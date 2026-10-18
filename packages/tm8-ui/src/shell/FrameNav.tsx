/**
 * THE FRAME NAV (round 2, R2-D1): the list a mode that is not Work draws in
 * the app frame's panel — Settings' sections, Design's designs and pages —
 * so leaving Work keeps Work's shape: a left column of things, the selected
 * one filling the rest. Work's own browser is an entity list tied to the
 * workspace runtime; this is the plain list beside it, in the same row
 * metrics (browser.css), with a name filter at the top (R2-D6).
 */
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import './frame-nav.css';

export interface FrameNavItem {
  key: string;
  label: string;
  /** A second, quieter line-end note (a page count, a scope). */
  detail?: string;
  /** 1 draws the row indented under the row before it (a design's pages). */
  depth?: 0 | 1;
  tone?: 'danger';
  /** A heading drawn above this row when it differs from the row before (Settings' "People & access"). */
  subheading?: string;
  /** Extra words the filter matches beside the label ("api key" finds the credentials rows). */
  keywords?: readonly string[];
}

export interface FrameNavGroup {
  id: string;
  /** Null draws the group with no heading. */
  label: string | null;
  /** One quieter line under the heading. */
  description?: string;
  items: readonly FrameNavItem[];
}

export interface FrameNavProps {
  /** The nav's accessible name. */
  label: string;
  groups: readonly FrameNavGroup[];
  current: string | null;
  onSelect(key: string): void;
  /** The filter box's placeholder; the filter matches labels, subheadings and keywords. */
  filterPlaceholder?: string;
  /** Drawn between the filter and the list (a + New, a loading line). */
  head?: ReactNode;
  /** What the list says when there is nothing to list (before any filter). */
  empty?: ReactNode;
}

function matches(item: FrameNavItem, q: string): boolean {
  return [item.label, item.subheading ?? '', ...(item.keywords ?? [])].some((word) => word.toLowerCase().includes(q));
}

export function FrameNav({ label, groups, current, onSelect, filterPlaceholder = 'Filter', head, empty }: FrameNavProps) {
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      groups
        .map((group) => ({ ...group, items: q ? group.items.filter((item) => matches(item, q)) : group.items }))
        .filter((group) => group.items.length > 0),
    [groups, q],
  );
  const total = groups.reduce((n, group) => n + group.items.length, 0);
  const shownCount = shown.reduce((n, group) => n + group.items.length, 0);
  /* Arrow keys walk the rows, and ↓ from the filter enters the list — a list
     reachable only by Tab-through-everything is not keyboard-friendly. */
  const rows = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.frame-nav__row') ?? []);
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : Math.min(Math.max(at + (event.key === 'ArrowDown' ? 1 : -1), 0), all.length - 1);
    all[next]?.focus();
  };
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
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              rows()[0]?.focus();
            } else if (event.key === 'Enter' && q) {
              /* Enter opens the first match: type "invite", press Enter. */
              const first = shown[0]?.items[0];
              if (first) {
                event.preventDefault();
                onSelect(first.key);
              }
            }
          }}
        />
        {q ? (
          <span className="frame-nav__count" role="status" aria-live="polite">
            {shownCount === 0 ? '' : `${shownCount} match${shownCount === 1 ? '' : 'es'}`}
          </span>
        ) : null}
      </div>
      {head}
      <div className="frame-nav__list" ref={listRef} onKeyDown={onListKey}>
        {total === 0 ? (
          empty ? <div className="frame-nav__empty">{empty}</div> : null
        ) : shown.length === 0 ? (
          <div className="frame-nav__empty" role="status">Nothing matches “{query.trim()}”.</div>
        ) : (
          shown.map((group) => (
            <div key={group.id} className="frame-nav__group" role="group" aria-label={group.label ?? undefined} data-group={group.id} data-described={group.description ? true : undefined}>
              {group.label ? <div className="frame-nav__heading" aria-hidden>{group.label}</div> : null}
              {group.description && !q ? <div className="frame-nav__description">{group.description}</div> : null}
              {group.items.map((item, index) => (
                <FrameNavRowWithHeading key={item.key} showHeading={!!item.subheading && item.subheading !== group.items[index - 1]?.subheading} heading={item.subheading}>
                <button
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
                </FrameNavRowWithHeading>
              ))}
            </div>
          ))
        )}
      </div>
    </nav>
  );
}

function FrameNavRowWithHeading({ showHeading, heading, children }: { showHeading: boolean; heading: string | undefined; children: ReactNode }) {
  return (
    <>
      {showHeading ? <div className="frame-nav__subheading">{heading}</div> : null}
      {children}
    </>
  );
}
