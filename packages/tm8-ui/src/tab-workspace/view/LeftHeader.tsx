/**
 * Left header (Spec A §3, design log §2): tm8 mark · space switcher … view
 * selector (right-aligned; Subhang round 2 item 7), spanning the rail and
 * the browser. Workstream A.
 *
 * `ViewSelector` is also mounted by the Restore cluster's ⋯ while the
 * navigation is expanded away (Spec A §14), so both doors open one menu.
 */
import { cloneElement, isValidElement, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { BrandMark } from '../../kit/BrandMark';
import { useShellFrame } from './context';

/** Below this browser width the space switcher draws its monogram only (design log §2, §4). */
const NARROW_BROWSER_W = 300;

export function LeftHeader() {
  const { gate, panelWidth: browserWidth } = useShellFrame();
  const narrow = browserWidth < NARROW_BROWSER_W;
  /* R4: the single-line quiet trigger; the space initial only when narrow. */
  const switcher = isValidElement<{ collapsed?: boolean; quiet?: boolean }>(gate.switcherSlot)
    ? cloneElement(gate.switcherSlot, { collapsed: narrow, quiet: true })
    : gate.switcherSlot;
  return (
    <header className="tws-left-header" data-testid="tws-left-header">
      <div className="tws-mark-cell">
        <button type="button" className="tws-icon-btn tws-mark" aria-label="Work" title="Work" onClick={gate.goHome}>
          <BrandMark />
        </button>
      </div>
      <div className="tws-space-slot" data-narrow={narrow || undefined}>
        {switcher}
        {gate.workspaceSwitcherSlot ?? null}
      </div>
      <ViewSelector variant="label" />
    </header>
  );
}

export interface ViewSelectorProps {
  /** `label` draws `Work ▾`; `more` draws the Restore cluster's ⋯. */
  variant: 'label' | 'more';
}

/** The view selector: a menu of every view, the current one checked. */
export function ViewSelector({ variant }: ViewSelectorProps) {
  const { gate } = useShellFrame();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = gate.viewTabs.find((tab) => tab.id === gate.activeViewTabId);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const rows = rowsOf(menuRef.current);
    (rows.find((row) => row.getAttribute('aria-checked') === 'true') ?? rows[0])?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  /* Arrow keys move, Tab cycles inside (the popover traps focus, Spec A §16),
     Escape closes back to the trigger. */
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = rowsOf(menuRef.current);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const move = (delta: number) => {
      event.preventDefault();
      rows[(at + delta + rows.length) % rows.length]?.focus();
    };
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'Tab') move(event.shiftKey ? -1 : 1);
    else if (event.key === 'Home') move(-at);
    else if (event.key === 'End') move(rows.length - 1 - at);
  };

  /* Outside the three modes (Settings, Inbox…) the selector names the screen. */
  const label = current?.label ?? gate.shellTabs.find((tab) => tab.id === gate.activeViewTabId)?.label ?? gate.screenLabel ?? 'Work';
  const trigger: ReactNode =
    variant === 'label' ? (
      <>
        <span>{label}</span>
        <span className="tws-chevron" aria-hidden>
          ▾
        </span>
      </>
    ) : (
      <span aria-hidden>⋯</span>
    );

  return (
    <div className="tws-view-select" ref={wrapRef} data-variant={variant}>
      <button
        ref={triggerRef}
        type="button"
        className={variant === 'label' ? 'tws-quiet-btn' : 'tws-icon-btn'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`View: ${label}`}
        title="Switch view"
        data-testid={variant === 'label' ? 'tws-view-select' : 'tws-view-select-more'}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open ? (
        <div ref={menuRef} role="menu" aria-label="Views" className="tws-menu" onKeyDown={onMenuKeyDown}>
          {gate.viewTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="menuitemradio"
              aria-checked={tab.id === gate.activeViewTabId}
              tabIndex={-1}
              className="tws-menu-row"
              onClick={() => {
                close(true);
                if (tab.id !== gate.activeViewTabId) gate.onSelectViewTab(tab.id);
              }}
            >
              {tab.glyph ? (
                <span className="tws-menu-glyph" aria-hidden>
                  {tab.glyph}
                </span>
              ) : null}
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function rowsOf(menu: HTMLElement | null): HTMLButtonElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')) : [];
}
