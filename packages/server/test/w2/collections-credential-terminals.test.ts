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

/** Records every statement the handler issues; answers all of them empty. */
function recordingQuerier(seen: string[]): Querier {
  return {
    query: async <R>(sql: string): Promise<R[]> => {
      seen.push(sql);
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
      { spaceId: SPACE_ID } as unknown as CollectionQuery,
      'viewer-1',
    );
    expect(seen.filter((sql) => sql.includes(PREDICATE))).toHaveLength(seen.length);
    expect(seen.length).toBeGreaterThan(1);
  });
});
