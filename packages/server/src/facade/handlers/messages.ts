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
  decodeCursor,
  encodeCursor,
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

  const rows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM}
      where msg.anchor_id = $1
        and msg.root_message_id = any($2::uuid[])
      order by msg.root_message_id asc, msg.created_at asc, e.id asc`,
    [anchorId, eligibleRootIds],
  );
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

function cursorFingerprint(anchorId: string, rootMessageId: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify({ operation: 'messages.list', anchorId, rootMessageId }))
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
    // `?rootMessageId=` switches from "thread roots" to "replies under a root".
    const rootMessageId = ctx.query.get('rootMessageId');
    if (rootMessageId && !/^[0-9a-f-]{36}$/i.test(rootMessageId)) {
      throw new CollabError('not_found', `no such rootMessageId: ${rootMessageId}`);
    }
    const fingerprint = cursorFingerprint(anchorId, rootMessageId);

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
        keyset = `and (msg.created_at, e.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }

      // Threads read oldest-first: a conversation is read in the order it
      // happened, unlike a feed.
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
      type MessageKeysetRow = EntityRow & { message_created_at: string };
      const rows = await q.query<MessageKeysetRow>(
        `select ${ENTITY_COLUMNS}, ${MICROS('msg.created_at')} as message_created_at ${ENTITY_FROM}
          where msg.anchor_id = $1 and ${scope} ${keyset}
          order by msg.created_at asc, e.id asc
          limit ${limit + 1}`,
        params,
      );

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const listed = await toMessageViews(q, pageRows, viewerIdentityId);
      const items = rootMessageId
        ? listed
        : await embedBoundedReplies(q, anchorId, listed, viewerIdentityId);
      const last = pageRows[pageRows.length - 1];

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
