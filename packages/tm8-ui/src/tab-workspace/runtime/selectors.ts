/**
 * Derived reads over WorkspaceState (Spec B §2). `visibleTabs` is ALWAYS
 * derived from eligibility and never stored.
 */
import type {
  KindId,
  TabId,
  TabRecord,
  TabScope,
  WorkspaceInspection,
  WorkspaceState,
} from './types';

/** `'mixed'`, or `'byType:' + sorted ids joined with ','`. */
export function scopeKey(scope: TabScope): string {
  if (scope.mode === 'mixed') return 'mixed';
  return `byType:${[...scope.selectedTypeIds].sort().join(',')}`;
}

/** Whether a kind passes the scope (choosers are not kinds; see `isEligible`). */
export function kindInScope(scope: TabScope, kind: KindId): boolean {
  return scope.mode === 'mixed' || scope.selectedTypeIds.includes(kind);
}

export function isEligible(scope: TabScope, tab: TabRecord): boolean {
  return tab.type === 'chooser' || kindInScope(scope, tab.kind);
}

export function visibleTabIds(state: WorkspaceState): TabId[] {
  return state.orderedTabIds.filter((id) => {
    const tab = state.tabs[id];
    return tab !== undefined && isEligible(state.scope, tab);
  });
}

export function visibleTabs(state: WorkspaceState): TabRecord[] {
  return visibleTabIds(state).map((id) => state.tabs[id]!);
}

export function activeTabId(state: WorkspaceState): TabId | null {
  return state.presentation.surface === 'tab' ? state.presentation.tabId : null;
}

export function activeTab(state: WorkspaceState): TabRecord | null {
  const id = activeTabId(state);
  return id ? (state.tabs[id] ?? null) : null;
}

/** The entity id of the active tab, or null for a draft / chooser / start. */
export function activeEntityId(state: WorkspaceState): string | null {
  const tab = activeTab(state);
  return tab?.type === 'entity' ? tab.entityId : null;
}

export function findEntityTab(state: WorkspaceState, kind: KindId, entityId: string): TabRecord | null {
  for (const id of state.orderedTabIds) {
    const tab = state.tabs[id];
    if (tab?.type === 'entity' && tab.kind === kind && tab.entityId === entityId) return tab;
  }
  return null;
}

/** The scope's kinds as a list: By type's selection, or [] for Mixed. */
export function selectedKinds(scope: TabScope): KindId[] {
  return scope.mode === 'byType' ? scope.selectedTypeIds : [];
}

/** The `workspace.inspect` row (§4): ids and kinds only, no draft or chat content. */
export function inspect(state: WorkspaceState): WorkspaceInspection {
  return {
    revision: state.revision,
    presentation: state.presentation,
    visibleTabIds: visibleTabIds(state),
    orderedTabIds: state.orderedTabIds.flatMap((id): WorkspaceInspection['orderedTabIds'] => {
      const tab = state.tabs[id];
      if (!tab) return [];
      if (tab.type === 'entity') return [{ id, type: tab.type, kind: tab.kind, entityId: tab.entityId }];
      if (tab.type === 'draft') return [{ id, type: tab.type, kind: tab.kind, dirty: tab.dirty }];
      return [{ id, type: tab.type }];
    }),
    scope: state.scope,
    browserKind: state.browsers.main.kind,
    layout: state.layout,
    ...(state.pending
      ? {
          pending: {
            id: state.pending.id,
            reason: state.pending.reason,
            choices: state.pending.choices,
            ...(state.pending.targetKind ? { targetKind: state.pending.targetKind } : {}),
            ...(state.pending.tabIds ? { tabIds: state.pending.tabIds } : {}),
          },
        }
      : {}),
  };
}
