/**
 * The Workspace icon rail's own preferences (task 01a1112a-c568): pins per
 * space, explicit section open/close choices, and the expanded flag.
 *
 * SEPARATE FROM HOME'S RAIL (`stores/homeRailStore.ts`, `tm8.home.*`): the two
 * rails draw the same population but are arranged independently, so pinning
 * in one never moves the other.
 *
 * A STORED PIN LIST REPLACES THE DEFAULT — an empty list means "pin nothing",
 * not "use the default".
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

export const DEFAULT_WORKSPACE_RAIL_PINS: readonly string[] = ['chat', 'task', 'work_session'];
export const railPinsKey = (spaceId: string) => `tm8.workspace.rail-pins:${spaceId}`;
export const RAIL_OPEN_KEY = 'tm8.workspace.rail-open';
export const RAIL_EXPANDED_KEY = 'tm8.workspace.rail-expanded';

export interface RailState {
  pins: readonly string[];
  /** Explicit per-section choices; a missing id follows the default-open rule. */
  open: Readonly<Record<string, boolean>>;
  expanded: boolean;
  togglePin(kind: string): boolean;
  setOpen(sectionId: string, open: boolean): void;
  setExpanded(expanded: boolean): void;
}
export type RailStore = StoreApi<RailState>;

function read(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // No storage ⇒ the choice lasts as long as the page. Still honoured.
  }
}

export function loadWorkspaceRailPins(spaceId: string): readonly string[] {
  const parsed = read(railPinsKey(spaceId));
  return Array.isArray(parsed) && parsed.every((kind) => typeof kind === 'string')
    ? parsed
    : DEFAULT_WORKSPACE_RAIL_PINS;
}

export function loadWorkspaceRailOpen(): Record<string, boolean> {
  const parsed = read(RAIL_OPEN_KEY);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
  );
}

export function loadWorkspaceRailExpanded(): boolean {
  return read(RAIL_EXPANDED_KEY) === true;
}

/**
 * Spec D: once the node keeps this space's workspace, a rail change is a
 * `workspace.rail.set` command (it persists with the workspace and syncs to
 * every window) instead of a localStorage write.
 */
export interface RailWriter {
  write(patch: { pins?: string[]; open?: Record<string, boolean>; expanded?: boolean }): void;
}
const writers = new Map<string, RailWriter>();

/** Attach (or, with null, detach) the workspace as this space's rail writer. */
export function attachRailWriter(spaceId: string, writer: RailWriter | null): void {
  if (writer) writers.set(spaceId, writer);
  else writers.delete(spaceId);
}

/** Lay the workspace's stored rail prefs over the store (no write back). */
export function applyStoredRail(spaceId: string, rail: { pins: readonly string[]; open: Record<string, boolean>; expanded: boolean }): void {
  const store = getRailStore(spaceId);
  const now = store.getState();
  if (
    now.expanded === rail.expanded &&
    now.pins.join('\u0000') === rail.pins.join('\u0000') &&
    JSON.stringify(now.open) === JSON.stringify(rail.open)
  ) {
    return;
  }
  store.setState({ pins: [...rail.pins], open: { ...rail.open }, expanded: rail.expanded });
}

/** The legacy (localStorage) rail prefs, for the one-time import; null when none were ever stored. */
export function legacyRail(spaceId: string): { pins: string[]; open: Record<string, boolean>; expanded: boolean } | null {
  const stored = read(railPinsKey(spaceId)) !== undefined || read(RAIL_OPEN_KEY) !== undefined || read(RAIL_EXPANDED_KEY) !== undefined;
  if (!stored) return null;
  return { pins: [...loadWorkspaceRailPins(spaceId)], open: loadWorkspaceRailOpen(), expanded: loadWorkspaceRailExpanded() };
}

export function createRailStore(spaceId: string): RailStore {
  const persist = (patch: { pins?: string[]; open?: Record<string, boolean>; expanded?: boolean }, legacy: () => void) => {
    const writer = writers.get(spaceId);
    if (writer) writer.write(patch);
    else legacy();
  };
  return createStore<RailState>()((set, get) => ({
    pins: loadWorkspaceRailPins(spaceId),
    open: loadWorkspaceRailOpen(),
    expanded: loadWorkspaceRailExpanded(),
    /** Returns true when the kind is pinned afterwards. */
    togglePin(kind) {
      const pins = get().pins;
      const next = pins.includes(kind) ? pins.filter((k) => k !== kind) : [...pins, kind];
      persist({ pins: next }, () => write(railPinsKey(spaceId), next));
      set({ pins: next });
      return next.includes(kind);
    },
    setOpen(sectionId, open) {
      const next = { ...get().open, [sectionId]: open };
      persist({ open: { [sectionId]: open } }, () => write(RAIL_OPEN_KEY, next));
      set({ open: next });
    },
    setExpanded(expanded) {
      persist({ expanded }, () => write(RAIL_EXPANDED_KEY, expanded));
      set({ expanded });
    },
  }));
}

const stores = new Map<string, RailStore>();

/** The kept-alive rail store for a space; created (and read from storage) on first use. */
export function getRailStore(spaceId: string): RailStore {
  let store = stores.get(spaceId);
  if (!store) {
    store = createRailStore(spaceId);
    stores.set(spaceId, store);
  }
  return store;
}

/** Test seam: forget the kept-alive stores so the next read re-loads storage. */
export function resetRailStores(): void {
  stores.clear();
}
