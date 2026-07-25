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
