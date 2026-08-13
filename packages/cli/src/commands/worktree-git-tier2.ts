/**
 * `tm8 worktree cherry-pick|branch|stash` — the Tier 2 COMPLETION verbs,
 * finishing the surface worktree-git.ts began. Same laws, stated there and
 * held here:
 *
 *  - ALIASES over the existing catalog, zero new operations (the git runs
 *    locally at the graph-recorded path; the graph touches are entities.get /
 *    edges.list resolution, messages.post receipts, attentionRequests.create
 *    on conflict);
 *  - S11 holds: the CLI never accepts a filesystem path — a host that cannot
 *    see the worktree refuses with worktree_not_local at the first probe;
 *  - a CONFLICT is never silent: cherry-pick and stash pop copy `worktree
 *    merge`'s rail verbatim — the core aborts and VERIFIES the worktree is
 *    clean, then this layer writes a durable message naming every conflicted
 *    path on the owning task anchor (fallback session, then worktree) and
 *    raises attention there, and only after both durable writes exits 6.
 *
 * The destructive gates are the core's, surfaced as flags: `branch delete`
 * of an unmerged branch and `stash drop` both refuse without --force, and
 * both receipts carry the oid that keeps the destroyed thing reachable
 * until gc — reversibility is part of the answer.
 */
import {
  branchCreate,
  branchDelete,
  branchRename,
  cherryPick,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
  type CherryPickResult,
  type StashPopResult,
} from '@tm8/execution/worktree';

import { CliError, EXIT_CONFLICT, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, requireArg } from './entity.js';
import {
  liftWorktreeError,
  postReceipt,
  receiptAnchor,
  renderFiles,
  resolveWorktree,
  type ResolvedWorktree,
} from './worktree-git.js';

const CONFLICT_ATTENTION_POINTS = 60;

/**
 * The conflict rail, shared by cherry-pick and stash pop — one durable
 * message + one attention request on the owning anchor, then exit 6. Copied
 * from `worktree merge`'s contract; the vocabulary must stay identical.
 */
async function surfaceConflict(
  cmd: CommandContext,
  resolved: ResolvedWorktree,
  what: string,
  conflictedPaths: readonly string[],
  rerun: string,
): Promise<never> {
  const explicitTask = cmd.options.value('task');
  const anchorId = explicitTask ?? resolved.taskIds[0] ?? resolved.sessionId ?? resolved.worktreeId;
  const body =
    `${what.toUpperCase()} CONFLICT on ${resolved.branch} ` +
    `(worktree ${resolved.worktreeId}${resolved.sessionId ? `, session ${resolved.sessionId}` : ''}). ` +
    `The operation was ABORTED cleanly; the worktree is unchanged. Conflicted path(s):\n` +
    conflictedPaths.map((p) => `- ${p}`).join('\n') +
    `\nResolve manually in the worktree, then re-run: ${rerun}`;
  await postReceipt(cmd, anchorId, body);
  const attentionBody: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    reason: `${what} conflict on ${resolved.branch}, ${conflictedPaths.length} path(s)`,
    points: CONFLICT_ATTENTION_POINTS,
  };
  if (cmd.ctx.actor) attentionBody.actorId = cmd.ctx.actor.value;
  await observedInvoke<unknown>(clientFor(cmd.ctx), 'attentionRequests.create', {
    params: { entityId: anchorId },
    body: attentionBody,
  });
  cmd.out.data({ worktreeId: resolved.worktreeId, status: 'conflict', conflictedPaths, surfacedOn: anchorId }, () =>
    `CONFLICT: ${what} on ${resolved.branch} — aborted cleanly, worktree unchanged.\n` +
    `conflicted:\n${conflictedPaths.map((p) => `  ${p}`).join('\n')}\n` +
    `surfaced: durable message + attention on ${anchorId}`);
  throw new CliError(
    `${what} conflict: ${conflictedPaths.length} path(s); surfaced on ${anchorId}`,
    EXIT_CONFLICT,
  );
}

/**
 * `tm8 worktree cherry-pick <id> <commit>... [--task <task-id>]` — apply
 * commits (oldest first) onto the session's branch, in the session's
 * worktree. The direction is fixed by construction: FROM the named commits
 * ONTO the session lane — this verb never touches any other checkout.
 */
async function worktreeCherryPick(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['task', 'mutation-id']);
  const id = requireArg(cmd, 0, '<session-id|worktree-id>');
  const commits = cmd.args.slice(1);
  if (commits.length === 0) {
    throw new CliError('worktree cherry-pick requires at least one <commit>', EXIT_USAGE);
  }
  const resolved = await resolveWorktree(cmd, id);
  let result: CherryPickResult;
  try {
    result = await cherryPick({ worktreePath: resolved.path, expectedBranch: resolved.branch, commits });
  } catch (error) {
    liftWorktreeError(error);
  }
  if (result.status === 'conflict') {
    // surfaceConflict always throws (exit 6) after its two durable writes.
    return surfaceConflict(cmd, resolved, 'cherry-pick', result.conflictedPaths,
      `tm8 worktree cherry-pick ${id} ${commits.join(' ')}`);
  }
  cmd.out.data({ worktreeId: resolved.worktreeId, ...result }, () =>
    `picked ${result.newOids.length} commit(s) onto ${resolved.branch}:\n` +
    result.newOids.map((o) => `  ${o}`).join('\n'));
  await postReceipt(cmd, receiptAnchor(resolved),
    `git cherry-pick onto ${resolved.branch} (worktree ${resolved.worktreeId}): ` +
    `${result.fromOids.join(', ')} applied as ${result.newOids.join(', ')}.`);
  return EXIT_OK;
}

/** `tm8 worktree branch create|rename|delete <id> ...` — inside the session's repo only. */
async function worktreeBranch(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['from', 'force', 'mutation-id']);
  const action = requireArg(cmd, 0, '<create|rename|delete>');
  const id = requireArg(cmd, 1, '<session-id|worktree-id>');
  const resolved = await resolveWorktree(cmd, id);
  // The one branch the graph explicitly ties this worktree to a base of.
  // (Checked-out-anywhere protection, primary tree included, is the core's.)
  try {
    if (action === 'create') {
      const name = requireArg(cmd, 2, '<branch-name>');
      const from = cmd.options.value('from');
      const r = await branchCreate({ worktreePath: resolved.path, name, ...(from ? { from } : {}) });
      cmd.out.data({ worktreeId: resolved.worktreeId, ...r }, () => `created ${r.name} at ${r.oid}`);
      await postReceipt(cmd, receiptAnchor(resolved),
        `git branch created: ${r.name} at ${r.oid} (worktree ${resolved.worktreeId}).`);
      return EXIT_OK;
    }
    if (action === 'rename') {
      const from = requireArg(cmd, 2, '<old-name>');
      const to = requireArg(cmd, 3, '<new-name>');
      const r = await branchRename({ worktreePath: resolved.path, from, to });
      cmd.out.data({ worktreeId: resolved.worktreeId, ...r }, () => `renamed ${r.from} -> ${r.to} (${r.oid})`);
      await postReceipt(cmd, receiptAnchor(resolved),
        `git branch renamed: ${r.from} -> ${r.to} (worktree ${resolved.worktreeId}).`);
      return EXIT_OK;
    }
    if (action === 'delete') {
      const name = requireArg(cmd, 2, '<branch-name>');
      const force = cmd.options.bool('force');
      const r = await branchDelete({ worktreePath: resolved.path, name, ...(force ? { force: true } : {}) });
      cmd.out.data({ worktreeId: resolved.worktreeId, ...r }, () =>
        `deleted ${r.name} (was ${r.deletedOid}${r.forced ? `; UNMERGED relative to ${r.measuredAgainst}, forced` : `; merged into ${r.measuredAgainst}`})\n` +
        `the tip stays reachable by oid until gc: git branch ${r.name} ${r.deletedOid}`);
      await postReceipt(cmd, receiptAnchor(resolved),
        `git branch deleted: ${r.name} (tip ${r.deletedOid}, ` +
        `${r.forced ? `unmerged relative to ${r.measuredAgainst}, forced` : 'merged'}; ` +
        `worktree ${resolved.worktreeId}). The tip oid resurrects it until gc.`);
      return EXIT_OK;
    }
    throw new CliError(`unknown branch action ${JSON.stringify(action)}; expected create|rename|delete`, EXIT_USAGE);
  } catch (error) {
    liftWorktreeError(error);
  }
}

/** `tm8 worktree stash push|list|pop|drop <id> ...` — per worktree. */
async function worktreeStash(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['message', 'index', 'force', 'task', 'mutation-id']);
  const action = requireArg(cmd, 0, '<push|list|pop|drop>');
  const id = requireArg(cmd, 1, '<session-id|worktree-id>');
  const resolved = await resolveWorktree(cmd, id);

  const parseIndex = (): number | undefined => {
    const raw = cmd.options.value('index');
    if (raw === undefined) return undefined;
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0 || String(n) !== raw.trim()) {
      throw new CliError(`--index must be a non-negative integer, got ${raw}`, EXIT_USAGE);
    }
    return n;
  };

  try {
    if (action === 'list') {
      refuseMutationId('worktree stash list', cmd.options.value('mutation-id'));
      const entries = await stashList(resolved.path);
      cmd.out.data({ worktreeId: resolved.worktreeId, entries }, () =>
        entries.length === 0
          ? `worktree ${resolved.worktreeId} (${resolved.branch}): no stash entries`
          : entries.map((e) => `  stash@{${e.index}}  ${e.oid.slice(0, 12)}  ${e.date}  ${e.subject}`).join('\n'));
      return EXIT_OK;
    }
    if (action === 'push') {
      const message = cmd.options.value('message');
      const r = await stashPush({
        worktreePath: resolved.path, expectedBranch: resolved.branch,
        ...(message ? { message } : {}),
      });
      if (r.status === 'clean') {
        cmd.out.data({ worktreeId: resolved.worktreeId, ...r }, () =>
          `worktree ${resolved.worktreeId} (${r.branch}) is clean — nothing to stash`);
        return EXIT_OK;
      }
      cmd.out.data({ worktreeId: resolved.worktreeId, ...r }, () =>
        `stashed ${r.files.length} file(s) from ${r.branch} as ${r.oid}:\n${renderFiles(r.files)}`);
      await postReceipt(cmd, receiptAnchor(resolved),
        `git stash push on ${r.branch} (worktree ${resolved.worktreeId}): ` +
        `${r.files.length} file(s) stored as ${r.oid} (untracked included — stored, not lost).`);
      return EXIT_OK;
    }
    if (action === 'pop') {
      const index = parseIndex();
      const r: StashPopResult = await stashPop({
        worktreePath: resolved.path, expectedBranch: resolved.branch,
        ...(index === undefined ? {} : { index }),
      });
      if (r.status === 'conflict') {
        // surfaceConflict always throws (exit 6) after its two durable writes.
        return surfaceConflict(cmd, resolved, 'stash pop', r.conflictedPaths,
          `tm8 worktree stash pop ${id}${index === undefined ? '' : ` --index ${index}`}` +
          ' (the entry was RETAINED)');
      }
      cmd.out.data({ worktreeId: resolved.worktreeId, ...r }, () =>
        `popped ${r.oid.slice(0, 12)} onto ${r.branch}:\n${renderFiles(r.files)}`);
      return EXIT_OK;
    }
    if (action === 'drop') {
      const index = parseIndex() ?? 0;
      const force = cmd.options.bool('force');
      const r = await stashDrop({ worktreePath: resolved.path, index, ...(force ? { force: true } : {}) });
      cmd.out.data({ worktreeId: resolved.worktreeId, ...r }, () =>
        `dropped stash@{${index}} (${r.subject})\nits content stays reachable until gc: git stash store ${r.droppedOid}`);
      await postReceipt(cmd, receiptAnchor(resolved),
        `git stash drop on worktree ${resolved.worktreeId}: stash@{${index}} destroyed ` +
        `(was ${r.droppedOid} — reachable by that oid until gc).`);
      return EXIT_OK;
    }
    throw new CliError(`unknown stash action ${JSON.stringify(action)}; expected push|list|pop|drop`, EXIT_USAGE);
  } catch (error) {
    liftWorktreeError(error);
  }
}

export const WORKTREE_GIT_TIER2_COMMANDS: CommandModule[] = [
  { path: ['worktree', 'cherry-pick'], run: worktreeCherryPick },
  { path: ['worktree', 'branch'], run: worktreeBranch },
  { path: ['worktree', 'stash'], run: worktreeStash },
];
