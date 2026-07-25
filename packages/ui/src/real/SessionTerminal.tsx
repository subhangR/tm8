import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { isUnavailable } from './capabilities';
import { dispatchClipboardData } from './terminal/clipboardPaste.js';
import { dataTransferHasFiles } from './terminal/clipboardImages.js';
import { copyToClipboardOrWarn } from './terminal/domUtils.js';
import { notifyUser } from './terminal/notifications.js';
import { ptyTransport } from './terminal/ptyTransport.js';
import { registerTerminal } from './terminal/runtime.js';
import {
  clientFittedSessions,
  measureSpawnTerminalSize,
  serverPtySizes,
  setLastFittedSize,
} from './terminal/terminalSize.js';
import { useTerminalSettingsStore, buildITheme } from './terminal/useTerminalSettingsStore.js';
import { reconcileTerminalVisibility } from './terminal/visibilityDriver.js';

const MAESTRO_TERMINAL_BG_LIGHT = '#1B1812';
const MAESTRO_TERMINAL_BG_DARK = '#100E0A';
const IMAGE_PASTE_REASON =
  'Pasting images needs files.upload, which is not implemented on this node';

function currentTerminalBg(): string {
  return document.documentElement.dataset.theme === 'dark'
    ? MAESTRO_TERMINAL_BG_DARK
    : MAESTRO_TERMINAL_BG_LIGHT;
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
      | { _renderer?: { value?: { dimensions?: unknown }; _value?: { dimensions?: unknown } }; __tm8SafeDimensions?: boolean }
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

function isPanelResizing(): boolean {
  const classes = document.documentElement.classList;
  return classes.contains('maestro-sidebar-resizing') || classes.contains('right-panel-resizing');
}

export interface SessionTerminalProps {
  sessionId: string;
  live: boolean;
  active?: boolean;
  fill?: boolean;
  onResize?: (sessionId: string, size: { cols: number; rows: number }) => void;
}

/**
 * Maestro's xterm component adapted only at the transport seam.
 *
 * RENDERER POLICY: DOM only, exactly as Maestro's current working tree. The
 * workspace separately caps mounted xterms with a dialable LRU; never replace
 * that bound with "mount every session" because scrollback + DOM then grow for
 * the lifetime of the fleet. WebGL remains deliberately absent even though a
 * single terminal could use it: this keeps the port identical to current
 * Maestro and avoids a future multi-terminal GPU-context regression.
 */
export function SessionTerminal({
  sessionId,
  live,
  active = true,
  fill = false,
  onResize,
}: SessionTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const resizeTimeoutRef = useRef<number | null>(null);
  const resizeRetryCountRef = useRef(0);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const fontsReadyRef = useRef(false);
  const activeRef = useRef(active);
  const readOnlyRef = useRef(!live);
  const onResizeRef = useRef(onResize);
  const [ended, setEnded] = useState(!live);

  activeRef.current = active;
  readOnlyRef.current = !live;
  onResizeRef.current = onResize;

  useEffect(() => {
    setEnded(!live);
  }, [live, sessionId]);

  useEffect(() => {
    const container = hostRef.current;
    if (!container || termRef.current) return;

    const terminalSettings = useTerminalSettingsStore.getState();
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: activeRef.current && terminalSettings.cursorBlink,
      cursorStyle: terminalSettings.cursorStyle,
      cursorInactiveStyle: terminalSettings.cursorInactiveStyle,
      disableStdin: readOnlyRef.current,
      fontFamily: terminalSettings.fontStack,
      fontSize: terminalSettings.fontSize,
      fontWeight: terminalSettings.fontWeight,
      fontWeightBold: terminalSettings.fontWeightBold,
      lineHeight: terminalSettings.lineHeight,
      letterSpacing: terminalSettings.letterSpacing,
      theme: buildITheme(terminalSettings.colors, currentTerminalBg()),
      scrollback: terminalSettings.scrollback,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    patchXtermRenderServiceDimensions(term);
    termRef.current = term;
    fitRef.current = fit;

    const themeObserver = new MutationObserver(() => {
      const next = useTerminalSettingsStore.getState();
      term.options.theme = buildITheme(next.colors, currentTerminalBg());
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

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
      // Hide imperative xterm DOM until its async parser reaches the final replay
      // byte; otherwise a retained full-screen TUI visibly redraws top-to-bottom.
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
      // Computed-hidden mounts follow PTY truth and never stomp a visible peer.
      if (getComputedStyle(container).visibility === 'hidden') return;
      if (isPanelResizing()) return;
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
      serverPtySizes.set(sessionId, { cols, rows });
      setLastFittedSize({ cols, rows });
      container.dataset.cols = String(cols);
      container.dataset.rows = String(rows);
      const last = lastSizeRef.current;
      if (last && last.cols === cols && last.rows === rows) return;
      lastSizeRef.current = { cols, rows };
      onResizeRef.current?.(sessionId, { cols, rows });
      ptyTransport.resize(sessionId, cols, rows);
    };

    const scheduleResize = () => {
      if (isPanelResizing()) return;
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
      const next = useTerminalSettingsStore.getState();
      const fontSize = next.fontSize ?? term.options.fontSize ?? 13;
      term.options.fontFamily = next.fontStack;
      term.options.fontSize = fontSize + 1;
      term.options.fontSize = fontSize;
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        // renderer not ready yet
      }
      fontsReadyRef.current = true;
      resizeRetryCountRef.current = 0;
      scheduleResize();
    };

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
      const shiftEnter = event.key === 'Enter' && event.shiftKey &&
        !event.metaKey && !event.ctrlKey && !event.altKey;
      if (shiftEnter) {
        if (event.type === 'keydown' && !readOnlyRef.current) {
          ptyTransport.write(sessionId, '\x1b[13;2u');
        }
        return false;
      }
      if (event.type !== 'keydown') return true;
      const copy = (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
        !event.altKey && event.key.toLowerCase() === 'c';
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
        onImages: () => {
          // Keep the Maestro image branch explicit, but never invent a path: the
          // backing upload must create a real file on the agent's server.
          if (isUnavailable('uploadFile')) notifyUser(IMAGE_PASTE_REASON, 'warn');
        },
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
        onImages: () => {
          if (isUnavailable('uploadFile')) notifyUser(IMAGE_PASTE_REASON, 'warn');
        },
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
      // Attach snapshots stop applying after this view fits; live peer resizes
      // always bypass that latch so passive views follow shared PTY truth.
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
    const offExit = ptyTransport.onExit((id) => {
      if (id !== sessionId) return;
      setEnded(true);
      term.options.disableStdin = true;
    });

    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(container);
    const handlePanelResizeEnd = () => scheduleResize();
    window.addEventListener('maestro:panel-resize-end', handlePanelResizeEnd);

    ptyTransport.openSession(sessionId);
    scheduleResize();

    return () => {
      themeObserver.disconnect();
      for (const timer of fontReflowTimers) window.clearTimeout(timer);
      resizeObserver.disconnect();
      window.removeEventListener('maestro:panel-resize-end', handlePanelResizeEnd);
      container.removeEventListener('paste', handlePaste, true);
      container.removeEventListener('dragover', handleDragOver);
      container.removeEventListener('drop', handleDrop);
      if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current);
      if (resizeTimeoutRef.current !== null) window.clearTimeout(resizeTimeoutRef.current);
      offSize();
      offExit();
      onData.dispose();
      unregister();
      // Eviction teardown is intentionally exhaustive. ptyTransport clears its
      // sockets/decoders/offsets/epochs/suspend/replay maps; unregister clears
      // the registry and write-scheduler/premount buffers.
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
  }, [sessionId]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const container = hostRef.current;
    if (!term || !fit || !container) return;
    term.options.cursorBlink = active && useTerminalSettingsStore.getState().cursorBlink;
    if (!active) return;

    let cancelled = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!cancelled) reconcileTerminalVisibility();
    }));

    const reclaim = (attempts: number) => {
      if (cancelled || !term.element) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || !fontsReadyRef.current || !isXtermRendererReady(term)) {
        if (attempts > 0) requestAnimationFrame(() => reclaim(attempts - 1));
        return;
      }
      try {
        term.focus();
        fit.fit();
      } catch {
        if (attempts > 0) requestAnimationFrame(() => reclaim(attempts - 1));
        return;
      }
      const { cols, rows } = term;
      clientFittedSessions.add(sessionId);
      const ptyTruth = serverPtySizes.get(sessionId);
      const ptyDiffers = !ptyTruth || ptyTruth.cols !== cols || ptyTruth.rows !== rows;
      serverPtySizes.set(sessionId, { cols, rows });
      setLastFittedSize({ cols, rows });
      container.dataset.cols = String(cols);
      container.dataset.rows = String(rows);
      const last = lastSizeRef.current;
      if (!last || last.cols !== cols || last.rows !== rows || ptyDiffers) {
        lastSizeRef.current = { cols, rows };
        onResizeRef.current?.(sessionId, { cols, rows });
        ptyTransport.resize(sessionId, cols, rows);
      }
    };
    reclaim(8);
    return () => { cancelled = true; };
  }, [active, sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.disableStdin = ended || !live;
  }, [ended, live]);

  const settings = useTerminalSettingsStore();
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const container = hostRef.current;
    if (!term || !container) return;
    const needsReflow = term.options.fontFamily !== settings.fontStack ||
      term.options.fontSize !== settings.fontSize ||
      term.options.fontWeight !== settings.fontWeight ||
      term.options.fontWeightBold !== settings.fontWeightBold ||
      term.options.lineHeight !== settings.lineHeight ||
      term.options.letterSpacing !== settings.letterSpacing;
    term.options.fontFamily = settings.fontStack;
    term.options.fontSize = settings.fontSize;
    term.options.fontWeight = settings.fontWeight;
    term.options.fontWeightBold = settings.fontWeightBold;
    term.options.lineHeight = settings.lineHeight;
    term.options.letterSpacing = settings.letterSpacing;
    term.options.cursorStyle = settings.cursorStyle;
    term.options.cursorBlink = active && settings.cursorBlink;
    term.options.cursorInactiveStyle = settings.cursorInactiveStyle;
    term.options.scrollback = settings.scrollback;
    term.options.theme = buildITheme(settings.colors, currentTerminalBg());
    if (needsReflow && getComputedStyle(container).visibility !== 'hidden') {
      try {
        fit?.fit();
        term.refresh(0, term.rows - 1);
      } catch {
        // A ResizeObserver/activation retry will finish the reflow.
      }
      const { cols, rows } = term;
      if (cols > 0 && rows > 0) {
        lastSizeRef.current = { cols, rows };
        serverPtySizes.set(sessionId, { cols, rows });
        setLastFittedSize({ cols, rows });
        ptyTransport.resize(sessionId, cols, rows);
      }
    }
  }, [settings, active, sessionId]);

  return (
    <div
      ref={hostRef}
      className={`session-terminal${fill ? ' session-terminal--fill' : ''}`}
      data-session-id={sessionId}
      data-active={active || undefined}
      data-ended={ended || undefined}
      data-image-paste-disabled={isUnavailable('uploadFile') || undefined}
      title={isUnavailable('uploadFile') ? IMAGE_PASTE_REASON : undefined}
    />
  );
}
