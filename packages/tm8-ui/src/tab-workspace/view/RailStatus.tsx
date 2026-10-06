/**
 * Status and attention in Work (D31 audit gap G1; Design Advisor R39).
 *
 * Work hides the top bar (D4), which took the attention segment and the status
 * strip with it. They come back as the FIRST two buttons of the rail's bottom
 * group, reusing the top bar's own parts and data:
 *
 *   [Needs you] — a bell with the Personal count badge; the tooltip carries
 *                 both counts; a click opens the existing `AttentionList`
 *                 (mine) in a popover to the right of the rail.
 *   [Status]    — a run dot while any session runs; the tooltip carries the
 *                 readout; a click opens the existing `StatusStrip`, stacked.
 *                 In the expanded rail the row's label IS the readout.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../../data/seam';
import { AttentionList, useAttentionOptional } from '../../attention';
import { VIEW_ART } from '../../domain';
import { useAnchoredPopover } from '../../kit/anchoredPopover';
import { VectorIcon } from '../../kit/VectorIcon';
import { useDismissable } from '../../panels/useDismissable';
import { StatusStrip } from '../../status-strip/StatusStrip';
import { formatCount, formatPercent } from '../../status-strip/format';
import { useStatusStrip } from '../../status-strip/useStatusStrip';
import { useShellFrame } from './context';
import { RAIL_BELL_ART } from './railArt';

/** The popover's offset from the rail (R39). */
const POP_OFFSET_PX = 8;

interface RailPopoverButtonProps {
  label: string;
  /** Tooltip text; the rail's own tip is not used so the readout can change live. */
  tip: string;
  icon: ReactNode;
  /** Drawn at the icon's top right: the count badge or the run dot. */
  mark?: ReactNode;
  expanded: boolean;
  /** The expanded rail's label (defaults to `label`). */
  rowLabel?: ReactNode;
  testId: string;
  popoverLabel: string;
  children(close: () => void): ReactNode;
}

function RailPopoverButton({
  label,
  tip,
  icon,
  mark,
  expanded,
  rowLabel,
  testId,
  popoverLabel,
  children,
}: RailPopoverButtonProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);
  useDismissable(open, [button, pop], () => setOpen(false));
  /* To the right of the rail, bottom-aligned with the button, clamped to the
     viewport (a short window pushes it down, never past the top edge). */
  const style = useAnchoredPopover(
    open,
    () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return null;
      const rail = button.current?.closest('.tws-rail')?.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rail?.right ?? rect.right };
    },
    pop,
    { side: 'right', align: 'end', gap: POP_OFFSET_PX },
  );
  return (
    <div className="tws-tip-anchor tws-rail-pop-anchor">
      <button
        ref={button}
        type="button"
        className="tws-rail-btn"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={tip}
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tws-rail-icon">
          {icon}
          {mark}
        </span>
        {expanded ? <span className="tws-rail-label">{rowLabel ?? label}</span> : null}
      </button>
      {open ? (
        <div
          ref={pop}
          className="tws-rail-pop"
          role="dialog"
          aria-label={popoverLabel}
          style={style}
          data-testid={`${testId}-popover`}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

/** [Needs you]: the attention bell. Renders nothing without the attention provider. */
export function RailAttention({ expanded }: { expanded: boolean }) {
  const { gate } = useShellFrame();
  const api = useAttentionOptional();
  if (!api) return null;
  const counts = api.counts();
  const failed = api.status === 'error';
  const loading = api.status === 'loading';
  /* A failed read is not an all-clear: it says so, and never shows a 0. */
  const tip = failed
    ? 'Needs you · attention could not be loaded'
    : loading
      ? 'Needs you · loading'
      : `Needs you · ${counts.mine} personal · ${counts.all} team`;
  return (
    <RailPopoverButton
      label="Needs you"
      tip={tip}
      icon={<VectorIcon paths={RAIL_BELL_ART} size={18} />}
      mark={
        !failed && !loading && counts.mine > 0 ? (
          <span className="tws-rail-badge" data-testid="tws-rail-attention-count">
            {counts.mine > 99 ? '99+' : counts.mine}
          </span>
        ) : null
      }
      expanded={expanded}
      testId="tws-rail-attention"
      popoverLabel="Needs you"
    >
      {(close) => (
        <AttentionList
          filter="mine"
          title="Needs you"
          onOpen={(id: EntityId) => {
            close();
            /* The route opens it as a Work tab (the URL sync's history path). */
            gate.navigateView({ view: 'tabs', tab: id });
          }}
        />
      )}
    </RailPopoverButton>
  );
}

/** [Status]: CPU, live sessions and chats, behind one rail button. Nothing without a data seam. */
export function RailStatus({ expanded }: { expanded: boolean }) {
  const { gate } = useShellFrame();
  const seam = gate.data?.seam;
  return seam ? <RailStatusButton seam={seam} expanded={expanded} /> : null;
}

function RailStatusButton({ seam, expanded }: { seam: Seam; expanded: boolean }) {
  const { spaceId } = useShellFrame();
  const { host, hostAccess, liveness } = useStatusStrip(seam, spaceId as SpaceId);
  const cpu = hostAccess === 'granted' && host && host.cpu.percent !== null ? host.cpu.percent / 100 : null;
  const sessions = liveness?.liveSessionCount ?? null;
  const chats = liveness?.liveChatCount ?? null;
  const plural = (n: number | null, word: string) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;
  const readout = [cpu === null ? null : `CPU ${formatPercent(cpu)}`, plural(sessions, 'session'), plural(chats, 'chat')]
    .filter(Boolean)
    .join(' · ');
  return (
    <RailPopoverButton
      label="Status"
      tip={readout}
      icon={<VectorIcon paths={VIEW_ART.feed} size={18} />}
      mark={sessions && sessions > 0 ? <span className="tws-rail-run-dot" data-testid="tws-rail-status-running" /> : null}
      expanded={expanded}
      rowLabel={<span className="tws-rail-readout">{readout}</span>}
      testId="tws-rail-status"
      popoverLabel="System status"
    >
      {() => (
        <div className="tws-rail-status-strip">
          <StatusStrip seam={seam} spaceId={spaceId as SpaceId} placement="row" />
        </div>
      )}
    </RailPopoverButton>
  );
}
