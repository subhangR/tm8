/**
 * The task tree and the task query — the two pieces of Lane A that are pure.
 *
 * These are separated from the panel's DOM tests on purpose. The hierarchy is
 * assembled client-side from a FLAT page (see `useTasks`'s header for why), so
 * the tree is the one place a real task can silently disappear: an orphaned
 * child, a self-parent cycle, a sibling group that quietly re-sorts. None of
 * those are visible in a rendered list — a missing row looks exactly like a row
 * that was never there. So they are asserted directly, against the row shape the
 * tm8 node actually returns.
 */
import { describe, expect, it } from 'vitest';
import type { EntitySummary, WorkStatus } from '../../../collab-v2/types/contract';
import {
  TASK_LIMIT, buildTaskTree, descendantIds, flattenTree, isFinished,
  taskState, tasksQuery,
} from '../useTasks';

/** A `task` exactly as `collections.query` projects it (verified by live call). */
function task(
  id: string,
  parentId: string | null = null,
  over: Partial<{ workStatus: WorkStatus; priority: string; title: string }> = {},
): EntitySummary {
  return {
    id,
    spaceId: 'spc_1',
    kind: 'task',
    title: over.title ?? id,
    parentId,
    position: 1,
    visibility: 'space',
    version: 2,
    activityAt: '2026-07-25T12:24:14.651Z',
    createdAt: '2026-07-25T09:55:10.388Z',
    updatedAt: '2026-07-25T09:55:10.630Z',
    deletedAt: null,
    createdBy: { id: 'm1', kind: 'member', displayName: 'Owner', avatar: null, isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: {
      kind: 'task',
      workStatus: over.workStatus ?? 'open',
      priority: (over.priority ?? 'medium') as 'medium',
      axes: {},
      dueDate: null,
      assignees: [],
      acceptance: { total: 0, completed: 0 },
    },
    badges: {},
  } as unknown as EntitySummary;
}

const ids = (rows: { task: EntitySummary }[]) => rows.map((r) => r.task.id);

describe('buildTaskTree', () => {
  it('nests children under their parent and keeps the server’s order', () => {
    // The response order IS the sort the user chose. Re-sorting here would mean
    // "sort by priority" silently became a second, client-side opinion.
    const tree = buildTaskTree([task('a'), task('b'), task('a1', 'a'), task('a2', 'a')]);

    expect(tree.map((n) => n.task.id)).toEqual(['a', 'b']);
    expect(tree[0]!.children.map((n) => n.task.id)).toEqual(['a1', 'a2']);
    expect(tree[1]!.children).toEqual([]);
  });

  it('promotes an orphan to the root rather than dropping it', () => {
    // THE regression this file exists for. `filters.workStatus` runs server-side,
    // so a filtered page routinely contains a child whose parent did not match.
    // Attaching it to a parent that is not in the page would render it nowhere —
    // a task that matched the query would be invisible, which is the exact class
    // of lie the degradation contract forbids.
    const tree = buildTaskTree([task('child', 'missing-parent'), task('root')]);

    expect(tree.map((n) => n.task.id)).toEqual(['child', 'root']);
  });

  it('does not hang or vanish a row when a task claims itself as its parent', () => {
    // Not reachable through the UI today, but a self-edge from a bad write would
    // otherwise build a node that contains itself — an infinite flatten.
    const tree = buildTaskTree([task('loop', 'loop')]);

    expect(tree.map((n) => n.task.id)).toEqual(['loop']);
    expect(flattenTree(tree, new Set(['loop']))).toHaveLength(1);
  });

  it('keeps every input row reachable somewhere', () => {
    const rows = [task('a'), task('a1', 'a'), task('b'), task('orphan', 'gone'), task('a1a', 'a1')];
    const all = flattenTree(buildTaskTree(rows), new Set(['a', 'a1']));

    expect(all).toHaveLength(rows.length);
    expect(new Set(ids(all))).toEqual(new Set(rows.map((r) => r.id)));
  });
});

describe('flattenTree', () => {
  const tree = buildTaskTree([task('a'), task('a1', 'a'), task('a1a', 'a1'), task('b')]);

  it('renders only what is expanded — a collapsed subtree costs no rows', () => {
    expect(ids(flattenTree(tree, new Set()))).toEqual(['a', 'b']);
    expect(ids(flattenTree(tree, new Set(['a'])))).toEqual(['a', 'a1', 'b']);
    expect(ids(flattenTree(tree, new Set(['a', 'a1'])))).toEqual(['a', 'a1', 'a1a', 'b']);
  });

  it('reports depth so the indent is data, not a guess', () => {
    const rows = flattenTree(tree, new Set(['a', 'a1']));
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 0]);
  });

  it('marks a row as having children even while it is collapsed', () => {
    // Otherwise the caret only appears after you expand — which you cannot do.
    const [a, b] = flattenTree(tree, new Set());
    expect(a!.hasChildren).toBe(true);
    expect(a!.expanded).toBe(false);
    expect(b!.hasChildren).toBe(false);
  });

  it('never reports an expanded leaf', () => {
    const rows = flattenTree(tree, new Set(['b']));
    expect(rows.find((r) => r.task.id === 'b')!.expanded).toBe(false);
  });
});

describe('descendantIds', () => {
  it('returns the whole subtree so collapsing cascades', () => {
    const tree = buildTaskTree([task('a'), task('a1', 'a'), task('a1a', 'a1'), task('a2', 'a')]);
    expect(descendantIds(tree[0]!).sort()).toEqual(['a1', 'a1a', 'a2']);
  });
});

describe('tasksQuery', () => {
  it('asks for tasks with a server-side sort and the reported cap', () => {
    expect(tasksQuery('spc_1', 'priority', [])).toEqual({
      spaceId: 'spc_1', kinds: ['task'], sort: 'priority', limit: TASK_LIMIT,
    });
  });

  it('omits `filters` entirely when nothing is selected', () => {
    // `collections.query` is `.strict()` server-side and `workStatus: []` would
    // filter everything OUT rather than nothing — an empty panel that looks like
    // an empty space.
    expect('filters' in tasksQuery('spc_1', 'dueDate', [])).toBe(false);
  });

  it('sends the status filter to the server rather than filtering locally', () => {
    expect(tasksQuery('spc_1', 'activityAt_desc', ['working', 'open']).filters)
      .toEqual({ workStatus: ['working', 'open'] });
  });

  it('sends the assignee filter to the server too, and composes with status', () => {
    // `assigneeIds` is an `assigned_to` edge with `dst_id = any(...)` — OR across
    // the selection, resolved over the whole space rather than the fetched page.
    expect(tasksQuery('spc_1', 'priority', [], ['act_a', 'act_b']).filters)
      .toEqual({ assigneeIds: ['act_a', 'act_b'] });
    expect(tasksQuery('spc_1', 'priority', ['open'], ['act_a']).filters)
      .toEqual({ workStatus: ['open'], assigneeIds: ['act_a'] });
  });

  it('omits `assigneeIds` when nobody is selected rather than sending []', () => {
    // Same trap as `workStatus: []`: an empty array is a filter that matches
    // nothing, so it would empty the list instead of leaving it alone.
    expect('filters' in tasksQuery('spc_1', 'priority', [], [])).toBe(false);
    expect(tasksQuery('spc_1', 'priority', ['open'], []).filters).toEqual({ workStatus: ['open'] });
  });

  it('is stable for the same selection, so the poll is still shared', () => {
    expect(JSON.stringify(tasksQuery('spc_1', 'priority', ['open'], ['act_a'])))
      .toBe(JSON.stringify(tasksQuery('spc_1', 'priority', ['open'], ['act_a'])));
  });

  it('produces a stable object for the same question, so the poll is shared', () => {
    // `usePolledCollection` keys its subscription on the SERIALIZED query. Two
    // call sites that differ only in key order would open two intervals against
    // the same rows — the storm the shared factory exists to prevent.
    expect(JSON.stringify(tasksQuery('spc_1', 'priority', ['done'])))
      .toBe(JSON.stringify(tasksQuery('spc_1', 'priority', ['done'])));
  });
});

describe('taskState', () => {
  it('reads the tm8 `state` arm', () => {
    const s = taskState(task('a', null, { workStatus: 'working', priority: 'urgent' }));
    expect(s.workStatus).toBe('working');
    expect(s.priority).toBe('urgent');
  });

  it('defaults field-by-field rather than rendering a blank status chip', () => {
    const bare = { ...task('a'), state: undefined } as unknown as EntitySummary;
    expect(taskState(bare).workStatus).toBe('open');
    expect(taskState(bare).acceptance).toEqual({ total: 0, completed: 0 });
  });
});

describe('isFinished', () => {
  it('follows the graph, not the UI’s feelings about it', () => {
    expect(isFinished(task('a', null, { workStatus: 'done' }))).toBe(true);
    expect(isFinished(task('a', null, { workStatus: 'cancelled' }))).toBe(true);
    expect(isFinished(task('a', null, { workStatus: 'in_review' }))).toBe(false);
    expect(isFinished(task('a', null, { workStatus: 'working' }))).toBe(false);
  });
});
