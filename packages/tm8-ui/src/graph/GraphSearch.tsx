/**
 * GraphSearch — the compact toolbar search input for the ◉ Graph canvas
 * (ATELIER paper-and-ink; tokens only, hex banned outside tokens.css). Mono
 * face, ~180px wide. Match feedback is a WORD, never a bare number — "3
 * matches" / "1 match" — the status-is-color+word law applied to a count.
 *
 * State stays the caller's: this renders `value`, forwards keystrokes through
 * `onChange`, and reports Enter through `onSubmit`. Escape is special — it
 * clears + blurs AND stops propagation, so the host screen's Esc ladder (Z4 →
 * Z3 → dismiss) does not also fire when the user is only escaping the field.
 */
import { useRef } from 'react';
import './graph-search.css';

export interface GraphSearchProps {
  value: string;
  onChange(value: string): void;
  /** Match count for the current query, or null when there is nothing to say. */
  matchCount: number | null;
  onSubmit(): void;
}

export function GraphSearch(props: GraphSearchProps) {
  const { value, onChange, matchCount, onSubmit } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);

  const showCount = value.trim().length > 0 && matchCount !== null;
  const countLabel = matchCount === 1 ? '1 match' : `${matchCount} matches`;

  return (
    <div className="gv-search">
      <span className="gv-search__glyph" aria-hidden>
        ⌕
      </span>
      <input
        ref={inputRef}
        type="text"
        className="gv-search__input"
        placeholder="search graph…"
        aria-label="Search graph"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onSubmit();
          } else if (event.key === 'Escape') {
            // Own the Escape: clear + blur, and DON'T let the host Esc ladder
            // also fire (Z4 collapse / panel dismiss) on the same keypress.
            event.stopPropagation();
            event.preventDefault();
            onChange('');
            inputRef.current?.blur();
          }
        }}
      />
      {showCount && (
        <span className="gv-search__count" aria-live="polite">
          {countLabel}
        </span>
      )}
    </div>
  );
}
