/**
 * `workspace.drafts.*` — open (§5.2), markDirty, and the internal bind (§5.5).
 */
import { findEntityTab, kindInScope } from '../selectors';
import { isWorkspaceKind } from '../types';
import type { DraftTabRecord, EntityTabRecord, TabId, TabRecord, WorkspaceState } from '../types';
import { activate, isNonEmptyString, isRecord, reject, replaceChooser, toFront, type Planner } from './shared';

/** §5.2 Open a draft: reuse the untouched one of that kind, else create at index 0. */
export const openDraft: Planner = ({ state, env, hooks }) => {
  const args = env.args;
  if (!isRecord(args) || !isNonEmptyString(args.kind)) return reject('invalid_arguments');
  if (args.replaceTabId !== undefined && !isNonEmptyString(args.replaceTabId)) return reject('invalid_arguments');
  if (!isWorkspaceKind(args.kind) || !hooks.canCreate(args.kind)) return reject('unsupported_kind');
  const kind = args.kind;
  if (!kindInScope(state.scope, kind)) {
    return {
      type: 'choice',
      pending: { reason: 'scope_choice_required', choices: ['addType', 'useMixed', 'cancel'], targetKind: kind },
    };
  }
  const drafts = state.orderedTabIds
    .map((id) => state.tabs[id])
    .filter((tab): tab is DraftTabRecord => tab?.type === 'draft' && tab.kind === kind);
  // A dirty (or submitting) draft is never reused or reset.
  const untouched = drafts.find((tab) => !tab.dirty && !tab.submitting);
  if (untouched) {
    let next: WorkspaceState = { ...state, orderedTabIds: toFront(state.orderedTabIds, untouched.id) };
    if (next.orderedTabIds.every((id, i) => id === state.orderedTabIds[i])) next = state;
    next = activate(next, untouched.id, hooks);
    next = replaceChooser(next, args.replaceTabId, untouched.id, true, hooks);
    return { type: 'commit', next, result: { tabId: untouched.id, outcome: 'reused' } };
  }
  const record: DraftTabRecord = {
    id: hooks.newId(),
    type: 'draft',
    kind,
    draftId: hooks.newId(),
    dirty: false,
    submitting: false,
    ordinal: drafts.reduce((max, tab) => Math.max(max, tab.ordinal), 0) + 1,
  };
  let next = activate(
    { ...state, tabs: { ...state.tabs, [record.id]: record }, orderedTabIds: toFront(state.orderedTabIds, record.id) },
    record.id,
    hooks,
  );
  next = replaceChooser(next, args.replaceTabId, record.id, true, hooks);
  return { type: 'commit', next, result: { tabId: record.id, outcome: 'created' } };
};

export const markDirty: Planner = ({ state, env }) => {
  const args = env.args;
  if (!isRecord(args) || !isNonEmptyString(args.tabId)) return reject('invalid_arguments');
  if (args.dirty !== undefined && typeof args.dirty !== 'boolean') return reject('invalid_arguments');
  if (args.submitting !== undefined && typeof args.submitting !== 'boolean') return reject('invalid_arguments');
  const tab = state.tabs[args.tabId];
  if (!tab || tab.type !== 'draft') return reject('invalid_arguments');
  const dirty = args.dirty ?? tab.dirty;
  const submitting = args.submitting ?? tab.submitting;
  if (dirty === tab.dirty && submitting === tab.submitting) {
    return { type: 'commit', next: state, result: { tabId: tab.id } };
  }
  return {
    type: 'commit',
    next: { ...state, tabs: { ...state.tabs, [tab.id]: { ...tab, dirty, submitting } } },
    result: { tabId: tab.id },
  };
};

/**
 * §5.5 bind — INTERNAL ONLY (source `system`, enforced by the dispatcher).
 * The draft becomes the entity tab in place: same id, same index, no focus
 * steal, no scope change. Three races:
 *  - the tab was closed → toast "Created <title>" with Open, no tab recreated;
 *  - an entity tab with the same dedup key appeared → drop it, keep the
 *    draft's id and position, carry its ui over;
 *  - otherwise → plain in-place replace.
 */
export const bind: Planner = ({ state, env, hooks }) => {
  const args = env.args;
  if (!isRecord(args) || !isNonEmptyString(args.tabId) || !isNonEmptyString(args.entityId)) {
    return reject('invalid_arguments');
  }
  if (args.kind !== undefined && !isNonEmptyString(args.kind)) return reject('invalid_arguments');
  if (args.title !== undefined && typeof args.title !== 'string') return reject('invalid_arguments');
  const entityId = args.entityId;
  const tab = state.tabs[args.tabId];

  if (!tab) {
    const kind = args.kind;
    const title = args.title || 'entity';
    return {
      type: 'commit',
      next: state,
      after: [
        () =>
          hooks.toast({
            text: `Created ${title}`,
            ...(kind && isWorkspaceKind(kind)
              ? { action: { label: 'Open', run: () => hooks.openEntity(kind, entityId) } }
              : {}),
          }),
      ],
    };
  }
  if (tab.type !== 'draft') return { type: 'commit', next: state, result: { tabId: tab.id } };

  const duplicate = findEntityTab(state, tab.kind, entityId);
  const record: EntityTabRecord = {
    id: tab.id,
    type: 'entity',
    kind: tab.kind,
    entityId,
    ui: duplicate?.type === 'entity' ? duplicate.ui : { subview: 'entity' },
  };
  const tabs: Record<TabId, TabRecord> = { ...state.tabs, [tab.id]: record };
  let next: WorkspaceState = { ...state, tabs };
  if (duplicate) {
    const dup = duplicate.id;
    delete tabs[dup];
    const rememberedActive: Record<string, TabId> = {};
    for (const [key, id] of Object.entries(state.rememberedActive)) rememberedActive[key] = id === dup ? tab.id : id;
    const recency = state.recency.map((id) => (id === dup ? tab.id : id)).filter((id, i, all) => all.indexOf(id) === i);
    next = {
      ...next,
      orderedTabIds: state.orderedTabIds.filter((id) => id !== dup),
      recency,
      rememberedActive,
      presentation:
        state.presentation.surface === 'tab' && state.presentation.tabId === dup
          ? { surface: 'tab', tabId: tab.id }
          : state.presentation,
    };
  }
  return {
    type: 'commit',
    next,
    after: [() => hooks.deleteDraft(tab.draftId)],
    result: { tabId: tab.id },
  };
};
