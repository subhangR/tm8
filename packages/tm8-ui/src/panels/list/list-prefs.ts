import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { EntitySummary } from '@tm8/contract';

/**
 * LIST PREFERENCES THE PINNED-ONLY RAIL'S SETTINGS MENU OWNS (Subhang,
 * 2026-10-17): how the loaded rows are GROUPED, and whether sub-items show in
 * the tree. Per kind, per device, like `row-view.ts` — presentation only:
 * nothing here narrows the query, so a group or a hidden child never changes
 * which rows the list holds, only how they are laid out.
 *
 * Group by works on the rows already loaded (a page at a time), so a group's
 * count is the count on screen, not the kind's total.
 */
export type ListGroupBy = 'none' | 'status' | 'priority' | 'assignee';

export interface ListGroupOption {
  id: ListGroupBy;
  label: string;
}

const NONE: ListGroupOption = { id: 'none', label: 'None' };
/** Only tasks carry status, priority and assignees on the summary today. */
const BY_KIND: Readonly<Record<string, readonly ListGroupOption[]>> = {
  task: [NONE, { id: 'status', label: 'Status' }, { id: 'priority', label: 'Priority' }, { id: 'assignee', label: 'Assignee' }],
};

export function groupOptionsFor(kind: string): readonly ListGroupOption[] {
  return BY_KIND[kind] ?? [NONE];
}

export interface ListPrefs {
  groupBy: ListGroupBy;
  subItems: boolean;
}

const DEFAULTS: ListPrefs = { groupBy: 'none', subItems: true };
const STORAGE_PREFIX = 'tm8.list.prefs.v1.';
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; prefs: ListPrefs }>();

function read(kind: string): ListPrefs {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_PREFIX + kind);
  } catch {
    raw = null;
  }
  const hit = cache.get(kind);
  if (hit && hit.raw === raw) return hit.prefs;
  let prefs = DEFAULTS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ListPrefs>;
      const groupBy = groupOptionsFor(kind).some((o) => o.id === parsed.groupBy) ? (parsed.groupBy as ListGroupBy) : 'none';
      prefs = { groupBy, subItems: parsed.subItems !== false };
    } catch {
      prefs = DEFAULTS;
    }
  }
  cache.set(kind, { raw, prefs });
  return prefs;
}

function write(kind: string, prefs: ListPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + kind, JSON.stringify(prefs));
  } catch {
    // No storage ⇒ the choice lasts as long as the page.
    cache.set(kind, { raw: JSON.stringify(prefs), prefs });
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useListPrefs(kind: string): ListPrefs & {
  setGroupBy(groupBy: ListGroupBy): void;
  setSubItems(on: boolean): void;
  reset(): void;
  changed: number;
} {
  const prefs = useSyncExternalStore(subscribe, () => read(kind), () => DEFAULTS);
  const setGroupBy = useCallback((groupBy: ListGroupBy) => write(kind, { ...read(kind), groupBy }), [kind]);
  const setSubItems = useCallback((on: boolean) => write(kind, { ...read(kind), subItems: on }), [kind]);
  const reset = useCallback(() => write(kind, DEFAULTS), [kind]);
  return useMemo(
    () => ({
      ...prefs,
      setGroupBy,
      setSubItems,
      reset,
      changed: (prefs.groupBy !== 'none' ? 1 : 0) + (prefs.subItems ? 0 : 1),
    }),
    [prefs, setGroupBy, setSubItems, reset],
  );
}

/** Rows whose parent is not in the set — the tree's roots, children dropped. */
export function rootsOnly(rows: readonly EntitySummary[]): EntitySummary[] {
  const ids = new Set(rows.map((row) => row.id));
  return rows.filter((row) => row.parentId === null || !ids.has(row.parentId));
}

const STATUS_ORDER = ['open', 'pulled', 'working', 'in_review', 'blocked', 'done', 'cancelled'];
const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'];

function words(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The group a row falls in, and where that group sorts among the others. */
export function groupOf(row: EntitySummary, groupBy: ListGroupBy): { key: string; label: string; rank: number } {
  const state = row.state as { kind: string; status?: string; priority?: string; assignees?: { id: string; displayName: string }[] };
  if (groupBy === 'status') {
    const status = state.status ?? 'none';
    const i = STATUS_ORDER.indexOf(status);
    return { key: status, label: status === 'none' ? 'No status' : words(status), rank: i < 0 ? STATUS_ORDER.length : i };
  }
  if (groupBy === 'priority') {
    const priority = state.priority ?? 'none';
    const i = PRIORITY_ORDER.indexOf(priority);
    return { key: priority, label: priority === 'none' ? 'No priority' : words(priority), rank: i < 0 ? PRIORITY_ORDER.length : i };
  }
  if (groupBy === 'assignee') {
    /* A task with several assignees groups under its FIRST one. */
    const first = state.assignees?.[0];
    return first ? { key: first.id, label: first.displayName, rank: 0 } : { key: 'none', label: 'Unassigned', rank: 1 };
  }
  return { key: 'all', label: '', rank: 0 };
}
