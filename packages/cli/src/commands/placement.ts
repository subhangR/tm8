/**
 * `tm8 placement apply` — the intent-level placement seam (grammar §4.8).
 *
 * ONE OPERATION, ONE COMMAND, NO COMPOSITION. `placements.apply` translates a
 * caller INTENT ("this file attaches to that task") into whatever registered
 * edge, hierarchy move, or message the Server decides that intent means. The
 * CLI deliberately does not model that translation: which edge type an
 * `attach` becomes is Server truth, and a client that predicted it would drift
 * the moment the placement rules changed.
 *
 * THE INTENT IS A CLOSED POSITIONAL, CHECKED HERE. `PlacementInput.intent` is a
 * six-member enum. A typo is refused locally with the six named, because a
 * positional in a three-argument command is the easiest thing in this grammar
 * to get subtly wrong (`depends` for `depend`), and "which words are legal" is
 * the one question the caller actually has.
 *
 * `embed` IS NEWLY REPAIRED, NOT NEW. It was a confirmed data-loss defect —
 * an undo token rejected at INSERT rolled back the message the placement had
 * just posted — fixed by X01 and re-confirmed at the public boundary by W3.
 * Nothing in this file works around it; it is named here so the next reader
 * knows the integration suite exercises `embed` deliberately rather than as
 * one more member of an enum.
 *
 * WHAT THIS COMMAND MUST NEVER SAY. A placement can return an undo token, and
 * an undo token is NOT uniformly a reversal: redeeming a `messages.delete`
 * token is a REDACTION reversal in which thread history never left. The
 * rendering is shared with the edge module for exactly that reason — see
 * `renderCommandResult` — and neither surface may describe undo as universally
 * applicable or as an un-delete.
 */
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';
import { renderCommandResult } from './edge.js';

/** §4.8, in the grammar's own order. `PlacementInput.intent` is this enum. */
export const PLACEMENT_INTENTS = [
  'attach', 'assign', 'depend', 'subtask', 'embed', 'reparent',
] as const;

/**
 * `PlacementInput` carries an optional `embedMessage`, and §4.8 binds NO flag
 * for it. Accepting `--embed-message` and dropping it would be the worst
 * available answer on precisely the row with a data-loss history: the caller
 * would believe a message was posted with the embed. Refused, named.
 */
const UNBOUND_PLACEMENT_FLAGS = ['embed-message'] as const;

function requireArg(raw: string | undefined, placeholder: string): string {
  if (raw === undefined || raw.length === 0) {
    throw new CliError(
      `tm8 placement apply requires <source-entity-id> ${PLACEMENT_INTENTS.join('|')} <target-entity-id>` +
        ` — missing ${placeholder}`,
      EXIT_USAGE,
    );
  }
  return raw;
}

function requireIntent(raw: string | undefined): string {
  const intent = requireArg(raw, `${PLACEMENT_INTENTS.join('|')}`);
  if (!(PLACEMENT_INTENTS as readonly string[]).includes(intent)) {
    throw new CliError(
      `${JSON.stringify(intent)} is not a placement intent: expected ${PLACEMENT_INTENTS.join('|')}`,
      EXIT_USAGE,
    );
  }
  return intent;
}

async function placementApply(cmd: CommandContext): Promise<ExitCode> {
  for (const flag of UNBOUND_PLACEMENT_FLAGS) {
    if (cmd.options.has(flag)) {
      throw new CliError(
        `--${flag} is not bound by \`tm8 placement apply\`: it is amendment-dependent and the frozen grammar does not carry it`,
        EXIT_USAGE,
        { hint: 'read the bound flags with `tm8 help placement apply`' },
      );
    }
  }

  const sourceId = requireArg(cmd.args[0], '<source-entity-id>');
  const intent = requireIntent(cmd.args[1]);
  const targetId = requireArg(cmd.args[2], '<target-entity-id>');

  const body: Record<string, unknown> = {
    sourceId,
    targetId,
    intent,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'placements.apply', { body });
  cmd.out.data(data, renderCommandResult);
  return EXIT_OK;
}

export const PLACEMENT_COMMANDS: CommandModule[] = [
  { path: ['placement', 'apply'], run: placementApply },
];
