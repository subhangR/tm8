/**
 * WHO LAUNCHED A SESSION (330) — the `launched_by` edge, read off the summary.
 *
 * A launched session has no parent: the chat or session that started it is a
 * `launched_by` edge, carried on the session's state as `launchedBy`. Every
 * tree that nests sessions under their launcher reads it here, so a session
 * row nests the same way in every list. Read STRUCTURALLY (what the state
 * HAS), never by kind: a row without `launchedBy` keeps its `parentId`, which
 * is still how every other kind nests.
 */
import type { EntitySummary } from '@tm8/contract';
import { allKinds } from './registry';
import type { QueryFilter } from './types';

/** The launcher's id, or null when the state names none. */
export function launchedByOf(state: unknown): string | null {
  const value = (state as { launchedBy?: unknown } | null | undefined)?.launchedBy;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The row a tree nests this one under: its launcher, else its parent. */
export function treeParentOf(row: Pick<EntitySummary, 'parentId' | 'state'>): string | null {
  return launchedByOf(row.state) ?? row.parentId ?? null;
}

/**
 * THE LAUNCHED ROWS A LIST NESTS (331). A list whose registry row declares
 * `list.launches` (today: the chat list, `work_session`) also loads the rows
 * its own rows LAUNCHED and hangs each under its launcher via `treeParentOf`.
 * This is the one read for it — the filter, the bound and the id order — so a
 * later change (chats with sub-chats) is an edit here.
 *
 * Bounded: one page of launchers, at most LAUNCHERS_PER_READ ids, sorted so
 * the read's cache key does not churn with the list's order.
 */
export const LAUNCHERS_PER_READ = 100;

export function launchedRowsFilter(launcherIds: readonly string[]): { launchedBy: string[] } | null {
  if (launcherIds.length === 0) return null;
  return { launchedBy: [...new Set(launcherIds)].sort().slice(0, LAUNCHERS_PER_READ) };
}

/**
 * THE KINDS A LAUNCHER CAN BE (task 01a182c8). A session's launcher is a
 * session or any kind whose list declares `launches` of it (today: a chat).
 * Read off the registry, so a kind that starts launching sessions needs no
 * edit here. The kind itself comes first: most launchers are its own rows.
 */
export function launcherKindsOf(kind: string): readonly string[] {
  return [kind, ...allKinds().flatMap((config) => (config.list.launches === kind && config.kind !== kind ? [config.kind] : []))];
}

/** A kind's row reader — the host's `rowsFor(kind)`, absent where it has none. */
export type RowsForKind = (kind: string) => ((filter: QueryFilter) => readonly EntitySummary[]) | null | undefined;

/**
 * THE LAUNCHERS A FLAT SURFACE NAMES (task 01a182c8). A roster that draws
 * sessions side by side cannot nest them, so each launched row names who
 * launched it. Titles come from the rows the surface already holds (`known`,
 * by default the launched rows themselves), then from bounded `idIn` reads,
 * one per launcher kind, each asking only for the ids still unnamed — the same
 * bound as `launchedRowsFilter`.
 */
export function launcherTitlesOf(
  rows: readonly Pick<EntitySummary, 'id' | 'title' | 'state'>[],
  kind: string,
  rowsFor?: RowsForKind,
  known: readonly Pick<EntitySummary, 'id' | 'title'>[] = rows,
): ReadonlyMap<string, string> {
  const titles = new Map([...known, ...rows].map((row) => [row.id, row.title] as const));
  const missing = [...new Set(rows.flatMap((row) => {
    const launcher = launchedByOf(row.state);
    return launcher && !titles.has(launcher) ? [launcher] : [];
  }))].sort().slice(0, LAUNCHERS_PER_READ);
  if (missing.length > 0 && rowsFor) {
    let ask = missing;
    for (const launcherKind of launcherKindsOf(kind)) {
      if (ask.length === 0) break;
      const read = rowsFor(launcherKind);
      if (!read) continue;
      for (const row of read({ idIn: ask } as QueryFilter)) {
        if (ask.includes(row.id)) titles.set(row.id, row.title);
      }
      /* The next kind is asked only for the ids this one did not name. */
      ask = ask.filter((id) => !titles.has(id));
    }
  }
  return titles;
}

/**
 * `↳ launched by <title>` — the crumb a flat surface draws on a launched row,
 * or null when nothing launched it. Only the `launched_by` edge counts: a
 * legacy `parentId` is often a task, which launched nothing. A launcher no
 * read could name keeps its short id — the lineage is the point.
 */
export function launchedByCrumb(state: unknown, titles: ReadonlyMap<string, string>): string | null {
  const launcher = launchedByOf(state);
  if (!launcher) return null;
  return `↳ launched by ${titles.get(launcher) || `${launcher.slice(0, 8)}…`}`;
}
