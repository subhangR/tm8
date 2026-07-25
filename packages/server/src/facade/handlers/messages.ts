/**
 * `messages.list` / `messages.send` — the task thread the user watches while
 * an agent works.
 *
 * Threads are ADDRESSED BY ANCHOR (02 §3.4): a message hangs off whatever
 * entity it is about, so a task's discussion and a channel's discussion are the
 * same mechanism. `messages.list` returns the ROOTS of the thread with their
 * reply counts; replies are fetched per root. A flat list of every message
 * would make a 500-message channel unusable and would lose the reply structure
 * the UI renders.
 */
import {
  CollabError,
  decodeCursor,
  encodeCursor,
  type MessageView,
  type Page,
  type PostMessageInput,
} from '@tm8/contract';
import type { Querier } from '../../db/types.js';
import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, commandEnvelope, limitOf, requireUuidParam } from '../context.js';
import {
  assembleSummaries,
  contentOf,
  ENTITY_COLUMNS,
  ENTITY_FROM,
  type EntityRow,
} from '../entity-read.js';
import { toCommandResult, type RpcCommandResult } from './entities.js';

/**
 * A `MessageView` is an `EntitySummary` plus the message-specific content and
 * a reply count — so it comes out of the same assembler as everything else and
 * then gains its message parts. Nothing about a message is derived twice.
 */
async function toMessageViews(
  q: Querier,
  rows: readonly EntityRow[],
  viewerIdentityId: string,
): Promise<MessageView[]> {
  if (rows.length === 0) return [];
  const summaries = await assembleSummaries(q, rows, viewerIdentityId);
  const byId = new Map(summaries.map((s) => [s.id, s]));

  const replyCounts = await q.query<{ root_message_id: string; count: string }>(
    `select root_message_id, count(*)::text as count
       from public.messages
      where root_message_id = any($1::uuid[])
      group by root_message_id`,
    [rows.map((r) => r.id)],
  );
  const counts = new Map(replyCounts.map((r) => [r.root_message_id, Number(r.count)]));

  const views: MessageView[] = [];
  for (const row of rows) {
    const summary = byId.get(row.id);
    if (!summary) continue;
    const state = summary.state;
    const content = contentOf(row);
    if (state.kind !== 'message' || content.kind !== 'message') continue;
    views.push({
      ...summary,
      state,
      content,
      replyCount: counts.get(row.id) ?? 0,
    });
  }
  return views;
}

export function messagesList(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const anchorId = requireUuidParam(ctx, 'anchorId');
    const limit = limitOf(ctx.query.get('limit'));
    const cursor = ctx.query.get('cursor');
    // `?rootMessageId=` switches from "thread roots" to "replies under a root".
    const rootMessageId = ctx.query.get('rootMessageId');

    return deps.db.tx(claimsFor(owner, ctx), async (q) => {
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
        if (k.length !== 2) {
          throw new CollabError('invalid_cursor', 'invalid cursor: expected [createdAt, id]');
        }
        params.push(String(k[0]), String(k[1]));
        keyset = `and (msg.created_at, e.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }

      // Threads read oldest-first: a conversation is read in the order it
      // happened, unlike a feed.
      const rows = await q.query<EntityRow>(
        `select ${ENTITY_COLUMNS} ${ENTITY_FROM}
          where msg.anchor_id = $1 and ${scope} ${keyset}
          order by msg.created_at asc, e.id asc
          limit ${limit + 1}`,
        params,
      );

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = await toMessageViews(q, pageRows, owner.identityId);
      const last = pageRows[pageRows.length - 1];

      const page: Page<MessageView> = {
        items,
        nextCursor:
          hasMore && last
            ? encodeCursor([
                last.created_at instanceof Date
                  ? last.created_at.toISOString()
                  : new Date(last.created_at).toISOString(),
                last.id,
              ])
            : null,
      };
      return page;
    });
  };
}

export function messagesPost(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const input = ctx.body as PostMessageInput;

    return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<RpcCommandResult>('post_message', [
        input.anchorId,
        input.body,
        envelope.actorId ?? null,
        input.parentMessageId ?? null,
        JSON.stringify(input.mentions ?? []),
        JSON.stringify(input.attachments ?? []),
        envelope.clientMutationId ?? null,
      ]);
      const result = await toCommandResult(q, raw, owner.identityId);
      return { kind: 'json' as const, status: 201, data: result };
    });
  };
}
