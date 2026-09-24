/**
 * A CREDENTIAL LOGIN TERMINAL IS NOT WORK, and the COUNT has to know it too.
 *
 * `projectRows` (tm8-ui) has dropped `sessionKind === 'credential'` from every
 * list since 082/Ruling 16, but `collections.query` never knew about it. So
 * `page.items` carried rows the client refused to render and `page.total`
 * counted them — the two could not agree by construction. Measured on the
 * launch node 2026-08-21: the session list's To Do tab read "1" over ZERO
 * rows, because the space's only to_do session was an eight-day-old `spawning`
 * credential terminal, and Done was inflated by eight more.
 *
 * THE COUNT IS THE HALF THAT MATTERS, and it is why this file asserts TWO
 * statements rather than one. `queryTotal` runs its own `count(*)` over
 * `baseWhere`; a fix applied to the page's SELECT alone would leave the number
 * wrong while every visible row looked right — which is exactly the shape of
 * the original defect, one layer down.
 *
 * `is distinct from` and NOT `<> 'credential'`: `ws.session_kind` is NULL on
 * every row that is not a work_session, and `<>` would drop the entire graph.
 * Asserted verbatim, because that mistake is silent and total.
 */
import { describe, expect, it } from 'vitest';

import type { CollectionQuery } from '@tm8/contract';
import type { Querier } from '../../src/db/types.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';

const SPACE_ID = '00000000-0000-7000-8000-0000000005c1';
const PREDICATE = `ws.session_kind is distinct from 'credential'`;

/**
 * Records every statement the handler issues; answers all of them empty EXCEPT
 * the page probe, which comes back FULL.
 *
 * Full on purpose: a short first page is its own total and the executor skips
 * the count (see `pageIsWholeMatch`), which would leave the count — the half
 * of this file that matters — unexercised. `limit: 1` below plus two probe
 * rows is the smallest page that still has to be counted.
 */
function recordingQuerier(seen: string[]): Querier {
  return {
    query: async <R>(sql: string): Promise<R[]> => {
      seen.push(sql);
      if (sql.includes(' as __sort')) {
        return [1, 2].map((n) => ({
          id: `00000000-0000-7000-8000-00000000000${n}`,
          space_id: SPACE_ID,
          kind: 'work_session',
          visibility: 'space',
          activity_at: '2026-09-24T10:00:00.000Z',
          created_at: '2026-09-24T10:00:00.000Z',
          updated_at: '2026-09-24T10:00:00.000Z',
          deleted_at: null,
          __sort: '2026-09-24T10:00:00.000Z',
          __sort_cursor: '2026-09-24T10:00:00.000Z',
        })) as unknown as R[];
      }
      return [] as R[];
    },
    rpc: async <T>(): Promise<T> => ({}) as T,
  };
}

describe('collections.query excludes credential login terminals', () => {
  it('pushes the predicate into the page query AND the count', async () => {
    const seen: string[] = [];
    const query = {
      spaceId: SPACE_ID,
      kinds: ['work_session'],
      filters: { category: ['to_do'] },
      limit: 1,
    } as unknown as CollectionQuery;

    await queryCollection(recordingQuerier(seen), query, 'viewer-1');

    // The page's SELECT is the one that carries the sort expression; the
    // count is the one that starts with `count(*)`. Naming them structurally
    // keeps this from passing on a single statement that happens to contain
    // the predicate twice.
    const page = seen.filter((sql) => sql.includes(' as __sort'));
    const counts = seen.filter((sql) => sql.includes('count(*)::int as total'));
    expect(page).toHaveLength(1);
    expect(counts).toHaveLength(1);

    expect(page[0]).toContain(PREDICATE);
    expect(counts[0]).toContain(PREDICATE);
  });

  it('applies to every kind, not only work_session', async () => {
    // The predicate rides `buildWhere`, so an unfiltered read of the whole
    // space carries it too. That is deliberate: a credential terminal must not
    // appear in a mixed list either, and `is distinct from` is what keeps the
    // NULL `session_kind` of every non-session row passing.
    const seen: string[] = [];
    await queryCollection(
      recordingQuerier(seen),
      { spaceId: SPACE_ID, limit: 1 } as unknown as CollectionQuery,
      'viewer-1',
    );
    // Both statements that select FROM the query's WHERE carry it; the rest
    // of `seen` is the assembler's per-id batch loads for the full page.
    const page = seen.filter((sql) => sql.includes(' as __sort'));
    const counts = seen.filter((sql) => sql.includes('count(*)::int as total'));
    expect(page).toHaveLength(1);
    expect(counts).toHaveLength(1);
    expect(page[0]).toContain(PREDICATE);
    expect(counts[0]).toContain(PREDICATE);
  });
});
