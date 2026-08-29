import { useId, type ReactNode } from 'react';
import { useReasonDisclosure } from './useReasonDisclosure';
import { toReason, type UnavailableReason } from './DisabledWithReason';

/**
 * A `title=` THAT A FINGER CAN READ.
 *
 * `title` renders as a tooltip on hover and in NO other circumstance. There is
 * no hover on a touch device, so the text does not merely become awkward to
 * reach — it does not exist. Roughly forty attributes in this codebase carried
 * their information nowhere else, and every one of them is an explanation: why
 * an entity wants attention, why a command is unavailable, why an option is
 * barred. A hidden explanation is the same defect as a missing one, which is the
 * whole argument [[DisabledWithReason]] already makes for refusals.
 *
 * THIS IS NOT A SECOND TOOLTIP VOCABULARY. It renders `.hon-tip` — the same
 * bubble, the same cause/remedy voice, the same tap-to-open disclosure and the
 * same phone clamp that honesty.css already writes once for every spelling of
 * this tooltip. The only thing new here is the HOST, because the existing hosts
 * are all refused controls and most of these sites are ordinary text.
 *
 * WHEN NOT TO USE IT. If the same information is already on screen — the title
 * mirrors a visible label, or repeats an `aria-label` the user can also see —
 * then nothing is lost on touch and this would add a control where there was
 * only text. Around 245 of the 320 attributes are that case and were left alone
 * deliberately. Converting them would bury the ones that matter.
 *
 * THE NATIVE `title` IS REPLACED, NOT KEPT, and that is not a loss on any
 * platform. `.hon-tip` opens on hover exactly as `title` did, and also on focus
 * and on tap, which `title` never did; it renders the cause/remedy split in the
 * vocabulary's own voice instead of an unstyled OS bubble; and it is wired
 * through `aria-describedby`, so a screen reader announces it. Keeping both
 * would put a native tooltip and a styled one on the same element, firing a
 * second later — the desktop reads that as a bug, and it is one.
 */
export function ReasonNote({
  reason,
  children,
  label,
  className,
  testid,
}: {
  /** The full text that was in `title`. Split into cause/remedy for the bubble. */
  reason: string;
  /** The visible content this note explains. */
  children: ReactNode;
  /**
   * Accessible name for the disclosure trigger. Defaults to naming the visible
   * content, so a screen reader hears what is being explained rather than a
   * bare "button".
   */
  label?: string;
  className?: string;
  testid?: string;
}) {
  const tipId = useId();
  const tip = useReasonDisclosure();
  const parts: UnavailableReason = toReason(reason);
  return (
    <span
      className={className ? `hon-note ${className}` : 'hon-note'}
      {...tip.hostProps}
      data-testid={testid ?? 'reason-note'}
    >
      <span
        className="hon-note__trigger"
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-describedby={tipId}
        {...tip.triggerProps}
      >
        {children}
      </span>
      {/* Always in the DOM, hidden with opacity/visibility and never
          `display: none` — it is the `aria-describedby` target, and dropping it
          from the accessibility tree would take the reason with it. */}
      <span className="hon-tip" id={tipId} role="tooltip">
        <span className="hon-tip__cause">{parts.cause}</span>
        {parts.remedy ? <span className="hon-tip__remedy">{parts.remedy}</span> : null}
      </span>
    </span>
  );
}
