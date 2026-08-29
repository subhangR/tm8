import type { ReactNode } from 'react';

/**
 * Btn — the Kinetic button grammar as a component (kit.css `.k-btn`).
 *
 * A thin wrapper: the grammar lives in CSS and works on any raw <button>;
 * this component exists so callers get the variant vocabulary and the honest
 * disabled API without hand-assembling class strings.
 *
 * Variants: `primary` (filled ink — the default action), `brand` (the blue
 * fill, reserved for Run/Launch verbs), `secondary` (bordered neutral, the
 * safe default), `ghost` (quiet inline).
 *
 * `disabledReason` is the honest disabled API, same contract as Chip and
 * IconBtn: setting it marks the button `aria-disabled`, surfaces the reason
 * as the tooltip, and makes the click inert. There is deliberately no bare
 * `disabled` prop — a dead control with no stated reason is the silent-dead
 * problem the honesty kit exists to end.
 */
export type BtnVariant = 'primary' | 'brand' | 'secondary' | 'ghost';

export function Btn({
  variant = 'secondary',
  sm,
  onClick,
  children,
  title,
  disabledReason,
  type = 'button',
}: {
  variant?: BtnVariant;
  /** Compact 28px form (`.k-btn--sm`) for dense rows and toolbars. */
  sm?: boolean;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
  /** Set ⇒ aria-disabled, tooltip carries the reason, onClick never fires. */
  disabledReason?: string;
  type?: 'button' | 'submit';
}) {
  const disabled = disabledReason !== undefined;
  const className = ['k-btn', `k-btn--${variant}`, sm ? 'k-btn--sm' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type={type}
      className={className}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      title={disabled ? disabledReason : title}
    >
      {children}
    </button>
  );
}
