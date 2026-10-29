import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import { classifyFailure } from '../authoring/commands';
import type { Seam } from '../data/seam';
import type { LoopsClient, LoopView } from './api';
import { absolute, relativeTime, runStatusChip } from './format';
import { LoopCreateButton, type LoopFormSources } from './LoopForm';
import { PREVIEW_DEBOUNCE_MS } from './SchedulePreview';
import { entityRefLabel, useEntityRef } from './use-entity-ref';
import './loops.css';

/*
 * THE LOOPS LIST (design 01a182d4 §6) — one row per loop, read from
 * `loops.list`, whose rows carry the server's schedule summary and run facts.
 * The generic entity list has no column concept, so the loop kind's registry
 * row selects this surface (`list.surface: 'loops'`).
 *
 * Nothing on a row is computed here: "next run" is the server's `nextRunAt`,
 * the schedule words are its `describeSchedule`, the Enabled switch is
 * `loops.enable`/`loops.disable` under the row's version.
 */

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; items: LoopView[]; nextCursor: string | null }
  | { phase: 'error'; message: string };

/** Re-read so "in 3 minutes" and a fresh last run do not go stale on an open screen. */
const REFRESH_MS = 60_000;
const PAGE = 100;

export function LoopsList({ spaceId, client, sources, onOpen }: {
  spaceId: SpaceId;
  client: LoopsClient | null;
  sources: LoopFormSources & Partial<Pick<Seam, 'entity'>>;
  onOpen(id: EntityId): void;
}) {
  const [state, setState] = useState<ListState>({ phase: 'loading' });
  const [words, setWords] = useState('');
  // The filter the server is asked for: the typed words once typing pauses.
  const [query, setQuery] = useState('');
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  // How many rows are on screen ("Show more" pages included), so a refresh re-reads them all.
  const span = useRef(0);
  const sequence = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(words.trim()), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [words]);

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
      setState({ phase: 'ready', items, nextCursor: page.nextCursor });
    } catch (error) {
      if (mine !== sequence.current) return;
      setState({ phase: 'error', message: error instanceof Error ? error.message : 'The loops could not be read.' });
    }
  }, [client, spaceId, query]);

  useEffect(() => {
    span.current = 0;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const more = async () => {
    if (!client || state.phase !== 'ready' || !state.nextCursor) return;
    const page = await client.list(spaceId, { ...(query ? { words: query } : {}), limit: PAGE, cursor: state.nextCursor });
    span.current = state.items.length + page.items.length;
    setState({ phase: 'ready', items: [...state.items, ...page.items], nextCursor: page.nextCursor });
  };

  const replace = (view: LoopView) => setState(current => current.phase === 'ready'
    ? { ...current, items: current.items.map(item => (item.id === view.id ? view : item)) }
    : current);

  const toggle = async (loop: LoopView) => {
    // One request per row at a time: a second click would carry a stale version.
    if (!client || pending.has(loop.id)) return;
    setRowError(null);
    setPending(current => new Set(current).add(loop.id));
    try {
      replace(await (loop.state.enabled ? client.disable(loop) : client.enable(loop)));
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
        <button type="button" className="pn-btn" onClick={() => void more()}>Show more</button>
      ) : null}
    </section>
  );
}

function LoopRow({ loop, sources, error, busy, onOpen, onToggle }: {
  loop: LoopView;
  sources: Partial<Pick<Seam, 'entity'>>;
  error: string | null;
  busy: boolean;
  onOpen(): void;
  onToggle(): void;
}) {
  const { definition, state, schedule, runs, capabilities } = loop;
  const last = runs.last;
  const chip = last ? runStatusChip(last.status) : null;
  const paused = state.pausedUntil && Date.parse(state.pausedUntil) > Date.now();
  return (
    <tr data-testid={`loop-row-${loop.id}`}>
      <td>
        <button type="button" className="loops-table__open" onClick={onOpen}>{definition.title}</button>
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
          : paused ? <span title={absolute(state.pausedUntil)}>Paused {relativeTime(state.pausedUntil)}</span>
            : state.nextRunAt ? <time dateTime={state.nextRunAt} title={absolute(state.nextRunAt, definition.timezone)}>{relativeTime(state.nextRunAt)}</time>
              : <span className="loop-form__muted">—</span>}
      </td>
      <td>
        {last && chip ? (
          <>
            <span className={`loop-chip loop-chip--${chip.tone}`}>{chip.label}</span>{' '}
            <time dateTime={last.firedAt} title={absolute(last.firedAt)}>{relativeTime(last.firedAt)}</time>
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

function RunsCell({ loop, sources }: { loop: LoopView; sources: Partial<Pick<Seam, 'entity'>> }) {
  const { action, teamMemberId, toolId } = loop.definition;
  // The sources object itself (stable across renders), so the ref read is not repeated.
  const reader = sources.entity ? (sources as Pick<Seam, 'entity'>) : null;
  const ref = useEntityRef(reader, action === 'spawn' ? teamMemberId : action === 'tool' ? toolId : null);
  if (action === 'dispatch') return <span className="loop-chip loop-chip--quiet">Dispatcher</span>;
  if (action === 'tool') return <span className="loops-table__tool">⚙ {entityRefLabel(ref, 'Tool')}</span>;
  return <span className="loop-chip loop-chip--person">{entityRefLabel(ref, 'Teammate')}</span>;
}
