/**
 * Recents + palette context.
 *
 * Search is deferred for v1 (STATE.md ⚠ contract update), so the palette's
 * entity source is "what this session already knows": the entities the viewer
 * recently opened (tracked here off the nav store), plus whatever the graph
 * store has cached, plus entities a host passes in. No facade.search — ever.
 *
 * `openPaletteWith(entityId)` is the imperative open-with-context helper other
 * layers call (a panel header ⌘K button, a card's "actions…" affordance).
 */
import { create } from 'zustand';
import { useNavStore } from '../../stores/nav';
import type { EntityId } from '../../types/contract';

export const RECENTS_CAP = 12;

export interface RecentsState {
  /** Most-recent-first entity ids. */
  ids: EntityId[];
  /** Entity the palette should treat as its context (null = global). */
  contextEntityId: EntityId | null;

  record: (id: EntityId | null | undefined) => void;
  setContext: (id: EntityId | null) => void;
  reset: () => void;
}

export const usePaletteStore = create<RecentsState>()((set) => ({
  ids: [],
  contextEntityId: null,

  record: (id) => set((s) => {
    if (!id) return {};
    if (s.ids[0] === id) return {};
    return { ids: [id, ...s.ids.filter((x) => x !== id)].slice(0, RECENTS_CAP) };
  }),

  setContext: (id) => set({ contextEntityId: id }),

  reset: () => set({ ids: [], contextEntityId: null }),
}));

/**
 * Mirror nav navigation into the recents list: every panel push, pin and Z4
 * route counts as "recently viewed". Returns the unsubscribe.
 */
export function startRecentsTracker(store: typeof useNavStore = useNavStore): () => void {
  const record = (): void => {
    const s = store.getState();
    const top = s.stack[s.stack.length - 1];
    usePaletteStore.getState().record(top?.entityId ?? s.entityId ?? null);
  };
  record();
  return store.subscribe(record);
}

/**
 * Open the palette, optionally scoped to a context entity so its actions
 * ("Link X to…", "Pull X", "Set status…") come back from `facade.getActions`.
 */
export function openPaletteWith(contextEntityId?: EntityId | null): void {
  usePaletteStore.getState().setContext(contextEntityId ?? null);
  if (contextEntityId) usePaletteStore.getState().record(contextEntityId);
  useNavStore.getState().openPalette();
}

/** Close the palette and drop its context. */
export function dismissPalette(): void {
  usePaletteStore.getState().setContext(null);
  useNavStore.getState().closePalette();
}

// --- selectors ----------------------------------------------------------------
export const selectRecentIds = (s: RecentsState): EntityId[] => s.ids;
export const selectPaletteContextId = (s: RecentsState): EntityId | null => s.contextEntityId;
