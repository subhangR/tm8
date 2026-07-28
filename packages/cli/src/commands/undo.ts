/**
 * `tm8 undo apply <undo-token>` — redeem a token a previous mutation returned
 * (§4.8).
 *
 * ── LAW O5: THIS IS A REDACTION, NEVER A DELETE ────────────────────────────
 *
 * The undo-token table admits exactly four registered inverses —
 * `edges.delete`, `entities.move`, `entities.restore`, and `messages.delete` —
 * and the token's `operation` names the inverse RUN AT REDEMPTION, not the
 * mutation that issued the token. The `messages.delete` inverse is issued by
 * `placements.apply … embed`, an intent that POSTS a message; redeeming it
 * therefore calls the message tombstone RPC, which sets the body to
 * `[redacted]`, clears mentions and attachments, stamps `redacted_at` — and
 * LEAVES THE ROW IN THE THREAD. Thread history survives.
 *
 * Calling that transition a "delete", or its inverse an "un-delete", tells an
 * operator that history is gone when it is not. The natural response to
 * "history is gone" is a destructive recovery, aimed at data that was never
 * lost. So the vocabulary is a correctness property of this file and is
 * asserted by a probe that first proves it can detect the words it forbids.
 *
 * ── AN UNDO TOKEN IS NOT UNIVERSAL ─────────────────────────────────────────
 *
 * A token exists only when the mutation that ran issued one, it expires, and
 * it can be spent once. Nothing here may read as though every command produces
 * one — an agent that believes undo is always available will plan around a
 * rollback it does not have.
 *
 * ── FAITHFUL RENDER, ZERO INVENTION ────────────────────────────────────────
 *
 * `--format json` emits the contract `CommandResult` verbatim, unannotated.
 * The human view is a rendering of that same DTO: the affected entity ids,
 * plus the redaction sentence exactly when the DTO itself shows a message was
 * touched. A non-message inverse is never described as a redaction either —
 * a moved entity has not been redacted, and saying so would be wrong in the
 * other direction.
 */
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { assertKnownOptions, summaryLine, withActor } from './entity.js';
import type { CommandContext, CommandModule } from '../run.js';

interface TouchedEntity {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  version?: unknown;
}

/**
 * The redaction sentence. Every word is chosen against the failure mode: it
 * states what the row now CONTAINS, and states explicitly that the row is
 * still there.
 */
const REDACTION_NOTE =
  'redacted: the message body is now [redacted], its mentions and attachments are cleared, ' +
  'and thread history survives — the message is still in its thread';

function touched(dto: unknown): TouchedEntity[] {
  const r = dto as { entity?: TouchedEntity; patches?: unknown } | undefined;
  const rows: TouchedEntity[] = [];
  if (r?.entity) rows.push(r.entity);
  if (Array.isArray(r?.patches)) rows.push(...(r.patches as TouchedEntity[]));
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = String(row?.id ?? '');
    if (key === '' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderRedemption(dto: unknown): string {
  const rows = touched(dto);
  const lines = rows.map((row) => summaryLine(row)).filter((l) => l !== '');
  if (rows.some((row) => row?.kind === 'message')) lines.push(REDACTION_NOTE);
  return lines.length > 0 ? lines.join('\n') : 'ok';
}

async function undoApply(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const token = cmd.args[0];
  if (token === undefined || token === '') {
    throw new CliError('`tm8 undo apply` requires the <undo-token> a mutation returned', EXIT_USAGE, {
      hint:
        'not every mutation issues an undo token; when one is issued it appears on that command output, ' +
        'and it is redeemable only while it is unspent and unexpired',
    });
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'commands.undo', {
    body: withActor(cmd, {
      token,
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    }),
  });
  cmd.out.data(data, renderRedemption);
  return EXIT_OK;
}

export const UNDO_COMMANDS: CommandModule[] = [
  { path: ['undo', 'apply'], run: undoApply },
];
