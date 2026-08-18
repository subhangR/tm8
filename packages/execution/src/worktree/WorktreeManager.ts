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
// documented deadlock pattern (036:100-105, 032:123-129). Callers wrap the
// whole saga step in `withProjectLock`; nothing in this class talks to the
// database at all (the package has no driver and must never gain one).

import { createHash } from 'node:crypto';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import {
  WorktreeError,
  assertCommitOid,
  assertSafeBranchName,
  assertSafeRefName,
  runGit,
  type GitRunOptions,
} from './git-invoker.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
}

export class WorktreeManager {
  private readonly rootConfigured: string;
  private rootReal: string | null = null;
  private readonly gitTimeoutMs: number | undefined;
  /** Per-project promise chain — the generalized workspace-trust mutex (§5.1). */
  private readonly projectLocks = new Map<string, Promise<void>>();

  constructor(options: WorktreeManagerOptions) {
    this.rootConfigured = options.worktreeRoot;
    this.gitTimeoutMs = options.gitTimeoutMs;
  }

  private gitOpts(cwd?: string): GitRunOptions {
    return { cwd, ...(this.gitTimeoutMs === undefined ? {} : { timeoutMs: this.gitTimeoutMs }) };
  }

  /**
   * Serialize `fn` against every other holder of the same project's lock.
   * `git worktree add/remove/prune` mutate shared `.git/worktrees/` metadata,
   * so they serialize per repository; distinct projects proceed concurrently.
   * The chain entry is removed when the tail settles so the map cannot grow
   * without bound across many projects.
   */
  async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
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
      return await fn();
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
   * §4.1 — repository validation. Canonicalize with realpath and confirm a Git
   * repository lives there. Failure is `invalid_input`/`not_a_git_repository`,
   * NEVER a fallback to project mode — falling back silently is the failure
   * this whole design is an argument against.
   */
  async validateRepository(workingDir: string): Promise<{ repoRoot: string }> {
    let real: string;
    try {
      real = await realpath(workingDir);
    } catch {
      throw new WorktreeError(
        `project working directory does not exist: ${workingDir}`,
        'invalid_input', 'not_a_git_repository',
      );
    }
    const probe = await runGit(['-C', real, 'rev-parse', '--git-dir'], this.gitOpts());
    if (probe.code !== 0) {
      throw new WorktreeError(
        `not a git repository: ${real}`,
        'invalid_input', 'not_a_git_repository', { stderr: probe.stderr.trim() },
      );
    }
    return { repoRoot: real };
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

    const originHead = await runGit(
      ['-C', repoRoot, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'],
      this.gitOpts(),
    );
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
    const head = await runGit(['-C', repoRoot, 'symbolic-ref', '--short', '-q', 'HEAD'], this.gitOpts());
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

  /**
   * §4.6 — `git worktree add`, argv-only, with §4.4's containment sandwich:
   *
   *   1. realpath the PARENT (the leaf does not exist yet) and assert it is a
   *      segment-wise descendant of the realpath'd root;
   *   2. run `git -C <repo> worktree add -b <branch> <path> <oid>`;
   *   3. realpath the CREATED directory and RE-ASSERT containment — the check
   *      before creation is a check against a path that does not exist yet;
   *      this one is what actually closes the symlink race. On violation the
   *      checkout is removed, not warned about.
   *
   * Callers hold `withProjectLock(projectId, …)` around this.
   */
  async add(params: WorktreeAddParams): Promise<{ path: string }> {
    assertSafeBranchName(params.branch);
    assertCommitOid(params.baseCommitOid);
    const root = await this.worktreeRoot();
    const path = await this.computeWorktreePath(params.projectId, params.worktreeId);

    await mkdir(dirname(path), { recursive: true });
    const parentReal = await realpath(dirname(path));
    if (!isContainedIn(parentReal, root)) {
      throw new WorktreeError(
        `computed worktree parent escapes the worktree area: ${parentReal}`,
        'invalid_input', 'containment_violation',
      );
    }

    if (params.onBeforeGitAdd) await params.onBeforeGitAdd();

    const added = await runGit(
      ['-C', params.repoRoot, 'worktree', 'add', '-b', params.branch, path, params.baseCommitOid],
      this.gitOpts(),
    );
    if (added.code !== 0) {
      throw new WorktreeError(
        `git worktree add failed for ${params.branch}`,
        'conflict', 'worktree_add_failed', { stderr: added.stderr.trim() },
      );
    }

    let createdReal: string;
    try {
      createdReal = await realpath(path);
    } catch {
      throw new WorktreeError('created worktree vanished before verification', 'internal', 'worktree_vanished');
    }
    if (!isContainedIn(createdReal, root)) {
      // §8: failure here is a CLEANUP OBLIGATION, not a warning.
      await this.remove({ repoRoot: params.repoRoot, path, force: true }).catch(() => undefined);
      throw new WorktreeError(
        `created worktree resolved outside the worktree area: ${createdReal}`,
        'invalid_input', 'containment_violation',
      );
    }
    return { path };
  }

  /**
   * §5.3 — removal, idempotent under retry: `remove` twice, `remove` on an
   * already-gone directory, and `remove` after a manual `rm -rf` all converge.
   * `prune` runs unconditionally afterwards so `.git/worktrees` metadata never
   * outlives the directory. Callers hold the project lock.
   */
  async remove(params: { repoRoot: string; path: string; force?: boolean }): Promise<void> {
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
