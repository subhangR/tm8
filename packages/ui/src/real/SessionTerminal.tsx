/**
 * A real rendered terminal for a live agent session, fed by the PTY WebSocket.
 *
 * This REPLACED a 500ms `GET /pty/output` poll. The poll was the terminal lag: it
 * repainted on a fixed tick regardless of output, so a fast agent arrived in
 * visible half-second bursts and an idle one still cost a request every tick per
 * session. Output is now PUSHED over `/v2/ws?sessionId=<id>` — coalesced into
 * 16ms frames server-side, then into one animation frame client-side.
 *
 * The streaming machinery lives in ./terminal/ (transport, write scheduler,
 * visibility driver, runtime), not here: it is module-level and shared by every
 * mounted terminal. This component only owns the xterm instance and its DOM node.
 *
 * RENDERER: the DEFAULT DOM renderer, and NO addons. Two independent reasons,
 * both learned the hard way:
 *  - the WebGL/Canvas addons crash in this React/StrictMode setup (a documented
 *    dead-end);
 *  - xterm's WebGL renderer allocates ONE GPU CONTEXT PER TERMINAL, so with many
 *    terminals mounted the browser blows past its ~16-context cap and thrashes
 *    (constant context loss + recreation), pegging the GPU and stalling the whole
 *    tab's compositor — the ENTIRE UI goes laggy, not just the terminal.
 * Parse load is bounded instead by only feeding on-screen terminals (see
 * ./terminal/visibilityDriver.ts), which is the right axis anyway.
 */
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { ptyTransport } from './terminal/ptyTransport.js';
import { registerTerminal } from './terminal/runtime.js';

export function SessionTerminal({ sessionId, live }: { sessionId: string; live: boolean }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    if (!host.current || !sessionId) return;

    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      theme: { background: '#0b0c10', foreground: '#e7e7ea' },
      // Only a focused/active terminal should blink. Each mounted xterm with
      // cursorBlink on runs its OWN blink timer plus a periodic cursor refresh,
      // so N mounted terminals mean N steady repaint loops that scale with the
      // fleet and show up as gradual whole-UI lag. There is one terminal on this
      // screen today; leaving blink off keeps that cost at zero regardless.
      cursorBlink: false,
      // View-only for now: there is no client→server input path wired in this
      // view yet. The transport supports it (the socket carries binary
      // keystrokes), but enabling stdin without honoring the prompt-delivery
      // ownership rules would risk duplicate injection.
      disableStdin: true,
      scrollback: 5000,
    });
    term.open(host.current);

    const unregister = registerTerminal(sessionId, term);
    const offExit = ptyTransport.onExit((id) => {
      if (id === sessionId) setEnded(true);
    });
    ptyTransport.openSession(sessionId);

    return () => {
      offExit();
      unregister();
      ptyTransport.closeSession(sessionId);
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 11, textTransform: 'uppercase', opacity: 0.6 }}>Terminal</span>
        <span style={{ fontSize: 10, opacity: 0.5 }}>
          {ended || !live ? 'session ended' : 'live · streaming'}
        </span>
      </div>
      <div
        ref={host}
        style={{
          height: 260,
          background: '#0b0c10',
          borderRadius: 6,
          border: '1px solid var(--pn-line, #33343a)',
          padding: 6,
          overflow: 'hidden',
        }}
      />
    </div>
  );
}
