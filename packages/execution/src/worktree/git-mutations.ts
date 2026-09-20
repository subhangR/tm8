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
import { buildSubsetPatch, digestHunks, parseUnifiedDiff, selectHunks, type ParsedDiff } from './hunks.js';

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
  // `--literal-pathspecs` BEFORE the subcommand: the paths are exact names
  // from a status listing, and a name containing `*` must stage that file and
  // not everything it would match. See the env default in `git-invoker`.
  const args = params.all === true ? ['add', '-A'] : ['--literal-pathspecs', 'add', '--', ...paths];
  const added = await git(args, params.worktreePath);
  if (added.code !== 0) {
    throw new WorktreeError(
      'git add failed', 'invalid_input', 'add_failed',
      { stderr: added.stderr.trim() },
    );
  }
  return { staged: await stagedFiles(params.worktreePath) };
}

/**
 * A STAGED RENAME IS ONE ROW AND TWO INDEX ENTRIES.
 *
 * `git status` and `git diff --cached` both report `git mv old new` as a
 * SINGLE row — `R100 old new` — so every surface above this one holds it as
 * one file with a `path` and an `origPath`. The index does not: it holds the
 * DELETION of `old` and the ADDITION of `new`, two entries. `git reset HEAD --
 * new` therefore unstages exactly half of it, and leaves behind a staged
 * deletion of a file the reviewer never asked to delete plus an untracked
 * `new` — a worse index than the one they started with, reached by pressing a
 * button labelled "Unstage".
 *
 * So unstage expands a rename to both of its paths, HERE rather than in a
 * caller, because every caller has the same half and picking one is not a
 * choice any of them should be making.
 *
 * COPIES ARE DELIBERATELY NOT EXPANDED. `C100 old new` means the index added
 * `new`; `old` is untouched by that operation and may carry a genuine, wholly
 * unrelated staged change of its own. Resetting it would be the silent
 * widening this expansion exists to prevent, pointed the other way.
 */
async function expandStagedRenames(
  worktreePath: string,
  paths: readonly string[],
): Promise<string[]> {
  const asked = new Set(paths);
  const out = [...paths];
  const seen = new Set(paths);
  for (const file of await stagedFiles(worktreePath)) {
    if (!file.status.startsWith('R') || file.origPath === undefined) continue;
    if (!asked.has(file.path) && !asked.has(file.origPath)) continue;
    for (const half of [file.path, file.origPath]) {
      if (seen.has(half)) continue;
      // Git's own output, guarded anyway: this list reaches an argv slot and
      // a path never passes that boundary unchecked, whoever produced it.
      assertSafePathspec(half);
      seen.add(half);
      out.push(half);
    }
  }
  return out;
}

/**
 * UNSTAGE — move the index back to HEAD for these paths, and touch nothing
 * else. The mirror of `stage`, and the verb whose absence meant a reviewer
 * could put a file into a commit but never take it out again.
 *
 * `git reset -q HEAD -- <paths>` is a MIXED reset: it rewrites the index and
 * leaves every byte in the working tree exactly where it was. That is the
 * whole safety argument for this verb, and it is why `--hard` (and `--merge`,
 * and `checkout --` ) are not reachable from here under any argument. A lane
 * holds an agent's uncommitted work; a verb that could discard it while
 * calling itself "unstage" is the silent data loss this module is written to
 * make impossible. Discarding work is `rollback`, which gates on `force` and
 * reports the untracked paths it deleted.
 *
 * `all` unstages the whole index — still mixed, still worktree-safe.
 *
 * MID-MERGE IS REFUSED, exactly as `stage` refuses it, and for a sharper
 * reason: during a merge the index holds the CONFLICT STAGES (1/2/3), and
 * resetting a conflicted path to HEAD throws away the resolution work and
 * leaves a half-merged tree that looks clean. tm8 verbs never complete or
 * unpick a merge implicitly.
 */
export async function unstage(params: {
  worktreePath: string;
  expectedBranch?: string;
  paths?: readonly string[];
  all?: boolean;
  /** `paths` on the result is what was ACTUALLY reset — see the expansion. */
}): Promise<{ staged: ChangedFile[]; paths: string[] }> {
  await assertMutableWorktree(params);
  await refuseMidMerge(params.worktreePath, 'unstage');
  const paths = params.paths ?? [];
  if (params.all !== true && paths.length === 0) {
    throw new WorktreeError('unstage needs pathspecs or all: true', 'invalid_input', 'nothing_to_unstage');
  }
  for (const p of paths) assertSafePathspec(p);
  // An unborn branch has no HEAD to reset to. Caught by name rather than let
  // through as a raw git failure, because "there is no first commit yet" is a
  // different fact from "the reset failed".
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], params.worktreePath);
  if (head.code !== 0) {
    throw new WorktreeError(
      'worktree has no HEAD commit to unstage against', 'conflict', 'no_head',
      { hint: 'nothing has been committed on this branch yet; there is no HEAD state to restore the index to' },
    );
  }
  // Read the index BEFORE the reset: afterwards the rename row is gone and
  // its other half is unreachable.
  const resetPaths = params.all === true ? [] : await expandStagedRenames(params.worktreePath, paths);
  // MIXED by omission — `git reset` with no mode flag is `--mixed`, and a
  // path-scoped reset cannot be anything else (git refuses `--hard` with
  // pathspecs outright). The mode is never caller-supplied.
  const args = params.all === true
    ? ['reset', '-q', 'HEAD']
    // Literal for the same reason `stage` is: exact names, never patterns.
    : ['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', ...resetPaths];
  const reset = await git(args, params.worktreePath);
  if (reset.code !== 0) {
    throw new WorktreeError(
      'git reset failed', 'invalid_input', 'unstage_failed',
      { stderr: reset.stderr.trim() },
    );
  }
  return { staged: await stagedFiles(params.worktreePath), paths: resetPaths };
}

export interface CommitResult {
  oid: string;
  branch: string;
  files: ChangedFile[];
}

/**
 * THE ONE PLACE A SPLITTABLE DIFF IS DERIVED.
 *
 * Both the read that TELLS a client which hunks exist and the write that
 * verifies the client's digest go through here, because a digest is only
 * worth anything if the two sides derive the same bytes. The flags are the
 * reason this is not "just `git diff`" at each call site:
 *
 *   `--literal-pathspecs` — the path is an exact name from a status listing,
 *     and a name containing `*` must mean that file (see `stage`);
 *   `--no-renames` — with detection on, a renamed path pulls its counterpart
 *     in, and a two-file diff is one the parser refuses. Better never produced;
 *   `--no-ext-diff` / `--no-textconv` — a repo's own config can substitute a
 *     human-readable diff that git cannot apply. That is a trap for a verb
 *     whose whole job is to feed the text back to `git apply`.
 *
 * Drifting these apart at either call site reintroduces a stale-digest
 * refusal that no edit explains, so there is deliberately no second spelling.
 */
async function deriveHunks(worktreePath: string, path: string, staged: boolean): Promise<ParsedDiff> {
  const diff = await git(
    [
      '--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
      ...(staged ? ['--cached'] : []),
      '--', path,
    ],
    worktreePath,
    { maxBufferBytes: HUNK_DIFF_MAX_BYTES },
  );
  if (diff.code !== 0) {
    throw new WorktreeError('git diff failed', 'internal', 'diff_failed', { stderr: diff.stderr.trim() });
  }
  if (diff.stdout.trim().length === 0) {
    // An untracked file lands here: `git diff` cannot see it, because it has
    // no index entry to diff against. Say so by name — the honest remedy is
    // to stage the whole file once, after which its hunks become selectable.
    throw new WorktreeError(
      `no ${staged ? 'staged' : 'unstaged'} changes in ${JSON.stringify(path)}`,
      'conflict', 'no_hunks_available',
      { path, hint: 'an untracked file has no diff to split; stage the whole file first' },
    );
  }
  const parsed = parseUnifiedDiff(diff.stdout);
  if (parsed.binary) {
    throw new WorktreeError(
      `${JSON.stringify(path)} is a binary file and has no hunks`,
      'invalid_input', 'binary_file',
      { path, hint: 'stage or unstage the whole file' },
    );
  }
  return parsed;
}

/** What a client needs to offer a hunk selection: how many, and which ones. */
export interface HunkListing {
  path: string;
  staged: boolean;
  count: number;
  /** Echo this back with a selection; `stageHunks` refuses if it moved. */
  digest: string;
  hunks: { index: number; heading: string; oldStart: number; newStart: number; text: string }[];
}

/**
 * List the hunks of one file, with the digest that pins them.
 *
 * Returns `null` for the two states that are not failures of the read — an
 * untracked or binary path simply has no hunks to offer, and a client asking
 * "can this file be split?" deserves "no" rather than an exception it has to
 * classify. `stageHunks` still THROWS for both, because there the same state
 * means a selection was made against something that cannot honour it.
 */
export async function readHunks(params: {
  worktreePath: string;
  path: string;
  staged?: boolean;
}): Promise<HunkListing | null> {
  await assertWorktreeDir(params.worktreePath);
  assertSafePathspec(params.path);
  const staged = params.staged === true;
  let parsed: ParsedDiff;
  try {
    parsed = await deriveHunks(params.worktreePath, params.path, staged);
  } catch (error) {
    const reason = error instanceof WorktreeError ? error.reason : '';
    if (reason === 'no_hunks_available' || reason === 'binary_file') return null;
    throw error;
  }
  return {
    path: params.path,
    staged,
    count: parsed.hunks.length,
    digest: digestHunks(parsed.hunks),
    hunks: parsed.hunks.map((h) => ({
      index: h.index, heading: h.heading, oldStart: h.oldStart, newStart: h.newStart, text: h.text,
    })),
  };
}

/** What `stageHunks` did, plus the post-operation index so the UI need not re-read. */
export interface StageHunksResult {
  path: string;
  /** How many hunks the patch carried — the caller's selection, after de-duplication. */
  appliedHunks: number;
  /** Total hunks in the diff the server derived, so the UI can say "2 of 5". */
  totalHunks: number;
  staged: ChangedFile[];
}

/** The diff-read cap. A single file's diff past this is not a review surface. */
const HUNK_DIFF_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Stage or unstage INDIVIDUAL HUNKS of one file — `git add -p` without the
 * prompt, driven by hunk indices from a UI.
 *
 * THE CLIENT NEVER SENDS PATCH TEXT. It sends a path and a list of indices,
 * and the server re-derives the diff itself and slices it. This is the whole
 * security posture of the verb: a patch reaching `git apply --cached` is a
 * write primitive for ANY path in the repository — `--cached` writes the
 * index, so a hostile patch would not even need to touch the working tree to
 * put content into the next commit. Indices cannot express that. They can only
 * select a subset of a diff the server just computed for a path it already
 * validated.
 *
 * WHICH DIFF, AND WHY EACH IS THE RIGHT PRE-IMAGE:
 *   stage   — `git diff -- <path>`          (index → worktree). Applying it to
 *             the index with `--cached` moves the selected hunks into the
 *             index, leaving the rest unstaged. This is exactly `git add -p`.
 *   unstage — `git diff --cached -- <path>` (HEAD → index). Applying it to the
 *             index REVERSED backs the selected hunks out. This is `git reset -p`.
 * In both directions the patch's pre-image is the index, which is what
 * `--cached` applies against, so a stale selection fails loudly in `git apply`
 * instead of landing somewhere unintended.
 *
 * `digest` is the caller's claim about WHICH hunks they were looking at. The
 * diff can change under a live agent lane between render and click, and the
 * indices would still be in range — pointing at different code. The digest
 * covers hunk BODY text only, deliberately: an edit elsewhere in the file
 * renumbers every later `@@` header without changing the hunk the reviewer
 * approved, and refusing that would make the feature unusable in the only
 * place it is ever used.
 */
export async function stageHunks(params: {
  worktreePath: string;
  expectedBranch?: string;
  path: string;
  indices: readonly number[];
  /** Fail unless the server's freshly-read hunks still digest to this. */
  digest?: string;
  /** true = remove these hunks from the index (unstage); false = add them. */
  reverse?: boolean;
}): Promise<StageHunksResult> {
  const verb = params.reverse === true ? 'unstage' : 'stage';
  await assertMutableWorktree(params);
  await refuseMidMerge(params.worktreePath, `${verb} hunks`);
  assertSafePathspec(params.path);
  if (params.indices.length === 0) {
    throw new WorktreeError(`${verb} hunks needs at least one hunk index`, 'invalid_input', 'no_hunks_selected');
  }

  const parsed = await deriveHunks(params.worktreePath, params.path, params.reverse === true);

  if (params.digest !== undefined) {
    const actual = digestHunks(parsed.hunks);
    if (actual !== params.digest) {
      // The same shape as the facade's staged_outside_selection refusal: the
      // caller is told the world moved, not handed a silent partial result.
      throw new WorktreeError(
        `${params.path} changed since the hunks were listed`,
        'conflict', 'hunks_stale',
        { path: params.path, expectedDigest: params.digest, actualDigest: actual,
          hint: 'reload the diff and re-select; the file was edited under the selection' },
      );
    }
  }

  const selected = selectHunks(parsed, params.indices);
  const patch = buildSubsetPatch(parsed, selected);

  // NO `--recount`. MEASURED (git 2.x, this box): `git apply` validates BOTH
  // hunk COUNTS against the body and rejects a mismatch outright — "corrupt
  // patch at line N" — but it IGNORES the new-side START, applying a hunk
  // headed `@@ -2,3 +99,3 @@` to the right place without complaint. So
  // `--recount` would suppress the one class of subset-builder bug git can
  // still catch for us, and buys nothing for the class it cannot.
  //
  // The offset recomputation is therefore NOT guarded by git. It is guarded
  // only by `execution/test/hunks.test.ts` ("RECOMPUTES the new-side offset"),
  // verified by mutation: breaking the recomputation reddens those unit tests
  // while all twelve real-git cases still pass. Do not delete them thinking
  // the integration suite covers it — it does not.
  const applyArgs = [
    'apply', '--cached', '--whitespace=nowarn',
    ...(params.reverse === true ? ['--reverse'] : []),
    '-',
  ];
  const applied = await git(applyArgs, params.worktreePath, { stdin: patch });
  if (applied.code !== 0) {
    throw new WorktreeError(
      `git apply --cached refused the ${verb} patch`,
      'conflict', 'hunk_apply_failed',
      { path: params.path, stderr: applied.stderr.trim(),
        hint: 'the file moved under the selection; reload the diff and re-select' },
    );
  }

  return {
    path: params.path,
    appliedHunks: selected.length,
    totalHunks: parsed.hunks.length,
    staged: await stagedFiles(params.worktreePath),
  };
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

// ═══ Tier 2 completion: cherry-pick / branch ops / stash ════════════════════
//
// The same laws as above, verbatim: argv-only git, no client paths, loud typed
// refusals, and — for the two verbs that can conflict (cherry-pick, stash
// pop) — the merge verb's contract copied exactly: abort, VERIFY the abort
// took by reading git state, and return the conflicted paths as DATA.

/**
 * Branch names for the branch verbs, validated to GIT'S OWN rules
 * (git-check-ref-format), not the stricter revision-ref subset above.
 *
 * The distinction is deliberate: `assertSafeRefName` guards CLIENT-SUPPLIED
 * revision expressions and refuses shell metacharacters as defense in depth,
 * but git's ref rules PERMIT `$ ( ) ; & > ' " | { }` — so a branch named
 * `feat/x;echo>pwned` legitimately exists in the wild and the branch verbs
 * must be able to create, rename and delete it. That is safe here because the
 * invoker is execFile argv (no shell EVER sees the name) and the name rides
 * behind a literal `--` in every branch invocation. What git itself bans is
 * still refused: option shapes, control bytes and space, `~ ^ : ? * [ \`,
 * `..`, `@{`, bad dot/slash/.lock placement, and the literal `HEAD`.
 */
export function assertGitLegalBranchName(name: string): void {
  const refuse = (why: string): never => {
    throw new WorktreeError(
      `illegal branch name ${JSON.stringify(name)}: ${why}`,
      'invalid_input', 'illegal_branch_name',
    );
  };
  if (name.length === 0 || name.length > 255) refuse('empty or too long');
  if (name.startsWith('-')) refuse('leading dash reads as an option');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f ]/.test(name)) refuse('control characters or spaces');
  if (/[~^:?*\[\\]/.test(name)) refuse('characters git-check-ref-format bans');
  if (name.includes('..') || name.includes('@{')) refuse('revision-range syntax');
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) refuse('bad slash placement');
  if (name.endsWith('.lock') || name.endsWith('.')) refuse('dot placement git refuses');
  if (name.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'))) refuse('dot placement git refuses');
  if (name === 'HEAD') refuse('HEAD is not a branch name');
}

/** Branches checked out in ANY worktree of this repo, primary tree included. */
export async function checkedOutBranches(worktreePath: string): Promise<Map<string, string>> {
  const res = await git(['worktree', 'list', '--porcelain'], worktreePath);
  if (res.code !== 0) {
    throw new WorktreeError('git worktree list failed', 'internal', 'worktree_list_failed', { stderr: res.stderr.trim() });
  }
  const out = new Map<string, string>();
  let dir: string | null = null;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/') && dir !== null) {
      out.set(line.slice('branch refs/heads/'.length), dir);
    }
  }
  return out;
}

async function branchExists(worktreePath: string, name: string): Promise<boolean> {
  const res = await git(['rev-parse', '-q', '--verify', `refs/heads/${name}`], worktreePath);
  return res.code === 0;
}

/**
 * The two refusals every destructive branch verb shares: a branch that is
 * checked out in ANY worktree (mutating it would re-point someone's checkout,
 * the user's primary tree included), and the caller-declared protected set
 * (the project's default/base branch — the graph knows it, this layer only
 * enforces it).
 */
async function refuseProtectedBranch(
  worktreePath: string,
  name: string,
  verb: string,
  protectedBranches: readonly string[],
): Promise<void> {
  const checkedOut = await checkedOutBranches(worktreePath);
  const where = checkedOut.get(name);
  if (where !== undefined) {
    throw new WorktreeError(
      `${verb} refused: branch ${JSON.stringify(name)} is checked out in worktree ${where}`,
      'conflict', 'branch_checked_out', { branch: name, worktree: where },
    );
  }
  if (protectedBranches.includes(name)) {
    throw new WorktreeError(
      `${verb} refused: ${JSON.stringify(name)} is a protected branch (project default/base)`,
      'conflict', 'branch_protected', { branch: name, protectedBranches: [...protectedBranches] },
    );
  }
}

export interface BranchCreateResult {
  name: string;
  /** The commit the new branch points at. */
  oid: string;
}

/** Create a branch at `from` (default: the worktree's HEAD). Never checks it out. */
export async function branchCreate(params: {
  worktreePath: string;
  name: string;
  /** Commitish the branch starts at; defaults to HEAD. */
  from?: string;
}): Promise<BranchCreateResult> {
  await assertWorktreeDir(params.worktreePath);
  assertGitLegalBranchName(params.name);
  const oid = params.from === undefined
    ? await headOid(params.worktreePath)
    : await resolveCommitish(params.worktreePath, params.from);
  if (await branchExists(params.worktreePath, params.name)) {
    throw new WorktreeError(
      `branch already exists: ${JSON.stringify(params.name)}`,
      'conflict', 'branch_exists', { branch: params.name },
    );
  }
  const res = await git(['branch', '--', params.name, oid], params.worktreePath);
  if (res.code !== 0) {
    throw new WorktreeError('git branch failed', 'invalid_input', 'branch_create_failed', { stderr: res.stderr.trim() });
  }
  return { name: params.name, oid };
}

export interface BranchRenameResult {
  from: string;
  to: string;
  oid: string;
}

/** Rename a branch that is checked out NOWHERE and is not protected. */
export async function branchRename(params: {
  worktreePath: string;
  from: string;
  to: string;
  /** Branches the caller's graph marks untouchable (project default/base). */
  protectedBranches?: readonly string[];
}): Promise<BranchRenameResult> {
  await assertWorktreeDir(params.worktreePath);
  assertGitLegalBranchName(params.from);
  assertGitLegalBranchName(params.to);
  if (!(await branchExists(params.worktreePath, params.from))) {
    throw new WorktreeError(`no such branch: ${JSON.stringify(params.from)}`, 'not_found', 'branch_not_found');
  }
  await refuseProtectedBranch(params.worktreePath, params.from, 'rename', params.protectedBranches ?? []);
  if (await branchExists(params.worktreePath, params.to)) {
    throw new WorktreeError(
      `target branch already exists: ${JSON.stringify(params.to)}`,
      'conflict', 'branch_exists', { branch: params.to },
    );
  }
  const oidRes = await git(['rev-parse', '--verify', `refs/heads/${params.from}`], params.worktreePath);
  const res = await git(['branch', '-m', '--', params.from, params.to], params.worktreePath);
  if (res.code !== 0) {
    throw new WorktreeError('git branch -m failed', 'invalid_input', 'branch_rename_failed', { stderr: res.stderr.trim() });
  }
  return { from: params.from, to: params.to, oid: oidRes.stdout.trim() };
}

export interface BranchDeleteResult {
  name: string;
  /** The deleted tip — still reachable by this oid until gc, and the receipt says so. */
  deletedOid: string;
  /** What "unmerged" was measured against when force was required. */
  measuredAgainst: string;
  forced: boolean;
}

/**
 * Delete a branch that is checked out NOWHERE and is not protected.
 *
 * "Unmerged" is MEASURED, and the measurement is named in both the refusal
 * and the result: the branch tip is unmerged iff it is not an ancestor of the
 * worktree's current HEAD branch. An unmerged delete refuses without
 * `force: true`; a forced delete still returns the tip oid, which keeps the
 * commits reachable (`git branch <name> <oid>` resurrects it) until gc.
 */
export async function branchDelete(params: {
  worktreePath: string;
  name: string;
  force?: boolean;
  protectedBranches?: readonly string[];
}): Promise<BranchDeleteResult> {
  await assertWorktreeDir(params.worktreePath);
  assertGitLegalBranchName(params.name);
  if (!(await branchExists(params.worktreePath, params.name))) {
    throw new WorktreeError(`no such branch: ${JSON.stringify(params.name)}`, 'not_found', 'branch_not_found');
  }
  await refuseProtectedBranch(params.worktreePath, params.name, 'delete', params.protectedBranches ?? []);

  const measuredAgainst = (await currentBranch(params.worktreePath)) ?? 'HEAD';
  const tip = await git(['rev-parse', '--verify', `refs/heads/${params.name}`], params.worktreePath);
  const deletedOid = tip.stdout.trim();
  const merged = await git(['merge-base', '--is-ancestor', deletedOid, 'HEAD'], params.worktreePath);
  const isMerged = merged.code === 0;
  if (!isMerged && params.force !== true) {
    throw new WorktreeError(
      `branch ${JSON.stringify(params.name)} is not merged into ${JSON.stringify(measuredAgainst)} (the worktree's HEAD branch); refuse without force`,
      'conflict', 'branch_unmerged',
      { branch: params.name, measuredAgainst, tip: deletedOid, hint: 'pass force to delete anyway — the tip oid stays in the receipt' },
    );
  }
  const res = await git(
    ['branch', isMerged ? '-d' : '-D', '--', params.name],
    params.worktreePath,
  );
  if (res.code !== 0) {
    throw new WorktreeError('git branch -d failed', 'conflict', 'branch_delete_failed', { stderr: res.stderr.trim() });
  }
  return { name: params.name, deletedOid, measuredAgainst, forced: !isMerged };
}

async function cherryPickInProgress(worktreePath: string): Promise<boolean> {
  const res = await git(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], worktreePath);
  return res.code === 0;
}

export type CherryPickResult =
  | { status: 'picked'; branch: string; fromOids: string[]; newOids: string[] }
  | { status: 'conflict'; branch: string; fromOids: string[]; conflictedPaths: string[] };

/**
 * Apply one or more commits onto the worktree's branch, in the worktree.
 *
 * THE CONTRACT ON CONFLICT is mergeFromRef's, copied verbatim: collect the
 * conflicted paths, `cherry-pick --abort`, VERIFY the abort took (no
 * CHERRY_PICK_HEAD, clean status, HEAD back where it started — or throw
 * `cherry_pick_abort_failed` loudly), and return the paths as DATA. A
 * multi-commit pick aborts the WHOLE sequence: partial application is a
 * half-state a later verb would trip over.
 */
export async function cherryPick(params: {
  worktreePath: string;
  /** Commitishes to apply, oldest first. Each resolves before anything runs. */
  commits: readonly string[];
  expectedBranch?: string;
  identity?: GitIdentity;
}): Promise<CherryPickResult> {
  const { branch } = await assertMutableWorktree(params);
  await refuseMidMerge(params.worktreePath, 'cherry-pick');
  if (await cherryPickInProgress(params.worktreePath)) {
    throw new WorktreeError(
      'cherry-pick refused: a cherry-pick is already in progress in this worktree',
      'conflict', 'cherry_pick_in_progress',
    );
  }
  if (params.commits.length === 0) {
    throw new WorktreeError('cherry-pick needs at least one commit', 'invalid_input', 'no_commits');
  }
  const dirty = await changedFiles(params.worktreePath);
  if (dirty.length > 0) {
    throw new WorktreeError(
      'cherry-pick refused: the worktree has uncommitted changes',
      'conflict', 'dirty_worktree',
      { hint: 'checkpoint or commit first, so a conflicted pick can abort to a clean state', files: dirty.length },
    );
  }

  const fromOids: string[] = [];
  for (const c of params.commits) fromOids.push(await resolveCommitish(params.worktreePath, c));
  const before = await headOid(params.worktreePath);

  const picked = await git(
    [...identityArgs(params.identity), 'cherry-pick', '--allow-empty', ...fromOids],
    params.worktreePath,
  );
  if (picked.code === 0) {
    const listed = await git(['rev-list', '--reverse', `${before}..HEAD`], params.worktreePath);
    const newOids = listed.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    return { status: 'picked', branch, fromOids, newOids };
  }

  const conflicted = await git(['diff', '--name-only', '--diff-filter=U', '-z'], params.worktreePath);
  const conflictedPaths = conflicted.stdout.split('\u0000').filter((p) => p.length > 0);
  const sequencing = await cherryPickInProgress(params.worktreePath);
  if (!sequencing && conflictedPaths.length === 0) {
    throw new WorktreeError(
      `git cherry-pick failed before starting: ${picked.stderr.trim()}`,
      'conflict', 'cherry_pick_failed', { stderr: picked.stderr.trim() },
    );
  }

  const aborted = await git(['cherry-pick', '--abort'], params.worktreePath);
  const stillPicking = await cherryPickInProgress(params.worktreePath);
  const residue = await changedFiles(params.worktreePath);
  const after = await headOid(params.worktreePath);
  if (aborted.code !== 0 || stillPicking || residue.length > 0 || after !== before) {
    throw new WorktreeError(
      'cherry-pick conflicted AND the abort did not restore a clean worktree — manual repair needed',
      'internal', 'cherry_pick_abort_failed',
      { stderr: aborted.stderr.trim(), stillPicking, residue: residue.length, headMoved: after !== before, conflictedPaths },
    );
  }
  return { status: 'conflict', branch, fromOids, conflictedPaths };
}

// ── stash, per worktree ─────────────────────────────────────────────────────

export interface StashEntry {
  /** Position in the stash list; stash@{index}. */
  index: number;
  oid: string;
  subject: string;
  date: string;
}

/** stash@{n} is SERVER-FORMATTED from an integer — never a client string. */
function stashRef(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new WorktreeError(`stash index must be a non-negative integer, got ${index}`, 'invalid_input', 'invalid_stash_index');
  }
  return `stash@{${index}}`;
}

export async function stashList(worktreePath: string): Promise<StashEntry[]> {
  await assertWorktreeDir(worktreePath);
  const res = await git(
    ['stash', 'list', '--format=%H\u001f%ci\u001f%gs'],
    worktreePath,
  );
  if (res.code !== 0) {
    throw new WorktreeError('git stash list failed', 'internal', 'stash_list_failed', { stderr: res.stderr.trim() });
  }
  const entries: StashEntry[] = [];
  for (const line of res.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [oid, date, subject] = line.split('\u001f');
    if (!oid || !date) continue;
    entries.push({ index: entries.length, oid, date, subject: subject ?? '' });
  }
  return entries;
}

export type StashPushResult =
  | { status: 'stashed'; oid: string; branch: string; files: ChangedFile[] }
  | { status: 'clean'; branch: string };

/**
 * Stash ALL work-in-progress, untracked included (`-u`): unlike rollback,
 * pushing untracked files into a stash STORES them, so no force gate — the
 * verb is the safe direction of the asymmetry. A clean tree is a success
 * that stores nothing, mirroring checkpoint.
 */
export async function stashPush(params: {
  worktreePath: string;
  expectedBranch?: string;
  message?: string;
  identity?: GitIdentity;
}): Promise<StashPushResult> {
  const { branch } = await assertMutableWorktree(params);
  await refuseMidMerge(params.worktreePath, 'stash push');
  const message = params.message ?? `tm8 stash ${new Date().toISOString()}`;
  assertSafeMessage(message);
  const files = await changedFiles(params.worktreePath);
  if (files.length === 0) return { status: 'clean', branch };
  const res = await git(
    [...identityArgs(params.identity), 'stash', 'push', '-u', '-m', message],
    params.worktreePath,
  );
  if (res.code !== 0) {
    throw new WorktreeError('git stash push failed', 'internal', 'stash_push_failed', { stderr: res.stderr.trim() });
  }
  const top = await git(['rev-parse', '--verify', 'refs/stash'], params.worktreePath);
  return { status: 'stashed', oid: top.stdout.trim(), branch, files };
}

export type StashPopResult =
  | { status: 'popped'; branch: string; oid: string; files: ChangedFile[] }
  | { status: 'conflict'; branch: string; oid: string; conflictedPaths: string[] };

/**
 * Pop a stash entry into a CLEAN worktree. The clean-tree requirement exists
 * for the same reason merge's does: it is what makes the conflict contract
 * honest. On conflict the entry is NOT dropped (git keeps it), the apply is
 * rolled back (`reset --hard` + `clean -fd` — every untracked file present
 * came from the failed pop, the tree was clean), and the abort is VERIFIED:
 * clean status AND the stash entry still present, or `stash_pop_abort_failed`
 * is thrown loudly.
 */
export async function stashPop(params: {
  worktreePath: string;
  expectedBranch?: string;
  index?: number;
}): Promise<StashPopResult> {
  const { branch } = await assertMutableWorktree(params);
  await refuseMidMerge(params.worktreePath, 'stash pop');
  const index = params.index ?? 0;
  const ref = stashRef(index);
  const entries = await stashList(params.worktreePath);
  const entry = entries[index];
  if (entry === undefined) {
    throw new WorktreeError(`no stash entry at index ${index}`, 'not_found', 'stash_not_found', { entries: entries.length });
  }
  const dirty = await changedFiles(params.worktreePath);
  if (dirty.length > 0) {
    throw new WorktreeError(
      'stash pop refused: the worktree has uncommitted changes',
      'conflict', 'dirty_worktree',
      { hint: 'checkpoint, commit, or stash first, so a conflicted pop can abort to a clean state', files: dirty.length },
    );
  }

  const popped = await git(['stash', 'pop', ref], params.worktreePath);
  if (popped.code === 0) {
    return { status: 'popped', branch, oid: entry.oid, files: await changedFiles(params.worktreePath) };
  }

  const conflicted = await git(['diff', '--name-only', '--diff-filter=U', '-z'], params.worktreePath);
  const conflictedPaths = conflicted.stdout.split('\u0000').filter((p) => p.length > 0);
  if (conflictedPaths.length === 0) {
    throw new WorktreeError(
      `git stash pop failed: ${popped.stderr.trim()}`,
      'conflict', 'stash_pop_failed', { stderr: popped.stderr.trim() },
    );
  }

  // Abort: the tree was clean before the pop, so everything in it now came
  // from the failed apply — reset tracked, clean untracked, then VERIFY.
  const reset = await git(['reset', '--hard', 'HEAD'], params.worktreePath);
  const cleaned = await git(['clean', '-fd'], params.worktreePath);
  const residue = await changedFiles(params.worktreePath);
  const stillStashed = (await stashList(params.worktreePath)).some((e) => e.oid === entry.oid);
  if (reset.code !== 0 || cleaned.code !== 0 || residue.length > 0 || !stillStashed) {
    throw new WorktreeError(
      'stash pop conflicted AND the abort did not restore a clean worktree with the entry retained — manual repair needed',
      'internal', 'stash_pop_abort_failed',
      { residue: residue.length, stashRetained: stillStashed, conflictedPaths },
    );
  }
  return { status: 'conflict', branch, oid: entry.oid, conflictedPaths };
}

export interface StashDropResult {
  /** The destroyed entry's commit — reachable by oid until gc, and the receipt says so. */
  droppedOid: string;
  subject: string;
}

/**
 * Destroy one stash entry. This is the stash family's one unrecoverable-ish
 * act (the entry leaves every ref), so it GATES ON FORCE unconditionally —
 * and the result carries the dropped oid, which keeps the content reachable
 * (`git stash store <oid>` resurrects it) until gc.
 */
export async function stashDrop(params: {
  worktreePath: string;
  index: number;
  force?: boolean;
}): Promise<StashDropResult> {
  await assertWorktreeDir(params.worktreePath);
  const ref = stashRef(params.index);
  const entries = await stashList(params.worktreePath);
  const entry = entries[params.index];
  if (entry === undefined) {
    throw new WorktreeError(`no stash entry at index ${params.index}`, 'not_found', 'stash_not_found', { entries: entries.length });
  }
  if (params.force !== true) {
    throw new WorktreeError(
      `stash drop destroys ${ref} (${entry.subject}); refuse without force`,
      'conflict', 'stash_drop_needs_force',
      { index: params.index, oid: entry.oid, hint: 'pass force to drop — the oid stays in the receipt until gc' },
    );
  }
  const res = await git(['stash', 'drop', ref], params.worktreePath);
  if (res.code !== 0) {
    throw new WorktreeError('git stash drop failed', 'internal', 'stash_drop_failed', { stderr: res.stderr.trim() });
  }
  return { droppedOid: entry.oid, subject: entry.subject };
}
