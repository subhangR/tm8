/**
 * THE ⚙ PANEL'S ROW GRAMMAR — one row style for every setting.
 *
 *   Label                      value  ›     a pick: click (or Enter / →) opens a
 *                                           small submenu beside the panel
 *   Label                      🔒 value     read-only: no chevron, no hover
 *   Label                       [ ○—]       a switch
 *
 * Every row is the same height with its value in the same right-hand column,
 * so the panel reads as one table instead of a stack of differently sized
 * native controls. No native <select>: the submenu is drawn here, with arrow
 * keys, Enter, Esc / ← and Home / End.
 *
 * THE SUBMENU IS `position: fixed` INSIDE THE PANEL, not portalled. The panel
 * scrolls (its height is capped to the viewport), and a fixed child escapes
 * that clip while staying inside the panel's DOM, so the panel's outside-click
 * dismissal still sees a click in the submenu as inside. Coordinates are
 * divided by the host's CSS zoom, for the reason `useMenuAnchor` gives.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { zoomOf } from '../../kit/useMenuAnchor';
import { ComposerIcon } from './ComposerIcons';

export interface MenuChoice {
  id: string;
  label: string;
  hint?: string;
  /** Present ⇒ drawn, not pickable, and this is why. */
  disabledReason?: string;
  /** Drawn before the label (an avatar, an icon). */
  leading?: ReactNode;
}

export function MenuSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="tch-menu__section" role="group" aria-label={title}>
      {title ? <p className="tch-menu__heading">{title}</p> : null}
      {children}
    </div>
  );
}

/** Arrow keys move between the rows of one panel. */
export function moveRowFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const panel = event.currentTarget.closest('.tch-popmenu');
  if (!panel) return;
  const rows = [...panel.querySelectorAll<HTMLElement>('[data-menu-row]:not([aria-disabled="true"])')];
  const at = rows.indexOf(event.target as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  rows[(at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
}

export function PickRow({
  label,
  ariaLabel,
  choices,
  value,
  onPick,
  disabledReason,
  leading,
  testId,
}: {
  label: string;
  /** Accessible name of the row; defaults to `label`. */
  ariaLabel?: string;
  choices: readonly MenuChoice[];
  value: string;
  onPick: (id: string) => void;
  /** The whole row is locked, and why. */
  disabledReason?: string | null;
  /** Drawn before the value (the teammate's avatar). */
  leading?: ReactNode;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLButtonElement>(null);
  const current = choices.find((choice) => choice.id === value);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) row.current?.focus();
  }, []);
  return (
    <div className="tch-menu__rowwrap">
      <button
        ref={row}
        type="button"
        className="tch-menu__row"
        data-menu-row
        data-testid={testId}
        aria-label={ariaLabel ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabledReason ? true : undefined}
        title={disabledReason ?? undefined}
        onClick={() => { if (!disabledReason) setOpen((was) => !was); }}
        onKeyDown={(event) => {
          if (!disabledReason && (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            setOpen(true);
            return;
          }
          moveRowFocus(event);
        }}
      >
        <span className="tch-menu__label">{label}</span>
        <span className="tch-menu__value" data-testid={`${testId}-value`}>
          {leading ?? current?.leading ?? null}
          <span className="tch-menu__valuetext">{current?.label ?? '—'}</span>
        </span>
        {disabledReason ? <span className="tch-menu__chev" aria-hidden /> : <ComposerIcon name="chevronRight" size={14} className="tch-menu__chev" />}
      </button>
      {open ? (
        <Submenu
          anchor={row}
          label={ariaLabel ?? label}
          choices={choices}
          value={value}
          testId={testId}
          onPick={(id) => { onPick(id); close(true); }}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

function Submenu({
  anchor,
  label,
  choices,
  value,
  testId,
  onPick,
  onClose,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  label: string;
  choices: readonly MenuChoice[];
  value: string;
  testId: string;
  onPick: (id: string) => void;
  onClose: (refocus: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const pickable = choices.filter((choice) => !choice.disabledReason);
  const [active, setActive] = useState(() => Math.max(0, pickable.findIndex((choice) => choice.id === value)));

  /* Beside the panel, top-aligned with the row; flipped to the left edge when
     the right has no room, and clamped inside the viewport. */
  useLayoutEffect(() => {
    const rowEl = anchor.current;
    const panel = rowEl?.closest('.tch-popmenu') as HTMLElement | null;
    const menuEl = menu.current;
    if (!rowEl || !menuEl) return;
    const zoom = zoomOf(rowEl);
    const rowBox = rowEl.getBoundingClientRect();
    const side = (panel ?? rowEl).getBoundingClientRect();
    const width = menuEl.offsetWidth * zoom;
    const height = menuEl.offsetHeight * zoom;
    const right = side.right + 4;
    const left = right + width <= window.innerWidth - 8 ? right : Math.max(8, side.left - 4 - width);
    const top = Math.max(8, Math.min(rowBox.top - 5 * zoom, window.innerHeight - height - 8));
    setStyle({ position: 'fixed', left: left / zoom, top: top / zoom, zIndex: 1001 });
  }, [anchor]);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [active, style]);

  /* Esc closes THIS menu, not the panel: listen on window in the capture
     phase, which runs before the panel's own document-level Esc. */
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      onClose(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      ref={menu}
      id={id}
      role="menu"
      aria-label={label}
      className="tch-submenu"
      data-testid={`${testId}-menu`}
      style={style}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((at) => (at + (event.key === 'ArrowDown' ? 1 : pickable.length - 1)) % Math.max(1, pickable.length));
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          setActive(event.key === 'Home' ? 0 : pickable.length - 1);
        } else if (event.key === 'ArrowLeft' || event.key === 'Tab') {
          event.preventDefault();
          onClose(true);
        }
      }}
    >
      {choices.map((choice) => {
        const index = pickable.indexOf(choice);
        const selected = choice.id === value;
        return (
          <button
            key={choice.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            aria-disabled={choice.disabledReason ? true : undefined}
            className="tch-submenu__opt"
            data-testid={`${testId}-${choice.id}`}
            data-index={index >= 0 ? index : undefined}
            tabIndex={index === active ? 0 : -1}
            title={choice.disabledReason ?? choice.hint}
            onMouseEnter={() => { if (index >= 0) setActive(index); }}
            onClick={() => { if (!choice.disabledReason) onPick(choice.id); }}
          >
            {choice.leading ?? null}
            <span className="tch-submenu__text">
              <span className="tch-submenu__name">{choice.label}</span>
              {choice.disabledReason ? (
                <span className="tch-submenu__hint tch-submenu__hint--why">{choice.disabledReason}</span>
              ) : choice.hint ? (
                <span className="tch-submenu__hint">{choice.hint}</span>
              ) : null}
            </span>
            <span className="tch-submenu__mark" aria-hidden>{selected ? <ComposerIcon name="check" size={14} /> : null}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A fact that cannot change here: no chevron, no hover. */
export function StaticRow({ label, value, title, locked = false, testId }: {
  label: string;
  value: ReactNode;
  title?: string;
  locked?: boolean;
  testId?: string;
}) {
  return (
    <div className="tch-menu__row tch-menu__row--static" title={title} data-testid={testId}>
      <span className="tch-menu__label">{label}</span>
      <span className="tch-menu__value">
        {locked ? <ComposerIcon name="lock" size={13} className="tch-menu__lock" /> : null}
        <span className="tch-menu__valuetext">{value}</span>
      </span>
      <span className="tch-menu__chev" aria-hidden />
    </div>
  );
}

export function SwitchRow({ label, checked, onChange, testId }: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="tch-menu__row"
      data-menu-row
      data-testid={testId}
      onClick={() => onChange(!checked)}
      onKeyDown={moveRowFocus}
    >
      <span className="tch-menu__label">{label}</span>
      <span className="tch-switch" data-on={checked || undefined} aria-hidden><span className="tch-switch__knob" /></span>
    </button>
  );
}

export function TextRow({ label, value, placeholder, onChange, testId }: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
  testId?: string;
}) {
  return (
    <label className="tch-menu__row tch-menu__row--text">
      <span className="tch-menu__label">{label}</span>
      <input
        type="text"
        className="tch-menu__input"
        data-menu-row
        data-testid={testId}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={moveRowFocus}
      />
    </label>
  );
}

/** The one-letter face a teammate row leads with. */
export function Initial({ name }: { name: string }) {
  return <span className="tch-menu__avatar" aria-hidden>{(name.trim()[0] ?? '?').toUpperCase()}</span>;
}
