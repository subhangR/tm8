/**
 * THE ATTENTION LIST (Attention v2, chapter 4 "Top bar"): one row per roll-up
 * root, with a `Mine · n` / `All · n` filter on top. The same component is
 * the top-bar popover, the empty right column, and (S5b) the phone sheet,
 * Home NEEDS YOU and the empty centre.
 *
 * - The filter defaults to Mine when anything is mine, else All.
 * - Order comes from the store: unseen first, then level, points, age. Rows
 *   the viewer has seen are dimmed.
 * - Each row: chip, title, type tag, latest reason, then
 *   `via session #… · persona · age · assigned to you`.
 * - Row actions: Open, Seen, Resolve. Resolve opens a one-line optional note
 *   inline, then settles; the row leaves in place and the shell's toast offers
 *   Undo. There is no Decline and no Snooze (Q4, Q8), and no row cap.
 */
import { useEffect, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { useAttention } from './attention-store';
import type { AttentionFilter, AttentionQueueRow } from './attention-selectors';
import { formatAge } from './attention-selectors';
import { AttentionChipView } from './AttentionChipView';
import './attention-v2.css';

export interface AttentionListProps {
  /** Start on this filter instead of the default (Mine when mine > 0). */
  filter?: AttentionFilter;
  onOpen(rootId: EntityId): void;
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
  const counts = api.counts();
  const [chosen, setChosen] = useState<AttentionFilter | null>(initial ?? null);
  const filter: AttentionFilter = chosen ?? (counts.mine > 0 ? 'mine' : 'all');
  const rows = api.queue(filter);
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
              {key === 'mine' ? `Mine · ${counts.mine}` : `All · ${counts.all}`}
            </button>
          ))}
        </div>
      </header>
      {api.status === 'loading' ? (
        <p className="att-list__empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="att-list__empty" data-testid="attention-list-empty">
          {filter === 'mine' && counts.all > 0 ? 'Nothing assigned to you. Try All.' : 'Nothing needs anyone.'}
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
                onOpen(row.rootId);
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

  const latest = row.latest;
  const source = latest.sourceWorkSessionId
    ? `via session ${shortHandle(latest.sourceWorkSessionId)}`
    : latest.entityId !== row.rootId ? `via ${shortHandle(latest.entityId)}` : null;
  const facts = [
    source,
    latest.requestedBy.displayName,
    formatAge(latest.createdAt, now),
    row.mine ? 'assigned to you' : null,
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
          <span className={title ? 'att-list__name' : 'att-list__name att-list__name--raw'}>{title ?? row.rootId}</span>
          <span className="att-list__type">{latest.actionType ?? 'decide'}</span>
        </div>
        <div className="att-list__reason" title={latest.reason}>{latest.reason}</div>
        <div className="att-list__facts">{facts}</div>
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
