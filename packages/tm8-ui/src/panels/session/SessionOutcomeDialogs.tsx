/**
 * SPEC D1 §5.4 / §5.5 — the two session outcome dialogs.
 *
 *   Terminate (open session only): "This session hasn't completed." It lists
 *   what the session is working on and makes the operator say which ending
 *   they mean — Mark complete & close, or Stop without completing. This is
 *   what stops the 131 "Stopped by request." endings that said nothing.
 *
 *   Complete (the tick, or "Mark complete"): the receipt (the session's
 *   latest message prefilled, else a text box), the claimed tasks with their
 *   status and a Hand off for each one still being worked, and "Also close the
 *   process" (ticked for operators, Q3). Complete stays disabled while any
 *   claim is still working or waiting — the server's claim check, shown first.
 *
 * Both keep the MembershipConfirm shape: a scrim, `role="dialog"`, a pending
 * state, and on failure the dialog STAYS with the node's refusal in a
 * `role="alert"` line beside the act that was refused. Cancel takes focus.
 *
 * Pure presentation over a port: the host (`usePanelPrimaries`) reads the
 * facts and performs the commands, so the dialog never imports the seam.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { blockingClaims, activeClaims, type SessionClaim } from '../../domain';
import './session-outcome.css';

/** What the dialogs need to know about one session, read once on open. */
export interface SessionOutcomeFacts {
  title: string;
  claims: readonly SessionClaim[];
  /** The newest message on the session's anchor, the prefilled receipt. */
  latestMessage: { id: string; body: string; author: string | null; createdAt: string } | null;
}

/** A refusal from the node, already sorted into the cases the dialog draws. */
export interface SessionRefusal {
  reason: string | null;
  message: string;
  /** `claims_open`: the tasks the node says are still being worked. */
  tasks?: readonly { taskId: string; title: string; status: string }[];
}

/** Read `details.reason` (and `details.tasks`) off a CollabError-shaped failure. */
export function refusalOf(error: unknown): SessionRefusal {
  const e = error as { message?: unknown; details?: Record<string, unknown> } | null;
  const details = e?.details ?? {};
  const reason = typeof details.reason === 'string' ? details.reason : null;
  const tasks = Array.isArray(details.tasks)
    ? (details.tasks as Record<string, unknown>[]).map((t) => ({
        taskId: String(t.taskId ?? ''),
        title: String(t.title ?? 'Task'),
        status: String(t.claimStatus ?? t.status ?? 'working'),
      }))
    : undefined;
  const message = typeof e?.message === 'string' ? e.message : String(error);
  return { reason, message, ...(tasks ? { tasks } : {}) };
}

/** The sentence a refusal reads as, in the dialog's own words where it has them. */
function refusalSentence(r: SessionRefusal): string {
  switch (r.reason) {
    case 'claims_open':
      return 'These tasks are still being worked. Finish them, move them to review or blocked, or hand them off first.';
    case 'receipt_required':
      return 'There is no close-out message to use as the receipt. Write one below.';
    case 'receipt_not_on_anchor':
      return 'That message is not on this session or one of its tasks, so it cannot be the receipt.';
    case 'session_stopped':
      return 'This session was stopped. Resume it before completing it.';
    default:
      return r.message;
  }
}

const CLAIM_WORD: Readonly<Record<string, string>> = {
  working: 'working',
  waiting: 'waiting for input',
  blocked: 'blocked',
  in_review: 'in review',
};

function ClaimList({
  claims,
  onHandOff,
  onOpenTask,
  testId,
}: {
  claims: readonly SessionClaim[];
  onHandOff?: (taskId: string, note: string) => Promise<unknown>;
  onOpenTask?: (taskId: string) => void;
  testId: string;
}) {
  const [handing, setHanding] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (claims.length === 0) {
    return <p className="so-dialog__muted" data-testid={`${testId}-no-claims`}>No claimed tasks.</p>;
  }
  const blocking = new Set(blockingClaims(claims).map((c) => c.taskId));
  return (
    <ul className="so-dialog__claims" data-testid={`${testId}-claims`}>
      {claims.map((c) => (
        <li key={c.taskId} className="so-dialog__claim" data-testid="session-claim" data-claim-status={c.status}>
          <span className="so-dialog__claimtitle">{c.title}</span>
          <span className={`so-dialog__claimstatus${blocking.has(c.taskId) ? ' so-dialog__claimstatus--open' : ''}`}>
            {CLAIM_WORD[c.status] ?? c.status}
            {!blocking.has(c.taskId) ? ' · ends with the receipt' : ''}
          </span>
          {blocking.has(c.taskId) && (onHandOff || onOpenTask) ? (
            <span className="so-dialog__claimacts">
              {onHandOff ? (
                <button type="button" className="so-dialog__link" onClick={() => { setHanding(c.taskId); setNote(''); setFailure(null); }}>
                  Hand off
                </button>
              ) : null}
              {onOpenTask ? (
                <button type="button" className="so-dialog__link" onClick={() => onOpenTask(c.taskId)}>
                  Open task
                </button>
              ) : null}
            </span>
          ) : null}
          {handing === c.taskId && onHandOff ? (
            <span className="so-dialog__handoff">
              <textarea
                className="so-dialog__text"
                aria-label={`Hand-off note for ${c.title}`}
                data-testid="session-handoff-note"
                placeholder="Where it stands and what is left"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              {failure ? <span className="so-dialog__error" role="alert">{failure}</span> : null}
              <span className="so-dialog__row">
                <button type="button" className="so-dialog__cancel" onClick={() => setHanding(null)}>Cancel</button>
                <button
                  type="button"
                  className="so-dialog__go"
                  data-testid="session-handoff-go"
                  disabled={pending || note.trim().length === 0}
                  onClick={() => {
                    setPending(true);
                    setFailure(null);
                    onHandOff(c.taskId, note.trim())
                      .then(() => setHanding(null))
                      .catch((error: unknown) => setFailure(refusalOf(error).message))
                      .finally(() => setPending(false));
                  }}
                >
                  {pending ? '…' : 'Hand off'}
                </button>
              </span>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function useAutofocus() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);
  return ref;
}

/** Load the facts once on open; `reload` after a hand-off. */
function useFacts(load: () => Promise<SessionOutcomeFacts>) {
  const [facts, setFacts] = useState<SessionOutcomeFacts | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => {
    loadRef.current()
      .then((f) => { setFacts(f); setLoadError(null); })
      .catch((error: unknown) => setLoadError(refusalOf(error).message));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { facts, loadError, reload, setFacts };
}

export interface SessionCompleteDialogProps {
  load: () => Promise<SessionOutcomeFacts>;
  /**
   * Resolve when the session is completed. `receiptText` is set when the
   * operator wrote the receipt here; the host posts it first and passes the
   * new message's id. A rejection is shown and the dialog stays.
   */
  onComplete: (input: { receiptMessageId?: string; receiptText?: string; closeProcess: boolean }) => Promise<unknown>;
  onHandOff?: (taskId: string, note: string) => Promise<unknown>;
  onOpenTask?: (taskId: string) => void;
  onCancel: () => void;
  /** From the Terminate dialog's "Mark complete & close": closing is the point, not an option. */
  closeForced?: boolean;
}

export function SessionCompleteDialog({
  load,
  onComplete,
  onHandOff,
  onOpenTask,
  onCancel,
  closeForced = false,
}: SessionCompleteDialogProps) {
  const testId = 'session-complete-dialog';
  const ref = useAutofocus();
  const { facts, loadError, reload, setFacts } = useFacts(load);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  // Q3: "Also close the process" is ticked for operators.
  const [closeProcess, setCloseProcess] = useState(true);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<SessionRefusal | null>(null);

  const latest = facts?.latestMessage ?? null;
  const useText = writing || (facts !== null && latest === null);
  const blocking = facts ? blockingClaims(facts.claims) : [];
  const receiptMissing = useText ? text.trim().length === 0 : latest === null;
  const disabled = pending || facts === null || blocking.length > 0 || receiptMissing;

  async function complete() {
    setPending(true);
    setRefusal(null);
    try {
      await onComplete({
        ...(useText ? { receiptText: text.trim() } : latest ? { receiptMessageId: latest.id } : {}),
        closeProcess: closeForced || closeProcess,
      });
    } catch (error) {
      const r = refusalOf(error);
      setRefusal(r);
      if (r.reason === 'receipt_required' || r.reason === 'receipt_not_on_anchor') setWriting(true);
      // The node's list of open claims replaces ours: it is the one that refused.
      if (r.reason === 'claims_open' && r.tasks && facts) {
        const open = new Map(r.tasks.map((t) => [t.taskId, t]));
        setFacts({
          ...facts,
          claims: [
            ...facts.claims.map((c) => (open.has(c.taskId) ? { ...c, status: open.get(c.taskId)!.status, endedAt: null } : c)),
            ...r.tasks.filter((t) => !facts.claims.some((c) => c.taskId === t.taskId))
              .map((t) => ({ taskId: t.taskId, title: t.title, status: t.status })),
          ],
        });
      }
      setPending(false);
    }
  }

  return (
    <div className="so-dialog__scrim" data-testid={`${testId}-scrim`}>
      <div className="so-dialog" role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`} data-testid={testId} ref={ref}>
        <div className="so-dialog__title" id={`${testId}-title`}>
          {closeForced ? 'Complete and close' : 'Complete session'}
          {facts?.title ? <span className="so-dialog__subject">{facts.title}</span> : null}
        </div>

        {loadError ? <p className="so-dialog__error" role="alert">{loadError}</p> : null}
        {facts === null && !loadError ? <p className="so-dialog__muted">Loading…</p> : null}

        {facts ? (
          <>
            <div className="so-dialog__section">
              <div className="so-dialog__label">Receipt</div>
              {!useText && latest ? (
                <div className="so-dialog__receipt" data-testid="session-receipt-latest">
                  <p className="so-dialog__quote">{latest.body}</p>
                  <span className="so-dialog__muted">
                    The latest message{latest.author ? ` from ${latest.author}` : ''}.{' '}
                    <button type="button" className="so-dialog__link" onClick={() => setWriting(true)}>
                      Write a different receipt
                    </button>
                  </span>
                </div>
              ) : (
                <textarea
                  className="so-dialog__text"
                  aria-label="Receipt"
                  data-testid="session-receipt-text"
                  placeholder="What was done, and where each task stands"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              )}
            </div>

            <div className="so-dialog__section">
              <div className="so-dialog__label">Claimed tasks</div>
              <ClaimList
                claims={activeClaims(facts.claims)}
                testId={testId}
                onOpenTask={onOpenTask}
                {...(onHandOff
                  ? { onHandOff: (taskId: string, note: string) => onHandOff(taskId, note).then(() => reload()) }
                  : {})}
              />
            </div>

            {closeForced ? null : (
              <label className="so-dialog__check">
                <input
                  type="checkbox"
                  checked={closeProcess}
                  data-testid="session-close-process"
                  onChange={(e) => setCloseProcess(e.target.checked)}
                />
                Also close the process
              </label>
            )}
          </>
        ) : null}

        {refusal ? (
          <p className="so-dialog__error" role="alert" data-testid={`${testId}-error`} data-reason={refusal.reason ?? undefined}>
            {refusalSentence(refusal)}
          </p>
        ) : null}

        <div className="so-dialog__actions">
          <button type="button" className="so-dialog__cancel" onClick={onCancel} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className="so-dialog__go so-dialog__go--done"
            onClick={() => void complete()}
            disabled={disabled}
            title={blocking.length > 0 ? 'Hand off or finish the tasks still being worked first' : undefined}
            data-testid={`${testId}-go`}
          >
            {pending ? '…' : closeForced ? 'Complete & close' : 'Complete'}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface SessionTerminateDialogProps {
  load: () => Promise<SessionOutcomeFacts>;
  /** "Mark complete & close" — the host opens the Complete dialog with closing forced. */
  onCompleteAndClose: () => void;
  /** "Stop without completing" — terminate with outcome `stop`. */
  onStop: () => Promise<unknown>;
  onCancel: () => void;
}

export function SessionTerminateDialog({ load, onCompleteAndClose, onStop, onCancel }: SessionTerminateDialogProps) {
  const testId = 'session-terminate-dialog';
  const ref = useAutofocus();
  const { facts, loadError } = useFacts(load);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function stop() {
    setPending(true);
    setFailure(null);
    try {
      await onStop();
    } catch (error) {
      setFailure(refusalSentence(refusalOf(error)));
      setPending(false);
    }
  }

  const claims = facts ? activeClaims(facts.claims) : [];
  return (
    <div className="so-dialog__scrim" data-testid={`${testId}-scrim`}>
      <div className="so-dialog" role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`} data-testid={testId} ref={ref}>
        <div className="so-dialog__title" id={`${testId}-title`}>
          This session hasn’t completed.
          {facts?.title ? <span className="so-dialog__subject">{facts.title}</span> : null}
        </div>
        {loadError ? <p className="so-dialog__error" role="alert">{loadError}</p> : null}
        {facts === null && !loadError ? <p className="so-dialog__muted">Loading…</p> : null}
        {facts ? (
          <div className="so-dialog__section">
            <div className="so-dialog__label">{claims.length > 0 ? 'It’s working on' : 'It has no claimed tasks.'}</div>
            {claims.length > 0 ? <ClaimList claims={claims} testId={testId} /> : null}
          </div>
        ) : null}
        <p className="so-dialog__muted">
          <strong>Mark complete &amp; close</strong>: confirm the receipt and pass the claim check, then close the process.{' '}
          <strong>Stop without completing</strong>: its claims are released, its tasks show “No live session”, and it moves
          to Stopped. It can be resumed later.
        </p>
        {failure ? (
          <p className="so-dialog__error" role="alert" data-testid={`${testId}-error`}>
            {failure}
          </p>
        ) : null}
        <div className="so-dialog__actions">
          <button type="button" className="so-dialog__cancel" onClick={onCancel} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className="so-dialog__go so-dialog__go--stop"
            onClick={() => void stop()}
            disabled={pending}
            data-testid={`${testId}-stop`}
          >
            {pending ? '…' : 'Stop without completing'}
          </button>
          <button
            type="button"
            className="so-dialog__go so-dialog__go--done"
            onClick={onCompleteAndClose}
            disabled={pending}
            data-testid={`${testId}-complete`}
          >
            Mark complete &amp; close
          </button>
        </div>
      </div>
    </div>
  );
}

export interface SessionReopenDialogProps {
  title?: string;
  /** Resume the session (`execution.resume`); a rejection stays in the dialog. */
  onReopen: () => Promise<unknown>;
  onCancel: () => void;
}

/**
 * Q2 = B (owner, 6 Oct) — REOPENING A COMPLETED SESSION is an explicit,
 * logged resume, never an untick. One confirm line says what it does and what
 * it keeps: the outcome goes back to open, the receipt stays in history.
 */
export function SessionReopenDialog({ title, onReopen, onCancel }: SessionReopenDialogProps) {
  const testId = 'session-reopen-dialog';
  const ref = useAutofocus();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function reopen() {
    setPending(true);
    setFailure(null);
    try {
      await onReopen();
    } catch (error) {
      setFailure(refusalOf(error).message);
      setPending(false);
    }
  }

  return (
    <div className="so-dialog__scrim" data-testid={`${testId}-scrim`}>
      <div className="so-dialog" role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`} data-testid={testId} ref={ref}>
        <div className="so-dialog__title" id={`${testId}-title`}>
          Reopen this session?
          {title ? <span className="so-dialog__subject">{title}</span> : null}
        </div>
        <p className="so-dialog__muted">Reopens this completed session; its receipt stays in history.</p>
        {failure ? (
          <p className="so-dialog__error" role="alert" data-testid={`${testId}-error`}>
            {failure}
          </p>
        ) : null}
        <div className="so-dialog__actions">
          <button type="button" className="so-dialog__cancel" onClick={onCancel} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className="so-dialog__go so-dialog__go--done"
            onClick={() => void reopen()}
            disabled={pending}
            data-testid={`${testId}-go`}
          >
            {pending ? '…' : 'Reopen (resume)'}
          </button>
        </div>
      </div>
    </div>
  );
}
