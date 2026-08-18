/**
 * The DEV-8 error middleware: every failure leaves this server as the closed
 * taxonomy's wire body and nothing else.
 *
 *   { error: { code, message, details?, requestId, retryable } }
 *
 * with HTTP status = `ERROR_STATUS[code]`. There is exactly one serializer
 * (`toWireError`) and one writer (`sendWireError`) — no route may hand-build
 * an error response, because the conformance suite asserts this shape on
 * every error path and a second code path is a second chance to drift.
 *
 * `CollabError` (from the frozen contract) is THE error type handlers throw.
 * Anything else that escapes a handler is a bug in the server, and is
 * reported as `upstream_unavailable` (503) with a generic message — internal
 * failure text never reaches the client.
 */
import type { ServerResponse } from 'node:http';
import {
  CollabError,
  ERROR_STATUS,
  RETRYABLE_BY_DEFAULT,
  isCollabError,
  type CommandErrorCode,
  type WireErrorBody,
} from '@tm8/contract';

/**
 * Postgres SQLSTATE → contract taxonomy (published by Cygnus, W1b db block).
 *
 * This is a MECHANICAL TABLE by design. The rule agreed with the db block:
 * never regex an error message to decide a code. Anything not in this table
 * degrades to `upstream_unavailable` — a wrong-but-honest 503, never a
 * plausible-but-wrong 400. When the db block adds a SQLSTATE, it lands here.
 *
 * Unused in the skeleton (no database yet); it exists so the W2 db seam has
 * one obvious place to call and cannot invent a second mapping.
 */
export const SQLSTATE_TO_ERROR_CODE: Readonly<Record<string, CommandErrorCode>> = {
  '28000': 'unauthenticated',
  '42501': 'forbidden',
  P0002: 'not_found',
  // 22P02 invalid_text_representation — almost always a malformed uuid reaching
  // a `uuid` parameter (e.g. `projectId: 'proj-missing-x'`). `not_found` is the
  // honest answer: a string that cannot BE a uuid cannot identify a row, so it
  // is not found, and it is not retryable. Left in the catch-all it became a
  // 503, which tells the client "the node is broken, retry" about a request
  // that will never succeed — wrong on both the code and the retry flag.
  '22P02': 'not_found',
  '22023': 'invalid_input',
  '23514': 'invariant_violation',
  '23503': 'invariant_violation',
  '23505': 'invariant_violation',
  '40001': 'version_conflict',
  '53400': 'limit_exceeded',
  '54000': 'payload_too_large',
  '0A000': 'not_implemented',
};

/** Translate a driver error carrying a SQLSTATE into the taxonomy. */
export function errorCodeForSqlState(sqlState: string | undefined): CommandErrorCode {
  if (!sqlState) return 'upstream_unavailable';
  return SQLSTATE_TO_ERROR_CODE[sqlState] ?? 'upstream_unavailable';
}

export interface WireErrorResponse {
  status: number;
  body: WireErrorBody;
}

/**
 * Serialize any thrown value into the wire error body.
 *
 * `requestId` comes from the request, NOT from the error: `CollabError`
 * mints its own id at construction time, which is useful in the UI seam but
 * wrong on the wire, where the id must match the one the request is logged
 * and audited under.
 */
export function toWireError(err: unknown, requestId: string): WireErrorResponse {
  if (isCollabError(err)) {
    // A version_conflict carries `current: EntityDetail`; the wire body has no
    // dedicated slot for it, so it rides in `details` (04 §4).
    const details =
      err.details ?? (err.current === undefined ? undefined : { current: err.current });
    return {
      status: ERROR_STATUS[err.code],
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(details === undefined ? {} : { details }),
          requestId,
          retryable: err.retryable,
        },
      },
    };
  }

  return {
    status: ERROR_STATUS.upstream_unavailable,
    body: {
      error: {
        code: 'upstream_unavailable',
        message: 'internal server error',
        requestId,
        retryable: true,
      },
    },
  };
}

/**
 * Anything that is NOT a `CollabError` becomes a generic 503 on the wire, by
 * design — internal failure text never reaches the client. That rule is right
 * and stays, but it used to mean the cause reached NOBODY: the pipeline's one
 * catch called the writer and nothing else, so a real crash inside a handler
 * showed up as `internal server error` in the browser and left no trace on the
 * server either. Diagnosing the `/v2/execution/spawn` 503 started with adding
 * this line, which is the evidence that it was missing.
 *
 * Logged HERE rather than at the catch site so it cannot be forgotten by a
 * second caller: `sendWireError` is the only writer, so every unexpected
 * escape is logged exactly once, correlated by the same `requestId` the client
 * is holding.
 */
function logUnexpected(err: unknown, requestId: string): void {
  const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  console.error(`[tm8] unhandled error (requestId=${requestId}): ${detail}`);
}

/**
 * `Retry-After` in whole seconds, or null when the error does not carry one.
 * Read from `details.retryAfterSeconds` so the raiser owns the number — the
 * writer has no idea what limit was tripped or when its window rolls.
 */
function retryAfterSecondsOf(err: unknown): number | null {
  if (!isCollabError(err)) return null;
  const value = (err.details as Record<string, unknown> | undefined)?.retryAfterSeconds;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/** The one and only error writer. */
export function sendWireError(res: ServerResponse, err: unknown, requestId: string): void {
  if (!isCollabError(err)) logUnexpected(err, requestId);
  const { status, body } = toWireError(err, requestId);
  if (res.headersSent) {
    res.end();
    return;
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-tm8-request-id': requestId,
  };
  // A 429 without `Retry-After` tells a client to back off and refuses to say
  // by how much, so every client invents its own answer and the well-behaved
  // ones back off hardest. The value is carried in the error's details by
  // whoever raised it; nothing else may set this header.
  const retryAfter = retryAfterSecondsOf(err);
  if (retryAfter !== null) headers['retry-after'] = String(retryAfter);
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/** Terse constructors, so call sites read as the rule they enforce. */
export function fail(
  code: CommandErrorCode,
  message: string,
  details?: Record<string, unknown>,
): CollabError {
  return new CollabError(code, message, details === undefined ? {} : { details });
}

export function notImplemented(opName: string): CollabError {
  // DEV-13 honesty: an unbuilt operation says so with 501. It never 404s
  // (which would deny the contract) and never fakes a 200.
  return new CollabError('not_implemented', `operation ${opName} is not implemented on this node`);
}

export { CollabError, RETRYABLE_BY_DEFAULT };
