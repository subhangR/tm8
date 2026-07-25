/**
 * Pre-shell states: loading, failed, no-spaces, and choose-a-space.
 *
 * These exist as four DISTINCT screens rather than one spinner-then-shell,
 * because they are four genuinely different facts and collapsing them is how a
 * UI starts lying. "Still loading", "the server refused", "the server answered
 * and there is nothing" and "pick one of these" must not look alike — the
 * middle two in particular, since an empty workspace and an unreachable node
 * both end in a blank screen if you let them.
 */
import { useState } from 'react';
import type { SpaceSummary } from '../collab-v2/types/contract';
import type { RealFacade } from './RealFacade';

type Boot =
  | { phase: 'loading' }
  | { phase: 'ready'; spaces: SpaceSummary[] }
  | { phase: 'failed'; message: string };

const wrap: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start',
  padding: '48px 40px', font: '14px/1.6 ui-sans-serif, system-ui, sans-serif',
  color: 'var(--pn-text, #e7e7ea)', maxWidth: 640,
};

const button: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--pn-line, #33343a)',
  background: 'var(--pn-surface, #1b1c20)', color: 'inherit', font: 'inherit',
};

export function SpacePicker({
  boot, facade, onPick, onRetry,
}: {
  boot: Boot;
  facade: RealFacade;
  onPick: (spaceId: string) => void;
  onRetry: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (boot.phase === 'loading') {
    return <div style={wrap} role="status">Connecting to the tm8 server…</div>;
  }

  if (boot.phase === 'failed') {
    return (
      <div style={wrap} role="alert">
        <h1 style={{ margin: 0, fontSize: 18 }}>Could not reach the tm8 server</h1>
        {/* The raw failure, not a friendly paraphrase: the person looking at
            this screen is the person who can fix it. */}
        <pre style={{
          margin: 0, padding: 12, borderRadius: 6, whiteSpace: 'pre-wrap',
          background: 'var(--pn-surface, #1b1c20)', border: '1px solid var(--pn-line, #33343a)',
          font: '12px/1.5 ui-monospace, Menlo, monospace',
        }}>{boot.message}</pre>
        <p style={{ margin: 0, opacity: 0.75 }}>
          The dev server proxies <code>/v2</code> to <code>{'http://127.0.0.1:4620'}</code> by
          default. Start a node there, or set <code>TM8_SERVER_ORIGIN</code> and restart Vite.
        </p>
        <button style={button} onClick={onRetry}>Retry</button>
      </div>
    );
  }

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const { space } = await facade.createSpace('My Space');
      onPick(space.id);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
      setCreating(false);
    }
  };

  if (boot.spaces.length === 0) {
    return (
      <div style={wrap}>
        <h1 style={{ margin: 0, fontSize: 18 }}>No spaces on this node</h1>
        <p style={{ margin: 0, opacity: 0.75 }}>
          The server answered normally — it simply has no spaces yet. This is an
          empty database, not a failed request.
        </p>
        <button style={button} onClick={create} disabled={creating}>
          {creating ? 'Creating…' : 'Create a space'}
        </button>
        {error && <p style={{ margin: 0, color: '#f87171' }} role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div style={wrap}>
      <h1 style={{ margin: 0, fontSize: 18 }}>Choose a space</h1>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8, width: '100%' }}>
        {boot.spaces.map((s) => (
          <li key={s.id}>
            <button style={{ ...button, width: '100%', textAlign: 'left' }} onClick={() => onPick(s.id)}>
              <strong>{s.name}</strong>
              <span style={{ opacity: 0.6 }}> · {s.memberCount} member{s.memberCount === 1 ? '' : 's'}</span>
            </button>
          </li>
        ))}
      </ul>
      <button style={button} onClick={create} disabled={creating}>
        {creating ? 'Creating…' : 'New space'}
      </button>
      {error && <p style={{ margin: 0, color: '#f87171' }} role="alert">{error}</p>}
    </div>
  );
}
