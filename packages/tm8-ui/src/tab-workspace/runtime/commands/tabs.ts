/**
 * `workspace.tabs.*` — open (§5.1), activate, close (§5.4), closeVisible,
 * move and setUi.
 */
import { findEntityTab, isEligible, kindInScope, visibleTabIds } from '../selectors';
import { isWorkspaceKind, TAB_SUBVIEWS, UI_SOURCES } from '../types';
import type { EntityTabRecord, TabId, TabUi, TrailCrumb } from '../types';
import {
  activate,
  isFiniteNumber,
  isNonEmptyString,
  isRecord,
  reject,
  removeTabs,
  type Planner,
} from './shared';

function isTrail(value: unknown): value is TrailCrumb[] {
  return (
    Array.isArray(value) &&
    value.every(
      (c) => isRecord(c) && isNonEmptyString(c.entityId) && isNonEmptyString(c.kind) && typeof c.title === 'string',
    )
  );
}

function isSubview(value: unknown): value is TabUi['subview'] {
  return typeof value === 'string' && (TAB_SUBVIEWS as readonly string[]).includes(value);
}

function isUiPatch(value: unknown): value is Partial<TabUi> {
  if (!isRecord(value)) return false;
  if (value.subview !== undefined && !isSubview(value.subview)) return false;
  if (value.scrollTop !== undefined && !isFiniteNumber(value.scrollTop)) return false;
  if (value.trail !== undefined && !isTrail(value.trail)) return false;
  if (value.chat !== undefined) {
    const chat = value.chat;
    if (!isRecord(chat) || typeof chat.open !== 'boolean') return false;
    if (chat.width !== undefined && !isFiniteNumber(chat.width)) return false;
    if (chat.threadId !== undefined && typeof chat.threadId !== 'string') return false;
  }
  return true;
}

/** §5.1 Open an entity. */
export const open: Planner = ({ state, env, hooks }) => {
  const args = env.args;
  if (!isRecord(args) || !isNonEmptyString(args.entityId) || !isNonEmptyString(args.kind)) {
    return reject('invalid_arguments');
  }
  if (!isWorkspaceKind(args.kind)) return reject('unsupported_kind');
  if (args.activate !== undefined && typeof args.activate !== 'boolean') return reject('invalid_arguments');
  if (args.trail !== undefined && !isTrail(args.trail)) return reject('invalid_arguments');
  if (args.subview !== undefined && !isSubview(args.subview)) return reject('invalid_arguments');
  const kind = args.kind;
  const entityId = args.entityId;
  const shouldActivate = args.activate !== false;
  const trail = args.trail as TrailCrumb[] | undefined;
  const subview = args.subview as TabUi['subview'] | undefined;

  // Step 3 first only in effect: an ineligible existing tab and an ineligible
  // new one both need the reveal prompt, and no record is inserted.
  if (!kindInScope(state.scope, kind)) {
    return {
      type: 'choice',
      pending: { reason: 'scope_choice_required', choices: ['addType', 'useMixed', 'cancel'], targetKind: kind },
    };
  }

  const existing = findEntityTab(state, kind, entityId);
  if (existing && existing.type === 'entity' && isEligible(state.scope, existing)) {
    let next = state;
    if (trail !== undefined || subview !== undefined) {
      const ui: TabUi = {
        ...existing.ui,
        ...(subview !== undefined ? { subview } : {}),
        ...(trail !== undefined ? { trail } : {}),
      };
      next = { ...next, tabs: { ...next.tabs, [existing.id]: { ...existing, ui } } };
    }
    if (shouldActivate) next = activate(next, existing.id, hooks);
    return {
      type: 'commit',
      next,
      result: { tabId: existing.id, outcome: 'focused', ...(next === state ? { status: 'no_op' } : {}) },
    };
  }

  const record: EntityTabRecord = {
    id: hooks.newId(),
    type: 'entity',
    kind,
    entityId,
    ui: { subview: subview ?? 'entity', ...(trail !== undefined ? { trail } : {}) },
  };
  let next = {
    ...state,
    tabs: { ...state.tabs, [record.id]: record },
    orderedTabIds: [...state.orderedTabIds, record.id],
    recency: shouldActivate ? state.recency : [...state.recency, record.id],
  };
  if (shouldActivate) next = activate(next, record.id, hooks);
  return { type: 'commit', next, result: { tabId: record.id, outcome: 'created' } };
};

export const activateTab: Planner = ({ state, env, hooks }) => {
  const args = env.args;
  if (!isRecord(args) || !isNonEmptyString(args.tabId)) return reject('invalid_arguments');
  const tab = state.tabs[args.tabId];
  if (!tab || !isEligible(state.scope, tab)) return reject('invalid_arguments');
  const next = activate(state, tab.id, hooks);
  return { type: 'commit', next, result: { tabId: tab.id, outcome: 'focused' } };
};

/** §5.4 Close. */
export const close: Planner = ({ state, env, hooks }) => {
  const args = env.args;
  if (!isRecord(args) || !isNonEmptyString(args.tabId)) return reject('invalid_arguments');
  if (args.discard !== undefined && typeof args.discard !== 'boolean') return reject('invalid_arguments');
  const tab = state.tabs[args.tabId];
  if (!tab) return { type: 'commit', next: state, result: { status: 'no_op' } };
  // `discard` is honoured only from a person (the confirmation's resolve path).
  const discard = args.discard === true && UI_SOURCES.includes(env.source);
  if (tab.type === 'draft' && tab.dirty && !discard) {
    return {
      type: 'choice',
      pending: {
        reason: 'unsaved_changes',
        choices: ['discard', 'keep'],
        targetKind: tab.kind,
        tabIds: [tab.id],
        closeTabIds: [tab.id],
        draftRevisions: { [tab.id]: hooks.draftRevision(tab.draftId) },
      },
    };
  }
  const { next, after } = removeTabs(state, [tab.id], hooks);
  return { type: 'commit', next, after, result: { tabId: tab.id } };
};

/** Close every visible tab (optionally but one); one prompt lists every dirty draft. */
export const closeVisible: Planner = ({ state, env, hooks }) => {
  const args = env.args ?? {};
  if (!isRecord(args)) return reject('invalid_arguments');
  if (args.except !== undefined && !isNonEmptyString(args.except)) return reject('invalid_arguments');
  const captured = visibleTabIds(state).filter((id) => id !== args.except);
  if (captured.length === 0) return { type: 'commit', next: state, result: { status: 'no_op' } };
  const dirty = captured.filter((id) => {
    const tab = state.tabs[id];
    return tab?.type === 'draft' && tab.dirty;
  });
  if (dirty.length > 0) {
    const draftRevisions: Record<TabId, number> = {};
    for (const id of dirty) {
      const tab = state.tabs[id];
      if (tab?.type === 'draft') draftRevisions[id] = hooks.draftRevision(tab.draftId);
    }
    return {
      type: 'choice',
      pending: {
        reason: 'unsaved_changes',
        choices: ['discard', 'keep'],
        tabIds: dirty,
        closeTabIds: captured,
        draftRevisions,
      },
    };
  }
  const { next, after } = removeTabs(state, captured, hooks);
  return { type: 'commit', next, after };
};

/** Reorder. Moving one id never changes the relative order of the others, hidden or not. */
export const move: Planner = ({ state, env }) => {
  const args = env.args;
  if (!isRecord(args) || !isNonEmptyString(args.tabId)) return reject('invalid_arguments');
  if (args.beforeTabId !== undefined && !isNonEmptyString(args.beforeTabId)) return reject('invalid_arguments');
  const tabId = args.tabId;
  if (!state.tabs[tabId]) return reject('invalid_arguments');
  if (args.beforeTabId !== undefined && !state.tabs[args.beforeTabId]) return reject('invalid_arguments');
  if (args.beforeTabId === tabId) return { type: 'commit', next: state, result: { tabId, status: 'no_op' } };
  const rest = state.orderedTabIds.filter((id) => id !== tabId);
  const at = args.beforeTabId === undefined ? rest.length : rest.indexOf(args.beforeTabId);
  const orderedTabIds = [...rest.slice(0, at), tabId, ...rest.slice(at)];
  const same = orderedTabIds.every((id, i) => id === state.orderedTabIds[i]);
  return { type: 'commit', next: same ? state : { ...state, orderedTabIds }, result: { tabId } };
};

/** Section switcher, chat toggle, trail and scroll. Scroll alone is not revision-significant. */
export const setUi: Planner = ({ state, env }) => {
  const args = env.args;
  if (!isRecord(args) || !isNonEmptyString(args.tabId) || !isUiPatch(args.patch)) return reject('invalid_arguments');
  const tab = state.tabs[args.tabId];
  if (!tab || tab.type !== 'entity') return reject('invalid_arguments');
  const patch = args.patch;
  const ui: TabUi = { ...tab.ui, ...patch, ...(patch.chat ? { chat: { ...tab.ui.chat, ...patch.chat } } : {}) };
  const changed = (Object.keys(ui) as (keyof TabUi)[]).some(
    (key) => JSON.stringify(ui[key]) !== JSON.stringify(tab.ui[key]),
  );
  if (!changed) return { type: 'commit', next: state, result: { tabId: tab.id } };
  const scrollOnly = Object.keys(patch).every((key) => key === 'scrollTop');
  return {
    type: 'commit',
    next: { ...state, tabs: { ...state.tabs, [tab.id]: { ...tab, ui } } },
    significant: !scrollOnly,
    result: { tabId: tab.id },
  };
};
