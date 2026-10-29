import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import { classifyFailure } from '../authoring/commands';
import { Pill } from '../kit/Pill';
import { Timestamp } from '../kit/Timestamp';
import { isVersionConflict, type LoopsClient, type LoopView } from './api';
import { absolute, runStatusChip } from './format';
import { LoopCreateButton } from './LoopForm';
import { PREVIEW_DEBOUNCE_MS } from './SchedulePreview';
import type { LoopFormSources } from './sources';
import { entityRefLabel, useEntityRef } from './use-entity-ref';
import './loops.css';

/*
 * THE LOOPS LIST (design 01a182d4 §6) — one row per loop, read from
 * `loops.list`, whose rows carry the server's schedule summary and run facts.
 * The generic entity list has no column concept, so the loop kind's registry
 * row selects this surface (`list.surface: 'loops'`) on the desktop list.
 *
 * Nothing on a row is computed here: "next run" is the server's `nextRunAt`,
 * the schedule words are its `describeSchedule`, the Enabled switch is
 * `loops.enable`/`loops.disable` under the row's version.
 *
 * A ROW'S VERSION GOES STALE EVERY TIME ITS LOOP FIRES (the run bookkeeping
 * is part of the row), so the switch re-reads a loop it was refused for and
 * flips the fresh one — once, and only if it is still in the state the human
 * saw. And no read may land an older row over a newer one: rows merge by
 * version, whichever read finishes last.
 */

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; items: LoopView[]; nextCursor: string | null }
  | { phase: 'error'; message: string };

/** Re-read so "in 3 minutes" and a fresh last run do not go stale on an open screen. */
const REFRESH_MS = 60_000;
const PAGE = 100;

/** The newer of two reads of one loop: a late page must not undo a toggle that already landed. */
function newer(a: LoopView, b: LoopView | undefined): LoopView {
  return b && b.version > a.version ? b : a;
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export function LoopsList({ spaceId, client, sources, onOpen, selectedId = null }: {
  spaceId: SpaceId;
  client: LoopsClient | null;
  sources: LoopFormSources;
  onOpen(id: EntityId): void;
  /** The loop open in the detail pane, drawn as the selected row. */
  selectedId?: EntityId | null;
}) {
  const [state, setState] = useState<ListState>({ phase: 'loading' });
  const [words, setWords] = useState('');
  // The filter the server is asked for: the typed words once typing pauses.
  const [query, setQuery] = useState('');
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // A refresh that failed while rows were on screen: the rows stay, this says they may be stale.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  // How many rows are on screen ("Show more" pages included), so a refresh re-reads them all.
  const span = useRef(0);
  const sequence = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(words.trim()), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [words]);

  // Whether rows are on screen: a failed refresh then keeps them rather than replacing them with the error.
  const hasRows = useRef(false);
  hasRows.current = state.phase === 'ready';

  const load = useCallback(async () => {
    if (!client) return;
    const mine = ++sequence.current;
    try {
      const filter = query ? { words: query } : {};
      let page = await client.list(spaceId, { ...filter, limit: PAGE });
      const items = [...page.items];
      while (page.nextCursor && items.length < span.current) {
        page = await client.list(spaceId, { ...filter, limit: PAGE, cursor: page.nextCursor });
        items.push(...page.items);
      }
      if (mine !== sequence.current) return;
      span.current = items.length;
      setRefreshError(null);
      const nextCursor = page.nextCursor;
      setState(current => {
        const held = new Map(current.phase === 'ready' ? current.items.map(item => [item.id, item] as const) : []);
        return { phase: 'ready', items: items.map(item => newer(item, held.get(item.id))), nextCursor };
      });
    } catch (error) {
      if (mine !== sequence.current) return;
      const message = error instanceof Error ? error.message : 'The loops could not be read.';
      if (hasRows.current) setRefreshError(message);
      else setState({ phase: 'error', message });
    }
  }, [client, spaceId, query]);

  useEffect(() => {
    span.current = 0;
    void load();
    // No polling while the tab is hidden; coming back re-reads at once.
    const timer = setInterval(() => { if (!hidden()) void load(); }, REFRESH_MS);
    const onVisible = () => { if (!hidden()) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  const more = async () => {
    if (!client || state.phase !== 'ready' || !state.nextCursor || loadingMore) return;
    const mine = sequence.current;
    setLoadingMore(true);
    try {
      const page = await client.list(spaceId, { ...(query ? { words: query } : {}), limit: PAGE, cursor: state.nextCursor });
      // A refresh started meanwhile owns the list now; it re-reads the span it saw.
      if (mine !== sequence.current) return;
      setState(current => {
        if (current.phase !== 'ready') return current;
        const seen = new Set(current.items.map(item => item.id));
        const items = [...current.items, ...page.items.filter(item => !seen.has(item.id))];
        span.current = items.length;
        return { phase: 'ready', items, nextCursor: page.nextCursor };
      });
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : 'More loops could not be read.');
    } finally {
      setLoadingMore(false);
    }
  };

  const replace = (view: LoopView) => setState(current => current.phase === 'ready'
    ? { ...current, items: current.items.map(item => (item.id === view.id ? newer(view, item) : item)) }
    : current);

  const toggle = async (loop: LoopView) => {
    // One request per row at a time: a second click would carry a stale version.
    if (!client || pending.has(loop.id)) return;
    setRowError(null);
    setPending(current => new Set(current).add(loop.id));
    const flip = (target: LoopView) => (loop.state.enabled ? client.disable(target) : client.enable(target));
    try {
      try {
        replace(await flip(loop));
      } catch (error) {
        if (!isVersionConflict(error)) throw error;
        const fresh = await client.get(loop.id);
        // Someone else already flipped it, or changed it otherwise: show what is true, ask nothing of the server.
        if (fresh.state.enabled !== loop.state.enabled) {
          replace(fresh);
          setRowError({ id: loop.id, message: `Already ${fresh.state.enabled ? 'enabled' : 'disabled'} by someone else.` });
          return;
        }
        replace(await flip(fresh));
      }
    } catch (error) {
      setRowError({ id: loop.id, message: classifyFailure(error, 'save').cause });
      void load();
    } finally {
      setPending(current => { const next = new Set(current); next.delete(loop.id); return next; });
    }
  };

  return (
    <section className="loops-list" data-testid="loops-list" aria-label="Loops">
      <header className="loops-list__head">
        <h2 className="loops-list__title">Loops</h2>
        <input
          className="au-dialog__input loops-list__filter"
          type="search"
          aria-label="Filter loops"
          placeholder="Filter by name…"
          value={words}
          onChange={event => setWords(event.target.value)}
        />
        <LoopCreateButton
          spaceId={spaceId}
          client={client}
          sources={sources}
          onCreated={view => { void load(); onOpen(view.id); }}
        />
      </header>
      {!client ? <p className="loop-form__muted">This view has no loops client.</p> : null}
      {client && state.phase === 'loading' ? <p className="loop-form__muted">Loading loops…</p> : null}
      {state.phase === 'error' ? <p className="au-dialog__missing" role="alert">{state.message}</p> : null}
      {refreshError ? (
        <p className="au-dialog__missing" role="alert" data-testid="loops-refresh-error">
          Could not refresh: {refreshError}. The rows below are from the last read.
        </p>
      ) : null}
      {state.phase === 'ready' && state.items.length === 0 ? (
        <p className="loop-form__muted" data-testid="loops-empty">
          {query ? 'No loop matches that name.' : 'No loops yet. A loop runs a teammate, the Dispatcher or a tool on a schedule.'}
        </p>
      ) : null}
      {state.phase === 'ready' && state.items.length > 0 ? (
        <table className="loops-table">
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Runs</th>
              <th scope="col">Schedule</th>
              <th scope="col">Next run</th>
              <th scope="col">Last run</th>
              <th scope="col">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map(loop => (
              <LoopRow
                key={loop.id}
                loop={loop}
                sources={sources}
                selected={loop.id === selectedId}
                error={rowError?.id === loop.id ? rowError.message : null}
                busy={pending.has(loop.id)}
                onOpen={() => onOpen(loop.id)}
                onToggle={() => void toggle(loop)}
              />
            ))}
          </tbody>
        </table>
      ) : null}
      {state.phase === 'ready' && state.nextCursor ? (
        <button type="button" className="pn-btn" disabled={loadingMore} aria-busy={loadingMore || undefined} onClick={() => void more()}>
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      ) : null}
    </section>
  );
}

function LoopRow({ loop, sources, selected, error, busy, onOpen, onToggle }: {
  loop: LoopView;
  sources: LoopFormSources;
  selected: boolean;
  error: string | null;
  busy: boolean;
  onOpen(): void;
  onToggle(): void;
}) {
  const { definition, state, schedule, runs, capabilities } = loop;
  const last = runs.last;
  const chip = last ? runStatusChip(last.status) : null;
  // An expired pause reads as enabled: the server only skips firings before `pausedUntil`.
  const paused = state.pausedUntil && Date.parse(state.pausedUntil) > Date.now();
  // The run projection may not be filled yet; the loop's own `lastRunAt` still says when it last fired.
  const lastAt = last?.firedAt ?? state.lastRunAt;
  return (
    <tr data-testid={`loop-row-${loop.id}`} aria-selected={selected} className={selected ? 'loops-table__row--selected' : undefined}>
      <td>
        <button type="button" className="loops-table__open" aria-current={selected || undefined} onClick={onOpen}>{definition.title}</button>
        {state.lastError ? <span className="loops-table__error" title={state.lastError}> · last error</span> : null}
      </td>
      <td><RunsCell loop={loop} sources={sources} /></td>
      <td>
        {schedule.valid
          ? schedule.summary
          : <span className="loops-table__error">{schedule.problem ?? 'Unreadable schedule'}</span>}
      </td>
      <td>
        {!state.enabled ? <span className="loop-form__muted">Disabled</span>
          : paused ? <Timestamp at={state.pausedUntil} prefix="Paused · resumes" title="Paused until" />
            : state.nextRunAt ? <Timestamp at={state.nextRunAt} title={absolute(state.nextRunAt, definition.timezone)} />
              : <span className="loop-form__muted">—</span>}
      </td>
      <td>
        {lastAt ? (
          <>
            {chip ? <><Pill tone={chip.tone}>{chip.label}</Pill>{' '}</> : null}
            <Timestamp at={lastAt} />
          </>
        ) : <span className="loop-form__muted">Never</span>}
      </td>
      <td>
        <button
          type="button"
          role="switch"
          aria-checked={state.enabled}
          aria-label={`${state.enabled ? 'Disable' : 'Enable'} ${definition.title}`}
          className={`loop-switch${state.enabled ? ' loop-switch--on' : ''}`}
          aria-disabled={capabilities.canControl && !busy ? undefined : true}
          aria-busy={busy || undefined}
          title={capabilities.canControl ? undefined : 'You cannot enable or disable this loop.'}
          onClick={() => { if (capabilities.canControl && !busy) onToggle(); }}
        >
          <span className="loop-switch__knob" aria-hidden />
        </button>
        {error ? <span className="au-dialog__missing" role="alert">{error}</span> : null}
      </td>
    </tr>
  );
}

function RunsCell({ loop, sources }: { loop: LoopView; sources: LoopFormSources }) {
  const { action, teamMemberId, toolId } = loop.definition;
  // The sources object itself (stable across renders), so the ref read is not repeated.
  const reader = sources.entity ? (sources as Required<Pick<LoopFormSources, 'entity'>>) : null;
  const ref = useEntityRef(reader, action === 'spawn' ? teamMemberId : action === 'tool' ? toolId : null);
  if (action === 'dispatch') return <Pill tone="idle">Dispatcher</Pill>;
  if (action === 'tool') return <span className="loops-table__tool">⚙ {entityRefLabel(ref, 'Tool')}</span>;
  return <span className="loop-chip loop-chip--person">{entityRefLabel(ref, 'Teammate')}</span>;
}
