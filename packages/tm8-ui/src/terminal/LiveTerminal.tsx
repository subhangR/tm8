import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { isTerminalBlurChord, isTerminalPasteChord } from '../keyboard/contract';
import { dataTransferHasFiles } from './clipboardImages.js';
import { dispatchClipboardData } from './clipboardPaste.js';
import { uploadClipboardImage } from './clipboardUpload.js';
import { copyToClipboardOrWarn } from './domUtils.js';
import { notifyUser } from './notifications.js';
import { ptyTransport } from './pty/ptyTransport.js';
import { mintPtyAttachGrant } from './pty/ptyGrant.js';
import { readActivePass } from '../auth/pass-store';
import { registerTerminal } from './pty/runtime.js';
import {
  clientFittedSessions,
  measureSpawnTerminalSize,
  serverPtySizes,
  setLastFittedSize,
} from './pty/terminalSize.js';
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

function describeUploadFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  /** Focus stdin as soon as this intentionally-interactive terminal mounts. */
  autoFocus?: boolean;
  onResize?: (sessionId: string, size: { cols: number; rows: number }) => void;
  onExit?: (sessionId: string, exitCode?: number | null) => void;
}

/**
 * THE LIVE TERMINAL — xterm mounted into the reserved TerminalHost box.
 *
 * Ported from packages/ui's SessionTerminal at the transport/render seam
 * only. Byte handling (ptyTransport, the write scheduler, the visibility
 * driver, the persistent per-session decoder, offset-resume law) is UNEDITED
 * — see `pty/`. What is adapted here is layout: this reuses tm8-ui's
 * TerminalHost (the T0-2 black box, with its 160px floor and a11y wiring)
 * instead of rendering its own div, and `cursorBlink` is hard-`false`
 * (maestro main ef0dcbe) rather than a user setting.
 */
export const LiveTerminal = forwardRef<LiveTerminalHandle, LiveTerminalProps>(function LiveTerminal(
  { sessionId, serverBaseUrl = '', live, autoFocus = false, onResize, onExit },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const resizeTimeoutRef = useRef<number | null>(null);
  const resizeRetryCountRef = useRef(0);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const fontsReadyRef = useRef(false);
  const readOnlyRef = useRef(!live);
  const onResizeRef = useRef(onResize);
  const onExitRef = useRef(onExit);

  readOnlyRef.current = !live;
  onResizeRef.current = onResize;
  onExitRef.current = onExit;

  useImperativeHandle(ref, () => ({
    blur: () => termRef.current?.blur(),
  }));

  useEffect(() => {
    const container = hostRef.current;
    if (!container || termRef.current) return;

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

    // xterm receives keyboard input through a hidden textarea. The credential
    // login panel is mounted in an already-focused Settings surface, so the
    // textarea otherwise starts unfocused and keystrokes disappear into the
    // page. This panel opts in explicitly; ordinary session terminals keep
    // their existing non-stealing mount behaviour.
    if (autoFocus && !readOnlyRef.current) term.focus();

    const finishReplayHydration = () => {
      requestAnimationFrame(() => {
        if (!term.element) return;
        try {
          term.scrollToBottom();
          term.refresh(0, term.rows - 1);
        } catch {
          // Terminal may have been evicted after parsing the last replay byte.
        }
        term.element.style.removeProperty('visibility');
      });
    };
    const hydrateReplay = (data: string) => {
      if (!term.element) return;
      // Hide imperative xterm DOM until its async parser reaches the final
      // replay byte; otherwise a retained full-screen TUI visibly redraws
      // top-to-bottom.
      term.element.style.visibility = 'hidden';
      try {
        term.write(data, finishReplayHydration);
      } catch {
        term.element.style.removeProperty('visibility');
      }
    };

    const unregister = registerTerminal(sessionId, term, hydrateReplay);

    const sendResize = () => {
      const currentTerm = termRef.current;
      const currentFit = fitRef.current;
      if (!currentTerm || !currentFit || !currentTerm.element) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      if (getComputedStyle(container).visibility === 'hidden') return;
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
      clientFittedSessions.add(sessionId);
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
      if (last && last.cols === cols && last.rows === rows && !ptyDiffers) return;
      lastSizeRef.current = { cols, rows };
      onResizeRef.current?.(sessionId, { cols, rows });
      ptyTransport.resize(sessionId, cols, rows);
    };

    const scheduleResize = () => {
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
      // Hand Ctrl+V / Cmd+V (and Ctrl+Shift+V) back to the browser: returning
      // false here returns from xterm's _keyDown BEFORE its preventDefault, so
      // the native paste fires and `handlePaste` below receives it. Without
      // this, xterm encodes Ctrl+V as 0x16 and cancels the event, and no paste
      // ever reaches the PTY. See isTerminalPasteChord for why we must not
      // read the clipboard ourselves (http:// is not a secure context).
      if (!readOnlyRef.current && isTerminalPasteChord(event)) return false;
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

    /**
     * Pasted images become PATHS in the prompt, never bytes.
     *
     * A trailing space and NEVER a carriage return: the agent must see the
     * path as one more word the human is still composing, so they can add
     * "what is wrong with this?" after it. Injecting a CR here would submit a
     * bare path as the entire message.
     *
     * Uploads run in parallel but inject in paste order — the array preserves
     * it — because two screenshots pasted together are usually "before" and
     * "after", and network timing must not reorder them.
     */
    const injectImages = async (files: readonly File[]) => {
      const results = await Promise.allSettled(
        files.map((file) => uploadClipboardImage(file, sessionId)),
      );
      if (readOnlyRef.current) return;

      const paths = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.path] : []));
      if (paths.length > 0) ptyTransport.write(sessionId, `${paths.join(' ')} `);

      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        const reason = describeUploadFailure((failures[0] as PromiseRejectedResult).reason);
        notifyUser(
          failures.length === 1
            ? `An image could not be pasted — ${reason}`
            : `${failures.length} images could not be pasted — ${reason}`,
          'warn',
        );
      }
    };

    const handlePaste = (event: ClipboardEvent) => {
      if (readOnlyRef.current) return;
      const result = dispatchClipboardData(event.clipboardData, {
        onText: (text) => term.paste(text),
        onImages: (files) => void injectImages(files),
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
        onImages: (files) => void injectImages(files),
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
      } catch {
        // renderer not ready; initial sizing/fitting will retry
      }
    });
    const offExit = ptyTransport.onExit((id, exitCode) => {
      if (id !== sessionId) return;
      term.options.disableStdin = true;
      onExitRef.current?.(id, exitCode);
    });

    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(container);

    // Mint a fresh one-shot capability for every connect/reconnect. The HTTP
    // mint may use the active pass while older browser sessions transition to
    // the Secure cookie; the WebSocket itself receives only the scoped grant.
    ptyTransport.openSession(
      sessionId,
      serverBaseUrl,
      () => readActivePass()?.token ?? null,
      (id) => mintPtyAttachGrant(id, serverBaseUrl, readOnlyRef.current ? 'view' : 'drive'),
      readOnlyRef.current ? 'view' : 'drive',
    );
    scheduleResize();

    return () => {
      for (const timer of fontReflowTimers) window.clearTimeout(timer);
      resizeObserver.disconnect();
      container.removeEventListener('paste', handlePaste, true);
      container.removeEventListener('dragover', handleDragOver);
      container.removeEventListener('drop', handleDrop);
      if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current);
      if (resizeTimeoutRef.current !== null) window.clearTimeout(resizeTimeoutRef.current);
      offSize();
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
      resizeRetryCountRef.current = 0;
    };
  }, [sessionId, serverBaseUrl, autoFocus]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.disableStdin = !live;
  }, [live]);

  return (
    <TerminalHost
      hostRef={hostRef}
      ariaLabel="Live terminal"
      onPointerDown={() => {
        // Reclaim the textarea even when a surrounding scroll/settings layer
        // was the browser's previous focus target.
        if (!readOnlyRef.current) termRef.current?.focus();
      }}
    />
  );
});
