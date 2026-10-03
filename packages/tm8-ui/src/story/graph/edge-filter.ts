/**
 * Which edge types the story graph draws (issue #35). The trail follows many
 * edge types (contains, working_on, created_in, ...) and drawing them all
 * clutters a large story, so the graph opens with NO edges and the user turns
 * on the types they want.
 *
 * The selection is one set of edge type names, shared by every story graph and
 * kept in localStorage: it survives navigating between stories and reloads on
 * this device. Module-level store, so every mounted graph sees one value.
 */
import { useCallback, useSyncExternalStore } from 'react';

import type { GraphEdge } from './layout';

export const EDGE_TYPES_STORAGE_KEY = 'tm8.story.graph.edgeTypes';

const EMPTY: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let current: ReadonlySet<string> | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function read(): ReadonlySet<string> {
  if (current) return current;
  let next = EMPTY;
  try {
    const raw = storage()?.getItem(EDGE_TYPES_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) next = new Set(parsed.filter((t): t is string => typeof t === 'string'));
  } catch {
    /* A bad stored value falls back to no edges. */
  }
  current = next;
  return next;
}

export function setEdgeTypes(next: ReadonlySet<string>): void {
  current = new Set(next);
  try {
    storage()?.setItem(EDGE_TYPES_STORAGE_KEY, JSON.stringify([...next].sort()));
  } catch {
    /* Storage full or blocked: the selection still holds for this page. */
  }
  for (const l of listeners) l();
}

/** Test seam: forget the cached value so the next read goes to storage. */
export function resetEdgeTypesForTest(): void {
  current = null;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The edge types drawn, and a toggle for one type. Empty = no edges (the default). */
export function useEdgeTypes(): { types: ReadonlySet<string>; toggle: (type: string) => void; set: (next: ReadonlySet<string>) => void } {
  const types = useSyncExternalStore(subscribe, read, () => EMPTY);
  const toggle = useCallback((type: string) => {
    const next = new Set(read());
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setEdgeTypes(next);
  }, []);
  return { types, toggle, set: setEdgeTypes };
}

/** The edge types the layout draws, with how many of each, most common first. */
export function edgeTypeCounts(edges: readonly Pick<GraphEdge, 'type'>[]): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of edges) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}
