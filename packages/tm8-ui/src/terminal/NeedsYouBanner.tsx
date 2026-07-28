import { AlwaysDark } from './AlwaysDark';

/**
 * "⚠ needs you" — the one thing allowed to interrupt the black box.
 *
 * A full-width strip between the chrome and the canvas, not a pill: an agent
 * blocked on a human is the highest-priority fact on the screen, and a pill
 * in the strip would lose to the terminal's own output.
 *
 * DORMANT BY RULING (R8). The rendering exists and is fixture-drivable; no
 * server-side detection ships in this program, so nothing sets it in
 * production yet. Building the state now is deliberate — R8 says the UI
 * states exist — and it means the day detection lands, no design work is
 * owed.
 */
export function NeedsYouBanner({
  /** What the agent is waiting for, e.g. "approve plan (y/n)". */
  detail,
  onFocus,
}: {
  detail?: string;
  onFocus?: () => void;
}) {
  return (
    <AlwaysDark>
      <div
        className="term-needs-you"
        role="status"
        /* polite, not assertive: it interrupts the eye, not the user's
           current sentence. */
        aria-live="polite"
        data-testid="needs-you-banner"
        onClick={onFocus}
      >
        <span className="term-needs-you__label">⚠ needs you</span>
        {detail ? <span className="term-needs-you__detail">{detail}</span> : null}
      </div>
    </AlwaysDark>
  );
}
