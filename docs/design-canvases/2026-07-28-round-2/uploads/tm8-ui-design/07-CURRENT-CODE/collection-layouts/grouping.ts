/**
 * Client-side grouping — the ONE algorithm every layout shares.
 *
 * Mirrors the facade's `queryCollection` grouping exactly (so a server-grouped
 * result and a live re-group agree), but runs over the *patched* page items so
 * optimistic mutations and WorkspaceEvent patches move cards between groups
 * without a refetch. Axes are treated uniformly: `workStatus`, `assignee`, and
 * `axis:<name>` are three spellings of the same pivot — default and manual
 * axes are indistinguishable here (both are just `TaskAxis` rows).
 */
import { labelForWorkStatus } from '../kit';
import type {
  CollectionGroup, CollectionQuery, EntitySummary, TaskAxis, WorkStatus,
} from '../types/contract';

export type GroupByKey = NonNullable<CollectionQuery['groupBy']>;

/** Same order the mock uses for status groups (blocked before done). */
export const STATUS_ORDER: WorkStatus[] = [
  'open', 'pulled', 'working', 'in_review', 'blocked', 'done', 'cancelled',
];

export function isAxisGroupBy(groupBy: GroupByKey): groupBy is `axis:${string}` {
  return groupBy.startsWith('axis:');
}

export function axisNameOf(groupBy: GroupByKey): string | null {
  return isAxisGroupBy(groupBy) ? groupBy.slice('axis:'.length) : null;
}

/** Group page items exactly like the facade does (non-empty groups only). */
export function groupItems(
  items: EntitySummary[],
  groupBy: GroupByKey,
  axes?: TaskAxis[],
): CollectionGroup[] {
  const groups = new Map<string, { label: string; items: EntitySummary[] }>();
  const push = (key: string, label: string, s: EntitySummary): void => {
    const g = groups.get(key) ?? { label, items: [] };
    g.items.push(s);
    groups.set(key, g);
  };

  for (const s of items) {
    if (groupBy === 'workStatus') {
      const status: WorkStatus = s.state.kind === 'task' ? s.state.workStatus : 'open';
      push(status, status.replace('_', ' '), s);
    } else if (groupBy === 'assignee') {
      const assignees = s.state.kind === 'task' ? s.state.assignees : [];
      if (assignees.length === 0) push('unassigned', 'Unassigned', s);
      for (const a of assignees) push(a.id, a.displayName, s);
    } else {
      const axis = axisNameOf(groupBy) as string;
      const value = s.state.kind === 'task' ? (s.state.axes[axis] ?? '') : '';
      push(value || 'none', value || 'None', s);
    }
  }

  let ordered: CollectionGroup[] = [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label, items: g.items }));
  if (groupBy === 'workStatus') {
    ordered = ordered.sort((a, b) =>
      STATUS_ORDER.indexOf(a.key as WorkStatus) - STATUS_ORDER.indexOf(b.key as WorkStatus));
  } else if (isAxisGroupBy(groupBy)) {
    const axis = axes?.find((a) => a.name === axisNameOf(groupBy));
    if (axis) {
      const order = new Map(axis.axisValues.map((v, i) => [v, i]));
      ordered = ordered.sort((a, b) =>
        (order.get(a.key) ?? order.size) - (order.get(b.key) ?? order.size));
    }
  }
  return ordered;
}

export interface BoardColumn { key: string; label: string; items: EntitySummary[] }

/**
 * Board columns = the grouped items PLUS the empty drop targets the pivot
 * implies: every status, every axis value (default or manual alike), every
 * observed assignee. Empty columns are how a card gets dragged *into* a state
 * nothing is in yet.
 */
export function boardColumns(
  items: EntitySummary[],
  groupBy: GroupByKey,
  axes?: TaskAxis[],
): BoardColumn[] {
  const grouped = new Map(groupItems(items, groupBy, axes).map((g) => [g.key, g]));
  const columns: BoardColumn[] = [];
  const take = (key: string, label: string): void => {
    const g = grouped.get(key);
    columns.push({ key, label: g?.label ?? label, items: g?.items ?? [] });
    grouped.delete(key);
  };

  if (groupBy === 'workStatus') {
    for (const status of STATUS_ORDER) {
      // Cancelled stays hidden unless something is actually in it.
      if (status === 'cancelled' && !grouped.has(status)) continue;
      take(status, status.replace('_', ' '));
    }
  } else if (isAxisGroupBy(groupBy)) {
    const axis = axes?.find((a) => a.name === axisNameOf(groupBy));
    for (const value of axis?.axisValues ?? []) take(value, value);
  } else {
    take('unassigned', 'Unassigned');
  }
  // Anything observed but not canonical (e.g. per-actor assignee groups,
  // out-of-catalog axis values) appends in grouped order.
  for (const g of grouped.values()) columns.push({ key: g.key, label: g.label, items: g.items });
  return columns;
}
