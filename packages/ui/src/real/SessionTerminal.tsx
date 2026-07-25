/**
 * A real rendered terminal for a live agent session.
 *
 * There is no PTY WebSocket on this node yet (that is the post-G1A live-stream
 * lane), so this reads the server's sanitized scrollback by HTTP POLL — the same
 * offset-replay seam `PtyHostService.attach` uses, minus the live subscription.
 * `GET /pty/output?sessionId&offset` returns `{ base, gap, next, data }` with
 * `data` base64; we advance our offset to `next` each tick so no byte is painted
 * twice, and surface an explicit truncation marker on a `gap` (bytes evicted
 * from the 1 MiB ring before we asked). Honest by construction: what you see is
 * exactly what the PTY produced, or a marked gap — never invented output.
 *
 * xterm with the DEFAULT DOM renderer and NO addons: the WebGL/Canvas addons
 * crash in this React/StrictMode setup (a documented dead-end), and the DOM
 * renderer is correct for the low-volume output a session produces.
 */
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

const POLL_MS = 500;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function SessionTerminal({ sessionId, live }: { sessionId: string; live: boolean }) {
  const host = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);

  // Create/destroy the xterm instance with the element. StrictMode double-invoke
  // is why disposal must be exact — a leaked Terminal keeps its own poll alive.
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      theme: { background: '#0b0c10', foreground: '#e7e7ea' },
      cursorBlink: false,
      disableStdin: true,
      scrollback: 5000,
    });
    term.open(host.current);
    termRef.current = term;
    return () => {
      termRef.current = null;
      term.dispose();
    };
  }, []);

  // Poll the byte stream and paint it. Offset lives in the effect closure so a
  // sessionId change starts a fresh stream at 0.
  useEffect(() => {
    if (!sessionId) return;
    let offset = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const res = await fetch(`/pty/output?sessionId=${encodeURIComponent(sessionId)}&offset=${offset}`);
        // /pty/output is unenveloped (sendRaw, like /health): fields are
        // top-level, NOT under a {data} envelope. Reading env.data here was the
        // reason the pane stayed blank while bytes flowed server-side.
        const slice = (await res.json()) as {
          found: boolean; base: number; gap: number; next: number; data: string;
        };
        const term = termRef.current;
        if (slice.found && term) {
          if (slice.gap > 0) term.write(`\r\n\x1b[33m…[${slice.gap} bytes evicted]…\x1b[0m\r\n`);
          if (slice.data) term.write(b64ToBytes(slice.data));
          offset = slice.next;
        }
      } catch {
        /* transient — the next tick retries */
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 11, textTransform: 'uppercase', opacity: 0.6 }}>Terminal</span>
        <span style={{ fontSize: 10, opacity: 0.5 }}>{live ? 'polling · 0.5s' : 'session ended'}</span>
      </div>
      <div
        ref={host}
        style={{
          height: 260, background: '#0b0c10', borderRadius: 6,
          border: '1px solid var(--pn-line, #33343a)', padding: 6, overflow: 'hidden',
        }}
      />
    </div>
  );
}
