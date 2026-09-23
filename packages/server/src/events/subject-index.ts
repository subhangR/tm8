/**
 * The `subject_ids` index gate — what the scoped change feed (`events.changes`,
 * spec doc 01a0cf35 §5) asks before it reads `workspace_events` by subject.
 *
 * Migration 204 added `workspace_events.subject_ids` and backfills existing rows
 * online, newest first. Per space it records `indexedFrom`: EVERY row with
 * `seq >= indexedFrom` has `subject_ids` set. Below it, a row may still be NULL,
 * and a NULL row is NOT a non-match — it is unknown. There is one query path and
 * no jsonb fallback, so a request whose window reaches below the watermark is
 * refused, never answered partially.
 *
 * A request `after = N` examines rows with `seq > N`, i.e. `seq >= N + 1`. It is
 * fully covered exactly when `N + 1 >= indexedFrom`. The retry hint therefore
 * names `indexedFrom - 1`: the smallest cursor that is covered. Naming
 * `indexedFrom` itself would make the retry skip the row AT the watermark.
 */

import { CollabError } from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';

/** `details.reason` on the refusal. Step 3 surfaces it as the `index_incomplete` error. */
export const INDEX_INCOMPLETE = 'index_incomplete';

/** The space's watermark: 1 when every row is indexed. */
export async function readIndexedFrom(db: Db, claims: DbClaims, spaceId: string): Promise<number> {
  const raw = await db.rpc<string | number | null>(claims, 'public.event_subject_indexed_from', [spaceId]);
  const value = Number(raw ?? 1);
  if (!Number.isSafeInteger(value) || value < 1) {
    // A watermark we cannot read is not permission to read unindexed rows.
    throw new CollabError('invariant_violation', `unreadable subject index watermark: ${String(raw)}`);
  }
  return value;
}

/** The smallest `after` cursor the index fully covers for a given watermark. */
export function minCoveredAfter(indexedFrom: number): number {
  return Math.max(indexedFrom - 1, 0);
}

/** Throws `index_incomplete` when rows `seq > after` are not all indexed. */
export function assertIndexCovers(after: number, indexedFrom: number): void {
  const min = minCoveredAfter(indexedFrom);
  if (after >= min) return;
  throw new CollabError(
    'invalid_cursor',
    `the change index is still being backfilled below seq ${String(indexedFrom)}; ` +
      `retry with --after ${String(min)}, or tm8 event list`,
    {
      details: {
        reason: INDEX_INCOMPLETE,
        indexedFrom,
        hint: `retry with --after ${String(min)}, or tm8 event list`,
      },
      retryable: false,
    },
  );
}

/**
 * Read the watermark and gate `after` against it in one call. Returns the
 * watermark so the caller can report it.
 */
export async function gateSubjectIndex(
  db: Db,
  claims: DbClaims,
  spaceId: string,
  after: number,
): Promise<{ indexedFrom: number }> {
  const indexedFrom = await readIndexedFrom(db, claims, spaceId);
  assertIndexCovers(after, indexedFrom);
  return { indexedFrom };
}
