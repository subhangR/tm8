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
import { CollabError, type SessionGitBranchResult, type SessionGitCheckpointResult, type SessionGitCherryPickResult, type SessionGitCommitResult, type SessionGitDiff, type SessionGitDiffFile, type SessionGitMergeResult, type SessionGitRollbackResult, type SessionGitStashResult, type SessionGitStatus, type ExecutionGitBranchInput, type ExecutionGitCheckpointInput, type ExecutionGitCherryPickInput, type ExecutionGitCommitInput, type ExecutionGitMergeInput, type ExecutionGitRollbackInput, type ExecutionGitStashInput } from '@tm8/contract';
import {
  WorktreeError,
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
  stashDrop,
  stashList,
  stashPop,
  stashPush,
} from '@tm8/execution';

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

    const porcelain = await runGit(['status', '--porcelain=v1', '-z'], { cwd: path });
    if (porcelain.code !== 0) {
      return { ...empty, headOid, unavailableReason: 'worktree_unreadable' };
    }
    const tokens = porcelain.stdout.split('\u0000');
    const files: SessionGitStatus['files'] = [];
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
    const total = files.length;

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
      dirty: { staged, unstaged, untracked, total },
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
    if (from === null) {
      // No resolvable base: an honest empty diff with the reason visible in
      // the nulls, not a fabricated diff against some guessed ancestor.
      return { ...empty, available: true, headOid, baseRef, baseOid, unavailableReason: null };
    }

    const numstat = await runGit(['diff', '--numstat', from], { cwd: path });
    if (numstat.code !== 0) return { ...empty, headOid, baseRef, baseOid, mergeBaseOid, unavailableReason: 'worktree_unreadable' };
    const files: SessionGitDiffFile[] = [];
    let additions = 0;
    let deletions = 0;
    for (const line of numstat.stdout.split('\n')) {
      if (line.trim() === '') continue;
      const [a, d, ...rest] = line.split('\t');
      const filePath = rest.join('\t');
      if (filePath === '') continue;
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

    // A diff even bigger than the raised buffer rejects out of execFile with
    // the partial bytes attached — salvage them as an honestly-truncated
    // partial rather than turning a huge diff into an error.
    let diffText = '';
    let overflowed = false;
    try {
      const diffRun = await runGit(['diff', from], { cwd: path, maxBufferBytes: DIFF_BYTES_MAX + 1024 * 1024 });
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

  readonly commit = async (ctx: RequestContext): Promise<SessionGitCommitResult> => {
    const lane = await this.resolveLane(ctx);
    const { worktreeId, path, branch } = ExecutionGitService.requireActiveLane(lane);
    const input = ctx.body as ExecutionGitCommitInput;
    try {
      if (input.all === true || (input.paths !== undefined && input.paths.length > 0)) {
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
    'execution.gitMerge': service.merge,
    'execution.gitCherryPick': service.cherryPick,
    'execution.gitBranch': service.branch,
    'execution.gitStash': service.stash,
  });
}
