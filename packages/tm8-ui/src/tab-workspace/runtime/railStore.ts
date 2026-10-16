/**
 * The Workspace icon rail's own preferences (task 01a1112a-c568): pins per
 * space, explicit section open/close choices, the expanded flag, and the kinds
 * lifted to the top of the list (most recently unpinned first).
 *
 * SEPARATE FROM HOME'S RAIL (`stores/homeRailStore.ts`, `tm8.home.*`): the two
 * rails draw the same population but are arranged independently, so pinning
 * in one never moves the other.
 *
 * A STORED PIN LIST REPLACES THE DEFAULT — an empty list means "pin nothing",
 * not "use the default".
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { homeRailPinnedKinds, type KindConfig } from '../../domain';

/**
 * THE DEFAULT PINS (Subhang, 2026-10-16, design doc 01a1465d-a2b7 decision 1):
 * Chats, Tasks, Sessions, Docs, Artifacts, Teammates, in that order. Every
 * other kind is reached through All kinds and is not drawn by default. This is
 * also what `l 1`…`l 9` count, in this order.
 */
export const DEFAULT_WORKSPACE_RAIL_PINS: readonly string[] = [
  'chat',
  'task',
  'work_session',
  'doc',
  'artifact',
  'team_member',
];
export const railPinsKey = (spaceId: string) => `tm8.workspace.rail-pins:${spaceId}`;
export const RAIL_OPEN_KEY = 'tm8.workspace.rail-open';
export const RAIL_EXPANDED_KEY = 'tm8.workspace.rail-expanded';
export const railLiftedKey = (spaceId: string) => `tm8.workspace.rail-lifted:${spaceId}`;
/**
 * A NEW KEY, NOT `rail-expanded` REUSED (§11 risk 3). ⌘\ used to WIDEN the
 * 48px rail to 200px labels; in the navigator it COLLAPSES a 300px column to
 * the 48px strip. The two flags mean opposite things, so a viewer who had
 * widened the rail would land in the navigator collapsed — the stored `true`
 * read as the other state. A separate key leaves both readings intact and lets
 * the flag go back and forth without either preference inverting.
 *
 * `null` (nothing stored) is NOT `false`: it means nobody has chosen, so the
 * surface's own default applies — expanded in Work, collapsed in Craft (§9
 * phase 1). The first ⌘\ anywhere writes a real boolean and ends that.
 */
export const NAV_COLLAPSED_KEY = 'tm8.workspace.nav-collapsed';
/** Whether the pinned rows are folded into one icon strip (§3A). Remembered. */
export const NAV_PINS_FOLDED_KEY = 'tm8.workspace.nav-pins-folded';

export interface RailState {
  pins: readonly string[];
  /** Explicit per-section choices; a missing id follows the default-open rule. */
  open: Readonly<Record<string, boolean>>;
  expanded: boolean;
  /** Kinds drawn first in the list, most recently unpinned first (Subhang, 2026-10-07). */
  lifted: readonly string[];
  /** The navigator's collapsed state; `null` ⇒ unchosen, the surface's default wins. */
  collapsed: boolean | null;
  /** The navigator's pinned rows folded to one icon strip; `null` ⇒ unchosen. */
  pinsFolded: boolean | null;
  togglePin(kind: string): boolean;
  setOpen(sectionId: string, open: boolean): void;
  setExpanded(expanded: boolean): void;
  setCollapsed(collapsed: boolean): void;
  setPinsFolded(folded: boolean): void;
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

/**
 * The rail's Pinned group, top to bottom: what it draws and what `l 1`…`l 9`
 * count. ANY kind (Subhang, 2026-10-10): the rail lists every kind, and Pinned
 * is the same population, not only the kinds Work's browser can hold.
 */
export function workspacePinnedKinds(pins: readonly string[]): KindConfig[] {
  return homeRailPinnedKinds(pins);
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

export function loadWorkspaceRailLifted(spaceId: string): readonly string[] {
  const parsed = read(railLiftedKey(spaceId));
  return Array.isArray(parsed) && parsed.every((kind) => typeof kind === 'string') ? parsed : [];
}

export function loadWorkspaceRailExpanded(): boolean {
  return read(RAIL_EXPANDED_KEY) === true;
}

/** `null` when nothing was ever stored — see `NAV_COLLAPSED_KEY`. */
export function loadNavCollapsed(): boolean | null {
  const parsed = read(NAV_COLLAPSED_KEY);
  return typeof parsed === 'boolean' ? parsed : null;
}

export function loadNavPinsFolded(): boolean | null {
  const parsed = read(NAV_PINS_FOLDED_KEY);
  return typeof parsed === 'boolean' ? parsed : null;
}

/**
 * Spec D: once the node keeps this space's workspace, a rail change is a
 * `workspace.rail.set` command (it persists with the workspace and syncs to
 * every window) instead of a localStorage write.
 */
type RailPatch = { pins?: string[]; open?: Record<string, boolean>; expanded?: boolean; lifted?: string[] };
export interface RailWriter {
  write(patch: RailPatch): void;
}
const writers = new Map<string, RailWriter>();

/** Attach (or, with null, detach) the workspace as this space's rail writer. */
export function attachRailWriter(spaceId: string, writer: RailWriter | null): void {
  if (writer) writers.set(spaceId, writer);
  else writers.delete(spaceId);
}

/** Lay the workspace's stored rail prefs over the store (no write back). */
export function applyStoredRail(
  spaceId: string,
  rail: { pins: readonly string[]; open: Record<string, boolean>; expanded: boolean; lifted?: readonly string[] | undefined },
): void {
  const store = getRailStore(spaceId);
  const now = store.getState();
  const lifted = rail.lifted ?? [];
  if (
    now.expanded === rail.expanded &&
    now.pins.join('\u0000') === rail.pins.join('\u0000') &&
    now.lifted.join('\u0000') === lifted.join('\u0000') &&
    JSON.stringify(now.open) === JSON.stringify(rail.open)
  ) {
    return;
  }
  store.setState({ pins: [...rail.pins], open: { ...rail.open }, expanded: rail.expanded, lifted: [...lifted] });
}

/** The legacy (localStorage) rail prefs, for the one-time import; null when none were ever stored. */
export function legacyRail(spaceId: string): { pins: string[]; open: Record<string, boolean>; expanded: boolean; lifted: string[] } | null {
  const stored = read(railPinsKey(spaceId)) !== undefined || read(RAIL_OPEN_KEY) !== undefined || read(RAIL_EXPANDED_KEY) !== undefined;
  if (!stored) return null;
  return {
    pins: [...loadWorkspaceRailPins(spaceId)],
    open: loadWorkspaceRailOpen(),
    expanded: loadWorkspaceRailExpanded(),
    lifted: [...loadWorkspaceRailLifted(spaceId)],
  };
}

export function createRailStore(spaceId: string): RailStore {
  const persist = (patch: RailPatch, legacy: () => void) => {
    const writer = writers.get(spaceId);
    if (writer) writer.write(patch);
    else legacy();
  };
  return createStore<RailState>()((set, get) => ({
    pins: loadWorkspaceRailPins(spaceId),
    open: loadWorkspaceRailOpen(),
    expanded: loadWorkspaceRailExpanded(),
    lifted: loadWorkspaceRailLifted(spaceId),
    collapsed: loadNavCollapsed(),
    pinsFolded: loadNavPinsFolded(),
    /** Returns true when the kind is pinned afterwards. Unpinning lifts it to the top of the list. */
    togglePin(kind) {
      const { pins, lifted } = get();
      const pinning = !pins.includes(kind);
      const next = pinning ? [...pins, kind] : pins.filter((k) => k !== kind);
      const rest = lifted.filter((k) => k !== kind);
      const nextLifted = pinning ? rest : [kind, ...rest].slice(0, 32);
      persist({ pins: next, lifted: nextLifted }, () => {
        write(railPinsKey(spaceId), next);
        write(railLiftedKey(spaceId), nextLifted);
      });
      set({ pins: next, lifted: nextLifted });
      return pinning;
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
    /* NOT ROUTED THROUGH `persist`: the workspace's stored rail record has no
       field for either (Spec D's `workspace.rail.set` patch is pins / open /
       expanded / lifted). Widening the contract for a flagged surface would
       put a field on every persisted workspace for a column that may not
       ship; these stay local until the navigator lands, and then move with
       the same one-time import `legacyRail` already does. */
    setCollapsed(collapsed) {
      write(NAV_COLLAPSED_KEY, collapsed);
      set({ collapsed });
    },
    setPinsFolded(pinsFolded) {
      write(NAV_PINS_FOLDED_KEY, pinsFolded);
      set({ pinsFolded });
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
