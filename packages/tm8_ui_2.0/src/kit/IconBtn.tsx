import type { ReactNode } from 'react';

/**
 * IconBtn — square glyph button (T0-4 row actions). ALWAYS labeled for
 * screen readers: `label` is required and becomes aria-label + title.
 * `danger` shows the block color on hover (the T0-4 delete affordance).
 *
 * `disabledReason` is the honest disabled API (same grammar as Chip):
 * setting it marks the button `aria-disabled`, replaces the tooltip with the
 * reason, and makes the click inert. The aria-label stays the verb — what
 * the control IS — while the title says why it is refused right now.
 */
export function IconBtn({
  label,
  danger = false,
  onClick,
  children,
  disabledReason,
}: {
  label: string;
  danger?: boolean;
  onClick?: () => void;
  children: ReactNode;
  /** Set ⇒ aria-disabled, tooltip carries the reason, onClick never fires. */
  disabledReason?: string;
}) {
  const disabled = disabledReason !== undefined;
  return (
    <button
      type="button"
      className={danger ? 'kit-iconbtn kit-iconbtn--danger' : 'kit-iconbtn'}
      aria-label={label}
      aria-disabled={disabled || undefined}
      title={disabled ? disabledReason : label}
      onClick={disabled ? undefined : onClick}
    >
      <span aria-hidden>{children}</span>
    </button>
  );
}
