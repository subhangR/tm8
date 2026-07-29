import { useMemo, useState } from 'react';
import type { RealFacade } from '../RealFacade';
import { disabledBecause } from './Unavailable';
import { agentsQuery, docsQuery, isDrawing } from './queries';
import { AgentsTab } from './tabs/AgentsTab';
import { DocsTab } from './tabs/DocsTab';
import { DrawingsTab } from './tabs/DrawingsTab';
import { AgentLogo, PanelIcon, type PanelIconName } from './tabs/panelPrimitives';
import type { SessionLifecycleFilter } from './tabs/SessionTree';
import { TerminalsTab } from './tabs/TerminalsTab';
import { LIST_POLL_MS, sessionState, useSessions } from './useSessions';
import { usePolledCollection } from './usePolledCollection';
import './styles/resource-panel.css';

export type ResourceTab = 'terminals' | 'agents' | 'docs' | 'drawings';
type PanelMode = 'sessions' | 'resources';

export interface ResourcePanelProps {
  facade: RealFacade;
  spaceId: string;
  openSessionId: string | null;
  onOpenSession: (sessionId: string | null) => void;
}

const FILTERS: Array<{ id: ResourceTab; label: string; icon: PanelIconName }> = [
  { id: 'terminals', label: 'Terminals', icon: 'terminal' },
  { id: 'agents', label: 'Agents', icon: 'sparkles' },
  { id: 'docs', label: 'Docs', icon: 'doc' },
  { id: 'drawings', label: 'Drawings', icon: 'pen' },
];

const QUICK_TOOLS = ['claude', 'codex', 'hermes', 'gemini'] as const;

function QuickMark({ tool }: { tool: typeof QUICK_TOOLS[number] }) {
  return <AgentLogo tool={tool} />;
}

export function ResourcePanel({ facade, spaceId, openSessionId, onOpenSession }: ResourcePanelProps) {
  const [mode, setMode] = useState<PanelMode>('sessions');
  const [tab, setTab] = useState<ResourceTab>('agents');
  const [lifecycle, setLifecycle] = useState<SessionLifecycleFilter>('open');
  const [liveOnly, setLiveOnly] = useState(false);

  const { sessions, live, finished, error, reload } = useSessions(facade, spaceId);
  const agents = usePolledCollection(facade, agentsQuery(spaceId), LIST_POLL_MS);
  const documents = usePolledCollection(facade, docsQuery(spaceId), LIST_POLL_MS);

  const counts = useMemo(() => {
    const rows = sessions ?? [];
    const docs = documents.items ?? [];
    return {
      terminals: rows.filter((session) => !sessionState(session).agentTool).length,
      agents: rows.filter((session) => Boolean(sessionState(session).agentTool)).length,
      docs: docs.filter((doc) => !isDrawing(doc)).length,
      drawings: docs.filter(isDrawing).length,
    };
  }, [documents.items, sessions]);

  const switchMode = (next: PanelMode) => {
    setMode(next);
    setTab(next === 'sessions' ? 'agents' : 'docs');
  };
  const switchTab = (next: ResourceTab) => {
    setTab(next);
    setMode(next === 'docs' || next === 'drawings' ? 'resources' : 'sessions');
  };
  const refreshAll = () => { reload(); agents.reload(); documents.reload(); };
  const historyCount = finished.length;
  const sessionCount = sessions?.length ?? 0;
  const quickDisabled = disabledBecause('spawnSession', 'Choose a task and agent before starting a session');
  const collapseDisabled = disabledBecause('workspace.collapseResourcePanel', 'This workspace uses a resize handle instead of collapsing the panel');

  return (
    <aside className="ws-res pn-panel" data-testid="resource-panel" aria-label="Sessions and resources">
      <div className="pn-tabs ws-res__mode-tabs" role="tablist" aria-label="Sessions and resources">
        <button
          type="button"
          role="tab"
          className={`pn-tab${mode === 'sessions' ? ' pn-tab--active' : ''}`}
          aria-selected={mode === 'sessions'}
          onClick={() => switchMode('sessions')}
        >
          Sessions <span className="pn-tab-n">{sessionCount}</span>
        </button>
        <button
          type="button"
          role="tab"
          className={`pn-tab${mode === 'resources' ? ' pn-tab--active' : ''}`}
          aria-selected={mode === 'resources'}
          onClick={() => switchMode('resources')}
        >
          Resources
        </button>
        <span className="pn-head-spacer" />
        <button type="button" className="pn-ib ws-res__top-action" aria-label="New session" {...quickDisabled}>
          <PanelIcon name="plus" />
        </button>
        <button type="button" className="pn-ib ws-res__top-action ws-res__collapse" aria-label="Collapse panel" {...collapseDisabled}>
          <PanelIcon name="chevronR" />
          {historyCount > 0 && <span className="iconRailBadge iconRailBadge--history">{historyCount > 99 ? '99+' : historyCount}</span>}
        </button>
      </div>

      <div className="pn-head">
        <span className="pn-proj">Sessions</span>
        <span className="pn-head-spacer" />
        <div className="sidebarHeaderActions">
          <button type="button" className="pn-ib" onClick={refreshAll} title="Refresh sessions and resources" aria-label="Refresh sessions and resources">
            <PanelIcon name="refresh" />
          </button>
          <button type="button" className={`pn-ib${mode === 'resources' ? ' pn-ib--active' : ''}`} onClick={() => switchMode('resources')} title="Open resources" aria-label="Open resources">
            <PanelIcon name="layers" />
          </button>
          <button type="button" className={`pn-ib${lifecycle === 'done' ? ' pn-ib--active' : ''}`} onClick={() => { setLifecycle('done'); setTab('agents'); setMode('sessions'); }} title="Finished session history" aria-label="Finished session history">
            <PanelIcon name="clock" />
          </button>
          <button type="button" className="pn-ib" aria-label="Session view options" {...disabledBecause('getSettings', 'Session view options are not implemented on this node')}>
            <PanelIcon name="sliders" />
          </button>
        </div>
      </div>

      <div className="pn-quick" role="toolbar" aria-label="Quick launch">
        <button type="button" className="pn-qchip pn-qchip--icon" aria-label="New terminal" {...quickDisabled}>
          <PanelIcon name="terminal" />
        </button>
        {QUICK_TOOLS.map((tool) => (
          <button key={tool} type="button" className="pn-qchip pn-qchip--icon" aria-label={`Start ${tool}`} {...quickDisabled}>
            <QuickMark tool={tool} />
          </button>
        ))}
      </div>

      <div className="pn-filters" role="tablist" aria-label="Session and resource types">
        {FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            role="tab"
            id={`ws-res-tab-${filter.id}`}
            aria-selected={tab === filter.id}
            aria-controls={`ws-res-panel-${filter.id}`}
            className={`pn-filter${tab === filter.id ? ' pn-filter--active' : ''}`}
            data-testid={`res-tab-${filter.id}`}
            onClick={() => switchTab(filter.id)}
          >
            <PanelIcon name={filter.icon} />
            {filter.label}
            {counts[filter.id] > 0 && <span className="pn-tab-n">{counts[filter.id]}</span>}
          </button>
        ))}
      </div>

      {tab === 'agents' && (
        <div className="pn-subbar ws-res__lifecycle" role="tablist" aria-label="Session lifecycle">
          <button type="button" role="tab" aria-selected={lifecycle === 'open'} className={`pn-subtab${lifecycle === 'open' ? ' pn-subtab--active' : ''}`} onClick={() => { setLifecycle('open'); setLiveOnly(false); }}>
            <span>Open</span><span className="pn-tab-n">{sessions?.length ?? 0}</span>
          </button>
          <button type="button" role="tab" aria-selected={lifecycle === 'done'} className={`pn-subtab${lifecycle === 'done' ? ' pn-subtab--active' : ''}`} onClick={() => { setLifecycle('done'); setLiveOnly(false); }}>
            <span>Done</span><span className="pn-tab-n">{finished.length}</span>
          </button>
          <button type="button" role="tab" aria-selected="false" className="pn-subtab" {...disabledBecause('workSession.archive', 'Archive state is not projected for work sessions on this node')}>
            <span>Archived</span><span className="pn-tab-n">—</span>
          </button>
          <button type="button" role="tab" aria-selected="false" className="pn-subtab" {...disabledBecause('huddles.list', 'Huddles are not implemented on this node')}>
            <span>Huddles</span><span className="pn-tab-n">—</span>
          </button>
          {live.length > 0 && (
            <button
              type="button"
              className={`pn-chip pn-chip--btn${liveOnly ? ' pn-chip--active' : ''}`}
              onClick={() => setLiveOnly((value) => !value)}
              aria-pressed={liveOnly}
              aria-label={`${live.length} live`}
            >
              <span className="pn-dot-wrap"><span className="pn-dot pn-dot--run pn-dot--live" /></span>
              {live.length} live
            </button>
          )}
          <button type="button" className="pn-ib ws-res__view-options" aria-label="Tree view options" {...disabledBecause('getSettings', 'Tree view options are not implemented on this node')}>
            <PanelIcon name="sliders" />
          </button>
        </div>
      )}

      {(error || agents.error || documents.error) && (
        <pre className="ws-res__error" role="alert">{error || agents.error || documents.error}</pre>
      )}

      <div
        className="ws-res__body"
        role="tabpanel"
        id={`ws-res-panel-${tab}`}
        aria-labelledby={`ws-res-tab-${tab}`}
        data-tab={tab}
      >
        {tab === 'terminals' && <TerminalsTab facade={facade} spaceId={spaceId} openSessionId={openSessionId} onOpenSession={onOpenSession} lifecycle={lifecycle} liveOnly={liveOnly} />}
        {tab === 'agents' && <AgentsTab facade={facade} spaceId={spaceId} openSessionId={openSessionId} onOpenSession={onOpenSession} lifecycle={lifecycle} liveOnly={liveOnly} />}
        {tab === 'docs' && <DocsTab facade={facade} spaceId={spaceId} />}
        {tab === 'drawings' && <DrawingsTab facade={facade} spaceId={spaceId} />}
      </div>
      <div className="pn-fade" />
    </aside>
  );
}
