/**
 * `tm8 collection add|remove` — curated membership from the terminal.
 *
 * A COLLECTION IS THE HETEROGENEOUS SEAM. The entity hierarchy already gives
 * ordered lists, but a parent can only hold children of its OWN kind, so it
 * cannot express "these four tasks, that teammate, and the two memories behind
 * the decision" — which is the list people actually want to make. `contains`
 * edges are registered `dst_kinds=['*']` precisely so a collection can hold
 * anything, including another collection.
 *
 * WHY THESE ARE NOT `tm8 edge create ... contains`. They resolve to the same
 * edge, and that spelling is still available, but it makes the caller do two
 * things the pair-addressed rows do for them:
 *
 *  - APPEND POSITION. `contains` orders itself by `props.position`, so adding
 *    to the end over `edge create` means reading the current maximum and
 *    adding one — a read, an arithmetic step, and a race with anyone else
 *    appending at the same moment. `collections.addItem` omits the position
 *    and lets the database resolve it inside the write.
 *  - THE EDGE ID. `edge delete` takes an EDGE id. Nothing on the read side
 *    hands one out for a collection member — `content.items` is a list of
 *    entity summaries — so removing an item over `edge delete` means first
 *    finding the edge that joins the pair. `collection remove` takes the pair.
 *
 * `remove` TAKES NO `--yes`, unlike `edge delete`. It removes a MEMBERSHIP, not
 * an entity: the task, doc or teammate is untouched and stays in every other
 * collection it belongs to. Gating a reversible list edit behind the same
 * confirmation as a destructive one trains people to pass `--yes` reflexively,
 * which is how the flag stops protecting the row that needs it.
 */
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

const ADD_SHAPE = '<collection-id> <entity-id>';
const REMOVE_SHAPE = '<collection-id> <entity-id>';

/**
 * A required positional, reported with the FULL positional shape: both of
 * these rows take two ids of the same syntactic form, so "requires
 * <entity-id>" alone does not tell a caller which of the two they dropped.
 */
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

function envelope(cmd: CommandContext): Record<string, unknown> {
  const out: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) out.actorId = cmd.ctx.actor.value;
  return out;
}

/**
 * `--position` is parsed HERE rather than passed through as a string, because
 * the wire schema is `z.number().finite()` and a bare pass-through would turn
 * a typo into a 400 from the node that names a JSON type mismatch instead of
 * naming the flag the caller got wrong.
 *
 * Rejecting non-finite explicitly matters more than it looks: `Number('')` is
 * 0, not NaN, so an empty `--position` would otherwise silently mean "put this
 * first" — a confident wrong answer, which is worse than a refusal.
 */
function positionOf(cmd: CommandContext): number | undefined {
  const raw = cmd.options.value('position');
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value)) {
    throw new CliError(`tm8 collection add --position expects a number, got "${raw}"`, EXIT_USAGE, {
      hint: 'omit --position to append to the end of the collection',
    });
  }
  return value;
}

async function collectionAdd(cmd: CommandContext): Promise<ExitCode> {
  const collectionId = requireArg(cmd.args[0], 'collection add', '<collection-id>', ADD_SHAPE);
  const entityId = requireArg(cmd.args[1], 'collection add', '<entity-id>', ADD_SHAPE);
  const body: Record<string, unknown> = { entityId, ...envelope(cmd) };
  // Omitted rather than defaulted to null: `AddCollectionItemInput` is strict,
  // and "absent" is what means append. An explicit null is a different request
  // and the schema refuses it.
  const position = positionOf(cmd);
  if (position !== undefined) body.position = position;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'collections.addItem', {
    params: { id: collectionId },
    body,
  });
  cmd.out.data(data, renderAdd);
  return EXIT_OK;
}

async function collectionRemove(cmd: CommandContext): Promise<ExitCode> {
  const collectionId = requireArg(cmd.args[0], 'collection remove', '<collection-id>', REMOVE_SHAPE);
  const entityId = requireArg(cmd.args[1], 'collection remove', '<entity-id>', REMOVE_SHAPE);

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'collections.removeItem', {
    params: { id: collectionId, entityId },
    body: envelope(cmd),
  });
  cmd.out.data(data, renderRemove);
  return EXIT_OK;
}

// ── human renderings — a function of the SAME DTO `--format json` emits ──────

function renderAdd(): string {
  return 'added to collection';
}

/**
 * The `removed:false` case is rendered DIFFERENTLY rather than folded into one
 * cheerful line. The row succeeds either way, so a caller who mistyped an id
 * would otherwise be told "removed from collection" about a collection that
 * never contained it — the operation is idempotent, but the human reading the
 * output still needs to know which of the two things happened.
 */
function renderRemove(data: unknown): string {
  const removed = (data as { removed?: unknown } | null)?.removed;
  return removed === false
    ? 'not in the collection — nothing to remove'
    : 'removed from collection';
}

export const COLLECTION_COMMANDS: CommandModule[] = [
  { path: ['collection', 'add'], run: collectionAdd },
  { path: ['collection', 'remove'], run: collectionRemove },
];
