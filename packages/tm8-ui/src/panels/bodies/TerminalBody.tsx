import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { EntityDetail } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import { useShellKind } from '../../mobile';
import {
  ExitedFallback,
  LiveTerminal,
  NeedsYouBanner,
  StaleFallback,
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_KEY,
  TERMINAL_PLACEHOLDER,
  TerminalHost,
  TerminalModifierBar,
  UnverifiedFallback,
  isLiveTerminalEnabled,
  nearestFontSize,
  presentSession,
  presentationStyle,
  toSessionRow,
  type LiveTerminalHandle,
} from '../../terminal';

/**
 * THE TERMINAL ARCHETYPE BODY — the work_session Content tab (LLD §2.3, T0-2).
 *
 * Stack, top → bottom (user ruling 2026-08-19 — see the note above the render):
 *   ⚠ needs you banner                     (only when blocked on the user)
 *   terminal host  OR  an honest fallback
 *   modifier bar                           (phone only, below the canvas)
 *
 * That is the whole stack now. It used to carry ASSOCIATED PROJECTS · SHARED
 * CONTEXT, a reserved toolbar seam, a pixel-frozen chrome strip, a floating
 * SESSION DETAILS / exit-terminal overlay and the drawer they opened. All of
 * it is gone by ruling: the terminal is the thing, and everything else was
 * charging it height or overlaying its output.
 *
 * Live verdicts mount the real xterm/PTY transport. Recorded terminal states
 * keep the designed fallbacks, so stale/unknown/exited sessions never render a
 * black box that implies bytes can still arrive.
 *
 * THE CANVAS REGION IS THE ONLY THING THAT SWAPS — and now it is very nearly
 * the only thing there is, so a session ending cannot jump the layout under
 * the user's cursor at all.
 */

/**
 * The stored phone font size, clamped onto the offered ladder.
 *
 * Storage is user-writable and survives across builds, so a value from an
 * older ladder — or from a hand-edited key — must resolve to something
 * renderable rather than to an unusable terminal. Reading throws in Safari
 * private mode and some embedded webviews, which is exactly the population
 * this surface exists for, so a failure means "no preference" and never a
 * crash before the terminal can mount.
 */
function readStoredFontSize(): number {
  try {
    const raw = window.localStorage.getItem(TERMINAL_FONT_SIZE_KEY);
    return raw === null ? TERMINAL_FONT_SIZE : nearestFontSize(raw, TERMINAL_FONT_SIZE);
  } catch {
    return TERMINAL_FONT_SIZE;
  }
}

export interface TerminalBodyProps {
  detail: EntityDetail;
  /** Same-origin route prefix for the tm8 server that owns this session. */
  serverBaseUrl?: string;
  /** THE verdict — `seam.liveness.statusOf`. Never derived here. */
  liveness: SessionLiveness;
  /** Pool activity signal for this session. Gated on the verdict downstream. */
  streaming?: boolean;
  /** R8-dormant: blocked on the user. */
  needsAttention?: boolean;
  /** What the agent is waiting for, when it is. */
  attentionDetail?: string;
  /* GONE with the drawer (user ruling 2026-08-19): `handoffs`,
     `shareUnavailableReason`, `withdrawUnavailableReason`, `onOpenEntity` and
     `compact`. Every one of them fed only the chrome strip, the context header
     or the exit chip. Dropped from the interface rather than left accepted-
     and-ignored: a prop a component takes and does nothing with is a standing
     invitation to wire a feature into a dead end. */
  /** The registry's WORD for a degraded verdict (liveTreatment().label). */
  livenessLabel?: string;
  /** The registry's authored explanation for a degraded verdict. */
  livenessReason?: string;
  /** Selects the TRANSCRIPT surface. The overlay chip that used to call this
   *  is gone; the surface switcher in the panel bar is the way now, and
   *  `SessionFallback` still offers it on an exited session. */
  onOpenTranscript?: () => void;
  /** Resume this exited/failed session. Absent = the host has not wired it. */
  onResume?: () => void;
  resuming?: boolean;
  resumeDisabledReason?: string;
  /**
   * THE POST-MORTEM for an ended session, host-wired like `debugSurface`.
   *
   * It reads `execution.transcript` and this layer holds no seam — the panel is
   * presentational by construction — so it arrives already composed, from
   * `sessionStatsSurfaceFor()`. It reaches only the exited/failed canvas: a
   * running session's stats belong to the running session's own surfaces, and
   * mounting a transcript read beside a live PTY would poll a file that the
   * terminal is already showing you.
   */
  statsSurface?: ReactNode;
}

export function TerminalBody({
  detail,
  serverBaseUrl,
  liveness,
  streaming,
  needsAttention,
  attentionDetail,
  livenessLabel,
  livenessReason,
  onOpenTranscript,
  onResume,
  resuming,
  resumeDisabledReason,
  statsSurface,
}: TerminalBodyProps) {
  const row = toSessionRow(detail);
  const presentation = presentSession({
    liveness,
    recordedStatus: row.recordedStatus,
    streaming,
    needsAttention,
  });
  const style = presentationStyle(presentation);
  // Still held with nothing above it calling `blur()`: `LiveTerminal` needs the
  // handle, and the phone modifier bar drives the terminal through it. Only the
  // exit CHIP is gone, not the exit itself.
  const liveTerminalRef = useRef<LiveTerminalHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  /*
   * THE PHONE SURFACE — one fork, at the one place that can see the terminal.
   *
   * `useShellKind` and not a width media query: the shell decision is
   * `(pointer: coarse) && width < 500`, it is proved in `mobile/shell-for.ts`,
   * and a second rule here could disagree with the one that chose the shell
   * this body is rendering inside. A tablet at 768 is coarse-pointered and
   * still gets the desktop terminal, which is correct — it has a keyboard-sized
   * screen and, more to the point, it is not what the owner ruled on.
   *
   * The bar mounts INSIDE `.pn-terminal-body` rather than in the frame's
   * `notices` region deliberately. Notices is one 40px strip that the drop
   * notice and Lane 4's surfaces already contend for; a second permanent
   * occupant would fight them for it. The bar belongs to the terminal, lives
   * and dies with it, and needs the terminal's own ref — so it lives here.
   */
  const { shell } = useShellKind();
  const onPhone = shell === 'mobile';
  const [geometry, setGeometry] = useState<{ cols: number; rows: number } | null>(null);
  const [cellWidth, setCellWidth] = useState(0);
  const [hostWidth, setHostWidth] = useState(0);
  const [fontSize, setFontSize] = useState(() => readStoredFontSize());
  /*
   * THE ARM LIVES HERE, above both halves, because both halves change it and
   * neither owns it. The BAR arms it (a tap on `ctrl`); the TERMINAL spends it
   * (the next character from the system keyboard, seen only inside `onData`).
   * Keeping it in the bar meant the terminal had no way to clear it, and the
   * key would stay lit over a modifier that was already gone — a lie about
   * state on the one control whose entire value is that its state is visible.
   */
  const [ctrlArmed, setCtrlArmed] = useState(false);

  /* Persist per DEVICE, never per account — the size that is legible is a
     property of the screen you are holding and the eyes holding it, and a
     preference set on a phone must not follow you to a desktop. Same scope and
     same reasoning as `SHELL_OVERRIDE_KEY`. */
  const changeFontSize = useCallback((next: number) => {
    const clamped = nearestFontSize(next, TERMINAL_FONT_SIZE);
    setFontSize(clamped);
    try {
      window.localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(clamped));
    } catch {
      /* Storage refused (private mode, embedded webview). The choice still
         applies for this session, which beats refusing the user's request. */
    }
  }, []);

  /* The measured host width, for the "what one point smaller would buy"
     projection. Read after each fit rather than observed continuously: the only
     thing that moves it is a resize, and a resize is exactly what produces the
     geometry callback below. */
  const readTerminalMetrics = useCallback((size: { cols: number; rows: number }) => {
    setGeometry(size);
    const metrics = liveTerminalRef.current?.geometry();
    if (metrics) setCellWidth(metrics.cellWidth);
    const host = stageRef.current?.querySelector('.term-host');
    if (host instanceof HTMLElement) setHostWidth(host.getBoundingClientRect().width);
  }, []);

  /* USER RULING 2026-07-29 — "the terminal is the main thing of our app":
   * the canvas starts DIRECTLY under the tab strip and takes every pixel
   * down to the panel footer. The needs-you banner stays above the canvas: it
   * is conditional, rare, and its whole job is to interrupt. This supersedes
   * the top-stacked order the T0-2 canvas draws; the divergence is user-ruled
   * (D63).
   *
   * USER RULING 2026-08-19 (D63 taken to its end) — "remove the bottom panel
   * which opens up, the associated projects, shared context and all that
   * shit, the session details chip at the bottom, exit terminal button at the
   * bottom". This time it IS a deletion, not a move, and the honest record of
   * what went with it:
   *
   *   · the SESSION DETAILS toggle and the drawer it opened — chrome strip
   *     (persona · provider · state), ASSOCIATED PROJECTS, the launched-from
   *     provenance line, SHARED CONTEXT and the ShareDropTarget;
   *   · the exit chip. `⌃\`` still leaves a focused terminal — the keystroke
   *     is a keyboard-layer contract (C6 layer 3), not this button — but it
   *     is now UNDOCUMENTED ON SCREEN. That is a real loss and was raised
   *     with the user rather than absorbed silently;
   *   · the `transcript ↗` chip on exited sessions. No loss: it duplicated
   *     the TRANSCRIPT tab in the surface switcher, which is wired and
   *     visible.
   *
   * The drawer was `SharedContextSection`'s ONLY mount, so shared context and
   * drag-to-share are unreachable from the panel until someone re-homes them.
   * `SessionAnatomy` already exists, unmounted, holding a compact rendering of
   * exactly these facts — it is the obvious destination, and deliberately not
   * done here: the ruling was to remove them from the terminal's bottom, not
   * to redesign where they live.
   *
   * What is left is the ruling in one line: the canvas, and nothing else. */

  return (
    <div className="pn-terminal-body" data-testid="terminal-body">
      {needsAttention && style.isLive ? <NeedsYouBanner detail={attentionDetail} /> : null}

      <div className="pn-terminal-stage" data-testid="terminal-stage" ref={stageRef}>
        <SessionCanvas
          presentation={presentation}
          sessionId={detail.id}
          serverBaseUrl={serverBaseUrl}
          livenessLabel={livenessLabel}
          livenessReason={livenessReason}
          /* The record's own timestamps, straight through. `toSessionRow`
             already reads them structurally, so the exit facts arrive by the
             same route as the recorded status the presentation uses. */
          startedAt={row.startedAt}
          exitedAt={row.exitedAt}
          statsSurface={statsSurface}
          onOpenTranscript={onOpenTranscript}
          {...(onResume ? { onResume } : {})}
          {...(resuming ? { resuming } : {})}
          {...(resumeDisabledReason ? { resumeDisabledReason } : {})}
          liveTerminalRef={liveTerminalRef}
          {...(onPhone
            ? {
                fontSize,
                onGeometry: readTerminalMetrics,
                onCtrlSpent: () => setCtrlArmed(false),
              }
            : {})}
        />

      </div>

      {/*
        THE MODIFIER BAR — phone only, and OUTSIDE the stage.
        Outside because it must not overlay the canvas: a bar floating over the
        terminal covers the last two lines of output, which on a 390px screen is
        most of what you came to read. It is a sibling that takes its own height,
        so the terminal fits ABOVE it and the grid the agent is told about is the
        grid the user can actually see.
      */}
      {onPhone ? (
        <TerminalModifierBar
          terminal={liveTerminalRef}
          fontSize={fontSize}
          onFontSizeChange={changeFontSize}
          geometry={geometry}
          hostWidth={hostWidth}
          cellWidth={cellWidth}
          live={style.isLive}
          ctrlArmed={ctrlArmed}
          onCtrlArmedChange={setCtrlArmed}
        />
      ) : null}

    </div>
  );
}

/* SessionContextHeader and AssociatedProjects lived here and are DELETED
   (user ruling 2026-08-19 — see the stack note in TerminalBody). Between them
   they rendered the collapsed `<name> · ⬒<project> · nothing shared` summary,
   ASSOCIATED PROJECTS, the immutable launched-from provenance line, SHARED
   CONTEXT and the drag-share target. Every one of those was reachable only
   through the drawer that ruling removes, so keeping them would leave two
   components with no caller — the orphan half of the mistake
   chat-home-css-coverage.test.ts was written about, in TSX.

   `SharedContextSection` and `ShareDropTarget` are deliberately NOT deleted:
   both are exported from panels/index.ts, and `SessionAnatomy` already holds a
   compact rendering of the same facts with no mount of its own. That is where
   shared context goes if it is wanted back on this panel. */

/**
 * The canvas slot. Each verdict gets the rendering that states what we
 * actually know — never a spinner that cannot resolve, never a dark box
 * pretending a dead session might still print.
 */
function SessionCanvas({
  presentation,
  sessionId,
  serverBaseUrl,
  livenessLabel,
  livenessReason,
  startedAt,
  exitedAt,
  statsSurface,
  onOpenTranscript,
  onResume,
  resuming,
  resumeDisabledReason,
  liveTerminalRef,
  fontSize,
  onGeometry,
  onCtrlSpent,
}: {
  presentation: ReturnType<typeof presentSession>;
  sessionId: string;
  serverBaseUrl?: string;
  livenessLabel?: string;
  livenessReason?: string;
  startedAt?: string | null;
  exitedAt?: string | null;
  statsSurface?: ReactNode;
  onOpenTranscript?: () => void;
  onResume?: () => void;
  resuming?: boolean;
  resumeDisabledReason?: string;
  liveTerminalRef?: React.Ref<LiveTerminalHandle>;
  /** Phone only — the modifier bar's font control. Absent everywhere else, so
      the desktop terminal keeps `TERMINAL_FONT_SIZE` untouched. */
  fontSize?: number;
  /** Phone only — feeds the honest column readout. Named for what it reports
      rather than for the event, because a caller wiring `onResize` would
      reasonably expect it to be about the PANEL resizing. */
  onGeometry?: (size: { cols: number; rows: number }) => void;
  onCtrlSpent?: () => void;
}) {
  switch (presentation) {
    case 'streaming':
    case 'running':
    case 'needs-you':
      // Proven alive: mount the real byte stack. The only placeholder path is
      // the explicit operator/test opt-out in liveTerminalFlag.ts.
      return isLiveTerminalEnabled() ? (
        <LiveTerminal
          ref={liveTerminalRef}
          sessionId={sessionId}
          serverBaseUrl={serverBaseUrl}
          live
          {...(fontSize ? { fontSize } : {})}
          {...(onGeometry ? { onResize: (_id, size) => onGeometry(size) } : {})}
          {...(onCtrlSpent ? { onCtrlSpent } : {})}
        />
      ) : (
        <TerminalHost placeholder={TERMINAL_PLACEHOLDER} />
      );

    case 'stale':
      return <StaleFallback label={livenessLabel} reason={livenessReason} />;

    case 'unknown':
      return <UnverifiedFallback label={livenessLabel} reason={livenessReason} />;

    case 'spawning':
      return <TerminalHost placeholder={'▉ waiting for the session to start\nno PTY yet'} />;

    case 'failed':
    case 'exited':
    default:
      /* D3 CLOSED. Both statuses keep this one canvas — that was never the
         problem — but the canvas is now TOLD which ending it is drawing, so a
         failed session stops calling itself exited while the presentation two
         rows down correctly calls it failed. `presentation` is the authority
         here exactly as it is for every other arm of this switch; nothing
         re-derives the verdict from the record. */
      return (
        <ExitedFallback
          outcome={presentation === 'failed' ? 'failed' : 'exited'}
          startedAt={startedAt}
          exitedAt={exitedAt}
          {...(statsSurface ? { stats: statsSurface } : {})}
          onOpenTranscript={onOpenTranscript}
          {...(onResume ? { onResume } : {})}
          {...(resuming ? { resuming } : {})}
          {...(resumeDisabledReason ? { resumeDisabledReason } : {})}
        />
      );
  }
}

