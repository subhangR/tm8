/**
 * THE BOARD TAB's pure model — everything about the kanban that needs no
 * React and no seam, so the shape of the screen is testable as plain data.
 *
 * L3 STILL HOLDS: THE CLIENT NEVER GROUPS. Columns here are assembled FROM
 * `collections.query`'s server-computed groups; what this file adds is only
 * presentation truth the server cannot know —
 *
 *   · the CANONICAL COLUMN ORDER for the status and priority pivots. A group
 *     result is keyed by what the page happened to contain; a kanban's
 *     columns are the workflow vocabulary in reading order, INCLUDING the
 *     empty ones, because an empty column is both a real answer (§1.3) and
 *     the drop target that makes the answer changeable.
 *   · the OPTIMISTIC OVERLAY (`applyMoves`): a card the user just dropped
 *     renders in its target column until the next server read either agrees
 *     (the move is forgotten as settled) or the write is refused (the screen
 *     rolls it back and says why, inline at the refusing column).
 *
 * The vocabulary itself mirrors the registry's `TASK_STATE_CONTROL` /
 * `TASK_PRIORITY_CONTROL` ids and the server's own label maps
 * (`collections.ts` WORK_STATUS_LABELS / PRIORITY_LABELS) — the same words in
 * the same case, so a column header and a card pill cannot disagree.
 */
import type { CollectionGroup, EntitySummary } from '@tm8/contract';
import type { QueryFilter } from '../domain';
import type { PillTone } from '../kit';

/** The three axes `collections.query` can group tasks by. `axis:*` is out of
 * scope until custom axes get a picker. */
export type BoardPivot = 'workStatus' | 'assignee' | 'priority';

export const PIVOTS: readonly { key: BoardPivot; label: string }[] = [
  { key: 'workStatus', label: 'Status' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'priority', label: 'Priority' },
];

export interface ColumnSpec {
  key: string;
  label: string;
  tone: PillTone;
}

/**
 * Reading order = the registry's `TASK_STATE_CONTROL` option order — "a
 * vocabulary in reading order, not a state machine" (its own words), and the
 * board must not pretend otherwise by hiding or re-ordering members.
 */
export const STATUS_COLUMNS: readonly ColumnSpec[] = [
  { key: 'open', label: 'Open', tone: 'idle' },
  { key: 'pulled', label: 'Pulled', tone: 'wait' },
  { key: 'working', label: 'Working', tone: 'run' },
  { key: 'in_review', label: 'In review', tone: 'info' },
  { key: 'blocked', label: 'Blocked', tone: 'block' },
  { key: 'done', label: 'Done', tone: 'run' },
  { key: 'cancelled', label: 'Cancelled', tone: 'idle' },
];

/** Descending urgency — the order a triage eye actually scans. */
export const PRIORITY_COLUMNS: readonly ColumnSpec[] = [
  { key: 'urgent', label: 'Urgent', tone: 'block' },
  { key: 'high', label: 'High', tone: 'block' },
  { key: 'medium', label: 'Medium', tone: 'idle' },
  { key: 'low', label: 'Low', tone: 'idle' },
];

export interface BoardFilterState {
  statuses: readonly string[];
  priorities: readonly string[];
  /**
   * Actor ENTITY ids — members and teammates on the one axis, because
   * `assigned_to` legally targets both and the server's `assigneeIds` filter
   * does not care which it was handed.
   */
  people: readonly string[];
}

export const EMPTY_FILTERS: BoardFilterState = { statuses: [], priorities: [], people: [] };

export function anyFilterActive(f: BoardFilterState): boolean {
  return f.statuses.length > 0 || f.priorities.length > 0 || f.people.length > 0;
}

/**
 * The `CollectionQuery.filters` this state means. AN EMPTY ARRAY IS NO
 * CONSTRAINT (`narrow()`'s law — sending `workStatus: []` would either match
 * nothing or be refused, and both misread "no chips pressed" as a filter), so
 * empty axes are OMITTED and an all-empty state is `undefined`: the exact
 * cache key `boardFor` uses for the unfiltered read.
 */
export function buildFilters(f: BoardFilterState): QueryFilter | undefined {
  const out: QueryFilter = {};
  if (f.statuses.length > 0) out.workStatus = [...f.statuses] as NonNullable<QueryFilter['workStatus']>;
  if (f.priorities.length > 0) out.priority = [...f.priorities] as NonNullable<QueryFilter['priority']>;
  if (f.people.length > 0) out.assigneeIds = [...f.people] as NonNullable<QueryFilter['assigneeIds']>;
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface BoardColumn extends ColumnSpec {
  /**
   * The group's TRUE size under the filters (server `groupTotals`), which the
   * header shows beside the page-scoped card count. `null` = the read did not
   * say (never rendered as 0 — an unknown drawn as zero claims emptiness).
   */
  total: number | null;
  items: readonly EntitySummary[];
}

/**
 * Groups → columns for one pivot.
 *
 * status/priority: the canonical skeleton, narrowed to the selected chips
 * when that axis is filtered (a column the filter excludes would be a drop
 * target writing a state the viewer asked not to see). assignee: the server's
 * groups (labels are THEIRS — display names only the result carries), ordered
 * Unassigned-first then by name; when a people filter is active, exactly the
 * selected people's columns, empty ones synthesized from the roster so a
 * person with no tasks still shows their real, empty column.
 */
export function columnsFor(
  pivot: BoardPivot,
  groups: readonly CollectionGroup[] | undefined,
  filters: BoardFilterState,
  roster: readonly { id: string; label: string }[],
): BoardColumn[] {
  const byKey = new Map((groups ?? []).map((g) => [g.key, g] as const));
  const of = (spec: ColumnSpec): BoardColumn => {
    const g = byKey.get(spec.key);
    return { ...spec, total: g?.total ?? (g ? g.items.length : 0), items: g?.items ?? [] };
  };

  if (pivot === 'workStatus') {
    const specs =
      filters.statuses.length > 0
        ? STATUS_COLUMNS.filter((s) => filters.statuses.includes(s.key))
        : STATUS_COLUMNS;
    return specs.map(of);
  }

  if (pivot === 'priority') {
    const specs =
      filters.priorities.length > 0
        ? PRIORITY_COLUMNS.filter((s) => filters.priorities.includes(s.key))
        : PRIORITY_COLUMNS;
    return specs.map(of);
  }

  const names = new Map(roster.map((r) => [r.id, r.label] as const));
  if (filters.people.length > 0) {
    return filters.people.map((id) => {
      const g = byKey.get(id);
      return {
        key: id,
        label: g?.label ?? names.get(id) ?? id,
        tone: 'idle' as const,
        total: g?.total ?? 0,
        items: g?.items ?? [],
      };
    });
  }
  const unassigned = byKey.get('');
  const cols: BoardColumn[] = [
    {
      key: '',
      label: 'Unassigned',
      tone: 'idle',
      total: unassigned?.total ?? (groups === undefined ? null : 0),
      items: unassigned?.items ?? [],
    },
  ];
  const rest = (groups ?? [])
    .filter((g) => g.key !== '')
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const g of rest) {
    cols.push({ key: g.key, label: g.label, tone: 'idle', total: g.total ?? g.items.length, items: g.items });
  }
  return cols;
}

/**
 * The optimistic overlay: `moves` maps a card id to the column KEY it was
 * just dropped on. The card renders at the head of its target column and
 * leaves every other column; the true-count totals move WITH it so a header
 * never contradicts the cards below it.
 */
export function applyMoves(
  columns: readonly BoardColumn[],
  moves: ReadonlyMap<string, string>,
): BoardColumn[] {
  if (moves.size === 0) return [...columns];
  const carried = new Map<string, EntitySummary>();
  for (const col of columns) {
    for (const item of col.items) {
      const to = moves.get(item.id);
      if (to !== undefined && to !== col.key) carried.set(item.id, item);
    }
  }
  return columns.map((col) => {
    const kept = col.items.filter((i) => {
      const to = moves.get(i.id);
      return to === undefined || to === col.key;
    });
    const gained = [...carried.values()].filter(
      (i) => moves.get(i.id) === col.key && !kept.some((k) => k.id === i.id),
    );
    const delta = gained.length - (col.items.length - kept.length);
    return {
      ...col,
      items: [...gained, ...kept],
      total: col.total === null ? null : col.total + delta,
    };
  });
}

/**
 * Moves the fresh server read already reflects — safe to forget, because the
 * data now says what the overlay was claiming. Called with the RAW columns
 * (pre-overlay); a refused write never settles this way and is rolled back
 * explicitly by the screen instead.
 */
export function settledMoves(
  columns: readonly BoardColumn[],
  moves: ReadonlyMap<string, string>,
): string[] {
  const settled: string[] = [];
  for (const [id, to] of moves) {
    const target = columns.find((c) => c.key === to);
    if (target?.items.some((i) => i.id === id)) settled.push(id);
  }
  return settled;
}

/** Client-side title narrowing for the search box — display-only, page-scoped. */
export function matching(items: readonly EntitySummary[], query: string): readonly EntitySummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => i.title.toLowerCase().includes(q));
}
