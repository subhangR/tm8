/**
 * ONE FILTER AXIS, AS A DROPDOWN.
 *
 * WHY IT REPLACED THE CHIP ROWS. Every axis used to render its whole
 * vocabulary inline, and the two PEOPLE axes rendered one chip per roster
 * actor — twice. On a real space that is two rows of faces per axis, and the
 * filter rail grew a row for every teammate added to the space: the chrome
 * above the board scaled with the roster while the board itself got whatever
 * was left. A trigger is CONSTANT height, so the board's own share of the
 * screen no longer depends on how many people are in the space.
 *
 * IT SAYS WHAT IS SELECTED WITHOUT BEING OPENED. A dropdown that reads only
 * "Assigned to" hides the very thing a filter bar exists to make visible, so
 * the trigger carries the selection: one choice shows its name, several show
 * the count, and people show their real faces. Otherwise a filtered board and
 * an unfiltered one look identical, and "where did my tasks go" is the bug.
 *
 * THE MENU IS PORTALLED (`useMenuAnchor`) for the same reason the panels'
 * assign menu is: an ancestor's `overflow` is not this component's to trust,
 * and a clipped menu reads as a broken control rather than a hidden one.
 *
 * MULTI-SELECT, ONE TOGGLE AT A TIME — the state it edits is a filter array
 * held by the screen, not a server collection, so unlike the assign menu next
 * door there is no lost-update hazard here and no write to refuse.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ActorSummary } from '@tm8/contract';
import { Avatar, useMenuAnchor } from '../kit';
import { useDismissable } from '../panels/useDismissable';

/** Above this many options the menu grows its own search box. */
const SEARCH_AT = 7;
/** `.bd__menu`'s own max-height (300, board.css) + its 4px offset. */
const MENU_HEIGHT = 304;
const MENU_WIDTH = 210;
/** Faces on the trigger before it falls back to a bare count. */
const FACES = 3;

export interface FilterOption {
  id: string;
  label: string;
  /** People axes only — the real actor, so the trigger draws the real face. */
  actor?: ActorSummary;
}

export interface FilterSelectProps {
  label: string;
  options: readonly FilterOption[];
  selected: readonly string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  /** Trigger is this id; each option is `${testId}-${option.id}`. */
  testId: string;
  /**
   * What an EMPTY option list means. An empty menu is never drawn as an empty
   * menu: "no options" and "the roster has not loaded" are different answers
   * and only the caller knows which one it is handing over.
   */
  emptyNote: string;
}

export function FilterSelect({
  label,
  options,
  selected,
  onToggle,
  onClear,
  testId,
  emptyNote,
}: FilterSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, [boxRef, menuRef], close);
  const anchor = useMenuAnchor(open, boxRef, menuRef, close, MENU_HEIGHT, MENU_WIDTH);

  const chosen = useMemo(
    () => options.filter((o) => selected.includes(o.id)),
    [options, selected],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const faces = chosen.filter((o) => o.actor).slice(0, FACES);
  const summary =
    chosen.length === 0
      ? null
      : faces.length > 0 && chosen.length > faces.length
        ? `+${chosen.length - faces.length}`
        : chosen.length === 1
          ? chosen[0]!.label
          : `${chosen.length}`;

  return (
    <span className="bd__selwrap" ref={boxRef}>
      <button
        type="button"
        className={chosen.length > 0 ? 'bd__sel bd__sel--on' : 'bd__sel'}
        data-testid={testId}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          chosen.length === 0
            ? `${label} filter, nothing selected`
            : `${label} filter, ${chosen.length} selected`
        }
        onClick={() => {
          setQuery('');
          setOpen((v) => !v);
        }}
      >
        <span className="bd__sel-label">{label}</span>
        {faces.length > 0 ? (
          <span className="bd__sel-faces" aria-hidden>
            {faces.map((o) => (
              <Avatar
                key={o.id}
                actorId={o.actor!.id}
                provenance={o.actor!.isAgent ? 'agent' : 'human'}
                label={o.actor!.displayName}
                size={15}
                src={o.actor!.avatar ?? null}
              />
            ))}
          </span>
        ) : null}
        {summary ? <span className="bd__sel-val">{summary}</span> : null}
        <span className="bd__sel-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              className="bd__menu"
              style={anchor.style}
              role="group"
              aria-label={`${label} options`}
              data-testid={`${testId}-menu`}
            >
              {options.length > SEARCH_AT ? (
                <input
                  className="bd__menu-search"
                  type="search"
                  autoFocus
                  placeholder={`Find in ${label.toLowerCase()}…`}
                  aria-label={`Find in ${label}`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              ) : null}

              <div className="bd__menu-list">
                {options.length === 0 ? (
                  <p className="bd__menu-note">{emptyNote}</p>
                ) : shown.length === 0 ? (
                  <p className="bd__menu-note">{`Nothing here matches “${query.trim()}”.`}</p>
                ) : (
                  shown.map((option) => {
                    const on = selected.includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={on ? 'bd__opt bd__opt--on' : 'bd__opt'}
                        data-testid={`${testId}-${option.id}`}
                        aria-pressed={on}
                        onClick={() => onToggle(option.id)}
                      >
                        {option.actor ? (
                          <Avatar
                            actorId={option.actor.id}
                            provenance={option.actor.isAgent ? 'agent' : 'human'}
                            label={option.actor.displayName}
                            size={15}
                            src={option.actor.avatar ?? null}
                          />
                        ) : null}
                        <span className="bd__opt-name">{option.label}</span>
                        <span className="bd__opt-mark" aria-hidden>
                          {on ? '✓' : ''}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>

              {chosen.length > 0 ? (
                <button
                  type="button"
                  className="bd__menu-clear"
                  data-testid={`${testId}-clear`}
                  onClick={onClear}
                >
                  {`Clear ${label.toLowerCase()}`}
                </button>
              ) : null}
            </div>,
            anchor.host,
          )
        : null}
    </span>
  );
}
