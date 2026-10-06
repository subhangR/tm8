/**
 * The STORED Workspace (Spec D §1, §3): what the node keeps per (space,
 * identity), and how a window overlays its own per-window fields on it.
 *
 * Shared (stored):  tabs + order, scope, layout, browser, rail, recency,
 *                   rememberedActive, pending, scopeRepair, revision, and
 *                   `presentation` read as the workspace's LAST ACTIVE tab.
 * Per window:       its own presentation (active tab), per-tab scrollTop,
 *                   viewerId / windowId.
 *
 * Nothing stored names an entity's title or content: tabs are kinds and ids.
 */
import { DEFAULT_RAIL } from './commands/rail.js';
import { isEligible, scopeKey } from './selectors.js';
import {
  isWorkspaceKind,
  LAYOUT_BOUNDS,
  TAB_SUBVIEWS,
  type Presentation,
  type TabId,
  type TabRecord,
  type TabScope,
  type WorkspaceState,
} from './types.js';

/** The node's hard tab limit; the UI's soft cap (21) is a nudge below it. */
export const WORKSPACE_TAB_HARD_CAP = 50;
export const DEFAULT_BROWSER_KIND = 'task';

export function defaultWorkspaceState(spaceId: string, viewerId = '', windowId = ''): WorkspaceState {
  return {
    revision: 0,
    spaceId,
    viewerId,
    windowId,
    orderedTabIds: [],
    tabs: {},
    presentation: { surface: 'start' },
    scope: { mode: 'mixed', lastByTypeIds: [] },
    recency: [],
    rememberedActive: {},
    layout: {
      expanded: false,
      browserWidth: LAYOUT_BOUNDS.browserWidth.initial,
      chatWidth: LAYOUT_BOUNDS.chatWidth.initial,
    },
    browsers: {
      main: { kind: DEFAULT_BROWSER_KIND, perKind: { [DEFAULT_BROWSER_KIND]: { query: '', filters: null, scrollTop: 0 } } },
    },
  };
}

/** The shared part, as the node stores it: per-window fields stripped. */
export function toStoredState(state: WorkspaceState): WorkspaceState {
  const tabs: Record<TabId, TabRecord> = {};
  for (const [id, tab] of Object.entries(state.tabs)) {
    if (tab.type !== 'entity') {
      tabs[id] = tab;
      continue;
    }
    // Scroll is per window; crumb titles are content and could outlive access
    // (the trail resolves titles live and only falls back to the crumb's).
    const { scrollTop: _drop, ...ui } = tab.ui;
    tabs[id] = { ...tab, ui: ui.trail ? { ...ui, trail: ui.trail.map((c) => ({ ...c, title: '' })) } : ui };
  }
  return { ...state, viewerId: '', windowId: '', tabs };
}

/**
 * A window's view of a shared state: the stored state with THIS window's
 * presentation and per-tab scroll laid over it. When the shared change removed
 * or hid the window's active tab, the §5.3 fallback runs locally:
 * rememberedActive for the scope, then recency, then the nearest visible tab
 * (the start surface when nothing is visible).
 */
export function overlayWindow(
  stored: WorkspaceState,
  local: Pick<WorkspaceState, 'viewerId' | 'windowId' | 'presentation' | 'tabs' | 'orderedTabIds'>,
): WorkspaceState {
  const tabs: Record<TabId, TabRecord> = { ...stored.tabs };
  for (const [id, tab] of Object.entries(tabs)) {
    const mine = local.tabs[id];
    if (tab.type === 'entity' && mine?.type === 'entity' && mine.ui.scrollTop !== undefined) {
      tabs[id] = { ...tab, ui: { ...tab.ui, scrollTop: mine.ui.scrollTop } };
    }
  }
  const base: WorkspaceState = { ...stored, viewerId: local.viewerId, windowId: local.windowId, tabs };
  return { ...base, presentation: windowPresentation(base, local.presentation, local.orderedTabIds) };
}

function windowPresentation(state: WorkspaceState, wanted: Presentation, previousOrder: readonly TabId[]): Presentation {
  const usable = (id: TabId | undefined): id is TabId => {
    const tab = id ? state.tabs[id] : undefined;
    return tab !== undefined && isEligible(state.scope, tab);
  };
  if (wanted.surface === 'start') return wanted;
  if (usable(wanted.tabId)) return wanted;
  const remembered = state.rememberedActive[scopeKey(state.scope)];
  if (usable(remembered)) return { surface: 'tab', tabId: remembered };
  const recent = state.recency.find(usable);
  if (recent) return { surface: 'tab', tabId: recent };
  // Nearest visible neighbour of where the tab used to be.
  const at = previousOrder.indexOf(wanted.tabId);
  const visible = state.orderedTabIds.filter(usable);
  if (visible.length === 0) return { surface: 'start' };
  const before = previousOrder.slice(0, Math.max(at, 0)).reverse().find((id) => visible.includes(id));
  return { surface: 'tab', tabId: before ?? visible[0]! };
}

// ---------------------------------------------------------------------------
// Sanitizing what a window imports and what the row holds
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function cleanTab(id: string, raw: unknown): TabRecord | null {
  if (!isObj(raw) || raw.id !== id) return null;
  if (raw.type === 'chooser') return { id, type: 'chooser', query: typeof raw.query === 'string' ? raw.query.slice(0, 200) : '' };
  if (!isWorkspaceKind(raw.kind)) return null;
  if (raw.type === 'draft') {
    if (!str(raw.draftId)) return null;
    return {
      id,
      type: 'draft',
      kind: raw.kind,
      draftId: raw.draftId,
      dirty: raw.dirty === true,
      submitting: false,
      ordinal: num(raw.ordinal) && raw.ordinal >= 1 ? Math.floor(raw.ordinal) : 1,
    };
  }
  if (raw.type !== 'entity' || !str(raw.entityId)) return null;
  const ui = isObj(raw.ui) ? raw.ui : {};
  const subview = TAB_SUBVIEWS.includes(ui.subview as never) ? (ui.subview as (typeof TAB_SUBVIEWS)[number]) : 'entity';
  const trail = Array.isArray(ui.trail)
    ? ui.trail
        .filter((c): c is { entityId: string; kind: string; title: string } => isObj(c) && str(c.entityId) && isWorkspaceKind(c.kind))
        // Crumbs keep ids and kinds only: a stored title could outlive access.
        .map((c) => ({ entityId: c.entityId, kind: c.kind, title: '' }))
        .slice(0, 20)
    : undefined;
  const chat = isObj(ui.chat) && typeof ui.chat.open === 'boolean'
    ? { open: ui.chat.open, ...(num(ui.chat.width) ? { width: ui.chat.width } : {}), ...(str(ui.chat.threadId) ? { threadId: ui.chat.threadId } : {}) }
    : undefined;
  return {
    id,
    type: 'entity',
    kind: raw.kind,
    entityId: raw.entityId,
    ui: { subview, ...(trail ? { trail } : {}), ...(chat ? { chat } : {}) },
  };
}

function cleanScope(raw: unknown): TabScope {
  if (isObj(raw) && raw.mode === 'byType' && Array.isArray(raw.selectedTypeIds)) {
    const ids = [...new Set(raw.selectedTypeIds.filter(isWorkspaceKind))].sort();
    if (ids.length > 0) return { mode: 'byType', selectedTypeIds: ids };
  }
  const last = isObj(raw) && Array.isArray(raw.lastByTypeIds) ? [...new Set(raw.lastByTypeIds.filter(isWorkspaceKind))].sort() : [];
  return { mode: 'mixed', lastByTypeIds: last };
}

/**
 * A defensive copy of an untrusted state (a window's import, an old row):
 * unknown kinds and malformed records are dropped field by field, ids are
 * kept, titles are never kept, the tab list is capped at the hard limit.
 * Returns null when nothing usable remains of the shape.
 */
export function sanitizeWorkspaceState(raw: unknown, spaceId: string): WorkspaceState | null {
  if (!isObj(raw)) return null;
  const base = defaultWorkspaceState(spaceId);
  const tabs: Record<TabId, TabRecord> = {};
  const order: TabId[] = [];
  const rawTabs = isObj(raw.tabs) ? raw.tabs : {};
  const rawOrder = Array.isArray(raw.orderedTabIds) ? raw.orderedTabIds : [];
  for (const id of rawOrder) {
    if (!str(id, 64) || tabs[id] || order.length >= WORKSPACE_TAB_HARD_CAP) continue;
    const tab = cleanTab(id, rawTabs[id]);
    if (tab) {
      tabs[id] = tab;
      order.push(id);
    }
  }
  const known = (id: unknown): id is TabId => typeof id === 'string' && tabs[id] !== undefined;
  const layout = isObj(raw.layout) ? raw.layout : {};
  const clamp = (v: unknown, b: { min: number; max: number; initial: number }) =>
    num(v) ? Math.round(Math.min(b.max, Math.max(b.min, v))) : b.initial;
  const presentation: Presentation =
    isObj(raw.presentation) && raw.presentation.surface === 'tab' && known(raw.presentation.tabId)
      ? { surface: 'tab', tabId: raw.presentation.tabId }
      : { surface: 'start' };
  const remembered: Record<string, TabId> = {};
  if (isObj(raw.rememberedActive)) {
    for (const [key, id] of Object.entries(raw.rememberedActive)) if (key.length <= 300 && known(id)) remembered[key] = id;
  }
  const browserRaw = isObj(raw.browsers) && isObj(raw.browsers.main) ? raw.browsers.main : null;
  const perKind: Record<string, { query: string; filters: unknown; scrollTop: number }> = {};
  if (browserRaw && isObj(browserRaw.perKind)) {
    for (const [kind, v] of Object.entries(browserRaw.perKind)) {
      if (!isWorkspaceKind(kind) || !isObj(v)) continue;
      perKind[kind] = {
        query: typeof v.query === 'string' ? v.query.slice(0, 500) : '',
        filters: v.filters ?? null,
        scrollTop: num(v.scrollTop) ? Math.max(0, v.scrollTop) : 0,
      };
    }
  }
  const browserKind = browserRaw && isWorkspaceKind(browserRaw.kind) ? browserRaw.kind : base.browsers.main.kind;
  const railRaw = isObj(raw.rail) ? raw.rail : null;
  return {
    ...base,
    revision: num(raw.revision) && raw.revision >= 0 ? Math.floor(raw.revision) : 0,
    orderedTabIds: order,
    tabs,
    presentation,
    scope: cleanScope(raw.scope),
    recency: Array.isArray(raw.recency) ? [...new Set(raw.recency.filter(known))] : [],
    rememberedActive: remembered,
    layout: {
      expanded: layout.expanded === true,
      browserWidth: clamp(layout.browserWidth, LAYOUT_BOUNDS.browserWidth),
      chatWidth: clamp(layout.chatWidth, LAYOUT_BOUNDS.chatWidth),
    },
    browsers: { main: { kind: browserKind, perKind: Object.keys(perKind).length > 0 ? perKind : base.browsers.main.perKind } },
    ...(railRaw
      ? {
          rail: {
            pins: Array.isArray(railRaw.pins) ? railRaw.pins.filter((p): p is string => str(p, 64)).slice(0, 32) : DEFAULT_RAIL.pins,
            open: isObj(railRaw.open)
              ? Object.fromEntries(Object.entries(railRaw.open).filter(([, v]) => typeof v === 'boolean').slice(0, 64)) as Record<string, boolean>
              : {},
            expanded: railRaw.expanded === true,
          },
        }
      : {}),
    // A pending interaction is never imported: it belonged to another session.
  };
}
