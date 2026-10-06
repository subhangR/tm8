/**
 * "Active sessions" on Work's start surface (D31 audit gap G1, Design Advisor
 * R39): the old Work's terminal-activity roster — needs attention, running,
 * starting — at most six rows, no "show more", hidden when nothing is active.
 * Rows are the old roster's own (`SessionRosterRow`); a click opens the
 * session as a Work tab.
 */
import { useMemo } from 'react';
import { allKinds } from '../../domain';
import { toSessionRow } from '../../terminal';
import { SessionRosterRow, activeSessionsOf } from '../../views/EmptyCenter';
import { useWorkspace } from './context';

const ROSTER_KIND = allKinds().find((kind) => kind.list.liveTreatment != null)?.kind;
const MAX_ROWS = 6;

export function ActiveSessions() {
  const { gate, dispatch } = useWorkspace();
  const { data } = gate;
  const sessions = useMemo(() => {
    if (!ROSTER_KIND) return [];
    const rows = data.rowsFor(ROSTER_KIND)(undefined).map((summary) => toSessionRow(summary));
    return activeSessionsOf(rows, data.livenessOf).slice(0, MAX_ROWS);
  }, [data]);
  if (!ROSTER_KIND || sessions.length === 0) return null;
  const kind = ROSTER_KIND;
  return (
    <section className="tws-pick-section tws-active-sessions" aria-label="Active sessions" data-testid="tws-active-sessions">
      <span className="t-eyebrow">Active sessions</span>
      <ul className="shell-empty__roster">
        {sessions.map((session) => (
          <li key={session.row.id}>
            <SessionRosterRow
              session={session}
              onOpen={(entityId) =>
                dispatch({ command: 'workspace.tabs.open', args: { kind, entityId }, source: 'click' })
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
