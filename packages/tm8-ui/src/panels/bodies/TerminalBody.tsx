import { useCallback, useRef, useState } from 'react';
import type { EntityDetail, HandoffView } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import { Eyebrow } from '../../kit';
import { useShellKind } from '../../mobile';
import {
  ExitedFallback,
  LiveTerminal,
  NeedsYouBanner,
  ReservedToolbarSeam,
  StaleFallback,
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_KEY,
  TERMINAL_PLACEHOLDER,
  TerminalChromeStrip,
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
import { DisabledIconControl, toReason } from '../honesty/DisabledWithReason';
import { SharedContextSection } from '../share/SharedContextSection';
import { ShareDropTarget } from '../share/ShareDropTarget';

/**
 * THE TERMINAL ARCHETYPE BODY — the work_session Content tab (LLD §2.3, T0-2).
 *
 * Stack, top → bottom, exactly as the canvas draws it:
 *   ASSOCIATED PROJECTS · SHARED CONTEXT   (the Content body proper)
 *   reserved toolbar seam                  (RULING K — always present)
 *   chrome strip                           (pixel-frozen, RULING A)
 *   ⚠ needs you banner                     (only when blocked on the user)
 *   terminal host  OR  an honest fallback
 *
 * Live verdicts mount the real xterm/PTY transport. Recorded terminal states
 * keep the designed fallbacks, so stale/unknown/exited sessions never render a
 * black box that implies bytes can still arrive.
 *
 * THE CANVAS REGION IS THE ONLY THING THAT SWAPS. Header, seam, strip and
 * footer keep exact geometry across every verdict, so a session ending never
 * jumps the layout under the user's cursor.
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
  /** From the seam's `handoffs()` read. */
  handoffs?: readonly HandoffView[];
  /** §10.7 interim copy, injected so the reasons have one home. */
  shareUnavailableReason: string;
  withdrawUnavailableReason: string;
  /** The registry's WORD for a degraded verdict (liveTreatment().label). */
  livenessLabel?: string;
  /** The registry's authored explanation for a degraded verdict. */
  livenessReason?: string;
  /** True at the 320px floor — the exit chip label compacts. */
  compact?: boolean;
  onOpenEntity?: (id: string) => void;
  onOpenTranscript?: () => void;
  /** Resume this exited/failed session. Absent = the host has not wired it. */
  onResume?: () => void;
  resuming?: boolean;
  resumeDisabledReason?: string;
}

export function TerminalBody({
  detail,
  serverBaseUrl,
  liveness,
  streaming,
  needsAttention,
  attentionDetail,
  handoffs = [],
  shareUnavailableReason,
  withdrawUnavailableReason,
  livenessLabel,
  livenessReason,
  compact,
  onOpenEntity,
  onOpenTranscript,
  onResume,
  resuming,
  resumeDisabledReason,
}: TerminalBodyProps) {
  const row = toSessionRow(detail);
  const presentation = presentSession({
    liveness,
    recordedStatus: row.recordedStatus,
    streaming,
    needsAttention,
  });
  const style = presentationStyle(presentation);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [detailsDragging, setDetailsDragging] = useState(false);
  const detailsOpen = detailsExpanded || detailsDragging;
  const content = detail.content as unknown as Record<string, unknown>;
  const launchProjectId =
    typeof content.launchProjectId === 'string' ? content.launchProjectId : null;
  // Non-null while a live verdict has mounted LiveTerminal. Tests and an
  // explicit operator opt-out still use the placeholder, so the exit-focus
  // action remains safely optional.
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
   * down to the panel footer. The chrome strip and the context line move
   * BELOW the canvas — moved, not hidden (R7): every fact and control they
   * carried is still one glance down, and the drag-share target still
   * surfaces on dragover exactly as before. The needs-you banner stays above
   * the canvas: it is conditional, rare, and its whole job is to interrupt.
   * This supersedes the top-stacked order the T0-2 canvas draws; the
   * divergence is user-ruled (D63).
   *
   * USER RULING 2026-07-31 (D63 extended) — "remove the bottom strip …
   * terminal all the way, till the component bottom." The 28px drawer BAR is
   * gone as a permanent cost. Nothing it carried is gone WITH it, which is
   * what keeps this a move and not a deletion:
   *   · its toggle and the exit chip became a FLOATING overlay on the canvas
   *     itself — zero layout height, so the black box now reaches the panel's
   *     bottom edge exactly as ruled;
   *   · the drawer's content (chrome strip · projects · shared context) still
   *     opens from that toggle, and still auto-opens on dragover so
   *     drag-share never depended on expanding first;
   *   · the collapsed SUMMARY line ("<name> · ⬒<project> · nothing shared")
   *     is the one thing with no pixels left to live in. It moves onto the
   *     toggle's `title`/aria-label, so the facts are still one hover — and
   *     one screen-reader stop — away rather than silently dropped.
   *
   * THE OVERLAY IS HOVER/FOCUS-REVEALED, not always-on (see panels.css). It
   * may never be display:none or removed at a narrow width, though: the exit
   * chip is the only visible instruction for getting the keyboard back out of
   * a focused terminal (C6 layer 3), so it is opacity-hidden and keyboard-
   * reachable, and `:focus-within` brings it back the instant a tab lands on
   * it. */
  const summary = `${row.name} · ${launchProjectId ? `⬒ ${launchProjectId}` : 'no project'} · ${
    handoffs.length === 0 ? 'nothing shared' : `${handoffs.length} shared`
  }`;

  return (
    <div className="pn-terminal-body" data-testid="terminal-body">
      {needsAttention && style.isLive ? <NeedsYouBanner detail={attentionDetail} /> : null}

      <div
        className="pn-terminal-stage"
        data-testid="terminal-stage"
        ref={stageRef}
        onDragEnter={() => setDetailsDragging(true)}
        onDragOver={() => setDetailsDragging(true)}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDetailsDragging(false);
          }
        }}
        onDrop={() => setDetailsDragging(false)}
      >
        <SessionCanvas
          presentation={presentation}
          sessionId={detail.id}
          serverBaseUrl={serverBaseUrl}
          livenessLabel={livenessLabel}
          livenessReason={livenessReason}
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

        <div className="pn-terminal-overlay">
          <button
            type="button"
            className="pn-terminal-overlay__chip"
            data-testid="terminal-details-toggle"
            aria-expanded={detailsOpen}
            title={summary}
            aria-label={`Session details — ${summary}`}
            onClick={() => setDetailsExpanded((open) => !open)}
          >
            <span className="pn-terminal-drawer__caret" aria-hidden>
              {detailsOpen ? '▾' : '▸'}
            </span>
            <span className="pn-terminal-drawer__label">Session details</span>
          </button>

          {style.isLive ? (
            <button
              type="button"
              className="term-exit-chip"
              onClick={() => liveTerminalRef.current?.blur()}
              data-testid="exit-terminal-chip"
              aria-label="Exit terminal focus — press Control and backtick"
            >
              {compact ? 'exit ' : 'exit terminal '}
              <span className="term-exit-chip__key" aria-hidden>
                ⌃`
              </span>
            </button>
          ) : (
            <button
              type="button"
              className="term-exit-chip"
              onClick={onOpenTranscript}
              data-testid="transcript-chip"
            >
              transcript ↗
            </button>
          )}
        </div>
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

      {detailsOpen ? (
        <div
          className="pn-terminal-drawer pn-terminal-drawer--open"
          data-testid="terminal-bottom-drawer"
          data-expanded="true"
          onDragEnter={() => setDetailsDragging(true)}
          onDragOver={() => setDetailsDragging(true)}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDetailsDragging(false);
            }
          }}
          onDrop={() => setDetailsDragging(false)}
        >
          <div className="pn-terminal-drawer__content">
            <TerminalChromeStrip
              actor={row.actor}
              persona={row.name}
              provider={row.provider}
              presentation={presentation}
              statusDetail={livenessReason}
              compact={compact}
              onOpenTranscript={onOpenTranscript}
              onExitTerminal={() => liveTerminalRef.current?.blur()}
              showFocusControl={false}
            />

            <SessionContextHeader
              detail={detail}
              handoffs={handoffs}
              receiverName={row.name}
              shareUnavailableReason={shareUnavailableReason}
              withdrawUnavailableReason={withdrawUnavailableReason}
              onOpenEntity={onOpenEntity}
              forceOpen={detailsDragging}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * THE CONTEXT HEADER — R5 #10, user-ratified default.
 *
 * THE LAW, in the user's words: "an empty state that costs the primary surface
 * half its height inverts the honesty economy." Two always-open sections spent
 * roughly half this panel's height saying "no project recorded" and "nothing
 * shared" while the LIVE TERMINAL — the thing users stare at longest — was
 * squeezed into what remained. Honesty about an absence is cheap to state and
 * must be cheap to render; it may never outbid the primary surface for space.
 *
 * So: ONE compact line, expandable on demand, and the terminal takes every
 * pixel below the chrome strip. This matches composed T0-1's own default —
 * terminal dominates — so it is a ratified default, not a divergence.
 *
 * THE COLLAPSED LINE STILL CARRIES THE FACTS. It is a summary, not a hiding
 * place: the project (or its absence) and the share count are both stated, so
 * collapsing costs the viewer no information they had before — only the
 * vertical space that information was charging them.
 *
 * DROPPING MUST NOT REQUIRE EXPANDING FIRST. A drag entering this region
 * surfaces the drop target regardless of collapse; if it did not, drag-share
 * would be dead for every collapsed session, which is all of them by default.
 */
function SessionContextHeader({
  detail,
  handoffs,
  receiverName,
  shareUnavailableReason,
  withdrawUnavailableReason,
  onOpenEntity,
  forceOpen = false,
}: {
  detail: EntityDetail;
  handoffs: readonly HandoffView[];
  receiverName: string;
  shareUnavailableReason: string;
  withdrawUnavailableReason: string;
  onOpenEntity?: (id: string) => void;
  forceOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  /**
   * Raised by a drag ENTERING the region. Kept separate from `expanded` so
   * that releasing the drag returns the header to whatever the viewer chose,
   * rather than silently leaving it open behind them.
   */
  const [dragging, setDragging] = useState(false);

  // Structural read, not a kind comparison (§15.2): ask what the content HAS.
  const content = detail.content as unknown as Record<string, unknown>;
  const launchProjectId =
    typeof content.launchProjectId === 'string' ? content.launchProjectId : null;

  const open = expanded || dragging || forceOpen;

  return (
    <div
      className={open ? 'pn-ctxhead pn-ctxhead--open' : 'pn-ctxhead'}
      data-testid="session-context-header"
      data-expanded={open ? 'true' : 'false'}
      onDragEnter={() => setDragging(true)}
      onDragOver={() => setDragging(true)}
      onDragLeave={(e) => {
        // Only when the pointer leaves the REGION, not on every child boundary
        // crossed on the way in — otherwise the target flickers shut mid-drag.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={() => setDragging(false)}
    >
      <button
        type="button"
        className="pn-ctxhead__summary"
        aria-expanded={open}
        onClick={() => setExpanded((v) => !v)}
      >
        <span aria-hidden className="pn-ctxhead__caret">
          {open ? '▾' : '▸'}
        </span>
        <span className="pn-ctxhead__facts">
          {launchProjectId ? (
            <span className="pn-ctxhead__fact">{`⬒ ${launchProjectId}`}</span>
          ) : (
            <span className="pn-ctxhead__fact pn-ctxhead__fact--empty">no project recorded</span>
          )}
          <span aria-hidden className="pn-ctxhead__sep">
            ·
          </span>
          <span
            className={
              handoffs.length === 0
                ? 'pn-ctxhead__fact pn-ctxhead__fact--empty'
                : 'pn-ctxhead__fact'
            }
          >
            {handoffs.length === 0 ? 'nothing shared' : `⤓ ${handoffs.length} shared`}
          </span>
        </span>
      </button>

      {open ? (
        <div className="pn-ctxhead__detail">
          <AssociatedProjects detail={detail} onOpenEntity={onOpenEntity} />
          <SharedContextSection
            handoffs={handoffs}
            withdrawUnavailableReason={withdrawUnavailableReason}
            onOpenSource={onOpenEntity}
          />
          {/* Reserved so the surface switch costs no relayout. It has since
              landed in the panel bar; this seam still holds the height, and its
              occupant is the toolbar drop target (§8). */}
          <ReservedToolbarSeam>
            <ShareDropTarget
              receiverName={receiverName}
              unavailableReason={shareUnavailableReason}
              accept={false}
            />
          </ReservedToolbarSeam>
        </div>
      ) : null}
    </div>
  );
}

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
      return (
        <ExitedFallback
          onOpenTranscript={onOpenTranscript}
          {...(onResume ? { onResume } : {})}
          {...(resuming ? { resuming } : {})}
          {...(resumeDisabledReason ? { resumeDisabledReason } : {})}
        />
      );
  }
}

/**
 * ASSOCIATED PROJECTS — where this session may act.
 *
 * The LAUNCH project is IMMUTABLE PROVENANCE: it records where the session
 * was started and can never be edited, because rewriting it would falsify the
 * record of what an agent was allowed to touch. The canvas says so in the
 * caption ("launched from ⬒ … · immutable") and this renders it as a
 * non-editable fact rather than a removable chip.
 *
 * The `＋` add affordance is visible and disabled-with-reason: no seam
 * operation associates further projects with a running session, so offering a
 * working control would advertise something the facade cannot do (L6).
 */
function AssociatedProjects({
  detail,
  onOpenEntity,
}: {
  detail: EntityDetail;
  onOpenEntity?: (id: string) => void;
}) {
  // Structural read, not a kind comparison (§15.2): ask what the content HAS.
  const content = detail.content as unknown as Record<string, unknown>;
  const launchProjectId =
    typeof content.launchProjectId === 'string' ? content.launchProjectId : null;

  return (
    <section className="pn-section" data-testid="associated-projects-section">
      <Eyebrow faint>ASSOCIATED PROJECTS</Eyebrow>
      <div className="pn-chiprow">
        {launchProjectId ? (
          <button
            type="button"
            className="kit-chip"
            onClick={() => onOpenEntity?.(launchProjectId)}
            title={launchProjectId}
          >
            <span aria-hidden className="kit-chip__glyph">
              ⬒
            </span>
            {launchProjectId}
          </button>
        ) : (
          <span className="pn-section__empty">no project recorded for this session</span>
        )}
        <DisabledIconControl
          label="Associate another project"
          glyph="＋"
          reason={{
            cause: 'Can’t add a project to a running session',
            remedy: 'no facade operation associates projects after launch',
          }}
        />
      </div>
      {launchProjectId ? (
        <p className="pn-provenance">{`launched from ⬒ ${launchProjectId} · immutable`}</p>
      ) : null}
    </section>
  );
}
