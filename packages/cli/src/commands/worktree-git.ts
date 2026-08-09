/**
 * `tm8 worktree stage|commit|merge` — the MUTATING half of the worktree
 * surface (Tier 2), plus the graph-resolution helpers `session
 * checkpoint|rollback` share (session-git.ts).
 *
 * SUGAR OVER THE EXISTING CATALOG, ADDING ZERO OPERATIONS — the same law the
 * read surface (`worktree list|status`, PR #67) states in its own header.
 * Every graph touch here is an operation that already exists: `entities.get`
 * and `edges.list` resolve a session to its worktree, `messages.post` writes
 * the durable receipts, `attentionRequests.create` raises a conflict. The GIT
 * mutation itself runs through `@tm8/execution/worktree` — the same argv-only
 * hardened invoker the server's provisioning saga uses, never a shell string.
 *
 * WHERE THE GIT RUNS, AND WHY THAT IS SAFE TO SAY OUT LOUD. These verbs
 * execute git ON THIS HOST, against the path the GRAPH records for the
 * worktree — the CLI never accepts a path from the caller (S11 holds: paths
 * are server-computed; this surface only reads them back). On a host that is
 * not the worktree's host the very first probe refuses with
 * `worktree_not_local` instead of guessing. When a server-side operation
 * family for these verbs lands, the CLI keeps this grammar and swaps the
 * local call for the catalog call.
 *
 * A CONFLICT IS NEVER SILENT. `worktree merge` on conflict: the core aborts
 * and verifies the worktree is clean (that contract lives in
 * git-mutations.ts), then THIS layer writes a durable message listing the
 * conflicted paths on the owning task anchor (fallback: session, then the
 * worktree itself — some anchor ALWAYS gets it) and raises attention on that
 * anchor. Only after both durable writes does the command exit 6.
 */
import {
  WorktreeError,
  changedFiles,
  checkpoint,
  commit,
  mergeFromRef,
  rollback,
  stage,
  type ChangedFile,
  type MergeResult,
} from '@tm8/execution/worktree';

import { CliError, EXIT_CONFLICT, EXIT_NOT_FOUND, EXIT_OK, EXIT_PROTOCOL, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, requireArg } from './entity.js';

/** WorktreeError carries the contract taxonomy; project it onto exit codes. */
export function liftWorktreeError(error: unknown): never {
  if (!(error instanceof WorktreeError)) throw error;
  const exit: ExitCode =
    error.code === 'invalid_input' ? EXIT_USAGE
    : error.code === 'not_found' ? EXIT_NOT_FOUND
    : error.code === 'conflict' ? EXIT_CONFLICT
    : EXIT_PROTOCOL;
  const hint = typeof error.detail?.hint === 'string' ? { hint: error.detail.hint } : undefined;
  throw new CliError(`${error.message} [${error.reason}]`, exit, hint);
}

export interface ResolvedWorktree {
  worktreeId: string;
  /** Present when the caller addressed (or the edge names) a work session. */
  sessionId?: string;
  /** Task sources of `in_worktree` edges — the owning anchors for surfacing. */
  taskIds: string[];
  path: string;
  branch: string;
  status: string;
}

interface EdgeEndpoint { id?: unknown; kind?: unknown }
interface EdgeRow { type?: unknown; source?: EdgeEndpoint; target?: EdgeEndpoint }

async function edgesOf(
  cmd: CommandContext,
  filter: { source?: string; destination?: string },
): Promise<EdgeRow[]> {
  const data = await observedInvoke<{ items?: unknown }>(clientFor(cmd.ctx), 'edges.list', {
    query: { ...filter, type: 'in_worktree', limit: '50' },
  });
  return Array.isArray(data?.items) ? (data.items as EdgeRow[]) : [];
}

interface EntityRow {
  id?: unknown;
  kind?: unknown;
  content?: { kind?: unknown; path?: unknown; branch?: unknown; status?: unknown };
}

async function getEntity(cmd: CommandContext, id: string): Promise<EntityRow> {
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entities.get', { params: { id } });
  return (data ?? {}) as EntityRow;
}

/**
 * `<session-id|worktree-id>` → the worktree row the graph records, plus the
 * anchors around it. A session with no worktree, an ambiguous session (two
 * `in_worktree` edges), and a non-active worktree are all REFUSALS with the
 * ids in the message — never a guess among candidates.
 */
export async function resolveWorktree(cmd: CommandContext, id: string): Promise<ResolvedWorktree> {
  const row = await getEntity(cmd, id);
  let worktreeRow = row;
  let worktreeId = id;
  let sessionId: string | undefined;

  if (row.kind === 'work_session') {
    sessionId = id;
    const edges = await edgesOf(cmd, { source: id });
    const targets = [...new Set(edges
      .map((e) => (typeof e.target?.id === 'string' ? e.target.id : undefined))
      .filter((t): t is string => t !== undefined))];
    if (targets.length === 0) {
      throw new CliError(`work session ${id} has no in_worktree edge — no worktree to operate on`, EXIT_NOT_FOUND, {
        hint: 'spawn with --workdir worktree, or address the worktree entity id directly',
      });
    }
    if (targets.length > 1) {
      throw new CliError(
        `work session ${id} maps to ${targets.length} worktrees: ${targets.join(', ')} — name one explicitly`,
        EXIT_USAGE,
      );
    }
    worktreeId = targets[0] as string;
    worktreeRow = await getEntity(cmd, worktreeId);
  } else if (row.kind !== 'worktree') {
    throw new CliError(
      `${id} is a ${String(row.kind ?? 'missing entity')}; this command takes a work session or worktree id`,
      EXIT_USAGE,
    );
  }

  const content = worktreeRow.content;
  if (content?.kind !== 'worktree' || typeof content.path !== 'string' || typeof content.branch !== 'string') {
    throw new CliError(`entity ${worktreeId} did not hydrate as a worktree detail row`, EXIT_PROTOCOL);
  }
  const status = typeof content.status === 'string' ? content.status : 'unknown';
  if (status !== 'active') {
    throw new CliError(
      `worktree ${worktreeId} is ${status}; mutating verbs only touch active worktrees`,
      EXIT_CONFLICT,
    );
  }

  // Anchors AROUND the worktree: sessions and tasks with in_worktree edges.
  const inbound = await edgesOf(cmd, { destination: worktreeId });
  const taskIds: string[] = [];
  for (const edge of inbound) {
    const src = edge.source;
    if (typeof src?.id !== 'string') continue;
    if (src.kind === 'task') taskIds.push(src.id);
    if (src.kind === 'work_session' && sessionId === undefined) sessionId = src.id;
  }

  return {
    worktreeId,
    ...(sessionId === undefined ? {} : { sessionId }),
    taskIds,
    path: content.path,
    branch: content.branch,
    status,
  };
}

/** One durable message per anchor — each its own batch, never silent on failure. */
export async function postReceipt(cmd: CommandContext, anchorId: string, body: string): Promise<void> {
  const request: Record<string, unknown> = {
    anchorIds: [anchorId],
    body,
    clientMutationId: resolveMutationId(undefined),
  };
  if (cmd.ctx.actor) request.actorId = cmd.ctx.actor.value;
  await observedInvoke<unknown>(clientFor(cmd.ctx), 'messages.post', { body: request });
}

/** The receipt anchor: the session that owns the worktree, else the worktree. */
export function receiptAnchor(resolved: ResolvedWorktree): string {
  return resolved.sessionId ?? resolved.worktreeId;
}

export function renderFiles(files: readonly ChangedFile[]): string {
  return files.map((f) => `  ${f.status}  ${f.origPath ? `${f.origPath} -> ` : ''}${f.path}`).join('\n');
}

// ── the commit rail ─────────────────────────────────────────────────────────

/**
 * `tm8 worktree stage <id> [<pathspec>...]` — with NO pathspecs it LISTS the
 * changed files and stages nothing, which is the "list changed files first"
 * affordance; `.` stages everything. A read when it reads, a mutation only
 * when told what to stage.
 */
async function worktreeStage(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, []);
  refuseMutationId('worktree stage', cmd.options.value('mutation-id'));
  const id = requireArg(cmd, 0, '<session-id|worktree-id>');
  const paths = cmd.args.slice(1);
  const resolved = await resolveWorktree(cmd, id);
  try {
    if (paths.length === 0) {
      const changed = await changedFiles(resolved.path);
      cmd.out.data({ worktreeId: resolved.worktreeId, branch: resolved.branch, changed }, () =>
        changed.length === 0
          ? `worktree ${resolved.worktreeId} (${resolved.branch}): clean`
          : `changed in ${resolved.branch}:\n${renderFiles(changed)}\nstage with: tm8 worktree stage ${id} <pathspec>... (or ".")`);
      return EXIT_OK;
    }
    const { staged } = await stage({ worktreePath: resolved.path, expectedBranch: resolved.branch, paths });
    cmd.out.data({ worktreeId: resolved.worktreeId, branch: resolved.branch, staged }, () =>
      `staged on ${resolved.branch}:\n${renderFiles(staged)}`);
    return EXIT_OK;
  } catch (error) {
    liftWorktreeError(error);
  }
}

/** `tm8 worktree commit <id> --message <text>` — commits exactly the index. */
async function worktreeCommit(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['message', 'mutation-id']);
  const id = requireArg(cmd, 0, '<session-id|worktree-id>');
  const message = cmd.options.value('message');
  if (!message?.trim()) throw new CliError('worktree commit requires --message <text>', EXIT_USAGE);
  const resolved = await resolveWorktree(cmd, id);
  let result;
  try {
    result = await commit({ worktreePath: resolved.path, expectedBranch: resolved.branch, message });
  } catch (error) {
    liftWorktreeError(error);
  }
  cmd.out.data({ worktreeId: resolved.worktreeId, ...result }, () =>
    `committed ${result.oid} on ${result.branch}:\n${renderFiles(result.files)}`);
  await postReceipt(cmd, receiptAnchor(resolved),
    `git commit ${result.oid} on ${result.branch} (worktree ${resolved.worktreeId}): ` +
    `${result.files.length} file(s). ${message.trim()}`);
  return EXIT_OK;
}

// ── merge, with the conflict rail ───────────────────────────────────────────

const CONFLICT_ATTENTION_POINTS = 60;

/**
 * `tm8 worktree merge <id> --from <ref> [--task <task-id>]` — merge the base
 * (or any safe ref) INTO the session branch, in the session's own worktree.
 * The other direction is refused by design: base is checked out in the user's
 * primary tree or nowhere, and a session verb must never mutate the user's
 * checkout. Landing on base is what PRs are for.
 */
async function worktreeMerge(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['from', 'task', 'mutation-id']);
  const id = requireArg(cmd, 0, '<session-id|worktree-id>');
  const fromRef = cmd.options.value('from');
  if (!fromRef?.trim()) throw new CliError('worktree merge requires --from <ref>', EXIT_USAGE);
  const resolved = await resolveWorktree(cmd, id);

  let result: MergeResult;
  try {
    result = await mergeFromRef({ worktreePath: resolved.path, expectedBranch: resolved.branch, fromRef });
  } catch (error) {
    liftWorktreeError(error);
  }

  if (result.status !== 'conflict') {
    cmd.out.data({ worktreeId: resolved.worktreeId, ...result }, () =>
      result.status === 'merged'
        ? `merged ${fromRef} (${result.fromOid.slice(0, 12)}) into ${resolved.branch}: HEAD ${result.oid}`
        : `${resolved.branch} is already up to date with ${fromRef}`);
    if (result.status === 'merged') {
      await postReceipt(cmd, receiptAnchor(resolved),
        `git merge: ${fromRef} (${result.fromOid}) merged into ${resolved.branch} ` +
        `(worktree ${resolved.worktreeId}), HEAD now ${result.oid}.`);
    }
    return EXIT_OK;
  }

  // CONFLICT. The worktree is already verified clean (the core's contract);
  // now make it DURABLE before the process says anything about exiting.
  const explicitTask = cmd.options.value('task');
  const anchorId = explicitTask ?? resolved.taskIds[0] ?? resolved.sessionId ?? resolved.worktreeId;
  const body =
    `MERGE CONFLICT: ${fromRef} (${result.fromOid}) into ${resolved.branch} ` +
    `(worktree ${resolved.worktreeId}${resolved.sessionId ? `, session ${resolved.sessionId}` : ''}). ` +
    `The merge was ABORTED cleanly; the worktree is unchanged. Conflicted path(s):\n` +
    result.conflictedPaths.map((p) => `- ${p}`).join('\n') +
    `\nResolve by merging manually in the worktree, or rebase the branch. Re-run: tm8 worktree merge ${id} --from ${fromRef}`;
  await postReceipt(cmd, anchorId, body);
  const attentionBody: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    reason: `merge conflict: ${fromRef} into ${resolved.branch}, ${result.conflictedPaths.length} path(s)`,
    points: CONFLICT_ATTENTION_POINTS,
  };
  if (cmd.ctx.actor) attentionBody.actorId = cmd.ctx.actor.value;
  await observedInvoke<unknown>(clientFor(cmd.ctx), 'attentionRequests.create', {
    params: { entityId: anchorId },
    body: attentionBody,
  });

  cmd.out.data({ worktreeId: resolved.worktreeId, ...result, surfacedOn: anchorId }, () =>
    `CONFLICT merging ${fromRef} into ${resolved.branch} — aborted cleanly, worktree unchanged.\n` +
    `conflicted:\n${result.conflictedPaths.map((p) => `  ${p}`).join('\n')}\n` +
    `surfaced: durable message + attention on ${anchorId}`);
  throw new CliError(
    `merge conflict: ${result.conflictedPaths.length} path(s); surfaced on ${anchorId}`,
    EXIT_CONFLICT,
  );
}

export const WORKTREE_GIT_COMMANDS: CommandModule[] = [
  { path: ['worktree', 'stage'], run: worktreeStage },
  { path: ['worktree', 'commit'], run: worktreeCommit },
  { path: ['worktree', 'merge'], run: worktreeMerge },
];
