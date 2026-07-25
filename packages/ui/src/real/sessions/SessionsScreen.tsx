/**
 * The Sessions surface — the list of agent sessions, and the live terminal for
 * whichever one is open.
 *
 * WHY THIS EXISTS. Before it, the entire execution product was a single modal
 * (`SpawnDialog`) that held its session in React local state. Nothing listed
 * sessions, so closing the modal or reloading the page left a REAL agent with a
 * REAL PTY running on the node with no way back to it — you could start work you
 * could never watch again. That is the gap this closes.
 *
 * WHY IT LIVES IN `real/` AND NOT IN THE MODULE. The collab-v2 module is
 * backend-agnostic by law and never imports from `real/`; it also predates
 * tm8 and has no `work_session` in its `EntityKind` union. The terminal, the PTY
 * socket and the execution commands are all tm8-specific. So the execution
 * surface is supplied FROM the integration layer through the shell's existing
 * `ViewRegistry` seam — the same injection shape `installTm8Kinds()` already
 * uses for kinds. The module stays clean; nothing is forked to achieve it.
 *
 * DURABILITY. The open session is identified by the ROUTE
 * (`#/s/{space}/sessions/{sessionId}`), never by component state, so a reload,
 * a deep link, or back/forward all land on the same live terminal.
 */
import { useCallback, useEffect, useState } from 'react';
import type { EntitySummary } from '../../collab-v2/types/contract';
import type { ShellViewProps } from '../../collab-v2/shell';
import type { RealFacade } from '../RealFacade';
import { SessionTerminal } from '../SessionTerminal';
import { SessionStatusPill } from '../tm8Kinds';
import './sessions.css';

/** How often the list re-reads. Sessions change state without a graph event. */
const LIST_POLL_MS = 4000;
/** The open session polls faster — its status drives the terminal's liveness. */
const DETAIL_POLL_MS = 1500;

/**
 * `work_session` is not in the module's `EntityKind` union (it predates tm8's
 * promotion of the kind), but `collections.query` is generic over kinds
 * server-side with no allowlist — so this works today against the real node
 * with no contract change. The cast is the honest, narrow way to say that.
 */
const WORK_SESSION_KINDS = ['work_session'] as unknown as EntitySummary['kind'][];

interface SessionState {
  status?: string;
  agentTool?: string | null;
  model?: string | null;
  startedAt?: string | null;
  exitedAt?: string | null;
}

function stateOf(s: EntitySummary): SessionState {
  return (s.state ?? {}) as unknown as SessionState;
}

/** `2026-07-25T18:40:12Z` → `18:40:12`. Absent stays absent — never "—" as a time. */
function clock(iso: string | null | undefined): string | null {
  return iso ? String(iso).slice(11, 19) : null;
}

function useSessions(facade: RealFacade, spaceId: string) {
  const [sessions, setSessions] = useState<EntitySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    facade
      .queryCollection({ spaceId, kinds: WORK_SESSION_KINDS, limit: 100, sort: 'activityAt_desc' })
      .then(
        (result) => { setSessions(result.page.items); setError(null); },
        (err) => setError(String((err as Error)?.message ?? err)),
      );
  }, [facade, spaceId]);

  useEffect(() => {
    load();
    const id = setInterval(load, LIST_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  return { sessions, error, reload: load };
}

function SessionRow({ session, active, onOpen }: {
  session: EntitySummary; active: boolean; onOpen: () => void;
}) {
  const st = stateOf(session);
  const started = clock(st.startedAt);
  const exited = clock(st.exitedAt);

  return (
    <button
      type="button"
      className="tm8-sessrow"
      data-active={active || undefined}
      data-session={session.id}
      onClick={onOpen}
    >
      <SessionStatusPill status={st.status ?? 'unknown'} />
      <span className="tm8-sessrow__title">{session.title || 'Session'}</span>
      <span className="tm8-sessrow__meta t-mono">
        {[st.agentTool, st.model].filter(Boolean).join(' · ') || 'agent unknown'}
      </span>
      <span className="tm8-sessrow__time t-mono">
        {exited ? `exited ${exited}` : started ? `started ${started}` : ''}
      </span>
    </button>
  );
}

/**
 * The open session: status, controls, and the live terminal.
 *
 * The terminal is keyed by session id so switching sessions tears down the old
 * xterm and its socket rather than re-pointing a live one — reattaching to a
 * different PTY under the same instance would replay the new session's
 * scrollback into the previous session's buffer.
 */
function SessionDetail({ facade, sessionId, onBack }: {
  facade: RealFacade; sessionId: string; onBack: () => void;
}) {
  const [session, setSession] = useState<EntitySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = () => {
      facade.getEntity(sessionId).then(
        (fresh) => { if (alive) { setSession(fresh); setError(null); } },
        (err) => { if (alive && !session) setError(String((err as Error)?.message ?? err)); },
      );
    };
    read();
    const id = setInterval(read, DETAIL_POLL_MS);
    return () => { alive = false; clearInterval(id); };
    // `session` is deliberately not a dependency: it would restart the poll on
    // every tick. The guard above only suppresses the FIRST-load error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facade, sessionId]);

  const status = String(stateOf(session ?? ({} as EntitySummary)).status ?? '');
  const live = Boolean(session) && status !== 'exited' && status !== 'failed';

  const prompt = async () => {
    // A browser prompt() is a placeholder, not a design. A real composer (with
    // history, and a record of what was sent) is Wave 1 — this at least lets a
    // reattached session be driven today.
    const message = window.prompt('Message to send to the agent:');
    if (!message) return;
    setBusy(true);
    try { await facade.promptSession(sessionId, message); setError(null); }
    catch (err) { setError(String((err as Error)?.message ?? err)); }
    finally { setBusy(false); }
  };

  const terminate = async () => {
    setBusy(true);
    try {
      const r = await facade.terminateSession(sessionId);
      if (r.entity) setSession(r.entity);
      setError(null);
    } catch (err) { setError(String((err as Error)?.message ?? err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="tm8-sessdetail">
      <header className="tm8-sessdetail__head">
        <button type="button" className="tm8-sess__btn" onClick={onBack}>← All sessions</button>
        <SessionStatusPill status={status || 'unknown'} />
        <span className="tm8-sessdetail__title">{session?.title ?? 'Session'}</span>
        <span className="tm8-sessdetail__id t-mono">{sessionId}</span>
        <span className="tm8-sess__spacer" />
        <button type="button" className="tm8-sess__btn" onClick={prompt} disabled={busy || !live}>
          Prompt
        </button>
        <button type="button" className="tm8-sess__btn" onClick={terminate} disabled={busy || !live}>
          Terminate
        </button>
      </header>

      {error && <pre className="tm8-sess__error" role="alert">{error}</pre>}

      {/*
        Mounted for exited sessions too: the server keeps the output ring, so
        attaching replays what the agent did. A finished session you cannot read
        back is the same lost-work problem this screen exists to fix.
      */}
      <SessionTerminal key={sessionId} sessionId={sessionId} live={live} fill />
    </div>
  );
}

export function SessionsScreen({ facade, spaceId, entityId, onNavigate }: ShellViewProps) {
  // The shell hands the module's `CollabFacade`; the execution commands live on
  // the tm8 implementation behind it. This screen is only ever registered by
  // the real entry, so the widening is sound — and it is asserted, not assumed.
  const real = facade as unknown as RealFacade;
  const { sessions, error, reload } = useSessions(real, spaceId);

  const openSession = useCallback(
    (id: string | null) => onNavigate('sessions', id),
    [onNavigate],
  );

  if (entityId) {
    return (
      <div className="tm8-sess" data-testid="view-sessions">
        <SessionDetail facade={real} sessionId={entityId} onBack={() => openSession(null)} />
      </div>
    );
  }

  const running = (sessions ?? []).filter((s) => {
    const st = stateOf(s).status;
    return st === 'running' || st === 'spawning' || st === 'idle';
  });
  const finished = (sessions ?? []).filter((s) => !running.includes(s));

  return (
    <div className="tm8-sess" data-testid="view-sessions">
      <header className="tm8-sess__head">
        <div>
          <div className="cv2-eyebrow">sessions</div>
          <h1 className="tm8-sess__h1">Agent sessions</h1>
          <p className="tm8-sess__blurb">
            Every agent this space has spawned. Open one to watch its terminal
            and type into it — a session stays reachable here after a reload.
          </p>
        </div>
        <button type="button" className="tm8-sess__btn" onClick={reload}>Refresh</button>
      </header>

      {error && <pre className="tm8-sess__error" role="alert">{error}</pre>}

      {sessions === null && !error && <p className="cv2-empty-line">Loading sessions…</p>}

      {sessions !== null && sessions.length === 0 && (
        <p className="cv2-empty-line">
          No sessions yet — open a task and choose <strong>Spawn agent</strong> to
          start one.
        </p>
      )}

      {running.length > 0 && (
        <section className="tm8-sess__group">
          <div className="cv2-eyebrow">live · {running.length}</div>
          {running.map((s) => (
            <SessionRow key={s.id} session={s} active={false} onOpen={() => openSession(s.id)} />
          ))}
        </section>
      )}

      {finished.length > 0 && (
        <section className="tm8-sess__group">
          <div className="cv2-eyebrow">finished · {finished.length}</div>
          {finished.map((s) => (
            <SessionRow key={s.id} session={s} active={false} onOpen={() => openSession(s.id)} />
          ))}
        </section>
      )}
    </div>
  );
}
