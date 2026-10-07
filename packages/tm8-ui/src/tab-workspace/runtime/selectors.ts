/** Derived reads over WorkspaceState (Spec B §2) — shared with the node via `@tm8/contract/workspace`. */
export {
  activeEntityId,
  activeTab,
  activeTabId,
  findEntityTab,
  findFileTab,
  findPreviewFileTab,
  inspect,
  isEligible,
  kindInScope,
  scopeKey,
  selectedKinds,
  visibleTabIds,
  visibleTabs,
} from '@tm8/contract/workspace';
