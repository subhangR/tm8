/**
 * ONE THREAD SETTING, AS A DROP-UP INSIDE THE COMPOSER.
 *
 * WHY IT REPLACED THE HEADER PANEL AND THE CHIP ROWS. A thread's three
 * write-once facts — teammate, mode, model — used to be drawn twice: a select
 * panel above the transcript AND, for a new thread, a five-wide mode radio row
 * plus one chip per teammate inside the composer. Both grew with the roster and
 * both ate the top of the canvas, which is the part a conversation actually
 * needs. A trigger is CONSTANT height and states its own value, so the settings
 * cost the same three buttons whether the space has two teammates or twenty.
 *
 * THE MENU IS PORTALLED (`useMenuAnchor`) for the reason the board's filter
 * selects are: `.tch-composer` is a bordered card inside a `container-type`
 * ancestor, and a menu an ancestor's `overflow` can clip reads as a broken
 * control rather than a hidden one. `useMenuAnchor` also decides up-vs-down from
 * the room actually left below the trigger — pinned to the bottom of the canvas
 * the composer's menus resolve to a drop-up on their own, rather than by a
 * hard-coded direction that would be wrong in a short pane.
 *
 * FOCUS STAYS ON THE TRIGGER and the arrow keys are read there. Moving focus
 * into a portalled list means putting it back on close, and getting that wrong
 * strands the keyboard in the document body — the highlight is state, so it
 * costs nothing to keep it under the element that already has focus.
 *
 * SINGLE SELECT, AND IT CANNOT BE EMPTIED: every one of these settings is
 * required to start a turn, so there is no clear affordance and no null option.
 * A caller with nothing to offer passes an empty list and says what that means
 * in `emptyNote` — "no teammates exist" and "the roster has not loaded" are
 * different answers, and only the caller knows which one it is handing over.
 */
import { Fragment, useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EntityId } from '@tm8/contract';
import { Avatar, useMenuAnchor } from '../kit';
import { MobileSheet, useMobileSurface } from '../mobile';
import { useDismissable } from '../panels/useDismissable';

/** `.tch-pickmenu`'s own max-height (260, chat-home.css) + its 4px offset. */
const MENU_HEIGHT = 264;
const MENU_WIDTH = 220;
/** `.tch-pickmenu--tall` (440, chat-home.css) + offset; wider so captions wrap once at most. */
const TALL_MENU_HEIGHT = 444;
const TALL_MENU_WIDTH = 280;

export interface ComposerSelectOption {
  id: string;
  label: string;
  /** Second line in the menu row — a mode's intent, a model's provider. */
  hint?: string;
  /** Teammates only, so the trigger and the rows draw the real face. */
  actor?: { id: EntityId; avatar?: string | null };
  /**
   * A section heading drawn above the first row that carries it (Read /
   * Shape / Act). Rows with the same group must be adjacent; the menu does
   * not sort, so the caller's order is the drawn order.
   */
  group?: string;
  /** Drawn, not pickable, and this is why — a codex model in the coordinator slot. */
  disabledReason?: string;
}

export interface ComposerSelectProps {
  /** The accessible name. Stable across selections, so queries stay stable. */
  label: string;
  options: readonly ComposerSelectOption[];
  value: string;
  onChange: (id: string) => void;
  /**
   * A pinned thread setting. Disabled WITH its reason beside it: the pinned
   * note in the composer foot is that reason, and this is the control it names.
   */
  disabled?: boolean;
  /** What an EMPTY option list means, in the caller's own words. */
  emptyNote: string;
  /** A line under the rows about the list as a whole — "no coordinator exists, showing everyone". */
  note?: string | null;
  /**
   * `quiet` is the thread rail's weight: no chip border, smaller, sitting on
   * the page instead of inside the composer box. The organising rule of the
   * composer is drawn by this one difference, so it is a prop and not a class
   * a caller might forget.
   */
  variant?: 'chip' | 'quiet';
  /** A leading glyph on the trigger (the rail's 🔒 / ●). Decorative. */
  glyph?: string;
  /** Groups whose heading is drawn emphasised (the Act group). */
  emphasisGroups?: readonly string[];
  /** A grouped list with captions needs more than the 260px flat menu — the
      mode menu clipped its Act group at that height (pixel check, 2026-09-05). */
  tall?: boolean;
  testId: string;
}

export function ComposerSelect({
  label,
  options,
  value,
  onChange,
  disabled = false,
  emptyNote,
  note = null,
  variant = 'chip',
  glyph,
  emphasisGroups = [],
  tall = false,
  testId,
}: ComposerSelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const { oneSurface } = useMobileSurface();
  /*
   * OFF ON THE PHONE, AND THIS ONE IS NOT AN OPTIMISATION — IT IS THE BUG.
   *
   * `useDismissable` closes on a `pointerdown` outside every MOUNTED ref. On
   * the phone the anchored menu is not rendered, so `menuRef.current` is null
   * and "outside" collapses to "outside the trigger" — and the sheet is
   * portalled into the frame's sheet host, which is outside the trigger by
   * construction. So a tap on an option fires `pointerdown` → dismiss →
   * `open: false` → the sheet unmounts, and the `click` that would have
   * selected the option never lands on anything.
   *
   * The failure is a control that renders, highlights, accepts the press and
   * does nothing — the exact shape the shell contract's honesty rule names
   * ("absent handler ⇒ absent control, never a live-looking one that swallows
   * the press"), arrived at from the opposite direction. It is also invisible
   * to every instrument here: the row measures 44px, the census passes, and no
   * screenshot can show that a tap did not take.
   *
   * `MobileSheet` already owns all three dismissal routes on the phone — the
   * ✕, the backdrop and Escape — so this is not dropping a behaviour, it is
   * declining to run a second one that fights it.
   */
  useDismissable(open && !oneSurface, [boxRef, menuRef], close);
  /* NOT CALLED ON THE PHONE. `useMenuAnchor` measures the trigger and solves a
     fixed position for a 220x264 box; on the phone the menu is a sheet, whose
     position is the frame's. Passing `false` keeps the hook's rule-of-hooks
     shape while leaving it inert, rather than computing a rectangle nothing
     reads. */
  const anchor = useMenuAnchor(open && !oneSurface, boxRef, menuRef, close, tall ? TALL_MENU_HEIGHT : MENU_HEIGHT, tall ? TALL_MENU_WIDTH : MENU_WIDTH);

  const selectedIndex = options.findIndex((option) => option.id === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const activeIndex = options.length ? Math.min(active, options.length - 1) : 0;
  const menuId = useId();

  const choose = (option: ComposerSelectOption): void => {
    if (option.disabledReason) return;
    onChange(option.id);
    close();
  };
  /* Arrow keys step over rows that cannot be picked, in the pressed direction. */
  const stepActive = (from: number, step: number): number => {
    if (!options.length) return 0;
    let next = from;
    for (let i = 0; i < options.length; i += 1) {
      next = (next + step + options.length) % options.length;
      if (!options[next]?.disabledReason) return next;
    }
    return from;
  };

  /*
   * THE ROWS, ONCE. The desktop draws them in a portalled anchored menu and the
   * phone draws them in a sheet, and those are two POSITIONS for one list —
   * writing the list twice is how the two arrangements start disagreeing about
   * which option is selected or what a row announces.
   */
  const rows = options.length === 0 ? (
    <p className="tch-pickmenu__note" role="status">{emptyNote}</p>
  ) : (
    <div role="listbox" id={menuId} aria-label={`${label} options`}>
      {options.map((option, index) => (<Fragment key={option.id}>
        {option.group && options[index - 1]?.group !== option.group ? (
          <div
            className="tch-pickmenu__group"
            data-emphasis={emphasisGroups.includes(option.group) || undefined}
            role="presentation"
          >
            {option.group}
          </div>
        ) : null}
        <button
          type="button"
          role="option"
          id={`${menuId}-opt-${index}`}
          className="tch-pickmenu__opt"
          data-testid={`${testId}-${option.id}`}
          data-active={index === activeIndex || undefined}
          data-group={option.group}
          aria-selected={option.id === value}
          aria-disabled={option.disabledReason ? true : undefined}
          title={option.disabledReason}
          /* Hover moves the highlight so the mouse and the arrow
             keys never disagree about which row Enter would take. */
          onMouseEnter={() => { if (!option.disabledReason) setActive(index); }}
          onClick={() => choose(option)}
        >
          {option.actor ? (
            <Avatar
              actorId={option.actor.id}
              provenance="agent"
              label={option.label}
              size={15}
              src={option.actor.avatar ?? null}
            />
          ) : null}
          <span className="tch-pickmenu__text">
            <span className="tch-pickmenu__name">{option.label}</span>
            {option.disabledReason ? (
              <span className="tch-pickmenu__hint tch-pickmenu__hint--why">{option.disabledReason}</span>
            ) : option.hint ? (
              <span className="tch-pickmenu__hint">{option.hint}</span>
            ) : null}
          </span>
          <span className="tch-pickmenu__mark" aria-hidden>
            {option.id === value ? '✓' : ''}
          </span>
        </button>
      </Fragment>))}
      {note ? <p className="tch-pickmenu__note" role="note">{note}</p> : null}
    </div>
  );

  /*
   * A TRIGGER THAT DRAWS A FACE CAN AFFORD TO LOSE ITS WORD; ONE THAT IS ONLY A
   * WORD CANNOT. In a narrow foot the three triggers have to give something
   * back, and the honest thing to give is the teammate's NAME — because the
   * avatar beside it already says which teammate, so nothing is actually lost.
   * Doing the same to mode or model would leave a caret with no subject.
   *
   * The flag is "has an avatar", not "is the teammate picker": the picker that
   * carries a face is the one that can stand without a label, and keying on the
   * face means a fourth setting gets the right behaviour for free.
   */
  const faced = Boolean(selected?.actor);

  return (
    <span
      className={[
        'tch-pick',
        faced ? 'tch-pick--faced' : '',
        variant === 'quiet' ? 'tch-pick--quiet' : '',
      ].filter(Boolean).join(' ')}
      ref={boxRef}
    >
      <button
        type="button"
        className="tch-pick__trigger"
        data-testid={testId}
        /* The value is ellipsized at every width and hidden outright on a
           narrow foot, so the tooltip is where the full selection stays
           readable. It does NOT carry the accessible name — see below. */
        title={selected?.label}
        /* The name is the LABEL alone. Folding the selection into it would
           rename the control every time it is used, and every query that
           found it once would stop finding it. */
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        /* Focus stays on the trigger while arrows browse the portal, so the
           trigger must SAY which row is active — without this the arrows
           moved a highlight no screen reader ever announced. */
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open && options.length ? `${menuId}-opt-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => {
          setActive(selectedIndex >= 0 ? selectedIndex : 0);
          setOpen((v) => !v);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
              setActive(selectedIndex >= 0 ? selectedIndex : 0);
              setOpen(true);
            } else if (options.length) {
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((current) => stepActive(current, step));
            }
            return;
          }
          if (open && event.key === 'Enter') {
            const option = options[activeIndex];
            if (option) {
              event.preventDefault();
              choose(option);
            }
          }
        }}
      >
        {selected?.actor ? (
          <Avatar
            actorId={selected.actor.id}
            provenance="agent"
            label={selected.label}
            size={15}
            src={selected.actor.avatar ?? null}
          />
        ) : null}
        {glyph ? <span className="tch-pick__glyph" aria-hidden>{glyph}</span> : null}
        <span className="tch-pick__value">{selected?.label ?? '—'}</span>
        <span className="tch-pick__caret" aria-hidden>▾</span>
      </button>

      {/*
        THE PHONE TAKES A SHEET, AND THE SHELL CONTRACT §4 IS WHY — not taste.

        This is an ANCHORED POPOVER ON A SMALL TRIGGER, which is the exact case
        the contract names as not surviving the trip to a 390px phone (it is
        the same reason the account menu is a sheet rather than
        `auth/AccountMenu` dropped into the header). `useMenuAnchor` solves a
        220x264 box against the room left around a trigger that is one of THREE
        sitting in a composer foot pinned to the bottom of the frame — and with
        the soft keyboard up that frame is a few hundred pixels tall, so the
        drop-up it resolves to has nowhere to resolve INTO.

        A sheet has no such problem: it is positioned by the frame, which is the
        only thing that knows where the tab bar and the keyboard inset are, and
        this component composes against that rather than measuring anything
        itself. Per contract §3 a lane must not wire its own `visualViewport`
        listener, and this does not — it wires no measurement at all.

        SHEET AND NOT A PUSHED SCREEN: picking a teammate is temporary and over
        your place. Pushing it would put a thread setting in the back stack, so
        backing out of it would walk the screen stack instead of returning the
        writer to the message they were composing.

        `MobileSheet` renders null off the phone, and `oneSurface` is false
        there by construction, so the desktop branch below is untouched.
      */}
      {open && oneSurface ? (
        <MobileSheet title={label} onDismiss={close} testId={`${testId}-sheet`}>
          <div className="tch-picksheet">{rows}</div>
        </MobileSheet>
      ) : null}

      {open && !oneSurface && anchor
        ? createPortal(
            <div
              ref={menuRef}
              className={tall ? 'tch-pickmenu tch-pickmenu--tall' : 'tch-pickmenu'}
              style={anchor.style}
              data-testid={`${testId}-menu`}
            >
              {rows}
            </div>,
            anchor.host,
          )
        : null}
    </span>
  );
}
