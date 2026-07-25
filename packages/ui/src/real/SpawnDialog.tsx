/**
 * The work-session surface: spawn an agent on a task, watch its status, prompt
 * it, terminate it.
 *
 * Deliberate design choices, all of them about not guessing on the user's
 * behalf:
 *
 * - Project and agent persona are CHOSEN, never defaulted. `execution.spawn`
 *   requires a `teamMemberId` and refuses an untrusted project; silently
 *   picking "the first one" would start a real process in a real directory
 *   under a real identity that nobody selected.
 * - An untrusted project is shown and DISABLED with the reason, rather than
 *   hidden or silently upgraded. The server's refusal to spawn into a
 *   directory nobody vouched for is a feature, so the UI states it.
 * - It SPAWNS, and then it gets out of the way. It used to keep the new session
 *   in local state and host the terminal itself, which meant the only handle on
 *   a running agent was this component: close it, or reload, and a live PTY
 *   became unreachable with no way back. Now a successful spawn navigates to
 *   `#/s/{space}/sessions/{id}` — the route IS the durable handle, and the
 *   Sessions view owns the terminal. One terminal, one owner, survives reload.
 */
import { useEffect, useState } from 'react';
import type { EntitySummary } from '../collab-v2/types/contract';
import { useNavStore } from '../collab-v2/stores/nav';
import type { RealFacade, Tm8Project } from './RealFacade';
import { SPAWN_REQUEST_EVENT } from './tm8Kinds';

interface Req { taskId: string; spaceId: string }

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 200, display: 'grid', placeItems: 'center',
  background: 'rgba(0,0,0,.55)',
};
const card: React.CSSProperties = {
  width: 'min(560px, 92vw)', maxHeight: '86vh', overflow: 'auto',
  background: 'var(--pn-surface, #1b1c20)', color: 'var(--pn-text, #e7e7ea)',
  border: '1px solid var(--pn-line, #33343a)', borderRadius: 10, padding: 20,
  font: '13px/1.6 ui-sans-serif, system-ui, sans-serif',
};
const btn: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 6, cursor: 'pointer', font: 'inherit',
  border: '1px solid var(--pn-line, #33343a)', background: 'var(--pn-bg, #121317)', color: 'inherit',
};
const row: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', marginBottom: 6,
  padding: '8px 10px', borderRadius: 6, font: 'inherit',
  border: '1px solid var(--pn-line, #33343a)', background: 'var(--pn-bg, #121317)', color: 'inherit',
};

export function SpawnDialog({ facade }: { facade: RealFacade }) {
  const [req, setReq] = useState<Req | null>(null);
  const [projects, setProjects] = useState<Tm8Project[]>([]);
  const [members, setMembers] = useState<EntitySummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setView = useNavStore((s) => s.setView);

  useEffect(() => {
    const onReq = (e: Event) => {
      const detail = (e as CustomEvent<Req>).detail;
      setReq(detail);
      setError(null); setProjectId(null); setMemberId(null);
      facade.listProjects().then((ps) => {
        setProjects(ps);
        // If there is exactly one spawnable (trusted) project, pre-select it —
        // there is no choice to make, so making the user hunt for the click is
        // pure friction. Ambiguity (0 or >1) is still left explicit.
        const trusted = ps.filter((p) => p.trust === 'trusted');
        if (trusted.length === 1) setProjectId(trusted[0]!.id);
      }, (err) => setError(String(err?.message ?? err)));
      facade
        .queryCollection({ spaceId: detail.spaceId, kinds: ['team_member'], limit: 50 })
        .then((r) => {
          setMembers(r.page.items);
          if (r.page.items.length === 1) setMemberId(r.page.items[0]!.id);
        }, (err) => setError(String(err?.message ?? err)));
    };
    window.addEventListener(SPAWN_REQUEST_EVENT, onReq);
    return () => window.removeEventListener(SPAWN_REQUEST_EVENT, onReq);
  }, [facade]);

  if (!req) return null;

  const close = () => setReq(null);

  const spawn = async () => {
    if (!projectId || !memberId) return;
    setBusy(true); setError(null);
    try {
      const result = await facade.spawnSession({
        spaceId: req.spaceId, projectId, teamMemberId: memberId, taskIds: [req.taskId],
      });
      if (!result.entity) throw new Error('spawn returned no session entity');
      // Hand the session to the route before dismissing. Navigating first means
      // there is never an instant where a live agent exists and nothing on
      // screen refers to it.
      setView('sessions', result.entity.id);
      setReq(null);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Spawn an agent">
      <div style={card}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16, flex: '0 0 auto' }}>
          Spawn an agent on this task
        </h2>

        <p className="t-secondary" style={{ margin: '0 0 14px', opacity: 0.7 }}>
          A session runs as a persona, in a project directory. Both are chosen
          explicitly — this starts a real process.
        </p>

            <h3 style={{ fontSize: 12, textTransform: 'uppercase', opacity: 0.6, margin: '0 0 6px' }}>
              Project <span style={{ textTransform: 'none', opacity: 0.7 }}>· click to select</span>
            </h3>
            {projects.length === 0 && <p style={{ opacity: 0.7 }}>No projects on this node.</p>}
            {projects.map((p) => {
              const untrusted = p.trust !== 'trusted';
              return (
                <button
                  key={p.id}
                  style={{
                    ...row,
                    opacity: untrusted ? 0.5 : 1,
                    cursor: untrusted ? 'not-allowed' : 'pointer',
                    outline: projectId === p.id ? '2px solid var(--pn-brand, #6366f1)' : 'none',
                    background: projectId === p.id ? 'rgba(99,102,241,.15)' : (row.background as string),
                  }}
                  disabled={untrusted}
                  title={untrusted ? 'Spawning into an untrusted project is refused by the server' : p.workingDir}
                  onClick={() => setProjectId(p.id)}
                >
                  <strong>{projectId === p.id ? '✓ ' : ''}{p.name}</strong>
                  <div style={{ opacity: 0.6, fontSize: 11 }} className="t-mono">{p.workingDir}</div>
                  {untrusted && <div style={{ color: '#fbbf24', fontSize: 11 }}>untrusted — spawn refused</div>}
                </button>
              );
            })}

            <h3 style={{ fontSize: 12, textTransform: 'uppercase', opacity: 0.6, margin: '14px 0 6px' }}>Agent</h3>
            {members.length === 0 && (
              <p style={{ opacity: 0.7 }}>
                No team members in this space. Create one (kind <code>team_member</code>) first —
                <code> execution.spawn</code> requires a persona.
              </p>
            )}
            {members.map((m) => (
              <button
                key={m.id}
                style={{
                  ...row,
                  outline: memberId === m.id ? '2px solid var(--pn-brand, #6366f1)' : 'none',
                  background: memberId === m.id ? 'rgba(99,102,241,.15)' : (row.background as string),
                }}
                onClick={() => setMemberId(m.id)}
              >
                {memberId === m.id ? '✓ ' : ''}{m.title}
              </button>
            ))}

        {error && (
          <pre style={{
            margin: '12px 0 0', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap', color: '#fca5a5',
            background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.3)',
            font: '11px/1.5 ui-monospace, Menlo, monospace',
          }} role="alert">{error}</pre>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18, flex: '0 0 auto' }}>
          <button style={btn} onClick={close}>Cancel</button>
          <button
            style={{ ...btn, borderColor: 'var(--pn-brand, #6366f1)' }}
            onClick={spawn}
            disabled={busy || !projectId || !memberId}
          >
            {busy ? 'Spawning…' : 'Spawn'}
          </button>
        </div>
      </div>
    </div>
  );
}
