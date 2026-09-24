/**
 * `Page.total` is not recounted when the page already IS the whole match.
 *
 * `queryTotal` runs `count(*)` over the same FROM and WHERE as the page. When
 * the page had no cursor and its `limit n+1` probe came back short, those two
 * statements count the same rows — so the aggregate is pure repetition, and
 * under RLS it is expensive repetition: a predicate that reaches
 * `public.messages` (`needsActorId`, `mentionedActorId`) is a full scan with
 * two `entity_readable()` calls per row in whichever statement runs it.
 * Measured on a prod copy (2026-09-24, as `tm8_app`): the three `spaces.home`
 * preset counts were 1.83 s of the request's 5.57 s of Postgres time.
 *
 * What must NOT change is the phase-7 ruling the count exists for: a CLIPPED
 * page, or a page past a cursor, still reports the true size of the query —
 * `test/db/status-category.pg.test.ts` pins that against a real database; the
 * cases below pin which statements the executor issues to get there.
 */
import { describe, expect, it } from 'vitest';

import type { CollectionQuery } from '@tm8/contract';
import type { Querier } from '../../src/db/types.js';
import type { EntityRow } from '../../src/facade/entity-read.js';
import { pageIsWholeMatch, queryCollection } from '../../src/facade/handlers/collections.js';

const SPACE_ID = '00000000-0000-7000-8000-0000000007a1';
const MEMBER_ID = '00000000-0000-7000-8000-0000000007a2';

function taskRow(n: number): EntityRow & { __sort: string; __sort_cursor: string } {
  const id = `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const at = `2026-09-24T10:00:${String(59 - n).padStart(2, '0')}.000Z`;
  return {
    id,
    space_id: SPACE_ID,
    kind: 'task',
    parent_id: null,
    position: n,
    visibility: 'space',
    version: 1,
    activity_at: at,
    created_at: at,
    updated_at: at,
    deleted_at: null,
    created_by: MEMBER_ID,
    likes: 0,
    dislikes: 0,
    stars: 0,
    points: 0,
    messages: 0,
    task_title: `Task ${n}`,
    task_description: null,
    task_axes: {},
    work_status: 'open',
    priority: 'medium',
    acceptance_criteria: [],
    __sort: at,
    __sort_cursor: at,
  } as unknown as EntityRow & { __sort: string; __sort_cursor: string };
}

/**
 * Answers the page SELECT with `pageRows` and the count with `countTotal`;
 * everything else (the assembler's batched loads) empty.
 */
function recordingQuerier(seen: string[], pageRows: number, countTotal = 999): Querier {
  return {
    query: async <R>(sql: string): Promise<R[]> => {
      seen.push(sql);
      if (sql.includes(' as __sort')) {
        return Array.from({ length: pageRows }, (_, i) => taskRow(i + 1)) as unknown as R[];
      }
      if (sql.includes('count(*)::int as total')) return [{ total: countTotal }] as unknown as R[];
      return [] as R[];
    },
    rpc: async <T>(): Promise<T> => [] as unknown as T,
  };
}

const counts = (seen: string[]): string[] => seen.filter((sql) => sql.includes('count(*)::int as total'));

describe('pageIsWholeMatch', () => {
  it('is true only without a cursor AND with a short probe', () => {
    expect(pageIsWholeMatch(undefined, 0, 51)).toBe(true);
    expect(pageIsWholeMatch(undefined, 50, 51)).toBe(true);
    // The probe filled: there is at least one row beyond the page.
    expect(pageIsWholeMatch(undefined, 51, 51)).toBe(false);
    // A cursor narrows the page's WHERE below the count's, so a short page
    // past a cursor says nothing about the rows BEFORE it.
    expect(pageIsWholeMatch('opaque-cursor', 3, 51)).toBe(false);
    expect(pageIsWholeMatch('', 3, 51)).toBe(true);
    expect(pageIsWholeMatch(null, 3, 51)).toBe(true);
  });
});

describe('queryCollection total', () => {
  it('reports a short first page by its length and issues no count', async () => {
    const seen: string[] = [];
    const query = { spaceId: SPACE_ID, kinds: ['task'], limit: 5 } as unknown as CollectionQuery;

    const result = await queryCollection(recordingQuerier(seen, 3), query, 'viewer-1');

    expect(result.page.items).toHaveLength(3);
    expect(result.page.total).toBe(3);
    expect(result.page.nextCursor).toBeNull();
    expect(counts(seen)).toHaveLength(0);
  });

  it('reports an EMPTY first page as a total of zero and issues no count', async () => {
    const seen: string[] = [];
    const query = { spaceId: SPACE_ID, kinds: ['task'] } as unknown as CollectionQuery;

    const result = await queryCollection(recordingQuerier(seen, 0), query, 'viewer-1');

    expect(result.page.total).toBe(0);
    expect(counts(seen)).toHaveLength(0);
  });

  it('still counts the query when the page is CLIPPED', async () => {
    const seen: string[] = [];
    const query = { spaceId: SPACE_ID, kinds: ['task'], limit: 2 } as unknown as CollectionQuery;

    // limit 2 → the probe asks for 3 and gets 3: there is more.
    const result = await queryCollection(recordingQuerier(seen, 3, 17), query, 'viewer-1');

    expect(result.page.items).toHaveLength(2);
    expect(result.page.nextCursor).not.toBeNull();
    expect(result.page.total).toBe(17);
    expect(counts(seen)).toHaveLength(1);
  });

  it('still counts the query on a page past a cursor, however short', async () => {
    const first: string[] = [];
    const query = { spaceId: SPACE_ID, kinds: ['task'], limit: 2 } as unknown as CollectionQuery;
    const page1 = await queryCollection(recordingQuerier(first, 3, 17), query, 'viewer-1');
    const cursor = page1.page.nextCursor;
    expect(cursor).not.toBeNull();

    const seen: string[] = [];
    const page2 = await queryCollection(
      recordingQuerier(seen, 1, 17),
      { ...query, cursor } as unknown as CollectionQuery,
      'viewer-1',
    );

    expect(page2.page.items).toHaveLength(1);
    expect(page2.page.total).toBe(17);
    expect(counts(seen)).toHaveLength(1);
  });
});
