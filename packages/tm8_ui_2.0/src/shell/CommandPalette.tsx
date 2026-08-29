import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EntitySummary } from '@tm8/contract';
import type { ActionContext, ActionRef } from '../domain';
import { KindIcon, deferredActions, getKind, resolveAction } from '../domain';
import { ReasonNote } from '../panels/honesty/ReasonNote';
import './palette.css';

/**
 * THE COMMAND PALETTE (T1-2) — "/ or ⌘K · entities + views + actions ·
 * deferred features stay visible, labeled, unclickable."
 *
 * GROUP ORDER IS FIXED, and it is a ranking of usefulness rather than a
 * layout choice: ENTITIES (the thing you were looking for) → VIEWS (where to
 * go) → ACTIONS (what to do) → NOT AVAILABLE YET.
 *
 * THE QUERY FILTERS EVERY GROUP, AND THE SPLIT IS DELIBERATE. Entity rows
 * arrive already matched — the seam `query()` read owns entity search, and
 * this component renders what it is given (see the omission rule below for
 * why re-filtering upstream results would be worse than redundant). Views and
 * actions have no seam: they are static props, so THIS component matches them,
 * by case-insensitive substring on the label. Before this split existed the
 * input filtered entities only, every static row stayed put, and Enter opened
 * the first UNFILTERED view — type "task", get Home (palette audit #1). The
 * cursor resets to the top on every keystroke, so Enter always targets the
 * first row of the FILTERED navigable set.
 *
 * THE DISCOVERY ROW IS POLICY, NOT DECORATION (R7). Deferred features render
 * muted with their reason inline; arrow keys SKIP them and clicks do nothing.
 * That combination is the whole design: the user learns what exists without
 * being lied to, and without a dead row stealing their Enter key. Every one of
 * those rows is derived from `deferredActions()` — the registry's own
 * permanently-disabled action set — so this file maintains no second list that
 * could drift out of sync with the real availability rules.
 *
 * THE DISCOVERY GROUP OPENS COLLAPSED (palette audit #3). Fifteen-odd
 * permanently-dead rows on every open buried the live ones under choice the
 * user could not act on, so the group renders as ONE summary row — "N not
 * available yet ▸" — that expands on click or on arrowing into it from the
 * last enabled row. The count and the expanded rows read from the SAME
 * derived list, so the collapse hides nothing the registry did not declare,
 * and the query filters that list like any other group: a search that matches
 * a deferred feature keeps it one gesture from sight, and a search that
 * matches nothing at all is allowed to say so.
 *
 * THE SEARCH SURFACE IS THE PALETTE ITSELF: a full search-results view is
 * deferred (R7), and its disabled home is the footer affordance below.
 *
 * PERMISSION-LOST ENTITIES ARE OMITTED from results entirely — never shown as
 * a locked row. Their existence-in-a-result-list is itself a leak, so the
 * omission happens upstream in the query, and this component simply renders
 * what it is given.
 */

export interface PaletteView {
  id: string;
  label: string;
  glyph?: ReactNode;
  /** Absent ⇒ the view is implemented and openable. */
  disabledReason?: string;
}

export interface CommandPaletteProps {
  open: boolean;
  /** Fuzzy matches from the seam `query()` read — the consensus palette path. */
  results: readonly EntitySummary[];
  views: readonly PaletteView[];
  /** Contextual verbs for the current selection. */
  actions?: readonly ActionRef[];
  ctx: ActionContext;
  /** Status word per entity, when it has one (the registry supplies it). */
  statusOf?: (entity: EntitySummary) => { word: string; tone: string } | null;
  onQueryChange?: (q: string) => void;
  onOpenEntity?: (id: string) => void;
  onOpenView?: (id: string) => void;
  onRunAction?: (ref: ActionRef) => void;
  onDismiss?: () => void;
}

type Row =
  | { kind: 'entity'; id: string; label: string; glyph: ReactNode; meta?: string; disabled?: never }
  | { kind: 'view'; id: string; label: string; glyph: ReactNode; meta?: string; disabled?: string }
  | { kind: 'action'; id: ActionRef; label: string; glyph: ReactNode; meta?: string; disabled?: string };

const GROUPS: readonly { key: string; label: string }[] = [
  { key: 'entity', label: 'ENTITIES' },
  { key: 'view', label: 'VIEWS' },
  { key: 'action', label: 'ACTIONS' },
  { key: 'deferred', label: 'NOT AVAILABLE YET' },
];

export function CommandPalette({
  open,
  results,
  views,
  actions = [],
  ctx,
  statusOf,
  onQueryChange,
  onOpenEntity,
  onOpenView,
  onRunAction,
  onDismiss,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  /** Audit #3: the deferred group starts collapsed on EVERY open. */
  const [deferredOpen, setDeferredOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { rows, deferred } = useMemo(
    () => buildRows(results, views, actions, ctx, query),
    [results, views, actions, ctx, query],
  );

  /** Only ENABLED rows are navigable — a disabled row must never eat Enter. */
  const navigable = rows.filter((r) => !r.disabled);

  useEffect(() => {
    if (open) {
      setCursor(0);
      setDeferredOpen(false);
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const activate = (row: Row | undefined) => {
    if (!row || row.disabled) return;
    if (row.kind === 'entity') onOpenEntity?.(row.id);
    else if (row.kind === 'view') onOpenView?.(row.id);
    else onRunAction?.(row.id);
    onDismiss?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // consumed here: Esc closes THIS surface only
      onDismiss?.();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      /* ARROW-INTO EXPANDS (audit #3): Down from the last enabled row opens
         the collapsed discovery group instead of moving nowhere. The cursor
         stays where it is — the revealed rows are disabled and the skip law
         still holds — so the gesture spends itself on revealing, never on a
         selection change the user did not ask for. */
      if (cursor >= navigable.length - 1 && !deferredOpen && deferred.length > 0) {
        setDeferredOpen(true);
        return;
      }
      setCursor((c) => Math.min(c + 1, Math.max(navigable.length - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      activate(navigable[cursor]);
    }
  };

  const selected = navigable[cursor];

  return (
    <div className="pal-scrim" data-testid="command-palette-scrim" onMouseDown={onDismiss}>
      <div
        className="pal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="pal__input-row">
          <span className="pal__icon" aria-hidden>
            ⌕
          </span>
          <input
            ref={inputRef}
            className="pal__input"
            value={query}
            /* F-1: the canvas never draws an EMPTY input, so there is no frozen
               placeholder string. Authored to name all three groups, so the
               palette's scope is discoverable before the first keystroke. */
            placeholder="Search entities, views and actions…"
            aria-label="Search entities, views and actions"
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
              onQueryChange?.(e.target.value);
            }}
          />
          <kbd className="pal__esc">esc</kbd>
        </div>

        <div className="pal__results" role="listbox" aria-label="Results">
          {rows.length === 0 && deferred.length === 0 ? (
            <p className="pal__empty">
              {query ? `No matches for “${query}”.` : 'Start typing to search this space.'}
            </p>
          ) : null}

          {GROUPS.map((group) => {
            const groupRows =
              group.key === 'deferred' ? deferred : rows.filter((r) => r.kind === group.key);
            if (groupRows.length === 0) return null;
            if (group.key === 'deferred' && !deferredOpen) {
              /* The whole group behind one live row (audit #3). No group
                 header: the row carries the group's identity and its derived
                 count, and it is a CONTROL — clickable, hover-lit — never a
                 disabled row pretending to be one. */
              return (
                <div
                  key={group.key}
                  className="pal__row pal__row--deferred-summary"
                  role="button"
                  tabIndex={-1}
                  aria-expanded="false"
                  aria-label={`Show ${groupRows.length} features that are not available yet`}
                  data-testid="palette-deferred-summary"
                  onClick={() => setDeferredOpen(true)}
                >
                  <span className="pal__row-label">{groupRows.length} not available yet</span>
                  <span className="pal__spacer" />
                  <span className="pal__row-hint" aria-hidden>
                    ▸
                  </span>
                </div>
              );
            }
            return (
              <div key={group.key}>
                <div className="pal__group">{group.label}</div>
                {groupRows.map((row) => (
                  <PaletteRow
                    key={`${row.kind}:${row.id}`}
                    row={row}
                    selected={row === selected}
                    statusOf={statusOf}
                    results={results}
                    onActivate={() => activate(row)}
                  />
                ))}
              </div>
            );
          })}
        </div>

        <div className="pal__footer">
          <span>↑↓ navigate</span>
          <span>⏎ open</span>
          <span>⌘⏎ open + pin</span>
          <span className="pal__spacer" />
          {/* R7's named home for the deferred search-results view. The palette
              IS the search surface; the full view is honestly unavailable, and
              the reason comes from the registry rather than being restated. */}
          <span className="pal__footer-deferred" title={searchResultsReason(ctx)}>
            open full results — not available yet
          </span>
        </div>
      </div>
    </div>
  );
}

function PaletteRow({
  row,
  selected,
  statusOf,
  results,
  onActivate,
}: {
  row: Row;
  selected: boolean;
  statusOf?: CommandPaletteProps['statusOf'];
  results: readonly EntitySummary[];
  onActivate: () => void;
}) {
  const entity = row.kind === 'entity' ? results.find((r) => r.id === row.id) : undefined;
  const status = entity && statusOf ? statusOf(entity) : null;

  if (row.disabled) {
    return (
      <div
        className="pal__row pal__row--disabled"
        data-testid="palette-disabled-row"
        aria-disabled="true"
      >
        <span className="pal__row-glyph" aria-hidden>
          {row.glyph}
        </span>
        <span className="pal__row-label">{row.label}</span>
        <span className="pal__spacer" />
        {/* The reason is INLINE and right-aligned, not a tooltip: a row the
            keyboard skips would never surface a hover-only explanation.

            BUT THE INLINE FORM IS NOT THE WHOLE REASON. `shortReason` keeps only
            the text before the first `:` or em-dash, and falls back to the
            generic "not available yet" once that head passes 40 characters — so
            the REMEDY half was dropped on every platform, and a long cause
            degraded to a placeholder carrying nothing at all. The full sentence
            lived only in `title`, which renders on hover and nowhere else.
            Wrapping the short form in `ReasonNote` keeps the glanceable line
            exactly as it was and makes the whole reason reachable by hover,
            focus OR tap. */}
        <ReasonNote
          className="pal__row-reason"
          reason={row.disabled}
          label={`${row.label} — why it is unavailable`}
          testid="palette-disabled-reason"
        >
          {shortReason(row.disabled)}
        </ReasonNote>
      </div>
    );
  }

  return (
    <div
      className={selected ? 'pal__row pal__row--selected' : 'pal__row'}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-testid="palette-row"
      onClick={onActivate}
    >
      <span className="pal__row-glyph" aria-hidden>
        {row.glyph}
      </span>
      <span className="pal__row-label">{row.label}</span>
      {row.meta ? <span className="pal__row-meta">{row.meta}</span> : null}
      {status ? <span className={`pal__row-status kit-pill--${status.tone}`}>{status.word}</span> : null}
      {selected ? (
        <span className="pal__row-hint" aria-hidden>
          ⏎
        </span>
      ) : null}
    </div>
  );
}

function buildRows(
  results: readonly EntitySummary[],
  views: readonly PaletteView[],
  actions: readonly ActionRef[],
  ctx: ActionContext,
  query: string,
): { rows: Row[]; deferred: Row[] } {
  const rows: Row[] = [];
  const deferred: Row[] = [];

  /* Views, actions and discovery rows match HERE, on the label, because they
     have no seam to match them upstream. Entities are exempt on purpose: the
     seam already matched them (and owns how — fuzziness included), so a second
     literal filter could only disagree with it. */
  const q = query.trim().toLowerCase();
  const matches = (label: string) => q === '' || label.toLowerCase().includes(q);

  for (const entity of results) {
    rows.push({
      kind: 'entity',
      id: entity.id,
      label: entity.title,
      glyph: <KindIcon kind={entity.kind} />,
      meta: getKind(entity.kind).label,
    });
  }

  for (const view of views) {
    if (!matches(view.label)) continue;
    const row: Row = { kind: 'view', id: view.id, label: view.label, glyph: view.glyph ?? '⊙', meta: 'view' };
    if (view.disabledReason) deferred.push({ ...row, disabled: view.disabledReason });
    else rows.push(row);
  }

  for (const ref of actions) {
    const def = resolveAction(ref);
    if (!matches(def.label)) continue;
    const availability = def.availability(ctx);
    const row: Row = { kind: 'action', id: ref, label: def.label, glyph: def.icon };
    if (availability.kind === 'disabled') deferred.push({ ...row, disabled: availability.reason });
    else rows.push(row);
  }

  /**
   * The R7 discovery rows, DERIVED. `deferredActions()` is the registry's own
   * permanently-disabled set, so this list cannot drift from the availability
   * rules the rest of the app enforces — which is exactly what a hand-kept
   * second list of "coming soon" features always does. The query filter
   * applies to these like any other non-entity row: discovery means findable,
   * not immune to the search the user just typed.
   */
  const already = new Set(deferred.map((d) => d.id));
  for (const def of deferredActions()) {
    if (already.has(def.id)) continue;
    if (!matches(def.label)) continue;
    const availability = def.availability(ctx);
    deferred.push({
      kind: 'action',
      id: def.id,
      label: def.label,
      glyph: def.icon,
      disabled: availability.kind === 'disabled' ? availability.reason : 'not available yet',
    });
  }

  return { rows, deferred };
}

/** The inline reason is one narrow column; the full sentence stays on title. */
function shortReason(reason: string): string {
  const head = reason.split(/[:—]/)[0]?.trim();
  return head && head.length > 0 && head.length < 40 ? head.toLowerCase() : 'not available yet';
}

/**
 * The deferred search-results view's own reason, read from the action
 * registry — never a second copy of the sentence.
 */
function searchResultsReason(ctx: ActionContext): string {
  const availability = resolveAction('search-results').availability(ctx);
  return availability.kind === 'disabled' ? availability.reason : '';
}
