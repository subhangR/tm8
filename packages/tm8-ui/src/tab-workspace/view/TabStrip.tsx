/** Tab strip (Spec A §6): tablist of visible tabs, `+` chooser, scope control. Workstream C. */
import { useShallow } from 'zustand/react/shallow';
import { KindIcon } from '../../domain';
import { draftTitle } from '../adapters/registry';
import { activeTabId, visibleTabs } from '../runtime/selectors';
import type { TabRecord } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import { ScopePicker } from './ScopePicker';

export function tabTitle(tab: TabRecord): string {
  if (tab.type === 'chooser') return 'New tab';
  if (tab.type === 'draft') return draftTitle(tab.kind, tab.ordinal);
  return tab.entityId;
}

export function TabStrip() {
  const { dispatch } = useWorkspace();
  const tabs = useWorkspaceState(useShallow(visibleTabs));
  const active = useWorkspaceState(activeTabId);
  const expanded = useWorkspaceState((s) => s.layout.expanded);
  return (
    <div className="tws-strip" data-testid="tws-strip">
      {expanded ? (
        <button
          type="button"
          className="tws-quiet-btn"
          onClick={() => dispatch({ command: 'workspace.layout.set', args: { expanded: false }, source: 'click' })}
        >
          Restore navigation
        </button>
      ) : null}
      <div className="tws-strip-scroll" role="tablist" aria-label="Open tabs">
        {tabs.map((tab) => (
          <div key={tab.id} className="tws-tab" data-active={tab.id === active || undefined}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === active}
              className="tws-tab-main"
              onClick={() => dispatch({ command: 'workspace.tabs.activate', args: { tabId: tab.id }, source: 'click' })}
            >
              {tab.type !== 'chooser' ? <KindIcon kind={tab.kind} size={14} /> : null}
              <span className="tws-tab-title">{tabTitle(tab)}</span>
              {tab.type === 'draft' && tab.dirty ? <span aria-label="Unsaved">•</span> : null}
            </button>
            <button
              type="button"
              className="tws-tab-close"
              aria-label={`Close ${tabTitle(tab)}`}
              onClick={() => dispatch({ command: 'workspace.tabs.close', args: { tabId: tab.id }, source: 'click' })}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="tws-icon-btn"
        aria-label="Open a new tab"
        onClick={() => dispatch({ command: 'workspace.chooser.open', args: {}, source: 'click' })}
      >
        +
      </button>
      <ScopePicker />
    </div>
  );
}
