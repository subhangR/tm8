import { createHash } from 'node:crypto';

import {
  CollabError,
  CommandContextSchema,
  InboxListQuerySchema,
  InboxMarkReadInputSchema,
  decodeCursor,
  encodeCursor,
  type ActorSummary,
  type CommandContext,
  type InboxListQuery,
  type InboxMarkReadInput,
  type InboxRecipient,
  type NotificationItem,
  type Page,
} from '@tm8/contract';

import type { Querier } from '../../../db/types.js';
import type { RequestContext } from '../../../http/types.js';
import { claimsFor, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import {
  MICROS,
  actorOf,
  iso,
  loadActors,
  loadEntitySummariesByIds,
} from '../../entity-read.js';

interface NotificationRow {
  id: string;
  space_id: string;
  recipient_member_id: string;
  recipient_team_member_id: string | null;
  target_entity_id: string | null;
  actor_id: string | null;
  kind: string;
  payload: Record<string, unknown> | null;
  read_at: Date | string | null;
  created_at: Date | string;
  /**
   * The keyset value, as microsecond TEXT straight from Postgres. REQUIRED, and
   * `string` not `Date | string`: a `timestamptz` returned as a JavaScript
   * `Date` keeps only milliseconds, and on this DESC keyset a truncated cursor
   * SILENTLY SKIPS every row sharing the lost millisecond rather than looping.
   *
   * ⚠ DECLARING IT REQUIRED DOES **NOT** MAKE A FORGOTTEN `to_char` A COMPILE
   * ERROR. This comment said it did, and it was wrong in the one file that
   * proved it: `Querier.query<R>` (db/types.ts:45) takes `R` as an UNCHECKED
   * CALLER ASSERTION and never sees the SELECT list, so a query that omits this
   * column typechecks clean and yields `undefined` here. `queryInbox` shipped
   * exactly that, and `encodeCursor` turned the missing slot into a JSON `null`
   * that this file's own `decodeListCursor` (:173) then rejected — the server
   * handing out a cursor it would not accept. Only an OBJECT-LITERAL producer
   * is checked; every producer of this row is raw SQL.
   *
   * SO THE INVARIANT IS HELD BY THE PRODUCERS, NOT BY THE COMPILER, AND THERE
   * ARE EXACTLY TWO: `directInboxSql` (:243) and `queryInbox` (:272). A THIRD
   * ONE IS A DECISION, NOT AN OVERSIGHT — give it `MICROS(...)` or give this
   * type a runtime refusal at the mint, the way `sortKeyOf`
   * (handlers/collections.ts:192-203) refuses rather than trusting its callers.
   */
  cursor_created_at: string;
}

interface RecipientAuthorizationRow {
  authorized: boolean;
}

interface ReadMarkResult {
  anchorId: string;
  lastReadAt: string;
  patches: unknown[];
}

interface NormalizedListQuery {
  recipient: InboxRecipient | null;
  spaceId: string | null;
  unread: boolean | null;
  cursor: string | null;
  limit: number;
}

interface CursorKey {
  createdAt: string;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUERY_KEYS = new Set(['recipient', 'spaceId', 'unread', 'cursor', 'limit']);
const DEFAULT_LIMIT = 50;

function invalidInput(message: string): never {
  throw new CollabError('invalid_input', message);
}

function notFound(): never {
  throw new CollabError('not_found', 'inbox recipient not found');
}

function requireUuid(value: string, field: string): string {
  if (!UUID_RE.test(value)) invalidInput(`${field} must be a uuid`);
  return value;
}

function parseBody<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) invalidInput('request body does not match the operation schema');
  return parsed.data;
}

function normalizeListQuery(search: URLSearchParams): NormalizedListQuery {
  for (const key of search.keys()) {
    if (!QUERY_KEYS.has(key)) invalidInput(`unknown inbox query field: ${key}`);
  }

  let recipient: unknown;
  const rawRecipient = search.get('recipient');
  if (rawRecipient !== null) {
    try {
      recipient = JSON.parse(rawRecipient);
    } catch {
      invalidInput('recipient must be the encoded discriminated recipient object');
    }
  }

  let unread: boolean | undefined;
  const rawUnread = search.get('unread');
  if (rawUnread !== null) {
    if (rawUnread !== 'true' && rawUnread !== 'false') invalidInput('unread must be true or false');
    unread = rawUnread === 'true';
  }

  let limit: number | undefined;
  const rawLimit = search.get('limit');
  if (rawLimit !== null) {
    limit = Number(rawLimit);
  }

  const candidate: InboxListQuery = {
    ...(recipient === undefined ? {} : { recipient: recipient as InboxRecipient }),
    ...(search.get('spaceId') === null ? {} : { spaceId: search.get('spaceId')! }),
    ...(unread === undefined ? {} : { unread }),
    ...(search.get('cursor') === null ? {} : { cursor: search.get('cursor')! }),
    ...(limit === undefined ? {} : { limit }),
  };
  const parsed = InboxListQuerySchema.safeParse(candidate);
  if (!parsed.success) invalidInput('inbox query does not match the operation schema');
  if (parsed.data.spaceId) requireUuid(parsed.data.spaceId, 'spaceId');
  if (parsed.data.recipient?.type === 'member') {
    requireUuid(parsed.data.recipient.memberId, 'recipient.memberId');
  } else if (parsed.data.recipient?.type === 'team_member') {
    requireUuid(parsed.data.recipient.teamMemberId, 'recipient.teamMemberId');
  }

  return {
    recipient: parsed.data.recipient ?? null,
    spaceId: parsed.data.spaceId ?? null,
    unread: parsed.data.unread ?? null,
    cursor: parsed.data.cursor ?? null,
    limit: parsed.data.limit ?? DEFAULT_LIMIT,
  };
}

function listFingerprint(query: NormalizedListQuery): string {
  const canonical = JSON.stringify({
    operation: 'inbox.list',
    recipient: query.recipient ?? { type: 'member', memberId: 'authenticated' },
    spaceId: query.spaceId,
    unread: query.unread,
    sort: ['createdAt:desc', 'id:desc'],
  });
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
}

function decodeListCursor(cursor: string | null, fingerprint: string): CursorKey | null {
  if (!cursor) return null;
  const decoded = decodeCursor(cursor);
  if (decoded.k.length !== 3 || decoded.k[0] !== fingerprint) {
    throw new CollabError('invalid_cursor', 'inbox cursor does not match this recipient or filter');
  }
  const createdAt = String(decoded.k[1] ?? '');
  const id = String(decoded.k[2] ?? '');
  if (Number.isNaN(Date.parse(createdAt)) || !UUID_RE.test(id)) {
    throw new CollabError('invalid_cursor', 'invalid inbox cursor keyset');
  }
  return { createdAt, id };
}

async function recipientAuthorized(
  q: Querier,
  recipient: InboxRecipient,
): Promise<boolean> {
  const rows = recipient.type === 'member'
    ? await q.query<RecipientAuthorizationRow>(
      `select exists (
         select 1 from public.members member_row
          where member_row.entity_id = $1
            and member_row.identity_id = internal.identity_id()
       ) authorized /* inbox_recipient_authorized */`,
      [recipient.memberId],
    )
    : await q.query<RecipientAuthorizationRow>(
      `select exists (
         select 1
           from public.team_members teammate_row
           join public.entities teammate_entity on teammate_entity.id = teammate_row.entity_id
          where teammate_row.entity_id = $1
            and internal.can_act_as(teammate_row.entity_id, teammate_entity.space_id)
       ) authorized /* inbox_recipient_authorized */`,
      [recipient.teamMemberId],
    );
  return rows[0]?.authorized === true;
}

function directInboxSql(query: NormalizedListQuery, cursor: CursorKey | null): {
  sql: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (query.recipient?.type === 'team_member') {
    where.push(`notification_row.recipient_team_member_id = ${bind(query.recipient.teamMemberId)}::uuid`);
  } else {
    where.push('notification_row.recipient_team_member_id is null');
    if (query.recipient?.type === 'member') {
      where.push(`notification_row.recipient_member_id = ${bind(query.recipient.memberId)}::uuid`);
    } else {
      where.push(`exists (
        select 1 from public.members inbox_member
         where inbox_member.entity_id = notification_row.recipient_member_id
           and inbox_member.identity_id = internal.identity_id()
      )`);
    }
  }
  if (query.spaceId) where.push(`notification_row.space_id = ${bind(query.spaceId)}::uuid`);
  if (query.unread === true) where.push('notification_row.read_at is null');
  if (cursor) {
    where.push(`(notification_row.created_at, notification_row.id) <
      (${bind(cursor.createdAt)}::timestamptz, ${bind(cursor.id)}::uuid)`);
  }

  return {
    sql: `select notification_row.id, notification_row.space_id,
                 notification_row.recipient_member_id,
                 notification_row.recipient_team_member_id,
                 notification_row.target_entity_id, notification_row.actor_id,
                 notification_row.kind, notification_row.payload,
                 notification_row.read_at, notification_row.created_at,
                 ${MICROS('notification_row.created_at')} cursor_created_at
            from public.notifications notification_row
           where ${where.join('\n             and ')}
           order by notification_row.created_at desc, notification_row.id desc
           limit ${query.limit + 1}`,
    params,
  };
}

async function queryInbox(
  q: Querier,
  query: NormalizedListQuery,
  cursor: CursorKey | null,
): Promise<NotificationRow[]> {
  if (query.recipient?.type === 'team_member') {
    return q.query<NotificationRow>(
      // `cursor_created_at` is computed HERE, in the outer select, and not by the
      // function: `inspect_owned_teammate_inbox` is `returns setof
      // public.notifications` (023_w2_inbox.sql:46) and the keyset value is an
      // expression, not a stored column, so it cannot come back from the RPC.
      // Omitting it did not fail to compile — `Querier.query<R>` (db/types.ts:45)
      // takes R as a caller assertion and never sees this SELECT list — it made
      // `page()` mint `[fingerprint, undefined, id]`, which JSON-encodes the slot
      // as null and is then rejected by this file's own `decodeListCursor` (:173)
      // as an invalid keyset. The server handed out a cursor it would not accept.
      `select owned_row.id, owned_row.space_id, owned_row.recipient_member_id,
              owned_row.recipient_team_member_id, owned_row.target_entity_id,
              owned_row.actor_id, owned_row.kind, owned_row.payload,
              owned_row.read_at, owned_row.created_at,
              ${MICROS('owned_row.created_at')} cursor_created_at
         from public.inspect_owned_teammate_inbox($1, $2, $3, $4, $5, $6) owned_row`,
      [
        query.recipient.teamMemberId,
        query.spaceId,
        query.unread,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      ],
    );
  }
  const statement = directInboxSql(query, cursor);
  return q.query<NotificationRow>(statement.sql, statement.params);
}

async function hydrateNotifications(
  q: Querier,
  rows: readonly NotificationRow[],
  viewerIdentityId: string,
): Promise<NotificationItem[]> {
  if (rows.length === 0) return [];
  const recipientIds = rows.map((row) => row.recipient_team_member_id ?? row.recipient_member_id);
  const actors = await loadActors(q, [
    ...recipientIds,
    ...rows.map((row) => row.actor_id ?? ''),
  ]);
  const targets = await loadEntitySummariesByIds(
    q,
    rows.map((row) => row.target_entity_id ?? ''),
    viewerIdentityId,
  );
  const targetsById = new Map(targets.map((target) => [target.id, target]));

  return rows.map((row) => {
    const recipientId = row.recipient_team_member_id ?? row.recipient_member_id;
    const recipient: ActorSummary = actorOf(actors, recipientId);
    // `payload.message` has never had a writer. Every producer that carries a
    // preview stores it under `excerpt` (003:155 mention, 019:267 mention,
    // 077:156 anchor_message), so reading only `message` meant the inbox
    // preview line rendered for nothing, ever. `message` stays preferred so a
    // future producer can override it. MUST stay in step with the event mapper
    // (`events/mapper.ts`, notification.created/read) — the two assemblers
    // produce the same NotificationItem and a divergence here is intermittent.
    const rawMessage = row.payload?.message ?? row.payload?.excerpt;
    return {
      id: row.id,
      spaceId: row.space_id,
      kind: row.kind,
      ...(row.actor_id === null ? {} : { actor: actorOf(actors, row.actor_id) }),
      ...(row.target_entity_id === null
        ? {}
        : { target: targetsById.get(row.target_entity_id) ?? null }),
      ...(typeof rawMessage === 'string' ? { message: rawMessage } : {}),
      recipient,
      readAt: row.read_at === null ? null : iso(row.read_at),
      createdAt: iso(row.created_at),
    };
  });
}

function selectedRecipient(input: InboxMarkReadInput): InboxRecipient | null {
  if (!input.recipient) return null;
  if (input.recipient.type === 'member') {
    requireUuid(input.recipient.memberId, 'recipient.memberId');
  } else {
    requireUuid(input.recipient.teamMemberId, 'recipient.teamMemberId');
  }
  return input.recipient;
}

export class W2InboxReadMarksService {
  constructor(private readonly deps: FacadeDeps) {}

  readonly list = async (ctx: RequestContext): Promise<Page<NotificationItem>> => {
    const owner = await this.deps.owner();
    const query = normalizeListQuery(ctx.query);
    const fingerprint = listFingerprint(query);
    const cursor = decodeListCursor(query.cursor, fingerprint);
    const isActing = ctx.identity.actorId !== undefined;

    if (query.recipient?.type === 'team_member') {
      const teamMemberId = query.recipient.teamMemberId;
      const actingAsSelected = ctx.identity.actorId === teamMemberId;
      return this.deps.db.tx(
        claimsFor(owner, ctx, actingAsSelected ? { actorId: teamMemberId } : {}),
        async (q) => {
          if (isActing && !actingAsSelected) notFound();
          if (actingAsSelected) {
            if (!await recipientAuthorized(q, query.recipient!)) notFound();
            const statement = directInboxSql(query, cursor);
            const rows = await q.query<NotificationRow>(statement.sql, statement.params);
            return this.page(q, rows, query.limit, fingerprint, owner.identityId);
          }
          const rows = await queryInbox(q, query, cursor);
          return this.page(q, rows, query.limit, fingerprint, owner.identityId);
        },
      );
    }

    if (isActing) notFound();
    return this.deps.db.tx(claimsFor(owner, ctx), async (q) => {
      if (query.recipient && !await recipientAuthorized(q, query.recipient)) notFound();
      const statement = directInboxSql(query, cursor);
      const rows = await q.query<NotificationRow>(statement.sql, statement.params);
      return this.page(q, rows, query.limit, fingerprint, owner.identityId);
    });
  };

  readonly markNotificationRead = async (ctx: RequestContext): Promise<NotificationItem> => {
    const owner = await this.deps.owner();
    const notificationId = requireUuidParam(ctx, 'notificationId');
    const input = parseBody(InboxMarkReadInputSchema, ctx.body);
    const recipient = selectedRecipient(input);
    const isActing = ctx.identity.actorId !== undefined;

    if (recipient?.type === 'team_member') {
      if (ctx.identity.actorId !== recipient.teamMemberId) notFound();
    } else if (isActing) {
      notFound();
    }

    const actorId = recipient?.type === 'team_member' ? recipient.teamMemberId : undefined;
    return this.deps.db.tx(claimsFor(owner, ctx, actorId ? { actorId } : {}), async (q) => {
      if (recipient && !await recipientAuthorized(q, recipient)) notFound();
      const row = await q.rpc<NotificationRow>('mark_notification_read', [
        notificationId,
        recipient?.type ?? 'member',
        recipient?.type === 'member'
          ? recipient.memberId
          : recipient?.type === 'team_member' ? recipient.teamMemberId : null,
        input.clientMutationId,
      ]);
      const [item] = await hydrateNotifications(q, [row], owner.identityId);
      if (!item) throw new CollabError('upstream_unavailable', 'notification mutation returned no row');
      return item;
    });
  };

  readonly upsertReadMark = async (ctx: RequestContext): Promise<ReadMarkResult> => {
    const owner = await this.deps.owner();
    const anchorId = requireUuidParam(ctx, 'anchorId');
    const input = parseBody<CommandContext>(CommandContextSchema, ctx.body);
    if (!input.clientMutationId) invalidInput('clientMutationId is required');
    const actorId = input.actorId ?? ctx.identity.actorId;
    if (actorId) requireUuid(actorId, 'actorId');
    return this.deps.db.tx(claimsFor(owner, ctx, actorId ? { actorId } : {}), (q) =>
      q.rpc<ReadMarkResult>('mark_read', [anchorId, input.clientMutationId!]));
  };

  private async page(
    q: Querier,
    rows: NotificationRow[],
    limit: number,
    fingerprint: string,
    viewerIdentityId: string,
  ): Promise<Page<NotificationItem>> {
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = await hydrateNotifications(q, pageRows, viewerIdentityId);
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor: hasMore && last
        // Carried verbatim — never through a JS Date. See NotificationRow.cursor_created_at.
        ? encodeCursor([fingerprint, last.cursor_created_at, last.id])
        : null,
    };
  }
}
