/**
 * THE FRAME NAV (round 2, R2-D1): the list a mode that is not Work draws in
 * the app frame's panel — Settings' sections, Design's designs and pages —
 * so leaving Work keeps Work's shape: a left column of things, the selected
 * one filling the rest. Work's own browser is an entity list tied to the
 * workspace runtime; this is the plain list beside it, in the same row
 * metrics (browser.css), with a name filter at the top (R2-D6).
 */
import { useMemo, useState, type ReactNode } from 'react';
import './frame-nav.css';

export interface FrameNavItem {
  key: string;
  label: string;
  /** A second, quieter line-end note (a page count, a scope). */
  detail?: string;
  /** 1 draws the row indented under the row before it (a design's pages). */
  depth?: 0 | 1;
  tone?: 'danger';
}

export interface FrameNavGroup {
  id: string;
  /** Null draws the group with no heading. */
  label: string | null;
  items: readonly FrameNavItem[];
}

export interface FrameNavProps {
  /** The nav's accessible name. */
  label: string;
  groups: readonly FrameNavGroup[];
  current: string | null;
  onSelect(key: string): void;
  /** The filter box's placeholder; the filter matches row labels. */
  filterPlaceholder?: string;
  /** Drawn between the filter and the list (a + New, a loading line). */
  head?: ReactNode;
  /** What the list says when there is nothing to list (before any filter). */
  empty?: ReactNode;
}

export function FrameNav({ label, groups, current, onSelect, filterPlaceholder = 'Filter', head, empty }: FrameNavProps) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      groups
        .map((group) => ({ ...group, items: q ? group.items.filter((item) => item.label.toLowerCase().includes(q)) : group.items }))
        .filter((group) => group.items.length > 0),
    [groups, q],
  );
  const total = groups.reduce((n, group) => n + group.items.length, 0);
  return (
    <nav className="frame-nav" aria-label={label} data-testid="frame-nav">
      <div className="frame-nav__filter">
        <input
          type="search"
          className="frame-nav__input"
          aria-label={`Filter ${label.toLowerCase()}`}
          placeholder={filterPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.stopPropagation();
              setQuery('');
            }
          }}
        />
      </div>
      {head}
      <div className="frame-nav__list">
        {total === 0 ? (
          empty ? <div className="frame-nav__empty">{empty}</div> : null
        ) : shown.length === 0 ? (
          <div className="frame-nav__empty" role="status">Nothing matches “{query.trim()}”.</div>
        ) : (
          shown.map((group) => (
            <div key={group.id} className="frame-nav__group" role="group" aria-label={group.label ?? undefined} data-group={group.id}>
              {group.label ? <div className="frame-nav__heading" aria-hidden>{group.label}</div> : null}
              {group.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="frame-nav__row"
                  data-depth={item.depth || undefined}
                  data-tone={item.tone}
                  aria-current={item.key === current ? 'page' : undefined}
                  onClick={() => onSelect(item.key)}
                >
                  <span className="frame-nav__label">{item.label}</span>
                  {item.detail ? <span className="frame-nav__detail">{item.detail}</span> : null}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </nav>
  );
}
