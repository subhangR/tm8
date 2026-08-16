/**
 * The Board tab's pure model — the column law, the filter law and the
 * optimistic overlay, provable as plain data with no React mounted.
 */
import { describe, expect, it } from 'vitest';
import type { CollectionGroup, EntitySummary } from '@tm8/contract';
import {
  EMPTY_FILTERS,
  PRIORITY_COLUMNS,
  STATUS_COLUMNS,
  applyMoves,
  buildFilters,
  columnsFor,
  matching,
  settledMoves,
  type BoardFilterState,
} from './board-model';

const row = (id: string, title = id): EntitySummary => ({ id, title }) as unknown as EntitySummary;

const group = (key: string, items: EntitySummary[], over: Partial<CollectionGroup> = {}): CollectionGroup =>
  ({ key, label: key, items, ...over }) as CollectionGroup;

describe('buildFilters — narrow()\'s law', () => {
  it('OMITS empty axes and answers undefined for the all-empty state', () => {
    /* `workStatus: []` would either match nothing or be refused — both
       misread "no chips pressed" as a constraint. And `undefined` is the
       exact cache key `boardFor` uses for the unfiltered read, so the
       untouched board and the just-cleared board share one snapshot. */
    expect(buildFilters(EMPTY_FILTERS)).toBeUndefined();
    expect(buildFilters({ statuses: ['open'], priorities: [], people: [], assignedBy: [] })).toEqual({
      workStatus: ['open'],
    });
    expect(buildFilters({ statuses: [], priorities: ['high'], people: ['m-1'], assignedBy: [] })).toEqual({
      priority: ['high'],
      assigneeIds: ['m-1'],
    });
    // The provenance axis is its own question — who HANDED OUT the work,
    // not who holds it — and it emits the server's assignedByIds arm.
    expect(buildFilters({ statuses: [], priorities: [], people: [], assignedBy: ['m-ada'] })).toEqual({
      assignedByIds: ['m-ada'],
    });
  });
});

describe('columnsFor — the column law per pivot', () => {
  it('status: the FULL canonical skeleton, empty columns included', () => {
    /* §1.3 — an empty column is a real answer and the drop target that makes
       it changeable; a groups-keyed board would hide every state the page
       happened not to contain. */
    const cols = columnsFor('workStatus', [group('working', [row('t1')])], EMPTY_FILTERS, []);
    expect(cols.map((c) => c.key)).toEqual(STATUS_COLUMNS.map((s) => s.key));
    expect(cols.find((c) => c.key === 'working')?.items).toHaveLength(1);
    expect(cols.find((c) => c.key === 'blocked')?.items).toHaveLength(0);
  });

  it('status: narrows to the selected chips — an excluded column must not stay a drop target', () => {
    const filters: BoardFilterState = { statuses: ['open', 'done'], priorities: [], people: [], assignedBy: [] };
    const cols = columnsFor('workStatus', [], filters, []);
    expect(cols.map((c) => c.key)).toEqual(['open', 'done']);
  });

  it('priority: descending urgency, the triage reading order', () => {
    const cols = columnsFor('priority', undefined, EMPTY_FILTERS, []);
    expect(cols.map((c) => c.key)).toEqual(PRIORITY_COLUMNS.map((p) => p.key));
  });

  it('carries the server\'s TRUE total beside the page-scoped items', () => {
    const cols = columnsFor(
      'workStatus',
      [group('open', [row('t1')], { total: 12 })],
      EMPTY_FILTERS,
      [],
    );
    const open = cols.find((c) => c.key === 'open')!;
    expect(open.items).toHaveLength(1);
    expect(open.total).toBe(12);
  });

  it('assignee: Unassigned first, then the server\'s groups by label', () => {
    const groups = [
      group('m-zed', [row('t1')], { label: 'Zed' }),
      group('', [row('t2')], { label: 'Unassigned' }),
      group('m-ada', [row('t3')], { label: 'Ada' }),
    ];
    const cols = columnsFor('assignee', groups, EMPTY_FILTERS, []);
    expect(cols.map((c) => c.label)).toEqual(['Unassigned', 'Ada', 'Zed']);
  });

  it('assignee under a people filter: exactly the chosen columns, empties synthesized from the roster', () => {
    /* A person with no tasks still shows their real, empty column — absence
       of a column would read as "not filterable", not "no tasks". */
    const filters: BoardFilterState = { statuses: [], priorities: [], people: ['m-ada', 'm-idle'], assignedBy: [] };
    const cols = columnsFor('assignee', [group('m-ada', [row('t1')], { label: 'Ada' })], filters, [
      { id: 'm-ada', label: 'Ada' },
      { id: 'm-idle', label: 'Idle' },
    ]);
    expect(cols.map((c) => c.key)).toEqual(['m-ada', 'm-idle']);
    expect(cols[1]!.label).toBe('Idle');
    expect(cols[1]!.items).toHaveLength(0);
  });

  it('assignee Unassigned total is null before the first read — unknown is never drawn as zero', () => {
    const cols = columnsFor('assignee', undefined, EMPTY_FILTERS, []);
    expect(cols[0]!.label).toBe('Unassigned');
    expect(cols[0]!.total).toBeNull();
  });
});

describe('applyMoves / settledMoves — the optimistic overlay', () => {
  const columns = () =>
    columnsFor(
      'workStatus',
      [group('open', [row('t1'), row('t2')], { total: 2 }), group('working', [row('t3')], { total: 1 })],
      EMPTY_FILTERS,
      [],
    );

  it('moves the card to the head of its target and the true totals move WITH it', () => {
    const moved = applyMoves(columns(), new Map([['t1', 'working']]));
    const open = moved.find((c) => c.key === 'open')!;
    const working = moved.find((c) => c.key === 'working')!;
    expect(open.items.map((i) => i.id)).toEqual(['t2']);
    expect(open.total).toBe(1);
    expect(working.items.map((i) => i.id)).toEqual(['t1', 't3']);
    expect(working.total).toBe(2);
  });

  it('settles a move once the RAW read already agrees, and only that one', () => {
    const fresh = columnsFor(
      'workStatus',
      [group('open', [row('t2')]), group('working', [row('t1'), row('t3')])],
      EMPTY_FILTERS,
      [],
    );
    const moves = new Map([
      ['t1', 'working'], // the read reflects it — safe to forget
      ['t2', 'done'], // still in flight — must survive the prune
    ]);
    expect(settledMoves(fresh, moves)).toEqual(['t1']);
  });

  it('a settled-and-forgotten overlay leaves the columns byte-identical', () => {
    const base = columns();
    expect(applyMoves(base, new Map())).toEqual([...base]);
  });
});

describe('matching — the title search is display-only', () => {
  it('narrows case-insensitively and an empty query narrows nothing', () => {
    const items = [row('t1', 'Wire the palette'), row('t2', 'Guide lines')];
    expect(matching(items, 'guide').map((i) => i.id)).toEqual(['t2']);
    expect(matching(items, '  ')).toHaveLength(2);
  });
});
