/**
 * `tm8 message list|send|reply|update|delete|attachment add|attachment remove|delivery`
 * — the durable communication surface (§4.7).
 *
 * MESSAGE SEND IS THE ONLY PUBLIC COMMUNICATION ACTION FOR TEXT. There is no
 * prompt command, no report command, no progress command, and no compatibility
 * alias for the retired ones — `run.ts` fails those by name and points here. A
 * work session is addressed like any other anchor, because the design law is
 * persistence first and delivery second: the message is STORED, and only then
 * is a live delivery attempted.
 *
 * FOUR THINGS THIS FILE IS CAREFUL ABOUT, each of which has a specific failure
 * it exists to prevent:
 *
 *  1. `message delete` IS A REDACTION. The body becomes `[redacted]`, mentions
 *     and attachments are cleared, `redacted_at` is set — and the row stays in
 *     the thread, so replies, ordering, and cursors are unaffected. Rendering
 *     that transition as a deletion tells an operator their history is gone when
 *     it is not, which invites a destructive recovery against data that was
 *     never lost.
 *
 *  2. STORED AND SETTLED ARE DIFFERENT FACTS. `--wait settled` observes delivery
 *     outcomes; it never changes persistence and never retries delivery. Exit 11
 *     therefore means "stored, delivery incomplete" — NOT "failed" — and the
 *     stored batch is still written to stdout when it is raised. A caller who
 *     reads 11 as a write failure and resends produces a duplicate message.
 *
 *  3. `clientMutationId` IS A CORRELATION IDENTIFIER. `messageBatchId` equals it
 *     by design and it is published in read DTOs. It is not a capability, and no
 *     decision anywhere may rest on anyone not knowing it.
 *
 *  4. `message mark-read` IS NOT REGISTERED HERE. `readMarks.upsert` is
 *     per-member read state and belongs to the group that owns that seam. It
 *     sits under this noun, which is exactly why it is named here: `registry.ts`
 *     throws at IMPORT on a duplicate path, so registering it twice would not
 *     fail one test, it would collapse the whole command surface.
 *
 * TWO PLACES WHERE THE AUTHORITIES DISAGREE are handled explicitly and reported
 * for arbitration rather than normalised away — see `refuseMentionEdit` and the
 * `--order` note on `messageList`.
 */
import { plainExcerpt } from '@tm8/contract';
import { readTextSource } from '../args.js';
import { UnsettledDeliveryError } from '../errors.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { Tm8Client } from '../client.js';
import type { CommandContext, CommandModule } from '../run.js';

// ---------------------------------------------------------------------------
// Shared argument handling
// ---------------------------------------------------------------------------

/**
 * §3 closes `--order` to two values, so a typo is caught here rather than
 * becoming a query parameter the node quietly ignores while the caller believes
 * they asked for something.
 */
function parseOrder(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'oldest' && raw !== 'newest') {
    throw new CliError(`--order expects oldest|newest, got ${JSON.stringify(raw)}`, EXIT_USAGE);
  }
  return raw;
}

const WAIT_MODES = ['stored', 'settled'] as const;
export type WaitMode = (typeof WAIT_MODES)[number];

export function parseWait(raw: string | undefined): WaitMode {
  if (raw === undefined) return 'stored';
  const found = WAIT_MODES.find((m) => m === raw);
  if (!found) {
    throw new CliError(`--wait expects stored|settled, got ${JSON.stringify(raw)}`, EXIT_USAGE);
  }
  return found;
}

function requireArg(raw: string | undefined, what: string, syntax: string): string {
  if (raw === undefined || raw.length === 0) {
    throw new CliError(`tm8 ${syntax} requires ${what}`, EXIT_USAGE);
  }
  return raw;
}

function requireExpectedVersion(cmd: CommandContext, syntax: string): number {
  const version = cmd.options.integer('expect-version');
  if (version === undefined) {
    throw new CliError(`tm8 ${syntax} requires --expect-version <n>`, EXIT_USAGE, {
      hint: 'read the current version first; a guard you did not supply is a guard you do not have',
    });
  }
  return version;
}

/** §7.5 — a destructive operation is never inferred from context. */
function requireConfirmation(cmd: CommandContext, syntax: string, consequence: string): void {
  if (!cmd.options.bool('yes')) {
    throw new CliError(`tm8 ${syntax} requires --yes: ${consequence}`, EXIT_USAGE);
  }
}

/**
 * `[<body>|-]` positional XOR `--body <text-source>`, else piped stdin, else a
 * usage error.
 *
 * The POSITIONAL is a literal body or the bare `-`; it is deliberately NOT run
 * through the `@path` source grammar, because a body that legitimately begins
 * with `@` is ordinary prose and reading it as a filename would be a silent
 * misinterpretation of the caller's text. `--body` is the full text-source.
 *
 * Bytes are passed through verbatim — no trimming. The Server's idempotency
 * identity hashes the EXACT body bytes, so normalising them here would change
 * the mutation identity of a retry.
 */
export async function resolveBody(
  positional: string | undefined,
  flag: string | undefined,
  syntax: string,
): Promise<string> {
  if (positional !== undefined && flag !== undefined) {
    throw new CliError(
      `tm8 ${syntax}: a positional body and --body are mutually exclusive`,
      EXIT_USAGE,
    );
  }
  let body: string;
  if (positional === '-') body = await readTextSource('-');
  else if (positional !== undefined) body = positional;
  else if (flag !== undefined) body = await readTextSource(flag);
  else if (process.stdin.isTTY) {
    // A terminal with no body is a usage error: nothing opens an editor the
    // caller did not ask for, and nothing blocks a session on a read that will
    // never receive anything.
    throw new CliError(`tm8 ${syntax} requires a body`, EXIT_USAGE, {
      hint: 'pass it positionally, with --body <text-source>, or pipe it and use `-`',
    });
  } else body = await readTextSource('-');

  if (body.length === 0) throw new CliError(`tm8 ${syntax}: the body is empty`, EXIT_USAGE);
  return body;
}

/** Repeatable id flags collapse duplicates, PRESERVING first-occurrence order. */
export function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * `--order` is carried through as a catalog query parameter. Whether a given
 * node honours it is a per-NODE fact this CLI does not assert: encoding a claim
 * about one node's ordering behaviour into the client would be exactly the
 * proxy-for-property error the availability rules exist to prevent. The
 * behaviour is measured in the integration suite and reported.
 */
async function messageList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('message list', cmd.options.value('mutation-id'));
  const positionalAnchor = cmd.args[0];
  const flaggedAnchor = cmd.options.value('for');
  if (positionalAnchor !== undefined && flaggedAnchor !== undefined) {
    throw new CliError(
      '`tm8 message list` accepts its anchor either positionally or with --for, not both',
      EXIT_USAGE,
    );
  }
  const anchorId = requireArg(
    positionalAnchor ?? flaggedAnchor,
    'an <anchor-entity-id> or --for <anchor-entity-id>',
    'message list',
  );
  const limit = cmd.options.integer('limit');

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'messages.list', {
    params: { anchorId },
    query: {
      rootMessageId: cmd.options.value('root'),
      order: parseOrder(cmd.options.value('order')),
      limit: limit === undefined ? undefined : String(limit),
      cursor: cmd.options.value('cursor'),
    },
  });
  cmd.out.data(data, renderMessagePage);
  return EXIT_OK;
}

async function messageDelivery(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('message delivery', cmd.options.value('mutation-id'));
  const messageId = requireArg(cmd.args[0], 'a <message-id>', 'message delivery');

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'messages.delivery.get', {
    params: { messageId },
  });
  cmd.out.data(data, renderDelivery);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// message send, and the settle observation behind exit 11
// ---------------------------------------------------------------------------

interface DeliveryRecord {
  deliveryId?: unknown;
  messageId?: unknown;
  targetWorkSessionId?: unknown;
  status?: unknown;
  settledAt?: unknown;
}

/**
 * Has this delivery row reached an outcome that can no longer change?
 *
 * ⚠ CORRECTING A WRONG COMMENT THAT STOOD HERE. This used to be an allowlist of
 * "terminal" status names that deliberately EXCLUDED `failed_retryable`, on the
 * stated reasoning that "the attempt failed but the delivery has not finished".
 * That reasoning is plausible and it is WRONG, and the authority is the CHECK
 * constraint rather than the status name —
 * `session_message_deliveries_state_shape`, `015_w1_foundations.sql`:
 *
 *     UNSETTLED = exactly {pending, dispatching}   (settled_at IS NULL)
 *     SETTLED   = delivered, failed_retryable, failed_permanent,
 *                 unknown, expired, cancelled     (settled_at IS NOT NULL)
 *
 * `failed_retryable` STAMPS `settled_at`: it is TERMINAL FOR THAT ROW.
 * "Retryable" describes the MESSAGE, not the row — a retry is a NEW
 * `delivery_id` with `attempt_no + 1`, never a revisit of this one. The old set
 * also omitted `unknown` for the same reason. The live cost was not a wrong exit
 * code but a FALSE DIAGNOSTIC: the loop polled an already-settled row until the
 * `--timeout` budget expired and then reported that it had expired "before they
 * settled", when the Server had answered immediately. In a PTY that sentence
 * lands in an agent's context.
 *
 * So settlement is keyed on `settledAt` — `MessageDeliveryRecord.settledAt` is
 * `string | null` on the frozen wire — and NOT on a status allowlist. Two
 * reasons, and the second is the one that matters: the partition is enforced by
 * a CHECK constraint so `settledAt` cannot drift from the status, and an
 * allowlist has to KNOW that `failed_retryable` is terminal-for-this-row, which
 * is exactly the confusion that produced this defect. `settledAt` is
 * structurally incapable of making that mistake.
 *
 * A record that omits the field entirely is treated as NOT settled: the node did
 * not answer the question, so the honest behaviour is to keep observing and let
 * the budget report a genuine timeout, rather than to invent a verdict.
 */
function isSettled(record: DeliveryRecord): boolean {
  return typeof record.settledAt === 'string' && record.settledAt.length > 0;
}

const DELIVERED = 'delivered';

async function deliveriesOf(
  client: Tm8Client,
  messageId: string,
): Promise<{ messageId: string; records: DeliveryRecord[] }> {
  const view = await observedInvoke<{ deliveries?: unknown }>(client, 'messages.delivery.get', {
    params: { messageId },
  });
  const records = Array.isArray(view?.deliveries) ? (view.deliveries as DeliveryRecord[]) : [];
  return { messageId, records };
}

function describe(messageId: string, record: DeliveryRecord): string {
  const target = record.targetWorkSessionId === undefined ? '' : ` -> ${String(record.targetWorkSessionId)}`;
  return `${messageId}${target}: ${String(record.status ?? 'unknown')}`;
}

/**
 * `--wait settled`. Observes each stored message's delivery rows until every one
 * of them is SETTLED — `settledAt` stamped, see `isSettled` — or the
 * `--timeout <seconds>` budget runs out.
 *
 * Exit 11 is a DISJUNCTION and non-delivered is the FIRST disjunct: a settled
 * row whose status is anything other than `delivered` is an outcome, not a
 * wait. The timeout is the second disjunct, and the diagnostic says so only
 * when it actually happened.
 *
 * This NEVER retries a delivery and never writes anything: it reads
 * `messages.delivery.get`, which is the operation whose whole purpose is to
 * answer "what happened to the delivery of a message that is already stored".
 *
 * A message with no delivery rows has nothing to settle — a durable message to
 * a non-session anchor requests no live delivery — and contributes no outcome.
 */
async function waitForSettlement(
  cmd: CommandContext,
  client: Tm8Client,
  messageIds: readonly string[],
): Promise<{ outcomes: string[]; undelivered: string[]; timedOut: boolean }> {
  const budgetMs = cmd.ctx.timeoutMs ?? 15_000;
  const deadline = Date.now() + budgetMs;
  let observed: { messageId: string; records: DeliveryRecord[] }[] = [];
  let timedOut = false;

  for (;;) {
    observed = await Promise.all(messageIds.map((id) => deliveriesOf(client, id)));
    const pending = observed.some((o) => o.records.some((r) => !isSettled(r)));
    if (!pending) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  }

  const outcomes: string[] = [];
  const undelivered: string[] = [];
  for (const { messageId, records } of observed) {
    for (const record of records) {
      const line = describe(messageId, record);
      outcomes.push(line);
      if (String(record.status) !== DELIVERED) undelivered.push(line);
    }
  }
  return { outcomes, undelivered, timedOut };
}

async function messageSend(cmd: CommandContext): Promise<ExitCode> {
  const anchorIds = uniqueInOrder(cmd.options.values('to'));
  if (anchorIds.length === 0) {
    throw new CliError('tm8 message send requires at least one --to <anchor-entity-id>', EXIT_USAGE, {
      hint: 'a work session is addressed like any other anchor',
    });
  }
  const wait = parseWait(cmd.options.value('wait'));
  const body = await resolveBody(cmd.args[0], cmd.options.value('body'), 'message send');
  const conversationAnchorId = cmd.options.value('conversation');
  if (anchorIds.length > 1 && !conversationAnchorId) {
    throw new CliError(
      'tm8 message send with more than one --to requires --conversation <anchor-entity-id>',
      EXIT_USAGE,
      { hint: 'name the place this conversation came from; reply routing never guesses from --to order' },
    );
  }
  if (conversationAnchorId && !anchorIds.includes(conversationAnchorId)) {
    throw new CliError('--conversation must also appear as a --to anchor', EXIT_USAGE);
  }

  const request: Record<string, unknown> = {
    anchorIds,
    body,
    // `messageBatchId` equals this value by design — it is how a caller
    // correlates a retry with the batch it already created.
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (conversationAnchorId) request.conversationAnchorId = conversationAnchorId;
  const mentionIds = uniqueInOrder(cmd.options.values('mention'));
  const attachmentIds = uniqueInOrder(cmd.options.values('attach'));
  if (mentionIds.length > 0) request.mentionIds = mentionIds;
  if (attachmentIds.length > 0) request.attachmentIds = attachmentIds;
  const replyTo = cmd.options.value('reply-to');
  if (replyTo) request.parentMessageId = replyTo;
  if (cmd.ctx.actor) request.actorId = cmd.ctx.actor.value;
  if (cmd.ctx.sessionId) request.workSessionId = cmd.ctx.sessionId;

  return postMessage(cmd, request, wait);
}

async function messageReply(cmd: CommandContext): Promise<ExitCode> {
  const messageId = requireArg(cmd.args[0], 'a <message-id>', 'message reply');
  if (cmd.options.values('to').length > 0 || cmd.options.value('conversation')) {
    throw new CliError(
      'tm8 message reply derives its anchor and thread from <message-id>; do not pass --to or --conversation',
      EXIT_USAGE,
    );
  }
  const wait = parseWait(cmd.options.value('wait'));
  const body = await resolveBody(cmd.args[1], cmd.options.value('body'), 'message reply');
  const request: Record<string, unknown> = {
    replyToMessageId: messageId,
    body,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const mentionIds = uniqueInOrder(cmd.options.values('mention'));
  const attachmentIds = uniqueInOrder(cmd.options.values('attach'));
  if (mentionIds.length > 0) request.mentionIds = mentionIds;
  if (attachmentIds.length > 0) request.attachmentIds = attachmentIds;
  if (cmd.ctx.actor) request.actorId = cmd.ctx.actor.value;
  return postMessage(cmd, request, wait);
}

export async function postMessage(
  cmd: CommandContext,
  request: Record<string, unknown>,
  wait: WaitMode,
): Promise<ExitCode> {
  const client = clientFor(cmd.ctx);
  const batch = await observedInvoke<{ messages?: unknown }>(client, 'messages.post', {
    body: request,
  });

  // The batch is the command's DATA and is written BEFORE any settle
  // observation, so a caller who reads stdout gets the stored result whatever
  // the delivery outcome turns out to be.
  cmd.out.data(batch, renderBatch);
  if (wait === 'stored') return EXIT_OK;

  const messageIds = (Array.isArray(batch?.messages) ? batch.messages : [])
    .map((m) => (m as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string');

  const { outcomes, undelivered, timedOut } = await waitForSettlement(cmd, client, messageIds);
  for (const outcome of outcomes) cmd.out.note(`delivery ${outcome}`);
  if (undelivered.length === 0) return EXIT_OK;

  throw new UnsettledDeliveryError(
    `--wait settled: the batch is STORED, but ${undelivered.length} of ${outcomes.length} ` +
      `requested deliveries did not deliver: ${undelivered.join('; ')}` +
      (timedOut ? ' (the --timeout <seconds> budget expired before they settled)' : ''),
    batch,
    outcomes,
  );
}

// ---------------------------------------------------------------------------
// Versioned mutations
// ---------------------------------------------------------------------------

/**
 * `PatchMessageInputSchema.mentions` is `Mention[]` — `{entityId, kind,
 * display}` — while `--mention` supplies an id and nothing else, and `kind` and
 * `display` are facts the Server derives. Honouring the flag would mean
 * FABRICATING two Server-owned fields; dropping it silently would mean a caller
 * believing they changed the mentions of a message when they did not. So the
 * command stops and names the conflict, which is an open amendment item.
 */
function refuseMentionEdit(cmd: CommandContext): void {
  if (cmd.options.values('mention').length === 0) return;
  throw new CliError(
    'tm8 message update cannot carry --mention: the frozen PatchMessageInput takes full ' +
      'Mention objects (entityId, kind, display) and this CLI holds only an id — ' +
      'kind and display are Server-derived and will not be invented here',
    EXIT_USAGE,
    { hint: 'the mention-by-id spelling for an EDIT is an open amendment item; `message send` takes --mention today' },
  );
}

async function messageUpdate(cmd: CommandContext): Promise<ExitCode> {
  const messageId = requireArg(cmd.args[0], 'a <message-id>', 'message update');
  refuseMentionEdit(cmd);
  const expectedVersion = requireExpectedVersion(cmd, 'message update');
  const body = await resolveBody(cmd.args[1], cmd.options.value('body'), 'message update');

  const request: Record<string, unknown> = {
    body,
    expectedVersion,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) request.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'messages.edit', {
    params: { id: messageId },
    body: request,
  });
  cmd.out.data(data, renderMessage);
  return EXIT_OK;
}

/**
 * A REDACTION under a version guard. Every word rendered by this command is
 * chosen so that an operator reading it does not conclude the thread lost
 * anything: the row survives, the ordering survives, the replies survive.
 */
async function messageDelete(cmd: CommandContext): Promise<ExitCode> {
  const messageId = requireArg(cmd.args[0], 'a <message-id>', 'message delete');
  requireConfirmation(
    cmd,
    'message delete',
    'it redacts the message body and clears its mentions and attachments',
  );
  const expectedVersion = requireExpectedVersion(cmd, 'message delete');

  const request: Record<string, unknown> = {
    expectedVersion,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) request.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'messages.delete', {
    params: { id: messageId },
    body: request,
  });
  cmd.out.data(data, renderRedaction);
  cmd.out.note(
    `redacted ${messageId}: the body reads [redacted] and its mentions and attachments are cleared. ` +
      'The row stays in the thread, so replies, ordering, and cursors are unaffected.',
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * `AddMessageAttachmentsInput` and its remove twin are `.strict()` and — unlike
 * every other message input here — do NOT carry the command-context shape, so
 * no `actorId` goes on the wire even when `--as` is set. An unknown key is an
 * `invalid_input`, and one added out of symmetry would be a self-inflicted one.
 *
 * These two commands are the ONLY mutation path for message-owned `attached_to`
 * edges; the generic edge commands cannot touch them.
 */
async function attachmentMutation(
  cmd: CommandContext,
  operation: 'messages.attachments.add' | 'messages.attachments.remove',
  syntax: string,
): Promise<ExitCode> {
  const messageId = requireArg(cmd.args[0], 'a <message-id>', syntax);
  const fileEntityIds = uniqueInOrder(cmd.args.slice(1));
  if (fileEntityIds.length === 0) {
    throw new CliError(`tm8 ${syntax} requires at least one <file-entity-id>`, EXIT_USAGE);
  }
  const expectedVersion = requireExpectedVersion(cmd, syntax);

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), operation, {
    params: { messageId },
    body: {
      fileEntityIds,
      expectedVersion,
      clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    },
  });
  cmd.out.data(data, renderMessage);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Human views — renderings of the SAME DTO `--format json` emits, never a
// second shape and never a superset. Any id a follow-up command needs stays.
// ---------------------------------------------------------------------------

function idOf(value: unknown): string {
  return String((value as { id?: unknown })?.id ?? '');
}

/**
 * The one-line body preview `message list` shows per row.
 *
 * 72 chars, and they are spent on WORDS: `plainExcerpt` strips markdown before
 * truncating. The server's 200-char `EntitySummary.excerpt` shares that helper.
 * The two caps differ because the surfaces do; the stripping rule must not,
 * which is why it lives in `@tm8/contract` rather than twice, here and there.
 */
function bodyExcerpt(value: unknown): string {
  const content = (value as { content?: { body?: unknown } })?.content;
  const body = typeof content?.body === 'string' ? content.body : '';
  return plainExcerpt(body, 72);
}

export function renderMessagePage(dto: unknown): string {
  const items = (dto as { items?: unknown })?.items;
  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0) return 'no messages';
  const lines = rows.map((row) => {
    const replies = (row as { replyCount?: unknown }).replyCount;
    const count = typeof replies === 'number' && replies > 0 ? `  (${replies} replies)` : '';
    return `${idOf(row)}  ${bodyExcerpt(row)}${count}`.trimEnd();
  });
  const next = (dto as { nextCursor?: unknown })?.nextCursor;
  if (typeof next === 'string' && next) lines.push(`next cursor: ${next}`);
  return lines.join('\n');
}

function renderMessage(dto: unknown): string {
  const id = idOf(dto);
  return id || JSON.stringify(dto);
}

function renderRedaction(dto: unknown): string {
  const id = idOf(dto);
  const at = (dto as { redactedAt?: unknown })?.redactedAt;
  return typeof at === 'string' && at ? `${id}  redacted at ${at}` : `${id}  redacted`;
}

function renderBatch(dto: unknown): string {
  const batchId = (dto as { messageBatchId?: unknown })?.messageBatchId;
  const messages = (dto as { messages?: unknown })?.messages;
  const rows = Array.isArray(messages) ? messages : [];
  const lines = [`batch ${String(batchId ?? '')}`.trimEnd()];
  for (const row of rows) {
    // `pending` is the Server's own field: a live delivery has been reserved and
    // has not settled. It is a delivery fact, and never a storage one.
    const pending = (row as { pending?: unknown }).pending === true ? '  delivery: pending' : '';
    lines.push(`${idOf(row)}${pending}`);
  }

  // THE LINE THAT USED TO BE MISSING. Without it, `tm8 message send --to
  // <sessionId>` printed a batch id and exited 0 whether the steer reached the
  // worker's terminal or was refused before a single durable row existed — and
  // on 2026-08-21 it was the latter, twice, with nothing on stdout to say so.
  // Storage and delivery stay separate facts: the batch line above is still
  // the stored one, and this is only ever about the live copy.
  const delivery = (dto as { delivery?: unknown })?.delivery;
  for (const entry of Array.isArray(delivery) ? delivery : []) {
    const row = entry as { targetWorkSessionId?: unknown; status?: unknown; reason?: unknown };
    const status = String(row.status ?? 'unknown');
    const reason = typeof row.reason === 'string' ? ` (${row.reason})` : '';
    // `undelivered` is called out rather than merely listed: it is the one
    // value a caller must not skim past.
    const label = status === 'undelivered' ? 'NOT DELIVERED' : status;
    lines.push(`  ${String(row.targetWorkSessionId ?? '')}  ${label}${reason}`.trimEnd());
  }
  return lines.join('\n');
}

export function renderDelivery(dto: unknown): string {
  const message = (dto as { message?: unknown })?.message;
  const deliveries = (dto as { deliveries?: unknown })?.deliveries;
  const rows = Array.isArray(deliveries) ? (deliveries as DeliveryRecord[]) : [];
  // Storage and delivery are different facts, and the stored one is stated
  // first: a pending delivery is not a message that went missing.
  const lines = [`${idOf(message)}  stored`];
  if (rows.length === 0) lines.push('  no live delivery was requested for this message');
  for (const row of rows) {
    lines.push(`  ${String(row.targetWorkSessionId ?? '')}  ${String(row.status ?? 'unknown')}`.trimEnd());
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

/**
 * The module's registration. NOTE the absence of `message mark-read`: that path
 * is `readMarks.upsert` and belongs to the per-member read-state group.
 */
export const MESSAGE_COMMANDS: CommandModule[] = [
  { path: ['message', 'list'], run: messageList },
  { path: ['message', 'send'], run: messageSend },
  { path: ['message', 'reply'], run: messageReply },
  { path: ['message', 'update'], run: messageUpdate },
  { path: ['message', 'delete'], run: messageDelete },
  {
    path: ['message', 'attachment', 'add'],
    run: (cmd) => attachmentMutation(cmd, 'messages.attachments.add', 'message attachment add'),
  },
  {
    path: ['message', 'attachment', 'remove'],
    run: (cmd) => attachmentMutation(cmd, 'messages.attachments.remove', 'message attachment remove'),
  },
  { path: ['message', 'delivery'], run: messageDelivery },
];
