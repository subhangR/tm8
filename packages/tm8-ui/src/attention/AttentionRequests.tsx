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
 *
 * IT IS A DOCK NOW, NOT A SECTION (user ruling 2026-09-07: "taking up too much
 * space at the bottom"). Four cards of settled history were spending the whole
 * foot of the panel on a record nobody had asked to read. So the record folds
 * behind ONE pinned line, and the four rulings that shape it are these:
 *
 *   1. THE BAR IS PANEL CHROME, not content. It sits outside the scroller,
 *      between the body and the footer, so it is on screen at any scroll
 *      offset and on every tab. That placement is what let the SECOND mount
 *      die: terminal and chat bodies used to be exiled to the Connections tab
 *      because the full section was too tall for a body that owns its own
 *      height, and a one-line bar is not. One home, every kind.
 *   2. THE DATA DECIDES THE DEFAULT, and nothing is persisted. A settled-only
 *      history — the common case, and the one in the report — opens collapsed.
 *      A row still pending opens the sheet, because it is the only part anyone
 *      can still act on. `autoOpened` makes that a one-way latch: settling the
 *      last pending row must not yank the list shut under the hand that just
 *      acted on it.
 *   3. THE BAR CARRIES A FACT, not just a number: the loudest pending reason,
 *      truncated to the line. A bar that only counts makes you open it to
 *      learn anything, which is the cost the collapse was meant to remove.
 *   4. THE EYEBROW IS GONE. The bar states the same counts, and repeating them
 *      one line lower inside the sheet is exactly the kind of spend this
 *      change exists to stop.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AttentionRequest, AttentionRequestStatus, EntityId } from '@tm8/contract';
import {
  isPending,
  leadPending,
  orderHistory,
  settlementLine,
  STATUS_LABEL,
  summarizeHistory,
} from './attention-history';
import { relTime } from '../kit/time';
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
  /**
   * THE SHEET'S DISCLOSURE STATE, seeded closed and opened by the data once.
   *
   * `autoOpened` is a ONE-WAY LATCH and that is the whole subtlety here. The
   * rule is "open when something is pending", but a naive effect that mirrors
   * `pendingCount > 0` would slam the sheet shut the instant you resolved the
   * last row — pulling the history out from under the click that settled it,
   * and hiding the write error if that click had failed. So the effect may only
   * ever set `true`, and the only thing that can close the sheet is the person
   * pressing the bar.
   *
   * The latch is per-MOUNT, and the component is keyed on the entity
   * (`attentionSurface.tsx`), so switching entities re-arms it. A refresh that
   * brings back a NEW pending row re-opens too, which is right: the latch tracks
   * "has this instance ever had something to act on", not "has it rendered".
   */
  const [open, setOpen] = useState(false);
  const autoOpened = useRef(false);
  const sheetId = useId();
  const live = useRef(true);

  /**
   * THE PORT IS HELD BY REFERENCE, NEVER BY DEPENDENCY — this is the fix for the
   * section's flicker, and it belongs here rather than only at the five call
   * sites.
   *
   * `attentionSectionFor` builds the port inside each host's render. When that
   * identity was in `load`'s dependency array, `load` changed on every host
   * render, the mount effect below re-ran, and `load('initial')` put the section
   * back into `phase: 'loading'` — which returns `null`. The whole `<section>`
   * left the document and came back a fetch later, shunting the content body up
   * and then down again, over and over, for as long as the host kept rendering.
   *
   * A ref severs that. The effect keys on the ENTITY, which is the only thing
   * that actually changes what should be on screen, and the fetch always reads
   * whatever port the latest render handed us. `port.ts` memoises the factory as
   * well, but this is the half that a sixth host cannot accidentally undo.
   */
  const portRef = useRef(port);
  portRef.current = port;

  const load = useCallback(
    (mode: 'initial' | 'refresh') => {
      if (injected) return;
      if (mode === 'initial') setState({ phase: 'loading' });
      portRef.current.history(entityId).then(
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
    [entityId, injected],
  );

  useEffect(() => {
    live.current = true;
    load('initial');
    return () => { live.current = false; };
  }, [load]);

  useEffect(() => {
    if (autoOpened.current) return;
    if (state.phase !== 'ready') return;
    if (!state.rows.some(isPending)) return;
    autoOpened.current = true;
    setOpen(true);
  }, [state]);

  const settle = useCallback(
    (row: AttentionRequest, status: AttentionRequestStatus, note: string) => {
      setBusy(row.id);
      setWriteError(null);
      // Through the ref for the same reason `load` is — a click handler must not
      // be a reason to keep the port in a dependency array.
      portRef.current
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
    [load, props.onSettled],
  );

  // LOADING AND EMPTY BOTH RENDER NOTHING, and for the same reason: this
  // section is mounted on every entity in the product, and the overwhelming
  // majority have never been escalated (user ruling — hide when empty). A
  // spinner would flash a box onto every page in the app for one frame.
  //
  // This is safe ONLY because `loading` is now entered once per entity. It used
  // to be re-entered on every host render, and rendering `null` from a state the
  // component kept falling back into is what made the section strobe. A refresh
  // deliberately never comes through here: `load('refresh')` leaves the rows on
  // screen, so a settlement re-reads the history without the page moving.
  if (state.phase === 'loading') return null;

  if (state.phase === 'error') {
    return (
      <AttentionDock
        open={open}
        onToggle={() => setOpen((v) => !v)}
        sheetId={sheetId}
        tone="error"
        counts="Attention history unavailable"
        lead={null}
      >
        <p className="att-req__error">Attention history could not be loaded.</p>
        <p className="att-req__error-detail">{state.message}</p>
      </AttentionDock>
    );
  }

  if (state.rows.length === 0) return null;

  const ordered = orderHistory(state.rows);
  const summary = summarizeHistory(state.rows);
  const lead = leadPending(state.rows);

  return (
    <AttentionDock
      open={open}
      onToggle={() => setOpen((v) => !v)}
      sheetId={sheetId}
      tone={summary.pendingCount > 0 ? 'wait' : 'quiet'}
      counts={
        summary.pendingCount > 0
          ? `${summary.pendingCount} waiting · ${summary.pendingPoints} pts`
          : `${summary.total} settled`
      }
      /* Only a PENDING row gets quoted. Leading a collapsed bar with the text
         of a closed request would read as live, which is the one thing this
         surface has to be careful about — see the footnote below. */
      lead={lead ? lead.reason : null}
    >
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
    </AttentionDock>
  );
}

/**
 * THE DOCK — a pinned bar and the sheet it discloses, with no knowledge of what
 * is inside either.
 *
 * Split out from `AttentionRequests` so the READY and ERROR phases share one
 * shape. They used to be two different boxes, which was survivable while both
 * were inline sections and is not now: this thing is panel chrome, and chrome
 * that changes height and silhouette depending on whether a fetch failed is
 * chrome that makes the panel twitch.
 *
 * WHY THE SHEET IS ABSOLUTE, NOT A FLEX SIBLING. In flow, expanding would
 * shorten the scroll host and reflow the entire body under it — the reader's
 * place in the content moves because they asked to see something at the bottom.
 * `bottom: 100%` against the dock lifts the sheet OVER the body instead, so
 * the content behind it is untouched and closing puts everything back exactly.
 * The panel's own `overflow: hidden` (panels.css) is the clip that keeps it
 * inside the panel; the sheet's `max-height` is what keeps it from needing to
 * be clipped in the first place.
 *
 * DOM ORDER IS BAR-THEN-SHEET even though the sheet paints above it, because
 * that is the reading order a disclosure wants: the control, then the region it
 * names through `aria-controls`. Absolute positioning makes the two orders
 * independent, which is the other half of why the sheet is not in flow.
 */
function AttentionDock(props: {
  open: boolean;
  onToggle(): void;
  sheetId: string;
  /** Drives the glyph's colour only — `wait` when something is still pending. */
  tone: 'wait' | 'quiet' | 'error';
  counts: string;
  /** The loudest pending reason, or null when there is no live row to quote. */
  lead: string | null;
  children: ReactNode;
}) {
  const { open, sheetId, tone, counts, lead } = props;
  return (
    <div className="att-dock" data-testid="attention-requests" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="att-dock__bar"
        data-testid="attention-bar"
        data-tone={tone}
        aria-expanded={open}
        aria-controls={sheetId}
        onClick={props.onToggle}
      >
        {/* The glyph is a WARNING only while something is waiting. Settled
            history keeps the same silhouette — so the bar does not jump when
            the last row closes — but goes ink-quiet, because a standing alarm
            over a finished record is the lie this whole surface footnotes. */}
        <span className="att-dock__glyph" aria-hidden="true">
          ⚠
        </span>
        <span className="att-dock__counts">{counts}</span>
        {lead ? <span className="att-dock__lead">{lead}</span> : null}
        <span className="att-dock__chevron" aria-hidden="true">
          {open ? '▾' : '▴'}
        </span>
        {/* The chevron is decorative; `aria-expanded` is the real state, and
            this is the word that names the action for a screen reader. */}
        <span className="att-dock__sr">{open ? 'Hide attention history' : 'Show attention history'}</span>
      </button>

      {open ? (
        <div className="att-dock__sheet" id={sheetId} data-testid="attention-sheet" role="group">
          <div className="att-dock__sheet-inner">{props.children}</div>
        </div>
      ) : null}
    </div>
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
            {`Requested by ${row.requestedBy.displayName} · ${relTime(row.createdAt, now ? Date.parse(now) : undefined)}`}
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
