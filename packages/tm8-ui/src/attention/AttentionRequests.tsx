/**
 * ATTENTION REQUESTS — one entity's full escalation record, as a section that
 * every entity detail page carries.
 *
 * WHAT THIS EXISTS TO FIX. `attention_requests` has always retained its rows:
 * resolving is a status flip, never a delete (migration 050:208-212), so the
 * reason, the score, the requester and the resolution note all survive. None of
 * that was reachable from the UI. The badge shows a live count and drops the
 * moment somebody opens the entity — and `views/open-entity.ts:60` opens by
 * bulk-resolving — so the product's answer to "what was escalated here, and who
 * decided what about it" was `tm8 attention list --entity <id>` and nothing else.
 *
 * IT IS A HISTORY FIRST, AND THAT IS A RULING, NOT AN OVERSIGHT. Auto-resolve-
 * on-open stays (user ruling 2026-08-16), so by the time this section renders,
 * rows that were pending a second ago usually say `Resolved · you · now`. The
 * section is honest about that rather than pretending to be a live queue: the
 * eyebrow states pending and settled counts separately, and the footnote says
 * out loud that opening the page is what settled them. Hiding that would make
 * the surface look broken to anyone who read the badge first.
 *
 * IT STILL WRITES, because two of the four statuses had no UI path at all.
 * `dismissed` in particular was unreachable — a whole quarter of the enum that
 * only the CLI could produce — so a request could be satisfied but never
 * declined. Rows that are still pending carry Resolve and Decline, each with an
 * optional note.
 *
 * KIND-AGNOSTIC BY CONSTRUCTION. Attention is defined on `entities`, so this
 * names no kind and takes no registry row; §15.2's ban on kind literals is not
 * a constraint it has to work around. The host decides WHERE it mounts, which
 * is the one thing that does vary — see `views/attentionSurface.tsx`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttentionRequest, AttentionRequestStatus, EntityId } from '@tm8/contract';
import { Eyebrow } from '../kit/Eyebrow';
import {
  isPending,
  orderHistory,
  settlementLine,
  STATUS_LABEL,
  summarizeHistory,
  timeAgo,
} from './attention-history';
import type { AttentionPort } from './port';
import './attention.css';

export interface AttentionRequestsProps {
  entityId: EntityId;
  port: AttentionPort;
  /**
   * A settlement landed. The host refetches the entity so the BADGE catches up
   * — this section owns its own rows and reloads them itself, but the count in
   * the list rail is the host's cache and would otherwise keep the old number.
   */
  onSettled?: () => void;
  /** Test seam: injected rows skip the fetch entirely. */
  rows?: readonly AttentionRequest[];
  /** Test seam: pins relative times. Real renders use the wall clock. */
  now?: string;
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; rows: readonly AttentionRequest[]; truncated: boolean }
  | { phase: 'error'; message: string };

export function AttentionRequests(props: AttentionRequestsProps) {
  const { entityId, port, rows: injected, now } = props;
  const [state, setState] = useState<LoadState>(
    injected ? { phase: 'ready', rows: injected, truncated: false } : { phase: 'loading' },
  );
  /** Which row has its note field open, and for which outcome. */
  const [drafting, setDrafting] = useState<{ id: string; status: AttentionRequestStatus } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * A write that failed. Kept OUT of `state` on purpose: a failed settlement
   * must not blank the history that is already on screen, which is exactly what
   * moving to the error phase would do.
   */
  const [writeError, setWriteError] = useState<string | null>(null);
  const live = useRef(true);

  const load = useCallback(
    (mode: 'initial' | 'refresh') => {
      if (injected) return;
      if (mode === 'initial') setState({ phase: 'loading' });
      port.history(entityId).then(
        ({ rows, truncated }) => {
          if (!live.current) return;
          setState({ phase: 'ready', rows, truncated });
        },
        (error: unknown) => {
          if (!live.current) return;
          const message = String((error as { message?: string })?.message ?? error);
          // A REFRESH that fails leaves the rows in place and reports itself as
          // a write-side problem. Only the first load has nothing to preserve.
          if (mode === 'refresh') setWriteError(`Could not reload: ${message}`);
          else setState({ phase: 'error', message });
        },
      );
    },
    [entityId, port, injected],
  );

  useEffect(() => {
    live.current = true;
    load('initial');
    return () => { live.current = false; };
  }, [load]);

  const settle = useCallback(
    (row: AttentionRequest, status: AttentionRequestStatus, note: string) => {
      setBusy(row.id);
      setWriteError(null);
      port
        .settle({
          requestId: row.id,
          expectedVersion: row.version,
          status,
          resolutionNote: note.trim() || undefined,
        })
        .then(
          () => {
            if (!live.current) return;
            setBusy(null);
            setDrafting(null);
            // Refetch rather than patch in place: the bulk resolve can settle
            // SIBLING rows behind this one, so the local copy of everything
            // else is suspect too, not just the row that was written.
            load('refresh');
            props.onSettled?.();
          },
          (error: unknown) => {
            if (!live.current) return;
            setBusy(null);
            const code = (error as { code?: string })?.code;
            setWriteError(
              code === 'version_conflict'
                ? 'This request changed while you were looking at it — reloading.'
                : String((error as { message?: string })?.message ?? error),
            );
            // A conflict is not a dead end: the row moved, so re-read it. The
            // usual cause is benign — opening this page bulk-resolved the queue.
            if (code === 'version_conflict') load('refresh');
          },
        );
    },
    [load, port, props.onSettled],
  );

  // LOADING AND EMPTY BOTH RENDER NOTHING, and for the same reason: this
  // section is mounted on every entity in the product, and the overwhelming
  // majority have never been escalated (user ruling — hide when empty). A
  // spinner would flash a box onto every page in the app for one frame.
  if (state.phase === 'loading') return null;

  if (state.phase === 'error') {
    return (
      <section className="pn-section att-req" data-testid="attention-requests">
        <Eyebrow faint>Attention requests</Eyebrow>
        <p className="att-req__error">Attention history could not be loaded.</p>
        <p className="att-req__error-detail">{state.message}</p>
      </section>
    );
  }

  if (state.rows.length === 0) return null;

  const ordered = orderHistory(state.rows);
  const summary = summarizeHistory(state.rows);

  return (
    <section className="pn-section att-req" data-testid="attention-requests">
      <Eyebrow faint>
        {summary.pendingCount > 0
          ? `Attention requests · ${summary.pendingCount} waiting · ${summary.pendingPoints} points`
          : `Attention requests · ${summary.total} settled`}
      </Eyebrow>

      {writeError ? (
        <p className="att-req__notice" role="status" data-testid="attention-write-error">
          {writeError}
        </p>
      ) : null}

      <ul className="att-req__list">
        {ordered.map((row) => (
          <HistoryRow
            key={row.id}
            row={row}
            now={now}
            busy={busy === row.id}
            drafting={drafting?.id === row.id ? drafting.status : null}
            onDraft={(status) => setDrafting(status ? { id: row.id, status } : null)}
            onConfirm={(note) => {
              if (drafting?.id === row.id) settle(row, drafting.status, note);
            }}
          />
        ))}
      </ul>

      {state.truncated ? (
        <p className="att-req__more">
          Showing the {ordered.length} highest-scored requests — this entity has more.
        </p>
      ) : null}

      {/* THE FOOTNOTE IS LOAD-BEARING. Without it, a reader who just saw a
          NEEDS ATTENTION badge finds every row marked resolved-by-them and
          concludes the surface is lying. It is not: opening the page is the
          thing that resolved them (`views/open-entity.ts`). Only shown when
          there is a settled row to explain. */}
      {summary.settledCount > 0 ? (
        <p className="att-req__footnote">
          Opening an entity resolves whatever was waiting on it, so requests may be
          settled here by the act of reading them.
        </p>
      ) : null}
    </section>
  );
}

function HistoryRow(props: {
  row: AttentionRequest;
  now?: string;
  busy: boolean;
  /** Non-null while this row's note field is open, carrying the pending outcome. */
  drafting: AttentionRequestStatus | null;
  onDraft(status: AttentionRequestStatus | null): void;
  onConfirm(note: string): void;
}) {
  const { row, now, busy, drafting } = props;
  const [note, setNote] = useState('');
  const pending = isPending(row);
  const settled = settlementLine(row, now);

  return (
    <li className="att-req__row" data-status={row.status} data-testid={`attention-request-${row.id}`}>
      <span
        className="att-req__points"
        title={`${row.points} of 100`}
        aria-label={`${row.points} points`}
      >
        {row.points}
      </span>

      <div className="att-req__body">
        <p className="att-req__reason">{row.reason}</p>

        <p className="att-req__meta">
          <span className="att-req__status" data-status={row.status}>
            {STATUS_LABEL[row.status]}
          </span>
          <span className="att-req__by">
            {`Requested by ${row.requestedBy.displayName} · ${timeAgo(row.createdAt, now)}`}
          </span>
          {settled ? <span className="att-req__by">{settled}</span> : null}
        </p>

        {/* A note is the only free text a resolver leaves behind; showing it is
            most of the reason to keep settled rows at all. */}
        {row.resolutionNote ? (
          <p className="att-req__note">{row.resolutionNote}</p>
        ) : null}

        {pending && drafting === null ? (
          <p className="att-req__actions">
            <button
              type="button"
              className="att-req__act"
              disabled={busy}
              onClick={() => props.onDraft('resolved')}
              data-testid={`attention-resolve-${row.id}`}
            >
              Resolve
            </button>
            {/* DECLINE writes `dismissed`. Spelled as a decision rather than a
                dismissal so it does not read as a synonym for Resolve — see
                STATUS_LABEL in attention-history.ts. */}
            <button
              type="button"
              className="att-req__act"
              disabled={busy}
              onClick={() => props.onDraft('dismissed')}
              data-testid={`attention-dismiss-${row.id}`}
            >
              Decline
            </button>
          </p>
        ) : null}

        {pending && drafting !== null ? (
          <div className="att-req__draft">
            <label className="att-req__draft-label" htmlFor={`att-note-${row.id}`}>
              {drafting === 'resolved' ? 'Resolve — note (optional)' : 'Decline — note (optional)'}
            </label>
            <input
              id={`att-note-${row.id}`}
              className="att-req__draft-input"
              value={note}
              maxLength={1000}
              placeholder="What happened?"
              onChange={(event) => setNote(event.target.value)}
              disabled={busy}
            />
            <span className="att-req__draft-acts">
              <button
                type="button"
                className="att-req__act att-req__act--primary"
                disabled={busy}
                onClick={() => props.onConfirm(note)}
                data-testid={`attention-confirm-${row.id}`}
              >
                {busy ? 'Saving…' : drafting === 'resolved' ? 'Resolve' : 'Decline'}
              </button>
              <button
                type="button"
                className="att-req__act"
                disabled={busy}
                onClick={() => { setNote(''); props.onDraft(null); }}
              >
                Cancel
              </button>
            </span>
          </div>
        ) : null}
      </div>
    </li>
  );
}
