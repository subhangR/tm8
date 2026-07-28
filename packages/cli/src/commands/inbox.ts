/**
 * `tm8 inbox list|mark-read` and `tm8 message mark-read` — G08 per-member read
 * state (§4.11), projecting `inbox.list`, `inbox.markRead`, `readMarks.upsert`.
 *
 * TWO COMMANDS SAY "MARK READ" AND THEY OWN DIFFERENT STATE:
 *
 *   inbox mark-read <notification-id>  -> inbox.markRead    one notification row
 *   message mark-read <anchor-id>      -> readMarks.upsert  an anchor's read cursor
 *
 * Blurring them costs a caller something real in both directions: a
 * notification that stays lit because the thread was read but the row never
 * was, or a belief that a conversation is caught up because a single
 * notification was dismissed. The projection says the same thing in its own
 * note, and this module keeps them apart in code rather than in prose.
 *
 * WHY `message mark-read` LIVES HERE AND NOT IN THE `message` MODULE. Seam
 * ruling S2: `readMarks.upsert` is G08 per-member read state — composed and
 * W3-PASSED — while the rest of the `message` noun is uncomposed. A noun is not
 * an ownership unit; a module is. `registry.ts` throws at IMPORT on a duplicate
 * path, so exactly one module may carry this path and it is this one.
 *
 * `--through <message-id>` IS NOT IMPLEMENTED, DELIBERATELY. See `messageMarkRead`.
 */
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

/** `--limit <count>`: a count, so zero and negatives are refused before the wire. */
function limitOf(cmd: CommandContext): string | undefined {
  const limit = cmd.options.integer('limit');
  if (limit === undefined) return undefined;
  if (limit <= 0) {
    throw new CliError(`--limit expects a positive count, got ${limit}`, EXIT_USAGE);
  }
  return String(limit);
}

/**
 * `--for <team-member-id>` selects a Teammate feed. `inbox.list` types its
 * `recipient` as a DISCRIMINATED object, JSON-encoded into one query field —
 * not a bare id — so the shape is built here rather than left to the caller.
 *
 * A Member's personal inbox deliberately EXCLUDES rows owned by their
 * Teammates, which is why inspecting a Teammate feed is a separate request
 * rather than a wider one.
 */
function recipientOf(cmd: CommandContext): string | undefined {
  const teamMemberId = cmd.options.value('for');
  if (teamMemberId === undefined) return undefined;
  return JSON.stringify({ type: 'team_member', teamMemberId });
}

async function inboxList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('inbox list', cmd.options.value('mutation-id'));

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'inbox.list', {
    query: {
      spaceId: cmd.ctx.space?.value,
      recipient: recipientOf(cmd),
      // Sent ONLY when asked for. The Server filters on `unread === true`, so an
      // `unread=false` would be a no-op that reads like a filter — and this
      // operation rejects any query key outside its closed set, which makes an
      // unnecessary key pure downside.
      ...(cmd.options.bool('unread') ? { unread: 'true' } : {}),
      limit: limitOf(cmd),
      cursor: cmd.options.value('cursor'),
    },
  });

  cmd.out.data(data, renderNotifications);
  return EXIT_OK;
}

async function inboxMarkRead(cmd: CommandContext): Promise<ExitCode> {
  const notificationId = requireArg(cmd, 0, 'inbox mark-read', '<notification-id>');

  // `InboxMarkReadInputSchema` is `.strict()` and its fields are exactly
  // `clientMutationId` and `recipient` — there is NO `actorId`, unlike every
  // other command in this module. `--as` must therefore not be projected into
  // this body: it would be a hard `invalid_input`, not a harmless extra.
  const body = { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) };

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'inbox.markRead', {
    params: { notificationId },
    body,
  });
  cmd.out.data(data, renderNotification);
  return EXIT_OK;
}

/**
 * `tm8 message mark-read <anchor-entity-id>` — advance an anchor's read cursor.
 *
 * ON `--through <message-id>`, WHICH THIS REFUSES. The flag is
 * AMENDMENT-DEPENDENT, not frozen: the grammar's own §8 extension table lists
 * `message mark-read --through` under "proposed extension / required
 * amendment", §9.2 item 26 is that amendment, and the projection marks this row
 * `input: 'unbound'` — a payload with no frozen schema binding. The wire today
 * is `{actorId?, clientMutationId}` under a `.strict()` schema, and the node's
 * `mark_read(p_anchor_id, p_client_mutation_id)` takes no message id: it marks
 * read AS OF NOW.
 *
 * That leaves exactly two dishonest options and this takes neither. Dropping
 * the flag silently tells a caller they positioned a cursor they did not
 * position. Sending it produces a guaranteed `invalid_input`. Refusing locally
 * costs no round trip and names the amendment the caller is waiting on.
 */
async function messageMarkRead(cmd: CommandContext): Promise<ExitCode> {
  const anchorId = requireArg(cmd, 0, 'message mark-read', '<anchor-entity-id>');

  if (cmd.options.value('through') !== undefined) {
    throw new CliError(
      '--through <message-id> is not implemented: `readMarks.upsert` has no frozen input binding ' +
        'for a read-through message, and this node marks an anchor read AS OF NOW',
      EXIT_USAGE,
      {
        hint:
          'run `tm8 message mark-read <anchor-entity-id>` without --through to advance the cursor to now; ' +
          '--through awaits grammar amendment §9.2 item 26',
      },
    );
  }

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'readMarks.upsert', {
    params: { anchorId },
    body,
  });
  cmd.out.data(data, renderReadMark);
  return EXIT_OK;
}

function requireArg(
  cmd: CommandContext,
  index: number,
  command: string,
  placeholder: string,
): string {
  const value = cmd.args[index];
  if (value === undefined || value.length === 0) {
    throw new CliError(`tm8 ${command} requires ${placeholder}`, EXIT_USAGE);
  }
  return value;
}

interface NotificationRow {
  id?: unknown;
  kind?: unknown;
  readAt?: unknown;
  createdAt?: unknown;
  message?: unknown;
  target?: { title?: unknown } | null;
  actor?: { name?: unknown } | null;
}

/**
 * The human view renders the SAME DTO `--format json` emits, and always keeps
 * the notification id: it is the argument `tm8 inbox mark-read` takes, and an
 * id omitted from human output is a follow-up command the caller cannot write.
 */
function renderNotifications(dto: unknown): string {
  const page = dto as { items?: unknown; nextCursor?: unknown };
  const rows: NotificationRow[] = Array.isArray(page?.items)
    ? (page.items as NotificationRow[])
    : Array.isArray(dto)
      ? (dto as NotificationRow[])
      : [];
  if (rows.length === 0) return 'no notifications';

  const lines = rows.map((row) => notificationLine(row));
  const cursor = page?.nextCursor;
  if (typeof cursor === 'string' && cursor.length > 0) {
    lines.push(`next: --cursor ${cursor}`);
  }
  return lines.join('\n');
}

function notificationLine(row: NotificationRow): string {
  const state = row.readAt === null || row.readAt === undefined ? 'unread' : 'read';
  const subject = row.target?.title ?? row.message ?? '';
  return [
    String(row.id ?? ''),
    state,
    String(row.kind ?? ''),
    String(row.actor?.name ?? ''),
    String(subject),
    String(row.createdAt ?? ''),
  ]
    .filter((part) => part.length > 0)
    .join('  ');
}

function renderNotification(dto: unknown): string {
  return notificationLine((dto ?? {}) as NotificationRow);
}

/**
 * `readMarks.upsert` answers `{anchorId, lastReadAt, patches}`. Rendered as
 * "read as of <time>" rather than "read through <message>", because the cursor
 * this operation sets is a TIMESTAMP and describing it as a message position
 * would promise the `--through` semantics the operation does not have.
 */
function renderReadMark(dto: unknown): string {
  const mark = (dto ?? {}) as { anchorId?: unknown; lastReadAt?: unknown };
  return `${String(mark.anchorId ?? '')} read as of ${String(mark.lastReadAt ?? '')}`.trim();
}

/**
 * Wired into `src/commands/registry.ts` by the coordinator as one import and
 * one spread. Carries the `message mark-read` path per seam ruling S2 — the
 * `message` module must NOT also register it, because a duplicate path throws
 * at import and takes the whole command surface down with it.
 */
export const INBOX_COMMANDS: CommandModule[] = [
  { path: ['inbox', 'list'], run: inboxList },
  { path: ['inbox', 'mark-read'], run: inboxMarkRead },
  { path: ['message', 'mark-read'], run: messageMarkRead },
];
