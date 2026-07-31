/**
 * Wire envelope conventions (DEV-6, 04 §1 + §4).
 *
 * - Every successful response: `{ data, requestId }`. List responses carry
 *   `nextCursor` (nullable) INSIDE `data.page` — never at the envelope level.
 * - Every error response: `{ error: { code, message, details?, requestId,
 *   retryable } }` with the DEV-8 status mapping.
 * - Facade methods (the UI seam) return unwrapped values; the envelope exists
 *   only at the HTTP layer.
 */
import type { CommandErrorCode } from './contract.js';

export interface Envelope<T> {
  data: T;
  requestId: string;
}

export interface WireErrorBody {
  error: {
    code: CommandErrorCode;
    message: string;
    details?: unknown;
    requestId: string;
    retryable: boolean;
  };
}

export function envelope<T>(data: T, requestId: string): Envelope<T> {
  return { data, requestId };
}

/**
 * S6 (10-SECURITY-MODEL): the CSRF header every tm8 browser client sends on
 * every request, and the header the node requires on state-changing requests
 * that carry a tm8 session cookie.
 *
 * A CUSTOM HEADER *IS* THE DEFENCE — that is the whole mechanism, not a token
 * lookup: a cross-site page cannot set one without a CORS preflight, and the
 * node refuses preflights outright (S4, `checkPreflight`). So the server only
 * checks that the header is PRESENT; its value is a client label for logs, and
 * nothing reads it.
 *
 * It lives in the contract rather than in the server because a header name the
 * client and the server spell separately is a name that drifts, and the drift
 * does not present as a typo — it presents as every mutation 403ing.
 */
export const TM8_CLIENT_HEADER = 'x-tm8-client';

/** Default label for the browser UI. Any non-empty value satisfies the gate. */
export const TM8_CLIENT_HEADER_VALUE = 'tm8-ui';
