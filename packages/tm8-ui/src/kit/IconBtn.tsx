import type { ReactNode } from 'react';

/**
 * IconBtn — square glyph button (T0-4 row actions). ALWAYS labeled for
 * screen readers: `label` is required and becomes aria-label + title.
 * `danger` shows the block color on hover (the T0-4 delete affordance).
 *
 * `pressed` makes it a TOGGLE. Left undefined the attribute is omitted
 * entirely rather than written as "false": `aria-pressed` is what tells a
 * screen reader this button has an on/off state at all, so putting it on the
 * plain action buttons would announce a state that does not exist. The first
 * caller is `kit/ZoomableFigure`'s expand control.
 */
export function IconBtn({
  label,
  danger = false,
  pressed,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  pressed?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={danger ? 'kit-iconbtn kit-iconbtn--danger' : 'kit-iconbtn'}
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      onClick={onClick}
    >
      <span aria-hidden>{children}</span>
    </button>
  );
}
