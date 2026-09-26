/**
 * `tm8 worktree stage|commit|merge` — the MUTATING half of the worktree
 * surface (Tier 2), plus the graph-resolution helpers `session
 * checkpoint|rollback` share (session-git.ts).
 *
 * SUGAR OVER THE EXISTING CATALOG, ADDING ZERO OPERATIONS — the same law the
 * read surface (`worktree list|status`, PR #67) states in its own header.
 * Every graph touch here is an operation that already exists: `entities.get`
 * and `edges.list` resolve a session to its worktree, `messages.post` writes
 * the durable receipts, `attentionSignals.raise` raises a conflict and
 * `attentionSignals.clear` clears it once the flow completes clean. The GIT
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
 * worktree itself — some anchor ALWAYS gets it) and raises tm8's own conflict
 * signal on that anchor (Attention v2 S6: origin system, keyed by the
 * worktree, high / review). Only after both durable writes does the command
 * exit 6. The next CLEAN merge, cherry-pick or stash pop in the same worktree
 * clears the signal, wherever it was raised.
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
import { ApiError } from '../errors.js';
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

/** Which rail conflicted: the key is per flow, so only the same flow clears it. */
export type ConflictFlow = 'merge' | 'cherry_pick' | 'stash_pop';

/**
 * Attention v2 S6: tm8's own conflict signal. The body names the situation
 * only ({kind:'conflict', worktreeId, flow}); the server builds the key
 * `conflict:<worktreeId>:<flow>`, fixes high / review, and refuses an anchor
 * that is not the worktree, a session or task in it, or a task a session in it
 * works on. An explicit --task the server refuses as unlinked falls back to the
 * default anchor chain rather than turning the conflict's exit 6 into a
 * forbidden error. Raising again while it is open returns the open request.
 * Returns the anchor the signal landed on.
 */
export async function raiseConflictSignal(
  cmd: CommandContext,
  resolved: ResolvedWorktree,
  anchorId: string,
  reason: string,
  flow: ConflictFlow,
): Promise<string> {
  const raise = async (entityId: string, clientMutationId: string): Promise<void> => {
    const body: Record<string, unknown> = {
      clientMutationId,
      signal: { kind: 'conflict', worktreeId: resolved.worktreeId, flow },
      reason,
    };
    if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;
    await observedInvoke<unknown>(clientFor(cmd.ctx), 'attentionSignals.raise', {
      params: { entityId },
      body,
    });
  };
  const fallback = resolved.taskIds[0] ?? resolved.sessionId ?? resolved.worktreeId;
  try {
    await raise(anchorId, resolveMutationId(cmd.options.value('mutation-id')));
    return anchorId;
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'forbidden' || anchorId === fallback) throw error;
    cmd.out.warn(`${anchorId} is not linked to worktree ${resolved.worktreeId}; the conflict signal is raised on ${fallback}`);
    await raise(fallback, resolveMutationId(undefined));
    return fallback;
  }
}

/**
 * The clean-completion half: clears this flow's open conflict signal in the
 * worktree, on whichever anchor it was raised. Idempotent, so every clean run
 * calls it. BEST-EFFORT: the git operation has already succeeded, and a
 * non-zero exit would invite a retry that is not idempotent (a second stash
 * pop pops the NEXT entry), so a failure here is a warning, never an exit.
 */
export async function clearConflictSignal(
  cmd: CommandContext,
  resolved: ResolvedWorktree,
  flow: ConflictFlow,
): Promise<void> {
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(undefined),
    signal: { kind: 'conflict', worktreeId: resolved.worktreeId, flow },
  };
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;
  try {
    await observedInvoke<unknown>(clientFor(cmd.ctx), 'attentionSignals.clear', {
      params: { entityId: resolved.worktreeId },
      body,
    });
  } catch (error) {
    cmd.out.warn(`conflict signal not cleared: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    await clearConflictSignal(cmd, resolved, 'merge');
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
    result.conflictedPaths.map((p: string) => `- ${p}`).join('\n') +
    `\nResolve by merging manually in the worktree, or rebase the branch. Re-run: tm8 worktree merge ${id} --from ${fromRef}`;
  await postReceipt(cmd, anchorId, body);
  const surfacedOn = await raiseConflictSignal(cmd, resolved, anchorId,
    `merge conflict: ${fromRef} into ${resolved.branch}, ${result.conflictedPaths.length} path(s)`, 'merge');

  cmd.out.data({ worktreeId: resolved.worktreeId, ...result, surfacedOn: surfacedOn }, () =>
    `CONFLICT merging ${fromRef} into ${resolved.branch} — aborted cleanly, worktree unchanged.\n` +
    `conflicted:\n${result.conflictedPaths.map((p: string) => `  ${p}`).join('\n')}\n` +
    (surfacedOn === anchorId
      ? `surfaced: durable message + attention on ${anchorId}`
      : `surfaced: durable message on ${anchorId}, attention on ${surfacedOn}`));
  throw new CliError(
    `merge conflict: ${result.conflictedPaths.length} path(s); surfaced on ${surfacedOn}`,
    EXIT_CONFLICT,
  );
}

export const WORKTREE_GIT_COMMANDS: CommandModule[] = [
  { path: ['worktree', 'stage'], run: worktreeStage },
  { path: ['worktree', 'commit'], run: worktreeCommit },
  { path: ['worktree', 'merge'], run: worktreeMerge },
];
