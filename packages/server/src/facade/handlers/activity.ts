/**
 * Activity pages — the compact feed under an entity and on the space home.
 *
 * Keyset-paged on `(created_at, id)`, the same shape every other list uses.
 * The `id` tiebreaker matters: several activity rows are written in one
 * transaction (create + attach + work-change), so `created_at` alone is not
 * unique and a cursor built on it would skip rows at a page boundary.
 */
import {
  encodeCursor,
  decodeCursor,
  CollabError,
  ISO_TIMESTAMP_RE,
  type ActivityItem,
  type Page,
} from '@tm8/contract';
import type { Querier } from '../../db/types.js';
import { loadActors, actorOf, iso, MICROS } from '../entity-read.js';

interface ActivityRow {
  id: string;
  entity_id: string | null;
  actor_id: string | null;
  verb: string;
  summary: Record<string, unknown>;
  ref_id: string | null;
  created_at: Date | string;
  /**
   * The keyset value, as microsecond TEXT straight from Postgres — never the
   * `created_at` column above, which node-pg hands back as a JavaScript `Date`
   * carrying only MILLISECONDS.
   *
   * MEASURED, not reasoned: with the cursor built through `iso()` this walk
   * seeded nine rows, returned three, and SILENTLY DROPPED THE REMAINING SIX.
   * The truncation rounds DOWN, every dropped row is strictly greater than the
   * truncated value, and the `<` keyset below is DESC — so there is no error,
   * no duplicate and no loop, which is why a terminates-plus-no-duplicates
   * assertion walks straight over it.
   *
   * ⚠ DECLARING THIS REQUIRED DOES NOT MAKE A FORGOTTEN `to_char` A COMPILE
   * ERROR — `Querier.query<R>` (db/types.ts:45) takes `R` as an unchecked
   * caller assertion and never sees a SELECT list. Only an object-literal
   * producer is checked, and this row only ever comes from SQL. The invariant
   * is held by the ONE producer below — the `MICROS('a.created_at')` term in
   * `loadActivity`'s SELECT, cited by name because a line number is the one
   * coordinate guaranteed to go stale. A SECOND producer is a decision, not an
   * oversight. `sortKeyOf` (handlers/collections.ts, `sortKeyOf`) is the shape
   * that actually refuses at runtime rather than trusting its callers.
   */
  cursor_created_at: string;
}

export interface ActivityQuery {
  /** Space feed. Mutually exclusive with `entityId`. */
  spaceId?: string;
  /** One entity's history. */
  entityId?: string;
  limit?: number;
  cursor?: string;
}

/**
 * The keyset instant out of a decoded cursor, or a refusal.
 *
 * MODELLED ON `sortKeyOf` (handlers/collections.ts), WHICH REFUSES ON **TWO**
 * CONDITIONS, AND BOTH ARE REPRODUCED HERE ON PURPOSE:
 *
 *   1. absent or null — nothing to compare against;
 *   2. PRESENT BUT NOT EXACT TEXT — the condition a guard built only on
 *      `Date.parse` silently drops, and the one that matters most here.
 *
 * Measured, because the second is not obvious: `Date.parse` ADMITS `'2026'`,
 * `'2026-07'`, a space-separated `'… 14:59:01.891820Z'`, and an OFFSET form
 * `'…+05:30'` that the contract's own `IsoTimestamp` calls invalid. It also
 * admits the NUMBER `123`, because a bare `String(k[0])` turns it into
 * `'123'`. Every one of those would be handed to Postgres as a keyset value.
 *
 * `ISO_TIMESTAMP_RE` (contract schemas.ts) is REUSED rather than reinvented —
 * it is already the published shape of an `IsoTimestamp`, it requires the
 * terminal `Z` that `MICROS` always emits, and a fourth private spelling of
 * this check is exactly the duplication that let the cursor class hide.
 *
 * WHY REFUSING BEATS PASSING IT THROUGH: previously a client string reached
 * `$::timestamptz` verbatim, so ordinary bad input surfaced as SQLSTATE 22007
 * — an UNMAPPED error and a 5xx-class failure, with nothing telling the caller
 * its cursor was the problem. A cursor is client input; a bad one is a client
 * error (DEV-5), never a server fault.
 */
function cursorInstant(raw: unknown): string {
  if (raw === null || raw === undefined) {
    throw new CollabError('invalid_cursor', 'invalid cursor: createdAt is missing');
  }
  if (typeof raw !== 'string' || !ISO_TIMESTAMP_RE.test(raw)) {
    throw new CollabError(
      'invalid_cursor',
      'invalid cursor: createdAt must be an ISO-8601 UTC timestamp',
    );
  }
  return raw;
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
    params.push(cursorInstant(k[0]), String(k[1]));
    where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const rows = await q.query<ActivityRow>(
    `select a.id, a.entity_id, a.actor_id, a.verb, a.summary, a.ref_id, a.created_at,
            ${MICROS('a.created_at')} cursor_created_at
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
    // Carried verbatim — never through a JS `Date`. See ActivityRow.cursor_created_at:
    // `iso(last.created_at)` here is what dropped six of nine rows.
    nextCursor: hasMore && last ? encodeCursor([last.cursor_created_at, last.id]) : null,
  };
}
