/**
 * `tm8 handoff send|list|withdraw` — projecting a bounded entity snapshot into
 * a work session (A05-A07).
 *
 * A HANDOFF IS NOT A MESSAGE ATTACHMENT, and the distinction is structural
 * rather than stylistic. `--attach` on `message send` carries FILES, and the
 * relationship it creates is `attached_to`. A handoff carries an ENTITY
 * SNAPSHOT — a `ShareProjectionEnvelope` capped at exactly 32,768 bytes — into a
 * session, and it has its own two-axis state machine (`deliveryStatus` ×
 * `recordStatus`) with its own withdrawal path. Collapsing the two would mean a
 * caller could not withdraw a projection, because files have no withdrawal.
 *
 * `handoffId == clientMutationId`, EXACTLY. That makes the mutation id a
 * published correlation identifier — it is read straight back out of
 * `HandoffView` — and it is never a capability. Nothing may depend on who does
 * or does not know one.
 *
 * TWO CONFLICTS BETWEEN THE AUTHORITIES ARE LIVE IN THIS FILE. Both are handled
 * so that the gap is visible rather than smoothed over, and both are reported
 * for arbitration; see `refuseSourceVersionGuard` and `handoffWithdraw`.
 */
import { readTextSource } from '../args.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

function requireArg(raw: string | undefined, what: string, syntax: string): string {
  if (raw === undefined || raw.length === 0) {
    throw new CliError(`tm8 ${syntax} requires ${what}`, EXIT_USAGE);
  }
  return raw;
}

/**
 * CONFLICT 1 — `--expect-source-version <n>` has no home on the wire.
 *
 * `SendHandoffInputSchema` is `.strict()` and holds exactly
 * `{clientMutationId, sourceEntityId}`. The CLI syntax in the grammar redesign
 * (and therefore in the discovery projection that renders it) offers
 * `[--expect-source-version <n>]`, but the frozen contract — which outranks both
 * — has no field to put it in.
 *
 * Sending it anyway would be a guaranteed `invalid_input`. Accepting it and
 * DROPPING it would be far worse: the caller asked for a guard that makes the
 * projection refuse a moved target, and would go on believing they had one. So
 * the command stops and names the conflict. This is an amendment item, not a
 * local preference.
 */
function refuseSourceVersionGuard(cmd: CommandContext): void {
  if (cmd.options.value('expect-source-version') === undefined) return;
  throw new CliError(
    'tm8 handoff send cannot carry --expect-source-version: the frozen SendHandoffInput is strict ' +
      'and has no field for a source-version guard, so this CLI can neither send it nor pretend it applied it',
    EXIT_USAGE,
    { hint: 'the guard is an open amendment item; re-read the source entity and send without it, knowingly' },
  );
}

async function handoffSend(cmd: CommandContext): Promise<ExitCode> {
  const workSessionId = requireArg(cmd.args[0], 'a <work-session-id>', 'handoff send');
  refuseSourceVersionGuard(cmd);
  const sourceEntityId = cmd.options.value('entity');
  if (sourceEntityId === undefined) {
    throw new CliError('tm8 handoff send requires --entity <source-entity-id>', EXIT_USAGE, {
      hint: 'an entity projection is a handoff, not a message attachment',
    });
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'handoffs.send', {
    params: { workSessionId },
    // Strict input: exactly these two fields. The id IS the handoff id.
    body: {
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
      sourceEntityId,
    },
  });
  cmd.out.data(data, renderHandoff);
  return EXIT_OK;
}

async function handoffList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('handoff list', cmd.options.value('mutation-id'));
  const workSessionId = requireArg(cmd.args[0], 'a <work-session-id>', 'handoff list');
  const limit = cmd.options.integer('limit');

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'handoffs.list', {
    params: { workSessionId },
    query: {
      limit: limit === undefined ? undefined : String(limit),
      cursor: cmd.options.value('cursor'),
    },
  });
  cmd.out.data(data, renderHandoffPage);
  return EXIT_OK;
}

/**
 * CONFLICT 2 — resolved the OPPOSITE way from conflict 1, and the asymmetry is
 * the whole principle rather than an inconsistency.
 *
 * `WithdrawHandoffInputSchema` is strict and requires
 * `expectedRecordVersion: z.number().int().positive()`. A REQUIRED frozen field
 * is not optional to send: omit it and every call is refused as
 * `invalid_input`, which does not make the guard absent — it makes the
 * operation DEAD. So the capability is frozen and adopted, and the only thing
 * genuinely unspecified was the CLI FLAG NAME.
 *
 * The flag surface belongs to this CLI, so the name is DERIVED rather than
 * invented: kebab-case the frozen field and drop nothing —
 * `expectedRecordVersion` → `--expect-record-version`. The same derivation
 * reproduces `--expect-version` from `expectedVersion` everywhere else in this
 * module, which is what makes it a rule rather than a special case.
 *
 * Contrast conflict 1: there the SCHEMA has no field, so the flag is a promise
 * with no wire destination and is refused. Here the schema has the field and
 * the caller had no way to fill it, so the flag is supplied. Neither case
 * fabricates a value, and neither drops something the caller asked for.
 */
async function handoffWithdraw(cmd: CommandContext): Promise<ExitCode> {
  const handoffId = requireArg(cmd.args[0], 'a <handoff-id>', 'handoff withdraw');
  if (!cmd.options.bool('yes')) {
    throw new CliError(
      'tm8 handoff withdraw requires --yes: it revokes a projection already sent into a session',
      EXIT_USAGE,
    );
  }
  const expectedRecordVersion = cmd.options.integer('expect-record-version');
  if (expectedRecordVersion === undefined) {
    throw new CliError('tm8 handoff withdraw requires --expect-record-version <n>', EXIT_USAGE, {
      hint: 'read the handoff first with `tm8 handoff list <work-session-id>`; the frozen input requires the guard',
    });
  }
  const reasonSource = cmd.options.value('reason');

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    expectedRecordVersion,
  };
  if (reasonSource !== undefined) body.reason = await readTextSource(reasonSource);

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'handoffs.withdraw', {
    params: { handoffId },
    body,
  });
  cmd.out.data(data, renderHandoff);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Human views — the same DTO `--format json` emits. BOTH status axes are always
// rendered: `deliveryStatus` alone cannot answer whether a handoff was recorded,
// and `recordStatus` alone cannot answer whether it reached the session.
// ---------------------------------------------------------------------------

interface HandoffRow {
  handoffId?: unknown;
  deliveryStatus?: unknown;
  recordStatus?: unknown;
  sourceEntityId?: unknown;
  sourceMissing?: unknown;
}

function renderHandoffRow(row: HandoffRow): string {
  const parts = [
    String(row.handoffId ?? ''),
    String(row.deliveryStatus ?? ''),
    String(row.recordStatus ?? ''),
  ].filter((p) => p.length > 0);
  if (row.sourceMissing === true) parts.push('source-missing');
  return parts.join('  ');
}

function renderHandoff(dto: unknown): string {
  const line = renderHandoffRow((dto ?? {}) as HandoffRow);
  return line.length > 0 ? line : JSON.stringify(dto);
}

function renderHandoffPage(dto: unknown): string {
  const items = (dto as { items?: unknown })?.items;
  const rows = Array.isArray(items) ? (items as HandoffRow[]) : [];
  if (rows.length === 0) return 'no handoffs';
  const lines = rows.map(renderHandoffRow);
  const next = (dto as { nextCursor?: unknown })?.nextCursor;
  if (typeof next === 'string' && next) lines.push(`next cursor: ${next}`);
  return lines.join('\n');
}

export const HANDOFF_COMMANDS: CommandModule[] = [
  { path: ['handoff', 'send'], run: handoffSend },
  { path: ['handoff', 'list'], run: handoffList },
  { path: ['handoff', 'withdraw'], run: handoffWithdraw },
];
