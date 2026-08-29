import type { ReactNode } from 'react';

/**
 * IconBtn — square glyph button (T0-4 row actions). ALWAYS labeled for
 * screen readers: `label` is required and becomes aria-label + title.
 * `danger` shows the block color on hover (the T0-4 delete affordance).
 */
export function IconBtn({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={danger ? 'kit-iconbtn kit-iconbtn--danger' : 'kit-iconbtn'}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <span aria-hidden>{children}</span>
    </button>
  );
}
