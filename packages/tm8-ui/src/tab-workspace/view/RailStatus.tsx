/**
 * Status and attention in Work (D31 audit gap G1; Design Advisor R39).
 *
 * Work hides the top bar (D4), which took the attention segment and the status
 * strip with it. They come back in the rail's bottom group, reusing the top
 * bar's own parts and data (task 01a122ea-b5d9 folded Status into [You]):
 *
 *   [Needs you] — a bell with the Personal count badge; the tooltip carries
 *                 both counts; a click opens the existing `AttentionList`
 *                 (mine) in a popover to the right of the rail.
 *   [You]       — the viewer's avatar; a click opens one card: the existing
 *                 `StatusStrip`, stacked, above the account menu.
 */
import { cloneElement, isValidElement, useCallback, useRef, useState, type ReactNode } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../../data/seam';
import { AttentionList, useAttentionOptional } from '../../attention';
import { useAnchoredPopover } from '../../kit/anchoredPopover';
import { Avatar } from '../../kit/Avatar';
import { VectorIcon } from '../../kit/VectorIcon';
import { useDismissable } from '../../panels/useDismissable';
import { StatusStrip } from '../../status-strip/StatusStrip';
import { useShellFrame } from './context';
import { RAIL_BELL_ART, RAIL_USER_ART } from './railArt';

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
  /** Styles one popover apart (`data-pop`), e.g. the account card's own padding. */
  variant?: string;
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
  variant,
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
          data-pop={variant}
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
      icon={
        /* The attention yellow (--pn-wait) disc, as every attention surface draws it. */
        <span className="tws-rail-disc" data-disc="attention">
          <VectorIcon paths={RAIL_BELL_ART} size={16} />
        </span>
      }
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

/**
 * [You]: the viewer's avatar (Subhang, 2026-10-10). A click opens ONE card
 * beside the rail: the system status on top, then the account menu inline.
 * It replaced the avatar switch that swapped the rail to a tools face. The
 * menu used to sit inside that face's scrolling column, absolutely placed
 * below a 56px-wide trigger, which clipped it out of sight.
 *
 * With no account (a node without sign-in) the card still opens: status,
 * then the viewer's name and a Settings row.
 */
export function RailUser({ expanded }: { expanded: boolean }) {
  const { gate, spaceId } = useShellFrame();
  const viewer = gate.data?.viewerActor ?? null;
  const seam = gate.data?.seam;
  const name = viewer?.displayName ?? 'You';
  const settings = gate.shellTabs.find((tab) => tab.id === 'settings');
  return (
    <RailPopoverButton
      label={`Account: ${name}`}
      tip={name}
      icon={
        <span className="tws-rail-disc" data-disc="user">
          {viewer ? (
            <Avatar
              actorId={viewer.id}
              provenance={viewer.isAgent ? 'agent' : 'human'}
              label={name}
              size={32}
              src={viewer.avatar ?? null}
            />
          ) : (
            <VectorIcon paths={RAIL_USER_ART} size={16} />
          )}
        </span>
      }
      expanded={expanded}
      rowLabel={name}
      testId="tws-rail-user"
      popoverLabel="Account"
      variant="user"
    >
      {(close) => (
        <>
          {seam ? (
            <div className="tws-rail-user-status tws-rail-status-strip" aria-label="System status">
              <StatusStrip seam={seam} spaceId={spaceId as SpaceId} placement="row" />
            </div>
          ) : null}
          {isValidElement<{ inline?: boolean; onClose?: () => void }>(gate.accountSlot) ? (
            cloneElement(gate.accountSlot, { inline: true, onClose: close })
          ) : (
            <div className="tws-rail-user-fallback">
              <div className="tws-rail-user-name">{name}</div>
              {settings ? (
                <button
                  type="button"
                  className="tws-menu-row"
                  onClick={() => {
                    close();
                    gate.onSelectViewTab(settings.id);
                  }}
                >
                  {settings.label}
                </button>
              ) : null}
            </div>
          )}
        </>
      )}
    </RailPopoverButton>
  );
}
