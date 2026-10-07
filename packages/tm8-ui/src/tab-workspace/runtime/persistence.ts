/**
 * Persistence (Spec B §8): browser storage only, every key versioned and
 * scoped `{viewerId}:{spaceId}`.
 *
 *   tm8.ws.tabs.v2     sessionStorage  order, content-free records, presentation,
 *                                      recency, rememberedActive, per-tab ui
 *   tm8.ws.last.v2     localStorage    mirror of the latest tabs snapshot
 *   tm8.ws.prefs.v2    localStorage    scope (mode + ids), layout widths, expanded
 *   tm8.ws.browser.v2  localStorage    browser kind + perKind
 *
 * v2 (multiple workspaces, API doc 01a115c4): the keys hold the ONE workspace
 * a window shows while the node does not hold it. Once it does (server mode)
 * they are neither written nor read back — the node's state, per workspace,
 * is the truth — and this window's `tabs` key is dropped so a reload never
 * flashes another workspace's tabs. The v1 keys are read only by the one-time
 * legacy import (`legacySnapshot`).
 *
 * Draft values live in `draftStore.ts` under their own keys.
 *
 * SAVING: a runtime effect schedules a write ~250 ms after each commit, and
 * `pagehide` (and teardown) flushes it.
 *
 * LOADING, and why it bypasses `dispatch`: restore restores STATE, never side
 * effects — no Create, no Run, no prompt. Replaying `tabs.open` would run the
 * scope check and could raise a reveal prompt, and would push history. So the
 * validated snapshot is written straight into the store with ONE
 * `store.setState` (revision + 1) here, and nowhere else. It happens once per
 * runtime (the store is kept alive across Home round trips), and only while
 * the store is still pristine. Effects do not run for it; URL sync observes the
 * store and REPLACES the address.
 *
 * Anything malformed is dropped field by field; a kind outside D7 drops its
 * tab, crumb or browser slot. A By type selection left empty by that becomes
 * the scope-repair state (`state.scopeRepair`, scope held at Mixed) with a
 * banner — never a silent Mixed.
 *
 * A NEW WINDOW (empty sessionStorage) does not restore by itself: when
 * `tm8.ws.last.v2` holds tabs, the start surface offers "Restore N tabs from
 * your last session" (`restoreOfferOf` / `acceptRestoreOffer`).
 */
import { activeTabId, isEligible, scopeKey } from './selectors';
import type { WorkspaceRuntime } from './dispatch';
import { DEFAULT_BROWSER_KIND } from './store';
import {
  isWorkspaceKind,
  LAYOUT_BOUNDS,
  TAB_SUBVIEWS,
  type BrowserKindState,
  type BrowserState,
  type KindId,
  type Presentation,
  type TabId,
  type TabRecord,
  type TabScope,
  type TabSubview,
  type TabUi,
  type TrailCrumb,
  type WorkspaceLayout,
  type WorkspaceState,
} from './types';

export interface WorkspaceInitContext {
  viewerId: string;
  spaceId: string;
}

const VERSION = 2;
/** The keys before multiple workspaces: read once, by the legacy import. */
const LEGACY_VERSION = 1;
export const SAVE_DEBOUNCE_MS = 250;

export function persistKey(
  name: 'tabs' | 'last' | 'prefs' | 'browser',
  ctx: WorkspaceInitContext,
  version: number = VERSION,
): string {
  return `tm8.ws.${name}.v${version}:${ctx.viewerId}:${ctx.spaceId}`;
}

/** The snapshot shapes did not change between v1 and v2. */
const isKnownVersion = (v: unknown): boolean => v === VERSION || v === LEGACY_VERSION;

// ---------------------------------------------------------------------------
// Storage access (failures read as absent and are swallowed)
// ---------------------------------------------------------------------------

function storage(which: 'session' | 'local'): Storage | null {
  try {
    if (which === 'session') return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson(which: 'session' | 'local', key: string): unknown {
  try {
    const raw = storage(which)?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(which: 'session' | 'local', key: string, value: unknown): void {
  try {
    storage(which)?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or privacy mode: persistence is best effort.
  }
}

// ---------------------------------------------------------------------------
// Snapshot shapes
// ---------------------------------------------------------------------------

/** The tabs snapshot (`tabs.v2`, mirrored to `last.v2`). No content. */
export interface TabsSnapshot {
  v: 2;
  savedAt: number;
  orderedTabIds: TabId[];
  tabs: Record<TabId, TabRecord>;
  presentation: Presentation;
  recency: TabId[];
  rememberedActive: Record<string, TabId>;
}

interface PrefsSnapshot {
  v: 2;
  scope: TabScope;
  layout: WorkspaceLayout;
}

interface BrowserSnapshot {
  v: 2;
  kind: KindId;
  perKind: Record<KindId, BrowserKindState>;
}

function tabsSnapshotOf(state: WorkspaceState): TabsSnapshot {
  const tabs: Record<TabId, TabRecord> = {};
  for (const id of state.orderedTabIds) {
    const tab = state.tabs[id];
    if (!tab) continue;
    // `submitting` never survives: restore must not look mid-Create.
    tabs[id] = tab.type === 'draft' ? { ...tab, submitting: false } : tab;
  }
  return {
    v: VERSION,
    savedAt: Date.now(),
    orderedTabIds: state.orderedTabIds.filter((id) => tabs[id] !== undefined),
    tabs,
    presentation: state.presentation,
    recency: state.recency,
    rememberedActive: state.rememberedActive,
  };
}

// ---------------------------------------------------------------------------
// Validation: drop anything malformed
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, b: { min: number; max: number }) => Math.min(b.max, Math.max(b.min, v));

function validCrumb(v: unknown): TrailCrumb | null {
  if (!isRecord(v) || !isId(v.entityId) || !isWorkspaceKind(v.kind) || typeof v.title !== 'string') return null;
  return { entityId: v.entityId, kind: v.kind, title: v.title };
}

function validUi(v: unknown): TabUi {
  const ui: TabUi = { subview: 'entity' };
  if (!isRecord(v)) return ui;
  if (TAB_SUBVIEWS.includes(v.subview as TabSubview)) ui.subview = v.subview as TabSubview;
  if (isFinite(v.scrollTop) && v.scrollTop >= 0) ui.scrollTop = v.scrollTop;
  if (Array.isArray(v.trail)) {
    const trail = v.trail.map(validCrumb).filter((c): c is TrailCrumb => c !== null);
    if (trail.length) ui.trail = trail;
  }
  if (isRecord(v.chat) && typeof v.chat.open === 'boolean') {
    const chat: NonNullable<TabUi['chat']> = { open: v.chat.open };
    if (isFinite(v.chat.width)) chat.width = clamp(v.chat.width, LAYOUT_BOUNDS.chatWidth);
    if (isId(v.chat.threadId)) chat.threadId = v.chat.threadId;
    ui.chat = chat;
  }
  return ui;
}

function validRecord(id: TabId, v: unknown): TabRecord | null {
  if (!isRecord(v) || v.id !== id) return null;
  if (v.type === 'chooser') return { id, type: 'chooser', query: typeof v.query === 'string' ? v.query : '' };
  // Unknown kinds (outside D7) are dropped from tabs (§8).
  if (!isWorkspaceKind(v.kind)) return null;
  if (v.type === 'entity') {
    if (!isId(v.entityId)) return null;
    return { id, type: 'entity', kind: v.kind, entityId: v.entityId, ui: validUi(v.ui) };
  }
  if (v.type === 'draft') {
    if (!isId(v.draftId)) return null;
    const ordinal = isFinite(v.ordinal) && v.ordinal >= 1 ? Math.floor(v.ordinal) : 1;
    return { id, type: 'draft', kind: v.kind, draftId: v.draftId, dirty: v.dirty === true, submitting: false, ordinal };
  }
  return null;
}

/** The restorable part of a saved tabs snapshot, or null when there is none. */
export function validTabsSnapshot(raw: unknown): Omit<TabsSnapshot, 'v' | 'savedAt'> | null {
  if (!isRecord(raw) || !isKnownVersion(raw.v) || !Array.isArray(raw.orderedTabIds) || !isRecord(raw.tabs)) return null;
  const tabs: Record<TabId, TabRecord> = {};
  const orderedTabIds: TabId[] = [];
  const entityKeys = new Set<string>();
  for (const id of raw.orderedTabIds) {
    if (!isId(id) || tabs[id]) continue;
    const record = validRecord(id, raw.tabs[id]);
    if (!record) continue;
    if (record.type === 'entity') {
      // Dedup key (kind + entity) within the window: first wins.
      const key = `${record.kind}:${record.entityId}`;
      if (entityKeys.has(key)) continue;
      entityKeys.add(key);
    }
    tabs[id] = record;
    orderedTabIds.push(id);
  }
  const open = (id: unknown): id is TabId => typeof id === 'string' && tabs[id] !== undefined;
  const recency = Array.isArray(raw.recency) ? [...new Set(raw.recency.filter(open))] : [];
  const rememberedActive: Record<string, TabId> = {};
  if (isRecord(raw.rememberedActive)) {
    for (const [key, id] of Object.entries(raw.rememberedActive)) if (open(id)) rememberedActive[key] = id;
  }
  const p = raw.presentation;
  const presentation: Presentation =
    isRecord(p) && p.surface === 'tab' && open(p.tabId) ? { surface: 'tab', tabId: p.tabId } : { surface: 'start' };
  return { orderedTabIds, tabs, presentation, recency, rememberedActive };
}

function validKinds(v: unknown): { kept: KindId[]; dropped: KindId[] } {
  const ids = Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : [];
  const kept = [...new Set(ids.filter(isWorkspaceKind))].sort();
  return { kept, dropped: [...new Set(ids.filter((id) => !isWorkspaceKind(id)))] };
}

function validPrefs(raw: unknown): { scope?: TabScope; repair?: KindId[]; layout?: WorkspaceLayout } {
  if (!isRecord(raw) || !isKnownVersion(raw.v)) return {};
  const out: { scope?: TabScope; repair?: KindId[]; layout?: WorkspaceLayout } = {};
  const s = raw.scope;
  if (isRecord(s) && s.mode === 'mixed') {
    out.scope = { mode: 'mixed', lastByTypeIds: validKinds(s.lastByTypeIds).kept };
  } else if (isRecord(s) && s.mode === 'byType') {
    const { kept, dropped } = validKinds(s.selectedTypeIds);
    if (kept.length) out.scope = { mode: 'byType', selectedTypeIds: kept };
    else if (dropped.length) {
      // Every selected kind is gone: hold Mixed and ask (§8 scope repair).
      out.scope = { mode: 'mixed', lastByTypeIds: [] };
      out.repair = dropped;
    }
  }
  const l = raw.layout;
  if (isRecord(l)) {
    out.layout = {
      expanded: l.expanded === true,
      browserWidth: isFinite(l.browserWidth)
        ? clamp(l.browserWidth, LAYOUT_BOUNDS.browserWidth)
        : LAYOUT_BOUNDS.browserWidth.initial,
      chatWidth: isFinite(l.chatWidth) ? clamp(l.chatWidth, LAYOUT_BOUNDS.chatWidth) : LAYOUT_BOUNDS.chatWidth.initial,
    };
  }
  return out;
}

function validBrowser(raw: unknown): BrowserState | null {
  if (!isRecord(raw) || !isKnownVersion(raw.v) || !isRecord(raw.perKind)) return null;
  const perKind: Record<KindId, BrowserKindState> = {};
  for (const [kind, v] of Object.entries(raw.perKind)) {
    if (!isWorkspaceKind(kind) || !isRecord(v)) continue;
    perKind[kind] = {
      query: typeof v.query === 'string' ? v.query : '',
      filters: v.filters ?? null,
      scrollTop: isFinite(v.scrollTop) && v.scrollTop >= 0 ? v.scrollTop : 0,
    };
  }
  const kind = isWorkspaceKind(raw.kind) ? raw.kind : DEFAULT_BROWSER_KIND;
  if (!perKind[kind]) perKind[kind] = { query: '', filters: null, scrollTop: 0 };
  return { kind, perKind };
}

// ---------------------------------------------------------------------------
// Hydrate (direct store write — see the header)
// ---------------------------------------------------------------------------

/** §5.3's fallback order, for a restored presentation that is gone or hidden. */
function settlePresentation(state: WorkspaceState): WorkspaceState {
  if (state.scopeRepair) return { ...state, presentation: { surface: 'start' } };
  const id = activeTabId(state);
  if (id === null) return state;
  const eligible = (tabId: TabId | undefined) => {
    const tab = tabId ? state.tabs[tabId] : undefined;
    return tab !== undefined && isEligible(state.scope, tab);
  };
  if (eligible(id)) return state;
  const pick =
    [state.rememberedActive[scopeKey(state.scope)]].find(eligible) ??
    state.recency.find(eligible) ??
    state.orderedTabIds.find(eligible);
  return { ...state, presentation: pick ? { surface: 'tab', tabId: pick } : { surface: 'start' } };
}

function hydrate(runtime: WorkspaceRuntime, patch: Partial<WorkspaceState>): void {
  const prev = runtime.store.getState();
  const next = settlePresentation({ ...prev, ...patch });
  runtime.store.setState({ ...next, revision: prev.revision + 1 }, true);
}

// ---------------------------------------------------------------------------
// Restore offer (a new window with a `last.v2` snapshot)
// ---------------------------------------------------------------------------

interface OfferSlot {
  snapshot: Omit<TabsSnapshot, 'v' | 'savedAt'> | null;
  listeners: Set<() => void>;
}
const offers = new WeakMap<WorkspaceRuntime, OfferSlot>();

function offerSlot(runtime: WorkspaceRuntime): OfferSlot {
  let slot = offers.get(runtime);
  if (!slot) {
    slot = { snapshot: null, listeners: new Set() };
    offers.set(runtime, slot);
  }
  return slot;
}

function setOffer(runtime: WorkspaceRuntime, snapshot: OfferSlot['snapshot']): void {
  const slot = offerSlot(runtime);
  if (slot.snapshot === snapshot) return;
  slot.snapshot = snapshot;
  for (const listener of slot.listeners) listener();
}

/** How many tabs the restore offer would bring back (0 = no offer). */
export function restoreOfferOf(runtime: WorkspaceRuntime): number {
  return offerSlot(runtime).snapshot?.orderedTabIds.length ?? 0;
}

/** Subscribe to the restore offer (for `useSyncExternalStore`). */
export function subscribeRestoreOffer(runtime: WorkspaceRuntime, listener: () => void): () => void {
  const slot = offerSlot(runtime);
  slot.listeners.add(listener);
  return () => slot.listeners.delete(listener);
}

/** Bring the last session's tabs into this window (state only, no side effects). */
export function acceptRestoreOffer(runtime: WorkspaceRuntime): void {
  const snapshot = offerSlot(runtime).snapshot;
  setOffer(runtime, null);
  if (!snapshot || runtime.store.getState().orderedTabIds.length > 0) return;
  hydrate(runtime, snapshot);
  saveNow(runtime);
}

export function dismissRestoreOffer(runtime: WorkspaceRuntime): void {
  setOffer(runtime, null);
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

const loaded = new WeakSet<WorkspaceRuntime>();
/** Runtimes whose workspace now lives on the node (Spec D): no storage writes, no offer. */
const serverMode = new WeakSet<WorkspaceRuntime>();
const contexts = new WeakMap<WorkspaceRuntime, WorkspaceInitContext>();

/**
 * Spec D §6: the node holds this workspace now. Browser storage is no longer
 * written; what it holds stays readable (the import read it, and it is the
 * read-only fallback when the node cannot be reached at boot).
 */
export function enterServerMode(runtime: WorkspaceRuntime): void {
  serverMode.add(runtime);
  loaded.add(runtime);
  setOffer(runtime, null);
  // The node now says which workspace this window shows, and what is in it.
  const ctx = contexts.get(runtime) ?? { viewerId: runtime.viewerId, spaceId: runtime.spaceId };
  try {
    storage('session')?.removeItem(persistKey('tabs', ctx));
  } catch {
    // ignore
  }
}

/**
 * The browser's legacy Workspace state for (viewer, space), read without
 * touching any store: this window's tabs (or, for a new window, the last
 * session's), the prefs, the browser state — v2 first, then the v1 keys.
 * Null when storage holds nothing.
 */
export function legacySnapshot(ctx: WorkspaceInitContext): Partial<WorkspaceState> | null {
  const read = (which: 'session' | 'local', name: 'tabs' | 'last' | 'prefs' | 'browser') =>
    readJson(which, persistKey(name, ctx)) ?? readJson(which, persistKey(name, ctx, LEGACY_VERSION));
  const patch: Partial<WorkspaceState> = {};
  const prefs = validPrefs(read('local', 'prefs'));
  if (prefs.scope) patch.scope = prefs.scope;
  if (prefs.layout) patch.layout = prefs.layout;
  const browser = validBrowser(read('local', 'browser'));
  if (browser) patch.browsers = { main: browser };
  const tabs =
    validTabsSnapshot(read('session', 'tabs')) ??
    validTabsSnapshot(read('local', 'last'));
  if (tabs) Object.assign(patch, tabs);
  return Object.keys(patch).length > 0 ? patch : null;
}

function load(runtime: WorkspaceRuntime, ctx: WorkspaceInitContext): void {
  if (loaded.has(runtime)) return;
  loaded.add(runtime);
  const state = runtime.store.getState();
  // Only a pristine store is hydrated; a kept-alive one already holds the truth.
  if (state.revision !== 0 || state.orderedTabIds.length > 0) return;

  const patch: Partial<WorkspaceState> = {};
  const prefs = validPrefs(readJson('local', persistKey('prefs', ctx)));
  if (prefs.scope) patch.scope = prefs.scope;
  if (prefs.repair) patch.scopeRepair = { droppedKinds: prefs.repair };
  if (prefs.layout) patch.layout = prefs.layout;
  const browser = validBrowser(readJson('local', persistKey('browser', ctx)));
  if (browser) patch.browsers = { main: browser };

  const rawTabs = readJson('session', persistKey('tabs', ctx));
  if (rawTabs !== undefined) {
    const tabs = validTabsSnapshot(rawTabs);
    if (tabs) Object.assign(patch, tabs);
  } else {
    // A new window: offer the last session rather than restoring it silently.
    const last = validTabsSnapshot(readJson('local', persistKey('last', ctx)));
    if (last && last.orderedTabIds.length > 0) setOffer(runtime, last);
  }
  if (Object.keys(patch).length > 0) hydrate(runtime, patch);
}


function saveNow(runtime: WorkspaceRuntime): void {
  if (serverMode.has(runtime)) return;
  const ctx = contexts.get(runtime) ?? { viewerId: runtime.viewerId, spaceId: runtime.spaceId };
  const state = runtime.store.getState();
  const snapshot = tabsSnapshotOf(state);
  writeJson('session', persistKey('tabs', ctx), snapshot);
  // While the restore offer is open, an empty new window must not erase the
  // snapshot it is offering.
  if (restoreOfferOf(runtime) === 0) writeJson('local', persistKey('last', ctx), snapshot);
  // An unanswered scope repair keeps the saved By type selection, so a reload
  // asks again instead of settling on Mixed.
  const savedPrefs = state.scopeRepair ? readJson('local', persistKey('prefs', ctx)) : undefined;
  const prefs: PrefsSnapshot = {
    v: VERSION,
    scope: isRecord(savedPrefs) && isRecord(savedPrefs.scope) ? (savedPrefs.scope as TabScope) : state.scope,
    layout: state.layout,
  };
  writeJson('local', persistKey('prefs', ctx), prefs);
  const browser: BrowserSnapshot = { v: VERSION, ...state.browsers.main };
  writeJson('local', persistKey('browser', ctx), browser);
}

/** Wire persistence for one runtime. Returns the teardown (flush + unregister). */
export function initPersistence(runtime: WorkspaceRuntime, ctx: WorkspaceInitContext): () => void {
  contexts.set(runtime, ctx);
  load(runtime, ctx);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    saveNow(runtime);
  };
  const unregister = runtime.registerEffect(({ next }) => {
    // The first tab of a new window withdraws the offer: this window now has
    // its own session, and the mirror follows it.
    if (next.orderedTabIds.length > 0) setOffer(runtime, null);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveNow(runtime);
    }, SAVE_DEBOUNCE_MS);
  });
  const win = typeof window === 'undefined' ? null : window;
  win?.addEventListener('pagehide', flush);
  return () => {
    win?.removeEventListener('pagehide', flush);
    unregister();
    flush();
  };
}
