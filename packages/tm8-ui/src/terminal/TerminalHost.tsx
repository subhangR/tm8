import { useId } from 'react';
import { AlwaysDark } from './AlwaysDark';

/**
 * THE TERMINAL HOST — the reserved black box.
 *
 * R9 makes the byte stack a VERBATIM TRANSPLANT: ptyTransport, the write
 * scheduler, the visibility driver and xterm itself arrive unedited at
 * integration. Phase 1 therefore builds the BOX and nothing inside it — the
 * canvas annotation says it outright: "the canvas is a black box — do not
 * design inside it."
 *
 * What this component guarantees so the transplant is a drop-in later:
 *   · the 160px min-height floor (L4) — measured, not aspirational;
 *   · `overflow:hidden` with `min-width:0`, so xterm scrolls INTERNALLY and
 *     can never grow the panel or push a floor open;
 *   · a stable host element to reparent `term.element` into (the pool's
 *     acquire mechanism is appendChild + refit, not portals);
 *   · the a11y wiring the keyboard contract requires: the host is described
 *     by the exit chip's instruction, so a screen-reader user entering the
 *     terminal is told how to leave before they are trapped.
 */

export function TerminalHost({
  /** Reason the canvas is empty. Phase 1 always has one — there is no PTY. */
  placeholder,
  hostRef,
  ariaLabel = 'Terminal',
}: {
  placeholder?: string;
  /** Where the pool will reparent the xterm element at integration. */
  hostRef?: React.Ref<HTMLDivElement>;
  ariaLabel?: string;
}) {
  const hintId = useId();
  return (
    <AlwaysDark>
      <div
        className="term-host"
        ref={hostRef}
        role="group"
        aria-label={ariaLabel}
        aria-describedby={hintId}
        data-testid="terminal-host"
      >
        {placeholder ? (
          <p className="term-host__ghost" data-testid="terminal-host-placeholder">
            {placeholder}
          </p>
        ) : null}
        {/* The escape instruction lives with the host, not only in the chip:
            a user who lands here by keyboard must be told how to get out. */}
        <span id={hintId} hidden>
          The terminal captures the keyboard while focused. Press Control and backtick to return to
          the panel.
        </span>
      </div>
    </AlwaysDark>
  );
}

/** Phase-1 copy, verbatim from the T0-2 placeholder. */
export const TERMINAL_PLACEHOLDER =
  '▉ xterm canvas — verbatim transplant\ndo not design inside · scrolls internally · min-height 160';
