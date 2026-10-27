import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { TILE_LINK_GROUPS } from '../../domain/tile-counts';

/**
 * ROW VIEW — which facts a list row draws, chosen by the viewer from the
 * `View` section of the list header's `⋯` menu (task 01a0ebdf, design form
 * 01a0ebe2; moved out of the funnel by design doc 01a1465d §5).
 *
 * The rulings the form settled, all still in force:
 *   · PER KIND. Each list remembers its own choice; hiding avatars on the
 *     Sessions list says nothing about Tasks. A tile nested under another
 *     kind's row follows ITS OWN kind's choice, so a row looks the same
 *     wherever it is drawn.
 *   · THIS DEVICE. Stored in localStorage — no server state.
 *   · EVERYTHING ON BY DEFAULT. What is stored is the HIDDEN set, so an
 *     absent or unreadable entry is the default look, and a facet added later
 *     arrives visible rather than silently hidden.
 *
 * WHAT CHANGED ON 2026-10-16 (approved change list, message 01a14695-6b54).
 * The quiet tile is not "the old tile with switches flipped" — the cut facts
 * are GONE from the renderers, so they are gone from here too. Twelve of the
 * fifteen facets left with them: `model`, `agent_avatar`, `lane`,
 * `linked_tasks`, `forms`, `meta` (priority except urgent), `status_word`
 * (the status is colour and glyph now, with the word kept for screen
 * readers), `prs`, `sessions_chip`, `docs_memories` and the two message
 * tallies. A switch for a fact no renderer draws is a dead control, and this
 * file is the switchboard — it is where that has to be true.
 *
 * WHY THE STORAGE VERSION MOVED. A viewer who had hidden `status_word` on
 * Tasks has `["status_word"]` under the v1 key. That id no longer resolves,
 * so the entry was already inert — but it would have sat in storage forever,
 * and the migration is cheap and runs exactly once per kind (see `migrate`).
 * Surviving ids carry over; dropped ids are discarded with the key.
 *
 * A facet hides PRESENTATION only. Nothing here narrows the query, and the
 * status mark, the title, the one signal, the time and the row's verbs are not
 * facets at all: a row with every facet off is still a row you can read and
 * act on.
 */
export type RowFacet =
  /** The one signal on a task or PR row: the assignee / owner avatar. */
  | 'avatar'
  /** The counts line: Docs · PRs · Artifacts · Drawings · Memories. */
  | 'counts'
  /** The done-of-total bar, on the kinds whose registry row declares one. */
  | 'progress'
  /**
   * ONE LINK GROUP ON THE COUNTS LINE (`links:docs`, `links:prs`, …): the List
   * settings menu's per-link switches (Subhang 2026-10-17). Hidden ⇒ that
   * group's count is not drawn; the line itself stays under `counts`.
   */
  | `links:${string}`;

/** The tile anatomies the registry declares (`list.tile.anatomy`). */
export type RowAnatomy = 'standard' | 'control-card' | 'session-tree';

export interface RowFacetSpec {
  id: RowFacet;
  label: string;
  /** The anatomies that actually draw this fact — the picker offers no dead switches. */
  anatomies: readonly RowAnatomy[];
}

const ALL: readonly RowAnatomy[] = ['standard', 'control-card', 'session-tree'];

/** Menu order: the row's own line first, then what hangs under it. */
export const ROW_FACETS: readonly RowFacetSpec[] = [
  { id: 'avatar', label: 'People avatars', anatomies: ['standard', 'control-card'] },
  /* Only kinds whose registry row declares `tile.progress` draw it (story,
     and task on its control card since 307). */
  { id: 'progress', label: 'Progress', anatomies: ['standard', 'control-card'] },
  { id: 'counts', label: 'Counts line', anatomies: ALL },
];

/** The counts line's per-group facet, by `TILE_LINK_GROUPS` id. */
export function linkFacet(groupId: string): RowFacet {
  return `links:${groupId}`;
}

const FACET_IDS: ReadonlySet<string> = new Set([
  ...ROW_FACETS.map((spec) => spec.id),
  ...TILE_LINK_GROUPS.map((group) => linkFacet(group.id)),
]);

/** The link-group ids a row view hides (`links:docs` ⇒ `docs`). */
export function hiddenLinkGroups(hidden: ReadonlySet<RowFacet>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const facet of hidden) if (facet.startsWith('links:')) out.add(facet.slice('links:'.length));
  return out;
}

export function facetsForAnatomy(anatomy: RowAnatomy | undefined): readonly RowFacetSpec[] {
  const resolved = anatomy ?? 'standard';
  return ROW_FACETS.filter((spec) => spec.anatomies.includes(resolved));
}

// ---- the store ------------------------------------------------------------

const STORAGE_PREFIX = 'tm8.list.rowView.v2.';
/** The pre-quiet-tile key. Read once per kind by `migrate`, then removed. */
const LEGACY_PREFIX = 'tm8.list.rowView.v1.';
const EMPTY: ReadonlySet<RowFacet> = new Set();

export function rowViewStorageKey(kind: string): string {
  return `${STORAGE_PREFIX}${kind}`;
}

export function legacyRowViewStorageKey(kind: string): string {
  return `${LEGACY_PREFIX}${kind}`;
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

/**
 * ONE-TIME CARRY-OVER from the pre-quiet-tile key, for one kind.
 *
 * Runs only when the v2 key is ABSENT, so it cannot overwrite a choice made
 * since; it always removes the v1 key, so it runs at most once per kind per
 * device whether or not anything survived the filter. A v1 entry of only cut
 * ids (the common case — `status_word`, `model`, the message tallies) carries
 * nothing over and leaves no v2 key, which is the default look.
 */
function migrate(kind: string): string | null {
  const store = storage();
  if (!store) return null;
  const legacyKey = legacyRowViewStorageKey(kind);
  const legacy = store.getItem(legacyKey);
  if (legacy === null) return null;
  const kept = [...parse(legacy)];
  try {
    store.removeItem(legacyKey);
    if (kept.length > 0) {
      const raw = JSON.stringify(kept);
      store.setItem(rowViewStorageKey(kind), raw);
      return raw;
    }
  } catch {
    // Quota or access failure: the carry-over is skipped and the kind reads
    // its default, which is a visible, correct row rather than a wrong one.
  }
  return null;
}

export function readHiddenFacets(kind: string): ReadonlySet<RowFacet> {
  const cached = cache.get(kind);
  if (cached) return cached;
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(rowViewStorageKey(kind)) ?? null;
    if (raw === null) raw = migrate(kind);
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
