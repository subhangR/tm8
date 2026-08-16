/**
 * homeRegionStore — Home's three-region selection state (task 01a006f8,
 * D5–D8/D10/D11/D15).
 *
 * Two facts per space, and WHY they are module-level rather than component
 * state:
 *
 *  - `tab`: which of Home's left-column tabs (Chats | Tasks | Sessions) is
 *    active. D15 says it persists PER SPACE and the first visit opens on
 *    Chats — so it round-trips localStorage, unlike the screen stacks (whose
 *    in-memory-only ruling is about entity IDS, which go stale on reload;
 *    a tab name cannot go stale).
 *  - `center`: the entity occupying region B, or null when B shows the chat.
 *    In-memory only, same reasoning as `screenStackStore`: switching rail
 *    items unmounts HomeView, and D11's spawn path writes this from OUTSIDE
 *    the view (GateApp's launch submit puts the new session in B and flips
 *    the tab to Sessions) — component state could do neither.
 *
 * Keyed by space id so switching spaces cannot carry one space's selection
 * into another — the same bleed `screenStackStore.clearAll` exists for, made
 * structural instead of swept.
 */
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EntityId } from '@tm8/contract';

export type HomeTab = 'tasks' | 'chats' | 'sessions';

const TAB_VALUES: readonly HomeTab[] = ['tasks', 'chats', 'sessions'];
/** D15: the default active tab is Chats (the ORDER is Chats | Tasks | Sessions,
 *  re-ruled by Subhang 2026-08-16). */
export const DEFAULT_HOME_TAB: HomeTab = 'chats';

const storageKey = (spaceId: string) => `tm8.home.tab:${spaceId}`;

/** localStorage may be absent or refused (gate tests run without it). A read
 *  that throws or holds junk is the same as no preference: the default. */
function loadTab(spaceId: string): HomeTab {
  try {
    const raw = window.localStorage.getItem(storageKey(spaceId));
    return TAB_VALUES.includes(raw as HomeTab) ? (raw as HomeTab) : DEFAULT_HOME_TAB;
  } catch {
    return DEFAULT_HOME_TAB;
  }
}

export interface HomeRegionStore {
  /** Per-space tab overrides made THIS session; misses fall back to storage. */
  tabs: Readonly<Record<string, HomeTab>>;
  /** Per-space region-B subject. Absent/null = the chat occupies B (D7/D8). */
  centers: Readonly<Record<string, EntityId | null>>;
  setTab(spaceId: string, tab: HomeTab): void;
  /** Put an entity in region B (null returns B to the chat). */
  selectCenter(spaceId: string, id: EntityId | null): void;
}

export const homeRegionStore: StoreApi<HomeRegionStore> = createStore<HomeRegionStore>()(
  (set, get) => ({
    tabs: {},
    centers: {},
    setTab(spaceId, tab) {
      set({ tabs: { ...get().tabs, [spaceId]: tab } });
      try {
        window.localStorage.setItem(storageKey(spaceId), tab);
      } catch {
        // No storage ⇒ the choice lives for the session only. Still a choice.
      }
    },
    selectCenter(spaceId, id) {
      set({ centers: { ...get().centers, [spaceId]: id } });
    },
  }),
);

export function tabOf(state: Pick<HomeRegionStore, 'tabs'>, spaceId: string): HomeTab {
  return state.tabs[spaceId] ?? loadTab(spaceId);
}

export function centerOf(state: Pick<HomeRegionStore, 'centers'>, spaceId: string): EntityId | null {
  return state.centers[spaceId] ?? null;
}

/** The view-side handle: current tab + B subject and the two writes. */
export function useHomeRegion(spaceId: string) {
  const tab = useStore(homeRegionStore, (s) => tabOf(s, spaceId));
  const center = useStore(homeRegionStore, (s) => centerOf(s, spaceId));
  const store = homeRegionStore.getState();
  return {
    tab,
    center,
    setTab: (next: HomeTab) => store.setTab(spaceId, next),
    selectCenter: (id: EntityId | null) => store.selectCenter(spaceId, id),
  };
}
