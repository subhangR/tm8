import type { RealFacade } from '../../RealFacade';
import { useSessionLinks, useSessions } from '../useSessions';
import { SessionTree, type SessionLifecycleFilter } from './SessionTree';

export interface TerminalsTabProps {
  facade: RealFacade;
  spaceId: string;
  openSessionId: string | null;
  onOpenSession: (sessionId: string | null) => void;
  lifecycle?: SessionLifecycleFilter;
  liveOnly?: boolean;
}

export function TerminalsTab({ facade, spaceId, openSessionId, onOpenSession, lifecycle = 'open', liveOnly = false }: TerminalsTabProps) {
  const { sessions, error } = useSessions(facade, spaceId);
  const links = useSessionLinks(facade, sessions);
  const terminals = (sessions ?? []).filter((session) => {
    const state = session.state as unknown as { agentTool?: string | null };
    return !state.agentTool;
  });

  return (
    <div className="pn-scroll" data-testid="tab-terminals">
      {error && <pre className="ws-res__error" role="alert">{error}</pre>}
      {sessions === null && !error && <div className="ws-session-skeleton" aria-label="Loading terminals" />}
      {sessions !== null && (
        <SessionTree
          sessions={terminals}
          links={links}
          active={openSessionId}
          onOpen={(id) => onOpenSession(id)}
          lifecycle={lifecycle}
          liveOnly={liveOnly}
        />
      )}
    </div>
  );
}
