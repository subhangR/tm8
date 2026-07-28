import type { EntityDetail, HandoffView } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import { Eyebrow } from '../../kit';
import {
  ExitedFallback,
  NeedsYouBanner,
  ReservedToolbarSeam,
  StaleFallback,
  TERMINAL_PLACEHOLDER,
  TerminalChromeStrip,
  TerminalHost,
  UnverifiedFallback,
  presentSession,
  presentationStyle,
  toSessionRow,
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
 * PHASE 1 SCOPE (R9). There is no PTY, no transport, no xterm — the byte
 * stack is a verbatim transplant that arrives at integration. This renders
 * the DESIGNED STATIC state: a reserved host box for a live verdict, and the
 * real designed fallbacks for every other verdict. Because the fallbacks are
 * where the honesty lives, they are the states that actually matter at the
 * gate, and they are complete.
 *
 * THE CANVAS REGION IS THE ONLY THING THAT SWAPS. Header, seam, strip and
 * footer keep exact geometry across every verdict, so a session ending never
 * jumps the layout under the user's cursor.
 */

export interface TerminalBodyProps {
  detail: EntityDetail;
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
}

export function TerminalBody({
  detail,
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
}: TerminalBodyProps) {
  const row = toSessionRow(detail);
  const presentation = presentSession({
    liveness,
    recordedStatus: row.recordedStatus,
    streaming,
    needsAttention,
  });
  const style = presentationStyle(presentation);

  return (
    <div className="pn-terminal-body" data-testid="terminal-body">
      <div className="pn-terminal-body__sections">
        <AssociatedProjects detail={detail} onOpenEntity={onOpenEntity} />
        <SharedContextSection
          handoffs={handoffs}
          withdrawUnavailableReason={withdrawUnavailableReason}
          onOpenSource={onOpenEntity}
        />
      </div>

      {/* Reserved now so the Phase-2 [ Terminal | Chat ] switch costs no
          relayout. Its Phase-1 occupant is the toolbar drop target (§8). */}
      <ReservedToolbarSeam>
        <ShareDropTarget
          receiverName={row.name}
          unavailableReason={shareUnavailableReason}
          accept={false}
        />
      </ReservedToolbarSeam>

      <TerminalChromeStrip
        persona={row.name}
        provider={row.provider}
        presentation={presentation}
        statusDetail={livenessReason}
        compact={compact}
        onOpenTranscript={onOpenTranscript}
      />

      {needsAttention && style.isLive ? <NeedsYouBanner detail={attentionDetail} /> : null}

      <SessionCanvas
        presentation={presentation}
        livenessLabel={livenessLabel}
        livenessReason={livenessReason}
        onOpenTranscript={onOpenTranscript}
      />
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
  livenessLabel,
  livenessReason,
  onOpenTranscript,
}: {
  presentation: ReturnType<typeof presentSession>;
  livenessLabel?: string;
  livenessReason?: string;
  onOpenTranscript?: () => void;
}) {
  switch (presentation) {
    case 'streaming':
    case 'running':
    case 'needs-you':
      // Proven alive: reserve the black box. Phase 1 has no bytes to put in
      // it, and the placeholder says exactly that rather than faking output.
      return <TerminalHost placeholder={TERMINAL_PLACEHOLDER} />;

    case 'stale':
      return <StaleFallback label={livenessLabel} reason={livenessReason} />;

    case 'unknown':
      return <UnverifiedFallback label={livenessLabel} reason={livenessReason} />;

    case 'spawning':
      return <TerminalHost placeholder={'▉ waiting for the session to start\nno PTY yet'} />;

    case 'failed':
    case 'exited':
    default:
      return <ExitedFallback onOpenTranscript={onOpenTranscript} />;
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
