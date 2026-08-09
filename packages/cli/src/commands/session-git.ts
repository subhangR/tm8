/**
 * `tm8 session checkpoint|rollback` — undo for agents (Tier 2 headline).
 *
 * Checkpoint commits the session worktree's ENTIRE work-in-progress to the
 * session's own branch and returns the commit oid as the checkpoint ref;
 * rollback restores the worktree to any such ref, refusing to delete
 * untracked files without `--force`. Both write a durable receipt on the
 * session anchor, because a checkpoint nobody can find later is not a
 * checkpoint. Same catalog-zero law as worktree-git.ts: the graph is touched
 * only through operations that already exist, and git runs argv-only through
 * `@tm8/execution/worktree`.
 *
 * The rollback safety asymmetry, spelled out: tracked WIP is exactly what a
 * rollback exists to discard, and rolled-over COMMITS stay reachable in the
 * reflog — but an untracked file may exist in NO commit at all, so deleting
 * it is the one unrecoverable act here. That is why untracked files, and
 * only untracked files, gate on `--force`.
 */
import { checkpoint, rollback } from '@tm8/execution/worktree';

import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import type { CommandContext, CommandModule } from '../run.js';
import { assertKnownOptions, requireArg } from './entity.js';
import {
  liftWorktreeError,
  postReceipt,
  receiptAnchor,
  renderFiles,
  resolveWorktree,
} from './worktree-git.js';

async function sessionCheckpoint(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['message', 'mutation-id']);
  const id = requireArg(cmd, 0, '<session-id|worktree-id>');
  const message = cmd.options.value('message');
  const resolved = await resolveWorktree(cmd, id);
  let result;
  try {
    result = await checkpoint({
      worktreePath: resolved.path,
      expectedBranch: resolved.branch,
      ...(message === undefined ? {} : { message }),
    });
  } catch (error) {
    liftWorktreeError(error);
  }
  cmd.out.data({ worktreeId: resolved.worktreeId, ...result }, () =>
    result.created
      ? `checkpoint ${result.oid} on ${result.branch} (${result.files.length} file(s)):\n${renderFiles(result.files)}\n` +
        `rollback with: tm8 session rollback ${id} --to ${result.oid}`
      : `worktree is clean; checkpoint ref is HEAD: ${result.oid}`);
  if (result.created) {
    await postReceipt(cmd, receiptAnchor(resolved),
      `git checkpoint ${result.oid} on ${result.branch} (worktree ${resolved.worktreeId}): ` +
      `${result.files.length} file(s) captured. Rollback: tm8 session rollback ${id} --to ${result.oid}`);
  }
  return EXIT_OK;
}

async function sessionRollback(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['to', 'force', 'mutation-id']);
  const id = requireArg(cmd, 0, '<session-id|worktree-id>');
  const to = cmd.options.value('to');
  if (!to?.trim()) {
    throw new CliError('session rollback requires --to <checkpoint-ref>', EXIT_USAGE, {
      hint: 'the ref `tm8 session checkpoint` printed, or any commit on the session branch',
    });
  }
  const force = cmd.options.bool('force');
  const resolved = await resolveWorktree(cmd, id);
  let result;
  try {
    result = await rollback({
      worktreePath: resolved.path,
      expectedBranch: resolved.branch,
      to,
      force,
    });
  } catch (error) {
    liftWorktreeError(error);
  }
  cmd.out.data({ worktreeId: resolved.worktreeId, ...result }, () =>
    `rolled back ${result.branch} to ${result.oid}\n` +
    `previous HEAD ${result.previousOid} stays reachable via the reflog` +
    (result.deletedUntracked.length > 0
      ? `\ndeleted untracked (--force):\n${result.deletedUntracked.map((p) => `  ${p}`).join('\n')}`
      : ''));
  await postReceipt(cmd, receiptAnchor(resolved),
    `git rollback: ${result.branch} (worktree ${resolved.worktreeId}) reset to ${result.oid}; ` +
    `previous HEAD was ${result.previousOid} (reflog-reachable)` +
    (result.deletedUntracked.length > 0
      ? `; ${result.deletedUntracked.length} untracked file(s) deleted under --force`
      : '') + '.');
  return EXIT_OK;
}

export const SESSION_GIT_COMMANDS: CommandModule[] = [
  { path: ['session', 'checkpoint'], run: sessionCheckpoint },
  { path: ['session', 'rollback'], run: sessionRollback },
];
