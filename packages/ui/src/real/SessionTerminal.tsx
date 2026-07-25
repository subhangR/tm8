/**
 * A real, interactive terminal for a live agent session, fed by the PTY
 * WebSocket.
 *
 * This REPLACED a 500ms `GET /pty/output` poll. The poll was the terminal lag:
 * it repainted on a fixed tick regardless of output, so a fast agent arrived in
 * visible half-second bursts and an idle one still cost a request every tick per
 * session. Output is now PUSHED over `/v2/ws?sessionId=<id>` — coalesced into
 * 16ms frames server-side, then into one animation frame client-side.
 *
 * The streaming machinery lives in ./terminal/ (transport, write scheduler,
 * visibility driver, runtime), not here: it is module-level and shared by every
 * mounted terminal. This component owns the xterm instance, its DOM node, and
 * the two things that only make sense per-view — SIZING and INPUT.
 *
 * RENDERER: the DEFAULT DOM renderer, and NO addons. Two independent reasons,
 * both learned the hard way:
 *  - the WebGL/Canvas addons crash in this React/StrictMode setup (a documented
 *    dead-end);
 *  - xterm's WebGL renderer allocates ONE GPU CONTEXT PER TERMINAL, so with many
 *    terminals mounted the browser blows past its ~16-context cap and thrashes,
 *    pegging the GPU and stalling the whole tab's compositor — the ENTIRE UI
 *    goes laggy, not just the terminal.
 */
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { ptyTransport } from './terminal/ptyTransport.js';
import { registerTerminal } from './terminal/runtime.js';

/**
 * Compute the grid that fills `container`, the way `@xterm/addon-fit` does.
 *
 * We read the render service's measured CELL SIZE rather than adding the addon:
 * tm8 is deliberately dependency-light and a new package moves `bun.lock`. This
 * touches xterm's private `_core`, which is exactly what FitAddon does too — so
 * it carries the same (real) upgrade risk, hence the defensive optional chaining
 * and the null return that simply leaves the grid alone.
 *
 * Measuring the CELL, not guessing from font size, is what keeps a full-screen
 * terminal from wrapping at the wrong column: the PTY is told the same grid the
 * renderer actually uses, so the agent's own line wrapping agrees with ours.
 */
function computeFit(term: Terminal, container: HTMLElement): { cols: number; rows: number } | null {
  const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } } })._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  if (!cell?.width || !cell?.height) return null;
  const style = getComputedStyle(container);
  const padX = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0');
  const padY = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0');
  const cols = Math.max(2, Math.floor((container.clientWidth - padX) / cell.width));
  const rows = Math.max(1, Math.floor((container.clientHeight - padY) / cell.height));
  return { cols, rows };
}

export function SessionTerminal({
  sessionId,
  live,
  fill = false,
}: {
  sessionId: string;
  live: boolean;
  /** Fill the parent's height instead of using the compact fixed-height box. */
  fill?: boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    if (!host.current || !sessionId) return;
    const container = host.current;

    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      theme: { background: '#0b0c10', foreground: '#e7e7ea' },
      // Blink only matters for a terminal you are typing into, and each mounted
      // xterm with blink on runs its OWN timer plus a periodic cursor refresh —
      // N mounted terminals means N steady repaint loops that scale with the
      // fleet. One interactive terminal on screen, so this is affordable here.
      cursorBlink: true,
      scrollback: 5000,
    });
    term.open(container);

    const unregister = registerTerminal(sessionId, term);

    // INPUT. Keystrokes go straight out as binary frames; the server writes them
    // to the PTY. We do NOT echo locally — the PTY echoes, so echoing here too
    // would double every character.
    const onData = term.onData((data) => ptyTransport.write(sessionId, data));

    const offExit = ptyTransport.onExit((id) => {
      if (id === sessionId) setEnded(true);
    });

    // SIZING. Fit to the container and tell the PTY, so the agent's own wrapping
    // matches the grid we render. Debounced through rAF because a drag fires
    // ResizeObserver continuously and each resize reflows the whole buffer.
    let raf = 0;
    const applyFit = () => {
      raf = 0;
      const next = computeFit(term, container);
      if (!next) return;
      if (next.cols !== term.cols || next.rows !== term.rows) {
        term.resize(next.cols, next.rows);
        ptyTransport.resize(sessionId, next.cols, next.rows);
      }
    };
    const scheduleFit = () => {
      if (raf === 0) raf = requestAnimationFrame(applyFit);
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(container);
    scheduleFit();

    // The server sends its own {type:'size'} on attach so the replay renders at
    // the width it was authored at; once we are attached, OUR grid is the truth,
    // so re-assert it. Without this a resumed session keeps the old PTY width.
    const offSize = ptyTransport.onSize((id) => {
      if (id === sessionId) scheduleFit();
    });

    ptyTransport.openSession(sessionId);

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      ro.disconnect();
      offSize();
      offExit();
      onData.dispose();
      unregister();
      ptyTransport.closeSession(sessionId);
      term.dispose();
    };
  }, [sessionId]);

  const finished = ended || !live;

  return (
    <div
      style={
        fill
          ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, marginTop: 10 }
          : { marginTop: 10 }
      }
    >
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
          {finished ? 'session ended' : 'live · streaming · type to interact'}
        </span>
      </div>
      <div
        ref={host}
        style={{
          // `minHeight: 0` is load-bearing in the fill case: without it a flex
          // child refuses to shrink below its content and the terminal pushes
          // the dialog's footer off-screen instead of scrolling internally.
          ...(fill ? { flex: 1, minHeight: 0 } : { height: 260 }),
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
