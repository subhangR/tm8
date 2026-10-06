/**
 * The chooser body (Spec A §6 `+`, design log §10): search over the in-scope
 * kinds (Mixed: every D7 kind), Recent, and one `New <kind>` per creatable
 * in-scope kind. The start surface renders the same component without a tab.
 *
 * Search reads WHAT THE APP HAS READ (the hydrated kind caches, the same
 * honest scope as the ⌘K palette); the chooser asks each in-scope kind to
 * hydrate, so candidates refresh when the scope changes. The query is local
 * component state.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { EntitySummary } from '@tm8/contract';
import { KindIcon } from '../../domain';
import { getKindAdapter } from '../adapters/registry';
import { WORKSPACE_KINDS, type KindId, type TabId, type TabScope } from '../runtime/types';
import { scopeKey } from '../runtime/selectors';
import { useWorkspace, useWorkspaceState } from './context';
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

/** The in-scope kinds, always in D7 order. */
function inScopeKinds(scope: TabScope): KindId[] {
  if (scope.mode === 'mixed') return [...WORKSPACE_KINDS];
  return WORKSPACE_KINDS.filter((kind) => scope.selectedTypeIds.includes(kind));
}

function placeholderFor(scope: TabScope, kinds: readonly KindId[]): string {
  if (scope.mode === 'mixed') return 'Search tasks, agents, docs…';
  const plurals = kinds.map((kind) => getKindAdapter(kind).nounPlural.toLowerCase());
  return `Search ${plurals.join(', ')}…`;
}

/** Opens the tab-strip scope control (workstream D owns the popover). */
function openScopePicker(): void {
  document.querySelector<HTMLElement>('[data-testid="tws-scope"]')?.click();
}

export function Chooser({ tabId, variant, restoreSlot, afterRecent }: ChooserProps) {
  const { dispatch, gate } = useWorkspace();
  const scope = useWorkspaceState((s) => s.scope);
  const key = scopeKey(scope);
  // The scope object is replaced on every commit that touches it; key on its identity string.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const kinds = useMemo(() => inScopeKinds(scope), [key]);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { rowsFor, ensureKind } = gate.data;

  useEffect(() => {
    for (const kind of kinds) ensureKind(kind);
  }, [kinds, ensureKind]);

  // The chooser tab autofocuses its search; the empty start surface does not
  // (it must not steal focus from the browser).
  useEffect(() => {
    if (variant === 'tab') searchRef.current?.focus();
  }, [variant]);

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const all: EntitySummary[] = [];
    for (const kind of kinds) {
      for (const row of rowsFor(kind)(undefined)) {
        if (seen.has(row.id) || row.deletedAt) continue;
        seen.add(row.id);
        all.push(row);
      }
    }
    if (q) return all.filter((row) => row.title.toLowerCase().includes(q)).slice(0, RESULT_LIMIT);
    return all.sort((a, b) => (a.activityAt < b.activityAt ? 1 : a.activityAt > b.activityAt ? -1 : 0)).slice(0, RECENT_LIMIT);
  }, [kinds, rowsFor, q]);

  const creatable = useMemo(() => kinds.map(getKindAdapter).filter((adapter) => adapter.creatable === true), [kinds]);
  const replace = tabId ? { replaceTabId: tabId } : {};

  const openRow = (row: EntitySummary) =>
    dispatch({ command: 'workspace.tabs.open', args: { kind: row.kind, entityId: row.id, ...replace }, source: 'click' });
  const newDraft = (kind: KindId) =>
    dispatch({ command: 'workspace.drafts.open', args: { kind, ...replace }, source: 'click' });

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && rows[0]) {
      event.preventDefault();
      openRow(rows[0]);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.currentTarget.closest('.tws-pick')?.querySelector<HTMLElement>('.tws-pick-row')?.focus();
    }
  };
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('.tws-pick-row')];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && at === 0) searchRef.current?.focus();
    else buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  const byType = scope.mode === 'byType';
  return (
    <div className="tws-pick" data-testid={`tws-chooser-${variant}`}>
      <div className="tws-pick-head">
        <h2 className="tws-pick-title">
          {variant === 'tab' ? 'Open a tab' : byType ? 'No open tabs for the selected types' : 'No open tabs'}
        </h2>
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
          placeholder={placeholderFor(scope, kinds)}
          aria-label="Search entities"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKey}
          data-testid="tws-chooser-search"
        />
      </label>
      <section className="tws-pick-section" aria-label={q ? 'Results' : 'Recent'}>
        <span className="t-eyebrow">{q ? 'Results' : 'Recent'}</span>
        {rows.length === 0 ? (
          <p className="tws-pick-empty">{q ? `No matches for “${query.trim()}”` : 'Nothing here yet.'}</p>
        ) : (
          <ul className="tws-pick-list" onKeyDown={onListKey}>
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="tws-pick-row"
                  onClick={() => openRow(row)}
                  title={`${row.title} — ${getKindAdapter(row.kind).noun}`}
                  data-testid="tws-chooser-row"
                >
                  <KindIcon kind={row.kind} size={14} />
                  <span className="tws-pick-row-title">{row.title}</span>
                  <span className="tws-pick-row-kind">{getKindAdapter(row.kind).noun}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {afterRecent}
      {creatable.length > 0 ? (
        <section className="tws-pick-section" aria-label="Create">
          <span className="t-eyebrow">Create</span>
          <div className="tws-pick-create">
            {creatable.map((adapter) => (
              <button
                key={adapter.kind}
                type="button"
                className="tws-pick-new"
                onClick={() => newDraft(adapter.kind)}
                data-testid={`tws-chooser-new-${adapter.kind}`}
              >
                <KindIcon kind={adapter.kind} size={14} />
                <span className="tws-pick-new-label">{`New ${adapter.noun.toLowerCase()}`}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
