import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { OP_REQUEST_NOTE_MAX, type EntityDetail, type OpRequestStatus, type OpRequestView } from '@tm8/contract';
import type { OpRequestDecision, OpRequestsOps } from '../../data/seam';
import { ActorRef, Markdown, Pill, Timestamp, type PillTone } from '../../kit';
import { NOT_WIRED_REASON } from '../honesty/DisabledWithReason';

/**
 * THE APPROVE CARD (L5, migration 280) — one request for a human-only
 * operation: what it would run, why the agent asked, and where it stands.
 *
 * NOTHING HERE DECIDES WHO MAY DECIDE. The server computes `canDecide` for
 * THIS viewer (the approver rule, human-only, still pending) and refuses an
 * approve or deny it would not allow; the card only draws Approve / Deny when
 * the view says so, and shows the server's refusal word when it refuses.
 *
 * Approving does not run anything in the browser. The server runs the op AS
 * THE APPROVER — their identity, their authority checks, the op's own schema —
 * and posts the outcome to the requesting session. The card then re-reads the
 * request, so what it shows after a click is the server's record, not a guess.
 *
 * No kind literal appears in this file (§15.2): the registry routes a kind
 * here with `{ block: 'approval' }`, and the card reads the request by id.
 */

const STATUS: Readonly<Record<OpRequestStatus, { word: string; tone: PillTone }>> = {
  pending: { word: 'Waiting for a decision', tone: 'wait' },
  executing: { word: 'Approved · running', tone: 'run' },
  succeeded: { word: 'Approved · done', tone: 'run' },
  failed: { word: 'Approved · failed', tone: 'block' },
  denied: { word: 'Denied', tone: 'idle' },
};

const APPROVER: Readonly<Record<OpRequestView['approver'], string>> = {
  requester: 'Only the person the agent acts for',
  any_member: 'Any person in this space',
};

/** Compact JSON for a params/input/result value; null when there is nothing to show. */
function compact(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'object' && Object.keys(value as object).length === 0) return null;
  return JSON.stringify(value);
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="pn-fields__row" data-testid={testId}>
      <dt className="pn-fields__key">{label}</dt>
      <dd className="pn-fields__value">{children}</dd>
    </div>
  );
}

export function ApprovalBlock({
  detail,
  port,
  onOpenEntity,
}: {
  detail: Pick<EntityDetail, 'id' | 'version' | 'createdBy'>;
  /** `seam.commands.opRequests`. Absent ⇒ the card says it is not wired, never draws dead buttons. */
  port?: Pick<OpRequestsOps, 'get' | 'approve' | 'deny'> | null;
  /** Opens the requesting session. */
  onOpenEntity?: (id: string) => void;
}) {
  const [request, setRequest] = useState<OpRequestView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [decision, setDecision] = useState<OpRequestDecision | null>(null);

  /* Keyed on the entity VERSION too: the server bumps it when a request is
     decided, so another member's decision re-reads here without a click. */
  const load = useCallback(async () => {
    if (!port) { setLoaded(true); return; }
    try {
      setRequest(await port.get(detail.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [port, detail.id, detail.version]);

  useEffect(() => { void load(); }, [load]);

  async function decide(verb: 'approve' | 'deny') {
    if (!port) return;
    setBusy(true); setError(null);
    try {
      const trimmed = note.trim();
      const answer = await port[verb](detail.id, trimmed === '' ? null : trimmed);
      setDecision(answer);
      setRequest(answer.request);
      setNote('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <p className="pn-muted" data-testid="approval-loading">Loading…</p>;
  if (!port) return <p className="pn-muted" data-testid="approval-unwired">{NOT_WIRED_REASON.cause}</p>;
  if (!request) {
    return (
      <p role="alert" className="pn-error" data-testid="approval-unreadable">
        This request did not load{error ? `: ${error}` : '.'}
      </p>
    );
  }

  const status = STATUS[request.status] ?? { word: request.status, tone: 'idle' as const };
  const params = compact(request.params);
  const input = compact(request.input);
  const result = compact(request.result);
  const decided = request.decidedAt !== null;
  const open = request.status === 'pending';

  return (
    <div className="pn-approval" data-testid="approval-block">
      <div className="pn-approval__head">
        <span data-testid="approval-status"><Pill tone={status.tone}>{status.word}</Pill></span>
        <span className="pn-approval__label">{request.label}</span>
      </div>
      <p className="pn-approval__title" data-testid="approval-title">{request.title}</p>

      <dl className="pn-fields" data-testid="approval-facts">
        <Row label="Operation" testId="approval-op"><code>{request.op}</code></Row>
        {params ? <Row label="Params" testId="approval-params"><code>{params}</code></Row> : null}
        {input ? <Row label="Input" testId="approval-input"><code>{input}</code></Row> : null}
        <Row label="Who decides">{APPROVER[request.approver] ?? request.approver}</Row>
        <Row label="Filed by" testId="approval-filed-by">
          {detail.createdBy ? <ActorRef actor={detail.createdBy} /> : request.requestedBy}
          {' · '}<Timestamp at={request.createdAt} />
        </Row>
        {request.requestingSessionId ? (
          <Row label="Session">
            {onOpenEntity ? (
              <button type="button" className="pn-approval__link" onClick={() => onOpenEntity(request.requestingSessionId!)}>
                Open the session that asked
              </button>
            ) : <code>{request.requestingSessionId}</code>}
          </Row>
        ) : null}
      </dl>

      <div className="pn-approval__why" data-testid="approval-justification">
        <span className="pn-fields__key">Why</span>
        <Markdown source={request.justification} className="pn-prose" />
      </div>

      {decided ? (
        <dl className="pn-fields" data-testid="approval-outcome">
          <Row label="Decided"><Timestamp at={request.decidedAt} /></Row>
          {request.decisionNote ? <Row label="Note" testId="approval-note">{request.decisionNote}</Row> : null}
          {result ? <Row label="Result" testId="approval-result"><code>{result}</code></Row> : null}
          {request.error ? (
            <Row label="Error" testId="approval-error"><code>{request.error.code}</code>: {request.error.message}</Row>
          ) : null}
        </dl>
      ) : null}

      {decision && !decision.notified && request.requestingSessionId ? (
        <p className="pn-notice" role="note" data-testid="approval-not-notified">
          The session that asked was not told{decision.notifyError ? `: ${decision.notifyError.message}` : '.'}
        </p>
      ) : null}

      {open && request.canDecide ? (
        <div className="pn-approval__decide" data-testid="approval-decide">
          <label className="pn-approval__note">
            <span className="pn-fields__key">Note (optional)</span>
            <textarea
              value={note}
              maxLength={OP_REQUEST_NOTE_MAX}
              rows={2}
              disabled={busy}
              data-testid="approval-note-input"
              placeholder="Sent to the agent with your decision"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="pn-approval__verbs">
            <button type="button" className="pn-btn pn-btn--primary" disabled={busy} data-testid="approval-approve"
              onClick={() => void decide('approve')}>
              Approve
            </button>
            <button type="button" className="pn-btn" disabled={busy} data-testid="approval-deny"
              onClick={() => void decide('deny')}>
              Deny
            </button>
          </div>
        </div>
      ) : open ? (
        <p className="pn-notice" data-testid="approval-not-yours">
          {request.approver === 'requester'
            ? 'Only the person the agent acts for can decide this request.'
            : 'You cannot decide this request.'}
        </p>
      ) : null}

      {error ? <p role="alert" className="pn-error" data-testid="approval-failed">{error}</p> : null}
    </div>
  );
}
