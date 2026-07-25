/**
 * Activity pages — the compact feed under an entity and on the space home.
 *
 * Keyset-paged on `(created_at, id)`, the same shape every other list uses.
 * The `id` tiebreaker matters: several activity rows are written in one
 * transaction (create + attach + work-change), so `created_at` alone is not
 * unique and a cursor built on it would skip rows at a page boundary.
 */
import { encodeCursor, decodeCursor, CollabError, type ActivityItem, type Page } from '@tm8/contract';
import type { Querier } from '../../db/types.js';
import { loadActors, actorOf, iso } from '../entity-read.js';

interface ActivityRow {
  id: string;
  entity_id: string | null;
  actor_id: string | null;
  verb: string;
  summary: Record<string, unknown>;
  ref_id: string | null;
  created_at: Date | string;
}

export interface ActivityQuery {
  /** Space feed. Mutually exclusive with `entityId`. */
  spaceId?: string;
  /** One entity's history. */
  entityId?: string;
  limit?: number;
  cursor?: string;
}

export async function loadActivity(q: Querier, query: ActivityQuery): Promise<Page<ActivityItem>> {
  const params: unknown[] = [];
  const where: string[] = [];

  if (query.entityId) {
    params.push(query.entityId);
    where.push(`a.entity_id = $${params.length}`);
  } else if (query.spaceId) {
    params.push(query.spaceId);
    where.push(`a.space_id = $${params.length}`);
  } else {
    throw new CollabError('invalid_input', 'activity requires a spaceId or an entityId');
  }

  if (query.cursor) {
    const { k } = decodeCursor(query.cursor);
    if (k.length !== 2) throw new CollabError('invalid_cursor', 'invalid cursor: expected [createdAt, id]');
    params.push(String(k[0]), String(k[1]));
    where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const rows = await q.query<ActivityRow>(
    `select a.id, a.entity_id, a.actor_id, a.verb, a.summary, a.ref_id, a.created_at
       from public.activity a
      where ${where.join(' and ')}
      order by a.created_at desc, a.id desc
      limit ${limit + 1}`,
    params,
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const actors = await loadActors(q, pageRows.map((r) => r.actor_id ?? ''));

  const items: ActivityItem[] = pageRows.map((row) => ({
    id: row.id,
    entityId: row.entity_id,
    actor: row.actor_id ? actorOf(actors, row.actor_id) : null,
    verb: row.verb,
    summary: row.summary ?? {},
    createdAt: iso(row.created_at),
    refId: row.ref_id,
  }));

  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor([iso(last.created_at), last.id]) : null,
  };
}
