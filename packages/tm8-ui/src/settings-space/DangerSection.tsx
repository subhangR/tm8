/**
 * Danger zone. The oracle names it in the nav (L43) and draws no body — and
 * this is the one section where that must not become an empty pane, because
 * the acts behind it (transfer ownership, delete the space) are irreversible.
 * Both render refused, and the reason says the seam carries no verb rather
 * than implying they are merely gated by permission.
 *
 * EXTRACTED FROM `SettingsShell.tsx` 2026-08-16, same reason as
 * `ProfileSection`. It also gained a scroller in the move: it used to render a
 * bare `.set-stack` straight into `.set-body`, so on a short card its second
 * button was clipped by the card's `overflow: hidden` with no way to reach it
 * — on the one screen where a control silently disappearing is worst.
 */
import { SectionFrame } from './SectionFrame';
import { DisabledAction } from '../panels';
import { DANGER_ZONE_UNAVAILABLE } from './reasons';

export function DangerSection({ heading }: { heading: string }) {
  return (
    <SectionFrame title={heading} bodyTestId="danger-body">
      <div className="set-stack">
        <span className="set-prose">
          These two acts are irreversible and neither has an executor in this build. They are shown so
          you know where they live — not so you can be told “nothing happened” after clicking.
        </span>
        <DisabledAction reason={DANGER_ZONE_UNAVAILABLE} label="transfer ownership">
          Transfer ownership
        </DisabledAction>
        <DisabledAction reason={DANGER_ZONE_UNAVAILABLE} label="delete this space">
          Delete this space
        </DisabledAction>
      </div>
    </SectionFrame>
  );
}
