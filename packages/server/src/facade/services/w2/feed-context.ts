/**
 * W2.G13 — the universal feed (`entities.feed`, dossier A11) and the bounded
 * entity context (`entities.context`, dossier A12).
 *
 * ONE LAW DOMINATES THIS FILE, and it is dossier closure item M1/M3:
 *
 *   **A feed is selected by a VERSIONED NAMED SCOPE, never by a raw predicate
 *   array.**
 *
 * The caller says `scope=session_chat_v1`. It does not — and cannot — say
 * "give me these five predicates", "filter where author_id = …", or hand over
 * anything else that ends up shaping a query. `FEED_SCOPE_PREDICATES` below is
 * the ONLY place a scope becomes predicates, `FEED_VIA_SQL` is the only place a
 * predicate becomes SQL, and neither is reachable from request input except
 * through the closed `FeedScope` enum. That is why the `_v1` suffix is in the
 * wire name: the meaning of a scope is a server-owned, versioned artefact that
 * can be superseded by `…_v2` without a caller ever having depended on its
 * internals.
 *
 * NO CALLER-SUPPLIED STRING REACHES SQL TEXT ON ANY PATH. The scope selects
 * frozen fragments by enum key; the anchor id, the `around` item id and its
 * kind, and both cursor keys are bound as PARAMETERS. `limit` is the one value
 * interpolated into the statement, and it is an integer the contract schema has
 * already constrained to 1..100.
 *
 * The second law is bounded focus (A12): `totalBytes` and `sectionBytes` are
 * HARD caps enforced against the finally-serialised view, not advisory hints on
 * a response that may be any size. A caller that asks for every section still
 * cannot exceed its own budget.
 *
 * Both operations are READS. Every statement runs inside `db.tx` under
 * claim-bound RLS, and there is no `rpc` call in this file at all: a write from
 * a read handler would have to go through an enumerable SECURITY DEFINER RPC,
 * and nothing here should ever want one.
 */
import { createHash } from 'node:crypto';

import {
  CollabError,
  EntityContextQuerySchema,
  EntityFeedQuerySchema,
  decodeCursor,
  encodeCursor,
  type ActivityItem,
  type Cursor,
  type DeliverySummary,
  type EdgeView,
  type EntityContextQuery,
  type EntityContextSection,
  type EntityContextView,
  type EntityFeedPage,
  type EntityFeedQuery,
  type EntitySummary,
  type FeedItem,
  type FeedScope,
  type FeedVia,
  type MessageDeliveryStatus,
  type MessageView,
  type PaletteAction,
} from '@tm8/contract';
import type { ZodTypeAny } from 'zod';

import type { DbClaims, Querier } from '../../../db/types.js';
import type { OperationHandler, RequestContext } from '../../../http/types.js';
import { claimsFor, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import {
  ENTITY_COLUMNS,
  ENTITY_FROM,
  MICROS,
  actorOf,
  assembleSummaries,
  contentOf,
  iso,
  loadActors,
  loadEntitySummariesByIds,
  type EntityRow,
} from '../../entity-read.js';
import { loadMessageViewsByIds } from '../../handlers/messages.js';

// ---------------------------------------------------------------------------
// The versioned named-scope registry — the whole M1/M3 surface
// ---------------------------------------------------------------------------

/**
 * Scope → predicates. Canonical: deduped AND SORTED.
 *
 * Sorted is not cosmetic. The same canonical array feeds BOTH the cursor
 * fingerprint and the SQL assembly, so the two cannot drift into disagreeing
 * about what "this filter" means. `handoffs.list` shipped exactly that bug in
 * the other direction — an insertion-ordered fingerprint over an
 * order-insensitive `= any(...)` — and rejected cursors across a reordered but
 * identical request.
 *
 * `db/migrations/030_w2_feed_context.sql` mirrors this map as
 * `internal.w2_feed_scope_predicates()`, and the PG suite asserts the two agree
 * in BOTH directions: a scope either side gains alone is the drift that hurts.
 */
export const FEED_SCOPE_PREDICATES: Readonly<Record<FeedScope, readonly FeedVia[]>> = Object.freeze({
  /** Anything anchored on, replying under, or recorded about the entity. */
  direct_v1: Object.freeze(['anchored', 'replies', 'subject'] as const),
  /** A work session's chat: its thread, plus what it authored and caused. */
  session_chat_v1: Object.freeze(['anchored', 'authored', 'caused', 'replies'] as const),
  /**
   * A channel read as THREAD ROOTS — `direct_v1` minus `replies`.
   *
   * `direct_v1` unions roots and replies and orders the result by time, which
   * is why a channel reads flat: a reply is drawn wherever it happens to fall
   * in the timeline rather than under the message it answers. Dropping the one
   * predicate is the whole of it — a reply is still stored, still readable, and
   * still reachable through `messages.list?rootMessageId=`, which has returned
   * roots-with-reply-counts since it was written. It simply stops being
   * rendered as a peer of the message it replies to.
   *
   * A SEPARATE SCOPE RATHER THAN A NARROWED `direct_v1`. The task Discussion
   * tab and every other hub read `direct_v1` and want replies inline; changing
   * it in place would silently restructure surfaces this ticket never looked
   * at. The two scopes disagree deliberately, and the disagreement is the
   * feature.
   */
  channel_threads_v1: Object.freeze(['anchored', 'subject'] as const),
});

/**
 * Which anchor kinds a named scope means anything for.
 *
 * `session_chat_v1` on a task is not "an empty feed" — it is a caller asking
 * for something that does not exist, which is `invalid_input` with
 * `details.reason = 'feed_scope_not_applicable'` (dossier :228). Answering 200
 * with `[]` would let a client ship a broken query and never find out.
 */
export const FEED_SCOPE_ANCHOR_KINDS: Readonly<Record<FeedScope, 'any' | readonly string[]>> =
  Object.freeze({
    direct_v1: 'any',
    session_chat_v1: Object.freeze(['work_session'] as const),
    channel_threads_v1: Object.freeze(['channel'] as const),
  });

/**
 * Anchor kind → the scope `default` resolves to for it.
 *
 * A channel defaults to roots-only, so a client that asks for nothing in
 * particular gets the threaded reading. Naming the scope explicitly still
 * works and still wins; this only decides what `default` MEANS, which is the
 * one place a kind may shape a read without the caller knowing.
 */
function defaultScopeFor(anchorKind: string): FeedScope {
  if (anchorKind === 'work_session') return 'session_chat_v1';
  if (anchorKind === 'channel') return 'channel_threads_v1';
  return 'direct_v1';
}

/**
 * One predicate → one SQL branch. `$1` is always the anchor entity id.
 *
 * Every branch reads a table RLS already guards (`messages_select`,
 * `activity_select`, `edges_select`), so scope resolution narrows a view the
 * database has already restricted — it never widens one.
 */
const FEED_VIA_SQL: Readonly<Record<FeedVia, string>> = Object.freeze({
  anchored:
    `select 'message', m.entity_id, m.created_at, 'anchored'
       from public.messages m
      where m.anchor_id = $1 and m.root_message_id is null`,
  replies:
    `select 'message', m.entity_id, m.created_at, 'replies'
       from public.messages m
      where m.anchor_id = $1 and m.root_message_id is not null`,
  subject:
    `select 'activity', a.id, a.created_at, 'subject'
       from public.activity a
      where a.entity_id = $1`,
  authored:
    `select 'message', m.entity_id, m.created_at, 'authored'
       from public.messages m
       join public.edges g on g.src_id = m.entity_id and g.type = 'authored_from'
      where g.dst_id = $1`,
  caused:
    `select 'activity', a.id, a.created_at, 'caused'
       from public.activity a
      where a.work_session_id = $1`,
});

/**
 * The named scope for this request, or `invalid_input`.
 *
 * Exported because it IS the law: the point of M1/M3 is that the mapping is a
 * single enumerable artefact, and an artefact nothing can name directly is one
 * a test can only observe through a handler.
 */
export function resolveFeedScope(
  requested: EntityFeedQuery['scope'],
  anchorKind: string,
): FeedScope {
  if (requested === undefined || requested === 'default') return defaultScopeFor(anchorKind);
  const applicable = FEED_SCOPE_ANCHOR_KINDS[requested];
  if (applicable !== 'any' && !applicable.includes(anchorKind)) {
    throw new CollabError(
      'invalid_input',
      `feed scope ${requested} is not applicable to a ${anchorKind} anchor`,
      // `reason`, NOT a bare DETAIL string: dossier §4 says ErrorDetails is
      // `{reason}`, and a reason that arrives as `details.detail` is a reason
      // no client can switch on.
      { details: { reason: 'feed_scope_not_applicable', scope: requested, anchorKind } },
    );
  }
  return requested;
}

/** Canonical (deduped + sorted) predicate spelling — one value, two consumers. */
function canonicalPredicates(predicates: readonly FeedVia[]): FeedVia[] {
  return [...new Set(predicates)].sort();
}

export interface FeedCursorIdentity {
  readonly entityId: string;
  readonly scope: FeedScope;
  readonly order: 'newest' | 'oldest';
  readonly predicates: readonly FeedVia[];
}

/**
 * The complete identity of a feed page's filter and sort.
 *
 * Canonicalised before hashing so a reordered-but-identical predicate list is
 * NOT a different filter, while a genuinely different anchor, scope or sort is.
 */
export function feedCursorFingerprint(identity: FeedCursorIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify({
      operation: 'entities.feed',
      entityId: identity.entityId,
      scope: identity.scope,
      order: identity.order,
      predicates: canonicalPredicates(identity.predicates),
    }))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Query-string parsing — the refusal happens here, before any database work
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `URLSearchParams` → a plain object the CONTRACT's strict schema can judge.
 *
 * `INPUT_SCHEMAS` (facade/input-schemas.ts, coordinator-owned) binds REQUEST
 * BODIES, and both G13 operations are GETs — so without this step their query
 * string would reach the handler unvalidated. Reusing the contract's own
 * `.strict()` schema rather than hand-rolling checks is precisely what makes
 * `?predicates=`, `?filter=`, `?where=`, `?via=` and every other invented key a
 * hard `invalid_input`: they are unrecognised keys on a strict object, refused
 * without the handler ever opening a transaction.
 */
function parseQuery<T>(
  query: URLSearchParams,
  schema: ZodTypeAny,
  coerce: (raw: Record<string, unknown>) => void,
  label: string,
): T {
  const raw: Record<string, unknown> = {};
  for (const key of new Set(query.keys())) {
    const values = query.getAll(key);
    if (values.length > 1) {
      throw new CollabError('invalid_input', `${key} must not be repeated`);
    }
    raw[key] = values[0];
  }
  coerce(raw);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new CollabError('invalid_input', `${label} failed contract validation`, {
      details: { issues: parsed.error.issues },
    });
  }
  return parsed.data as T;
}

/** `'50'` → `50`, `'abc'` → `NaN` so the SCHEMA rejects it rather than SQL. */
function integer(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return /^-?\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
}

function parseFeedQuery(query: URLSearchParams): EntityFeedQuery {
  return parseQuery<EntityFeedQuery>(query, EntityFeedQuerySchema, (raw) => {
    if ('limit' in raw) raw['limit'] = integer(raw['limit']);
  }, 'feed query');
}

function parseContextQuery(query: URLSearchParams): EntityContextQuery {
  return parseQuery<EntityContextQuery>(query, EntityContextQuerySchema, (raw) => {
    if (typeof raw['sections'] === 'string') {
      raw['sections'] = raw['sections'].split(',').filter((value) => value.length > 0);
    }
    if ('totalBytes' in raw) raw['totalBytes'] = integer(raw['totalBytes']);
    if ('sectionBytes' in raw) raw['sectionBytes'] = integer(raw['sectionBytes']);
  }, 'context query');
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface RequestAccess {
  readonly claims: DbClaims;
  readonly viewerIdentityId: string;
}

async function accessFor(deps: FacadeDeps, ctx: RequestContext): Promise<RequestAccess> {
  const owner = await deps.owner();
  if (ctx.identity.kind === 'anonymous') {
    throw new CollabError('unauthenticated', 'authentication is required');
  }
  const viewerIdentityId = ctx.identity.kind === 'auto-owner'
    ? owner.identityId
    : ctx.identity.identityId;
  if (!viewerIdentityId) {
    throw new CollabError('unauthenticated', 'bearer identity is unresolved');
  }
  return {
    viewerIdentityId,
    claims: {
      ...claimsFor(owner, ctx),
      identityId: viewerIdentityId,
      nodeAdmin: viewerIdentityId === owner.identityId ? owner.isNodeAdmin : false,
    },
  };
}

interface AnchorRow {
  id: string;
  kind: string;
  space_id: string;
}

async function loadAnchor(q: Querier, id: string): Promise<AnchorRow> {
  const rows = await q.query<AnchorRow>(
    `/* entities.feed:anchor */
     select e.id, e.kind, e.space_id
       from public.entities e
      where e.id = $1 and e.deleted_at is null`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new CollabError('not_found', `no readable entity: ${id}`);
  return row;
}

// ---------------------------------------------------------------------------
// entities.feed
// ---------------------------------------------------------------------------

interface FeedPageRow {
  item_kind: 'message' | 'activity';
  item_id: string;
  created_at: Date | string;
  /**
   * The keyset value, as microsecond TEXT straight from Postgres. REQUIRED, and
   * `string` not `Date | string`: the feed's default order is DESC (`newest`),
   * and a cursor truncated to milliseconds by a JavaScript `Date` does not loop
   * there — it SILENTLY SKIPS every item sharing the lost millisecond. Feed
   * items are exactly the batch-written rows that share one transaction's
   * `now()`, so that window is where a posted message batch would vanish.
   */
  cursor_created_at: string;
  via: string[];
}

interface ActivityRow {
  id: string;
  entity_id: string | null;
  actor_id: string | null;
  verb: string;
  summary: Record<string, unknown> | null;
  ref_id: string | null;
  created_at: Date | string;
  work_session_id: string | null;
}

interface DeliveryRow {
  delivery_id: string;
  message_id: string;
  target_work_session_id: string;
  status: string;
  attempt_no: number;
  failure_reason: string | null;
  updated_at: Date | string;
}

interface SessionSiblingRow {
  source_message_id: string;
  target_message_id: string;
  target_work_session_id: string;
}

const DELIVERY_STATUSES = new Set<string>([
  'pending', 'dispatching', 'delivered', 'failed_retryable',
  'failed_permanent', 'unknown', 'expired', 'cancelled',
]);

/**
 * The scope's branches, unioned and folded to one row per item.
 *
 * Exported, along with `feedPageSql` and `feedLocateSql`, so the PG suite can
 * execute the LITERAL production statement against the real chain rather than a
 * transcription of it. A copied query is how a gate ends up proving something
 * about a string nobody ships.
 */
export function feedCandidateSql(predicates: readonly FeedVia[]): string {
  const branches = canonicalPredicates(predicates).map((via) => FEED_VIA_SQL[via]);
  return `with candidate(item_kind, item_id, created_at, via) as (
            ${branches.join('\n            union all\n            ')}
          ),
          item as (
            select item_kind, item_id, created_at, array_agg(distinct via order by via) via
              from candidate
             group by item_kind, item_id, created_at
          )`;
}

interface PageWindow {
  readonly comparator: '<' | '>' | '<=' | '>=';
  readonly direction: 'asc' | 'desc';
  readonly limit: number;
  readonly from?: { createdAt: string; itemId: string };
}

/**
 * `$1` is the anchor id; `$2`/`$3` are the keyset when `keyed`. `limit` is the
 * only interpolated value and the contract schema has already bound it to
 * 1..100 — nothing a caller typed reaches SQL text.
 */
export function feedPageSql(
  predicates: readonly FeedVia[],
  window: { comparator: string; direction: 'asc' | 'desc'; limit: number; keyed: boolean },
): string {
  const keyset = window.keyed
    ? `where (created_at, item_id) ${window.comparator} ($2::timestamptz, $3::uuid)`
    : '';
  return `/* entities.feed:page */
     ${feedCandidateSql(predicates)}
     select item_kind, item_id, created_at,
            ${MICROS('created_at')} cursor_created_at,
            via
       from item
      ${keyset}
      order by created_at ${window.direction}, item_id ${window.direction}
      limit ${window.limit}`;
}

async function readWindow(
  q: Querier,
  entityId: string,
  predicates: readonly FeedVia[],
  window: PageWindow,
): Promise<{ rows: FeedPageRow[]; hasMore: boolean }> {
  const params: unknown[] = [entityId];
  if (window.from) params.push(window.from.createdAt, window.from.itemId);
  const rows = await q.query<FeedPageRow>(
    feedPageSql(predicates, {
      comparator: window.comparator,
      direction: window.direction,
      // One row past the page: the honest test for "is there more?".
      limit: window.limit + 1,
      keyed: window.from !== undefined,
    }),
    params,
  );
  const hasMore = rows.length > window.limit;
  return { rows: hasMore ? rows.slice(0, window.limit) : rows, hasMore };
}

/** Server-owned provenance for every item, assembled from stored rows only. */
interface FeedHydration {
  readonly messages: Map<string, MessageView>;
  readonly activity: Map<string, ActivityItem>;
  readonly activityRows: Map<string, ActivityRow>;
  readonly deliveries: Map<string, DeliverySummary[]>;
  readonly linkedWorkSessions: Map<string, EntitySummary[]>;
  readonly authoredFrom: Map<string, string>;
  readonly anchors: Map<string, EntitySummary>;
}

async function hydrate(
  q: Querier,
  rows: readonly FeedPageRow[],
  viewerIdentityId: string,
): Promise<FeedHydration> {
  const messageIds = rows.filter((row) => row.item_kind === 'message').map((row) => row.item_id);
  const activityIds = rows.filter((row) => row.item_kind === 'activity').map((row) => row.item_id);

  // Sequential throughout: one `Querier` is one pooled pg client, which cannot
  // run two statements at once.
  const messageViews = await loadMessageViewsByIds(q, messageIds, viewerIdentityId);
  const messages = new Map(messageViews.map((view) => [view.id, view]));

  const activityRows = activityIds.length === 0 ? [] : await q.query<ActivityRow>(
    `/* entities.feed:activity */
     select a.id, a.entity_id, a.actor_id, a.verb, a.summary, a.ref_id, a.created_at,
            a.work_session_id
       from public.activity a
      where a.id = any($1::uuid[])`,
    [activityIds],
  );
  const activityActors = await loadActors(q, activityRows.map((row) => row.actor_id ?? ''));
  const activity = new Map<string, ActivityItem>(activityRows.map((row) => [row.id, {
    id: row.id,
    entityId: row.entity_id,
    actor: row.actor_id ? actorOf(activityActors, row.actor_id) : null,
    verb: row.verb,
    summary: row.summary ?? {},
    createdAt: iso(row.created_at),
    refId: row.ref_id,
    workSessionId: row.work_session_id,
  }]));

  // A channel @Tag is represented by one message batch with a channel source
  // copy and one work-session sibling per existing/spawned session target.
  // Read that durable graph shape rather than inferring linkage from delivery:
  // a session chip must survive a refused, unavailable, or pruned attempt.
  const sessionSiblingRows = messageIds.length === 0 ? [] : await q.query<SessionSiblingRow>(
    `/* entities.feed:sessiontargets */
     select source.entity_id source_message_id,
            sibling.entity_id target_message_id,
            sibling.anchor_id target_work_session_id
       from public.messages source
       join public.entities source_anchor
         on source_anchor.id = source.anchor_id and source_anchor.kind = 'channel'
       join public.messages sibling
         on sibling.message_batch_id = source.message_batch_id
        and sibling.author_id = source.author_id
        and sibling.entity_id <> source.entity_id
       join public.entities target_anchor
         on target_anchor.id = sibling.anchor_id
        and target_anchor.kind = 'work_session'
        and target_anchor.space_id = source_anchor.space_id
      where source.entity_id = any($1::uuid[])
        and source.message_batch_id is not null
      order by source.entity_id, sibling.entity_id`,
    [messageIds],
  );

  const deliveryMessageIds = [...new Set([
    ...messageIds,
    ...sessionSiblingRows.map((row) => row.target_message_id),
  ])];

  const deliveryRows = deliveryMessageIds.length === 0 ? [] : await q.query<DeliveryRow>(
    `/* entities.feed:deliveries */
     select delivery_id, message_id, target_work_session_id, status, attempt_no,
            failure_reason, updated_at
       from public.session_message_deliveries
      where message_id = any($1::uuid[])
      order by reserved_at asc, delivery_id asc`,
    [deliveryMessageIds],
  );
  for (const row of deliveryRows) {
    if (!DELIVERY_STATUSES.has(row.status)) {
      throw new CollabError('upstream_unavailable', 'stored delivery has an invalid status');
    }
  }

  // `authored_from` is writer-gated to `message_recorder` (015:618), so this is
  // recorder-owned provenance. It is READ here and never accepted as input.
  const provenanceRows = messageIds.length === 0 ? [] : await q.query<{
    src_id: string;
    dst_id: string;
  }>(
    `/* entities.feed:provenance */
     select g.src_id, g.dst_id
       from public.edges g
      where g.type = 'authored_from' and g.src_id = any($1::uuid[])`,
    [messageIds],
  );
  const authoredFrom = new Map(provenanceRows.map((row) => [row.src_id, row.dst_id]));

  const anchorIds = [
    ...messageViews.map((view) => view.state.anchorId),
    ...activityRows.map((row) => row.entity_id ?? ''),
    ...sessionSiblingRows.map((row) => row.target_work_session_id),
    ...deliveryRows.map((row) => row.target_work_session_id),
  ].filter(Boolean);
  const anchorSummaries = await loadEntitySummariesByIds(q, anchorIds, viewerIdentityId);
  const anchors = new Map(anchorSummaries.map((summary) => [summary.id, summary]));

  const feedIdsByDeliveryMessage = new Map<string, Set<string>>();
  for (const id of messageIds) feedIdsByDeliveryMessage.set(id, new Set([id]));
  for (const row of sessionSiblingRows) {
    const feedIds = feedIdsByDeliveryMessage.get(row.target_message_id) ?? new Set<string>();
    feedIds.add(row.source_message_id);
    feedIdsByDeliveryMessage.set(row.target_message_id, feedIds);
  }

  const deliveries = new Map<string, DeliverySummary[]>();
  for (const row of deliveryRows) {
    for (const feedId of feedIdsByDeliveryMessage.get(row.message_id) ?? []) {
      const list = deliveries.get(feedId) ?? [];
      list.push({
        deliveryId: row.delivery_id,
        targetWorkSessionId: row.target_work_session_id,
        targetWorkSession: anchors.get(row.target_work_session_id) ?? null,
        status: row.status as MessageDeliveryStatus,
        attemptNo: Number(row.attempt_no),
        failureReason: row.failure_reason,
        updatedAt: iso(row.updated_at),
      });
      deliveries.set(feedId, list);
    }
  }

  const linkedWorkSessions = new Map<string, EntitySummary[]>();
  for (const row of sessionSiblingRows) {
    const session = anchors.get(row.target_work_session_id);
    if (!session) continue;
    const list = linkedWorkSessions.get(row.source_message_id) ?? [];
    if (!list.some((candidate) => candidate.id === session.id)) list.push(session);
    linkedWorkSessions.set(row.source_message_id, list);
  }

  return {
    messages,
    activity,
    activityRows: new Map(activityRows.map((row) => [row.id, row])),
    deliveries,
    linkedWorkSessions,
    authoredFrom,
    anchors,
  };
}

const FEED_VIA_VALUES: readonly string[] = ['subject', 'anchored', 'authored', 'replies', 'caused'];

function viaOf(raw: readonly string[]): FeedVia[] {
  const known = raw.filter((value): value is FeedVia => FEED_VIA_VALUES.includes(value));
  return [...new Set(known)].sort();
}

function toFeedItem(row: FeedPageRow, hydration: FeedHydration): FeedItem | null {
  const via = viaOf(row.via);
  if (via.length === 0) return null;
  const createdAt = iso(row.created_at);
  const sortId = `${createdAt}#${row.item_id}`;

  if (row.item_kind === 'message') {
    const message = hydration.messages.get(row.item_id);
    // RLS hid the message (or its anchor). Dropping the row is the honest
    // answer; a placeholder would leak that something is there.
    if (!message) return null;
    return {
      itemId: row.item_id,
      createdAt,
      sortId,
      via,
      actor: message.state.author,
      sourceWorkSessionId: hydration.authoredFrom.get(row.item_id) ?? null,
      anchor: hydration.anchors.get(message.state.anchorId) ?? null,
      logicalOperationId: message.state.messageBatchId,
      itemKind: 'message',
      message,
      delivery: hydration.deliveries.get(row.item_id) ?? [],
      linkedWorkSessions: hydration.linkedWorkSessions.get(row.item_id) ?? [],
    };
  }

  const activity = hydration.activity.get(row.item_id);
  const activityRow = hydration.activityRows.get(row.item_id);
  if (!activity || !activityRow) return null;
  return {
    itemId: row.item_id,
    createdAt,
    sortId,
    via,
    actor: activity.actor ?? null,
    sourceWorkSessionId: activityRow.work_session_id,
    anchor: activityRow.entity_id ? (hydration.anchors.get(activityRow.entity_id) ?? null) : null,
    // `public.activity` stores no logical-operation identity today, and G13
    // deliberately does NOT add one: the column would sit under three composed,
    // already-gated readers (`entities.activity`, `entities.get`,
    // `collections.query` under `activityAt_desc`). `null` is the honest answer
    // for a provenance the recorder never wrote.
    logicalOperationId: null,
    itemKind: 'activity',
    activity,
  };
}

function cursorAt(fingerprint: string, row: FeedPageRow): Cursor {
  // Carried verbatim — never through a JS Date. See FeedPageRow.cursor_created_at.
  return encodeCursor([fingerprint, row.cursor_created_at, row.item_id]);
}

/**
 * `$1` anchor id, `$2` item id, `$3` item kind — all bound as parameters.
 *
 * `in_scope` separates the two frozen refusals: a row that is visible but
 * absent from the scope's own candidate set is `feed_item_not_in_scope`, while
 * no row at all is `not_found`. Both facts have to come from ONE statement, or
 * a concurrent write between two queries could make them disagree.
 */
export function feedLocateSql(predicates: readonly FeedVia[]): string {
  return `/* entities.feed:locate */
     ${feedCandidateSql(predicates)}
     select v.item_id, v.created_at,
            ${MICROS('v.created_at')} cursor_created_at,
            exists (select 1 from item i where i.item_id = v.item_id) in_scope
       from (
         select m.entity_id item_id, m.created_at
           from public.messages m where m.entity_id = $2 and $3 = 'message'
         union all
         select a.id, a.created_at
           from public.activity a where a.id = $2 and $3 = 'activity'
       ) v`;
}

/** The `around` anchor, or one of the two frozen refusals. */
async function locateAround(
  q: Querier,
  entityId: string,
  predicates: readonly FeedVia[],
  around: string,
): Promise<{ createdAt: string; itemId: string }> {
  const separator = around.indexOf(':');
  const kind = around.slice(0, separator);
  const itemId = around.slice(separator + 1);
  // A non-uuid would raise 22P02 from `$2::uuid`, which is not in the taxonomy
  // and would surface as a 503 — telling the caller the database is unwell when
  // in fact they typed a bad id.
  if (!UUID_RE.test(itemId)) {
    throw new CollabError('not_found', `no such feed item: ${around}`);
  }
  const rows = await q.query<{
    item_id: string; created_at: Date | string; cursor_created_at: string; in_scope: boolean;
  }>(
    feedLocateSql(predicates), [entityId, itemId, kind],
  );
  const row = rows[0];
  if (!row) throw new CollabError('not_found', `no readable feed item: ${around}`);
  if (!row.in_scope) {
    throw new CollabError('invalid_input', `feed item ${around} is outside the resolved scope`, {
      details: { reason: 'feed_item_not_in_scope', around },
    });
  }
  // The `around` anchor feeds the SAME keyset as the page cursor, so it needs
  // the same microsecond fidelity — truncating here would place the window
  // boundary a fraction of a millisecond off and drop items at its edge.
  return { createdAt: row.cursor_created_at, itemId: row.item_id };
}

export interface W2FeedContextServiceOptions {
  /**
   * The palette for `entities.context`'s `actions` section.
   *
   * Injected rather than reimplemented: G09 already owns availability, and two
   * action discoverers would let the focus view and `actions.list` disagree
   * about what the same caller may do.
   */
  readonly actions?: (ctx: RequestContext, entityId: string) => Promise<PaletteAction[]>;
}

// ---------------------------------------------------------------------------
// entities.context — bounded focus
// ---------------------------------------------------------------------------

const ALL_SECTIONS: readonly EntityContextSection[] = [
  'summary', 'hierarchy', 'connections', 'messages', 'activity', 'actions',
];

const DEFAULT_TOTAL_BYTES = 16_384;
const DEFAULT_SECTION_BYTES = 4096;
/** Nothing in a focus view is worth more rows than this before capping. */
const SECTION_ROW_LIMIT = 50;

/**
 * Drop order when the assembled view still exceeds `totalBytes`.
 *
 * Lowest value first. Messages and the root's own content go last, because a
 * focus view that has lost the thread has lost its reason to exist.
 */
const DROP_ORDER = ['actions', 'edges', 'children', 'parents', 'messages', 'content'] as const;
type Droppable = (typeof DROP_ORDER)[number];
type ListName = Exclude<Droppable, 'content'>;

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/** Trim trailing items until the list fits `limit` bytes. Deterministic. */
function capList<T>(list: readonly T[], limit: number): { list: T[]; truncated: boolean } {
  const out = [...list];
  let truncated = false;
  while (out.length > 0 && byteLength(out) > limit) {
    out.pop();
    truncated = true;
  }
  return { list: out, truncated };
}

/**
 * Trim a string to at most `limit` BYTES without leaving a partial code point.
 *
 * The cap is in BYTES because the budget is in bytes; `String.slice` counts
 * UTF-16 units and would blow a 4096-byte budget on 4096 CJK characters. So the
 * cut is made on the buffer and then walked BACK to a code-point boundary —
 * UTF-8 continuation bytes are `0b10xxxxxx`, so at most three steps.
 *
 * Doing it this way rather than decoding and stripping the U+FFFD that a
 * mid-sequence cut produces: the replacement character is a DECODING artefact,
 * and reasoning about how many of them Node emits for a given truncated
 * sequence is a worse foundation than never producing one.
 */
function capText(value: string, limit: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= limit) return { text: value, truncated: false };
  let end = Math.max(0, limit);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

interface ContextRowSet {
  root: EntityRow;
  rootSummary: EntitySummary;
  parents: EntitySummary[];
  children: EntitySummary[];
  edges: EdgeView[];
  messages: MessageView[];
  /**
   * message id -> the microsecond-exact `m.created_at` its feed cursor keys on.
   *
   * REQUIRED because `MessageView.createdAt` CANNOT serve as a cursor value on
   * two independent counts, and both are invisible at the encode site:
   * it is `iso(e.created_at)` (entity-read.ts), so it is (1) the ENVELOPE's
   * timestamp while this section orders by `m.created_at`, and (2) already
   * truncated to milliseconds by `iso()` one layer away. A cursor built from a
   * DTO inherits whatever that DTO did to the value.
   */
  messageCursors: Map<string, string>;
  actions: PaletteAction[];
  newestActivity: { id: string; created_at: Date | string; cursor_created_at: string } | null;
  eventSeq: number;
  /** A section had more rows than the fetch cap — the view is already partial. */
  overfetched: boolean;
}

function excerptOf(row: EntityRow): { excerpt: string; source: 'entity' | 'message' | 'file' } {
  if (row.kind === 'message') {
    return { excerpt: row.message_redacted_at ? '' : (row.message_body ?? ''), source: 'message' };
  }
  if (row.kind === 'file') return { excerpt: row.file_name ?? '', source: 'file' };
  const content = contentOf(row) as Record<string, unknown>;
  const text = [content['body'], content['description'], content['topic']]
    .find((value): value is string => typeof value === 'string' && value.length > 0) ?? '';
  return { excerpt: text, source: 'entity' };
}

// ---------------------------------------------------------------------------

export class W2FeedContextService {
  constructor(
    private readonly deps: FacadeDeps,
    private readonly options: W2FeedContextServiceOptions = {},
  ) {}

  /**
   * `GET /v2/entities/:id/feed` — dossier A11.
   *
   * The parse happens FIRST, before a transaction is opened, so an invented key
   * or an arbitrary scope string never costs a database round trip and is never
   * observed by PostgreSQL at all.
   */
  readonly feed: OperationHandler = async (ctx) => {
    const id = requireUuidParam(ctx, 'id');
    const input = parseFeedQuery(ctx.query);
    const order = input.order ?? 'newest';
    const limit = input.limit ?? 50;
    const { claims, viewerIdentityId } = await accessFor(this.deps, ctx);

    return this.deps.db.tx(claims, async (q) => {
      const anchor = await loadAnchor(q, id);
      const scope = resolveFeedScope(input.scope, anchor.kind);
      const predicates = canonicalPredicates(FEED_SCOPE_PREDICATES[scope]);
      const fingerprint = feedCursorFingerprint({ entityId: id, scope, order, predicates });

      const forward: 'asc' | 'desc' = order === 'newest' ? 'desc' : 'asc';
      const backward: 'asc' | 'desc' = order === 'newest' ? 'asc' : 'desc';
      const forwardComparator = order === 'newest' ? '<' : '>';
      const backwardComparator = order === 'newest' ? '>' : '<';

      if (input.around !== undefined) {
        const at = await locateAround(q, id, predicates, input.around);
        const leadCount = Math.floor((limit - 1) / 2);
        const lead = leadCount === 0
          ? { rows: [] as FeedPageRow[], hasMore: false }
          : await readWindow(q, id, predicates, {
              comparator: backwardComparator,
              direction: backward,
              limit: leadCount,
              from: at,
            });
        const tail = await readWindow(q, id, predicates, {
          comparator: `${forwardComparator}=` as PageWindow['comparator'],
          direction: forward,
          limit: limit - lead.rows.length,
          from: at,
        });
        const seen = new Set<string>();
        const rows = [...[...lead.rows].reverse(), ...tail.rows].filter((row) => {
          if (seen.has(row.item_id)) return false;
          seen.add(row.item_id);
          return true;
        });
        const first = rows[0];
        const last = tail.rows.at(-1);
        return this.assemblePage(q, viewerIdentityId, {
          scope, predicates, fingerprint, rows,
          nextCursor: tail.hasMore && last ? cursorAt(fingerprint, last) : null,
          previousCursor: lead.hasMore && first ? cursorAt(fingerprint, first) : null,
        });
      }

      let from: PageWindow['from'];
      if (input.cursor !== undefined) {
        const { k } = decodeCursor(input.cursor);
        if (k.length !== 3 || k[0] !== fingerprint) {
          throw new CollabError('invalid_cursor', 'cursor does not match this feed');
        }
        from = { createdAt: String(k[1]), itemId: String(k[2]) };
      }
      const page = await readWindow(q, id, predicates, {
        comparator: forwardComparator,
        direction: forward,
        limit,
        ...(from ? { from } : {}),
      });
      const last = page.rows.at(-1);
      return this.assemblePage(q, viewerIdentityId, {
        scope, predicates, fingerprint, rows: page.rows,
        nextCursor: page.hasMore && last ? cursorAt(fingerprint, last) : null,
        previousCursor: null,
      });
    });
  };

  private async assemblePage(
    q: Querier,
    viewerIdentityId: string,
    input: {
      scope: FeedScope;
      predicates: readonly FeedVia[];
      fingerprint: string;
      rows: FeedPageRow[];
      nextCursor: Cursor | null;
      previousCursor: Cursor | null;
    },
  ): Promise<EntityFeedPage> {
    const hydration = await hydrate(q, input.rows, viewerIdentityId);
    const items = input.rows
      .map((row) => toFeedItem(row, hydration))
      .filter((item): item is FeedItem => item !== null);
    return {
      resolvedScope: input.scope,
      predicates: [...input.predicates],
      items,
      nextCursor: input.nextCursor,
      previousCursor: input.previousCursor,
    };
  }

  /**
   * `GET /v2/entities/:id/context` — dossier A12.
   *
   * ⚠ DECLARED GAP, reported to the wave coordinator and batched for a single
   * dossier amendment rather than normalised here: `EntityContextQuery.sections`
   * offers `'activity'`, but the frozen `EntityContextView`
   * (`packages/contract/src/schemas.ts:1365-1386`, `.strict()`) has NO activity
   * array. Rather than invent a field, the `activity` section contributes only a
   * `cursors.activity` continuation token into `entities.feed` — legal without
   * any schema change because `cursors` is an open `z.record`.
   */
  readonly context: OperationHandler = async (ctx) => {
    const id = requireUuidParam(ctx, 'id');
    const input = parseContextQuery(ctx.query);
    const sections = new Set(input.sections ?? ALL_SECTIONS);
    const totalBytes = input.totalBytes ?? DEFAULT_TOTAL_BYTES;
    const sectionBytes = input.sectionBytes ?? DEFAULT_SECTION_BYTES;
    const { claims, viewerIdentityId } = await accessFor(this.deps, ctx);

    const loaded = await this.deps.db.tx(claims, (q) =>
      this.loadContext(q, ctx, id, sections, viewerIdentityId));
    return boundedView(id, loaded, sections, totalBytes, sectionBytes);
  };

  private async loadContext(
    q: Querier,
    ctx: RequestContext,
    id: string,
    sections: ReadonlySet<EntityContextSection>,
    viewerIdentityId: string,
  ): Promise<ContextRowSet> {
    const rootRows = await q.query<EntityRow>(
      `/* entities.context:root */
       select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = $1`,
      [id],
    );
    const root = rootRows[0];
    if (!root) throw new CollabError('not_found', `no readable entity: ${id}`);
    const [rootSummary] = await assembleSummaries(q, [root], viewerIdentityId);
    if (!rootSummary) throw new CollabError('not_found', `no readable entity: ${id}`);

    let overfetched = false;
    let parents: EntitySummary[] = [];
    let children: EntitySummary[] = [];
    if (sections.has('hierarchy')) {
      const parentRows = await q.query<EntityRow>(
        `/* entities.context:parents */
         with recursive up(id, parent_id, depth) as (
           select e.id, e.parent_id, 0 from public.entities e where e.id = $1
           union all
           select p.id, p.parent_id, up.depth + 1
             from public.entities p join up on p.id = up.parent_id
            where up.depth < 32
         )
         select ${ENTITY_COLUMNS} ${ENTITY_FROM}
          where e.id in (select id from up where depth > 0)`,
        [id],
      );
      parents = await assembleSummaries(q, parentRows, viewerIdentityId);

      const childRows = await q.query<EntityRow>(
        `/* entities.context:children */
         select ${ENTITY_COLUMNS} ${ENTITY_FROM}
          where e.parent_id = $1 and e.deleted_at is null
          order by e.position asc, e.id asc
          limit ${SECTION_ROW_LIMIT + 1}`,
        [id],
      );
      overfetched ||= childRows.length > SECTION_ROW_LIMIT;
      children = await assembleSummaries(
        q, childRows.slice(0, SECTION_ROW_LIMIT), viewerIdentityId,
      );
    }

    let edges: EdgeView[] = [];
    if (sections.has('connections')) {
      const edgeRows = await q.query<{
        id: string; src_id: string; dst_id: string; type: string;
        props: Record<string, unknown> | null; created_by: string;
        created_at: Date | string; updated_at: Date | string; dst_resolved: boolean | null;
      }>(
        `/* entities.context:edges */
         select g.id, g.src_id, g.dst_id, g.type, g.props, g.created_by,
                g.created_at, g.updated_at,
                case when g.type = 'depends_on' then internal.is_resolved(g.dst_id) else null end dst_resolved
           from public.edges g
          where g.src_id = $1 or g.dst_id = $1
          order by g.type asc, g.created_at desc, g.id desc
          limit ${SECTION_ROW_LIMIT + 1}`,
        [id],
      );
      overfetched ||= edgeRows.length > SECTION_ROW_LIMIT;
      const page = edgeRows.slice(0, SECTION_ROW_LIMIT);
      const endpointIds = [...new Set(page.flatMap((edge) => [edge.src_id, edge.dst_id]))];
      const endpoints = new Map(
        (await loadEntitySummariesByIds(q, endpointIds, viewerIdentityId)).map((s) => [s.id, s]),
      );
      const actors = await loadActors(q, page.map((edge) => edge.created_by));
      edges = page.flatMap((edge) => {
        const source = endpoints.get(edge.src_id);
        const target = endpoints.get(edge.dst_id);
        // An endpoint RLS hid: drop the edge rather than render half of it.
        if (!source || !target) return [];
        return [{
          id: edge.id,
          type: edge.type,
          source,
          target,
          props: edge.props ?? {},
          createdBy: actorOf(actors, edge.created_by),
          createdAt: iso(edge.created_at),
          updatedAt: iso(edge.updated_at),
          ...(edge.dst_resolved === null ? {} : { resolved: edge.dst_resolved }),
        } satisfies EdgeView];
      });
    }

    let messages: MessageView[] = [];
    const messageCursors = new Map<string, string>();
    if (sections.has('messages')) {
      const messageRows = await q.query<{ entity_id: string; cursor_created_at: string }>(
        `/* entities.context:messages */
         select m.entity_id, ${MICROS('m.created_at')} cursor_created_at
           from public.messages m
          where m.anchor_id = $1
          order by m.created_at desc, m.entity_id desc
          limit ${SECTION_ROW_LIMIT + 1}`,
        [id],
      );
      overfetched ||= messageRows.length > SECTION_ROW_LIMIT;
      for (const row of messageRows) messageCursors.set(row.entity_id, row.cursor_created_at);
      messages = await loadMessageViewsByIds(
        q, messageRows.slice(0, SECTION_ROW_LIMIT).map((row) => row.entity_id), viewerIdentityId,
      );
    }

    let newestActivity:
      { id: string; created_at: Date | string; cursor_created_at: string } | null = null;
    if (sections.has('activity')) {
      const rows = await q.query<{ id: string; created_at: Date | string; cursor_created_at: string }>(
        `/* entities.context:activity */
         select a.id, a.created_at,
                ${MICROS('a.created_at')} cursor_created_at
           from public.activity a
          where a.entity_id = $1
          order by a.created_at desc, a.id desc
          limit 1`,
        [id],
      );
      newestActivity = rows[0] ?? null;
    }

    // The as-of watermark. `space_event_seq` deliberately carries no RLS policy
    // (008:205), so the durable event log is the readable authority.
    const seqRows = await q.query<{ seq: string | number }>(
      `/* entities.context:seq */
       select coalesce(max(w.seq), 0) seq
         from public.workspace_events w
        where w.space_id = $1`,
      [root.space_id],
    );

    const actions = sections.has('actions') && this.options.actions
      ? await this.options.actions(ctx, id)
      : [];

    return {
      root,
      rootSummary,
      parents,
      children,
      edges,
      messages,
      messageCursors,
      actions,
      newestActivity,
      eventSeq: Number(seqRows[0]?.seq ?? 0),
      overfetched,
    };
  }
}

/**
 * Assemble the view and then ENFORCE the caps against its real serialised size.
 *
 * Capping per-section and stopping there would make `totalBytes` advisory: six
 * sections each inside `sectionBytes` can be six times over budget. So the
 * final loop measures the actual JSON and drops one item at a time, in a fixed
 * order, until the whole view fits — which is what makes the cap enforced
 * rather than advertised.
 */
function boundedView(
  id: string,
  loaded: ContextRowSet,
  sections: ReadonlySet<EntityContextSection>,
  totalBytes: number,
  sectionBytes: number,
): EntityContextView {
  let truncated = loaded.overfetched;

  const capped = {
    parents: capList(loaded.parents, sectionBytes),
    children: capList(loaded.children, sectionBytes),
    edges: capList(loaded.edges, sectionBytes),
    messages: capList(loaded.messages, sectionBytes),
    actions: capList(loaded.actions, sectionBytes),
  };
  for (const section of Object.values(capped)) truncated ||= section.truncated;

  const lists: Record<ListName, unknown[]> = {
    parents: capped.parents.list,
    children: capped.children.list,
    edges: capped.edges.list,
    messages: capped.messages.list,
    actions: capped.actions.list,
  };
  const fetched: Record<ListName, number> = {
    parents: loaded.parents.length,
    children: loaded.children.length,
    edges: loaded.edges.length,
    messages: loaded.messages.length,
    actions: loaded.actions.length,
  };

  let content: EntityContextView['content'];
  if (sections.has('summary')) {
    const raw = excerptOf(loaded.root);
    const held = capText(raw.excerpt, Math.min(sectionBytes, totalBytes));
    truncated ||= held.truncated;
    content = { excerpt: held.text, source: raw.source, truncated: held.truncated };
  }

  const fetchedAt = new Date().toISOString();
  const build = (): EntityContextView => ({
    schemaVersion: 'tm8.entity-context.v1',
    root: loaded.rootSummary,
    ...(content ? { content } : {}),
    parents: lists.parents as EntitySummary[],
    children: lists.children as EntitySummary[],
    edges: lists.edges as EdgeView[],
    messages: lists.messages as MessageView[],
    actions: lists.actions as PaletteAction[],
    provenance: { operation: 'entities.context', fetchedAt, eventSeq: loaded.eventSeq },
    cursors: cursorsFor(id, loaded, sections, lists, fetched),
    byteSize: 0,
    truncated: false,
  });

  /** `byteSize` counts itself, so settle it on its own fixed point. */
  const finalise = (view: EntityContextView): EntityContextView => {
    let size = byteLength({ ...view, truncated, byteSize: 0 });
    for (let round = 0; round < 4; round += 1) {
      const next = byteLength({ ...view, truncated, byteSize: size });
      if (next === size) break;
      size = next;
    }
    return { ...view, truncated, byteSize: size };
  };

  // Deterministic: always the LAST item of the lowest-priority non-empty
  // section, never a sampled or "least useful" one.
  let view = finalise(build());
  let guard = 0;
  while (view.byteSize > totalBytes && guard < 4096) {
    guard += 1;
    const victim: Droppable | undefined = DROP_ORDER.find((name) =>
      name === 'content' ? content !== undefined : lists[name].length > 0);
    // Only `root` and `provenance` are left, and both are mandatory in the DTO.
    if (!victim) break;
    if (victim === 'content') content = undefined;
    else lists[victim].pop();
    truncated = true;
    view = finalise(build());
  }
  return view;
}

/**
 * Continuation tokens, keyed by the operation that consumes them.
 *
 * `edges` is deliberately absent: `entities.connections` owns its own cursor
 * fingerprint and G13 does not, so emitting one here would be a token the
 * continuing operation rejects. `truncated` is the honest signal instead.
 */
function cursorsFor(
  id: string,
  loaded: ContextRowSet,
  sections: ReadonlySet<EntityContextSection>,
  lists: Record<ListName, unknown[]>,
  fetched: Record<ListName, number>,
): Record<string, Cursor | null> {
  const cursors: Record<string, Cursor | null> = {};
  if (sections.has('hierarchy')) {
    const last = lists.children.at(-1) as EntitySummary | undefined;
    cursors['children'] = last && (loaded.overfetched || fetched.children > lists.children.length)
      ? encodeCursor([last.position, last.id])
      : null;
  }
  if (sections.has('messages') || sections.has('activity')) {
    const scope = defaultScopeFor(loaded.root.kind);
    const fingerprint = feedCursorFingerprint({
      entityId: id, scope, order: 'newest', predicates: FEED_SCOPE_PREDICATES[scope],
    });
    if (sections.has('messages')) {
      const last = lists.messages.at(-1) as MessageView | undefined;
      // NEVER `last.createdAt` — see LoadedContext.messageCursors. A DTO field
      // that has already been through `iso()` carries a truncated, and here
      // also a wrong-column, value, and nothing at this line shows it.
      const lastCursor = last ? loaded.messageCursors.get(last.id) : undefined;
      cursors['messages'] = last && lastCursor
        ? encodeCursor([fingerprint, lastCursor, last.id])
        : null;
    }
    if (sections.has('activity')) {
      cursors['activity'] = loaded.newestActivity
        // Carried verbatim — never through a JS Date.
        ? encodeCursor([fingerprint, loaded.newestActivity.cursor_created_at, loaded.newestActivity.id])
        : null;
    }
  }
  return cursors;
}
