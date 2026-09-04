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
  DEFAULT_SPAN_DAYS,
  EMPTY_FILTERS,
  MAX_AXIS_DAYS,
  MIN_AXIS_DAYS,
  TIMELINE_TONES,
  UNCATEGORISED_KEY,
  addDays,
  anyFilterActive,
  applyMoves,
  axisFor,
  barIn,
  buildFilters,
  categoryDropFor,
  columnFilter,
  compareDays,
  dayKeyOf,
  daysBetween,
  isLive,
  isLiveBy,
  isLiveDot,
  liveNarrow,
  liveSignalsFor,
  matching,
  planFor,
  resolveWorkflow,
  settledMoves,
  spanOf,
  summarise,
  timelineGroups,
  timelineTone,
  todayKey,
  uncategorised,
  weekdayOf,
  type BoardColumn,
  type ColumnPlan,
  type LiveContext,
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
    expect(plan.columns[1]?.filter).toEqual({ status: ['working'] });
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

/* `BoardFilterState` GAINED A `live` AXIS (the live-work chips, 2026-08-31).
   The literals below carry `live: []` for that reason — and the FIRST case of
   the next block is the claim that matters: `live` is a CLIENT-SIDE narrowing
   (`liveNarrow`) and must never reach the wire, because there is no
   `filters.live` on `CollectionQuery` and a server-side collection predicate
   cannot consult the node's live PTY set. */
describe('buildFilters — narrow()\'s law plus the archived ruling', () => {
  it('OMITS empty axes and answers undefined for the all-empty state', () => {
    expect(buildFilters(EMPTY_FILTERS)).toBeUndefined();
    expect(buildFilters({ people: ['m-1'], assignedBy: [], archived: false, live: [] })).toEqual({
      assigneeIds: ['m-1'],
    });
    expect(buildFilters({ people: [], assignedBy: ['m-ada'], archived: false, live: [] })).toEqual({
      assignedByIds: ['m-ada'],
    });
  });

  it('the live axis NEVER reaches the wire — it is a page-scoped narrowing, not a query', () => {
    expect(
      buildFilters({ people: [], assignedBy: [], archived: false, live: ['verdict', 'worked-on'] }),
    ).toBeUndefined();
    expect(
      buildFilters({ people: ['m-1'], assignedBy: [], archived: false, live: ['verdict'] }),
    ).toEqual({ assigneeIds: ['m-1'] });
    // …but it IS a filter for the purposes of the "Clear filters" escape hatch.
    expect(anyFilterActive(EMPTY_FILTERS)).toBe(false);
    expect(
      anyFilterActive({ people: [], assignedBy: [], archived: false, live: ['verdict'] }),
    ).toBe(true);
  });

  it('archived is a FILTER (`deleted: only`), composing with every column', () => {
    expect(buildFilters({ people: [], assignedBy: [], archived: true, live: [] })).toEqual({
      deleted: 'only',
    });
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

// ===========================================================================
// THE TIMELINE VIEW (owner request 2026-08-31)
// ===========================================================================

describe('day keys — the timezone law, stated and pinned', () => {
  /*
   * THE DEFECT THIS BLOCK EXISTS TO PREVENT: `new Date('2026-07-30')` is
   * midnight UTC, so `.getDate()` in any negative offset answers 29. Every bar
   * on this board would draw one column early for every reader west of
   * Greenwich, on every render, and nothing would ever say so.
   *
   * These cases hold whatever `TZ` the runner has, which is the point — they
   * cannot pass by accident on a UTC box and fail on a laptop.
   */
  it('takes a date-only wire string VERBATIM and never parses it into a Date', () => {
    expect(dayKeyOf('2026-07-30')).toBe('2026-07-30');
    expect(dayKeyOf('2026-01-01')).toBe('2026-01-01');
    expect(dayKeyOf('2026-12-31')).toBe('2026-12-31');
  });

  it('projects an INSTANT in UTC — both ends of a UTC day land on that day', () => {
    // In UTC-5 the first of these is local Feb 28; in UTC+9 the second is
    // local Mar 2. Both must be 2026-03-01 here.
    expect(dayKeyOf('2026-03-01T00:30:00.000Z')).toBe('2026-03-01');
    expect(dayKeyOf('2026-03-01T23:30:00.000Z')).toBe('2026-03-01');
  });

  it('answers null for absence rather than defaulting to today', () => {
    expect(dayKeyOf(null)).toBeNull();
    expect(dayKeyOf(undefined)).toBeNull();
    expect(dayKeyOf('')).toBeNull();
    expect(dayKeyOf('  ')).toBeNull();
    expect(dayKeyOf('not a date')).toBeNull();
  });

  it('adds whole UTC days, so no DST transition can shorten one', () => {
    // 2026-03-08 is the US spring-forward; 2026-10-25 is the EU fall-back.
    // Local-time arithmetic loses/gains an hour across both and can round to
    // the wrong day; UTC arithmetic cannot.
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-07-30', 6)).toBe('2026-08-05');
  });

  it('measures and orders days without a Date on either side', () => {
    expect(daysBetween('2026-07-30', '2026-08-05')).toBe(6);
    expect(daysBetween('2026-08-05', '2026-07-30')).toBe(-6);
    expect(daysBetween('2026-07-30', '2026-07-30')).toBe(0);
    expect(compareDays('2026-07-30', '2026-08-01')).toBe(-1);
    expect(compareDays('2026-08-01', '2026-07-30')).toBe(1);
    expect(compareDays('2026-08-01', '2026-08-01')).toBe(0);
  });

  it('reads the weekday in UTC — 2026-08-31 is a Monday', () => {
    expect(weekdayOf('2026-08-31')).toBe(1);
    expect(weekdayOf('2026-08-30')).toBe(0);
    expect(weekdayOf('2026-09-05')).toBe(6);
  });

  it('todayKey is UTC and injectable, so no test depends on when it runs', () => {
    expect(todayKey(Date.UTC(2026, 7, 31, 23, 59, 59))).toBe('2026-08-31');
    expect(todayKey(Date.UTC(2026, 7, 31, 0, 0, 0))).toBe('2026-08-31');
  });
});

describe('spanOf — a guess must never be indistinguishable from a fact', () => {
  const TODAY = '2026-08-31';

  it('BOTH DATES PRESENT: the record, verbatim, nothing inferred, no note', () => {
    const span = spanOf({ startDate: '2026-08-03', dueDate: '2026-08-14' }, TODAY);
    expect(span).toEqual({
      startDay: '2026-08-03',
      endDay: '2026-08-14',
      stated: 'both',
      inferred: false,
      contradictory: false,
      note: null,
    });
  });

  it('START ONLY: a default week FORWARD, flagged inferred, and it says so', () => {
    const span = spanOf({ startDate: '2026-08-03', dueDate: null }, TODAY);
    expect(span.startDay).toBe('2026-08-03');
    // Seven days INCLUSIVE — the 3rd through the 9th, not through the 10th.
    expect(span.endDay).toBe('2026-08-09');
    expect(daysBetween(span.startDay, span.endDay)).toBe(DEFAULT_SPAN_DAYS - 1);
    expect(span.stated).toBe('start');
    expect(span.inferred).toBe(true);
    expect(span.note).toContain('No end date set');
  });

  it('END ONLY: a default week BACKWARD onto the due date, flagged inferred', () => {
    const span = spanOf({ startDate: null, dueDate: '2026-07-30' }, TODAY);
    expect(span.endDay).toBe('2026-07-30');
    expect(span.startDay).toBe('2026-07-24');
    expect(span.stated).toBe('end');
    expect(span.inferred).toBe(true);
    expect(span.note).toContain('No start date set');
  });

  it('NEITHER: the owner-ruled default week from today — inferred, and the note says which', () => {
    const span = spanOf({ startDate: null, dueDate: null }, TODAY);
    expect(span).toEqual({
      startDay: '2026-08-31',
      endDay: '2026-09-06',
      stated: 'none',
      inferred: true,
      contradictory: false,
      note: 'No dates set; showing a default 7-day week from today.',
    });
    // A row with no `state` at all is the same case, not a crash.
    expect(spanOf(undefined, TODAY).stated).toBe('none');
    expect(spanOf(null, TODAY).stated).toBe('none');
    expect(spanOf({}, TODAY).stated).toBe('none');
  });

  it('END BEFORE START: spans both stated dates, flags the CONTRADICTION, infers nothing', () => {
    const span = spanOf({ startDate: '2026-08-14', dueDate: '2026-08-03' }, TODAY);
    expect(span.startDay).toBe('2026-08-03');
    expect(span.endDay).toBe('2026-08-14');
    // Both endpoints came off the record, so this is NOT a guess…
    expect(span.stated).toBe('both');
    expect(span.inferred).toBe(false);
    // …but the record disagrees with itself, and that is its own fact.
    expect(span.contradictory).toBe(true);
    expect(span.note).toContain('before the start date');
  });

  it('THE TYPE MAKES THE DISTINCTION UNLOSABLE: every inferred span carries a note', () => {
    const cases = [
      { startDate: '2026-08-03', dueDate: null },
      { startDate: null, dueDate: '2026-08-03' },
      { startDate: null, dueDate: null },
    ];
    for (const dates of cases) {
      const span = spanOf(dates, TODAY);
      expect(span.inferred).toBe(true);
      expect(span.note).toBeTruthy();
      expect(span.stated).not.toBe('both');
    }
    // And the converse: a fully-stated, self-consistent span says nothing.
    expect(spanOf({ startDate: '2026-08-03', dueDate: '2026-08-04' }, TODAY).note).toBeNull();
  });

  it('honours a different default width without changing what "inferred" means', () => {
    const span = spanOf({ startDate: null, dueDate: null }, TODAY, 3);
    expect(span.endDay).toBe('2026-09-02');
    expect(span.inferred).toBe(true);
    expect(span.note).toContain('3-day');
  });
});

describe('axisFor — the dated axis', () => {
  const TODAY = '2026-08-31'; // a Monday
  const span = (startDay: string, endDay: string) =>
    spanOf({ startDate: startDay, dueDate: endDay }, TODAY);

  it('starts on a MONDAY, ends on a Sunday, and always contains today', () => {
    const axis = axisFor([span('2026-08-05', '2026-08-20')], TODAY);
    expect(weekdayOf(axis.days[0]!.key)).toBe(1);
    expect(weekdayOf(axis.days[axis.days.length - 1]!.key)).toBe(0);
    expect(axis.days.length % 7).toBe(0);
    expect(axis.days.some((d) => d.key === TODAY)).toBe(true);
    expect(axis.days[axis.todayIndex]!.key).toBe(TODAY);
    expect(axis.days[axis.todayIndex]!.isToday).toBe(true);
  });

  it('never falls below the three-week floor, even for one one-day span', () => {
    const axis = axisFor([span(TODAY, TODAY)], TODAY);
    expect(axis.days.length).toBeGreaterThanOrEqual(MIN_AXIS_DAYS);
  });

  it('an EMPTY board still draws a calendar around today rather than nothing', () => {
    const axis = axisFor([], TODAY);
    expect(axis.days.length).toBeGreaterThanOrEqual(MIN_AXIS_DAYS);
    expect(axis.todayIndex).toBeGreaterThanOrEqual(0);
  });

  it('CAPS the window and COUNTS what it cut — never a silent clip', () => {
    const axis = axisFor([span('2026-08-31', '2028-08-31')], TODAY);
    expect(axis.days.length).toBe(MAX_AXIS_DAYS);
    expect(axis.truncated.after).toBe(1);
    expect(axis.truncated.before).toBe(0);
  });

  it('when the cap would push TODAY off the end, the window SLIDES instead of losing it', () => {
    // One ancient row must not cost the reader the present. Trimming the tail
    // here would put today ~18 months past the last column, and a timeline
    // with no today on it cannot be read at all.
    const axis = axisFor([span('2024-01-08', '2024-02-08')], TODAY);
    expect(axis.days.length).toBe(MAX_AXIS_DAYS);
    expect(axis.todayIndex).toBeGreaterThanOrEqual(0);
    expect(axis.days[axis.todayIndex]!.key).toBe(TODAY);
    // …and the row that fell off the LEFT edge is confessed, not hidden.
    expect(axis.truncated.before).toBe(1);
  });

  it('marks weekends and week starts rather than dropping weekend columns', () => {
    // Dropping them would make a stated seven-day bar five cells long.
    const axis = axisFor([span(TODAY, TODAY)], TODAY);
    expect(axis.days.filter((d) => d.isWeekend).length).toBe((axis.days.length / 7) * 2);
    expect(axis.days.filter((d) => d.isWeekStart).length).toBe(axis.days.length / 7);
  });

  it('labels the first column and every 1st of a month, and nothing else', () => {
    const axis = axisFor([span('2026-08-24', '2026-09-14')], TODAY);
    expect(axis.days[0]!.monthLabel).toBeTruthy();
    const firsts = axis.days.filter((d) => d.dayOfMonth === 1);
    expect(firsts.length).toBeGreaterThan(0);
    for (const day of firsts) expect(day.monthLabel).toBe(`Sep ${day.key.slice(0, 4)}`);
    expect(axis.days.filter((d) => d.monthLabel !== null).length).toBe(1 + firsts.length);
  });
});

describe('barIn — geometry, and the honest refusal to draw one', () => {
  const TODAY = '2026-08-31';
  const span = (startDay: string, endDay: string) =>
    spanOf({ startDate: startDay, dueDate: endDay }, TODAY);
  const axis = axisFor([span('2026-08-31', '2026-09-04')], TODAY);
  const first = axis.days[0]!.key;

  it('places a bar at its day offset and spans INCLUSIVE days', () => {
    const bar = barIn(span('2026-08-31', '2026-09-04'), axis)!;
    expect(bar.startIndex).toBe(daysBetween(first, '2026-08-31'));
    expect(bar.dayCount).toBe(5);
    expect(bar.clippedStart).toBe(false);
    expect(bar.clippedEnd).toBe(false);
  });

  it('a single-day span is one cell wide, never zero', () => {
    expect(barIn(span(TODAY, TODAY), axis)!.dayCount).toBe(1);
  });

  it('CLIPS at an edge and says which edge — a torn bar, not a shortened fact', () => {
    const last = axis.days[axis.days.length - 1]!.key;
    const over = barIn(span(first, addDays(last, 30)), axis)!;
    expect(over.clippedEnd).toBe(true);
    expect(over.clippedStart).toBe(false);
    expect(over.startIndex + over.dayCount).toBe(axis.days.length);

    const under = barIn(span(addDays(first, -30), last), axis)!;
    expect(under.clippedStart).toBe(true);
    expect(under.startIndex).toBe(0);
  });

  it('answers NULL for a span wholly outside the window rather than pinning it to column 1', () => {
    const last = axis.days[axis.days.length - 1]!.key;
    expect(barIn(span(addDays(last, 10), addDays(last, 20)), axis)).toBeNull();
    expect(barIn(span(addDays(first, -20), addDays(first, -10)), axis)).toBeNull();
  });
});

describe('TIMELINE_TONES — multicolour that means something', () => {
  it('gives each of the closed four its OWN ramp; a pill tone would give two of them one', () => {
    const tones = CATEGORY_SPECS.map((spec) => TIMELINE_TONES[spec.key]);
    expect(new Set(tones).size).toBe(CATEGORY_SPECS.length);
    expect(TIMELINE_TONES).toEqual({
      to_do: 'wait',
      in_progress: 'run',
      done: 'info',
      cancelled: 'block',
    });
    // The pill map this deliberately is NOT: two categories share `idle` and
    // two share `run`, which is right beside a word and useless in a wall of
    // bars. Asserted so a future "reuse CATEGORY_SPECS.tone" tidy-up fails.
    expect(new Set(CATEGORY_SPECS.map((s) => s.tone)).size).toBeLessThan(CATEGORY_SPECS.length);
  });

  it('a row with NO category gets no status colour — absent is not "to do"', () => {
    expect(timelineTone(null)).toBe('none');
    expect(timelineTone(undefined)).toBe('none');
    expect(timelineTone('in_progress')).toBe('run');
  });
});

describe('the live axis — Home\'s definition, borrowed rather than restated', () => {
  const ctx = (verdicts: Record<string, string>, activity: Record<string, boolean> = {}): LiveContext => ({
    livenessOf: (id) => (verdicts[id] ?? 'unknown') as never,
    activity,
  });

  const session = (id: string, over: Partial<EntitySummary> = {}): EntitySummary =>
    ({ id, kind: 'work_session', title: id, state: {}, badges: {}, ...over }) as unknown as EntitySummary;

  const workedTask = (id: string, sessionId: string | null): EntitySummary =>
    ({
      id,
      kind: 'task',
      title: id,
      state: {},
      badges: sessionId
        ? { workingActors: [{ actor: { id: 'a1', ...(sessionId ? { via: { sessionId } } : {}) }, task: {}, startedAt: '' }] }
        : {},
    }) as unknown as EntitySummary;

  it('IS Home\'s predicate: pulse or solid, nothing else', () => {
    expect(isLiveDot('pulse')).toBe(true);
    expect(isLiveDot('solid')).toBe(true);
    expect(isLiveDot('ring')).toBe(false);
    expect(isLiveDot(null)).toBe(false);
  });

  it('offers a chip ONLY where the registry says the kind can answer it', () => {
    expect(liveSignalsFor(getKind('work_session')).map((s) => s.id)).toContain('verdict');
    // A task carries no verdict of its own; what it carries is working_on.
    expect(liveSignalsFor(getKind('task')).map((s) => s.id)).toEqual(['worked-on']);
    // A doc has neither, so the axis is not drawn at all for it — a chip that
    // could only ever narrow to zero is a control that lies.
    expect(liveSignalsFor(getKind('doc'))).toEqual([]);
  });

  it('VERDICT: `live` is live; `stale`, `not-running` and `unknown` are NOT', () => {
    expect(isLiveBy('verdict', session('s1'), ctx({ s1: 'live' }))).toBe(true);
    // The three that a record CLAIMING running cannot promote — the whole
    // reason a verdict outranks the record (D39/R-UI-5).
    expect(isLiveBy('verdict', session('s1'), ctx({ s1: 'stale' }))).toBe(false);
    expect(isLiveBy('verdict', session('s1'), ctx({ s1: 'not-running' }))).toBe(false);
    expect(isLiveBy('verdict', session('s1'), ctx({ s1: 'unknown' }))).toBe(false);
  });

  it('VERDICT is refused for a kind the registry gives no liveTreatment, whatever the seam says', () => {
    const doc = { id: 'd1', kind: 'doc', title: 'd', state: {}, badges: {} } as unknown as EntitySummary;
    expect(isLiveBy('verdict', doc, ctx({ d1: 'live' }))).toBe(false);
  });

  it('WORKED-ON follows the working_on actor\'s SESSION through the same verdict', () => {
    const task = workedTask('t1', 's1');
    expect(isLiveBy('worked-on', task, ctx({ s1: 'live' }))).toBe(true);
    // The edge still exists; the session died. NOT live — which is exactly the
    // distinction a bare `workingActors.length > 0` check would lose.
    expect(isLiveBy('worked-on', task, ctx({ s1: 'stale' }))).toBe(false);
    expect(isLiveBy('worked-on', task, ctx({ s1: 'not-running' }))).toBe(false);
    expect(isLiveBy('worked-on', task, ctx({}))).toBe(false);
    // No edge at all, and no actor carrying a session.
    expect(isLiveBy('worked-on', workedTask('t2', null), ctx({ s1: 'live' }))).toBe(false);
  });

  it('narrows a page by ANY pressed signal, and an EMPTY signal list is no constraint', () => {
    const rows = [session('s1'), session('s2')];
    const live = ctx({ s1: 'live', s2: 'not-running' });
    expect(liveNarrow(rows, [], live)).toHaveLength(2);
    expect(liveNarrow(rows, ['verdict'], live).map((r) => r.id)).toEqual(['s1']);
    expect(isLive(rows[1]!, ['verdict', 'worked-on'], live)).toBe(false);
  });
});

describe('timelineGroups — the board\'s own grouping, re-shaped', () => {
  const TODAY = '2026-08-31';
  const dated = (id: string, title: string, startDate: string | null, dueDate: string | null) =>
    ({ id, kind: 'task', title, state: { startDate, dueDate }, badges: {} }) as unknown as EntitySummary;

  const plan = (key: string, label: string, category: StatusCategory | null): ColumnPlan => ({
    key,
    label,
    tone: 'idle',
    category,
    filter: null,
    drop: { kind: 'refuse', reason: 'x' },
  });

  const columns = [
    { plan: plan('in_progress', 'In Progress', 'in_progress'), items: [], hasMore: false },
    { plan: plan('done', 'Done', 'done'), items: [], hasMore: true },
    { plan: plan(UNCATEGORISED_KEY, 'No status yet', null), items: [], hasMore: false },
  ];

  it('keeps one group per COLUMN, in the board\'s order, tinted by category', () => {
    const groups = timelineGroups(columns, [[], [], []], TODAY);
    expect(groups.map((g) => g.key)).toEqual(['in_progress', 'done', UNCATEGORISED_KEY]);
    expect(groups.map((g) => g.tone)).toEqual(['run', 'info', 'none']);
    expect(groups[1]!.hasMore).toBe(true);
  });

  it('sorts by start, then end, then title — and puts the UNDATED rows LAST', () => {
    const rows = [
      dated('t-none', 'zero dates', null, null),
      dated('t-late', 'later start', '2026-09-10', '2026-09-12'),
      dated('t-early', 'early', '2026-08-01', '2026-08-30'),
      dated('t-early-short', 'early but shorter', '2026-08-01', '2026-08-04'),
    ];
    const groups = timelineGroups([columns[0]!], [rows], TODAY);
    expect(groups[0]!.rows.map((r) => r.row.id)).toEqual([
      't-early-short',
      't-early',
      't-late',
      // Least informative, and the only one whose position is a default.
      't-none',
    ]);
  });

  it('carries the COLUMN\'S WORD onto every row, so a bar is never colour alone', () => {
    const groups = timelineGroups([columns[0]!], [[dated('t1', 'x', null, null)]], TODAY);
    expect(groups[0]!.rows[0]!.word).toBe('In Progress');
    expect(groups[0]!.rows[0]!.span.inferred).toBe(true);
  });
});

describe('summarise — the dashboard strip, every number a real read', () => {
  const TODAY = '2026-08-31';
  const dated = (id: string, startDate: string | null, dueDate: string | null) =>
    ({ id, kind: 'task', title: id, state: { startDate, dueDate }, badges: {} }) as unknown as EntitySummary;

  const plan = (key: string, label: string, category: StatusCategory | null): ColumnPlan => ({
    key, label, tone: 'idle', category, filter: null, drop: { kind: 'refuse', reason: 'x' },
  });

  it('counts the arrays the board DREW, splits the dates three ways, and hedges', () => {
    const columns = [
      { plan: plan('to_do', 'To Do', 'to_do'), items: [] as EntitySummary[], hasMore: false },
      { plan: plan('done', 'Done', 'done'), items: [] as EntitySummary[], hasMore: true },
    ];
    const shown = [
      [dated('a', '2026-08-01', '2026-08-10'), dated('b', null, null), dated('c', '2026-08-01', null)],
      [dated('d', null, null)],
    ];
    const summary = summarise(columns, shown, TODAY, (row) => row.id === 'a');
    expect(summary.total).toBe(4);
    expect(summary.lines).toEqual([
      { key: 'to_do', label: 'To Do', tone: 'wait', count: 3 },
      { key: 'done', label: 'Done', tone: 'info', count: 1 },
    ]);
    expect(summary.live).toBe(1);
    expect(summary.undated).toBe(2);
    expect(summary.partiallyDated).toBe(1);
    // Some column has another page, so every figure above is page-scoped.
    expect(summary.hedged).toBe(true);
    expect(summary.loading).toBe(false);
  });

  it('says a read is IN FLIGHT rather than printing a zero for it', () => {
    const columns = [{ plan: plan('to_do', 'To Do', 'to_do'), items: undefined, hasMore: false }];
    expect(summarise(columns, [[]], TODAY, () => false).loading).toBe(true);
  });

  it('the strip and a column header cannot disagree — same arrays, same numbers', () => {
    const columns = [{ plan: plan('to_do', 'To Do', 'to_do'), items: [] as EntitySummary[], hasMore: false }];
    const shown = [[dated('a', null, null), dated('b', null, null)]];
    const summary = summarise(columns, shown, TODAY, () => false);
    expect(summary.lines[0]!.count).toBe(shown[0]!.length);
    expect(summary.total).toBe(shown[0]!.length);
  });
});
