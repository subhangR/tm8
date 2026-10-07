/**
 * THE NEW TAB (Kalai, 2026-10-07), and the start surface, which renders the
 * same body without a tab:
 *
 *   1. Search on top, over the WHOLE SPACE, whatever the tab scope says: a
 *      New tab is where you go to find anything. It reads what the app has
 *      read (the hydrated kind caches, the same honest reach as the ⌘K
 *      palette), so it asks every kind to hydrate.
 *   2. What you can make: the first `NEW_MAIN_COUNT` of `NEW_KINDS` as cards,
 *      the rest under More. The ⌘K palette and the `n` chords read the same
 *      list, and each card names its chord.
 *   3. Recent below, or the results while there is a query.
 *
 * Enter opens the highlighted row and nothing else. With no query nothing is
 * highlighted, so an idle Enter can never open a recent item you did not
 * pick; typing highlights the first result, and ↑/↓ move it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { EntitySummary } from '@tm8/contract';
import { KindIcon } from '../../domain';
import { NEW_KINDS, NEW_MAIN_COUNT } from '../../keyboard';
import { getKindAdapter } from '../adapters/registry';
import { WORKSPACE_KINDS, type KindId, type TabId } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import { useFreshGlow, useRetainLeaving } from '../../domain/useFreshGlow';
import './creation.css';

export interface ChooserProps {
  /** The chooser tab, or null when rendered as the start surface. */
  tabId: TabId | null;
  variant: 'tab' | 'start';
  /** Start surface only: rendered above the search (W2-I's restore offer). */
  restoreSlot?: ReactNode;
  /** Start surface only: rendered under Recent (D31: Active sessions). */
  afterRecent?: ReactNode;
}

const RECENT_LIMIT = 8;
const RESULT_LIMIT = 12;

type NewEntry = (typeof NEW_KINDS)[number];

/** Opens the tab-strip scope control (workstream D owns the popover). */
function openScopePicker(): void {
  document.querySelector<HTMLElement>('[data-testid="tws-scope"]')?.click();
}

const byActivity = (a: EntitySummary, b: EntitySummary) =>
  a.activityAt < b.activityAt ? 1 : a.activityAt > b.activityAt ? -1 : 0;

/** A title containing the query, or a kind whose name starts with it ("tas" finds tasks). */
function matches(row: EntitySummary, q: string): boolean {
  return row.title.toLowerCase().includes(q) || getKindAdapter(row.kind).noun.toLowerCase().startsWith(q);
}

export function Chooser({ tabId, variant, restoreSlot, afterRecent }: ChooserProps) {
  const { dispatch, gate } = useWorkspace();
  const byType = useWorkspaceState((s) => s.scope.mode === 'byType');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(-1);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { rowsFor, ensureKind } = gate.data;

  useEffect(() => {
    for (const kind of WORKSPACE_KINDS) ensureKind(kind);
  }, [ensureKind]);

  // The chooser tab autofocuses its search; the empty start surface does not
  // (it must not steal focus from the browser).
  useEffect(() => {
    if (variant === 'tab') searchRef.current?.focus();
  }, [variant]);

  const q = query.trim().toLowerCase();
  const liveRows = useMemo(() => {
    const seen = new Set<string>();
    const all: EntitySummary[] = [];
    for (const kind of WORKSPACE_KINDS) {
      for (const row of rowsFor(kind)(undefined)) {
        if (seen.has(row.id) || row.deletedAt) continue;
        seen.add(row.id);
        all.push(row);
      }
    }
    all.sort(byActivity);
    return q ? all.filter((row) => matches(row, q)).slice(0, RESULT_LIMIT) : all.slice(0, RECENT_LIMIT);
  }, [rowsFor, q]);
  /* A row deleted live stays for its exit (R41). */
  const rows = useRetainLeaving(liveRows, rowIdOf);

  const offered = useMemo(() => NEW_KINDS.filter((entry) => getKindAdapter(entry.kind).creatable === true), []);
  const main = offered.slice(0, NEW_MAIN_COUNT);
  const more = offered.slice(NEW_MAIN_COUNT);
  const replace = tabId ? { replaceTabId: tabId } : {};

  const openRow = (row: EntitySummary) =>
    dispatch({ command: 'workspace.tabs.open', args: { kind: row.kind, entityId: row.id, ...replace }, source: 'click' });
  const newDraft = (kind: KindId) =>
    dispatch({ command: 'workspace.drafts.open', args: { kind, ...replace }, source: 'click' });

  const highlighted = current >= 0 && current < rows.length ? current : -1;
  const onQuery = (next: string) => {
    setQuery(next);
    setCurrent(next.trim() ? 0 : -1);
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[highlighted];
      if (row) openRow(row);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rows.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setCurrent(Math.max(0, Math.min(rows.length - 1, (highlighted < 0 && step < 0 ? rows.length : highlighted) + step)));
    }
  };

  const listId = `tws-pick-list-${tabId ?? 'start'}`;
  return (
    <div className="tws-pick" data-testid={`tws-chooser-${variant}`}>
      <div className="tws-pick-head">
        <h2 className="tws-pick-title">{variant === 'tab' ? 'New tab' : byType ? 'No open tabs for the selected types' : 'No open tabs'}</h2>
        {variant === 'start' && byType ? (
          <button type="button" className="tws-pick-link" onClick={openScopePicker} data-testid="tws-start-change-scope">
            Change tab scope
          </button>
        ) : null}
      </div>
      {restoreSlot}
      <label className="tws-pick-search">
        <svg className="tws-pick-search-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search the whole space…"
          aria-label="Search the whole space"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-activedescendant={highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={onSearchKey}
          data-testid="tws-chooser-search"
        />
      </label>
      {offered.length > 0 ? (
        <section className="tws-pick-section tws-pick-section--create" aria-label="Create">
          <div className="tws-pick-create">
            {main.map((entry) => (
              <NewCard key={entry.kind} entry={entry} onNew={newDraft} />
            ))}
            {more.length > 0 ? <MoreMenu entries={more} onNew={newDraft} /> : null}
          </div>
        </section>
      ) : null}
      <section className="tws-pick-section" aria-label={q ? 'Results' : 'Recent'}>
        <span className="t-eyebrow">{q ? `Results in this space (${liveRows.length})` : 'Recent'}</span>
        {rows.length === 0 ? (
          <p className="tws-pick-empty">{q ? `No matches for “${query.trim()}”` : 'Nothing here yet.'}</p>
        ) : (
          <ul className="tws-pick-list" id={listId} role="listbox" aria-label={q ? 'Results' : 'Recent'}>
            {rows.map((row, i) => (
              <ChooserRow key={row.id} id={`${listId}-${i}`} row={row} current={i === highlighted} onOpen={openRow} />
            ))}
          </ul>
        )}
      </section>
      {afterRecent}
    </div>
  );
}

function NewCard({ entry, onNew }: { entry: NewEntry; onNew(kind: KindId): void }) {
  return (
    <button
      type="button"
      className="tws-pick-new"
      onClick={() => onNew(entry.kind)}
      data-testid={`tws-chooser-new-${entry.kind}`}
    >
      <KindIcon kind={entry.kind} size={14} />
      <span className="tws-pick-new-label">{entry.label}</span>
      <kbd className="tws-pick-new-key" aria-hidden="true">{`n ${entry.key}`}</kbd>
    </button>
  );
}

/** The rest of `NEW_KINDS`: a menu that closes on a pick, Escape, or a click elsewhere. */
function MoreMenu({ entries, onNew }: { entries: readonly NewEntry[]; onNew(kind: KindId): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const toggle = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // The menu's Esc, not the panel's (C6 layer 4).
      event.stopPropagation();
      setOpen(false);
      toggle.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  return (
    <div className="tws-pick-more" ref={root}>
      <button
        ref={toggle}
        type="button"
        className="tws-pick-new"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        data-testid="tws-chooser-more"
      >
        <span className="tws-pick-new-label">More</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="tws-pick-menu" role="menu" aria-label="More to create" onKeyDown={onMenuKey}>
          {entries.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              role="menuitem"
              className="tws-pick-menu-item"
              onClick={() => {
                setOpen(false);
                onNew(entry.kind);
              }}
              data-testid={`tws-chooser-new-${entry.kind}`}
            >
              <KindIcon kind={entry.kind} size={14} />
              <span className="tws-pick-new-label">{entry.label}</span>
              <kbd className="tws-pick-new-key" aria-hidden="true">{`n ${entry.key}`}</kbd>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const rowIdOf = (row: EntitySummary): string => row.id;

/** One Recent / Results row; glows while new and plays its exit when deleted (R40, R41). */
function ChooserRow({
  id,
  row,
  current,
  onOpen,
}: {
  id: string;
  row: EntitySummary;
  current: boolean;
  onOpen(row: EntitySummary): void;
}) {
  const glow = useFreshGlow(row.id);
  return (
    <li role="option" id={id} aria-selected={current}>
      <button
        {...glow.attrs}
        type="button"
        className="tws-pick-row"
        data-current={current || undefined}
        onClick={() => onOpen(row)}
        title={`${row.title} — ${getKindAdapter(row.kind).noun}`}
        data-testid="tws-chooser-row"
      >
        <KindIcon kind={row.kind} size={14} />
        <span className="tws-pick-row-title">{row.title}</span>
        {glow.srSuffix ? <span className="sr-only">{glow.srSuffix}</span> : null}
        <span className="tws-pick-row-kind">{getKindAdapter(row.kind).noun}</span>
      </button>
    </li>
  );
}
