/**
 * Board v2's pure model — the plan law (categories by default, workflow
 * states only when exact), the drop seam's resolution ladder, the filter law
 * and the endpointed optimistic overlay, provable as plain data.
 */
import { describe, expect, it } from 'vitest';
import type { EntitySummary, StatusCategory, Workflow } from '@tm8/contract';
import { getKind } from '../domain';
import {
  CATEGORY_SPECS,
  EMPTY_FILTERS,
  UNCATEGORISED_KEY,
  applyMoves,
  buildFilters,
  categoryDropFor,
  columnFilter,
  matching,
  planFor,
  resolveWorkflow,
  settledMoves,
  uncategorised,
  type BoardColumn,
  type ColumnPlan,
  type Move,
} from './board-model';

const task = getKind('task');
const doc = getKind('doc');

const row = (id: string, over: Partial<EntitySummary> = {}): EntitySummary =>
  ({ id, title: id, ...over }) as unknown as EntitySummary;

/** A workflow literal, tersely. */
const wf = (
  id: string,
  kind: string | null,
  states: [name: string, category: StatusCategory, opts?: { isDefault?: boolean; isInitial?: boolean }][],
  name = id,
): Workflow => ({
  id,
  spaceId: kind === null ? null : 'sp-1',
  name,
  kind,
  states: states.map(([stateName, category, opts], i) => ({
    id: `${id}:${stateName}`,
    workflowId: id,
    name: stateName,
    category,
    position: i,
    isInitial: opts?.isInitial ?? i === 0,
    isDefault: opts?.isDefault ?? false,
  })),
  transitions: [],
});

/** Migration 149's global default, as the fixture seam also mirrors it. */
const GLOBAL_DEFAULT = wf(
  'wf-global',
  null,
  [
    ['To Do', 'to_do', { isDefault: true }],
    ['In Progress', 'in_progress'],
    ['Done', 'done'],
    ['Cancelled', 'cancelled'],
  ],
  'Default',
);

/** A migrated per-type task workflow: states named BY the status literals. */
const MIGRATED = wf('wf-epic', 'task', [
  ['open', 'to_do'],
  ['working', 'in_progress'],
  ['in_review', 'in_progress'],
  ['done', 'done'],
]);

describe('resolveWorkflow — the pre-phase-5 resolution', () => {
  it('exactly one kind-bound workflow wins; none or several fall to the global default', () => {
    expect(resolveWorkflow(task, [GLOBAL_DEFAULT, MIGRATED])?.id).toBe('wf-epic');
    expect(resolveWorkflow(task, [GLOBAL_DEFAULT])?.id).toBe('wf-global');
    // Two per-type workflows: no single one IS "the task workflow" — picking
    // a favourite would draw a board half the space's tasks do not live on.
    const second = wf('wf-bug', 'task', [['open', 'to_do']]);
    expect(resolveWorkflow(task, [GLOBAL_DEFAULT, MIGRATED, second])?.id).toBe('wf-global');
    expect(resolveWorkflow(task, undefined)).toBeUndefined();
  });
});

describe('planFor — category columns are the default and every one is a real read', () => {
  it('emits the closed four in reading order plus the uncategorised column', () => {
    const plan = planFor(task, GLOBAL_DEFAULT, false);
    expect(plan.mode).toBe('category');
    expect(plan.columns.map((c) => c.key)).toEqual([
      ...CATEGORY_SPECS.map((s) => s.key),
      UNCATEGORISED_KEY,
    ]);
    // Each category column carries ITS server predicate…
    expect(plan.columns[0]?.filter).toEqual({ category: ['to_do'] });
    // …and the uncategorised column carries NONE: its rows are the base
    // read's, narrowed on the server-computed category being absent — the
    // one fact `filters.category` structurally cannot return.
    expect(plan.columns[4]?.filter).toBeNull();
  });

  it('the uncategorised column never accepts a drop — absence is not a state', () => {
    const plan = planFor(task, GLOBAL_DEFAULT, false);
    const un = plan.columns.find((c) => c.key === UNCATEGORISED_KEY)!;
    expect(un.drop.kind).toBe('refuse');
  });
});

describe('categoryDropFor — the drop seam ladder', () => {
  it('a workflow state naming a settable option wins (the migrated-workflow path)', () => {
    // in_progress has TWO states; `working` sits first, so it is the target.
    expect(categoryDropFor(task, MIGRATED, 'in_progress')).toEqual({
      kind: 'set-state',
      optionId: 'working',
    });
    // done routes via the gated complete, exactly as the registry declares.
    expect(categoryDropFor(task, MIGRATED, 'done')).toEqual({
      kind: 'set-state',
      optionId: 'done',
      via: 'complete',
    });
  });

  it('the display-named global default falls back to the transitional category defaults', () => {
    // "To Do" is nobody's settable status; the bridge answers `open`.
    expect(categoryDropFor(task, GLOBAL_DEFAULT, 'to_do')).toEqual({
      kind: 'set-state',
      optionId: 'open',
    });
    expect(categoryDropFor(task, GLOBAL_DEFAULT, 'cancelled')).toEqual({
      kind: 'set-state',
      optionId: 'cancelled',
    });
  });

  it('a kind with no state control refuses WITH the phase that unlocks it', () => {
    const drop = categoryDropFor(doc, GLOBAL_DEFAULT, 'to_do');
    expect(drop.kind).toBe('refuse');
    // Re-worded by phase 5 (migration 152): the first half of the old copy —
    // "no settable status yet" — stopped being true when every kind got one.
    // What is still missing is the settable CONTROL, and the phase that unlocks
    // it is the four-tab phase, which is what the refusal must now name.
    if (drop.kind === 'refuse') {
      expect(drop.reason).toMatch(/no settable control yet/i);
      expect(drop.reason).toMatch(/four-tab phase/i);
    }
  });
});

describe('planFor — workflow columns only when EVERY state is exactly queryable', () => {
  it('migrated task workflow: per-state columns read by the status axis, banded by category', () => {
    const plan = planFor(task, MIGRATED, true);
    expect(plan.mode).toBe('workflow');
    expect(plan.workflowName).toBe('wf-epic');
    expect(plan.columns.map((c) => c.label)).toEqual(['open', 'working', 'in_review', 'done']);
    expect(plan.columns[1]?.filter).toEqual({ workStatus: ['working'] });
    expect(plan.columns.map((c) => c.category)).toEqual(['to_do', 'in_progress', 'in_progress', 'done']);
  });

  it('the global default is exact for ANY kind: one state per category means the category read IS the state read', () => {
    const plan = planFor(doc, GLOBAL_DEFAULT, true);
    expect(plan.mode).toBe('workflow');
    expect(plan.columns.map((c) => c.label)).toEqual(['To Do', 'In Progress', 'Done', 'Cancelled']);
    expect(plan.columns[0]?.filter).toEqual({ category: ['to_do'] });
    // …but a DOC still cannot move: the drop seam refuses per column.
    expect(plan.columns[0]?.drop.kind).toBe('refuse');
  });

  it('one inexact state downgrades the WHOLE board, with the reason recorded', () => {
    // Two doc states share in_progress and neither is a settable doc option:
    // no read can isolate either, so approximating is refused wholesale.
    const inexact = wf('wf-x', 'doc', [
      ['Drafting', 'in_progress'],
      ['Reviewing', 'in_progress'],
    ]);
    const plan = planFor(doc, inexact, true);
    expect(plan.mode).toBe('category');
    expect(plan.workflowUnavailable).toMatch(/cannot be read exactly/i);
  });
});

describe('buildFilters — narrow()\'s law plus the archived ruling', () => {
  it('OMITS empty axes and answers undefined for the all-empty state', () => {
    expect(buildFilters(EMPTY_FILTERS)).toBeUndefined();
    expect(buildFilters({ people: ['m-1'], assignedBy: [], archived: false })).toEqual({
      assigneeIds: ['m-1'],
    });
    expect(buildFilters({ people: [], assignedBy: ['m-ada'], archived: false })).toEqual({
      assignedByIds: ['m-ada'],
    });
  });

  it('archived is a FILTER (`deleted: only`), composing with every column', () => {
    expect(buildFilters({ people: [], assignedBy: [], archived: true })).toEqual({ deleted: 'only' });
    const col: ColumnPlan = {
      key: 'to_do',
      label: 'To Do',
      tone: 'idle',
      category: 'to_do',
      filter: { category: ['to_do'] },
      drop: { kind: 'refuse', reason: 'x' },
    };
    expect(columnFilter({ deleted: 'only' }, col)).toEqual({ deleted: 'only', category: ['to_do'] });
  });
});

describe('uncategorised — the server-computed absence', () => {
  it('keeps exactly the rows whose summary carries NO category', () => {
    const rows = [row('a', { category: 'to_do' } as Partial<EntitySummary>), row('b'), row('c')];
    expect(uncategorised(rows).map((r) => r.id)).toEqual(['b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// The endpointed overlay
// ---------------------------------------------------------------------------

const plans: Record<string, ColumnPlan> = Object.fromEntries(
  ['a', 'b', 'c'].map((key) => [
    key,
    { key, label: key, tone: 'idle', category: null, filter: null, drop: { kind: 'refuse', reason: '' } },
  ]),
);
const col = (key: string, items: EntitySummary[] | undefined): BoardColumn => ({
  plan: plans[key]!,
  items,
  hasMore: false,
});
const moved = (entries: [string, Move][]) => new Map(entries);

describe('applyMoves — the optimistic overlay', () => {
  it('renders a dropped card at the head of its target and removes it from the source', () => {
    const columns = [col('a', [row('t1'), row('t2')]), col('b', [row('t3')])];
    const out = applyMoves(columns, moved([['t1', { to: 'b', from: 'a' }]]));
    expect(out[0]?.items?.map((i) => i.id)).toEqual(['t2']);
    expect(out[1]?.items?.map((i) => i.id)).toEqual(['t1', 't3']);
  });

  it('leaves a loading column alone rather than inventing its contents', () => {
    const columns = [col('a', [row('t1')]), col('b', undefined)];
    const out = applyMoves(columns, moved([['t1', { to: 'b', from: 'a' }]]));
    expect(out[1]?.items).toBeUndefined();
  });
});

describe('settledMoves — the fresh read answers', () => {
  it('settles when the card shows up in its TARGET column', () => {
    const columns = [col('a', []), col('b', [row('t1')])];
    expect(settledMoves(columns, moved([['t1', { to: 'b', from: 'a' }]]))).toEqual(['t1']);
  });

  it('keeps claiming while the card still sits only in its SOURCE (the write has not landed)', () => {
    const columns = [col('a', [row('t1')]), col('b', [])];
    expect(settledMoves(columns, moved([['t1', { to: 'b', from: 'a' }]]))).toEqual([]);
  });

  it('settles when the server landed the card SOMEWHERE ELSE — truth beats the claim', () => {
    // The write succeeded but a trigger derived a different landing column;
    // pinning the optimistic claim would contradict every fresh read forever.
    const columns = [col('a', []), col('b', []), col('c', [row('t1')])];
    expect(settledMoves(columns, moved([['t1', { to: 'b', from: 'a' }]]))).toEqual(['t1']);
  });
});

describe('matching — display-only title narrowing', () => {
  it('narrows case-insensitively and treats blank as no filter', () => {
    const rows = [row('t1', { title: 'Wire palette' } as Partial<EntitySummary>), row('t2', { title: 'Guide' } as Partial<EntitySummary>)];
    expect(matching(rows, '  ')).toHaveLength(2);
    expect(matching(rows, 'wire').map((r) => r.id)).toEqual(['t1']);
  });
});
