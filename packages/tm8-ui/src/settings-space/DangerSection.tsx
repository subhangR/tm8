/**
 * Danger zone. The oracle names it in the nav (L43) and draws no body — and
 * this is the one section where that must not become an empty pane, because
 * the acts behind it (transfer ownership, delete the space) are irreversible.
 * Both render refused, and the reason says the seam carries no verb rather
 * than implying they are merely gated by permission. That distinction is the
 * whole point of the section and nothing below may blur it: a permission gate
 * is a door someone else can open, a missing verb is a door that is not built.
 *
 * EXTRACTED FROM `SettingsShell.tsx` 2026-08-16, same reason as
 * `ProfileSection`. It also gained a scroller in the move: it used to render a
 * bare `.set-stack` straight into `.set-body`, so on a short card its second
 * button was clipped by the card's `overflow: hidden` with no way to reach it
 * — on the one screen where a control silently disappearing is worst.
 *
 * LAID OUT 2026-08-16 (twelve-lane settings pass). Three measured defects, all
 * inside the body the frame pass did not touch:
 *
 *   · `.set-stack` nests its own `12px var(--set-gutter)` inside the frame's
 *     `.set-section__pad`, so the body sat 36px from the card edge under an
 *     18px head. Dropped for the bulkhead, which owns its own padding.
 *   · The section looked like Profile. The nav row that leads here is
 *     block-coloured; the body it led to was not. It is now.
 *   · Both acts carried the SAME caption and nothing else, so the two most
 *     irreversible controls in the app were typographically indistinguishable.
 *     Each now states what it would destroy, in one line.
 *
 * The shared reason stays on BOTH controls rather than being stated once for
 * the pair. It reads as duplication and it is not optional: `DisabledAction`
 * wires it through `aria-describedby`, so a hoisted copy would be a reason
 * only a sighted reader gets, on the two acts that least tolerate that.
 */
import { SectionFrame } from './SectionFrame';
import { DisabledAction } from '../panels';
import { DANGER_ZONE_UNAVAILABLE } from './reasons';
import './danger-section.css';

/**
 * The two acts, in ascending order of how much they destroy. `what` is one
 * line and is the only per-act copy on the screen — this is the shortest
 * section here and restraint is the brief; the consequence is the one thing a
 * danger zone owes a reader that the verb alone does not say.
 */
const DANGER_ACTS = [
  {
    id: 'transfer',
    verb: 'Transfer ownership',
    /** Accessible name, matching the label the shell's sweep asserts on. */
    label: 'transfer ownership',
    what: 'Another member becomes owner. You keep your membership and lose every owner-only act, including this one.',
  },
  {
    id: 'delete',
    verb: 'Delete this space',
    label: 'delete this space',
    what: 'The space goes, and every task, session, message and attachment filed in it goes with it.',
  },
] as const;

export function DangerSection({ heading }: { heading: string }) {
  return (
    <SectionFrame title={heading} bodyTestId="danger-body">
      <div className="set-danger" data-testid="danger-bulkhead">
        <p className="set-danger__prose">
          These two acts are irreversible and neither has an executor in this build. They are shown
          so you know where they live — not so you can be told “nothing happened” after clicking.
        </p>
        <ul className="set-danger__acts">
          {DANGER_ACTS.map((act) => (
            <li className="set-danger__act" key={act.id} data-testid={`danger-act-${act.id}`}>
              <span className="set-danger__act-what">{act.what}</span>
              <DisabledAction reason={DANGER_ZONE_UNAVAILABLE} label={act.label}>
                {act.verb}
              </DisabledAction>
            </li>
          ))}
        </ul>
      </div>
    </SectionFrame>
  );
}
