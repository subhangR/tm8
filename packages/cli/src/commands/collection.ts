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
 */
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { renderCommandResult } from './edge.js';

const ADD_SHAPE = '<collection-id> <entity-id>';
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

async function collectionAdd(cmd: CommandContext): Promise<ExitCode> {
  const collectionId = requireArg(cmd.args[0], 'collection add', '<collection-id>', ADD_SHAPE);
  const entityId = requireArg(cmd.args[1], 'collection add', '<entity-id>', ADD_SHAPE);
  const body: Record<string, unknown> = { entityId, ...envelope(cmd) };
  const position = cmd.options.value('position');
  if (position !== undefined) {
    const parsed = Number(position);
    if (!Number.isFinite(parsed)) {
      throw new CliError(`--position <number> expects a finite number, got ${JSON.stringify(position)}`, EXIT_USAGE);
    }
    body.position = parsed;
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'collections.addItem', {
    params: { id: collectionId },
    body,
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

async function collectionRemove(cmd: CommandContext): Promise<ExitCode> {
  const collectionId = requireArg(cmd.args[0], 'collection remove', '<collection-id>', REMOVE_SHAPE);
  const entityId = requireArg(cmd.args[1], 'collection remove', '<entity-id>', REMOVE_SHAPE);
  if (!cmd.options.bool('yes')) {
    throw new CliError('tm8 collection remove is destructive and requires --yes', EXIT_USAGE, {
      hint: 'it deletes the `contains` edge; the entity itself is untouched',
    });
  }
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'collections.removeItem', {
    params: { id: collectionId, entityId },
    body: envelope(cmd),
  });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

export const COLLECTION_COMMANDS: CommandModule[] = [
  { path: ['collection', 'add'], run: collectionAdd },
  { path: ['collection', 'remove'], run: collectionRemove },
];
