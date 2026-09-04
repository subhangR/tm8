/**
 * GraphSearch — the toolbar find field for the ◉ Graph canvas.
 *
 * IT FOLLOWS THE LIST PANEL'S FIND BOX (`SearchRow` in EntityListPanel, styled
 * as `.lp__searchrow`), rather than inventing a second search grammar for the
 * one screen that most needs to feel like the rest of the app: a bordered row,
 * the `⌕` glyph leading, the field, and the `f` key hint trailing. `f` and not
 * `/` for D36's reason, restated where the code is: `/` is the command
 * palette's guaranteed path because ⌘K is browser-owned, so search gets its own
 * key instead of borrowing a committed one.
 *
 * WHAT IS DIFFERENT HERE, AND WHY. A list filters; a graph must not. Removing
 * a node's neighbours stops it being a graph, so search on this canvas MOVES
 * and MARKS instead: the host pans to the match, rings it, and this control
 * reports the position — "2 / 7" — with a pair of steppers to walk the rest.
 * That readout is why the count is a position and not just a total: a number
 * alone cannot tell you whether the thing you are looking at is the one you
 * asked for.
 *
 * OFF-CANVAS MATCHES ARE STATED, NEVER SWALLOWED. A match can be folded onto a
 * hub, sitting on the shelf, or past the render cap — real hits the steppers
 * cannot reach. Saying "7 here · 2 off canvas" is the same honesty the banner
 * keeps about truncation; silently reporting 7 would make the two counts
 * disagree with the canvas.
 *
 * State stays the caller's: this renders `value`, forwards keystrokes through
 * `onChange`, reports Enter/Shift-Enter through `onStep`. Escape is special —
 * it clears + blurs AND stops propagation, so the host screen's Esc ladder
 * (Z4 → Z3 → dismiss) does not also fire when the user is only leaving the
 * field.
 */
import type { Ref } from 'react';
import { useRef } from 'react';
import './graph-search.css';

export interface GraphSearchProps {
  value: string;
  onChange(value: string): void;
  /** Matches drawn on the canvas — the ones the steppers can reach. */
  onCanvas: number;
  /** 1-based position of the current match; 0 when there is none. */
  position: number;
  /** Matched but not drawn: folded, shelved, or past the render cap. */
  offCanvas: number;
  /** +1 / −1, wrapping. Enter and the steppers both call this. */
  onStep(delta: number): void;
  /** The host focuses this on `f`, exactly as the list panel does. */
  inputRef?: Ref<HTMLInputElement>;
}

export function GraphSearch(props: GraphSearchProps) {
  const { value, onChange, onCanvas, position, offCanvas, onStep } = props;
  const ownRef = useRef<HTMLInputElement | null>(null);

  const searching = value.trim().length > 0;
  const stepping = onCanvas > 1;

  return (
    <div className="gv-search">
      <span className="gv-search__glyph" aria-hidden>
        ⌕
      </span>
      <input
        ref={props.inputRef ?? ownRef}
        type="text"
        className="gv-search__input"
        placeholder="find on the graph…"
        aria-label="Find on the graph — moves the canvas to each match"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            // Own the Escape: clear + blur, and DON'T let the host Esc ladder
            // also fire (Z4 collapse / panel dismiss) on the same keypress.
            event.stopPropagation();
            event.preventDefault();
            onChange('');
            (props.inputRef && 'current' in props.inputRef
              ? props.inputRef.current
              : ownRef.current
            )?.blur();
          }
        }}
      />
      {searching ? (
        <span className="gv-search__count" aria-live="polite">
          {onCanvas === 0 ? (
            /* THE WORD, not a bare 0 — a zero beside a field reads as a count
               that has not caught up yet, which is exactly the wrong thing to
               believe while you are typing. */
            offCanvas > 0 ? `none here · ${offCanvas} off canvas` : 'no match'
          ) : (
            <>
              {position} / {onCanvas}
              {offCanvas > 0 ? ` · ${offCanvas} off canvas` : ''}
            </>
          )}
        </span>
      ) : null}
      {stepping ? (
        <span className="gv-search__steps">
          <button
            type="button"
            className="gv-search__step"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            onClick={() => onStep(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="gv-search__step"
            aria-label="Next match"
            title="Next match (Enter)"
            onClick={() => onStep(1)}
          >
            ›
          </button>
        </span>
      ) : null}
      {/* The list panel's hint, same key, same shape. It yields to the position
          readout rather than sitting beside it — the hint teaches how to get
          here, and once you are here it has nothing left to say. */}
      {searching ? null : (
        <kbd className="gv-search__key" aria-hidden>
          f
        </kbd>
      )}
    </div>
  );
}
