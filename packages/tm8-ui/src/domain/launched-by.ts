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

/** The launcher's id, or null when the state names none. */
export function launchedByOf(state: unknown): string | null {
  const value = (state as { launchedBy?: unknown } | null | undefined)?.launchedBy;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The row a tree nests this one under: its launcher, else its parent. */
export function treeParentOf(row: Pick<EntitySummary, 'parentId' | 'state'>): string | null {
  return launchedByOf(row.state) ?? row.parentId ?? null;
}
