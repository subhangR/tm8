/**
 * Nav store — space/view/entity route, the PANEL STACK ({stack, pinned}),
 * palette open-state, selection, and hash-URL serialization. No router dep:
 * `toHash()` / `hydrateFromHash()` are pure so every state is addressable and
 * back/forward becomes graph browsing history (the shell wires `hashchange`).
 *
 * Hash grammar:
 *   #/s/{spaceId}/{view}                         a primary view
 *   #/s/{spaceId}/{view}/{entityId}              a view focused on one entity
 *   #/s/{spaceId}/e/{entityId}                   the generic entity Z4 route
 *   ...?p=id1.id2&pin=id3&t=id2:connections      stack, pins, active tabs
 *
 * The `{view}/{entityId}` form exists because some views are entity-focused but
 * are NOT the generic Z4 route: `channel` (the hub) and `sessions` (a
 * work_session and its live terminal). Before it existed, both serialized to
 * `/e/{id}`, which `hydrateFromHash` could only read back as `entity` — so a
 * channel deep link, a reload, or back/forward silently landed on the generic
 * entity route instead of the hub, and the rail lost its active row.
 *
 * The invariant to preserve: **whatever `toHash` writes, `hydrateFromHash`
 * reads back as the same view.** There is a round-trip test over every view.
 */
import { create } from 'zustand';
import type { EntityId, SpaceId } from '../types/contract';

export type PanelTab = 'content' | 'discussion' | 'connections' | 'activity';
export interface PanelRef { entityId: EntityId; tab?: PanelTab }

export const MAX_PINNED = 3; // 2–3 persistent splits, per the UX brief

/**
 * ⚠ tm8 addition (drift ledger): `workspace`.
 *
 * The tm8 node supplies a three-column execution workspace (tasks │ live agent │
 * resources) through the shell's `extraViews` seam. It is a NEW route rather
 * than an override of `tasks`: the module's own Tasks screen stays exactly as it
 * was, so nothing the snapshot ships is replaced or forked.
 *
 * Listing it here is the entire store-side change. It is not entity-focused, so
 * `#/s/{space}/workspace` serializes through the existing generic grammar and
 * round-trips under the every-view test with no special case.
 */
export const VIEWS = [
  'home', 'tasks', 'workspace', 'docs', 'team', 'tracking', 'graph', 'leaderboard',
  'inbox', 'settings', 'sessions', 'channel', 'entity',
] as const;
export type ViewName = typeof VIEWS[number];

/**
 * Views that focus a single entity without being the generic Z4 route. These
 * serialize as `{view}/{entityId}` so they survive a reload; `entity` keeps its
 * own `/e/{id}` spelling for backwards compatibility with existing links.
 */
const ENTITY_FOCUSED_VIEWS: ReadonlySet<string> = new Set(['channel', 'sessions']);

export interface NavState {
  spaceId: SpaceId | null;
  view: ViewName;
  /** Entity for `entity`/`channel` full views (Z4). */
  entityId: EntityId | null;
  stack: PanelRef[];
  pinned: PanelRef[];
  paletteOpen: boolean;
  selection: EntityId[];

  setSpace: (spaceId: SpaceId) => void;
  setView: (view: ViewName, entityId?: EntityId | null) => void;
  /** Open a Z3 panel: replaces the peek top when `replace`, else stacks. */
  pushPanel: (ref: PanelRef, opts?: { replace?: boolean }) => void;
  popPanel: () => void;
  clearStack: () => void;
  setPanelTab: (entityId: EntityId, tab: PanelTab) => void;
  /** 📌 dock as persistent split; capped at MAX_PINNED. Returns success. */
  pinPanel: (entityId: EntityId) => boolean;
  unpinPanel: (entityId: EntityId) => void;
  /** ⤢ promote a panel to the Z4 route (current view becomes back target). */
  promotePanel: (entityId: EntityId) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  setSelection: (ids: EntityId[]) => void;
  toggleSelected: (id: EntityId) => void;

  toHash: () => string;
  hydrateFromHash: (hash: string) => void;
  reset: () => void;
}

const enc = encodeURIComponent;
const dec = decodeURIComponent;

function serializeRefs(refs: PanelRef[]): string {
  return refs.map((r) => enc(r.entityId)).join('.');
}
function serializeTabs(refs: PanelRef[]): string[] {
  return refs.filter((r) => r.tab).map((r) => `${enc(r.entityId)}:${r.tab as string}`);
}

export const useNavStore = create<NavState>()((set, get) => ({
  spaceId: null,
  view: 'home',
  entityId: null,
  stack: [],
  pinned: [],
  paletteOpen: false,
  selection: [],

  setSpace: (spaceId) => set({ spaceId, view: 'home', entityId: null, stack: [], pinned: [], selection: [] }),

  setView: (view, entityId = null) => set({ view, entityId, selection: [] }),

  pushPanel: (ref, opts = {}) => set((s) => {
    const withoutDupes = s.stack.filter((r) => r.entityId !== ref.entityId);
    if (opts.replace && withoutDupes.length > 0) {
      return { stack: [...withoutDupes.slice(0, -1), ref] };
    }
    return { stack: [...withoutDupes, ref] };
  }),

  popPanel: () => set((s) => ({ stack: s.stack.slice(0, -1) })),

  clearStack: () => set({ stack: [] }),

  setPanelTab: (entityId, tab) => set((s) => ({
    stack: s.stack.map((r) => (r.entityId === entityId ? { ...r, tab } : r)),
    pinned: s.pinned.map((r) => (r.entityId === entityId ? { ...r, tab } : r)),
  })),

  pinPanel: (entityId) => {
    const s = get();
    if (s.pinned.some((r) => r.entityId === entityId)) return true;
    if (s.pinned.length >= MAX_PINNED) return false;
    const ref = s.stack.find((r) => r.entityId === entityId) ?? { entityId };
    set({
      pinned: [...s.pinned, ref],
      stack: s.stack.filter((r) => r.entityId !== entityId),
    });
    return true;
  },

  unpinPanel: (entityId) => set((s) => ({ pinned: s.pinned.filter((r) => r.entityId !== entityId) })),

  promotePanel: (entityId) => set((s) => ({
    view: 'entity',
    entityId,
    stack: s.stack.filter((r) => r.entityId !== entityId),
  })),

  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),

  setSelection: (ids) => set({ selection: ids }),
  toggleSelected: (id) => set((s) => ({
    selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id],
  })),

  toHash: () => {
    const s = get();
    if (!s.spaceId) return '#/';
    const space = enc(s.spaceId);
    // An entity-focused view without an entity is a real state (the sessions
    // LIST, before one is selected), so it must serialize as the bare view
    // rather than a trailing empty segment — `/sessions/` would read back as a
    // focused view on the id "".
    const base = s.entityId
      ? (s.view === 'entity'
          ? `#/s/${space}/e/${enc(s.entityId)}`
          : ENTITY_FOCUSED_VIEWS.has(s.view)
            ? `#/s/${space}/${s.view}/${enc(s.entityId)}`
            : `#/s/${space}/${s.view}`)
      : `#/s/${space}/${s.view === 'entity' ? 'home' : s.view}`;
    const params = new URLSearchParams();
    if (s.stack.length > 0) params.set('p', serializeRefs(s.stack));
    if (s.pinned.length > 0) params.set('pin', serializeRefs(s.pinned));
    const tabs = [...serializeTabs(s.stack), ...serializeTabs(s.pinned)];
    if (tabs.length > 0) params.set('t', tabs.join(','));
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  },

  hydrateFromHash: (hash) => {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    const [pathPart, queryPart] = raw.split('?');
    const segs = pathPart.split('/').filter(Boolean); // ['s', spaceId, view] | ['s', spaceId, 'e', entityId]
    if (segs[0] !== 's' || !segs[1]) return;
    const spaceId = dec(segs[1]);
    let view: ViewName = 'home';
    let entityId: EntityId | null = null;
    if (segs[2] === 'e' && segs[3]) {
      view = 'entity';
      entityId = dec(segs[3]);
    } else if (segs[2] && (VIEWS as readonly string[]).includes(segs[2])) {
      view = segs[2] as ViewName;
      // `{view}/{entityId}` — only honoured for the views that actually focus an
      // entity, so a stray trailing segment on e.g. /tasks is ignored rather
      // than silently putting the view into a focused state it cannot render.
      if (segs[3] && ENTITY_FOCUSED_VIEWS.has(view)) entityId = dec(segs[3]);
    }
    const params = new URLSearchParams(queryPart ?? '');
    const tabMap = new Map<string, PanelTab>();
    for (const pair of (params.get('t') ?? '').split(',').filter(Boolean)) {
      const [id, tab] = pair.split(':');
      if (id && tab) tabMap.set(dec(id), tab as PanelTab);
    }
    const toRefs = (key: string): PanelRef[] =>
      (params.get(key) ?? '').split('.').filter(Boolean).map((id) => {
        const entity = dec(id);
        const tab = tabMap.get(entity);
        return tab ? { entityId: entity, tab } : { entityId: entity };
      });
    set({
      spaceId, view, entityId,
      stack: toRefs('p'),
      pinned: toRefs('pin').slice(0, MAX_PINNED),
    });
  },

  reset: () => set({
    spaceId: null, view: 'home', entityId: null, stack: [], pinned: [],
    paletteOpen: false, selection: [],
  }),
}));

// --- narrow selectors ---------------------------------------------------------
export const selectTopPanel = (s: NavState): PanelRef | undefined => s.stack[s.stack.length - 1];
export const selectIsPinned = (id: EntityId) => (s: NavState): boolean => s.pinned.some((r) => r.entityId === id);
export const selectStackDepth = (s: NavState): number => s.stack.length;
