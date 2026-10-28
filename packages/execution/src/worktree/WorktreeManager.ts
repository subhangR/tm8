// @tm8/execution — WorktreeManager: server-owned Git worktree lifecycle.
//
// TM8-WORKTREE-DESIGN §4 (provisioning saga steps 1–5), §5 (locks, caps,
// cleanup), §8 (security). This is Layer 3 — the piece that did not exist at
// all: every path is SERVER-COMPUTED, every Git call is an argv array
// (git-invoker.ts), and containment is asserted with realpath BOTH before and
// AFTER creation, segment-wise — `String.startsWith` would accept
// `/data/worktrees-evil` as inside `/data/worktrees`, so it is never used.
//
// LOCKING DISCIPLINE (§5.1, non-negotiable): the per-project mutex here is an
// IN-PROCESS keyed promise chain, generalizing workspace-trust.ts's single
// global chain to a Map. It is taken OUTSIDE and BEFORE any ledgered database
// transaction — `internal.ledger_replay` is the first statement of every door
// and holds an advisory lock, and nesting a project lock beneath it is the
// documented deadlock pattern (036:100-105, 032:123-129). Nothing in this
// class talks to the database at all (the package has no driver and must
// never gain one), so the ordering holds by construction.
//
// THE GIT LOCK IS TAKEN HERE, around exactly the commands that rewrite shared
// `.git/worktrees` metadata — `worktree add --no-checkout`, `move`, `remove`,
// `prune` — and NEVER around a checkout. Writing a tree's files touches only
// that tree and its own index, and holding the lock for it made every other
// launch of the project wait seconds behind it (measured on the tm8 repository:
// `git worktree add` p50 7.9 s on a loaded node, its registration 36 ms). So
// callers do not hold the lock around these methods: the chain is not
// reentrant, so a caller that does is refused with `git_lock_reentrant` the
// moment it re-enters — a fast, named failure where it would otherwise hang a
// launch forever. `withProjectLock` stays public for callers' own keys, such
// as the provisioning saga's reservation lock.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  WorktreeError,
  assertCommitOid,
  assertSafeBranchName,
  assertSafeRefName,
  runGit,
  type GitRunOptions,
} from './git-invoker.js';
import { WarmLanePool, type WarmLanePoolOptions } from './warm-pool.js';

/**
 * Untracked paths a lane borrows from the launch project by SYMLINK, never by
 * copy. `git worktree add` checks out tracked files only, so anything a
 * project builds locally and gitignores is absent from every lane.
 *
 * `graphify-out` is the code graph CLAUDE.md tells every agent to query at
 * `graphify-out/merged-graph.json`. `scripts/graphify-refresh.sh` rewrites it
 * in the launch project by rename; a link means every lane reads the latest
 * refresh, not the one current when it was provisioned, without a per-lane
 * copy of a file that runs to tens of megabytes.
 */
export const LANE_SHARED_PATHS: readonly string[] = ['graphify-out'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The bound on one checkout's file writes. `runGit`'s 30 s default is sized
 * for probes; a full checkout of a large repository on a loaded node was
 * measured at up to 24 s, and failing a launch at 30 s for a checkout that
 * would have finished is the wrong trade. Still bounded: a hung git must not
 * hang a saga.
 */
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;

/**
 * Parallel checkout (git ≥ 2.32): `0` is one worker per logical core. Measured
 * on the tm8 repository at about half the time of the sequential default.
 * Older git ignores the key.
 */
const PARALLEL_CHECKOUT_ARGS = ['-c', 'checkout.workers=0'] as const;

/**
 * Segment-boundary containment: is `child` equal to or under `root`?
 * Both inputs must already be ABSOLUTE and REAL (post-realpath) — this is
 * pure string mathematics over path segments and resolves no symlinks itself.
 */
export function isContainedIn(child: string, root: string): boolean {
  const childSegs = resolve(child).split(sep).filter(Boolean);
  const rootSegs = resolve(root).split(sep).filter(Boolean);
  if (rootSegs.length > childSegs.length) return false;
  return rootSegs.every((seg, i) => childSegs[i] === seg);
}

export interface WorktreeAddParams {
  /** Canonicalized repository root (from validateRepository). */
  repoRoot: string;
  projectId: string;
  /** Generated BEFORE any DB write (§4.4) — the path derives from it. */
  worktreeId: string;
  /** Server-computed branch name (e.g. `tm8/<short-id>`). */
  branch: string;
  /** The resolved OID from resolveBaseRef — never a symbolic ref (§4.6). */
  baseCommitOid: string;
  /** TEST SEAM for the §4.4.3 symlink race — runs between validation and `git worktree add`. */
  onBeforeGitAdd?: () => Promise<void>;
}

/** A reservation's lane, to be made out of a warm lane rather than checked out. */
export interface PoolLaneAdoption {
  repoRoot: string;
  projectId: string;
  worktreeId: string;
  branch: string;
  baseCommitOid: string;
  /** The warm lane's directory in the pool area. */
  from: string;
  /** The commit that directory is checked out at. */
  fromOid: string;
  /** TEST SEAM for the §4.4.3 symlink race — runs between validation and `git worktree move`. */
  onBeforeGitMove?: () => Promise<void>;
}

export interface WorktreePreflight {
  dirty: boolean;
  unpushedCommits: number;
  /** Digest over the probe results; written to the allocation row (§5.4). */
  token: string;
  measuredAtIso: string;
}

export interface WorktreeListEntry {
  path: string;
  headOid: string | null;
  branch: string | null;
  detached: boolean;
  prunable: boolean;
}

export interface WorktreeManagerOptions {
  /** The node's worktree area; created (and realpath'd) on first use. */
  worktreeRoot: string;
  gitTimeoutMs?: number;
  /**
   * The node's warm lanes (warm-pool.ts). Absent, or a size of 0, builds no
   * pool: every lane is checked out when its launch asks for it.
   */
  pool?: WarmLanePoolOptions;
}

export class WorktreeManager {
  private readonly rootConfigured: string;
  private rootReal: string | null = null;
  private readonly poolConfigured: string | null;
  private poolReal: string | null = null;
  private readonly gitTimeoutMs: number | undefined;
  /** Per-project promise chain — the generalized workspace-trust mutex (§5.1). */
  private readonly projectLocks = new Map<string, Promise<void>>();
  /** The keys the current async call chain holds, so re-entering one fails instead of deadlocking. */
  private readonly heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();
  /** This node's warm lanes, or null when it keeps none. */
  readonly pool: WarmLanePool | null;

  constructor(options: WorktreeManagerOptions) {
    this.rootConfigured = options.worktreeRoot;
    this.gitTimeoutMs = options.gitTimeoutMs;
    const pooled = options.pool !== undefined && options.pool.size > 0;
    this.poolConfigured = pooled ? options.pool!.root : null;
    this.pool = pooled ? new WarmLanePool(this, options.pool!) : null;
  }

  private gitOpts(cwd?: string): GitRunOptions {
    return { cwd, ...(this.gitTimeoutMs === undefined ? {} : { timeoutMs: this.gitTimeoutMs }) };
  }

  private checkoutOpts(): GitRunOptions {
    return { timeoutMs: this.gitTimeoutMs ?? CHECKOUT_TIMEOUT_MS };
  }

  /**
   * Serialize `fn` against every other holder of the same key. Keyed by a
   * project id it is that project's Git lock, which this class takes itself
   * (see the file header); other keys are the caller's own.
   * The chain entry is removed when the tail settles so the map cannot grow
   * without bound across many projects.
   */
  async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    // The chain cannot be re-entered: a holder waiting on itself waits forever.
    // Refuse it by name instead, before it queues.
    const held = this.heldLocks.getStore();
    if (held?.has(projectId)) {
      throw new WorktreeError(
        `the lock ${projectId} is already held by this call chain, and it is not reentrant`,
        'internal', 'git_lock_reentrant',
      );
    }
    const previous = this.projectLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((r) => { release = r; });
    // Hold a reference to the value ACTUALLY stored, not to `tail`. The map
    // stores `previous.then(() => tail)`, so an identity check against `tail`
    // in the finally block can never match — which is how the original of this
    // function retained one promise per project for the lifetime of the
    // process while claiming, in a comment, to clean up after itself.
    const entry = previous.then(() => tail);
    this.projectLocks.set(projectId, entry);
    await previous;
    try {
      return await this.heldLocks.run(new Set([...(held ?? []), projectId]), fn);
    } finally {
      release();
      if (this.projectLocks.get(projectId) === entry) this.projectLocks.delete(projectId);
    }
  }

  /** The canonicalized worktree area, created on first use. */
  async worktreeRoot(): Promise<string> {
    if (this.rootReal === null) {
      await mkdir(this.rootConfigured, { recursive: true });
      this.rootReal = await realpath(this.rootConfigured);
    }
    return this.rootReal;
  }

  /**
   * The canonicalized warm lane area, created on first use and asserted to
   * resolve inside the directory it was configured in (the node's data
   * directory): a pool area that is a symlink to somewhere else is refused,
   * not followed, because the pool deletes what it finds there.
   */
  async poolRoot(): Promise<string> {
    if (this.poolConfigured === null) {
      throw new WorktreeError('this node keeps no warm lanes', 'internal', 'pool_unconfigured');
    }
    if (this.poolReal === null) {
      await mkdir(this.poolConfigured, { recursive: true });
      const [real, parentReal] = await Promise.all([
        realpath(this.poolConfigured),
        realpath(dirname(this.poolConfigured)),
      ]);
      if (real === parentReal || !isContainedIn(real, parentReal)) {
        throw new WorktreeError(
          `the warm lane area resolves outside its data directory: ${real}`,
          'invalid_input', 'containment_violation',
        );
      }
      this.poolReal = real;
    }
    return this.poolReal;
  }

  /**
   * §4.1 — repository validation. Canonicalize with realpath and confirm a Git
   * repository lives there. Failure is `invalid_input`/`not_a_git_repository`,
   * NEVER a fallback to project mode — falling back silently is the failure
   * this whole design is an argument against.
   */
  async validateRepository(workingDir: string): Promise<{ repoRoot: string }> {
    const real = await this.canonicalWorkingDir(workingDir);
    await this.probeRepository(real);
    return { repoRoot: real };
  }

  /**
   * §4.1 and §4.3 in one pass, for the launch path: validate the repository
   * and resolve its base ref. The probe and the base reads are independent
   * reads of one repository, so they run at once — a launch pays one round of
   * git processes fewer — and the probe's refusal still wins: a directory that
   * is not a repository is `not_a_git_repository`, never `base_ref_not_found`.
   */
  async resolveRepositoryBase(
    workingDir: string,
    baseRef?: string,
  ): Promise<{ repoRoot: string; ref: string; oid: string }> {
    const real = await this.canonicalWorkingDir(workingDir);
    const [probe, base] = await Promise.allSettled([this.probeRepository(real), this.resolveBaseRef(real, baseRef)]);
    if (probe.status === 'rejected') throw probe.reason;
    if (base.status === 'rejected') throw base.reason;
    return { repoRoot: real, ...base.value };
  }

  private async canonicalWorkingDir(workingDir: string): Promise<string> {
    try {
      return await realpath(workingDir);
    } catch {
      throw new WorktreeError(
        `project working directory does not exist: ${workingDir}`,
        'invalid_input', 'not_a_git_repository',
      );
    }
  }

  private async probeRepository(real: string): Promise<void> {
    const probe = await runGit(['-C', real, 'rev-parse', '--git-dir'], this.gitOpts());
    if (probe.code !== 0) {
      throw new WorktreeError(
        `not a git repository: ${real}`,
        'invalid_input', 'not_a_git_repository', { stderr: probe.stderr.trim() },
      );
    }
  }

  /** `git rev-parse --verify <ref>^{commit}` — null oid means "no such commit". */
  private async revParseCommit(
    repoRoot: string,
    ref: string,
  ): Promise<{ oid: string | null; stderr: string }> {
    const resolved = await runGit(
      ['-C', repoRoot, 'rev-parse', '--verify', `${ref}^{commit}`],
      this.gitOpts(),
    );
    if (resolved.code !== 0) return { oid: null, stderr: resolved.stderr.trim() };
    const oid = resolved.stdout.trim();
    assertCommitOid(oid);
    return { oid, stderr: '' };
  }

  /**
   * §4.3, invariant I3 — the candidate list for an ABSENT base ref, in
   * preference order. Every entry is a plausible spelling of "the project's
   * DEFAULT branch"; the caller takes the first that resolves.
   *
   * `origin/HEAD` is the authoritative answer when it exists, but it is written
   * by `clone`, not by `fetch`, so a remote added after the fact has none — its
   * absence is a normal path here, never an error. `git ls-remote --symref` is
   * deliberately NOT probed as a second source: it is a NETWORK round trip in
   * the spawn hot path, so it would buy a new failure mode — spawn fails
   * because the network is down — for an answer the remote-tracking refs below
   * already give offline. (This function is NOT under the per-project lock;
   * provisioning takes that lock at step 4, after base ref resolution at step 2.
   * The reason to skip the probe is the network, not contention.)
   *
   * The remote-tracking ref is preferred over its LOCAL twin at every tier. The
   * base a lane wants is what `main` will be when its work merges, and
   * `origin/main` is that; local `main` on a shared checkout is an artifact of
   * whoever last pulled — measured 3 commits behind on the machine this was
   * written on. Remote-tracking refs are written by `fetch`, so reading one
   * costs no network. The local branch still follows as a fallback, which is
   * what covers a repository with no remote or one never fetched.
   *
   * The case this deliberately loses: a local `main` AHEAD of `origin/main`
   * with unpushed commits is not used as the base. For a lane that will open a
   * pull request against the remote, dropping commits the remote has never seen
   * is the correct answer, not a bug to be fixed back.
   */
  private async defaultBaseRefCandidates(repoRoot: string): Promise<string[]> {
    const candidates: string[] = [];
    const push = (ref: string | undefined): void => {
      if (ref === undefined || ref.length === 0) return;
      // Server-derived, but a repository is free to carry a branch name this
      // codebase refuses to pass to git. Skip such a candidate rather than
      // fail provisioning on it.
      try {
        assertSafeRefName(ref);
      } catch {
        return;
      }
      if (!candidates.includes(ref)) candidates.push(ref);
    };

    // Both symbolic refs are read at once: they are independent reads, and
    // every launch and every pool refresh waits on this list.
    const [originHead, head] = await Promise.all([
      runGit(['-C', repoRoot, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], this.gitOpts()),
      runGit(['-C', repoRoot, 'symbolic-ref', '--short', '-q', 'HEAD'], this.gitOpts()),
    ]);
    if (originHead.code === 0) {
      const remoteRef = originHead.stdout.trim(); // e.g. `origin/main`
      push(remoteRef);
      push(remoteRef.startsWith('origin/') ? remoteRef.slice('origin/'.length) : remoteRef);
    }
    push('origin/main');
    push('main');
    push('origin/master');
    push('master');

    // Last: the branch HEAD is parked on. Before this function existed that was
    // the FIRST and only answer, which is how 36 of 68 measured lanes were
    // based on another lane's in-flight branch.
    if (head.code === 0) push(head.stdout.trim());

    return candidates;
  }

  /**
   * §4.3 — base ref resolution. The symbolic ref is provenance; the RESOLVED
   * OID is what gets stored and later checked out, so a ref that moves between
   * resolution and `git worktree add` cannot silently change what was checked
   * out.
   *
   * An EXPLICITLY requested ref is honoured verbatim, and a missing one is
   * still `base_ref_not_found` — no fallback. With NO ref requested the answer
   * is the project's DEFAULT branch (invariant I3), never whatever branch the
   * working directory happens to be parked on: for a shared checkout that is
   * the last session's in-flight work.
   */
  async resolveBaseRef(repoRoot: string, baseRef?: string): Promise<{ ref: string; oid: string }> {
    if (baseRef !== undefined && baseRef !== '') {
      assertSafeRefName(baseRef);
      const { oid, stderr } = await this.revParseCommit(repoRoot, baseRef);
      if (oid === null) {
        throw new WorktreeError(
          `base ref not found: ${baseRef}`,
          'invalid_input', 'base_ref_not_found', { stderr },
        );
      }
      return { ref: baseRef, oid };
    }

    for (const ref of await this.defaultBaseRefCandidates(repoRoot)) {
      const { oid } = await this.revParseCommit(repoRoot, ref);
      if (oid !== null) return { ref, oid };
    }

    // Nothing symbolic resolved — a detached HEAD, or a repository whose
    // branches are all named something this code refuses. Resolve HEAD itself,
    // exactly as before, so a legitimate repository still provisions.
    const { oid, stderr } = await this.revParseCommit(repoRoot, 'HEAD');
    if (oid === null) {
      throw new WorktreeError(
        'base ref not found: HEAD',
        'invalid_input', 'base_ref_not_found', { stderr },
      );
    }
    return { ref: 'HEAD', oid };
  }

  /**
   * §4.4 — server-computed path. `<root>/<projectId>/<worktreeId>`, both ids
   * uuid-shaped so no client-influenced byte ever reaches a path segment.
   */
  async computeWorktreePath(projectId: string, worktreeId: string): Promise<string> {
    if (!UUID_RE.test(projectId) || !UUID_RE.test(worktreeId)) {
      throw new WorktreeError('worktree path components must be uuids', 'invalid_input', 'invalid_path_component');
    }
    return join(await this.worktreeRoot(), projectId, worktreeId);
  }

  /** A warm lane's path: `<pool root>/<projectId>/<laneId>`, by the same rule. */
  async computePoolLanePath(projectId: string, laneId: string): Promise<string> {
    if (!UUID_RE.test(projectId) || !UUID_RE.test(laneId)) {
      throw new WorktreeError('warm lane path components must be uuids', 'invalid_input', 'invalid_path_component');
    }
    return join(await this.poolRoot(), projectId, laneId);
  }

  /**
   * §4.6 — a lane's checkout, in two halves with §4.4's containment sandwich
   * around both:
   *
   *   1. realpath the PARENT (the leaf does not exist yet) and assert it is a
   *      segment-wise descendant of the realpath'd root;
   *   2. under the Git lock, `git -C <repo> worktree add --no-checkout -b
   *      <branch> <path> <oid>` — the registration, the only half that
   *      rewrites shared metadata — then realpath the CREATED directory and
   *      RE-ASSERT containment: the check before creation is a check against a
   *      path that does not exist yet; this one is what actually closes the
   *      symlink race. On violation the checkout is removed, not warned about;
   *   3. without the lock, write the files and the index: `reset --hard`, which
   *      is exactly what `git worktree add` runs itself after registering, with
   *      parallel checkout. Containment is asserted once more on the populated
   *      directory.
   *
   * The result is the checkout a plain `git worktree add -b` makes.
   */
  async add(params: WorktreeAddParams): Promise<{ path: string }> {
    assertSafeBranchName(params.branch);
    assertCommitOid(params.baseCommitOid);
    const root = await this.worktreeRoot();
    const path = await this.computeWorktreePath(params.projectId, params.worktreeId);
    await this.register({
      repoRoot: params.repoRoot,
      projectId: params.projectId,
      path,
      root,
      head: ['-b', params.branch],
      baseCommitOid: params.baseCommitOid,
      what: params.branch,
      ...(params.onBeforeGitAdd ? { onBeforeGitAdd: params.onBeforeGitAdd } : {}),
    });
    await this.populate({ repoRoot: params.repoRoot, projectId: params.projectId, path, root });
    return { path };
  }

  /**
   * A warm lane's checkout (warm-pool.ts): a DETACHED tree at `baseCommitOid`
   * in the pool area, made exactly as `add` makes a lane. Detached because the
   * branch is the launch's to name; `adoptPoolLane` creates it at the claim.
   */
  async addPoolLane(params: {
    repoRoot: string;
    projectId: string;
    laneId: string;
    baseCommitOid: string;
  }): Promise<{ path: string }> {
    assertCommitOid(params.baseCommitOid);
    const root = await this.poolRoot();
    const path = await this.computePoolLanePath(params.projectId, params.laneId);
    await this.register({
      repoRoot: params.repoRoot,
      projectId: params.projectId,
      path,
      root,
      head: ['--detach'],
      baseCommitOid: params.baseCommitOid,
      what: 'a warm lane',
    });
    await this.populate({ repoRoot: params.repoRoot, projectId: params.projectId, path, root });
    return { path };
  }

  /**
   * Make a reservation's lane out of a warm lane: the same checkout `add`
   * would have made at `computeWorktreePath(projectId, worktreeId)`, without
   * writing the tree.
   *
   *   1. under the Git lock, `git worktree move` it from the pool area to the
   *      lane path — a rename plus a metadata rewrite — and run `add`'s
   *      post-creation containment re-assert on the moved directory;
   *   2. without the lock, create the launch's branch at `baseCommitOid`. When
   *      the lane already sits at that commit, `checkout -b` with no start
   *      point writes neither a file nor the index (which the pool refreshed
   *      past git's racy-timestamp window); otherwise `checkout -f -b <oid>`
   *      rewrites exactly the files that differ.
   *
   * Two failures leave the reservation free for a cold `add`, and say so by
   * reason: `pool_lane_move_failed` (the lane is still where it was) and
   * `pool_lane_branch_failed` (the moved checkout was removed again). Anything
   * else — a containment violation above all — is the caller's to settle.
   */
  async adoptPoolLane(params: PoolLaneAdoption): Promise<{ path: string }> {
    assertSafeBranchName(params.branch);
    assertCommitOid(params.baseCommitOid);
    assertCommitOid(params.fromOid);
    const [root, poolRoot] = await Promise.all([this.worktreeRoot(), this.poolRoot()]);
    const path = await this.computeWorktreePath(params.projectId, params.worktreeId);
    await this.assertExistingInside(params.from, poolRoot);
    await mkdir(dirname(path), { recursive: true });
    await this.assertParentInside(path, root);

    if (params.onBeforeGitMove) await params.onBeforeGitMove();

    await this.withProjectLock(params.projectId, async () => {
      const moved = await runGit(
        ['-C', params.repoRoot, 'worktree', 'move', params.from, path],
        this.gitOpts(),
      );
      if (moved.code !== 0) {
        throw new WorktreeError(
          `git worktree move failed for ${params.from}`,
          'conflict', 'pool_lane_move_failed', { stderr: moved.stderr.trim() },
        );
      }
      await this.assertCreatedInside(path, root, () =>
        this.removeHeld({ repoRoot: params.repoRoot, path, force: true }));
    });

    const branched = await runGit(
      params.fromOid === params.baseCommitOid
        ? ['-C', path, 'checkout', '-q', '-b', params.branch]
        : [...PARALLEL_CHECKOUT_ARGS, '-C', path, 'checkout', '-q', '-f', '-b', params.branch, params.baseCommitOid],
      this.checkoutOpts(),
    );
    if (branched.code !== 0) {
      await this.remove({ projectId: params.projectId, repoRoot: params.repoRoot, path, force: true });
      throw new WorktreeError(
        `could not start ${params.branch} in a warm lane`,
        'internal', 'pool_lane_branch_failed', { stderr: branched.stderr.trim() },
      );
    }
    await this.assertCreatedInside(path, root, () =>
      this.remove({ projectId: params.projectId, repoRoot: params.repoRoot, path, force: true }));
    return { path };
  }

  /** Move a warm lane's detached tree to `oid`, rewriting the files that differ. No lock: one tree. */
  async checkoutDetached(path: string, oid: string): Promise<void> {
    assertCommitOid(oid);
    const res = await runGit(
      [...PARALLEL_CHECKOUT_ARGS, '-C', path, 'checkout', '-q', '-f', '--detach', oid],
      this.checkoutOpts(),
    );
    if (res.code !== 0) {
      throw new WorktreeError(`checkout of ${oid} failed in ${path}`, 'internal', 'worktree_checkout_failed', {
        stderr: res.stderr.trim(),
      });
    }
  }

  /**
   * Re-stat every tracked file into the index and write it. Right after a
   * checkout every file shares the index's timestamp, which git treats as
   * "racily clean" and re-hashes on the next read: 80-1,659 ms for the first
   * `git status` in a fresh tm8 lane. Run once the second has passed, this
   * pays that cost here instead. No lock: one tree.
   */
  async refreshIndex(path: string): Promise<void> {
    const res = await runGit(['-C', path, 'update-index', '-q', '--refresh'], this.checkoutOpts());
    if (res.code !== 0) {
      throw new WorktreeError(`index refresh failed in ${path}`, 'internal', 'worktree_index_refresh_failed', {
        stderr: res.stderr.trim(),
      });
    }
  }

  /**
   * Every `<projectId>/<laneId>` directory in the pool area — what a startup
   * sweep removes. Anything else found there is reported, never touched.
   */
  async listPoolLanes(): Promise<{
    lanes: Array<{ projectId: string; path: string }>;
    unexpected: string[];
  }> {
    const root = await this.poolRoot();
    const lanes: Array<{ projectId: string; path: string }> = [];
    const unexpected: string[] = [];
    for (const project of await readdir(root, { withFileTypes: true })) {
      const projectDir = join(root, project.name);
      if (!project.isDirectory() || !UUID_RE.test(project.name)) {
        unexpected.push(projectDir);
        continue;
      }
      for (const lane of await readdir(projectDir, { withFileTypes: true })) {
        const path = join(projectDir, lane.name);
        if (lane.isDirectory() && UUID_RE.test(lane.name)) lanes.push({ projectId: project.name, path });
        else unexpected.push(path);
      }
    }
    return { lanes, unexpected };
  }

  /**
   * Remove a warm lane. Only a directory exactly two levels under the pool
   * area qualifies — by the pool's contract nothing there is anyone's work —
   * and anything else is refused: a LANE is removed by `remove`, with its
   * dirty protection, never by this.
   *
   * The files go first and without the Git lock (that is the slow part), then
   * `git worktree prune` forgets the registration under it. The repository is
   * read off the lane's own `.git` file, so a leftover from an earlier process
   * is removable with no database to say whose repository it belonged to.
   */
  async discardPoolLane(params: { projectId: string; path: string }): Promise<void> {
    const root = await this.poolRoot();
    const lexical = resolve(params.path);
    // A lane path is never a symlink, so one that resolves anywhere but
    // itself — inside the area or not — is refused rather than followed.
    const real = await realpath(lexical).catch(() => lexical);
    const segments = relative(root, real).split(sep);
    if (
      real !== lexical
      || !isContainedIn(real, root)
      || segments.length !== 2
      || segments[0] !== params.projectId
      || segments.some((segment) => !UUID_RE.test(segment))
    ) {
      throw new WorktreeError(
        `refusing to discard a path that is not a warm lane: ${params.path}`,
        'invalid_input', 'containment_violation',
      );
    }
    const commonDir = await readCommonGitDir(real);
    await rm(real, { recursive: true, force: true });
    if (commonDir === null) return;
    await this.withProjectLock(params.projectId, async () => {
      await runGit(['--git-dir', commonDir, 'worktree', 'prune'], this.gitOpts());
    });
  }

  /** realpath(parent of `path`) must be inside `root` — `add`'s pre-creation check. */
  private async assertParentInside(path: string, root: string): Promise<void> {
    const parentReal = await realpath(dirname(path));
    if (!isContainedIn(parentReal, root)) {
      throw new WorktreeError(
        `computed worktree parent escapes the worktree area: ${parentReal}`,
        'invalid_input', 'containment_violation',
      );
    }
  }

  /** A path that must already exist inside `root`, such as a warm lane about to be moved. */
  private async assertExistingInside(path: string, root: string): Promise<void> {
    const real = await realpath(path).catch(() => null);
    if (real === null || !isContainedIn(real, root)) {
      throw new WorktreeError(
        `warm lane is missing or outside its area: ${path}`,
        real === null ? 'conflict' : 'invalid_input',
        real === null ? 'pool_lane_move_failed' : 'containment_violation',
      );
    }
  }

  /**
   * §8 — the post-creation re-assert: realpath the directory that now exists
   * and confirm it is still inside `root`. A violation is a CLEANUP
   * OBLIGATION, not a warning: `cleanUp` removes it before the refusal.
   */
  private async assertCreatedInside(path: string, root: string, cleanUp: () => Promise<void>): Promise<void> {
    let createdReal: string;
    try {
      createdReal = await realpath(path);
    } catch {
      throw new WorktreeError('created worktree vanished before verification', 'internal', 'worktree_vanished');
    }
    if (!isContainedIn(createdReal, root)) {
      await cleanUp().catch(() => undefined);
      throw new WorktreeError(
        `created worktree resolved outside the worktree area: ${createdReal}`,
        'invalid_input', 'containment_violation',
      );
    }
  }

  /** The registration half of a checkout: see `add`, steps 1-2. */
  private async register(params: {
    repoRoot: string;
    projectId: string;
    path: string;
    root: string;
    /** `['-b', branch]` for a lane, `['--detach']` for a warm lane. */
    head: readonly string[];
    baseCommitOid: string;
    /** For the refusal message: the branch, or what the tree is. */
    what: string;
    onBeforeGitAdd?: () => Promise<void>;
  }): Promise<void> {
    await mkdir(dirname(params.path), { recursive: true });
    await this.assertParentInside(params.path, params.root);

    if (params.onBeforeGitAdd) await params.onBeforeGitAdd();

    await this.withProjectLock(params.projectId, async () => {
      const added = await runGit(
        ['-C', params.repoRoot, 'worktree', 'add', '--no-checkout', ...params.head, params.path, params.baseCommitOid],
        this.gitOpts(),
      );
      if (added.code !== 0) {
        throw new WorktreeError(
          `git worktree add failed for ${params.what}`,
          'conflict', 'worktree_add_failed', { stderr: added.stderr.trim() },
        );
      }
      await this.assertCreatedInside(params.path, params.root, () =>
        this.removeHeld({ repoRoot: params.repoRoot, path: params.path, force: true }));
    });
  }

  /** The file-writing half of a checkout: see `add`, step 3. */
  private async populate(params: { repoRoot: string; projectId: string; path: string; root: string }): Promise<void> {
    const populated = await runGit(
      [...PARALLEL_CHECKOUT_ARGS, '-C', params.path, 'reset', '-q', '--hard', '--no-recurse-submodules'],
      this.checkoutOpts(),
    );
    if (populated.code !== 0) {
      throw new WorktreeError(
        `checkout failed in ${params.path}`,
        'conflict', 'worktree_add_failed', { stderr: populated.stderr.trim() },
      );
    }
    await this.assertCreatedInside(params.path, params.root, () =>
      this.remove({ projectId: params.projectId, repoRoot: params.repoRoot, path: params.path, force: true }));
  }

  /**
   * Link each `LANE_SHARED_PATHS` entry from the launch project into a freshly
   * added worktree. Returns the paths it linked.
   *
   * A path is linked only when all three hold, and skipped silently otherwise:
   *
   *   * it exists in the launch project — no dangling links;
   *   * the lane does not already have it — checked-out content wins;
   *   * the lane's gitignore ignores it. An untracked symlink would make
   *     `isDirty` answer true for every lane forever, and dirty lanes are
   *     delete-protected (§5.3), so an unignored path is never linked.
   *
   * Removal needs nothing extra: `git worktree remove` ignores ignored files
   * and `rm` unlinks a symlink without following it.
   */
  async linkSharedPaths(repoRoot: string, worktreePath: string): Promise<string[]> {
    const linked: string[] = [];
    for (const rel of LANE_SHARED_PATHS) {
      const target = join(repoRoot, rel);
      const link = join(worktreePath, rel);
      if (!(await stat(target).then((s) => s.isDirectory(), () => false))) continue;
      if (await lstat(link).then(() => true, () => false)) continue;
      const ignored = await runGit(['-C', worktreePath, 'check-ignore', '-q', rel], this.gitOpts());
      if (ignored.code !== 0) continue;
      await symlink(target, link, 'dir');
      linked.push(rel);
    }
    return linked;
  }

  /**
   * §5.3 — removal, idempotent under retry: `remove` twice, `remove` on an
   * already-gone directory, and `remove` after a manual `rm -rf` all converge.
   * `prune` runs unconditionally afterwards so `.git/worktrees` metadata never
   * outlives the directory. Takes the project's Git lock.
   */
  async remove(params: { projectId: string; repoRoot: string; path: string; force?: boolean }): Promise<void> {
    await this.withProjectLock(params.projectId, () => this.removeHeld(params));
  }

  /** `remove`'s body, for callers already holding the project's Git lock. */
  private async removeHeld(params: { repoRoot: string; path: string; force?: boolean }): Promise<void> {
    const args = ['-C', params.repoRoot, 'worktree', 'remove'];
    if (params.force) args.push('--force');
    args.push(params.path);
    const removed = await runGit(args, this.gitOpts());
    if (removed.code !== 0) {
      const gone = await stat(params.path).then(() => false, () => true);
      if (!gone) {
        // Directory still there and git refused (dirty without force, locked…).
        throw new WorktreeError(
          `git worktree remove refused for ${params.path}`,
          'conflict', 'worktree_remove_refused', { stderr: removed.stderr.trim() },
        );
      }
      // Directory already gone (manual rm, previous crash): fall through to
      // prune, which is the operation that actually forgets it.
    }
    await rm(params.path, { recursive: true, force: true }).catch(() => undefined);
    await runGit(['-C', params.repoRoot, 'worktree', 'prune'], this.gitOpts());
  }

  /** `git worktree list --porcelain`, parsed. Reconciliation's Git-side source. */
  async list(repoRoot: string): Promise<WorktreeListEntry[]> {
    const res = await runGit(['-C', repoRoot, 'worktree', 'list', '--porcelain'], this.gitOpts());
    if (res.code !== 0) {
      throw new WorktreeError('git worktree list failed', 'internal', 'worktree_list_failed', {
        stderr: res.stderr.trim(),
      });
    }
    const entries: WorktreeListEntry[] = [];
    let current: Partial<WorktreeListEntry> | null = null;
    for (const line of res.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current?.path) entries.push(this.finishEntry(current));
        current = { path: line.slice('worktree '.length) };
      } else if (current && line.startsWith('HEAD ')) {
        current.headOid = line.slice('HEAD '.length);
      } else if (current && line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (current && line === 'detached') {
        current.detached = true;
      } else if (current && line.startsWith('prunable')) {
        current.prunable = true;
      }
    }
    if (current?.path) entries.push(this.finishEntry(current));
    return entries;
  }

  private finishEntry(partial: Partial<WorktreeListEntry>): WorktreeListEntry {
    return {
      path: partial.path ?? '',
      headOid: partial.headOid ?? null,
      branch: partial.branch ?? null,
      detached: partial.detached ?? false,
      prunable: partial.prunable ?? false,
    };
  }

  /** `git status --porcelain` non-empty — the delete-protection probe (§5.3). */
  async isDirty(worktreePath: string): Promise<boolean> {
    const res = await runGit(['-C', worktreePath, 'status', '--porcelain'], this.gitOpts());
    if (res.code !== 0) {
      throw new WorktreeError('git status failed', 'internal', 'status_failed', { stderr: res.stderr.trim() });
    }
    return res.stdout.trim().length > 0;
  }

  /** Commits on `branch` unreachable from every remote ref — the other §5.3 probe. */
  async unpushedCommitCount(repoRoot: string, branch: string): Promise<number> {
    assertSafeBranchName(branch);
    const res = await runGit(
      ['-C', repoRoot, 'rev-list', '--count', branch, '--not', '--remotes'],
      this.gitOpts(),
    );
    if (res.code !== 0) {
      throw new WorktreeError('git rev-list failed', 'internal', 'rev_list_failed', { stderr: res.stderr.trim() });
    }
    return Number(res.stdout.trim()) || 0;
  }

  /**
   * §10.1 — merge verification: the server cannot OBSERVE a merge, but it can
   * refuse a false claim. Advisory, with the two documented holes answered:
   * a worktree with no commits of its own answers 'empty' (an empty tip is
   * trivially an ancestor — the most common abandoned-before-started case),
   * and squash/rebase merges legitimately answer 'not_merged' (callers carry
   * an explicit override that records HOW it merged).
   */
  async verifyMerged(params: {
    repoRoot: string; branch: string; baseBranch: string; baseCommitOid: string;
  }): Promise<'merged' | 'not_merged' | 'empty'> {
    assertSafeBranchName(params.branch);
    assertSafeRefName(params.baseBranch);
    assertCommitOid(params.baseCommitOid);
    const own = await runGit(
      ['-C', params.repoRoot, 'rev-list', '--count', `${params.baseCommitOid}..${params.branch}`],
      this.gitOpts(),
    );
    if (own.code !== 0 || (Number(own.stdout.trim()) || 0) === 0) return 'empty';
    const ancestor = await runGit(
      ['-C', params.repoRoot, 'merge-base', '--is-ancestor', params.branch, params.baseBranch],
      this.gitOpts(),
    );
    return ancestor.code === 0 ? 'merged' : 'not_merged';
  }

  /**
   * §5.4 — the preflight: run the Git probes and mint the token that
   * `update_worktree` re-checks under its row lock, closing the window between
   * "the tree was clean when we looked" and "the transition committed".
   */
  async preflight(params: { repoRoot: string; path: string; branch: string }): Promise<WorktreePreflight> {
    const dirty = await this.isDirty(params.path);
    const unpushed = await this.unpushedCommitCount(params.repoRoot, params.branch);
    const measuredAtIso = new Date().toISOString();
    const token = createHash('sha256')
      .update(JSON.stringify({ path: params.path, branch: params.branch, dirty, unpushed, measuredAtIso }))
      .digest('hex');
    return { dirty, unpushedCommits: unpushed, token, measuredAtIso };
  }
}

/**
 * The repository a linked worktree belongs to, from its `.git` file
 * (`gitdir: <common>/worktrees/<name>`) and that admin directory's `commondir`.
 * Null when the tree never got that far — there is then nothing to prune.
 */
async function readCommonGitDir(worktreePath: string): Promise<string | null> {
  const pointer = await readFile(join(worktreePath, '.git'), 'utf8').catch(() => null);
  const gitDir = pointer?.match(/^gitdir: (.+)$/m)?.[1]?.trim();
  if (!gitDir || !isAbsolute(gitDir)) return null;
  const common = await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => null);
  return common === null ? dirname(dirname(gitDir)) : resolve(gitDir, common.trim());
}
