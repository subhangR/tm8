import type { ReactNode } from 'react';
import { RibbonMark, type RibbonMotion } from './RibbonMark';

/**
 * BootLoader — the centred wait state for BOOT, and boot only.
 *
 * WHY THIS IS NOT A DESIGN-SYSTEM VIOLATION. `panels/detail/PanelStates.tsx`
 * binds panel loading to geometry-true skeletons and says, in as many words,
 * "never a spinner". That rule holds because a panel's SHAPE is known before
 * its content is: the chrome renders instantly and the skeleton is an honest
 * tracing of the rows that are coming.
 *
 * Boot has no such shape. Until `spaces.list` resolves there is no space, no
 * menu, no kinds and therefore no geometry to be true to — a skeleton here
 * would be inventing a layout it cannot promise, which is the dishonesty the
 * skeleton rule exists to prevent. So the two states are DIFFERENT states, and
 * this one is deliberately scoped: it replaces the bare `loading workspace…`
 * text at the boot gate and is used nowhere else. A list, panel or detail that
 * reaches for this instead of a skeleton is the design bug T4's matrix means.
 *
 * The mark is the tm8 figure-8, drawn as a Möbius ribbon in pseudo-3D and
 * turning on its own axis — the product's own glyph doing the waiting, rather
 * than a generic arc. See `RibbonMark` for the port and for what it costs.
 *
 * Honesty, same as every other wait state here: `role="status"` + a live
 * region, so a screen reader is told the workspace is loading rather than
 * meeting an empty main. `detail` carries the stage when the caller knows it —
 * an unlabelled wait that never resolves is the failure mode to avoid.
 */
export function BootLoader({
  label = 'loading workspace',
  detail,
  motion,
}: {
  /** The line under the mark. Lowercase; the CSS does the uppercasing. */
  label?: string;
  /** Optional second line — the stage, or why this is taking a while. */
  detail?: ReactNode;
  /**
   * Which authored scene list the mark turns on. Both variants shipped in the
   * design and the choice between them is still open, so it stays a prop
   * rather than being baked in here.
   *
   * Deliberately NOT defaulted: `RibbonMark` holds the one default, so when
   * the pick is made it is made in one place. A default here would be a second
   * copy of an answer nobody has given yet, and the chat marks would keep
   * turning the other way the day boot changed.
   */
  motion?: RibbonMotion;
}) {
  return (
    <div className="kit-boot" role="status" aria-live="polite" data-testid="boot-loader">
      {/* The wordmark, with the ribbon as its 8 — so boot shows the product's
          name being drawn rather than an anonymous mark spinning. Decorative:
          the label below is what a reader is given, and the letters here would
          otherwise be announced as a bare "tm". */}
      <div className="kit-boot__mark" aria-hidden="true">
        <span className="kit-boot__letters">tm</span>
        <RibbonMark className="kit-boot__ribbon" layout="wordmark" motion={motion} />
      </div>
      <span className="kit-boot__label">{label}</span>
      {detail ? <span className="kit-boot__detail">{detail}</span> : null}
    </div>
  );
}
