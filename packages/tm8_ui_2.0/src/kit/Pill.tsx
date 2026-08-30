import type { ReactNode } from 'react';

/** Functional-ramp tones (tokens §3) + the restrained brass accent. */
export type PillTone = 'run' | 'wait' | 'block' | 'info' | 'idle' | 'brand';

/**
 * Pill — status token: neutral card + colored WORD (status is always color +
 * word, never color alone). Optional leading dot; `dot="pulse"` is the
 * streaming/live marker (T0-1 "● live").
 *
 * Three forms, three jobs — the split the Home target draws:
 *   default    neutral card, tone on the ink
 *   `filled`   the DELTA badge — "2147 new", "9 live": soft fill AND a hairline
 *   `outline`  the T0-3 list-header filter/sort control, not a status tone
 *
 * `filled` is for a DELTA, never for a quantity. A raw total ("2351", "62",
 * "13/30") is reference and stays plain ink with no pill at all. A delta is a
 * change since you last looked — that is state which changes what you do next,
 * so it earns the hue. Getting that line wrong in either direction is the
 * mistake this variant exists to prevent.
 */
export function Pill({
  tone = 'idle',
  dot,
  outline = false,
  filled = false,
  children,
  title,
}: {
  tone?: PillTone;
  dot?: 'solid' | 'pulse';
  outline?: boolean;
  /** The delta badge: soft fill plus a hairline in the same hue. */
  filled?: boolean;
  children: ReactNode;
  title?: string;
}) {
  const cls = outline
    ? 'kit-pill kit-pill--outline'
    : `kit-pill kit-pill--${tone}${filled ? ' kit-pill--filled' : ''}`;
  return (
    <span className={cls} title={title}>
      {dot ? (
        <span aria-hidden className={dot === 'pulse' ? 'kit-pill__dot--pulse' : undefined}>
          ●
        </span>
      ) : null}
      {children}
    </span>
  );
}
