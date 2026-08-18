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
import { useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EntityId } from '@tm8/contract';
import { Avatar, useMenuAnchor } from '../kit';
import { useDismissable } from '../panels/useDismissable';

/** `.tch-pickmenu`'s own max-height (260, chat-home.css) + its 4px offset. */
const MENU_HEIGHT = 264;
const MENU_WIDTH = 220;

export interface ComposerSelectOption {
  id: string;
  label: string;
  /** Second line in the menu row — a mode's intent, a model's provider. */
  hint?: string;
  /** Teammates only, so the trigger and the rows draw the real face. */
  actor?: { id: EntityId; avatar?: string | null };
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
  testId: string;
}

export function ComposerSelect({
  label,
  options,
  value,
  onChange,
  disabled = false,
  emptyNote,
  testId,
}: ComposerSelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, [boxRef, menuRef], close);
  const anchor = useMenuAnchor(open, boxRef, menuRef, close, MENU_HEIGHT, MENU_WIDTH);

  const selectedIndex = options.findIndex((option) => option.id === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const activeIndex = options.length ? Math.min(active, options.length - 1) : 0;
  const menuId = useId();

  const choose = (option: ComposerSelectOption): void => {
    onChange(option.id);
    close();
  };

  return (
    <span className="tch-pick" ref={boxRef}>
      <button
        type="button"
        className="tch-pick__trigger"
        data-testid={testId}
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
              const step = event.key === 'ArrowDown' ? 1 : options.length - 1;
              setActive((current) => (current + step) % options.length);
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
        <span className="tch-pick__value">{selected?.label ?? '—'}</span>
        <span className="tch-pick__caret" aria-hidden>▾</span>
      </button>

      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              className="tch-pickmenu"
              style={anchor.style}
              data-testid={`${testId}-menu`}
            >
              {options.length === 0 ? (
                <p className="tch-pickmenu__note" role="status">{emptyNote}</p>
              ) : (
                <div role="listbox" id={menuId} aria-label={`${label} options`}>
                  {options.map((option, index) => (
                    <button
                      key={option.id}
                      type="button"
                      role="option"
                      id={`${menuId}-opt-${index}`}
                      className="tch-pickmenu__opt"
                      data-testid={`${testId}-${option.id}`}
                      data-active={index === activeIndex || undefined}
                      aria-selected={option.id === value}
                      /* Hover moves the highlight so the mouse and the arrow
                         keys never disagree about which row Enter would take. */
                      onMouseEnter={() => setActive(index)}
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
                        {option.hint ? (
                          <span className="tch-pickmenu__hint">{option.hint}</span>
                        ) : null}
                      </span>
                      <span className="tch-pickmenu__mark" aria-hidden>
                        {option.id === value ? '✓' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>,
            anchor.host,
          )
        : null}
    </span>
  );
}
