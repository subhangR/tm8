import { useRef } from 'react';
import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './terminal/terminal.css';
import { LiveTerminal, type LiveTerminalHandle } from './terminal';

/**
 * THROWAWAY P2 VERIFICATION HARNESS — not product code, never imported by
 * anything else, never landed. Same spirit as
 * packages/tm8-ui/scratch-p1-run-src/: it exists to pixel-verify LiveTerminal
 * against a REAL session on the shared :4610 node without touching the
 * fixture-vs-real-seam wiring in views/useGateData.ts (Frontend lane's open
 * window — see liveTerminalFlag.ts).
 *
 * Usage: /terminal-dev.html?sessionId=<uuid>
 */
function Harness() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('sessionId');
  const handleRef = useRef<LiveTerminalHandle>(null);

  if (!sessionId) {
    return (
      <p style={{ font: '13px monospace', padding: 16 }}>
        Pass ?sessionId=&lt;uuid&gt; of a real, running work_session.
      </p>
    );
  }

  return (
    // P ruled TYPO (via master, 2026-07-29): '#1B1812' was a hand-typed
    // near-miss of dark --pn-surface #1B1810 — no token, no oracle site, one
    // digit off. Tokens adopted per P's own (a): the guard's first find was a
    // real one-shade-off defect, not a style nit.
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--pn-surface)' }}>
      <div style={{ padding: 8, font: '12px monospace', color: 'var(--pn-x-term-fg)', display: 'flex', gap: 12 }}>
        <span>session: {sessionId}</span>
        <button type="button" onClick={() => handleRef.current?.blur()}>
          blur (⌃`)
        </button>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex' }}>
        <LiveTerminal ref={handleRef} sessionId={sessionId} live />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
