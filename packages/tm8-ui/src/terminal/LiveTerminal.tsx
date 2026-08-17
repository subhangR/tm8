import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { isTerminalBlurChord } from '../keyboard/contract';
import { dataTransferHasFiles } from './clipboardImages.js';
import { dispatchClipboardData } from './clipboardPaste.js';
import { copyToClipboardOrWarn } from './domUtils.js';
import { notifyUser } from './notifications.js';
import { isElementPaintable } from './pty/elementVisibility.js';
import { ptyTransport } from './pty/ptyTransport.js';
import { writeTerminalReplay } from './pty/replayHydration.js';
import { registerTerminal } from './pty/runtime.js';
import {
  clientFittedSessions,
  measureSpawnTerminalSize,
  serverPtySizes,
  setLastFittedSize,
} from './pty/terminalSize.js';
import { reconcileTerminalVisibility } from './pty/visibilityDriver.js';
import {
  TERMINAL_CURSOR_INACTIVE_STYLE,
  TERMINAL_CURSOR_STYLE,
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_STACK,
  TERMINAL_FONT_WEIGHT,
  TERMINAL_FONT_WEIGHT_BOLD,
  TERMINAL_LETTER_SPACING,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_SCROLLBACK,
  buildTerminalTheme,
} from './terminalTheme.js';
import { TerminalHost } from './TerminalHost';

const IMAGE_PASTE_UNSUPPORTED =
  'Pasting images into the terminal is not implemented yet — paste text, or type the path.';

type RenderDimension = { width: number; height: number };
type RenderDimensionsFallback = {
  css: { canvas: RenderDimension; cell: RenderDimension };
  device: {
    canvas: RenderDimension;
    cell: RenderDimension;
    char: { width: number; height: number; left: number; top: number };
  };
};

function createEmptyRenderDimensions(): RenderDimensionsFallback {
  const dim = (): RenderDimension => ({ width: 0, height: 0 });
  return {
    css: { canvas: dim(), cell: dim() },
    device: { canvas: dim(), cell: dim(), char: { width: 0, height: 0, left: 0, top: 0 } },
  };
}

/** xterm 6 can briefly expose a render service before its renderer dimensions. */
function patchXtermRenderServiceDimensions(term: Terminal): void {
  try {
    const core = (term as unknown as { _core?: Record<string, unknown> })._core as
      | { _renderService?: Record<string, unknown> }
      | undefined;
    const renderService = core?._renderService as
      | {
          _renderer?: { value?: { dimensions?: unknown }; _value?: { dimensions?: unknown } };
          __tm8SafeDimensions?: boolean;
        }
      | undefined;
    if (!renderService || renderService.__tm8SafeDimensions) return;
    const fallback = createEmptyRenderDimensions();
    Object.defineProperty(renderService, 'dimensions', {
      configurable: true,
      enumerable: true,
      get: () => {
        const renderer = renderService._renderer?.value ?? renderService._renderer?._value;
        return renderer?.dimensions ?? fallback;
      },
    });
    renderService.__tm8SafeDimensions = true;
  } catch {
    // A renderer-internal compatibility guard must never take down the PTY.
  }
}

function isXtermRendererReady(term: Terminal): boolean {
  const core = (term as unknown as { _core?: unknown })._core as
    | { _renderService?: { _renderer?: { value?: unknown; _value?: unknown } } }
    | undefined;
  const ref = core?._renderService?._renderer;
  const renderer = (ref?.value ?? ref?._value) as
    | { dimensions?: { css?: { cell?: { width?: number } } } }
    | undefined;
  return Boolean(renderer && (renderer.dimensions?.css?.cell?.width ?? 0) > 0);
}

export interface LiveTerminalHandle {
  /** Drop keyboard focus back to the app — the exit-terminal chip's target. */
  blur(): void;
}

export interface LiveTerminalProps {
  sessionId: string;
  /** Same-origin route prefix for the selected tm8 server. Empty means local. */
  serverBaseUrl?: string;
  /** False renders the terminal read-only (stdin disabled). */
  live: boolean;
  /** True while this retained xterm is the selected, paintable surface. */
  active?: boolean;
  onResize?: (sessionId: string, size: { cols: number; rows: number }) => void;
  onExit?: (sessionId: string, exitCode?: number | null) => void;
}

/**
 * THE LIVE TERMINAL — xterm mounted into the reserved TerminalHost box.
 *
 * Ported from packages/ui's SessionTerminal. Byte handling and the persistent
 * per-session offset/decoder laws remain aligned with that source; tm8-ui adds
 * explicit surface activation and attach/replay readiness around them. Layout
 * reuses tm8-ui's
 * TerminalHost (the T0-2 black box, with its 160px floor and a11y wiring)
 * instead of rendering its own div, and `cursorBlink` is hard-`false`
 * (maestro main ef0dcbe) rather than a user setting.
 */
export const LiveTerminal = forwardRef<LiveTerminalHandle, LiveTerminalProps>(function LiveTerminal(
  { sessionId, serverBaseUrl = '', live, active = true, onResize, onExit },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const resizeTimeoutRef = useRef<number | null>(null);
  const scheduleResizeRef = useRef<() => void>(() => undefined);
  const resizeRetryCountRef = useRef(0);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const fontsReadyRef = useRef(false);
  const activeRef = useRef(active);
  const attachedRef = useRef(false);
  const fittedRef = useRef(false);
  const awaitingReplayRef = useRef(false);
  /** One-shot per attach: has this view already asked the agent to repaint? */
  const repaintForcedRef = useRef(false);
  const hydratingRef = useRef(false);
  const hydrationGenerationRef = useRef(0);
  const hydrationTimerRef = useRef<number | null>(null);
  const hydrationRafRef = useRef<number | null>(null);
  const readOnlyRef = useRef(!live);
  const onResizeRef = useRef(onResize);
  const onExitRef = useRef(onExit);
  const [renderReady, setRenderReady] = useState(false);

  activeRef.current = active;
  readOnlyRef.current = !live;
  onResizeRef.current = onResize;
  onExitRef.current = onExit;

  useImperativeHandle(ref, () => ({
    blur: () => termRef.current?.blur(),
  }));

  useEffect(() => {
    const container = hostRef.current;
    if (!container || termRef.current) return;
    attachedRef.current = false;
    fittedRef.current = false;
    awaitingReplayRef.current = false;
    repaintForcedRef.current = false;
    setRenderReady(false);

    const term = new Terminal({
      allowProposedApi: true,
      // Hard-disabled everywhere (maestro main ef0dcbe) — not a setting.
      cursorBlink: false,
      cursorStyle: TERMINAL_CURSOR_STYLE,
      cursorInactiveStyle: TERMINAL_CURSOR_INACTIVE_STYLE,
      disableStdin: readOnlyRef.current,
      fontFamily: TERMINAL_FONT_STACK,
      fontSize: TERMINAL_FONT_SIZE,
      fontWeight: TERMINAL_FONT_WEIGHT,
      fontWeightBold: TERMINAL_FONT_WEIGHT_BOLD,
      lineHeight: TERMINAL_LINE_HEIGHT,
      letterSpacing: TERMINAL_LETTER_SPACING,
      theme: buildTerminalTheme(container),
      scrollback: TERMINAL_SCROLLBACK,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    patchXtermRenderServiceDimensions(term);
    termRef.current = term;
    fitRef.current = fit;

    const finishReplayHydration = (generation: number) => {
      if (generation !== hydrationGenerationRef.current || !hydratingRef.current) return;
      if (hydrationTimerRef.current !== null) {
        window.clearTimeout(hydrationTimerRef.current);
        hydrationTimerRef.current = null;
      }
      hydratingRef.current = false;
      hydrationRafRef.current = requestAnimationFrame(() => {
        hydrationRafRef.current = null;
        if (generation !== hydrationGenerationRef.current) return;
        if (!term.element) return;
        try {
          term.scrollToBottom();
          term.refresh(0, term.rows - 1);
        } catch {
          // Terminal may have been evicted after parsing the last replay byte.
        }
        term.element.style.removeProperty('visibility');
        setRenderReady(fittedRef.current);
        resizeRetryCountRef.current = 0;
        scheduleResizeRef.current();
        reconcileTerminalVisibility();
      });
    };
    const hydrateReplay = (data: string) => {
      if (!term.element) return;
      // Hide imperative xterm DOM until its async parser reaches the final
      // replay byte; otherwise a retained full-screen TUI visibly redraws
      // top-to-bottom.
      const generation = ++hydrationGenerationRef.current;
      awaitingReplayRef.current = false;
      hydratingRef.current = true;
      setRenderReady(false);
      term.element.style.visibility = 'hidden';
      // xterm's WriteBuffer uses a truthy `while (chunk = shift())` loop, so an
      // empty replay never invokes its callback. Complete it ourselves or the
      // terminal remains visibility:hidden forever.
      try {
        if (data.length > 0) {
          // A renderer/parser fault must degrade to a visible partial terminal,
          // never a permanent black box. The callback normally wins quickly.
          hydrationTimerRef.current = window.setTimeout(
            () => finishReplayHydration(generation),
            5000,
          );
        }
        writeTerminalReplay(term, data, () => finishReplayHydration(generation));
      } catch {
        finishReplayHydration(generation);
      }
    };

    const unregister = registerTerminal(sessionId, term, hydrateReplay);

    const sendResize = () => {
      const currentTerm = termRef.current;
      const currentFit = fitRef.current;
      if (!currentTerm || !currentFit || !currentTerm.element) return;
      // INACTIVE is a settled state, and the activation effect below re-arms
      // the fit when `active` flips. Returning without rescheduling is right.
      if (!activeRef.current) return;
      // UNPAINTABLE WHILE ACTIVE is a transient layout state — a surface switch
      // whose display:none is still committed on an ancestor, an in-flight
      // transition — and NOTHING else re-arms it. The container's own size does
      // not change when an ancestor's visibility does, so the ResizeObserver
      // never fires, and `active` is already true so the activation effect will
      // not run again either. This used to share the bare `return` above, which
      // stranded fittedRef and renderReady at false and left the loading cover
      // up permanently: the blank terminal that only a manual window resize
      // could heal. Retry on the same backoff every other guard here uses.
      if (!isElementPaintable(container)) {
        resizeRetryCountRef.current += 1;
        scheduleResize();
        return;
      }
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        resizeRetryCountRef.current += 1;
        scheduleResize();
        return;
      }
      if (!fontsReadyRef.current || !isXtermRendererReady(currentTerm)) {
        resizeRetryCountRef.current += 1;
        scheduleResize();
        return;
      }
      try {
        currentFit.fit();
      } catch {
        resizeRetryCountRef.current += 1;
        scheduleResize();
        return;
      }
      resizeRetryCountRef.current = 0;
      const { cols, rows } = currentTerm;
      if (cols <= 0 || rows <= 0) return;
      fittedRef.current = true;
      container.dataset.cols = String(cols);
      container.dataset.rows = String(rows);
      try {
        currentTerm.refresh(0, rows - 1);
      } catch {
        // A later activation/ResizeObserver pass will repaint.
      }
      if (
        attachedRef.current
        && !awaitingReplayRef.current
        && !hydratingRef.current
      ) {
        setRenderReady(true);
      }
      clientFittedSessions.add(sessionId);
      // ONE-SHOT REPAINT NUDGE (see ptyTransport.resize). The replay is on
      // screen and the grid is correctly fitted; now make the AGENT redraw over
      // it, because a full-screen TUI repaints only when something tells it to.
      // Decided BEFORE the no-op early-return below, because the case that
      // needs the nudge most is exactly the one that returns there: a remount
      // into unchanged window geometry, where the fitted size already equals
      // the PTY's and nothing would otherwise be sent at all.
      const forceRepaint =
        attachedRef.current
        && !awaitingReplayRef.current
        && !hydratingRef.current
        && !repaintForcedRef.current;
      // RECLAIM ON ACTIVATION (maestro 0539726): read the shared PTY's last-
      // known truth BEFORE this view overwrites it with its own just-fitted
      // size. A DIFFERENT hidden/inactive view may have shipped a resize
      // while this one sat idle at its old geometry — if so, this view's
      // freshly-fitted size must still ship even when it happens to match
      // ITS OWN stale `lastSizeRef`, or the shared PTY is stuck at the other
      // view's geometry while this one silently renders a mismatched grid.
      const ptyNow = serverPtySizes.get(sessionId);
      const ptyDiffers = !ptyNow || ptyNow.cols !== cols || ptyNow.rows !== rows;
      serverPtySizes.set(sessionId, { cols, rows });
      setLastFittedSize({ cols, rows });
      const last = lastSizeRef.current;
      if (last && last.cols === cols && last.rows === rows && !ptyDiffers && !forceRepaint) return;
      if (forceRepaint) repaintForcedRef.current = true;
      lastSizeRef.current = { cols, rows };
      onResizeRef.current?.(sessionId, { cols, rows });
      ptyTransport.resize(sessionId, cols, rows, forceRepaint);
    };

    const scheduleResize = () => {
      if (!activeRef.current) return;
      if (resizeRafRef.current !== null || resizeTimeoutRef.current !== null) return;
      const attempts = resizeRetryCountRef.current;
      if (attempts < 5) {
        resizeRafRef.current = requestAnimationFrame(() => {
          resizeRafRef.current = null;
          sendResize();
        });
        return;
      }
      const delay = Math.min(500, 16 * 2 ** Math.min(attempts - 5, 6));
      resizeTimeoutRef.current = window.setTimeout(() => {
        resizeTimeoutRef.current = null;
        sendResize();
      }, delay);
    };
    scheduleResizeRef.current = scheduleResize;

    const forceFontReflow = () => {
      if (!term.element) return;
      // Bump-then-restore forces xterm to re-measure its char cell after a
      // web font finishes loading — assigning the same value again is a
      // no-op to xterm's change detection.
      term.options.fontFamily = TERMINAL_FONT_STACK;
      term.options.fontSize = TERMINAL_FONT_SIZE + 1;
      term.options.fontSize = TERMINAL_FONT_SIZE;
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        // renderer not ready yet
      }
      fontsReadyRef.current = true;
      resizeRetryCountRef.current = 0;
      scheduleResize();
    };

    // COUNTER-SCALE RE-MEASURE (terminal.css's `.term-host { zoom: ... }`):
    // `zoom` changes the host's ambient scale synchronously at layout time,
    // but xterm's canvas font metrics do NOT recompute on their own when the
    // zoom an ancestor set changes — without an explicit reflow pass here,
    // FitAddon.fit() keeps dividing by a STALE cell size and cols/rows can
    // come out wrong even though the glyphs now paint at the correct
    // physical size. Independent of the document.fonts branch below (which
    // exists for a different reason — web-font load timing) because this
    // must still run in the `else` branch there, where fontsReadyRef is set
    // true without ever calling forceFontReflow. One rAF is enough: it runs
    // after the zoom CSS has been applied and the host has its final layout
    // box, and `sendResize`'s own readiness gate (`isXtermRendererReady`)
    // retries via `scheduleResize`'s backoff if the renderer genuinely isn't
    // up yet.
    requestAnimationFrame(forceFontReflow);

    let fontReflowTimers: number[] = [];
    if (document.fonts) {
      try {
        void document.fonts.load('13px "JetBrains Mono"');
        void document.fonts.load('600 13px "JetBrains Mono"');
      } catch {
        // Timed retries below still cover browsers with partial FontFaceSet.
      }
      void document.fonts.ready.then(forceFontReflow).catch(() => undefined);
      fontReflowTimers = [120, 360, 900].map((ms) => window.setTimeout(forceFontReflow, ms));
    } else {
      fontsReadyRef.current = true;
    }

    const initialSize = serverPtySizes.get(sessionId) ?? measureSpawnTerminalSize();
    if ((initialSize.cols ?? 0) > 0 && (initialSize.rows ?? 0) > 0) {
      try {
        term.resize(initialSize.cols!, initialSize.rows!);
      } catch {
        // A later FitAddon pass becomes authoritative.
      }
    }

    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && isTerminalBlurChord(event)) {
        // Intercepted here so ZERO bytes reach the PTY (R5-5) — the same
        // physical chord the exit-terminal chip's aria-label promises.
        term.blur();
        return false;
      }
      const shiftEnter =
        event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (shiftEnter) {
        if (event.type === 'keydown' && !readOnlyRef.current) {
          ptyTransport.write(sessionId, '\x1b[13;2u');
        }
        return false;
      }
      if (event.type !== 'keydown') return true;
      const copy =
        (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
        !event.altKey &&
        event.key.toLowerCase() === 'c';
      if (copy && term.hasSelection()) {
        void copyToClipboardOrWarn(term.getSelection(), 'Selection');
        return false;
      }
      return true;
    });

    const onData = term.onData((data) => {
      if (!readOnlyRef.current) ptyTransport.write(sessionId, data);
    });

    const handlePaste = (event: ClipboardEvent) => {
      if (readOnlyRef.current) return;
      const result = dispatchClipboardData(event.clipboardData, {
        onText: (text) => term.paste(text),
        onImages: () => notifyUser(IMAGE_PASTE_UNSUPPORTED, 'warn'),
      });
      if (result.handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const handleDragOver = (event: DragEvent) => {
      if (!readOnlyRef.current && dataTransferHasFiles(event.dataTransfer)) event.preventDefault();
    };
    const handleDrop = (event: DragEvent) => {
      if (readOnlyRef.current) return;
      const result = dispatchClipboardData(event.dataTransfer, {
        onText: (text) => term.paste(text),
        onImages: () => notifyUser(IMAGE_PASTE_UNSUPPORTED, 'warn'),
      });
      if (result.handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    container.addEventListener('paste', handlePaste, true);
    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('drop', handleDrop);

    const offSize = ptyTransport.onSize((id, size) => {
      if (id !== sessionId) return;
      serverPtySizes.set(id, { cols: size.cols, rows: size.rows });
      // Attach snapshots stop applying after this view fits; live peer
      // resizes always bypass that latch so passive views follow shared PTY
      // truth.
      if (!size.live && clientFittedSessions.has(id)) return;
      if (size.cols <= 0 || size.rows <= 0) return;
      try {
        term.resize(size.cols, size.rows);
        container.dataset.cols = String(size.cols);
        container.dataset.rows = String(size.rows);
      } catch {
        // renderer not ready; initial sizing/fitting will retry
      }
    });
    const offAttached = ptyTransport.onAttached((id, info) => {
      if (id !== sessionId) return;
      attachedRef.current = true;
      awaitingReplayRef.current = info.hasReplay;
      // A new attach means a newly rendered replay to redraw over, so the
      // one-shot nudge is owed again — including across a reconnect.
      repaintForcedRef.current = false;
      hydrationGenerationRef.current += 1;
      hydratingRef.current = false;
      if (hydrationTimerRef.current !== null) {
        window.clearTimeout(hydrationTimerRef.current);
        hydrationTimerRef.current = null;
      }
      if (hydrationRafRef.current !== null) {
        cancelAnimationFrame(hydrationRafRef.current);
        hydrationRafRef.current = null;
      }
      if (info.hasReplay) {
        // Keep the loading cover up until hydrateReplay's parser callback.
        setRenderReady(false);
        return;
      }
      // The authoritative attach says there is no history frame coming. An
      // empty but correctly fitted terminal is now the complete state.
      term.element?.style.removeProperty('visibility');
      setRenderReady(fittedRef.current);
      resizeRetryCountRef.current = 0;
      scheduleResizeRef.current();
    });
    const offExit = ptyTransport.onExit((id, exitCode) => {
      if (id !== sessionId) return;
      term.options.disableStdin = true;
      onExitRef.current?.(id, exitCode);
    });

    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(container);

    ptyTransport.openSession(sessionId, serverBaseUrl);
    scheduleResize();

    return () => {
      for (const timer of fontReflowTimers) window.clearTimeout(timer);
      resizeObserver.disconnect();
      container.removeEventListener('paste', handlePaste, true);
      container.removeEventListener('dragover', handleDragOver);
      container.removeEventListener('drop', handleDrop);
      if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current);
      if (resizeTimeoutRef.current !== null) window.clearTimeout(resizeTimeoutRef.current);
      if (hydrationTimerRef.current !== null) window.clearTimeout(hydrationTimerRef.current);
      if (hydrationRafRef.current !== null) cancelAnimationFrame(hydrationRafRef.current);
      hydrationGenerationRef.current += 1;
      attachedRef.current = false;
      fittedRef.current = false;
      awaitingReplayRef.current = false;
      repaintForcedRef.current = false;
      hydratingRef.current = false;
      scheduleResizeRef.current = () => undefined;
      offSize();
      offAttached();
      offExit();
      onData.dispose();
      unregister();
      // Eviction teardown is intentionally exhaustive: ptyTransport clears
      // its sockets/decoders/offsets/epochs/suspend/replay maps; unregister
      // clears the registry and write-scheduler/premount buffers. A remount
      // of the same sessionId starts openSession() fresh at offset 0 and the
      // server replays the full retained ring (requestFullReplay's contract).
      ptyTransport.closeSession(sessionId);
      clientFittedSessions.delete(sessionId);
      serverPtySizes.delete(sessionId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      resizeRafRef.current = null;
      resizeTimeoutRef.current = null;
      hydrationTimerRef.current = null;
      hydrationRafRef.current = null;
      resizeRetryCountRef.current = 0;
    };
  }, [sessionId, serverBaseUrl]);

  useEffect(() => {
    // Surface switches commit `display:none`/`display:flex` before effects run.
    // Reconcile the stream immediately, then wait two frames for nested flex
    // layout before doing the authoritative fit + refresh. ResizeObserver is a
    // safety net, not the activation signal: browsers may coalesce a
    // hidden-to-visible observation with an earlier zero-sized delivery.
    reconcileTerminalVisibility();
    if (!active) return;

    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    firstFrame = requestAnimationFrame(() => {
      firstFrame = null;
      secondFrame = requestAnimationFrame(() => {
        secondFrame = null;
        resizeRetryCountRef.current = 0;
        scheduleResizeRef.current();
        reconcileTerminalVisibility();
      });
    });
    return () => {
      if (firstFrame !== null) cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  }, [active, sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.disableStdin = !live;
  }, [live]);

  return (
    <TerminalHost
      hostRef={hostRef}
      ariaLabel="Live terminal"
      busy={!renderReady}
      placeholder={renderReady ? undefined : '▉ loading terminal\nrestoring session output…'}
    />
  );
});
