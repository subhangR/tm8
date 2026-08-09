// @tm8/execution — mutating Git verbs for session worktrees (Tier 2).
//
// checkpoint / rollback / stage / commit / merge, built DIRECTLY on the
// argv-only invoker (git-invoker.ts). The rules inherited from that file and
// WorktreeManager hold everywhere here:
//
//   * every Git call is an argv array through execFile — no shell, ever;
//   * no caller-supplied value may LOOK like an option: refs go through
//     assertSafeRefName, pathspecs and commit messages through the guards
//     below, and pathspecs additionally ride behind a literal `--`;
//   * refusal is loud and typed (WorktreeError), never a silent fallback;
//   * a failure must never leave the worktree in a half-state a later verb
//     trips over — the merge verb in particular ABORTS on conflict and
//     verifies the abort took, because a worktree stuck mid-merge is the
//     exact silent failure this tier exists to prevent.
//
// WHERE THIS RUNS. These functions execute wherever the worktree directory is
// reachable on disk. The CLI invokes them locally (loopback deployments — the
// only kind today); a future server-side operation family can call the same
// functions from a handler without change. That is why they take a worktree
// PATH the caller has already resolved from the graph, and never a client-
// supplied path directly.
//
// AUTO-CHECKPOINT HOOK POINT (designed here, shipped manual). The natural
// seam is the turn boundary in the execution loop (native-session's settled
// prompt → response cycle): after each completed turn, call
// `checkpoint({ worktreePath, expectedBranch, message: 'tm8 auto turn <n>' })`.
// The function is already idempotent for that use — a clean tree returns
// `created: false` with the current HEAD instead of minting an empty commit —
// so a per-turn hook needs no dedup of its own. Recording the returned oid as
// a graph fact should go through one write path shared with the manual verbs
// (the Tier 4 lane's `record_session_commit`), which is why this module does
// not write provenance itself: the hook point is a CALLER, and the caller
// owns the ledger.

import { stat } from 'node:fs/promises';

import { WorktreeError, assertSafeRefName, runGit, type GitRunOptions } from './git-invoker.js';

/** One changed path from `git status --porcelain -z`. */
export interface ChangedFile {
  /** The two-column XY status ("M ", " M", "??", "A ", …). */
  status: string;
  path: string;
  /** Present for renames/copies: the path the content came from. */
  origPath?: string;
}

export interface GitIdentity {
  /** Committer/author fallback when the checkout has no user.* config. */
  name?: string;
  email?: string;
}

const DEFAULT_IDENTITY = { name: 'tm8', email: 'tm8@local' } as const;

/**
 * Commit messages are single argv tokens after `-m`, so a shell never sees
 * them — but the invoker's discipline is that no caller-supplied value may
 * LOOK like an option, and a NUL would truncate the argv token itself.
 */
export function assertSafeMessage(message: string): void {
  if (message.trim().length === 0) {
    throw new WorktreeError('commit message must not be empty', 'invalid_input', 'empty_message');
  }
  if (message.length > 10_000) {
    throw new WorktreeError('commit message too long', 'invalid_input', 'message_too_long');
  }
  if (message.startsWith('-')) {
    throw new WorktreeError('commit message must not start with "-"', 'invalid_input', 'unsafe_message');
  }
  if (message.includes('\u0000')) {
    throw new WorktreeError('commit message must not contain NUL', 'invalid_input', 'unsafe_message');
  }
}

/**
 * Pathspecs ride behind a literal `--`, which already makes a leading dash
 * inert to git's option parser — this guard is defense in depth on top, plus
 * the two things `--` does NOT defend against: absolute paths and `..`
 * traversal both reach OUTSIDE the worktree the caller resolved.
 */
export function assertSafePathspec(path: string): void {
  const refuse = (why: string): never => {
    throw new WorktreeError(`unsafe pathspec ${JSON.stringify(path)}: ${why}`, 'invalid_input', 'unsafe_pathspec');
  };
  if (path.length === 0) refuse('empty');
  if (path.includes('\u0000')) refuse('NUL byte');
  if (path.startsWith('-')) refuse('leading dash reads as an option');
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) refuse('absolute paths escape the worktree');
  if (path.split(/[\\/]/).includes('..')) refuse('".." traverses outside the worktree');
  if (path.startsWith(':')) refuse('magic pathspec prefixes are not accepted here');
}

async function git(args: readonly string[], cwd: string, options: GitRunOptions = {}) {
  return runGit(args, { cwd, ...options });
}

/** `-c user.*=` fallbacks so a commit never dies on a configless checkout. */
function identityArgs(identity?: GitIdentity): string[] {
  const name = identity?.name ?? DEFAULT_IDENTITY.name;
  const email = identity?.email ?? DEFAULT_IDENTITY.email;
  // Single argv tokens of the shape `user.name=<value>` — a value can never
  // occupy its own argv slot, so it can never read as an option.
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
}

/** The worktree directory must exist and be a Git checkout — never a guess. */
export async function assertWorktreeDir(worktreePath: string): Promise<void> {
  const present = await stat(worktreePath).then((s) => s.isDirectory(), () => false);
  if (!present) {
    throw new WorktreeError(
      `worktree directory not reachable on this host: ${worktreePath}`,
      'not_found', 'worktree_not_local',
    );
  }
  const probe = await git(['rev-parse', '--git-dir'], worktreePath);
  if (probe.code !== 0) {
    throw new WorktreeError(
      `not a git checkout: ${worktreePath}`,
      'invalid_input', 'not_a_git_repository', { stderr: probe.stderr.trim() },
    );
  }
}

/** The branch HEAD points at, or null when detached. */
export async function currentBranch(worktreePath: string): Promise<string | null> {
  const res = await git(['symbolic-ref', '--short', '-q', 'HEAD'], worktreePath);
  return res.code === 0 && res.stdout.trim().length > 0 ? res.stdout.trim() : null;
}

/**
 * Every mutating verb calls this first: the checkout is real, HEAD is on the
 * branch the GRAPH says this worktree owns, and (unless the verb is designed
 * for it) no merge is half-done. A worktree whose branch does not match its
 * entity row is a worktree someone re-pointed by hand — mutating it would
 * write commits onto a branch the graph does not associate with the session.
 */
export async function assertMutableWorktree(params: {
  worktreePath: string;
  /** The branch the worktree entity row records; omit to skip the match. */
  expectedBranch?: string;
}): Promise<{ branch: string }> {
  await assertWorktreeDir(params.worktreePath);
  const branch = await currentBranch(params.worktreePath);
  if (branch === null) {
    throw new WorktreeError('worktree HEAD is detached', 'conflict', 'detached_head');
  }
  if (params.expectedBranch !== undefined && branch !== params.expectedBranch) {
    throw new WorktreeError(
      `worktree is on ${JSON.stringify(branch)} but the graph records ${JSON.stringify(params.expectedBranch)}`,
      'conflict', 'branch_mismatch', { branch, expectedBranch: params.expectedBranch },
    );
  }
  return { branch };
}

async function mergeInProgress(worktreePath: string): Promise<boolean> {
  const res = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktreePath);
  return res.code === 0;
}

async function refuseMidMerge(worktreePath: string, verb: string): Promise<void> {
  if (await mergeInProgress(worktreePath)) {
    throw new WorktreeError(
      `${verb} refused: a merge is in progress in this worktree`,
      'conflict', 'merge_in_progress',
      { hint: 'resolve or abort the merge first; tm8 verbs never complete a merge implicitly' },
    );
  }
}

/** Parse `git status --porcelain=v1 -z` — NUL-safe for any filename bytes. */
export async function changedFiles(worktreePath: string): Promise<ChangedFile[]> {
  const res = await git(['status', '--porcelain=v1', '-z'], worktreePath);
  if (res.code !== 0) {
    throw new WorktreeError('git status failed', 'internal', 'status_failed', { stderr: res.stderr.trim() });
  }
  const tokens = res.stdout.split('\u0000');
  const out: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.length < 4) continue;
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (status[0] === 'R' || status[0] === 'C') {
      // Rename/copy entries carry the source path as the NEXT NUL token.
      const origPath = tokens[i + 1];
      i += 1;
      out.push({ status, path, ...(origPath ? { origPath } : {}) });
    } else {
      out.push({ status, path });
    }
  }
  return out;
}

/** The staged half only: what `commit` would write right now. */
export async function stagedFiles(worktreePath: string): Promise<ChangedFile[]> {
  const res = await git(['diff', '--cached', '--name-status', '-z'], worktreePath);
  if (res.code !== 0) {
    throw new WorktreeError('git diff --cached failed', 'internal', 'diff_failed', { stderr: res.stderr.trim() });
  }
  const tokens = res.stdout.split('\u0000');
  const out: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i];
    const path = tokens[i + 1];
    if (!status || path === undefined || path.length === 0) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const dest = tokens[i + 2];
      out.push({ status, path: dest ?? path, origPath: path });
      i += 2;
    } else {
      out.push({ status, path });
      i += 1;
    }
  }
  return out;
}

async function headOid(worktreePath: string): Promise<string> {
  const res = await git(['rev-parse', '--verify', 'HEAD'], worktreePath);
  if (res.code !== 0) {
    throw new WorktreeError('worktree has no HEAD commit', 'conflict', 'no_head', { stderr: res.stderr.trim() });
  }
  return res.stdout.trim();
}

/**
 * Resolve a caller-supplied checkpoint ref (full oid, short oid, or symbolic
 * ref) to a full commit oid — hostile shapes are refused BEFORE the argv slot,
 * mirroring resolveBaseRef.
 */
export async function resolveCommitish(worktreePath: string, refOrOid: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(refOrOid)) assertSafeRefName(refOrOid);
  const res = await git(['rev-parse', '--verify', `${refOrOid}^{commit}`], worktreePath);
  if (res.code !== 0) {
    throw new WorktreeError(
      `not a commit in this worktree: ${refOrOid}`,
      'not_found', 'commit_not_found', { stderr: res.stderr.trim() },
    );
  }
  return res.stdout.trim();
}

export interface CheckpointResult {
  /** The checkpoint ref — a full commit oid on the worktree's branch. */
  oid: string;
  branch: string;
  /** false when the tree was already clean and HEAD itself is the checkpoint. */
  created: boolean;
  /** What the checkpoint captured (empty when created is false). */
  files: ChangedFile[];
}

/**
 * Commit ALL work-in-progress (tracked and untracked) to the worktree's own
 * branch and return the commit oid as the checkpoint ref. A clean tree is a
 * SUCCESS that creates nothing — per-turn auto-checkpointing must not mint
 * empty commits — and a half-done merge is a refusal, because `add -A` +
 * `commit` would complete it silently.
 */
export async function checkpoint(params: {
  worktreePath: string;
  expectedBranch?: string;
  message?: string;
  identity?: GitIdentity;
}): Promise<CheckpointResult> {
  const { branch } = await assertMutableWorktree(params);
  await refuseMidMerge(params.worktreePath, 'checkpoint');
  const message = params.message ?? `tm8 checkpoint ${new Date().toISOString()}`;
  assertSafeMessage(message);

  const files = await changedFiles(params.worktreePath);
  if (files.length === 0) {
    return { oid: await headOid(params.worktreePath), branch, created: false, files: [] };
  }

  const added = await git(['add', '-A'], params.worktreePath);
  if (added.code !== 0) {
    throw new WorktreeError('git add -A failed', 'internal', 'add_failed', { stderr: added.stderr.trim() });
  }
  const committed = await git(
    [...identityArgs(params.identity), 'commit', '-m', message],
    params.worktreePath,
  );
  if (committed.code !== 0) {
    throw new WorktreeError('git commit failed', 'internal', 'commit_failed', { stderr: committed.stderr.trim() });
  }
  return { oid: await headOid(params.worktreePath), branch, created: true, files };
}

export interface RollbackResult {
  /** Where HEAD (and the branch) now point. */
  oid: string;
  branch: string;
  /** HEAD before the rollback — the reflog keeps it reachable. */
  previousOid: string;
  /** Untracked paths deleted because --force said to. */
  deletedUntracked: string[];
}

/**
 * Restore the worktree to a checkpoint: `reset --hard` to the resolved commit,
 * moving the branch ref with it. Commits rolled over remain in the reflog, so
 * a rollback is itself reversible with another rollback to the newer oid.
 *
 * UNTRACKED FILES ARE THE REFUSAL CONDITION. Tracked WIP is what a rollback
 * exists to discard; an untracked file is different — it may exist in NO
 * commit, so deleting or overwriting it is unrecoverable. With untracked
 * files present the whole verb refuses unless `force`, which then also
 * `clean -fd`s them so the restored state is exactly the checkpoint.
 */
export async function rollback(params: {
  worktreePath: string;
  /** Checkpoint ref: full oid, short oid, or a symbolic ref. */
  to: string;
  expectedBranch?: string;
  force?: boolean;
}): Promise<RollbackResult> {
  const { branch } = await assertMutableWorktree(params);
  const targetOid = await resolveCommitish(params.worktreePath, params.to);
  const previousOid = await headOid(params.worktreePath);

  const untracked = (await changedFiles(params.worktreePath))
    .filter((f) => f.status === '??')
    .map((f) => f.path);
  if (untracked.length > 0 && params.force !== true) {
    throw new WorktreeError(
      `rollback would delete ${untracked.length} untracked file(s); refuse without --force`,
      'conflict', 'untracked_files_present', { untracked },
    );
  }

  const reset = await git(['reset', '--hard', targetOid], params.worktreePath);
  if (reset.code !== 0) {
    throw new WorktreeError('git reset --hard failed', 'internal', 'reset_failed', { stderr: reset.stderr.trim() });
  }
  let deletedUntracked: string[] = [];
  if (untracked.length > 0) {
    const cleaned = await git(['clean', '-fd'], params.worktreePath);
    if (cleaned.code !== 0) {
      throw new WorktreeError('git clean -fd failed', 'internal', 'clean_failed', { stderr: cleaned.stderr.trim() });
    }
    deletedUntracked = untracked;
  }
  return { oid: targetOid, branch, previousOid, deletedUntracked };
}

/**
 * Stage pathspecs (behind a literal `--`) or everything (`-A`). Returns what
 * is staged AFTER the operation so the caller can show the commit preview.
 */
export async function stage(params: {
  worktreePath: string;
  expectedBranch?: string;
  paths?: readonly string[];
  all?: boolean;
}): Promise<{ staged: ChangedFile[] }> {
  await assertMutableWorktree(params);
  await refuseMidMerge(params.worktreePath, 'stage');
  const paths = params.paths ?? [];
  if (params.all !== true && paths.length === 0) {
    throw new WorktreeError('stage needs pathspecs or all: true', 'invalid_input', 'nothing_to_stage');
  }
  for (const p of paths) assertSafePathspec(p);
  const args = params.all === true ? ['add', '-A'] : ['add', '--', ...paths];
  const added = await git(args, params.worktreePath);
  if (added.code !== 0) {
    throw new WorktreeError(
      'git add failed', 'invalid_input', 'add_failed',
      { stderr: added.stderr.trim() },
    );
  }
  return { staged: await stagedFiles(params.worktreePath) };
}

export interface CommitResult {
  oid: string;
  branch: string;
  files: ChangedFile[];
}

/** Commit exactly what is staged. An empty index is a refusal, not a no-op commit. */
export async function commit(params: {
  worktreePath: string;
  message: string;
  expectedBranch?: string;
  identity?: GitIdentity;
}): Promise<CommitResult> {
  const { branch } = await assertMutableWorktree(params);
  await refuseMidMerge(params.worktreePath, 'commit');
  assertSafeMessage(params.message);
  const files = await stagedFiles(params.worktreePath);
  if (files.length === 0) {
    throw new WorktreeError('nothing is staged', 'conflict', 'nothing_staged', {
      hint: 'stage changes first (tm8 worktree stage)',
    });
  }
  const committed = await git(
    [...identityArgs(params.identity), 'commit', '-m', params.message],
    params.worktreePath,
  );
  if (committed.code !== 0) {
    throw new WorktreeError('git commit failed', 'internal', 'commit_failed', { stderr: committed.stderr.trim() });
  }
  return { oid: await headOid(params.worktreePath), branch, files };
}

export type MergeResult =
  | { status: 'merged'; oid: string; fromOid: string }
  | { status: 'up_to_date'; oid: string; fromOid: string }
  | { status: 'conflict'; fromOid: string; conflictedPaths: string[] };

/**
 * Merge `fromRef` INTO the worktree's branch, in the worktree.
 *
 * THE CONTRACT ON CONFLICT: collect the conflicted paths, `merge --abort`,
 * VERIFY the abort took (no MERGE_HEAD, clean status), and return them as
 * DATA. This function never throws for a content conflict and never returns
 * with the worktree mid-merge — a conflict is an ANSWER for the caller to
 * surface durably, not an error state to strand on disk. If the abort itself
 * fails, that IS thrown (`merge_abort_failed`), because a worktree it could
 * not clean up is precisely what the caller must escalate loudest about.
 *
 * The other direction (session branch → base) is deliberately absent: base
 * is checked out in the USER'S primary tree or nowhere, and a session verb
 * that mutates the user's checkout would violate the rule every lane in this
 * program operates under. Land session work on base through a PR, or merge
 * base forward into the session branch here.
 */
export async function mergeFromRef(params: {
  worktreePath: string;
  fromRef: string;
  expectedBranch?: string;
  identity?: GitIdentity;
  message?: string;
}): Promise<MergeResult> {
  const { branch } = await assertMutableWorktree(params);
  await refuseMidMerge(params.worktreePath, 'merge');

  const dirty = await changedFiles(params.worktreePath);
  if (dirty.length > 0) {
    throw new WorktreeError(
      'merge refused: the worktree has uncommitted changes',
      'conflict', 'dirty_worktree',
      { hint: 'checkpoint or commit first, so a conflicted merge can abort to a clean state', files: dirty.length },
    );
  }

  // Resolve BEFORE merging — the ref must not move between probe and merge,
  // and the resolved oid is what the result records as provenance.
  const fromOid = await resolveCommitish(params.worktreePath, params.fromRef);
  const before = await headOid(params.worktreePath);
  const message = params.message ?? `tm8 merge ${params.fromRef} into ${branch}`;
  assertSafeMessage(message);

  const merged = await git(
    [...identityArgs(params.identity), 'merge', '--no-edit', '-m', message, fromOid],
    params.worktreePath,
  );
  if (merged.code === 0) {
    const after = await headOid(params.worktreePath);
    return after === before
      ? { status: 'up_to_date', oid: after, fromOid }
      : { status: 'merged', oid: after, fromOid };
  }

  // Non-zero: conflict, or a merge that never started (unrelated histories…).
  const conflicted = await git(['diff', '--name-only', '--diff-filter=U', '-z'], params.worktreePath);
  const conflictedPaths = conflicted.stdout.split('\u0000').filter((p) => p.length > 0);
  if (!(await mergeInProgress(params.worktreePath)) && conflictedPaths.length === 0) {
    throw new WorktreeError(
      `git merge failed before starting: ${merged.stderr.trim()}`,
      'conflict', 'merge_failed', { stderr: merged.stderr.trim() },
    );
  }

  const aborted = await git(['merge', '--abort'], params.worktreePath);
  const stillMerging = await mergeInProgress(params.worktreePath);
  const residue = await changedFiles(params.worktreePath);
  if (aborted.code !== 0 || stillMerging || residue.length > 0) {
    throw new WorktreeError(
      'merge conflicted AND the abort did not restore a clean worktree — manual repair needed',
      'internal', 'merge_abort_failed',
      { stderr: aborted.stderr.trim(), stillMerging, residue: residue.length, conflictedPaths },
    );
  }
  return { status: 'conflict', fromOid, conflictedPaths };
}
