/**
 * One delivery row (`form_deliveries`, FORMS-DESIGN §7.3) → what the chip and
 * its note say, and which action they offer. Pure, so every real state is
 * pinned by a table test (delivery.test.ts), and the ONLY place the UI reads
 * `status`/`attempts`/`lastError` to decide anything.
 *
 *   pending,  attempts=0, no error        → queued     (Resume now)
 *   pending,  attempts>0 or a lastError   → retrying   (Resume now; shows the error)
 *   delivered                             → delivered
 *   delivered, lastError delivery_unverified… → unverified (warning)
 *   spawned                               → spawned    (link to spawnedSessionId)
 *   cancelled                             → cancelled  (reason; Send to a new session)
 *
 * A redelivered row carries `lastError = 'redelivered_from: …'` as provenance,
 * not as a failure: it never makes a row "retrying".
 */
import type { FormDeliveryView } from '@tm8/contract';

export type DeliveryState = 'queued' | 'retrying' | 'delivered' | 'unverified' | 'spawned' | 'cancelled';

export interface DeliveryReading {
  state: DeliveryState;
  /** The server's error text for this state, when it carries one worth showing. */
  error: string | null;
  /** For a cancelled row: the reason in words. */
  reason: string | null;
  /** The row was itself a redelivery of an earlier one. */
  redeliveredFrom: string | null;
  /** Which door the row offers. */
  action: 'resume' | 'new_session' | null;
}

const UNVERIFIED = 'delivery_unverified';
const REDELIVERED = 'redelivered_from:';

const CANCEL_REASON: Record<string, string> = {
  session_deleted: 'the session was deleted',
  resume_unavailable: 'the session could not be resumed',
  spawn_failed: 'a new session could not be started',
};

/** `session_deleted` / `resume_unavailable: …` / an envelope refusal → words. */
export function cancelReasonText(lastError: string | null): string {
  if (!lastError) return 'the session is gone';
  const head = lastError.split(':')[0]!.trim();
  return CANCEL_REASON[head] ?? lastError;
}

export function readDelivery(d: Pick<FormDeliveryView, 'status' | 'attempts' | 'lastError'>): DeliveryReading {
  const provenance = d.lastError?.startsWith(REDELIVERED) ? d.lastError.slice(REDELIVERED.length).trim() : null;
  const error = provenance === null ? d.lastError : null;
  const base = { redeliveredFrom: provenance, reason: null, error: null, action: null } as const;
  switch (d.status) {
    case 'pending':
      return d.attempts > 0 || error
        ? { ...base, state: 'retrying', error, action: 'resume' }
        : { ...base, state: 'queued', action: 'resume' };
    case 'delivered':
      return error?.startsWith(UNVERIFIED)
        ? { ...base, state: 'unverified', error }
        : { ...base, state: 'delivered' };
    case 'spawned':
      return { ...base, state: 'spawned' };
    case 'cancelled':
      return { ...base, state: 'cancelled', error, reason: cancelReasonText(error), action: 'new_session' };
  }
}
