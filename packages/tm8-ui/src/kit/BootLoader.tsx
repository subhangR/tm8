import type { ReactNode } from 'react';

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
 * The mark is an ink ring with one brass arc tracing it — the atelier's nib,
 * not a UI spinner. Hairline strokes, warm ramp, no glow and no bounce, per
 * the token system's motion note ("fast, mechanical").
 *
 * Honesty, same as every other wait state here: `role="status"` + a live
 * region, so a screen reader is told the workspace is loading rather than
 * meeting an empty main. `detail` carries the stage when the caller knows it —
 * an unlabelled wait that never resolves is the failure mode to avoid.
 */
export function BootLoader({
  label = 'loading workspace',
  detail,
}: {
  /** The line under the mark. Lowercase; the CSS does the uppercasing. */
  label?: string;
  /** Optional second line — the stage, or why this is taking a while. */
  detail?: ReactNode;
}) {
  return (
    <div className="kit-boot" role="status" aria-live="polite" data-testid="boot-loader">
      <div className="kit-boot__mark" aria-hidden="true">
        <svg className="kit-boot__ring" viewBox="0 0 48 48" width="48" height="48">
          {/* The paper: a full hairline ring, always present, never animated. */}
          <circle className="kit-boot__track" cx="24" cy="24" r="21" />
          {/* The ink: one arc that draws, retracts and rotates. */}
          <circle className="kit-boot__arc" cx="24" cy="24" r="21" />
        </svg>
      </div>
      <span className="kit-boot__label">{label}</span>
      {detail ? <span className="kit-boot__detail">{detail}</span> : null}
    </div>
  );
}
