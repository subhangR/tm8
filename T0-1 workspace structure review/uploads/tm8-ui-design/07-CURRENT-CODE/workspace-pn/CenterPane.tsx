/**
 * Maestro's dark centre surface around tm8's proven terminal transport.
 *
 * Session terminals live in a bounded mounted-LRU: ordinary switches keep a
 * small working set warm, while the least-recently-viewed xterm is fully
 * disposed when the bound is crossed. Mounted-but-hidden layers retain their
 * geometry with visibility:hidden; the visibility driver polls computed style
 * and suspends their sockets after its own separate warm-socket policy.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EntityId, EntitySummary } from '../../collab-v2/types/contract';
import { Thread } from '../../collab-v2/subsystems/thread';
import { SessionTerminal } from '../SessionTerminal';
import type { RealFacade } from '../RealFacade';
import { ChromeIcon } from './IconRail';
import { Composer } from './Composer';
import { disabledBecause, Note } from './Unavailable';
import { sessionState, useSessionDetail } from './useSessions';
import './styles/center-pane.css';

export type CenterTab = 'terminal' | 'thread';

/** Mounted-xterm memory bound. Separate from terminal/visibilityDriver's warm socket LRU (3). */
export const MOUNTED_TERMINAL_LRU_SIZE = 4;

function touchMountedLru(ids: EntityId[], activeId: EntityId | null): EntityId[] {
  if (!activeId) return ids;
  const next = [...ids.filter((id) => id !== activeId), activeId];
  return next.slice(-MOUNTED_TERMINAL_LRU_SIZE);
}

export interface CenterPaneProps {
  facade: RealFacade;
  spaceId: string;
  sessionId: EntityId | null;
  taskId: EntityId | null;
  onCloseSession?: () => void;
  onOpenSession?: (sessionId: EntityId) => void;
}

interface ModeProjection {
  mode?: string | null;
}

function modeOf(session: EntitySummary | null): string | null {
  return session ? ((session.state ?? {}) as unknown as ModeProjection).mode ?? null : null;
}

function modeLabel(mode: string | null): string {
  if (mode === 'coordinator') return 'Coordinator';
  if (mode === 'coordinated-coordinator') return 'Coordinated · Coordinator';
  if (mode === 'coordinated-worker') return 'Coordinated · Worker';
  if (mode === 'worker') return 'Worker';
  return 'Role unavailable';
}

function isCoordinator(mode: string | null): boolean {
  return mode === 'coordinator' || mode === 'coordinated-coordinator';
}

export function CenterPane({ facade, sessionId, taskId, onCloseSession }: CenterPaneProps) {
  const [tab, setTab] = useState<CenterTab>('terminal');
  const [mountedLru, setMountedLru] = useState<EntityId[]>([]);
  const liveBySession = useRef(new Map<EntityId, boolean>());
  const { session, error, live } = useSessionDetail(facade, sessionId);
  const state = session ? sessionState(session) : {};
  const status = String(state.status ?? '');
  const mode = modeOf(session);
  const coordinator = isCoordinator(mode);

  useEffect(() => {
    if (!taskId && tab === 'thread') setTab('terminal');
  }, [tab, taskId]);

  if (sessionId) liveBySession.current.set(sessionId, live);

  // Derive the rendered set immediately so a switch never flashes an empty
  // centre, then commit the same order after layout. The slice guarantees that
  // even this transition render never exceeds the mounted-xterm bound.
  const renderedLru = touchMountedLru(mountedLru, sessionId);
  const renderedKey = renderedLru.join('\u0000');
  useLayoutEffect(() => {
    if (mountedLru.join('\u0000') !== renderedKey) setMountedLru(renderedLru);
  }, [mountedLru, renderedKey, renderedLru]);

  const showThread = tab === 'thread' && Boolean(taskId);

  return (
    <section className="terminalArea ws-center" data-testid="center-pane" aria-label="Terminal and thread">
      <div className="terminalPane" data-empty={!sessionId || undefined}>
        {sessionId && (
          <div className="termStrip" data-testid="terminal-strip">
            <div className="termStripBar">
              <button
                type="button"
                className="termStripToggle"
                disabled
                title="Session log is unavailable: tm8 does not store a durable transcript"
              >
                <span className="termStripChevron">▸</span>
                <span className="termStripLabel">Session Log</span>
                {live && <span className="termStripLiveDot" />}
                {live && <span className="termStripLiveTag">LIVE</span>}
              </button>

              <div className="termStripRail">
                <div className="termStripRailInner">
                  <span
                    className="termStripStat ws-center__title"
                    title={`${session?.title ?? 'Session'}\nsession ${sessionId}`}
                  >
                    {session?.title ?? 'Session'}
                  </span>
                  <span className="termStripStat termStripStat--dim ws-center__id" title={sessionId}>
                    {sessionId}
                  </span>
                  {status && <span className="termStripStat termStripStat--dim">{status}</span>}
                </div>
              </div>

              {state.model && <span className="termStripModel" title="Model">{state.model}</span>}

              <div className="termStripActions">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!showThread}
                  className="termStripActionBtn"
                  data-testid="center-tab-terminal"
                  onClick={() => setTab('terminal')}
                  title="Terminal"
                >
                  <span className="termStripActionGlyph terminalGlyph">&gt;_</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={showThread}
                  className="termStripActionBtn"
                  data-testid="center-tab-thread"
                  disabled={!taskId}
                  title={taskId ? 'Task thread' : 'select a task to see its thread'}
                  onClick={() => setTab('thread')}
                >
                  <span className="termStripActionGlyph">#</span>
                </button>
                <button
                  type="button"
                  className="termStripActionBtn"
                  data-testid="terminal-image-paste"
                  aria-label="Paste image into terminal"
                  {...disabledBecause('uploadFile')}
                >
                  <span className="termStripActionGlyph" aria-hidden="true">▧</span>
                </button>
                {onCloseSession && (
                  <button
                    type="button"
                    className="termStripActionBtn"
                    data-testid="center-close"
                    onClick={onCloseSession}
                    title="Close terminal view"
                    aria-label="Close terminal view"
                  >
                    <ChromeIcon name="x" size={15} />
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="terminalDeck">
          {sessionId && (
            <span
              className={`modeChip ${coordinator ? 'modeChip--coordinator' : 'modeChip--worker'}`}
              title={mode ? `Session role: ${modeLabel(mode)}` : 'Session role is not projected by tm8'}
            >
              {modeLabel(mode)}
            </span>
          )}

          {error && <pre className="ws-center__error" role="alert" data-testid="center-error">{error}</pre>}

          <div className="ws-center__stack">
            {renderedLru.map((mountedId) => {
              const selected = mountedId === sessionId;
              const visible = selected && !showThread;
              return (
                <div
                  key={mountedId}
                  className={`terminalContainer ws-center__layer${selected && coordinator ? ' coordinator-glow' : ''}`}
                  data-testid={selected ? 'terminal-layer' : 'terminal-layer-cached'}
                  data-session-id={mountedId}
                  style={{ visibility: visible ? 'visible' : 'hidden' }}
                  aria-hidden={!visible}
                >
                  <div className="ws-center__terminal">
                    <SessionTerminal
                      sessionId={mountedId}
                      live={selected ? live : (liveBySession.current.get(mountedId) ?? true)}
                      active={visible}
                      fill
                    />
                  </div>
                  {selected && (
                    <Composer facade={facade} sessionId={mountedId} live={live} status={status} />
                  )}
                </div>
              );
            })}

            {!sessionId && (
              <div className="terminalContainer ws-center__layer ws-center__empty" data-testid="center-empty">
                <Note>No session open. Pick one in the Terminals panel or run a task.</Note>
                <Note testId="center-transcript-note">
                  Scrollback is replayed from the server&apos;s output ring, not a stored transcript.
                </Note>
              </div>
            )}

            {showThread && taskId && (
              <div className="ws-center__layer ws-center__thread" data-testid="thread-layer">
                <Thread anchorId={taskId} variant="comments" defaultExpanded="all" live={false} />
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
