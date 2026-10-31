/**
 * S5 (mobile LLD §5.1): `collections.query {tree: {depth, perParent}}`. The
 * bounds are the contract and are refused, never clamped; only a collection
 * query takes the option; the result carries at most two levels of at most
 * 200 rows each.
 */
import { describe, expect, it } from 'vitest';
import {
  COLLECTION_TREE_LEVEL_MAX, COLLECTION_TREE_MAX_DEPTH,
  CollectionQuerySchema, CollectionResultSchema, GraphQuerySchema,
} from '../src/index.js';
import type { EntitySummary } from '../src/index.js';

const spaceId = '019f9896-928d-79b6-ba1c-1cdcc1d30a6f';
const query = (tree: unknown) => ({ spaceId, kinds: ['task'], parentId: null, tree });

const actor = { id: 'ent_member_1', kind: 'member' as const, displayName: 'Owner', isAgent: false };
const summary = (n: number, parentId: string | null): EntitySummary => ({
  id: `ent_task_${n}`, spaceId: 'space_1', kind: 'task', title: `T-${n}`,
  parentId, position: n, visibility: 'space', version: 1,
  activityAt: '2026-10-29T12:00:00.000Z', createdAt: '2026-10-29T12:00:00.000Z',
  updatedAt: '2026-10-29T12:00:00.000Z', deletedAt: null,
  createdBy: actor, counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
  state: {
    kind: 'task', status: 'open', priority: 'medium', axes: {}, assignees: [], assignments: [],
    acceptance: { total: 0, completed: 0 },
  },
  badges: {},
  childCount: 0,
});

describe('collections.query tree option', () => {
  it('takes depth 1 or 2 and an optional perParent from 1 to 200', () => {
    expect(COLLECTION_TREE_MAX_DEPTH).toBe(2);
    expect(COLLECTION_TREE_LEVEL_MAX).toBe(200);
    for (const tree of [{ depth: 1 }, { depth: 2 }, { depth: 2, perParent: 20 }, { depth: 1, perParent: 1 }, { depth: 2, perParent: 200 }]) {
      expect(CollectionQuerySchema.safeParse(query(tree)).success, JSON.stringify(tree)).toBe(true);
    }
    expect(CollectionQuerySchema.safeParse({ spaceId }).success).toBe(true);
  });

  it('refuses a depth outside 1..2, saying how many levels it reads', () => {
    for (const depth of [0, 3, 1.5, '2', null, undefined]) {
      const parsed = CollectionQuerySchema.safeParse(query({ depth }));
      expect(parsed.success, JSON.stringify(depth)).toBe(false);
      if (!parsed.success) expect(JSON.stringify(parsed.error.issues)).toContain('at most 2 levels are read under the page');
    }
  });

  it('refuses a perParent that is not an integer from 1 to 200', () => {
    for (const perParent of [0, -1, 201, 1000, 2.5, '20']) {
      expect(CollectionQuerySchema.safeParse(query({ depth: 2, perParent })).success, JSON.stringify(perParent)).toBe(false);
    }
  });

  it('is strict: an unknown key inside tree is a typo, not a no-op', () => {
    expect(CollectionQuerySchema.safeParse(query({ depth: 2, perLevel: 50 })).success).toBe(false);
  });

  it('graph.query refuses tree instead of ignoring it', () => {
    expect(GraphQuerySchema.safeParse({ spaceId }).success).toBe(true);
    expect(GraphQuerySchema.safeParse({ spaceId, tree: { depth: 1 } }).success).toBe(false);
  });

  const root = { ...summary(1, null), childCount: 2 };
  const result = (levels: unknown) => ({
    query: { spaceId, kinds: ['task'], parentId: null, tree: { depth: 2, perParent: 20 } },
    page: { items: [root], nextCursor: null, total: 1 },
    tree: { levels },
  });
  const level1 = { depth: 1, parentIds: [root.id], items: [summary(2, root.id), summary(3, root.id)], capped: false };
  const level2 = { depth: 2, parentIds: [], items: [], capped: false };

  it('a result carries one or two levels, each saying whether the bound cut it', () => {
    expect(CollectionResultSchema.safeParse(result([level1, level2])).success).toBe(true);
    expect(CollectionResultSchema.safeParse(result([level1])).success).toBe(true);
    expect(CollectionResultSchema.safeParse(result([])).success).toBe(false);
    expect(CollectionResultSchema.safeParse(result([level1, level2, { ...level2, depth: 3 }])).success).toBe(false);
    expect(CollectionResultSchema.safeParse(result([{ ...level1, capped: undefined }])).success).toBe(false);
  });

  // Parses 400 summaries: given room for a loaded node, where 5s was measured too tight.
  it('a level holds at most 200 rows', { timeout: 30_000 }, () => {
    const full = Array.from({ length: 200 }, (_, i) => summary(10 + i, root.id));
    expect(CollectionResultSchema.safeParse(result([{ ...level1, items: full, capped: true }])).success).toBe(true);
    expect(CollectionResultSchema.safeParse(result([{ ...level1, items: [...full, summary(999, root.id)] }])).success).toBe(false);
  });
});
