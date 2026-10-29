/**
 * The planner vocabulary every command family returns, plus the state
 * helpers the algorithms of Spec B §5 share (activation, removal, active-tab
 * resolution). Commands are PURE over the state they are given: they return
 * the next state (the same object when nothing changed) and any post-commit
 * side effects as `after` thunks, which the dispatcher runs only once the
 * commit has landed.
 */
import { isEligible, scopeKey } from '../selectors.js';
import type {
  CommandEnvelope,
  PendingInteraction,
  Result,
  ResultReason,
  TabId,
  TabRecord,
  WorkspaceHooks,
  WorkspaceState,
} from '../types.js';

export interface PlanContext {
  state: WorkspaceState;
  env: CommandEnvelope;
  hooks: WorkspaceHooks;
  /** True while replaying a resolved interaction's command (§5.6). */
  replay: boolean;
}

export type Plan =
  | { type: 'reject'; reason: ResultReason }
  /** Needs a blocking choice; the dispatcher stores it (or answers busy). */
  | { type: 'choice'; pending: Omit<PendingInteraction, 'id' | 'command' | 'revisionAtRequest'> }
  | {
      type: 'commit';
      next: WorkspaceState;
      result?: Partial<Pick<Result, 'tabId' | 'outcome' | 'status'>>;
      /** False for commits that must not bump `revision` (scroll only). Default true. */
      significant?: boolean;
      after?: (() => void)[];
    }
  /** Commit `next`, then replay `command` through dispatch exactly once. */
  | { type: 'replay'; next: WorkspaceState; command: CommandEnvelope; after?: (() => void)[] }
  | { type: 'inspect' }
  /**
   * ADDITIVE (Spec C). The command acted OUTSIDE the store (a dialog, the
   * route) through a hook; nothing commits and `revision` does not move.
   */
  | { type: 'external'; result: Omit<Result, 'revision'> };

export type Planner = (ctx: PlanContext) => Plan;

export const reject = (reason: ResultReason): Plan => ({ type: 'reject', reason });

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
export function optional<T>(value: unknown, guard: (v: unknown) => v is T): value is T | undefined {
  return value === undefined || guard(value);
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * Activate a tab: capture the outgoing tab's ui, set presentation, move the
 * tab to the front of recency, and remember it for the current scope (§5.3).
 * Returns the same state when the tab is already active.
 */
export function activate(state: WorkspaceState, tabId: TabId, hooks: WorkspaceHooks): WorkspaceState {
  if (state.presentation.surface === 'tab' && state.presentation.tabId === tabId) return state;
  const tabs = captureOutgoing(state, hooks);
  return {
    ...state,
    tabs,
    presentation: { surface: 'tab', tabId },
    recency: [tabId, ...state.recency.filter((id) => id !== tabId)],
    rememberedActive: { ...state.rememberedActive, [scopeKey(state.scope)]: tabId },
  };
}

/** Show the start surface (capturing the outgoing tab's ui). */
export function showStart(state: WorkspaceState, hooks: WorkspaceHooks): WorkspaceState {
  if (state.presentation.surface === 'start') return state;
  return { ...state, tabs: captureOutgoing(state, hooks), presentation: { surface: 'start' } };
}

function captureOutgoing(state: WorkspaceState, hooks: WorkspaceHooks): Record<TabId, TabRecord> {
  if (state.presentation.surface !== 'tab') return state.tabs;
  const outgoing = state.tabs[state.presentation.tabId];
  if (outgoing?.type !== 'entity') return state.tabs;
  const captured = hooks.captureUi(outgoing.id);
  if (!captured || Object.keys(captured).length === 0) return state.tabs;
  return { ...state.tabs, [outgoing.id]: { ...outgoing, ui: { ...outgoing.ui, ...captured } } };
}

export function eligibleIds(state: WorkspaceState, ids: readonly TabId[]): TabId[] {
  return ids.filter((id) => {
    const tab = state.tabs[id];
    return tab !== undefined && isEligible(state.scope, tab);
  });
}

/**
 * §5.3 after a scope change: keep the current tab while eligible; otherwise
 * remembered → most recent eligible → first eligible → start. A `start`
 * presentation stays `start`.
 */
export function resolveAfterScopeChange(state: WorkspaceState, hooks: WorkspaceHooks): WorkspaceState {
  if (state.presentation.surface === 'start') return state;
  const current = state.tabs[state.presentation.tabId];
  if (current && isEligible(state.scope, current)) {
    return {
      ...state,
      rememberedActive: { ...state.rememberedActive, [scopeKey(state.scope)]: current.id },
    };
  }
  const remembered = state.rememberedActive[scopeKey(state.scope)];
  const pick =
    (remembered && eligibleIds(state, [remembered])[0]) ??
    eligibleIds(state, state.recency)[0] ??
    eligibleIds(state, state.orderedTabIds)[0];
  return pick ? activate(state, pick, hooks) : showStart(state, hooks);
}

/**
 * Remove tabs (§5.4): out of the order, the records, recency and every
 * `rememberedActive` slot. When the active tab goes, activate the nearest
 * eligible survivor to its right in the OLD order, then to its left, then
 * `start`. Never touches the domain. Draft deletions are returned as `after`.
 */
export function removeTabs(
  state: WorkspaceState,
  ids: readonly TabId[],
  hooks: WorkspaceHooks,
): { next: WorkspaceState; after: (() => void)[] } {
  const doomed = new Set(ids.filter((id) => state.tabs[id] !== undefined));
  if (doomed.size === 0) return { next: state, after: [] };
  const after: (() => void)[] = [];
  const tabs: Record<TabId, TabRecord> = {};
  for (const [id, tab] of Object.entries(state.tabs)) {
    if (!doomed.has(id)) tabs[id] = tab;
    else if (tab.type === 'draft') after.push(() => hooks.deleteDraft(tab.draftId));
  }
  const rememberedActive: Record<string, TabId> = {};
  for (const [key, id] of Object.entries(state.rememberedActive)) if (!doomed.has(id)) rememberedActive[key] = id;
  let next: WorkspaceState = {
    ...state,
    tabs,
    orderedTabIds: state.orderedTabIds.filter((id) => !doomed.has(id)),
    recency: state.recency.filter((id) => !doomed.has(id)),
    rememberedActive,
  };
  if (state.presentation.surface === 'tab' && doomed.has(state.presentation.tabId)) {
    const at = state.orderedTabIds.indexOf(state.presentation.tabId);
    const survivors = (list: TabId[]) => eligibleIds(next, list.filter((id) => !doomed.has(id)));
    const right = survivors(state.orderedTabIds.slice(at + 1))[0];
    const left = survivors(state.orderedTabIds.slice(0, Math.max(at, 0))).at(-1);
    const pick = right ?? left;
    // The closed tab is gone, so there is nothing to capture: set directly.
    next = { ...next, presentation: { surface: 'start' } };
    if (pick) next = activate(next, pick, hooks);
  }
  return { next, after };
}

/**
 * ADDITIVE (W1-F): an open that names a chooser in `replaceTabId` removes it.
 * With `takePosition`, `tabId` first moves into the chooser's slot (a new or
 * reused draft, a new entity tab); an already-open tab stays where it is.
 * Call after activating `tabId`, so removing the chooser never re-picks.
 */
export function replaceChooser(
  state: WorkspaceState,
  chooserId: unknown,
  tabId: TabId,
  takePosition: boolean,
  hooks: WorkspaceHooks,
): WorkspaceState {
  if (typeof chooserId !== 'string' || chooserId === tabId || state.tabs[chooserId]?.type !== 'chooser') return state;
  let next = state;
  if (takePosition) {
    const rest = state.orderedTabIds.filter((id) => id !== tabId);
    const at = rest.indexOf(chooserId);
    next = { ...state, orderedTabIds: [...rest.slice(0, at), tabId, ...rest.slice(at)] };
  }
  return removeTabs(next, [chooserId], hooks).next;
}

/**
 * Insert or move a tab id to just after the active tab (Kalai, 2026-10-07:
 * "New tabs open right after the active tab"), the way a browser does. With
 * no active tab (the start surface) it goes to the end. When the tab is
 * already the active one, the order is unchanged.
 */
export function afterActive(state: WorkspaceState, tabId: TabId): TabId[] {
  const order = state.orderedTabIds;
  const active = state.presentation.surface === 'tab' ? state.presentation.tabId : null;
  if (active === tabId) return [...order];
  const rest = order.filter((id) => id !== tabId);
  const at = active === null ? -1 : rest.indexOf(active);
  if (at < 0) return [...rest, tabId];
  return [...rest.slice(0, at + 1), tabId, ...rest.slice(at + 1)];
}

/**
 * Where a tab opened in the background joins `recency`: just behind the
 * active tab, or first when none is, because opening it is a use. At the tail
 * it would rank as the least recently used tab and be the first
 * `evictLeastRecent` closes.
 */
export function openedInBackground(state: WorkspaceState, tabId: TabId): TabId[] {
  const rest = state.recency.filter((id) => id !== tabId);
  const active = state.presentation.surface === 'tab' ? state.presentation.tabId : null;
  const at = active === null ? -1 : rest.indexOf(active);
  return [...rest.slice(0, at + 1), tabId, ...rest.slice(at + 1)];
}

/**
 * Keep the tab list at `cap` by closing the least recently used tabs (task
 * 01a185ec), instead of refusing the open with `tab_limit`. Runs only when a
 * commit GREW the list past the cap. Never closes a tab `prev` did not have
 * (what this commit opened), the active tab, a draft with unsaved or
 * submitting values, or a tab a pending prompt names. Least recent is the
 * tail of `recency`; a tab missing from it counts as older still. Returns
 * `next` unchanged when nothing needs to go; the list may stay over the cap
 * when too few tabs may go, and the caller decides what that means.
 */
export function evictLeastRecent(
  prev: WorkspaceState,
  next: WorkspaceState,
  cap: number,
  hooks: WorkspaceHooks,
): { next: WorkspaceState; after: (() => void)[]; evicted: TabId[] } {
  const grew = next.orderedTabIds.length > prev.orderedTabIds.length;
  if (!grew || next.orderedTabIds.length <= cap) return { next, after: [], evicted: [] };
  const excess = next.orderedTabIds.length - cap;
  const active = next.presentation.surface === 'tab' ? next.presentation.tabId : null;
  const held = new Set([...(next.pending?.tabIds ?? []), ...(next.pending?.closeTabIds ?? [])]);
  const ranked = new Set(next.recency);
  const oldestFirst = [...next.orderedTabIds.filter((id) => !ranked.has(id)), ...[...next.recency].reverse()];
  const evicted: TabId[] = [];
  for (const id of oldestFirst) {
    if (evicted.length >= excess) break;
    const tab = next.tabs[id];
    if (!tab || !prev.tabs[id] || id === active || held.has(id)) continue;
    if (tab.type === 'draft' && (tab.dirty || tab.submitting)) continue;
    evicted.push(id);
  }
  if (evicted.length === 0) return { next, after: [], evicted };
  const removed = removeTabs(next, evicted, hooks);
  return { next: removed.next, after: removed.after, evicted };
}
