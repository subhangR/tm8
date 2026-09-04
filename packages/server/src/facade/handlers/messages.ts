/**
 * `messages.list` / `messages.send` — the task thread the user watches while
 * an agent works.
 *
 * Threads are ADDRESSED BY ANCHOR (02 §3.4): a message hangs off whatever
 * entity it is about, so a task's discussion and a channel's discussion are the
 * same mechanism. `messages.list` returns the ROOTS of the thread with their
 * reply counts and embeds a bounded reply page when that complete branch fits
 * under the preview cap. The explicit `?rootMessageId=` read remains the
 * pagination path for larger branches. A flat list of every message would make
 * a 500-message channel unusable and would lose the reply structure the UI
 * renders.
 */
import {
  CollabError,
  MessagePartSchema,
  decodeCursor,
  encodeCursor,
  type MessagePart,
  type MessageView,
  type Page,
} from '@tm8/contract';
import { createHash } from 'node:crypto';
import type { Querier } from '../../db/types.js';
import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, limitOf, requireUuidParam } from '../context.js';
import {
  assembleSummaries,
  contentOf,
  ENTITY_COLUMNS,
  ENTITY_FROM,
  MICROS,
  iso,
  loadActors,
  type EntityRow,
} from '../entity-read.js';

/**
 * Hydrate envelope rows for ids that are ALREADY KNOWN, preserving the order
 * they were given in.
 *
 * This exists because of how `ENTITY_FROM` behaves under a non-`entities`
 * predicate, and the difference is the whole reason a heavy thread opens at
 * all. `ENTITY_FROM` left-joins ~25 detail tables. Filter it on `e.id` and the
 * planner drives the chain from a single index lookup. Filter it on `msg`
 * instead — a table INSIDE the chain — and it has no id to drive from, so it
 * rebuilds the entire chain once per candidate row.
 *
 * Measured on prod (71-message thread, real RLS, real identity claims):
 *
 *   - filtering on `msg`: `Seq Scan on entities` at `loops=71`, the join
 *     `msg.entity_id = e.id` degraded to a `Join Filter` discarding 588,093
 *     rows, 5,880,086 shared buffer hits, **37,451 ms to return two rows**.
 *   - filtering on `e.id = any(...)`: bitmap scan, 4,080 buffer hits, **31 ms**.
 *
 * Two things make the bad plan worse than it looks. The RLS predicates
 * (`internal.entity_readable`, `internal.entity_row_visible`) are
 * SECURITY DEFINER and therefore CANNOT be inlined, so the planner cannot
 * estimate their selectivity — it guessed one row where there were 71 and
 * concluded the rescan was free. And a `Sort` lands above the join, so `limit`
 * discards nothing: `limit=1` and `limit=100` both took ~30 s, which is why
 * this never looked like a payload problem and never was one.
 */
export async function hydrateEntityRows(
  q: Querier,
  ids: readonly string[],
): Promise<EntityRow[]> {
  if (ids.length === 0) return [];
  const rows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[])`,
    [[...ids]],
  );
  // Postgres does not promise `any(...)` comes back in array order, and the
  // caller's order IS the thread order — it came from the keyset read.
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is EntityRow => row !== undefined);
}

/**
 * A `MessageView` is an `EntitySummary` plus the message-specific content and
 * a reply count — so it comes out of the same assembler as everything else and
 * then gains its message parts. Nothing about a message is derived twice.
 */
export async function toMessageViews(
  q: Querier,
  rows: readonly EntityRow[],
  viewerIdentityId: string,
): Promise<MessageView[]> {
  if (rows.length === 0) return [];
  const summaries = await assembleSummaries(q, rows, viewerIdentityId);
  const byId = new Map(summaries.map((s) => [s.id, s]));

  /*
   * ONE grouped read serves the whole thread footer.
   *
   * The count has always come from here. `lastReplyAt` and the distinct reply
   * authors ride the SAME `group by` rather than arriving as two more
   * round-trips: a `Querier` is one pooled client and cannot run statements
   * concurrently, so a second query here would be strictly serial latency for
   * data the first one is already standing on. `messages_root_created_idx` is
   * `(root_message_id, created_at, entity_id)` — it leads with the grouping
   * column and carries the timestamp, so `max(created_at)` is answered from the
   * index.
   *
   * Authors are ordered by their FIRST reply so the facepile is stable across
   * reads: `min(created_at)` per author, not `array_agg(distinct …)`, whose
   * order Postgres does not promise.
   */
  const replyStats = await q.query<{
    root_message_id: string;
    count: string;
    last_reply_at: string;
    author_ids: string[];
  }>(
    `select root_message_id,
            count(*)::text as count,
            ${MICROS('max(created_at)')} as last_reply_at,
            (select array_agg(author_id order by first_at)
               from (select author_id, min(created_at) first_at
                       from public.messages inner_m
                      where inner_m.root_message_id = m.root_message_id
                      group by author_id) authors) as author_ids
       from public.messages m
      where root_message_id = any($1::uuid[])
      group by root_message_id`,
    [rows.map((r) => r.id)],
  );
  const stats = new Map(replyStats.map((r) => [r.root_message_id, r]));

  const partRows = await q.query<{
    message_id: string;
    seq: number;
    kind: MessagePart['kind'];
    payload: unknown;
    created_at: string;
  }>(
    `select message_id, seq, kind, payload,
            ${MICROS('created_at')} as created_at
       from public.message_parts
      where message_id = any($1::uuid[])
      order by message_id, seq`,
    [rows.map((r) => r.id)],
  );
  /*
   * The wire marker for a claimed chat turn. `createAgentMessage`
   * (chat/orchestrator.ts) must give the agent's message a body at claim time
   * — `messages.body` is CHECK-constrained non-empty — so it writes the
   * 'Agent turn in progress.' placeholder, and `complete_chat_turn` replaces
   * it. Until then that body is a claim, not content, and clients used to
   * recognise it by string-matching the sentence. Projecting the turn binding
   * here lets them suppress by identity instead.
   */
  const inFlightRows = await q.query<{ agent_message_id: string }>(
    `select agent_message_id
       from public.chat_turns
      where agent_message_id = any($1::uuid[])
        and state in ('queued', 'running')`,
    [rows.map((r) => r.id)],
  );
  const inFlight = new Set(inFlightRows.map((r) => r.agent_message_id));

  const parts = new Map<string, MessagePart[]>();
  for (const row of partRows) {
    const part = MessagePartSchema.parse({
      seq: Number(row.seq),
      kind: row.kind,
      payload: row.payload,
      createdAt: iso(row.created_at),
    });
    const messageParts = parts.get(row.message_id) ?? [];
    messageParts.push(part);
    parts.set(row.message_id, messageParts);
  }

  /*
   * The facepile names PEOPLE, so it needs actor summaries, not raw ids — and
   * one author is typically in several threads on a page, so they are loaded
   * once for the whole batch rather than per root.
   */
  const replyAuthorIds = [...new Set(replyStats.flatMap((r) => r.author_ids ?? []))];
  const replyActors = await loadActors(q, replyAuthorIds);

  const views: MessageView[] = [];
  for (const row of rows) {
    const summary = byId.get(row.id);
    if (!summary) continue;
    const state = summary.state;
    const content = contentOf(row);
    if (state.kind !== 'message' || content.kind !== 'message') continue;
    const stat = stats.get(row.id);
    const messageParts = parts.get(row.id);
    views.push({
      ...summary,
      state,
      content,
      replyCount: stat ? Number(stat.count) : 0,
      // `null` on an unreplied root is the honest spelling: there is no last
      // reply, which is a different fact from "we did not look".
      lastReplyAt: stat ? iso(stat.last_reply_at) : null,
      replyParticipants: (stat?.author_ids ?? [])
        .map((id) => replyActors.get(id))
        .filter((actor): actor is NonNullable<typeof actor> => actor !== undefined),
      ...(messageParts ? { parts: messageParts } : {}),
      ...(inFlight.has(row.id) ? { turnInFlight: true } : {}),
    });
  }
  return views;
}

export async function loadMessageViewsByIds(
  q: Querier,
  ids: readonly string[],
  viewerIdentityId: string,
): Promise<MessageView[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const rows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM}
      where e.id = any($1::uuid[]) and e.kind = 'message'`,
    [unique],
  );
  const views = await toMessageViews(q, rows, viewerIdentityId);
  const byId = new Map(views.map((view) => [view.id, view]));
  return unique.map((id) => byId.get(id)).filter((view): view is MessageView => view !== undefined);
}

/**
 * A Discussion tab needs enough of a normal branch to show that an agent's
 * message is a reply, without turning the roots read into an unbounded thread
 * dump. Only branches whose complete reply set fits under this cap are
 * embedded; larger branches retain their authoritative `replyCount` and stay
 * available through the existing root-scoped pagination endpoint.
 */
const EMBEDDED_REPLY_LIMIT = 20;

async function embedBoundedReplies(
  q: Querier,
  anchorId: string,
  roots: readonly MessageView[],
  viewerIdentityId: string,
): Promise<MessageView[]> {
  const eligibleRootIds = roots
    .filter((root) => root.replyCount > 0 && root.replyCount <= EMBEDDED_REPLY_LIMIT)
    .map((root) => root.id);
  if (eligibleRootIds.length === 0) return [...roots];

  // Ids first, envelopes second — see `hydrateEntityRows`. This read is the
  // one the Discussion tab pays on every anchor open, so it carried the same
  // per-row rescan of `entities` as the page read above.
  const keyRows = await q.query<{ id: string }>(
    `select msg.entity_id as id
       from public.messages msg
      where msg.anchor_id = $1
        and msg.root_message_id = any($2::uuid[])
      order by msg.root_message_id asc, msg.created_at asc, msg.entity_id asc`,
    [anchorId, eligibleRootIds],
  );
  const rows = await hydrateEntityRows(q, keyRows.map((row) => row.id));
  const replies = await toMessageViews(q, rows, viewerIdentityId);
  const byRoot = new Map<string, MessageView[]>();
  for (const reply of replies) {
    const rootId = reply.state.rootMessageId;
    if (!rootId) continue;
    const branch = byRoot.get(rootId) ?? [];
    branch.push(reply);
    byRoot.set(rootId, branch);
  }

  return roots.map((root) => {
    const branch = byRoot.get(root.id);
    return branch
      ? { ...root, replies: { items: branch, nextCursor: null } }
      : root;
  });
}

function cursorFingerprint(
  anchorId: string,
  rootMessageId: string | null,
  order: 'oldest' | 'newest',
): string {
  return createHash('sha256')
    .update(JSON.stringify({ operation: 'messages.list', anchorId, rootMessageId, order }))
    .digest('hex');
}

export function messagesList(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
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
    const anchorId = requireUuidParam(ctx, 'anchorId');
    const limit = limitOf(ctx.query.get('limit'));
    const cursor = ctx.query.get('cursor');
    const rawOrder = ctx.query.get('order');
    if (rawOrder !== null && rawOrder !== 'oldest' && rawOrder !== 'newest') {
      throw new CollabError('invalid_input', 'order must be oldest or newest');
    }
    const order: 'oldest' | 'newest' = rawOrder ?? 'oldest';
    // `?rootMessageId=` switches from "thread roots" to "replies under a root".
    const rootMessageId = ctx.query.get('rootMessageId');
    if (rootMessageId && !/^[0-9a-f-]{36}$/i.test(rootMessageId)) {
      throw new CollabError('not_found', `no such rootMessageId: ${rootMessageId}`);
    }
    const fingerprint = cursorFingerprint(anchorId, rootMessageId, order);

    return deps.db.tx({
      ...claimsFor(owner, ctx),
      identityId: viewerIdentityId,
      nodeAdmin: viewerIdentityId === owner.identityId ? owner.isNodeAdmin : false,
    }, async (q) => {
      const params: unknown[] = [anchorId];
      let scope: string;
      if (rootMessageId) {
        params.push(rootMessageId);
        scope = `msg.root_message_id = $${params.length}`;
      } else {
        // Roots only: a message with no root IS a root.
        scope = 'msg.root_message_id is null';
      }

      let keyset = '';
      if (cursor) {
        const { k } = decodeCursor(cursor);
        if (k.length !== 3 || k[0] !== fingerprint) {
          throw new CollabError('invalid_cursor', 'cursor does not match this message thread');
        }
        params.push(String(k[1]), String(k[2]));
        const comparator = order === 'newest' ? '<' : '>';
        // `msg.entity_id` rather than `e.id`: identical value — the join is
        // `msg.entity_id = e.id` — but the keyset now runs against `messages`
        // alone, before `entities` is touched at all.
        keyset = `and (msg.created_at, msg.entity_id) ${comparator} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }

      // Threads default to oldest-first, while callers polling a busy anchor
      // can start at the newest edge without walking the whole history.
      //
      // `msg.created_at` is carried as TEXT deliberately, and it is
      // load-bearing for pagination in two independent ways. ENTITY_COLUMNS selects
      // `e.created_at` — the ENVELOPE's timestamp — and never this column, so a
      // cursor built from an `EntityRow` compares the wrong clock against the
      // keyset below. And a `timestamptz` handed back as a JavaScript `Date`
      // keeps only MILLISECONDS, while Postgres stores MICROSECONDS, so the
      // encoded value lands strictly BEFORE the row it came from. Either one
      // alone makes `(msg.created_at, e.id) > (cursor…)` re-admit that row and
      // the thread never advances past its first page.
      //
      // `MICROS` rather than `::text`: both keep the microseconds and both cast
      // back to the identical instant, but `::text` renders in the SESSION's
      // timezone and strips trailing zeros, so the same instant spells
      // differently depending on server config and carries a variable number of
      // fractional digits. This is now the one idiom every cursor in the
      // codebase uses, which is what lets the truncation detector stay simple.
      //
      // KEYSET FIRST, ENVELOPES SECOND. This selects from `public.messages`
      // alone: no `ENTITY_FROM`, so no 25-table join chain to rebuild per
      // candidate row, and `messages_root_created_idx`
      // `(root_message_id, created_at, entity_id)` supplies this exact ordering
      // from the index — which retires the `Sort` that used to sit above the
      // join and made `limit` decorative. `limit` is now load-bearing: a
      // one-message page reads one message. See `hydrateEntityRows` for the
      // measurements.
      //
      // Splitting the read does not widen what a viewer can see. RLS applies to
      // both halves and the conjunction is unchanged: `messages_select` demands
      // `entity_readable(entity_id) and entity_readable(anchor_id)` here, and
      // `entities_select` demands `entity_row_visible(...)` on the hydrate.
      // `entity_readable` is the STRICTER of the two — it additionally requires
      // `deleted_at is null` — so the hydrate can never drop a row this read
      // admitted, and the page cannot come back short.
      type MessageKeyRow = { id: string; message_created_at: string };
      const keyRows = await q.query<MessageKeyRow>(
        `select msg.entity_id as id, ${MICROS('msg.created_at')} as message_created_at
           from public.messages msg
          where msg.anchor_id = $1 and ${scope} ${keyset}
          order by msg.created_at ${order === 'newest' ? 'desc' : 'asc'}, msg.entity_id ${order === 'newest' ? 'desc' : 'asc'}
          limit ${limit + 1}`,
        params,
      );

      const hasMore = keyRows.length > limit;
      const pageKeys = hasMore ? keyRows.slice(0, limit) : keyRows;
      const pageRows = await hydrateEntityRows(q, pageKeys.map((row) => row.id));
      const listed = await toMessageViews(q, pageRows, viewerIdentityId);
      const items = rootMessageId
        ? listed
        : await embedBoundedReplies(q, anchorId, listed, viewerIdentityId);
      // The cursor comes from the KEYSET row, not the hydrated envelope: only
      // the keyset read carries `msg.created_at`, and it is the column the next
      // page's comparator is written against.
      const last = pageKeys[pageKeys.length - 1];

      const page: Page<MessageView> = {
        items,
        nextCursor:
          hasMore && last
            // Encoded verbatim: this is already the exact text of the column
            // the keyset compares. Routing it through a `Date` is what
            // truncated it to milliseconds and stalled the walk.
            ? encodeCursor([fingerprint, last.message_created_at, last.id])
            : null,
      };
      return page;
    });
  };
}
