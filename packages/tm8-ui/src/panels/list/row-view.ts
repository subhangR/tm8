import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { TileCountFacet } from '../../domain/tile-counts';

/**
 * ROW VIEW — which facts a list row draws, chosen by the viewer from the
 * `View ▾` picker in the filter row (task 01a0ebdf, design form 01a0ebe2).
 *
 * The rulings the form settled:
 *   · PER KIND. Each list remembers its own choice; hiding the model on the
 *     Sessions list says nothing about Tasks. A tile nested under another
 *     kind's row (a session opened under a task) follows ITS OWN kind's
 *     choice, so a session looks the same wherever it is drawn.
 *   · THIS DEVICE. Stored in localStorage — no server state, no migration.
 *   · EVERYTHING ON BY DEFAULT. What is stored is the HIDDEN set, so an
 *     absent or unreadable entry is today's look, and a facet added later
 *     arrives visible rather than silently hidden.
 *
 * A facet hides PRESENTATION only. Nothing here narrows the query, and the
 * status mark, title, liveness dot and row actions are not facets at all:
 * a row with every facet off is still a row you can read and act on.
 */
export type RowFacet =
  | 'model'
  | 'agent_avatar'
  | 'lane'
  | 'linked_tasks'
  | 'avatar'
  | 'meta'
  | 'status_word'
  | 'progress'
  | 'prs'
  | 'sessions_chip'
  | 'docs_memories'
  | 'human_messages'
  | 'agent_messages'
  | 'forms';

/** The tile anatomies the registry declares (`list.tile.anatomy`). */
export type RowAnatomy = 'standard' | 'control-card' | 'session-tree';

export interface RowFacetSpec {
  id: RowFacet;
  label: string;
  /** The anatomies that actually draw this fact — the picker offers no dead switches. */
  anatomies: readonly RowAnatomy[];
}

const ALL: readonly RowAnatomy[] = ['standard', 'control-card', 'session-tree'];

/** Menu order: the row's own identity facts first, then the badge sub-row left to right. */
export const ROW_FACETS: readonly RowFacetSpec[] = [
  { id: 'model', label: 'Model', anatomies: ['session-tree'] },
  /* The persona FACE only. The tile keeps its tool mark, which also carries
     the liveness ring and the sub-session count, so hiding the teammate can
     never hide whether the session is running. */
  { id: 'agent_avatar', label: 'Teammate avatar', anatomies: ['session-tree'] },
  { id: 'avatar', label: 'People avatars', anatomies: ['standard', 'control-card'] },
  { id: 'meta', label: 'Details & priority', anatomies: ['standard'] },
  /* Standard rows only: the task tile's status word is already screen-reader
     text behind its dot, and a session's status is its glyph. */
  { id: 'status_word', label: 'Status label', anatomies: ['standard'] },
  /* Only kinds whose registry row declares `tile.progress` draw it (story). */
  { id: 'progress', label: 'Progress', anatomies: ['standard'] },
  { id: 'lane', label: 'Branch / worktree', anatomies: ['session-tree'] },
  { id: 'linked_tasks', label: 'Linked tasks', anatomies: ['session-tree'] },
  { id: 'forms', label: 'Pending forms', anatomies: ['session-tree'] },
  { id: 'sessions_chip', label: 'Linked sessions', anatomies: ALL },
  { id: 'prs', label: 'Pull requests', anatomies: ['control-card', 'session-tree'] },
  { id: 'docs_memories', label: 'Docs & memories', anatomies: ALL },
  { id: 'human_messages', label: 'Member messages', anatomies: ALL },
  { id: 'agent_messages', label: 'Agent messages', anatomies: ALL },
];

const FACET_IDS: ReadonlySet<string> = new Set(ROW_FACETS.map((spec) => spec.id));

export function facetsForAnatomy(anatomy: RowAnatomy | undefined): readonly RowFacetSpec[] {
  const resolved = anatomy ?? 'standard';
  return ROW_FACETS.filter((spec) => spec.anatomies.includes(resolved));
}

/**
 * Whether a tile count badge survives the view, by the facet the badge's own
 * data names (`TileCountBadge.facet`). The undivided pre-109 total is hidden
 * only when BOTH message facets are, since it is both.
 */
export function countBadgeVisible(facet: TileCountFacet, hidden: ReadonlySet<RowFacet>): boolean {
  return facet === 'messages'
    ? !(hidden.has('human_messages') && hidden.has('agent_messages'))
    : !hidden.has(facet);
}

// ---- the store ------------------------------------------------------------

const STORAGE_PREFIX = 'tm8.list.rowView.v1.';
const EMPTY: ReadonlySet<RowFacet> = new Set();

export function rowViewStorageKey(kind: string): string {
  return `${STORAGE_PREFIX}${kind}`;
}

/** Parsed snapshots, one per kind, so `useSyncExternalStore` sees a stable reference. */
const cache = new Map<string, ReadonlySet<RowFacet>>();
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    // Storage can throw on access (privacy mode, sandboxed frame): the view
    // then simply does not persist, and every row keeps its default look.
    return null;
  }
}

function parse(raw: string | null): ReadonlySet<RowFacet> {
  if (!raw) return EMPTY;
  try {
    const value: unknown = JSON.parse(raw);
    const list = Array.isArray(value) ? value : [];
    const facets = list.filter((item): item is RowFacet => typeof item === 'string' && FACET_IDS.has(item));
    return facets.length > 0 ? new Set(facets) : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function readHiddenFacets(kind: string): ReadonlySet<RowFacet> {
  const cached = cache.get(kind);
  if (cached) return cached;
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(rowViewStorageKey(kind)) ?? null;
  } catch {
    raw = null;
  }
  const parsed = parse(raw);
  cache.set(kind, parsed);
  return parsed;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function writeHiddenFacets(kind: string, hidden: Iterable<RowFacet>): void {
  const next = new Set([...hidden].filter((facet) => FACET_IDS.has(facet)));
  cache.set(kind, next.size > 0 ? next : EMPTY);
  try {
    const store = storage();
    if (next.size === 0) store?.removeItem(rowViewStorageKey(kind));
    else store?.setItem(rowViewStorageKey(kind), JSON.stringify([...next]));
  } catch {
    // Quota or access failure: the choice still holds for this page.
  }
  emit();
}

function onStorage(event: StorageEvent): void {
  // Another tab changed a view (or cleared storage): drop the stale snapshot.
  if (event.key === null) cache.clear();
  else if (event.key.startsWith(STORAGE_PREFIX)) cache.delete(event.key.slice(STORAGE_PREFIX.length));
  else return;
  emit();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** Test seam: forget every parsed snapshot so the next read goes to storage. */
export function resetRowViewCache(): void {
  cache.clear();
}

export interface RowView {
  hidden: ReadonlySet<RowFacet>;
  shows: (facet: RowFacet) => boolean;
  toggle: (facet: RowFacet) => void;
  reset: () => void;
}

export function useRowView(kind: string): RowView {
  const hidden = useSyncExternalStore(
    subscribe,
    () => readHiddenFacets(kind),
    () => EMPTY,
  );
  const toggle = useCallback(
    (facet: RowFacet) => {
      const next = new Set(readHiddenFacets(kind));
      if (next.has(facet)) next.delete(facet);
      else next.add(facet);
      writeHiddenFacets(kind, next);
    },
    [kind],
  );
  const reset = useCallback(() => writeHiddenFacets(kind, []), [kind]);
  return useMemo(
    () => ({ hidden, shows: (facet: RowFacet) => !hidden.has(facet), toggle, reset }),
    [hidden, toggle, reset],
  );
}
