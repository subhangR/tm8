import type { RealFacade } from '../../RealFacade';
import { agentsQuery } from '../queries';
import { HollowNote } from '../Unavailable';
import { LIST_POLL_MS, useSessionLinks, useSessions } from '../useSessions';
import { usePolledCollection } from '../usePolledCollection';
import { SessionTree, type SessionLifecycleFilter } from './SessionTree';

export interface AgentsTabProps {
  facade: RealFacade;
  spaceId: string;
  openSessionId?: string | null;
  onOpenSession?: (sessionId: string | null) => void;
  lifecycle?: SessionLifecycleFilter;
  liveOnly?: boolean;
}

export function AgentsTab({
  facade,
  spaceId,
  openSessionId = null,
  onOpenSession = () => undefined,
  lifecycle = 'open',
  liveOnly = false,
}: AgentsTabProps) {
  const { sessions, error, live, finished } = useSessions(facade, spaceId);
  const links = useSessionLinks(facade, sessions);
  const { items: agents } = usePolledCollection(facade, agentsQuery(spaceId), LIST_POLL_MS);
  const agentSessions = (sessions ?? []).filter((session) => {
    const state = session.state as unknown as { agentTool?: string | null };
    return Boolean(state.agentTool);
  });

  return (
    <div className="pn-scroll" data-testid="tab-agents">
      <div className="ws-res__a11y-meta" aria-live="polite">
        {(agents ?? []).map((agent) => <span key={agent.id}>{agent.title}</span>)}
        <span>live · {live.length}</span>
        <span>finished · {finished.length}</span>
        <HollowNote field="team_member.state.liveWork">What each agent is working on is not shown — live-work projection not built.</HollowNote>
      </div>
      {error && <pre className="ws-res__error" role="alert">{error}</pre>}
      {sessions === null && !error && <div className="ws-session-skeleton" aria-label="Loading sessions" />}
      {sessions !== null && (
        <SessionTree
          sessions={agentSessions}
          links={links}
          active={openSessionId}
          onOpen={(id) => onOpenSession(id)}
          lifecycle={lifecycle}
          liveOnly={liveOnly}
        />
      )}
      <div className="pn-list-end" aria-hidden="true"><span className="pn-list-end__line" /><span className="pn-list-end__label">end</span><span className="pn-list-end__line" /></div>
    </div>
  );
}
