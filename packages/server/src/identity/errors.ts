/**
 * Identity failures speak the frozen contract's closed error taxonomy so the
 * facade can propagate them without translation (T-L12, contract ERROR_STATUS).
 */

import { CollabError } from '@tm8/contract';

export function unauthenticated(message: string, details?: Record<string, unknown>): CollabError {
  return new CollabError('unauthenticated', message, { details });
}

export function forbidden(message: string, details?: Record<string, unknown>): CollabError {
  return new CollabError('forbidden', message, { details });
}

export function notFound(message: string, details?: Record<string, unknown>): CollabError {
  return new CollabError('not_found', message, { details });
}

export function invalidInput(message: string, details?: Record<string, unknown>): CollabError {
  return new CollabError('invalid_input', message, { details });
}

export function invariantViolation(message: string, details?: Record<string, unknown>): CollabError {
  return new CollabError('invariant_violation', message, { details });
}
