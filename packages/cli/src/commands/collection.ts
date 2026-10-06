/**
 * `tm8 collection add|remove` — the membership seam (collections.addItem /
 * collections.removeItem).
 *
 * WHY THIS MODULE EXISTS AT ALL. The `collection` noun spent its first months
 * as a documentation alias: its one operation (`collections.query`) is invoked
 * as `tm8 entity query`, so `tm8 collection …` 2-exited as unknown. The
 * membership writs are the family's first rows whose PUBLIC invocation carries
 * the noun, so the module is new rather than a split of `entity.ts` — the
 * command path, not the operation family, decides which module owns a row.
 *
 * TWO DECISIONS THAT ARE NOT OBVIOUS FROM THE FLAG LIST:
 *
 *  - `--position` IS OPTIONAL AND OMITTED WHEN ABSENT, never defaulted. The
 *    Server appends after the current maximum when the field is missing;
 *    sending a locally-invented `0` would silently prepend instead.
 *  - `remove` REQUIRES `--yes` like `edge delete`, because it is the same
 *    physical operation: membership IS a `contains` edge, and this command
 *    deletes one addressed by (collection, entity) instead of by edge id.
 *
 * Reading a collection's members is NOT here and gets a pointer instead:
 * `tm8 edge list --source <collection-id> --type contains` pages the edges.
 *
 * The container may also be a story (migration 283): the same `contains` edge
 * is how a story's roots are put in by hand. Or a design (migration 304):
 * there the edge is a PAGE, `--position` orders the pages, and re-adding a
 * page with a new `--position` is how a page is moved. The Server decides
 * which kinds may contain (and refuses a design loop), so nothing here checks
 * the container's kind.
 */
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { parseInvocation, readTextSource } from '../args.js';
import { exitCodeFor } from '../errors.js';
import { assertKnownOptions } from './entity.js';
import { callerMutationId, SCHEMA_VERSION, successReceipt } from '../receipt.js';
import { errorInput, errorReceipt, isAmbiguous, replayCommand, withErrorReceipt } from '../receipt-error.js';
import { deriveMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { renderCommandResult } from './edge.js';

const ADD_SHAPE = '<collection-id> <entity-id>... [--from-file <path|->]';
const REMOVE_SHAPE = '<collection-id> <entity-id>';

function requireArg(
  raw: string | undefined,
  command: string,
  placeholder: string,
  shape: string,
): string {
  if (raw === undefined || raw.length === 0) {
    throw new CliError(`tm8 ${command} ${shape} — missing ${placeholder}`, EXIT_USAGE);
  }
  return raw;
}

/** The command envelope every mutation on this module carries. */
function envelope(cmd: CommandContext): Record<string, unknown> {
  const out: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) out.actorId = cmd.ctx.actor.value;
  return out;
}

/** Materialize file/stdin ids for replay and preserve the invocation's route and actor. */
function addArgv(cmd: CommandContext, collectionId: string, entityIds: readonly string[]): string[] {
  const globals = cmd.argv === undefined ? undefined : parseInvocation(cmd.argv).globals;
  return [
    ...(globals?.server === undefined ? [] : ['--server', globals.server]),
    ...(globals?.space === undefined ? [] : ['--space', globals.space]),
    ...(cmd.ctx.actor === undefined ? [] : ['--as', cmd.ctx.actor.value]),
    'collection', 'add', collectionId, ...entityIds,
  ];
}

async function collectionAdd(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['position', 'from-file', 'mutation-id']);
  const collectionId = requireArg(cmd.args[0], 'collection add', '<collection-id>', ADD_SHAPE);
  const ids = cmd.args.slice(1);
  const file = cmd.options.value('from-file');
  if (file !== undefined) {
    const text = await readTextSource(file === '-' || file.startsWith('@') ? file : `@${file}`);
    ids.push(...text.split(/\s+/).filter(Boolean));
  }
  const entityIds = [...new Set(ids)];
  requireArg(entityIds[0], 'collection add', '<entity-id>', ADD_SHAPE);
  const base = envelope(cmd);
  const position = cmd.options.value('position');
  if (position !== undefined) {
    const parsed = Number(position);
    if (position.trim() === '' || !/^-?\d+(\.\d+)?$/.test(position.trim()) || !Number.isFinite(parsed)) {
      throw new CliError(`--position <number> expects a finite number, got ${JSON.stringify(position)}`, EXIT_USAGE);
    }
    if (entityIds.length > 1) throw new CliError('--position is only supported when adding one entity', EXIT_USAGE);
    base.position = parsed;
  }
  if (entityIds.length === 1) {
    const entityId = entityIds[0]!;
    const data = await withErrorReceipt(cmd, errorInput(cmd, 'collection.add', { id: collectionId, mutationId: base.clientMutationId as string }), () =>
      observedInvoke<unknown>(clientFor(cmd.ctx), 'collections.addItem', { params: { id: collectionId }, body: { ...base, entityId } }));
    cmd.out.mutation('collection.add', data, renderCommandResult, () => successReceipt('collection.add', data, {
      ...callerMutationId(cmd.options), collectionId, entityId,
    }));
    return EXIT_OK;
  }
  // The existing membership door is atomic per id. Derive stable identities so
  // replaying the whole batch after a partial failure safely replays every member.
  // A one-item retry must use that member's derived id, not the batch id: the
  // established single-add door passes --mutation-id through unchanged.
  const results: Record<string, unknown>[] = [];
  let exitCode: ExitCode = EXIT_OK;
  for (const entityId of entityIds) {
    const mutationId = deriveMutationId(base.clientMutationId as string, `collection.add/${collectionId}/${entityId}`);
    try {
      const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'collections.addItem', {
        params: { id: collectionId }, body: { ...base, entityId, clientMutationId: mutationId },
      });
      results.push({ ...successReceipt('collection.add', data, { collectionId, entityId }), mutationId,
        ...(cmd.out.receipts === 'full' ? { data } : {}) });
    } catch (error) {
      if (exitCode === EXIT_OK) exitCode = exitCodeFor(error);
      const argv = addArgv(cmd, collectionId, [entityId]);
      const failure = errorReceipt(error, {
        ...errorInput(cmd, 'collection.add', { id: collectionId, mutationId }), argv,
      });
      results.push({ ...failure, entityId, ok: false, mutationId,
        error: failure?.error ?? { code: 'client_error', message: error instanceof Error ? error.message : String(error) },
        ...(isAmbiguous(error) ? { outcome: 'unknown' } : {}),
        next: replayCommand(argv, mutationId),
      });
    }
  }
  const receipt = { schemaVersion: SCHEMA_VERSION, op: 'collection.add', ok: exitCode === EXIT_OK, id: collectionId,
    mutationId: base.clientMutationId, results,
    next: replayCommand(addArgv(cmd, collectionId, entityIds), base.clientMutationId as string) };
  cmd.out.data(receipt, () => [
    `collection.add ${collectionId} · ${results.filter(r => r.ok === true).length}/${results.length} added`,
    `batch mutationId: ${receipt.mutationId}`,
    `replay whole batch: ${receipt.next}`,
    ...results.filter(r => r.ok === false).flatMap(r => [
      `${r.entityId}${r.outcome === 'unknown' ? ' · outcome: unknown' : ''}: ${JSON.stringify(r.error)}`,
      `retry this item: ${r.next}`,
    ]),
  ].join('\n'), { raw: true, minify: true });
  return exitCode;
}

async function collectionRemove(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['yes', 'mutation-id']);
  if (cmd.args.length > 2) throw new CliError('collection remove accepts exactly one entity id', EXIT_USAGE);
  const collectionId = requireArg(cmd.args[0], 'collection remove', '<collection-id>', REMOVE_SHAPE);
  const entityId = requireArg(cmd.args[1], 'collection remove', '<entity-id>', REMOVE_SHAPE);
  if (!cmd.options.bool('yes')) {
    throw new CliError('tm8 collection remove is destructive and requires --yes', EXIT_USAGE, {
      hint: 'it deletes the `contains` edge; the entity itself is untouched',
    });
  }
  const body = envelope(cmd);
  const data = await withErrorReceipt(cmd, errorInput(cmd, 'collection.remove', { id: collectionId, mutationId: body.clientMutationId as string }), () => observedInvoke<unknown>(clientFor(cmd.ctx), 'collections.removeItem', {
    params: { id: collectionId, entityId },
    body,
  }));
  cmd.out.mutation('collection.remove', data, renderCommandResult, () => successReceipt('collection.remove', data, {
    ...callerMutationId(cmd.options), collectionId, entityId,
  }));
  return EXIT_OK;
}

export const COLLECTION_COMMANDS: CommandModule[] = [
  { path: ['collection', 'add'], run: collectionAdd },
  { path: ['collection', 'remove'], run: collectionRemove },
];
