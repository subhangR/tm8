// @tm8/execution — the warm lane pool: checkouts made BEFORE a launch asks for one.
//
// `git worktree add` is the whole cost of a worktree launch: measured on the
// tm8 repository (5,572 files) at p50 7.9 s on a loaded node, against 46 ms to
// move an existing checkout into place. So this node keeps a few checkouts per
// project ready, and a launch takes one instead of making one.
//
// CONTRACT
//   Holds     up to `size` WARM LANES per project: detached checkouts of the
//             project's default base under `<pool root>/<projectId>/<laneId>`
//             (`<dataDir>/worktrees-pool`), each with the shared-path links and
//             an index refreshed past git's racy-timestamp window.
//   Called by
//     materializeWorktree      `claim()` for a reservation; `replenish()` after
//                              every checkout, warm or cold;
//     reconcileNodeWorktrees   `sweepOnce()`, then `replenish()` for the projects
//                              this node launches lanes for, at startup;
//     the scheduler            `maintainAll()`: top up, follow the default base,
//                              expire projects nobody launches any more;
//     the composition root     `drain()` at shutdown, under its own time bound.
//   Invariants
//     * A warm lane has NO allocation row and lives OUTSIDE the lane area, so
//       nothing that lists, counts, caps, publishes or reconciles lanes can
//       see one. It becomes a lane only when `WorktreeManager.adoptPoolLane`
//       moves it to a reserved lane path — the same checkout a cold `add`
//       makes, at the same path.
//     * Inside a launch the pool does only `claim()`: pick a lane, wait for a
//       step already running on it, move it, branch it. Fills, refreshes and
//       discards are background work and never hold the Git lock for a
//       checkout (the manager takes it for metadata commands only).
//     * One git step at a time per lane, and none once the lane is claimed:
//       a claimer waits for the step in flight (`busy`) and the pool starts no
//       further step on a lane that is not its own.
//     * A lane's state changes only in `transition`, along `LANE_TRANSITIONS`.
//     * The pool area holds nobody's work. A sweep removes every leftover in it
//       before the first fill, and the manager refuses to discard anything
//       outside it.
//     * A failure is logged with the lane's path and backs the project off
//       exponentially; nothing retries in a loop.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { Logger } from '../pty/types.js';
import { WorktreeError } from './git-invoker.js';
import type { WorktreeManager } from './WorktreeManager.js';

export interface WarmLanePoolOptions {
  /**
   * `<dataDir>/worktrees-pool`. On the lane area's filesystem, because a claim
   * is a rename; it is asserted to resolve inside the directory it sits in.
   */
  root: string;
  /** Warm lanes kept per project. 0 keeps none: the manager then builds no pool. */
  size: number;
  logger?: Logger | undefined;
}

/**
 * A warm lane's lifecycle.
 *
 *   filling ──► warm ◄──► refreshing        (unclaimed: in the pool)
 *      │          │            │
 *      └──────────┴─────┬──────┘
 *                       ├──► claimed ──► (adopted: an ordinary lane now)
 *                       │       │
 *                       └───────┴──► discarding ──► (gone from disk)
 *
 * `filling` is the first checkout, `refreshing` a move to a newer default
 * base. `claimed` belongs to one launch: the pool starts no step on it, and
 * touches it again only to discard it if the launch could not adopt it.
 */
export type PoolLaneState = 'filling' | 'refreshing' | 'warm' | 'claimed' | 'discarding';

const LANE_TRANSITIONS: Readonly<Record<PoolLaneState, readonly PoolLaneState[]>> = {
  filling: ['warm', 'claimed', 'discarding'],
  refreshing: ['warm', 'claimed', 'discarding'],
  warm: ['refreshing', 'claimed', 'discarding'],
  claimed: ['discarding'],
  discarding: [],
};

/** Open until `drain()`, which closes the pool for good: no claim, no fill. */
type PoolState = 'open' | 'closed';

/** A project's upkeep: at most one runs at a time, and a failure parks it for a while. */
type Upkeep =
  | { phase: 'idle' }
  | { phase: 'running'; done: Promise<void> }
  | { phase: 'backing_off'; until: number };

interface PoolLane {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  state: PoolLaneState;
  /** The commit the tree is checked out at. Changes only when a step completes. */
  headOid: string;
  /** The git step running on the tree, if any; it rejects when the step failed. */
  busy: Promise<void> | null;
}

interface ProjectPool {
  readonly projectId: string;
  /** The canonical repository root the lanes are checkouts of. */
  repoRoot: string;
  /** The UNCLAIMED lanes: filling, refreshing or warm. */
  readonly lanes: Map<string, PoolLane>;
  upkeep: Upkeep;
  /** Consecutive failed upkeeps — the backoff's exponent. */
  failures: number;
  /** When a launch last wanted a lane here; the project expires when this is old. */
  wantedAt: number;
}

export interface PoolClaimRequest {
  projectId: string;
  /** The reservation's repository root, canonical as `validateRepository` returns it. */
  repoRoot: string;
  worktreeId: string;
  branch: string;
  baseCommitOid: string;
}

export interface PoolSweepReport {
  /** Leftover warm lanes removed from the pool area. */
  removed: string[];
  /** Entries in the pool area that are not warm lanes, reported and left alone. */
  unexpected: string[];
  errors: Array<{ path: string; message: string }>;
}

export interface PoolLaneSnapshot {
  id: string;
  projectId: string;
  path: string;
  state: PoolLaneState;
  headOid: string;
}

export interface PoolMaintenanceReport {
  projects: number;
  lanes: Partial<Record<PoolLaneState, number>>;
}

/**
 * git compares a file's timestamp with the index's at whole seconds; once one
 * has passed, a refresh records every file as older than the index it writes.
 */
const RACY_WINDOW_MS = 1_100;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
/** A project no launch has wanted for a day gives its lanes' disk back. */
export const POOL_IDLE_EXPIRY_MS = 24 * 60 * 60_000;

/** Reasons `adoptPoolLane` uses for "not adopted, the reservation is still free". */
const ADOPTION_FALLBACK_REASONS = new Set(['pool_lane_move_failed', 'pool_lane_branch_failed']);

/** A fill step's failure, carrying the lane it happened to. */
class WarmLaneError extends Error {
  constructor(readonly path: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'WarmLaneError';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WarmLanePool {
  readonly size: number;
  private readonly logger: Logger | undefined;
  private state: PoolState = 'open';
  private readonly projects = new Map<string, ProjectPool>();
  private swept: Promise<PoolSweepReport> | null = null;
  /** Discards in progress, so `drain()` can wait for them. */
  private readonly removals = new Set<Promise<void>>();

  constructor(
    private readonly manager: WorktreeManager,
    options: Pick<WarmLanePoolOptions, 'size' | 'logger'>,
  ) {
    this.size = options.size;
    this.logger = options.logger;
  }

  /**
   * A lane for this reservation, made from a warm one: `{ path }` once it sits
   * at `computeWorktreePath(projectId, worktreeId)` on `branch` at
   * `baseCommitOid`, or null when the pool has none to give — the caller then
   * checks out cold. Throws only what the cold path could not recover from
   * either: a containment violation, or a lane path that could not be cleared.
   */
  async claim(request: PoolClaimRequest): Promise<{ path: string } | null> {
    if (this.state !== 'open') return null;
    const project = this.projects.get(request.projectId);
    if (!project) return null;
    project.wantedAt = Date.now();
    if (project.repoRoot !== request.repoRoot) {
      // The project's working directory moved since these lanes were made:
      // they are checkouts of a repository the launch is not asking about.
      this.retarget(project, request.repoRoot);
      return null;
    }

    const lane = pickLane(project, request.baseCommitOid);
    if (!lane) return null;
    this.transition(lane, 'claimed');
    // The pool is one lane short from this moment; start refilling now rather
    // than after this launch's checkout.
    void this.upkeep(project);
    try {
      // A fill or refresh still running on it finishes first. Waiting is
      // never slower than checking out cold: that is the same work, from zero.
      await lane.busy;
    } catch {
      this.discard(lane);
      return null;
    }
    // The pool area is ours, but nothing stops a process writing into it. A
    // stray file is one lane's problem, not the project's: no back-off.
    if ((await this.manager.isPristine(lane.path)) === false) {
      this.logger?.warn('worktree pool: a warm lane was not clean at its claim; discarding it', { path: lane.path });
      this.discard(lane);
      return null;
    }

    try {
      return await this.manager.adoptPoolLane({
        repoRoot: request.repoRoot,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        branch: request.branch,
        baseCommitOid: request.baseCommitOid,
        from: lane.path,
        fromOid: lane.headOid,
      });
    } catch (error) {
      if (!(error instanceof WorktreeError) || !ADOPTION_FALLBACK_REASONS.has(error.reason)) throw error;
      this.discard(lane);
      // Whatever stopped this adoption will stop the next one; filling more
      // lanes for it would be work thrown away.
      this.backOff(project, new WarmLaneError(lane.path, error));
      return null;
    }
  }

  /**
   * Bring the project's pool up to `size` in the background, and remember the
   * project as one this node launches lanes for. Never awaited by a launch,
   * never throws. `repoRoot` is canonical, as `validateRepository` returns it.
   */
  replenish(projectId: string, repoRoot: string): void {
    if (this.state !== 'open') return;
    const project = this.projectFor(projectId, repoRoot);
    project.wantedAt = Date.now();
    void this.upkeep(project);
  }

  /**
   * One upkeep for every known project: top the pool up, move warm lanes to
   * the current default base, expire projects nobody has launched for
   * `POOL_IDLE_EXPIRY_MS`. Never rejects; the scheduler calls it.
   */
  async maintainAll(): Promise<PoolMaintenanceReport> {
    if (this.state === 'open') {
      await Promise.all([...this.projects.values()].map((project) => this.upkeep(project)));
    }
    const lanes: Partial<Record<PoolLaneState, number>> = {};
    for (const lane of this.snapshot()) lanes[lane.state] = (lanes[lane.state] ?? 0) + 1;
    return { projects: this.projects.size, lanes };
  }

  /**
   * Remove every leftover in the pool area, once per process and before the
   * first fill. Everything there predates this process — no fill starts
   * before the sweep has finished — so all of it goes. Never rejects. An area
   * that cannot be listed, or that resolves outside its data directory,
   * closes the pool instead: it is not a place this pool may fill or empty.
   */
  sweepOnce(): Promise<PoolSweepReport> {
    this.swept ??= this.sweep();
    return this.swept;
  }

  /**
   * Shutdown: close the pool and remove every unclaimed lane. A claimed lane
   * belongs to its launch and is left alone. Bounded by the caller; whatever
   * this does not finish, the next startup sweep removes.
   */
  async drain(): Promise<{ discarded: number }> {
    this.state = 'closed';
    let discarded = 0;
    for (const project of this.projects.values()) {
      for (const lane of [...project.lanes.values()]) {
        this.discard(lane);
        discarded += 1;
      }
    }
    await Promise.allSettled([...this.removals]);
    return { discarded };
  }

  /** The unclaimed lanes, of one project or of all. For diagnostics and tests. */
  snapshot(projectId?: string): PoolLaneSnapshot[] {
    const out: PoolLaneSnapshot[] = [];
    for (const project of this.projects.values()) {
      if (projectId !== undefined && project.projectId !== projectId) continue;
      for (const lane of project.lanes.values()) {
        out.push({ id: lane.id, projectId: lane.projectId, path: lane.path, state: lane.state, headOid: lane.headOid });
      }
    }
    return out;
  }

  /** The ONE place a lane's state changes. A lane leaving the pool leaves its project's map. */
  private transition(lane: PoolLane, to: PoolLaneState): void {
    if (!LANE_TRANSITIONS[lane.state].includes(to)) {
      throw new Error(`warm lane ${lane.id}: ${lane.state} → ${to} is not a transition`);
    }
    lane.state = to;
    if (to === 'claimed' || to === 'discarding') this.projects.get(lane.projectId)?.lanes.delete(lane.id);
  }

  private projectFor(projectId: string, repoRoot: string): ProjectPool {
    const known = this.projects.get(projectId);
    if (known) {
      if (known.repoRoot !== repoRoot) this.retarget(known, repoRoot);
      return known;
    }
    const project: ProjectPool = {
      projectId,
      repoRoot,
      lanes: new Map(),
      upkeep: { phase: 'idle' },
      failures: 0,
      wantedAt: Date.now(),
    };
    this.projects.set(projectId, project);
    return project;
  }

  /** The project now lives in another repository: its lanes are checkouts of the old one. */
  private retarget(project: ProjectPool, repoRoot: string): void {
    for (const lane of [...project.lanes.values()]) this.discard(lane);
    project.repoRoot = repoRoot;
    project.failures = 0;
    if (project.upkeep.phase === 'backing_off') project.upkeep = { phase: 'idle' };
  }

  /** Start the project's upkeep unless one is running or it is backing off. */
  private upkeep(project: ProjectPool): Promise<void> {
    const current = project.upkeep;
    if (current.phase === 'running') return current.done;
    if (current.phase === 'backing_off' && Date.now() < current.until) return Promise.resolve();
    const done = this.runUpkeep(project).then(
      () => {
        // A claim may have backed the project off while this ran; that stands.
        if (project.upkeep.phase !== 'running') return;
        project.failures = 0;
        project.upkeep = { phase: 'idle' };
      },
      (error: unknown) => {
        this.backOff(project, error);
      },
    );
    project.upkeep = { phase: 'running', done };
    return done;
  }

  private async runUpkeep(project: ProjectPool): Promise<void> {
    await this.sweepOnce();
    if (!this.isCurrent(project)) return;
    if (Date.now() - project.wantedAt > POOL_IDLE_EXPIRY_MS) {
      for (const lane of [...project.lanes.values()]) this.discard(lane);
      this.projects.delete(project.projectId);
      return;
    }
    let base: { oid: string };
    try {
      // The default branch, exactly as a launch with no base ref resolves it.
      base = await this.manager.resolveBaseRef(project.repoRoot);
    } catch (error) {
      throw new WarmLaneError(project.repoRoot, error);
    }
    while (this.isCurrent(project) && project.lanes.size < this.size) {
      await this.fill(project, base.oid);
    }
    for (const lane of [...project.lanes.values()]) {
      if (!this.isCurrent(project)) return;
      if (lane.state === 'warm' && lane.headOid !== base.oid) await this.refresh(lane, base.oid);
    }
  }

  /** The pool is open and this record is still the project's (not expired or replaced). */
  private isCurrent(project: ProjectPool): boolean {
    return this.state === 'open' && this.projects.get(project.projectId) === project;
  }

  private async fill(project: ProjectPool, oid: string): Promise<void> {
    const id = randomUUID();
    const path = await this.manager.computePoolLanePath(project.projectId, id);
    const lane: PoolLane = { id, projectId: project.projectId, path, state: 'filling', headOid: oid, busy: null };
    // Registered and given its first step in the same tick, so no claimer can
    // see a filling lane with no step behind it.
    project.lanes.set(id, lane);
    const repoRoot = project.repoRoot;
    try {
      const checkedOut = await this.step(lane, async () => {
        await this.manager.addPoolLane({ repoRoot, projectId: project.projectId, laneId: id, baseCommitOid: oid });
        await this.manager.linkSharedPaths(repoRoot, path).catch((error: unknown) => {
          // A lane without the graph is a slower lane, not a broken one.
          this.logger?.warn('worktree pool: linking shared paths into a warm lane failed', {
            path,
            message: messageOf(error),
          });
        });
      });
      if (!checkedOut || lane.state !== 'filling') return; // claimed meanwhile: its launch has it
      await delay(RACY_WINDOW_MS);
      const refreshed = await this.step(lane, () => this.manager.refreshIndex(path));
      if (refreshed && lane.state === 'filling') this.transition(lane, 'warm');
    } catch (error) {
      if (lane.state === 'filling') this.discard(lane);
      throw new WarmLaneError(path, error);
    }
  }

  private async refresh(lane: PoolLane, oid: string): Promise<void> {
    this.transition(lane, 'refreshing');
    try {
      const moved = await this.step(lane, async () => {
        await this.manager.checkoutDetached(lane.path, oid);
        lane.headOid = oid;
      });
      if (moved && lane.state === 'refreshing') this.transition(lane, 'warm');
    } catch (error) {
      // Not a backoff: the next upkeep fills a replacement from scratch.
      this.logger?.warn('worktree pool: refreshing a warm lane failed; discarding it', {
        path: lane.path,
        oid,
        message: messageOf(error),
      });
      if (lane.state === 'refreshing') this.discard(lane);
    }
  }

  /**
   * Run one git step on an UNCLAIMED lane, published as `busy` for a claimer
   * to wait on. False when the lane left the pool before the step could start.
   */
  private async step(lane: PoolLane, work: () => Promise<void>): Promise<boolean> {
    if (lane.state !== 'filling' && lane.state !== 'refreshing') return false;
    const busy = work();
    lane.busy = busy;
    // Observed by this method and by any claimer; never an unhandled rejection.
    busy.catch(() => undefined);
    try {
      await busy;
      return true;
    } finally {
      if (lane.busy === busy) lane.busy = null;
    }
  }

  /**
   * Take the lane out of the pool and remove it from disk, in the background,
   * once the step running on it (if any) has stopped writing into it.
   */
  private discard(lane: PoolLane): void {
    if (lane.state !== 'discarding') this.transition(lane, 'discarding');
    const removal = (lane.busy ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.manager.discardPoolLane({ projectId: lane.projectId, path: lane.path }))
      .catch((error: unknown) => {
        this.logger?.warn('worktree pool: discarding a warm lane failed; the next startup sweep removes it', {
          path: lane.path,
          message: messageOf(error),
        });
      });
    this.removals.add(removal);
    void removal.finally(() => this.removals.delete(removal));
  }

  private backOff(project: ProjectPool, error: unknown): void {
    project.failures += 1;
    const retryInMs = Math.min(BACKOFF_BASE_MS * 2 ** (project.failures - 1), BACKOFF_MAX_MS);
    project.upkeep = { phase: 'backing_off', until: Date.now() + retryInMs };
    this.logger?.warn('worktree pool: could not keep warm lanes; backing off', {
      projectId: project.projectId,
      path: error instanceof WarmLaneError ? error.path : project.repoRoot,
      message: messageOf(error),
      failures: project.failures,
      retryInMs,
    });
  }

  private async sweep(): Promise<PoolSweepReport> {
    const report: PoolSweepReport = { removed: [], unexpected: [], errors: [] };
    let found: Awaited<ReturnType<WorktreeManager['listPoolLanes']>>;
    try {
      found = await this.manager.listPoolLanes();
    } catch (error) {
      this.state = 'closed';
      report.errors.push({ path: '(warm lane area)', message: messageOf(error) });
      this.logger?.warn('worktree pool: the warm lane area is unusable; keeping no warm lanes', {
        message: messageOf(error),
      });
      return report;
    }
    report.unexpected = found.unexpected;
    for (const { projectId, path } of found.lanes) {
      try {
        await this.manager.discardPoolLane({ projectId, path });
        report.removed.push(path);
      } catch (error) {
        report.errors.push({ path, message: messageOf(error) });
        this.logger?.warn('worktree pool: removing a leftover warm lane failed', { path, message: messageOf(error) });
      }
    }
    return report;
  }
}

/** Warm at the requested commit, then warm elsewhere, then a lane whose step is still running. */
function pickLane(project: ProjectPool, oid: string): PoolLane | null {
  let best: PoolLane | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const lane of project.lanes.values()) {
    const rank =
      lane.state === 'warm' ? (lane.headOid === oid ? 0 : 1)
      : lane.state === 'refreshing' ? 2
      : lane.state === 'filling' ? 3
      : Number.POSITIVE_INFINITY;
    if (rank < bestRank) {
      best = lane;
      bestRank = rank;
    }
  }
  return best;
}
