/**
 * THE ATTENTION LIST (Attention v2, chapter 4 "Top bar"): one row per roll-up
 * root, with a `Personal · n` / `Team · n` filter on top (Personal = assigned
 * to you; Team = everything pending in the space, which everyone can see). The same component is
 * the top-bar popover, the empty right column, and (S5b) the phone sheet,
 * Home NEEDS YOU and the empty centre.
 *
 * - The filter defaults to Personal when anything is yours, else Team.
 * - Open goes where the request came from (`openTargetOf`): the raising
 *   session or chat, or the form / thing a tm8 signal is about.
 * - Actionable is the default; an explicit FYI view keeps informational requests available.
 * - Order comes from the store: level first, then unseen, points, age. Rows
 *   the viewer has seen are dimmed.
 * - Each row: chip, title, type tag, highest priority reason, then
 *   `via session #… · persona · age · assigned to you`.
 * - Row actions: Open, Seen, Resolve. Resolve opens a one-line optional note
 *   inline, then settles; the row leaves in place and the shell's toast offers
 *   Undo. There is no Decline and no Snooze (Q4, Q8), and no row cap.
 */
import { useEffect, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { useAttention } from './attention-store';
import type { AttentionFilter, AttentionQueueRow, AttentionScope } from './attention-selectors';
import { formatAge, isActionable, openTargetOf } from './attention-selectors';
import { AttentionChipView } from './AttentionChipView';
import './attention-v2.css';

export interface AttentionListProps {
  /** Start on this filter instead of the default (Mine when mine > 0). */
  filter?: AttentionFilter;
  /** `targetId` is `openTargetOf(row.primary)`, which may differ from the root. */
  onOpen(targetId: EntityId, row: AttentionQueueRow): void;
  /** Names the host already holds, consulted before the store's hydration. */
  nameOf?(id: EntityId): { title: string } | undefined;
  /** Heading; defaults to "Needs you". */
  title?: string;
  className?: string;
}

/** `#a41f`: the short handle chapter 4 uses for a session. */
export function shortHandle(id: string): string {
  return `#${id.replace(/-/g, '').slice(-4)}`;
}

export function AttentionList({ filter: initial, onOpen, nameOf, title = 'Needs you', className }: AttentionListProps) {
  const api = useAttention();
  const actionableCounts = api.counts();
  const fyiCounts = api.counts('fyi');
  const [scope, setScope] = useState<Exclude<AttentionScope, 'all'>>('actionable');
  const counts = scope === 'actionable' ? actionableCounts : fyiCounts;
  const [chosen, setChosen] = useState<AttentionFilter | null>(initial ?? null);
  const filter: AttentionFilter = chosen ?? (actionableCounts.mine > 0 ? 'mine' : 'all');
  const rows = api.queue(filter, scope);
  const now = Date.now();

  return (
    <div className={['att-list', className].filter(Boolean).join(' ')} data-testid="attention-list">
      <header className="att-list__head">
        <b className="att-list__title">{title}</b>
        <div className="att-list__filter" role="group" aria-label="Show">
          {(['mine', 'all'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={filter === key ? 'att-list__f att-list__f--on' : 'att-list__f'}
              aria-pressed={filter === key}
              data-testid={`attention-filter-${key}`}
              onClick={() => setChosen(key)}
            >
              {key === 'mine' ? `Personal · ${counts.mine}` : `Team · ${counts.all}`}
            </button>
          ))}
        </div>
      </header>
      <div className="att-list__triage">
        <div className="att-list__scope" role="group" aria-label="Request type">
          {(['actionable', 'fyi'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={scope === key ? 'att-list__f att-list__f--on' : 'att-list__f'}
              aria-pressed={scope === key}
              data-testid={`attention-scope-${key}`}
              onClick={() => setScope(key)}
            >
              {key === 'actionable' ? `Action needed · ${actionableCounts[filter]}` : `FYI · ${fyiCounts[filter]}`}
            </button>
          ))}
        </div>
        <p className="att-list__order" data-testid="attention-priority-explanation">
          {scope === 'actionable'
            ? 'Urgent, high, then normal. Within each priority: unseen, points, then oldest.'
            : 'FYI is informational and does not count as action needed.'}
          {' Counts are work items.'}
        </p>
      </div>
      {api.refreshError ? (
        <p className="att-list__empty" role="status" data-testid="attention-list-stale">
          Attention could not be refreshed. Showing the last loaded work items.{' '}
          <button type="button" className="att-list__act" onClick={api.refresh}>Retry</button>
        </p>
      ) : null}
      {api.status === 'error' ? (
        <p className="att-list__empty" data-testid="attention-list-error">
          Attention could not be loaded. It will retry on the next change.
        </p>
      ) : api.status === 'loading' ? (
        <p className="att-list__empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="att-list__empty" data-testid="attention-list-empty">
          {filter === 'mine' && (counts.all > 0 || fyiCounts.all > 0) ? 'Nothing assigned to you in this view. Try Team.'
            : scope === 'fyi' ? 'No FYI requests in this view.'
              : fyiCounts[filter] > 0 ? 'No action needed. Informational requests are available in FYI.' : 'Nothing needs anyone.'}
        </p>
      ) : (
        <ul className="att-list__rows">
          {rows.map((row) => (
            <AttentionListRow
              key={row.rootId}
              row={row}
              now={now}
              title={nameOf?.(row.rootId)?.title ?? row.title}
              onOpen={() => {
                void api.markSeen(row.rootId);
                onOpen(openTargetOf(row.primary), row);
              }}
              onSeen={() => void api.markSeen(row.rootId)}
              onResolve={(note) => void api.resolve(row.rootId, note)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AttentionListRow(props: {
  row: AttentionQueueRow;
  title: string | null;
  now: number;
  onOpen(): void;
  onSeen(): void;
  onResolve(note: string): void;
}) {
  const { row, title, now } = props;
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (noting) input.current?.focus();
  }, [noting]);

  const primary = row.primary;
  const source = primary.origin !== 'system' && primary.sourceWorkSessionId
    ? `via session ${shortHandle(primary.sourceWorkSessionId)}`
    : primary.entityId !== row.rootId ? `via ${shortHandle(primary.entityId)}` : null;
  const actionable = row.requests.filter(isActionable).length;
  const fyi = row.requests.length - actionable;
  const facts = [
    source,
    primary.requestedBy.displayName,
    formatAge(primary.createdAt, now),
    row.mine ? 'includes an assignment to you' : null,
  ].filter(Boolean).join(' · ');

  return (
    <li
      className={row.seen ? 'att-list__row att-list__row--seen' : 'att-list__row'}
      data-testid="attention-list-row"
      data-root={row.rootId}
      data-seen={row.seen || undefined}
    >
      <AttentionChipView chip={row.chip} now={now} />
      <div className="att-list__body">
        <div className="att-list__line">
          {/* The title opens too: a click on the row's name doing nothing read
              as "the attention item does not open" (task 01a112b9). */}
          <button
            type="button"
            className={title ? 'att-list__name' : 'att-list__name att-list__name--raw'}
            title={title ?? row.rootId}
            data-testid="attention-open-title"
            onClick={props.onOpen}
          >
            {title ?? row.rootId}
          </button>
          <span className="att-list__type">{primary.actionType ?? 'decide'}</span>
        </div>
        <div className="att-list__priority" data-testid="attention-row-priority">
          {row.chip.level === 'fyi' ? 'FYI' : `${row.chip.level[0]!.toUpperCase()}${row.chip.level.slice(1)} priority`}
          {` · ${actionable} actionable · ${fyi} FYI`}
        </div>
        <div className="att-list__reason" title={primary.reason}>{primary.reason}</div>
        <div className="att-list__facts">{facts}</div>
        {noting ? (
          <p className="att-list__order" data-testid="attention-resolve-scope">
            Resolves all {row.requests.length} pending {row.requests.length === 1 ? 'request' : 'requests'} on this work item, including FYI and other assignees.
          </p>
        ) : null}
        {noting ? (
          <form
            className="att-list__note"
            onSubmit={(event) => {
              event.preventDefault();
              setNoting(false);
              props.onResolve(note);
            }}
          >
            <input
              ref={input}
              className="att-list__input"
              value={note}
              placeholder="Note for the agent (optional)"
              aria-label="Resolution note (optional)"
              data-testid="attention-resolve-note"
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setNoting(false);
                }
              }}
            />
            <button type="submit" className="att-list__act att-list__act--go" data-testid="attention-resolve-confirm">
              Resolve
            </button>
          </form>
        ) : null}
      </div>
      {noting ? null : (
        <div className="att-list__acts">
          <button type="button" className="att-list__act" data-testid="attention-open" onClick={props.onOpen}>Open</button>
          {row.seen ? null : (
            <button type="button" className="att-list__act" data-testid="attention-seen" onClick={props.onSeen}>Seen</button>
          )}
          <button type="button" className="att-list__act" data-testid="attention-resolve" onClick={() => setNoting(true)}>
            Resolve
          </button>
        </div>
      )}
    </li>
  );
}
