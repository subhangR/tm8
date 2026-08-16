/**
 * homeRegionStore — Home's root selection and region-B subject (task
 * 01a006f8 D5–D8/D10/D11/D15, generalized by task 01a00932: the three-tab
 * column became a ROOT over chats + every collection kind).
 *
 * Two facts per space, and WHY they are module-level rather than component
 * state:
 *
 *  - `root`: which population Home's left column lists — `CHATS_ROOT` or a
 *    collection kind (R3: all of them, registry-driven). D15 says it persists
 *    PER SPACE and the first visit opens on Chats — so it round-trips
 *    localStorage, unlike the screen stacks (whose in-memory-only ruling is
 *    about entity IDS, which go stale on reload; a root name cannot go
 *    stale). Legacy stored values from the tab era ('tasks', 'sessions')
 *    still resolve to the kinds they meant.
 *  - `center`: the entity occupying region B, or null when B shows the chat.
 *    In-memory only, same reasoning as `screenStackStore`: switching rail
 *    items unmounts HomeView, and D11's spawn path writes this from OUTSIDE
 *    the view (GateApp's launch submit puts the new session in B and flips
 *    the root to sessions) — component state could do neither.
 *
 * Keyed by space id so switching spaces cannot carry one space's selection
 * into another — the same bleed `screenStackStore.clearAll` exists for, made
 * structural instead of swept.
 */
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EntityId } from '@tm8/contract';
import {
  CHATS_ROOT,
  LEGACY_HOME_TAB_KINDS,
  isHomeRootKind,
  type HomeRoot,
} from '../domain';

export type { HomeRoot };

/** D15: the default root is Chats (R10 — land on the conversation surface). */
export const DEFAULT_HOME_ROOT: HomeRoot = CHATS_ROOT;

/* The key deliberately keeps the tab-era name: stored legacy values are
   readable and `normalizeRoot` maps them forward. */
const storageKey = (spaceId: string) => `tm8.home.tab:${spaceId}`;

/** A stored or incoming root name → a root this build can list. */
function normalizeRoot(raw: string | null): HomeRoot {
  if (raw === CHATS_ROOT) return CHATS_ROOT;
  if (raw === null) return DEFAULT_HOME_ROOT;
  const mapped = LEGACY_HOME_TAB_KINDS[raw] ?? raw;
  return isHomeRootKind(mapped) ? mapped : DEFAULT_HOME_ROOT;
}

/** localStorage may be absent or refused (gate tests run without it). A read
 *  that throws or holds junk is the same as no preference: the default. */
function loadRoot(spaceId: string): HomeRoot {
  try {
    return normalizeRoot(window.localStorage.getItem(storageKey(spaceId)));
  } catch {
    return DEFAULT_HOME_ROOT;
  }
}

export interface HomeRegionStore {
  /** Per-space root overrides made THIS session; misses fall back to storage. */
  roots: Readonly<Record<string, HomeRoot>>;
  /** Per-space region-B subject. Absent/null = the chat occupies B (D7/D8). */
  centers: Readonly<Record<string, EntityId | null>>;
  setRoot(spaceId: string, root: HomeRoot): void;
  /** Put an entity in region B (null returns B to the chat). */
  selectCenter(spaceId: string, id: EntityId | null): void;
}

export const homeRegionStore: StoreApi<HomeRegionStore> = createStore<HomeRegionStore>()(
  (set, get) => ({
    roots: {},
    centers: {},
    setRoot(spaceId, root) {
      const next = normalizeRoot(root);
      set({ roots: { ...get().roots, [spaceId]: next } });
      try {
        window.localStorage.setItem(storageKey(spaceId), next);
      } catch {
        // No storage ⇒ the choice lives for the session only. Still a choice.
      }
    },
    selectCenter(spaceId, id) {
      set({ centers: { ...get().centers, [spaceId]: id } });
    },
  }),
);

export function rootOf(state: Pick<HomeRegionStore, 'roots'>, spaceId: string): HomeRoot {
  return state.roots[spaceId] ?? loadRoot(spaceId);
}

export function centerOf(state: Pick<HomeRegionStore, 'centers'>, spaceId: string): EntityId | null {
  return state.centers[spaceId] ?? null;
}

/** The view-side handle: current root + B subject and the two writes. */
export function useHomeRegion(spaceId: string) {
  const root = useStore(homeRegionStore, (s) => rootOf(s, spaceId));
  const center = useStore(homeRegionStore, (s) => centerOf(s, spaceId));
  const store = homeRegionStore.getState();
  return {
    root,
    center,
    setRoot: (next: HomeRoot) => store.setRoot(spaceId, next),
    selectCenter: (id: EntityId | null) => store.selectCenter(spaceId, id),
  };
}
