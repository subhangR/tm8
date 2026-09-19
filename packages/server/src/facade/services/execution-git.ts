/**
 * `execution.git*` — the session git rail, behind the facade.
 *
 * The #76 verbs (checkpoint/rollback/stage/commit/merge) already exist in
 * `@tm8/execution/worktree` and run argv-only git; the CLI drives them on its
 * own machine. A BROWSER has no machine, so these six operations put the same
 * verbs behind HTTP, executed by the node that holds the session's worktree.
 *
 * The worktree path is resolved server-side from the graph — the newest
 * `in_worktree` edge (081's `link_session_worktree` writes session →
 * worktree) joined to `public.worktrees`, read under the CALLER's claims so
 * RLS decides visibility. No request ever names a filesystem path
 * (`execution.journal`'s discipline), and every git invocation goes through
 * the argv-only invoker — no shell, no interpolation.
 *
 * Honesty rules, both directions:
 * - a session with no worktree answers `available: false` with a NAMED
 *   reason on the reads, and a `conflict`-coded refusal on the commands —
 *   never a 500, never an empty panel;
 * - a merge conflict is DATA (`status: 'conflict'` + the conflicted paths,
 *   worktree restored clean by `mergeFromRef`'s abort contract), because a
 *   conflict is an answer for the UI to surface, not an error to strand on.
 *
 * Reads cap their output — digest+partial, the transcript precedent: the
 * numstat digest is always complete, the unified diff text is byte-capped.
 */
import { CollabError, type SessionGitBranchResult, type SessionGitCheckpointResult, type SessionGitCherryPickResult, type SessionGitCommitResult, type SessionGitDiff, type SessionGitDiffFile, type SessionGitDiffScope, type SessionGitFile, type SessionGitMergeResult, type SessionGitRollbackResult, type SessionGitStageResult, type SessionGitStashResult, type SessionGitStatus, type ExecutionGitBranchInput, type ExecutionGitCheckpointInput, type ExecutionGitCherryPickInput, type ExecutionGitCommitInput, type ExecutionGitMergeInput, type ExecutionGitRollbackInput, type ExecutionGitStageInput, type ExecutionGitStashInput } from '@tm8/contract';
import {
  WorktreeError,
  assertSafePathspec,
  branchCreate,
  branchDelete,
  branchRename,
  checkpoint,
  cherryPick,
  commit,
  mergeFromRef,
  resolveCommitish,
  rollback,
  runGit,
  stage,
  stagedFiles,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
  type ChangedFile,
  unstage,
} from '@tm8/execution';

import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import type { RequestContext } from '../../http/types.js';
import { claimsFor, requireUuidParam } from '../context.js';
import type { FacadeDeps } from '../deps.js';
import type { HandlerRegistry } from '../registry.js';

/** Dirty-file entries returned by gitStatus before the list is cut. */
const STATUS_FILES_CAP = 200;
/** numstat entries returned by gitDiff before the list is cut. */
const DIFF_FILES_CAP = 500;
/** Unified diff bytes by default / at most — the DIGEST is never cut. */
const DIFF_BYTES_DEFAULT = 256 * 1024;
const DIFF_BYTES_MAX = 1024 * 1024;

interface SessionLaneRow {
  session_id: string;
  workdir_mode: string | null;
  base_ref: string | null;
  worktree_id: string | null;
  path: string | null;
  branch: string | null;
  base_commit_oid: string | null;
  worktree_status: string | null;
}

/**
 * `git status --porcelain=v1 -z` → the shape both `gitStatus` and `gitStage`
 * answer with. Lifted out of the status handler when `gitStage` started
 * returning the POST-operation status: two copies of this parser would be two
 * definitions of "staged", and the XY column rules (a rename carries its
 * source in the next NUL token; `??` is untracked and counts as neither half)
 * are exactly the kind of detail that drifts between copies.
 */
function parsePorcelain(stdout: string): {
  files: SessionGitFile[];
  dirty: { staged: number; unstaged: number; untracked: number; total: number };
} {
  const tokens = stdout.split('\u0000');
  const files: SessionGitFile[] = [];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.length < 4) continue;
    const status = token.slice(0, 2);
    const filePath = token.slice(3);
    if (status === '??') untracked += 1;
    else {
      if (status[0] !== ' ' && status[0] !== '?') staged += 1;
      if (status[1] !== ' ' && status[1] !== '?') unstaged += 1;
    }
    if (status[0] === 'R' || status[0] === 'C') {
      const origPath = tokens[i + 1];
      files.push(origPath === undefined ? { status, path: filePath } : { status, path: filePath, origPath });
      i += 1;
    } else {
      files.push({ status, path: filePath });
    }
  }
  return { files, dirty: { staged, unstaged, untracked, total: files.length } };
}

/**
 * A caller-supplied path reaches a git argv slot, so it is guarded by the SAME
 * function the mutating verbs use — one definition of "safe pathspec" for the
 * reads and the writes both. `assertSafePathspec` throws a WorktreeError; this
 * read wants a CollabError, so it is lifted like any other.
 */
function requireSafePath(path: string): string {
  try {
    assertSafePathspec(path);
  } catch (error) {
    liftWorktreeError(error);
  }
  return path;
}

/**
 * IS THIS STAGED ROW THE OTHER HALF OF A FILE THE REVIEWER ALREADY TICKED?
 *
 * `git diff --cached --name-status` folds two index entries into one row for
 * both renames (`R100 old new`) and copies (`C100 old new`), and `stagedFiles`
 * parses both the same way: `path` is the destination, `origPath` the source.
 * The commit gate has to treat the two rows differently, because they are not
 * the same event.
 *
 * A RENAME is ONE logical file wearing two names. Its source no longer exists
 * — the index holds a deletion of `old` and an addition of `new`, and the two
 * cannot be committed apart without writing an index nobody asked for. So
 * selecting either name selects the pair, and the destination row is not
 * "outside" a selection that named the source.
 *
 * A COPY is TWO files. The source is UNTOUCHED by the copy and may carry a
 * wholly unrelated staged change of its own; the destination is new work the
 * reviewer may not have looked at. Aliasing them would mean a reviewer who
 * ticks `src.txt` and presses Commit selected silently commits `dup.txt` as
 * well — exactly the quiet widening this gate exists to refuse.
 *
 * This is the same distinction `expandStagedRenames` makes on the unstage
 * side, pointed the other way: there it decides what an unstage must DRAG
 * ALONG, here what a commit may LET PASS. Both answer it for `R*` only.
 */
function isRenameHalfOf(file: ChangedFile, wanted: ReadonlySet<string>): boolean {
  return file.origPath !== undefined && file.status.startsWith('R') && wanted.has(file.origPath);
}

/** `git diff --numstat` → the digest half of a diff answer. */
function parseNumstat(stdout: string): {
  files: SessionGitDiffFile[];
  additions: number;
  deletions: number;
} {
  const files: SessionGitDiffFile[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [a, d, ...rest] = line.split('\t');
    const filePath = rest.join('\t');
    if (filePath === '') continue;
    // A BINARY file's counts are `-` in both columns. That is not zero and it
    // is not an error — it is "git cannot count lines here", and it stays null
    // all the way to the UI rather than being flattened into a 0.
    const add = a === '-' ? null : Number.parseInt(a ?? '', 10);
    const del = d === '-' ? null : Number.parseInt(d ?? '', 10);
    if (add !== null && Number.isInteger(add)) additions += add;
    if (del !== null && Number.isInteger(del)) deletions += del;
    files.push({
      path: filePath,
      additions: add !== null && Number.isInteger(add) ? add : null,
      deletions: del !== null && Number.isInteger(del) ? del : null,
    });
  }
  return { files, additions, deletions };
}

/**
 * CONTAINMENT for the one code path that reads the filesystem instead of the
 * object store.
 *
 * Every other read here hands its path to git as a PATHSPEC, and git resolves
 * it against the repository — a pathspec cannot name a file the repository
 * does not contain. `git diff --no-index` is different: its arguments are
 * filesystem paths, resolved by the OS, and the repository has no say. So the
 * pathspec guard (`assertSafePathspec`: no absolute, no `..`, no leading dash)
 * is necessary but NOT sufficient — `link` can be a perfectly ordinary
 * relative name inside the worktree and still be a symlink to `/etc/shadow`.
 *
 * Hence: resolve BOTH sides to their real paths and require the target to sit
 * under the worktree root. An escape is refused BY NAME (`path_outside_worktree`)
 * rather than silently answered empty, because a caller that asked for a path
 * outside the lane needs to be told so.
 *
 * `absent` is the honest answer for a path that is simply not there (or is a
 * directory, or a device): there is no file to diff, which is different from
 * a refusal and different from an error.
 */
async function containedFile(
  worktreePath: string,
  relPath: string,
): Promise<{ kind: 'file'; real: string } | { kind: 'absent' }> {
  const rootReal = await realpath(worktreePath).catch(() => null);
  if (rootReal === null) return { kind: 'absent' };
  const inside = (candidate: string): boolean =>
    candidate === rootReal || candidate.startsWith(rootReal + sep);
  // Lexical first — cheap, and it catches anything the pathspec guard let
  // through before the filesystem is touched at all.
  const abs = resolve(rootReal, relPath);
  if (!inside(abs)) {
    throw new CollabError('invalid_input', 'path resolves outside the session worktree', {
      details: { reason: 'path_outside_worktree', path: relPath },
    });
  }
  const real = await realpath(abs).catch(() => null);
  if (real === null) return { kind: 'absent' };
  if (!inside(real)) {
    throw new CollabError('invalid_input', 'path resolves outside the session worktree', {
      details: { reason: 'path_outside_worktree', path: relPath },
    });
  }
  const st = await stat(real).catch(() => null);
  if (st === null || !st.isFile()) return { kind: 'absent' };
  return { kind: 'file', real };
}

/** `mapWorktreeError` — the verbs' taxonomy is a strict subset of ours. */
function liftWorktreeError(error: unknown): never {
  if (error instanceof WorktreeError) {
    const code =
      error.code === 'internal'
        ? // The one 'internal' with caller-visible meaning is a failed merge
          // abort — a worktree whose state no longer matches any invariant.
          ('invariant_violation' as const)
        : error.code;
    throw new CollabError(code, error.message, {
      details: { reason: error.reason, ...(error.detail ?? {}) },
    });
  }
  throw error;
}

export class ExecutionGitService {
  private readonly deps: FacadeDeps;

  constructor(deps: FacadeDeps) {
    this.deps = deps;
  }

  /**
   * The one resolution query every operation shares: the session exists (RLS
   * answers visibility — an unreadable session is indistinguishable from a
   * missing one), and its newest `in_worktree` edge names the worktree row.
   */
  private async resolveLane(ctx: RequestContext): Promise<SessionLaneRow> {
    const owner = await this.deps.owner();
    const claims = claimsFor(owner, ctx);
    const sessionId = requireUuidParam(ctx, 'workSessionId');

    const rows = await this.deps.db.query<SessionLaneRow>(
      claims,
      `select e.id as session_id, ws.workdir_mode, ws.base_ref,
              w.entity_id as worktree_id, w.path, w.branch, w.base_commit_oid,
              w.status as worktree_status
         from public.entities e
         join public.work_sessions ws on ws.entity_id = e.id
         left join lateral (
           select w.entity_id, w.path, w.branch, w.base_commit_oid, w.status
             from public.edges ed
             join public.worktrees w on w.entity_id = ed.dst_id
            where ed.src_id = e.id and ed.type = 'in_worktree'
            order by ed.created_at desc
            limit 1
         ) w on true
        where e.id = $1 and e.kind = 'work_session' and e.deleted_at is null`,
      [sessionId],
    );
    const row = rows[0];
    if (!row) throw new CollabError('not_found', `no such work session: ${sessionId}`);
    return row;
  }

  /** Reads answer `available:false` with a named reason instead of throwing. */
  private static unavailableReason(
    lane: SessionLaneRow,
  ): 'no_worktree' | 'worktree_not_active' | null {
    if (lane.worktree_id === null || lane.path === null) return 'no_worktree';
    if (lane.worktree_status !== 'active') return 'worktree_not_active';
    return null;
  }

  /** Commands refuse by name — the UI's DisabledWithReason renders `reason`. */
  private static requireActiveLane(
    lane: SessionLaneRow,
  ): { worktreeId: string; path: string; branch: string } {
    const reason = ExecutionGitService.unavailableReason(lane);
    if (reason !== null || lane.branch === null) {
      throw new CollabError('conflict', `session has no operable worktree (${reason ?? 'no_branch'})`, {
        details: { reason: reason ?? 'no_branch' },
      });
    }
    // requireActiveLane's checks make these non-null; TypeScript cannot see
    // through unavailableReason, so narrow explicitly.
    return { worktreeId: lane.worktree_id as string, path: lane.path as string, branch: lane.branch };
  }

  /**
   * Resolve the commit the session measures itself against: the symbolic base
   * ref when it still resolves in this worktree, else the recorded base oid.
   * Returns nulls rather than throwing — a worktree whose base vanished is a
   * worktree whose ahead/behind is honestly unknown, not zero.
   */
  private static async resolveBase(
    lane: SessionLaneRow,
    path: string,
  ): Promise<{ baseRef: string | null; baseOid: string | null }> {
    if (lane.base_ref !== null && lane.base_ref !== '') {
      try {
        return { baseRef: lane.base_ref, baseOid: await resolveCommitish(path, lane.base_ref) };
      } catch {
        // fall through to the recorded oid
      }
    }
    if (lane.base_commit_oid !== null) {
      try {
        return { baseRef: lane.base_ref, baseOid: await resolveCommitish(path, lane.base_commit_oid) };
      } catch {
        return { baseRef: lane.base_ref, baseOid: null };
      }
    }
    return { baseRef: lane.base_ref, baseOid: null };
  }

  readonly status = async (ctx: RequestContext): Promise<SessionGitStatus> => {
    const lane = await this.resolveLane(ctx);
    const reason = ExecutionGitService.unavailableReason(lane);
    const empty: SessionGitStatus = {
      sessionId: lane.session_id,
      available: false,
      unavailableReason: reason,
      worktreeId: lane.worktree_id,
      branch: lane.branch,
      baseRef: lane.base_ref,
      baseOid: lane.base_commit_oid,
      headOid: null,
      ahead: null,
      behind: null,
      dirty: { staged: 0, unstaged: 0, untracked: 0, total: 0 },
      files: [],
      filesTruncated: false,
      checkedAt: new Date().toISOString(),
    };
    if (reason !== null) return empty;
    const path = lane.path as string;

    // Live git, all read-only, all argv. A worktree the node cannot read is
    // reported as such — RLS said the caller may see the LANE; the node just
    // cannot serve its bytes right now.
    const head = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: path });
    if (head.code !== 0) {
      return { ...empty, unavailableReason: 'worktree_unreadable' };
    }
    const headOid = head.stdout.trim();

    // `-uall` lists untracked FILES. Without it git collapses a new directory
    // to `dir/`, and a Changes surface cannot stage, diff or even name what is
    // inside it. The list is capped below, so the cost of asking is bounded.
    const porcelain = await runGit(['status', '--porcelain=v1', '-z', '-uall'], { cwd: path });
    if (porcelain.code !== 0) {
      return { ...empty, headOid, unavailableReason: 'worktree_unreadable' };
    }
    const { files, dirty } = parsePorcelain(porcelain.stdout);

    const { baseRef, baseOid } = await ExecutionGitService.resolveBase(lane, path);
    let ahead: number | null = null;
    let behind: number | null = null;
    if (baseOid !== null) {
      const counts = await runGit(
        ['rev-list', '--left-right', '--count', `${baseOid}...HEAD`],
        { cwd: path },
      );
      if (counts.code === 0) {
        const [left, right] = counts.stdout.trim().split(/\s+/);
        behind = Number.parseInt(left ?? '', 10);
        ahead = Number.parseInt(right ?? '', 10);
        if (!Number.isInteger(behind)) behind = null;
        if (!Number.isInteger(ahead)) ahead = null;
      }
    }

    // The stash LIST rides on this read (Tier 2 completion) — a failed list
    // degrades to an absent field, never a failed status.
    let stashes: SessionGitStatus['stashes'];
    try {
      stashes = await stashList(path);
    } catch {
      stashes = undefined;
    }

    return {
      sessionId: lane.session_id,
      available: true,
      unavailableReason: null,
      worktreeId: lane.worktree_id,
      branch: lane.branch,
      baseRef,
      baseOid,
      headOid,
      ahead,
      behind,
      dirty,
      files: files.slice(0, STATUS_FILES_CAP),
      filesTruncated: files.length > STATUS_FILES_CAP,
      ...(stashes === undefined ? {} : { stashes }),
      checkedAt: new Date().toISOString(),
    };
  };

  readonly diff = async (ctx: RequestContext): Promise<SessionGitDiff> => {
    const lane = await this.resolveLane(ctx);
    const reason = ExecutionGitService.unavailableReason(lane);

    const rawMax = ctx.query.get('maxBytes');
    let maxBytes = DIFF_BYTES_DEFAULT;
    if (rawMax !== null && rawMax !== '') {
      const parsed = Number.parseInt(rawMax, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CollabError('invalid_input', `maxBytes must be a positive integer, got ${rawMax}`);
      }
      maxBytes = Math.min(parsed, DIFF_BYTES_MAX);
    }

    // NARROWING PARAMS (both optional; absent = the whole-session read this
    // handler has always answered). `path` is guarded by the mutating verbs'
    // own pathspec guard before it can reach an argv slot.
    const rawScope = ctx.query.get('scope');
    let scope: SessionGitDiffScope = 'session';
    if (rawScope !== null && rawScope !== '') {
      if (rawScope !== 'session' && rawScope !== 'staged' && rawScope !== 'unstaged') {
        throw new CollabError('invalid_input', `scope must be session|staged|unstaged, got ${rawScope}`);
      }
      scope = rawScope;
    }
    const rawPath = ctx.query.get('path');
    const wantPath = rawPath !== null && rawPath !== '' ? requireSafePath(rawPath) : null;

    const empty: SessionGitDiff = {
      sessionId: lane.session_id,
      available: false,
      unavailableReason: reason,
      branch: lane.branch,
      baseRef: lane.base_ref,
      baseOid: lane.base_commit_oid,
      mergeBaseOid: null,
      headOid: null,
      stat: { filesChanged: 0, additions: 0, deletions: 0 },
      files: [],
      filesTruncated: false,
      diff: '',
      diffTruncated: false,
      scope,
      path: wantPath,
      untracked: false,
      checkedAt: new Date().toISOString(),
    };
    if (reason !== null) return empty;
    const path = lane.path as string;

    const head = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: path });
    if (head.code !== 0) return { ...empty, unavailableReason: 'worktree_unreadable' };
    const headOid = head.stdout.trim();

    const { baseRef, baseOid } = await ExecutionGitService.resolveBase(lane, path);

    // "What did this session change" is measured from the MERGE-BASE of the
    // session's base, so drift that landed on base after the branch-off never
    // pollutes the session's answer. Working tree included: uncommitted work
    // is exactly what the rail exists to show.
    let mergeBaseOid: string | null = null;
    if (baseOid !== null) {
      const mb = await runGit(['merge-base', baseOid, 'HEAD'], { cwd: path });
      if (mb.code === 0) mergeBaseOid = mb.stdout.trim();
    }
    const from = mergeBaseOid ?? baseOid;
    if (from === null && scope === 'session') {
      // No resolvable base: an honest empty diff with the reason visible in
      // the nulls, not a fabricated diff against some guessed ancestor. Only
      // the SESSION scope needs a base — staged/unstaged are measured against
      // the index and HEAD, which every worktree has.
      return { ...empty, available: true, headOid, baseRef, baseOid, unavailableReason: null };
    }

    /*
     * WHAT IS BEING COMPARED, spelled out in one place because these are three
     * genuinely different questions and the argv is the only thing that says
     * which one was asked:
     *
     *   session   `git diff <merge-base>`  — working tree vs where the lane
     *                                        branched. The default, unchanged.
     *   staged    `git diff --cached`      — index vs HEAD: what a commit
     *                                        would write, exactly.
     *   unstaged  `git diff`               — working tree vs index.
     *
     * AN UNTRACKED PATH DOES NOT ANSWER THE SAME WAY IN ALL THREE. It sits in
     * the working tree and in neither the index nor HEAD, so each question
     * gets a different true answer:
     *
     *   · session  — the whole file IS what this lane changed, so `--no-index`
     *     against /dev/null is that answer: a real unified diff of every line,
     *     not a blank panel over a file that is plainly new;
     *   · staged   — the file contributes NOTHING to index-vs-HEAD. A commit
     *     would write none of it, so EMPTY is the correct answer;
     *   · unstaged — nothing to compare in worktree-vs-index either. EMPTY.
     *
     * Only the session branch takes `--no-index`. The other two fall through
     * to the ordinary tracked read below and let git answer for itself:
     * `git diff [--cached] -- <untracked path>` exits 0 with no output
     * (MEASURED — an unmatched pathspec is not an error to `git diff` the way
     * it is to `git add`).
     *
     * `untracked: true` rides on ALL THREE answers, because it CLASSIFIES the
     * path; it is not a claim about which argv produced the text. It is how a
     * reader tells an empty `staged` answer that is empty BECAUSE the file is
     * untracked from one that is empty because the file is unchanged.
     */
    let untracked = false;
    if (wantPath !== null) {
      // `--literal-pathspecs` (see `git-invoker`): `wantPath` is an exact name
      // out of a status listing. Without it a file called `a*.txt` would make
      // `ls-files --error-unmatch` succeed on the strength of `abc.txt`
      // existing, and a genuinely untracked file would be read as tracked.
      const inIndex = await runGit(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', wantPath], { cwd: path });
      if (inIndex.code !== 0) {
        /*
         * ABSENT FROM THE INDEX IS NOT THE SAME AS UNTRACKED, and a STAGED
         * DELETION is exactly where the two come apart. `git rm a.txt` takes
         * the index entry away — `ls-files --error-unmatch` exits 1 — while
         * staging a deletion that `git diff --cached` renders in full and
         * that a commit would write. Stopping at the index would classify it
         * untracked, send it down the `--no-index` branch, find no file on
         * disk, and answer with an EMPTY diff: the one change a reviewer most
         * needs to see, reported as nothing to see.
         *
         * So HEAD is asked too. Untracked means git has no recorded state
         * ANYWHERE — neither in the index nor in the commit the index is
         * measured against. (`ls-tree` exits 0 with EMPTY OUTPUT for a path
         * the tree does not hold, so the presence of output is the real test.)
         *
         * `-z` and a LENGTH check, not `.trim()`: a filename is bytes, and
         * `'   '` is a legal one. Trimming git's answer for that path turns a
         * found file into an empty string and misclassifies a real staged
         * deletion as untracked — the very bug this block exists to fix,
         * reintroduced by the check meant to confirm the fix. `-z` also stops
         * git C-quoting the name, which would change the bytes it reports.
         *
         * An UNSTAGED deletion keeps its index entry and never reaches here.
         */
        const inHead = await runGit(['--literal-pathspecs', 'ls-tree', '-z', '--name-only', headOid, '--', wantPath], { cwd: path });
        untracked = inHead.code !== 0 || inHead.stdout.length === 0;
      }
    }
    // Paired with `--literal-pathspecs` at every use below: `--` keeps the name
    // from being read as an option, the global flag keeps it from being read as
    // a glob. Neither implies the other.
    const pathArgs = wantPath === null ? [] : ['--', wantPath];
    const scopeArgs: string[] =
      scope === 'staged' ? ['--cached']
      : scope === 'unstaged' ? []
      : [from as string];

    /*
     * `--no-index` ONLY FOR THE SESSION SCOPE, because it is only the session
     * question a whole-file diff actually answers.
     *
     * An untracked file is in the working tree and in neither the index nor
     * HEAD. "What did this session change" therefore includes all of it, and
     * `/dev/null` vs the file is that answer. But `--cached` asks index vs
     * HEAD, where the file contributes NOTHING — and this branch used to run
     * for every scope, so asking for `staged` returned the entire file as an
     * addition under a caption reading "exactly what a commit would write",
     * when a commit would write none of it. Reachable without doing anything
     * unusual: open an untracked file under All, then press the Staged chip —
     * the open path persists and reloads in the new scope.
     *
     * The other two scopes fall through to the tracked read below, where git
     * answers for itself: `git diff [--cached] -- <untracked path>` exits 0
     * with no output. Measured, not assumed — an unmatched pathspec is not an
     * error to `git diff` the way it is to `git add`. `untracked: true` still
     * rides on the result, so a client can tell an empty-because-untracked
     * answer from an empty-because-unchanged one.
     */
    if (untracked && wantPath !== null && scope === 'session') {
      // The ONLY read in this file whose argument is a filesystem path rather
      // than a pathspec, so it is the only one that needs containment proved
      // rather than inherited from git. See `containedFile`.
      const target = await containedFile(path, wantPath);
      if (target.kind === 'absent') {
        // Neither tracked nor present: nothing to diff. Available and empty is
        // the truth; a 404 would claim the SESSION was missing.
        return { ...empty, available: true, unavailableReason: null, headOid, baseRef, baseOid, mergeBaseOid, untracked: true };
      }

      // `--no-index` exits 1 when the two inputs DIFFER, which for a new file
      // against /dev/null is always. Exit 1 is therefore the success case here
      // and only a code above it is a failure — the one place in this file
      // where a non-zero git exit is not a problem.
      const ok = (code: number): boolean => code === 0 || code === 1;
      const noIndex = (extra: readonly string[]): string[] =>
        ['diff', '--no-index', ...extra, '--', '/dev/null', wantPath];

      const digest = await runGit(noIndex(['--numstat']), { cwd: path });
      if (!ok(digest.code)) {
        return { ...empty, headOid, baseRef, baseOid, mergeBaseOid, unavailableReason: 'worktree_unreadable' };
      }
      // numstat names the pair as `/dev/null => <path>`; the file being
      // described is the one that was ASKED for, so it is named that way.
      const counted = parseNumstat(digest.stdout);
      const first = counted.files[0];
      const nsFiles: SessionGitDiffFile[] = [
        { path: wantPath, additions: first?.additions ?? null, deletions: first?.deletions ?? null },
      ];

      // Identical cap discipline to the tracked path below: raise the buffer,
      // salvage the partial bytes if even that overflows, cut at maxBytes and
      // SAY that it was cut.
      let text = '';
      let overflow = false;
      try {
        const textRun = await runGit(noIndex([]), { cwd: path, maxBufferBytes: DIFF_BYTES_MAX + 1024 * 1024 });
        text = ok(textRun.code) ? textRun.stdout : '';
      } catch (error) {
        const partial = (error as { stdout?: unknown }).stdout;
        text = typeof partial === 'string' ? partial : '';
        overflow = true;
      }
      const cut = overflow || Buffer.byteLength(text, 'utf8') > maxBytes;
      return {
        ...empty,
        available: true,
        unavailableReason: null,
        headOid,
        baseRef,
        baseOid,
        mergeBaseOid,
        stat: { filesChanged: nsFiles.length, additions: counted.additions, deletions: counted.deletions },
        files: nsFiles,
        filesTruncated: false,
        diff: cut ? Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8') : text,
        diffTruncated: cut,
        untracked: true,
      };
    }

    const numstat = await runGit(['--literal-pathspecs', 'diff', '--numstat', ...scopeArgs, ...pathArgs], { cwd: path });
    if (numstat.code !== 0) return { ...empty, headOid, baseRef, baseOid, mergeBaseOid, unavailableReason: 'worktree_unreadable' };
    const { files, additions, deletions } = parseNumstat(numstat.stdout);

    // A diff even bigger than the raised buffer rejects out of execFile with
    // the partial bytes attached — salvage them as an honestly-truncated
    // partial rather than turning a huge diff into an error.
    let diffText = '';
    let overflowed = false;
    try {
      const diffRun = await runGit(['--literal-pathspecs', 'diff', ...scopeArgs, ...pathArgs], { cwd: path, maxBufferBytes: DIFF_BYTES_MAX + 1024 * 1024 });
      diffText = diffRun.code === 0 ? diffRun.stdout : '';
    } catch (error) {
      const partial = (error as { stdout?: unknown }).stdout;
      diffText = typeof partial === 'string' ? partial : '';
      overflowed = true;
    }
    const truncated = overflowed || Buffer.byteLength(diffText, 'utf8') > maxBytes;
    const diff = truncated
      ? Buffer.from(diffText, 'utf8').subarray(0, maxBytes).toString('utf8')
      : diffText;

    return {
      sessionId: lane.session_id,
      available: true,
      unavailableReason: null,
      branch: lane.branch,
      baseRef,
      baseOid,
      mergeBaseOid,
      headOid,
      stat: { filesChanged: files.length, additions, deletions },
      files: files.slice(0, DIFF_FILES_CAP),
      filesTruncated: files.length > DIFF_FILES_CAP,
      diff,
      diffTruncated: truncated,
      scope,
      path: wantPath,
      untracked,
      checkedAt: new Date().toISOString(),
    };
  };

  readonly checkpoint = async (ctx: RequestContext): Promise<SessionGitCheckpointResult> => {
    const lane = await this.resolveLane(ctx);
    const { worktreeId, path, branch } = ExecutionGitService.requireActiveLane(lane);
    const input = ctx.body as ExecutionGitCheckpointInput;
    try {
      const result = await checkpoint({
        worktreePath: path,
        expectedBranch: branch,
        ...(input.message === undefined ? {} : { message: input.message }),
      });
      return { sessionId: lane.session_id, worktreeId, ...result };
    } catch (error) {
      liftWorktreeError(error);
    }
  };

  readonly rollback = async (ctx: RequestContext): Promise<SessionGitRollbackResult> => {
    const lane = await this.resolveLane(ctx);
    const { worktreeId, path, branch } = ExecutionGitService.requireActiveLane(lane);
    const input = ctx.body as ExecutionGitRollbackInput;
    try {
      const result = await rollback({
        worktreePath: path,
        expectedBranch: branch,
        to: input.to,
        ...(input.force === undefined ? {} : { force: input.force }),
      });
      return { sessionId: lane.session_id, worktreeId, ...result };
    } catch (error) {
      liftWorktreeError(error);
    }
  };

  /**
   * COMMIT — and, when `paths` is given, commit THOSE PATHS AND NOTHING ELSE.
   *
   * The trap this refusal disarms: `git commit` writes the whole index, not
   * the pathspecs it was handed. So "stage the selection, then commit" — the
   * obvious implementation, and the one that was here — quietly sweeps up any
   * file that was ALREADY staged for some other reason. A reviewer who ticks
   * one file and presses Commit selected would get a commit containing work
   * they never looked at, and nothing on screen would have said so.
   *
   * The alternative fix, `git commit -- <paths>`, is worse in a different
   * direction: that form commits the WORKING TREE content of those paths,
   * silently including hunks the reviewer had deliberately left unstaged. A
   * screen built on the staged/unstaged distinction cannot use a verb that
   * ignores it.
   *
   * So the index must genuinely hold only the selection, and when it does not,
   * this refuses BY NAME and hands back the offending paths AS DATA. The
   * caller's escapes are both honest and both visible: unstage them, or widen
   * the selection to include them.
   */
  readonly commit = async (ctx: RequestContext): Promise<SessionGitCommitResult> => {
    const lane = await this.resolveLane(ctx);
    const { worktreeId, path, branch } = ExecutionGitService.requireActiveLane(lane);
    const input = ctx.body as ExecutionGitCommitInput;
    try {
      const selected = input.paths ?? [];
      if (input.all !== true && selected.length > 0) {
        const wanted = new Set(selected);
        // Read with the SAME function `commit()` uses to decide what it is
        // about to write, so the set being checked is the set being committed.
        const already = await stagedFiles(path);
        const outside = already
          .filter((f) => !wanted.has(f.path) && !isRenameHalfOf(f, wanted))
          .map((f) => f.path);
        if (outside.length > 0) {
          throw new CollabError(
            'conflict',
            `commit refused: ${outside.length} staged path(s) are outside the selection`,
            {
              details: {
                reason: 'staged_outside_selection',
                outsidePaths: outside.slice(0, STATUS_FILES_CAP),
                outsideCount: outside.length,
                hint: 'unstage them, or include them in paths',
              },
            },
          );
        }
      }
      if (input.all === true || selected.length > 0) {
        await stage({
          worktreePath: path,
          expectedBranch: branch,
          ...(input.paths === undefined ? {} : { paths: input.paths }),
          ...(input.all === undefined ? {} : { all: input.all }),
        });
      }
      const result = await commit({ worktreePath: path, expectedBranch: branch, message: input.message });
      return { sessionId: lane.session_id, worktreeId, ...result };
    } catch (error) {
      liftWorktreeError(error);
    }
  };

  /**
   * STAGE / UNSTAGE — the review half of the commit verb, and the only pair in
   * this rail that moves nothing but the index.
   *
   * It answers with the POST-OPERATION status rather than an acknowledgement,
   * for the same reason `merge` answers with conflict paths: the client's next
   * question is always "what does it look like now", and a client that has to
   * ask again can render a stale list in between.
   */
  readonly stage = async (ctx: RequestContext): Promise<SessionGitStageResult> => {
    const lane = await this.resolveLane(ctx);
    const { worktreeId, path, branch } = ExecutionGitService.requireActiveLane(lane);
    const input = ctx.body as ExecutionGitStageInput;
    const params = {
      worktreePath: path,
      expectedBranch: branch,
      ...(input.paths === undefined ? {} : { paths: input.paths }),
      ...(input.all === undefined ? {} : { all: input.all }),
    };
    try {
      // `moved` is the list git was actually given. For stage that is the
      // request; for unstage it can be LONGER, because a staged rename is one
      // row over two index entries and resetting half of it leaves a worse
      // index than the reviewer started with. Echoing the request instead
      // would hide exactly the paths a client most needs to know moved.
      const { staged, moved } =
        input.action === 'unstage'
          ? await unstage(params).then((r) => ({ staged: r.staged, moved: r.paths }))
          : await stage(params).then((r) => ({ staged: r.staged, moved: [...(input.paths ?? [])] }));
      const porcelain = await runGit(['status', '--porcelain=v1', '-z', '-uall'], { cwd: path });
      if (porcelain.code !== 0) {
        // The index MOVED and then the read failed. Saying "failed" would be a
        // lie about the worktree, so the refusal says which half happened.
        throw new CollabError('upstream_unavailable', 'the index was updated but the worktree could not be re-read', {
          details: { reason: 'status_unreadable_after_apply', applied: true, action: input.action },
        });
      }
      const { files, dirty } = parsePorcelain(porcelain.stdout);
      return {
        sessionId: lane.session_id,
        worktreeId,
        action: input.action,
        branch,
        // EMPTY for `all: true`, because that is literally what git was
        // given: `add -A` / `reset HEAD` carry no pathspecs at all. Echoing
        // the request's `paths` here would claim the server scoped an
        // operation it deliberately did not scope — the same field saying two
        // different things depending on a flag the reader has to notice.
        paths: input.all === true ? [] : moved,
        all: input.all === true,
        staged,
        files: files.slice(0, STATUS_FILES_CAP),
        filesTruncated: files.length > STATUS_FILES_CAP,
        dirty,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      liftWorktreeError(error);
    }
  };

  readonly merge = async (ctx: RequestContext): Promise<SessionGitMergeResult> => {
    const lane = await this.resolveLane(ctx);
    const { worktreeId, path, branch } = ExecutionGitService.requireActiveLane(lane);
    const input = ctx.body as ExecutionGitMergeInput;
    const fromRef = input.fromRef ?? lane.base_ref ?? lane.base_commit_oid;
    if (fromRef === null || fromRef === '') {
      throw new CollabError('conflict', 'session records no base ref to merge from', {
        details: { reason: 'no_base_ref' },
      });
    }
    try {
      const result = await mergeFromRef({
        worktreePath: path,
        expectedBranch: branch,
        fromRef,
        ...(input.message === undefined ? {} : { message: input.message }),
      });
      return result.status === 'conflict'
        ? { sessionId: lane.session_id, worktreeId, status: 'conflict', fromRef, fromOid: result.fromOid, conflictedPaths: result.conflictedPaths }
        : { sessionId: lane.session_id, worktreeId, status: result.status, fromRef, oid: result.oid, fromOid: result.fromOid };
    } catch (error) {
      liftWorktreeError(error);
    }
  };

  // ── Tier 2 completion: cherry-pick / branch / stash ───────────────────────

  /**
   * Branches the branch verbs must never touch: the session's recorded base
   * (with and without a remote prefix — the graph records what the spawn was
   * given, the local branch is what a delete would destroy). The
   * checked-out-in-any-worktree refusal lives in the core and needs no graph.
   */
  private static protectedBranches(lane: SessionLaneRow): string[] {
    const out = new Set<string>();
    if (lane.base_ref !== null && lane.base_ref !== '') {
      out.add(lane.base_ref);
      const stripped = lane.base_ref.replace(/^[^/]+\//, '');
      if (stripped !== lane.base_ref) out.add(stripped);
    }
    return [...out];
  }

  readonly cherryPick = async (ctx: RequestContext): Promise<SessionGitCherryPickResult> => {
    const lane = await this.resolveLane(ctx);
    const { worktreeId, path, branch } = ExecutionGitService.requireActiveLane(lane);
    const input = ctx.body as ExecutionGitCherryPickInput;
    try {
      const result = await cherryPick({ worktreePath: path, expectedBranch: branch, commits: input.commits });
      return result.status === 'conflict'
        ? { sessionId: lane.session_id, worktreeId, status: 'conflict', branch: result.branch, fromOids: result.fromOids, conflictedPaths: result.conflictedPaths }
        : { sessionId: lane.session_id, worktreeId, status: 'picked', branch: result.branch, fromOids: result.fromOids, newOids: result.newOids };
    } catch (error) {
      liftWorktreeError(error);
    }
  };

  readonly branch = async (ctx: RequestContext): Promise<SessionGitBranchResult> => {
    const lane = await this.resolveLane(ctx);
    const { worktreeId, path } = ExecutionGitService.requireActiveLane(lane);
    const input = ctx.body as ExecutionGitBranchInput;
    const protectedBranches = ExecutionGitService.protectedBranches(lane);
    try {
      if (input.action === 'create') {
        const r = await branchCreate({ worktreePath: path, name: input.name, ...(input.from === undefined ? {} : { from: input.from }) });
        return { sessionId: lane.session_id, worktreeId, action: 'create', name: r.name, oid: r.oid };
      }
      if (input.action === 'rename') {
        const r = await branchRename({ worktreePath: path, from: input.from, to: input.to, protectedBranches });
        return { sessionId: lane.session_id, worktreeId, action: 'rename', from: r.from, to: r.to, oid: r.oid };
      }
      const r = await branchDelete({
        worktreePath: path, name: input.name, protectedBranches,
        ...(input.force === undefined ? {} : { force: input.force }),
      });
      return {
        sessionId: lane.session_id, worktreeId, action: 'delete',
        name: r.name, deletedOid: r.deletedOid, measuredAgainst: r.measuredAgainst, forced: r.forced,
      };
    } catch (error) {
      liftWorktreeError(error);
    }
  };

  readonly stash = async (ctx: RequestContext): Promise<SessionGitStashResult> => {
    const lane = await this.resolveLane(ctx);
    const { worktreeId, path, branch } = ExecutionGitService.requireActiveLane(lane);
    const input = ctx.body as ExecutionGitStashInput;
    try {
      if (input.action === 'push') {
        const r = await stashPush({
          worktreePath: path, expectedBranch: branch,
          ...(input.message === undefined ? {} : { message: input.message }),
        });
        return r.status === 'stashed'
          ? { sessionId: lane.session_id, worktreeId, action: 'push', status: 'stashed', oid: r.oid, branch: r.branch, files: r.files }
          : { sessionId: lane.session_id, worktreeId, action: 'push', status: 'clean', branch: r.branch };
      }
      if (input.action === 'pop') {
        const r = await stashPop({
          worktreePath: path, expectedBranch: branch,
          ...(input.index === undefined ? {} : { index: input.index }),
        });
        return r.status === 'conflict'
          ? { sessionId: lane.session_id, worktreeId, action: 'pop', status: 'conflict', oid: r.oid, branch: r.branch, conflictedPaths: r.conflictedPaths }
          : { sessionId: lane.session_id, worktreeId, action: 'pop', status: 'popped', oid: r.oid, branch: r.branch, files: r.files };
      }
      const r = await stashDrop({
        worktreePath: path, index: input.index,
        ...(input.force === undefined ? {} : { force: input.force }),
      });
      return { sessionId: lane.session_id, worktreeId, action: 'drop', droppedOid: r.droppedOid, subject: r.subject };
    } catch (error) {
      liftWorktreeError(error);
    }
  };
}

export function registerExecutionGitHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  const service = new ExecutionGitService(deps);
  registry.registerAll({
    'execution.gitStatus': service.status,
    'execution.gitDiff': service.diff,
    'execution.gitCheckpoint': service.checkpoint,
    'execution.gitRollback': service.rollback,
    'execution.gitCommit': service.commit,
    'execution.gitStage': service.stage,
    'execution.gitMerge': service.merge,
    'execution.gitCherryPick': service.cherryPick,
    'execution.gitBranch': service.branch,
    'execution.gitStash': service.stash,
  });
}
