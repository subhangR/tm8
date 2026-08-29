import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { isTerminalBlurChord, isTerminalPasteChord } from '../keyboard/contract';
import { ctrlByte } from './mobileKeys.js';
import { dataTransferHasFiles } from '../rich-input/clipboardFiles';
import { dispatchClipboardData } from './clipboardPaste.js';
import { uploadClipboardFile } from './clipboardUpload.js';
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

/**
 * xterm's OWN measured cell width in CSS px, or 0 before the renderer is up.
 *
 * Reads the same private render-service path `isXtermRendererReady` gates on,
 * because xterm exposes no public accessor for it and the alternative — the
 * `fontSize * 0.6` estimate `pty/terminalSize.ts` uses — is wrong by enough at
 * phone widths to move the reported column count by several columns. A readout
 * that exists to be honest about width cannot be built on a guess about width.
 */
function measuredCellWidth(term: Terminal): number {
  try {
    const core = (term as unknown as { _core?: unknown })._core as
      | { _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } } }
      | undefined;
    return core?._renderService?.dimensions?.css?.cell?.width ?? 0;
  } catch {
    return 0;
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
  /**
   * Put the caret back in the PTY. The phone's modifier bar needs this: tapping
   * a bar button moves focus out of xterm's hidden textarea, and without an
   * explicit return the soft keyboard dismisses after every single Esc.
   */
  focus(): void;
  /**
   * Write bytes as though they had been typed. The modifier bar's whole output
   * channel — it produces sequences no soft keyboard can (see `mobileKeys.ts`)
   * and hands them here rather than synthesising KeyboardEvents, which xterm
   * would re-encode and which cannot express DECCKM-dependent arrows at all.
   *
   * Refuses while read-only, for the same reason `onData` does: a view-only
   * attachment must not become writable through a second door.
   */
  send(data: string): void;
  /**
   * Arm (or disarm) the sticky Ctrl. The NEXT single character xterm reports —
   * from the soft keyboard, which is the only source of printables here — is
   * converted to its control byte and the arm is spent. See `ctrlByte`.
   */
  armCtrl(armed: boolean): void;
  /**
   * Is DECCKM on? Decides whether an arrow is `ESC [ A` or `ESC O A`, which is
   * the difference between the arrow working and the letters `OA` appearing in
   * the buffer. Asked per press, never cached: a TUI can set and clear it at
   * any moment.
   */
  applicationCursorKeys(): boolean;
  /**
   * The grid as it actually is, plus the MEASURED cell width the column count
   * was derived from. `cellWidth` is xterm's own metric rather than the
   * `fontSize * 0.6` estimate in `pty/terminalSize.ts`, because at phone widths
   * that estimate is wrong by several columns and several columns is the whole
   * subject of the readout this feeds.
   */
  geometry(): { cols: number; rows: number; cellWidth: number } | null;
}

export interface LiveTerminalProps {
  sessionId: string;
  /** Same-origin route prefix for the selected tm8 server. Empty means local. */
  serverBaseUrl?: string;
  /** False renders the terminal read-only (stdin disabled). */
  live: boolean;
  /** Focus stdin as soon as this intentionally-interactive terminal mounts. */
  autoFocus?: boolean;
  /**
   * Render size in px. Omitted everywhere but the phone, which is the only
   * surface where the shared 13px is a real cost: at 390px it buys roughly
   * forty columns, and dropping two points buys ten more. Changing it refits
   * and therefore RESIZES THE PTY — the agent is told the new geometry, which
   * is the point, not a side effect.
   */
  fontSize?: number;
  onResize?: (sessionId: string, size: { cols: number; rows: number }) => void;
  onExit?: (sessionId: string, exitCode?: number | null) => void;
  /**
   * The sticky Ctrl was consumed by a keystroke. The modifier bar lights its
   * Ctrl key while armed, and only this seam knows when the arm is spent — the
   * character that spends it comes from the system keyboard, which the bar
   * never sees. Without it the key would stay lit over a modifier that is
   * already gone, which is a lie about state on the one control whose entire
   * value is that you can see whether it is on.
   */
  onCtrlSpent?: () => void;
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
  { sessionId, serverBaseUrl = '', live, autoFocus = false, fontSize, onResize, onExit, onCtrlSpent },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const resizeTimeoutRef = useRef<number | null>(null);
  const resizeRetryCountRef = useRef(0);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  /**
   * One-shot: has this view already asked the agent to repaint?
   *
   * Scoped to the MOUNT, not to the attach, and that is a known narrowing. It
   * is not re-armed after a reconnect or a visibility-driver resume, so on
   * those paths the client asks for nothing and the terminal depends wholly on
   * replay fidelity again — the server would grant a fresh budget on the new
   * socket, the client simply never spends it. Acceptable because the PTY now
   * boots at the real geometry, so the replay ring holds correctly-sized frames
   * and replay IS enough; note that this rests on the spawn-geometry fix, not
   * on the nudge. Re-arming per REPLAY instead was the obvious alternative and
   * is worse: hydration runs on every reconnect and every resume, which made a
   * flapping socket a repaint storm.
   *
   * If a blank-on-reconnect report ever appears, this is the line. The seam
   * that would fix it properly is a per-attach signal — `ptyTransport.onAttached`,
   * which this version of the transport does not expose.
   */
  const repaintForcedRef = useRef(false);
  const fontsReadyRef = useRef(false);
  const readOnlyRef = useRef(!live);
  const onResizeRef = useRef(onResize);
  const onExitRef = useRef(onExit);
  const onCtrlSpentRef = useRef(onCtrlSpent);
  /**
   * THE STICKY-CTRL LATCH.
   *
   * A ref and not state, deliberately: it is read inside `onData`, which is
   * registered once for the life of the mount and closes over whatever it can
   * see at registration time. State here would leave that handler reading the
   * first render's `false` forever — the arm would light up in the UI and do
   * nothing to the bytes, which is the worst of both outcomes.
   */
  const pendingCtrlRef = useRef(false);
  /** Assigned by the mount effect so the font-size effect can force a refit.
      The effect owns the retry/backoff machinery; nothing outside it may
      re-implement that, so it publishes the entry point instead. */
  const scheduleResizeRef = useRef<(() => void) | null>(null);
  /** The live render size, readable from inside the mount effect without making
      that effect depend on the prop. See the `fontSize` option below. */
  const fontSizeRef = useRef(fontSize ?? TERMINAL_FONT_SIZE);
  fontSizeRef.current = fontSize ?? TERMINAL_FONT_SIZE;

  readOnlyRef.current = !live;
  onResizeRef.current = onResize;
  onExitRef.current = onExit;
  onCtrlSpentRef.current = onCtrlSpent;

  useImperativeHandle(ref, () => ({
    blur: () => termRef.current?.blur(),
    focus: () => {
      if (!readOnlyRef.current) termRef.current?.focus();
    },
    send: (data: string) => {
      if (readOnlyRef.current) return;
      ptyTransport.write(sessionId, data);
    },
    armCtrl: (armed: boolean) => {
      pendingCtrlRef.current = armed;
    },
    applicationCursorKeys: () => {
      /* `modes` is public API in xterm 5+, but it is read defensively because a
         disposed terminal is reachable here — the bar can outlive a session
         that just exited. Normal mode is the safe wrong answer: `ESC [ A` at
         worst does nothing, whereas `ESC O A` sent to a shell that is NOT in
         application mode prints the literal characters into the command line. */
      try {
        return termRef.current?.modes.applicationCursorKeysMode ?? false;
      } catch {
        return false;
      }
    },
    geometry: () => {
      const term = termRef.current;
      if (!term) return null;
      return { cols: term.cols, rows: term.rows, cellWidth: measuredCellWidth(term) };
    },
  }));

  useEffect(() => {
    const container = hostRef.current;
    if (!container || termRef.current) return;
    // The ref outlives a sessionId change; a new terminal is owed its own nudge.
    repaintForcedRef.current = false;

    const term = new Terminal({
      allowProposedApi: true,
      // Hard-disabled everywhere (maestro main ef0dcbe) — not a setting.
      cursorBlink: false,
      cursorStyle: TERMINAL_CURSOR_STYLE,
      cursorInactiveStyle: TERMINAL_CURSOR_INACTIVE_STYLE,
      disableStdin: readOnlyRef.current,
      fontFamily: TERMINAL_FONT_STACK,
      /* `fontSizeRef` and not the `fontSize` prop: this effect does not depend
         on it (a size change must refit, never remount and lose the session's
         scrollback), so reading the prop here would pin the mount to whatever
         the first render happened to carry. */
      fontSize: fontSizeRef.current,
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
        // Deliberately does NOT re-arm the repaint nudge. It used to, which
        // meant a normal attach forced TWICE — once from the mount's
        // scheduleResize and again here — and, because this runs on every
        // reconnect and every visibility-driver resume, a flapping socket
        // became a repaint storm. One nudge per mount is enough: the agent's
        // repaint bytes are live output, so the server's ordering invariant
        // sequences them AFTER the replay no matter which lands first.
        resizeRetryCountRef.current = 0;
        scheduleResize();
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
      // THESE TWO GUARDS ARE NOT SYMMETRIC, and treating them as if they were
      // is a regression. Both return early, but only one of them is stranded.
      //
      // A zero rect means an ancestor is `display:none` (panels.css hides
      // inactive work-session surfaces that way). Going hidden and coming back
      // CHANGES the box — 0x0 then 600x400 — so the ResizeObserver fires on
      // both edges and re-arms the fit on its own, in ~12ms. Retrying here
      // would be worse than useless: a display:none host is 0x0 for as long as
      // it is hidden, so the retry can never succeed, and because
      // scheduleResize refuses to queue while a timer is pending, the pending
      // retry SWALLOWS the ResizeObserver's fire on reveal and turns a 12ms
      // refit into a ~500ms one. Measured. Leave it alone.
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // `visibility:hidden` is the stranded one (shell.css hides the non-board
      // side panel that way). The box keeps its full size the whole time, so
      // the ResizeObserver fires on NEITHER edge and there is no backstop at
      // all — this is where the fit was silently dropped and the terminal
      // stayed on xterm's 80x24 until a human dragged the window. Retry on the
      // same backoff every other guard here uses; it self-cancels the moment
      // the surface is shown and the fit succeeds.
      if (getComputedStyle(container).visibility === 'hidden') {
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
      const { cols, rows } = currentTerm;
      // fit() can succeed without having resized anything — FitAddon's
      // proposeDimensions bails on a degenerate box and fit() then returns
      // silently — so a container smaller than one cell lands here.
      //
      // THE RETRY-COUNT RESET MUST STAY BELOW THIS GUARD. Above it, every pass
      // through would zero the counter and then bump it to 1, `attempts < 5`
      // would hold forever, and this would be an unbounded rAF loop at refresh
      // rate running a full fit() measure each frame — not the bounded backoff
      // the comment claims. The other retry branches sit before the reset and
      // accumulate correctly; this one has to be sequenced deliberately.
      if (cols <= 0 || rows <= 0) {
        resizeRetryCountRef.current += 1;
        scheduleResize();
        return;
      }
      resizeRetryCountRef.current = 0;
      clientFittedSessions.add(sessionId);
      // ONE-SHOT REPAINT NUDGE (see ptyTransport.resize). The grid is now
      // correctly fitted and any replay has been parsed; make the AGENT redraw
      // over it, because a full-screen TUI repaints only when something tells
      // it to. Decided BEFORE the no-op early-return below, because the case
      // that needs the nudge most is exactly the one that returns there: a
      // remount into unchanged window geometry, where the fitted size already
      // equals the PTY's and nothing would otherwise be sent at all.
      const forceRepaint = !repaintForcedRef.current;
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
      term.options.fontSize = fontSizeRef.current + 1;
      term.options.fontSize = fontSizeRef.current;
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
      if (readOnlyRef.current) return;
      /*
       * THE STICKY CTRL IS SPENT HERE, at the one place every keystroke passes
       * through, rather than in the bar.
       *
       * The bar cannot do it itself: the character it is modifying comes from
       * the SYSTEM keyboard, which the bar neither renders nor receives events
       * from. This is the only seam that sees both.
       *
       * `ctrlByte` returning null means the modifier does not apply to what was
       * typed — a digit, an emoji, a paste. The arm is spent ANYWAY and the
       * input is forwarded unchanged. Keeping it armed would silently apply
       * Ctrl to whatever the user typed NEXT, which is how a stray Ctrl+C ends
       * up killing an agent mid-run; and swallowing the character would make
       * the bar eat keystrokes. Spend it and pass the byte through.
       */
      if (pendingCtrlRef.current) {
        pendingCtrlRef.current = false;
        onCtrlSpentRef.current?.();
        const control = ctrlByte(data);
        ptyTransport.write(sessionId, control ?? data);
        return;
      }
      ptyTransport.write(sessionId, data);
    });

    /**
     * Pasted files become PATHS in the prompt, never bytes.
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
    const injectFiles = async (files: readonly File[]) => {
      const results = await Promise.allSettled(
        files.map((file) => uploadClipboardFile(file, sessionId)),
      );
      if (readOnlyRef.current) return;

      const paths = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.path] : []));
      if (paths.length > 0) ptyTransport.write(sessionId, `${paths.join(' ')} `);

      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        const reason = describeUploadFailure((failures[0] as PromiseRejectedResult).reason);
        notifyUser(
          failures.length === 1
            ? `A file could not be pasted — ${reason}`
            : `${failures.length} files could not be pasted — ${reason}`,
          'warn',
        );
      }
    };

    const handlePaste = (event: ClipboardEvent) => {
      if (readOnlyRef.current) return;
      const result = dispatchClipboardData(event.clipboardData, {
        onText: (text) => term.paste(text),
        onFiles: (files) => void injectFiles(files),
        /* STATED, never silent (R2): a refused paste that did nothing at all
           reads as a broken terminal. The names are the user's own, so they
           can see which of several files was the one nothing can read. */
        onRefused: (files) => notifyUser(
          `${files.map((file) => file.name || 'unnamed file').join(', ')} — not pasted; agents cannot read ${files.length === 1 ? 'this file type' : 'these file types'}.`,
          'warn',
        ),
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
        onFiles: (files) => void injectFiles(files),
        /* STATED, never silent (R2): a refused paste that did nothing at all
           reads as a broken terminal. The names are the user's own, so they
           can see which of several files was the one nothing can read. */
        onRefused: (files) => notifyUser(
          `${files.map((file) => file.name || 'unnamed file').join(', ')} — not pasted; agents cannot read ${files.length === 1 ? 'this file type' : 'these file types'}.`,
          'warn',
        ),
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
      scheduleResizeRef.current = null;
      /* An arm that survives a remount would apply Ctrl to the first character
         typed into the NEXT session — the bar would be dark and the byte would
         still be modified. */
      pendingCtrlRef.current = false;
    };
  }, [sessionId, serverBaseUrl, autoFocus]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.disableStdin = !live;
  }, [live]);

  /**
   * FONT SIZE, AS A REFIT AND NOT A REMOUNT.
   *
   * Its own effect, and NOT a dependency of the mount effect above, because a
   * remount tears down the socket and disposes the terminal: changing the font
   * would drop the attachment, replay the ring and lose the caret — a visible
   * flash and a round trip, every time a user taps A+.
   *
   * The refit that follows RESIZES THE PTY. That is intended and is the whole
   * point of the control: shrinking the font buys columns, and columns are only
   * real once the agent on the other end has been told about them. It goes
   * through `scheduleResize` rather than calling `fit()` directly so it inherits
   * the readiness gate and the backoff — xterm's cell metrics do not recompute
   * synchronously when `fontSize` is assigned, so an immediate fit divides by
   * the OLD cell and lands on a wrong grid.
   */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const next = fontSize ?? TERMINAL_FONT_SIZE;
    if (term.options.fontSize === next) return;
    term.options.fontSize = next;
    /* One rAF: the option has been assigned, the renderer re-measures on its
       next frame, and `sendResize`'s own readiness gate retries if it has not.
       Same reasoning as the counter-scale re-measure in the mount effect. */
    requestAnimationFrame(() => scheduleResizeRef.current?.());
  }, [fontSize]);

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
