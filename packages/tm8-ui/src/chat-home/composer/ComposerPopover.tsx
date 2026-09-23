/**
 * A TRIGGER AND A SURFACE, for composer controls whose content is not a flat
 * option list: the model+effort dial, the ⚙ options form, the ＋ menu, a crew
 * worker's gear. Same plumbing as `ComposerSelect` — portalled through
 * `useMenuAnchor` on the desktop, a `MobileSheet` on the phone, dismissed by
 * `useDismissable` only where a sheet is not already doing that job.
 */
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMenuAnchor } from '../../kit';
import { MobileSheet, useMobileSurface } from '../../mobile';
import { useDismissable } from '../../panels/useDismissable';

export interface ComposerPopoverProps {
  /** Accessible name of the trigger; stable across values. */
  label: string;
  /** What the trigger shows. */
  trigger: ReactNode;
  /** The surface's content; `close` lets a row dismiss on pick. */
  children: (close: () => void) => ReactNode;
  disabled?: boolean;
  /** Why it is disabled — rendered as the trigger's title, so a still control still explains itself. */
  disabledReason?: string;
  title?: string;
  className?: string;
  /** A small count drawn on the trigger (non-default options, enabled skills). */
  badge?: number;
  menuHeight?: number;
  menuWidth?: number;
  testId: string;
}

export function ComposerPopover({
  label,
  trigger,
  children,
  disabled = false,
  disabledReason,
  title,
  className,
  badge,
  menuHeight = 300,
  menuWidth = 260,
  testId,
}: ComposerPopoverProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const { oneSurface } = useMobileSurface();
  useDismissable(open && !oneSurface, [boxRef, menuRef], close);
  const anchor = useMenuAnchor(open && !oneSurface, boxRef, menuRef, close, menuHeight, menuWidth);
  const menuId = useId();

  return (
    <span className={['tch-pop', className ?? ''].filter(Boolean).join(' ')} ref={boxRef}>
      <button
        type="button"
        className="tch-pop__trigger"
        data-testid={testId}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={disabled ? disabledReason ?? title : title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
        {badge ? (
          <span className="tch-pop__badge" data-testid={`${testId}-badge`} aria-label={`${badge} set`}>
            {badge}
          </span>
        ) : null}
      </button>
      {open && oneSurface ? (
        <MobileSheet title={`${label} panel`} onDismiss={close} testId={`${testId}-sheet`}>
          <div className="tch-popmenu tch-popmenu--sheet">{children(close)}</div>
        </MobileSheet>
      ) : null}
      {open && !oneSurface && anchor
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="dialog"
              aria-label={`${label} panel`}
              className="tch-popmenu"
              style={{ ...anchor.style, width: menuWidth }}
              data-testid={`${testId}-menu`}
            >
              {children(close)}
            </div>,
            anchor.host,
          )
        : null}
    </span>
  );
}
