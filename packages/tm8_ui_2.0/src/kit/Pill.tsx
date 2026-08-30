import type { ReactNode } from 'react';

/** Functional-ramp tones (tokens §3) + the restrained brass accent. */
export type PillTone = 'run' | 'wait' | 'block' | 'info' | 'idle' | 'brand';

/**
 * Pill — status token: neutral card + colored WORD (status is always color +
 * word, never color alone). Optional leading dot; `dot="pulse"` is the
 * streaming/live marker (T0-1 "● live").
 * `outline` renders the T0-3 list-header filter/sort variant instead of a
 * status tone.
 */
export function Pill({
  tone = 'idle',
  dot,
  outline = false,
  children,
  title,
}: {
  tone?: PillTone;
  dot?: 'solid' | 'pulse';
  outline?: boolean;
  children: ReactNode;
  title?: string;
}) {
  const cls = outline ? 'kit-pill kit-pill--outline' : `kit-pill kit-pill--${tone}`;
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
