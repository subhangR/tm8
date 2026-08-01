/**
 * The closed error taxonomy, projected onto the frozen exit table.
 *
 * There are two closed code sets in the contract and they are NOT the same
 * list, which is the trap this module exists to close:
 *
 *   `CommandErrorCode` — 13 codes, what the wire actually carries (DEV-8).
 *   `ErrorCode`        — the 7-code W0-dossier subset used by the amendment
 *                        family's own refusals.
 *
 * Every member of both maps to exactly one code in the frozen §7.6 table, and
 * both maps are exhaustive `Record<...>` types so adding a taxonomy member to
 * `@tm8/contract` fails THIS build rather than silently falling through to a
 * default. The CLI invents no codes and no reasons: `details.reason` is
 * rendered verbatim from the Server's own `AmendmentErrorReason` vocabulary.
 *
 * `not_implemented` is a normal, honest, closed error envelope — a handler
 * that does not exist on this node (DEV-13). It renders like any other refusal
 * and exits 8. It is not a crash and it is not a transport failure, and the
 * prototype's habit of filing it next to ECONNREFUSED is exactly what made
 * "the server isn't built yet" indistinguishable from "the server is down".
 */
import type { CommandErrorCode, ErrorCode } from '@tm8/contract';
import {
  CliError,
  EXIT_CONFLICT,
  EXIT_FORBIDDEN,
  EXIT_NOT_FOUND,
  EXIT_NOT_IMPLEMENTED,
  EXIT_PAYLOAD_TOO_LARGE,
  EXIT_PROTOCOL,
  EXIT_RETRYABLE,
  EXIT_UNAUTHENTICATED,
  EXIT_UNSETTLED,
  EXIT_USAGE,
  type ExitCode,
} from './exit.js';

/**
 * The wire taxonomy → §7.6. Exhaustive by type.
 *
 * `conflict` and `invariant_violation` join `version_conflict` at 6 because
 * §7.6 names that code "version conflict OR invariant violation" — all three
 * mean "the graph refused this write against its current truth", and all three
 * are answered by re-reading rather than by retrying blind.
 *
 * `rate_limited`, `limit_exceeded`, and `upstream_unavailable` are 7 — the
 * contract's own `RETRYABLE_BY_DEFAULT` set, which is why 7's sentence says
 * "capacity/upstream/transport" rather than naming one cause.
 */
export const EXIT_BY_COMMAND_ERROR: Record<CommandErrorCode, ExitCode> = {
  invalid_input: EXIT_USAGE,
  invalid_cursor: EXIT_USAGE,
  unauthenticated: EXIT_UNAUTHENTICATED,
  forbidden: EXIT_FORBIDDEN,
  not_found: EXIT_NOT_FOUND,
  version_conflict: EXIT_CONFLICT,
  conflict: EXIT_CONFLICT,
  invariant_violation: EXIT_CONFLICT,
  payload_too_large: EXIT_PAYLOAD_TOO_LARGE,
  rate_limited: EXIT_RETRYABLE,
  limit_exceeded: EXIT_RETRYABLE,
  not_implemented: EXIT_NOT_IMPLEMENTED,
  upstream_unavailable: EXIT_RETRYABLE,
};

/** The 7-code W0 subset → §7.6. Exhaustive by type. */
export const EXIT_BY_ERROR_CODE: Record<ErrorCode, ExitCode> = {
  invalid_input: EXIT_USAGE,
  forbidden: EXIT_FORBIDDEN,
  not_found: EXIT_NOT_FOUND,
  conflict: EXIT_CONFLICT,
  invariant_violation: EXIT_CONFLICT,
  limit_exceeded: EXIT_RETRYABLE,
  not_implemented: EXIT_NOT_IMPLEMENTED,
};

export function exitCodeForCommandError(code: CommandErrorCode): ExitCode {
  return EXIT_BY_COMMAND_ERROR[code];
}

/**
 * HTTP statuses that mean "ask again later" even when the body is not
 * contract-shaped. A load balancer's 503 HTML page is still a 503.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);

/** `details.reason`, when the Server sent one. Never synthesized by the CLI. */
function reasonOf(details: unknown): string | undefined {
  if (details === null || typeof details !== 'object') return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
}

/** A typed refusal carrying the Server's own taxonomy code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: CommandErrorCode,
    message: string,
    readonly requestId: string,
    readonly retryable: boolean,
    readonly details: unknown,
    /** The operation whose binding produced this — for the diagnostic line. */
    readonly operation?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The Server's `AmendmentErrorReason`, e.g. `use_message_send`. */
  get reason(): string | undefined {
    return reasonOf(this.details);
  }

  get exitCode(): ExitCode {
    return EXIT_BY_COMMAND_ERROR[this.code];
  }
}

/** No HTTP answer at all: DNS, ECONNREFUSED, abort, timeout. Always retryable. */
export class TransportError extends Error {
  readonly exitCode: ExitCode = EXIT_RETRYABLE;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TransportError';
  }
}

/**
 * An answer that is not contract-shaped: a 200 without `{data, requestId}`, a
 * 4xx/5xx whose body fails `WireErrorBodySchema`, unparseable JSON. This is
 * exit 10 — "other Server/protocol failure" — unless the status itself is a
 * retryable one, in which case an HTML 503 is still just a 503.
 */
export class ProtocolError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message);
    this.name = 'ProtocolError';
    this.exitCode = status !== undefined && RETRYABLE_STATUSES.has(status)
      ? EXIT_RETRYABLE
      : EXIT_PROTOCOL;
  }
}

/**
 * A `WS` catalog row reached through the request client. Usage (2), not a
 * server failure: nothing was sent, and the caller wants `tm8 event watch`.
 */
export class StreamOperationError extends CliError {
  constructor(operation: string) {
    super(
      `operation ${operation} is a stream (WS); it cannot be invoked as a request`,
      EXIT_USAGE,
      { hint: 'use `tm8 event watch`' },
    );
    this.name = 'StreamOperationError';
  }
}

/**
 * `--wait settled` observed a stored batch whose delivery did not settle.
 * Exit 11 and nothing else may use it: persistence SUCCEEDED, so this is not
 * a failure of the write and the caller must not retry the send.
 */
export class UnsettledDeliveryError extends Error {
  readonly exitCode: ExitCode = EXIT_UNSETTLED;
  constructor(message: string, readonly stored: unknown, readonly outcomes: unknown) {
    super(message);
    this.name = 'UnsettledDeliveryError';
  }
}

/** SIGINT. 130 by shell convention. */
export class InterruptedError extends Error {
  readonly exitCode: ExitCode = 130;
  constructor(message = 'interrupted') {
    super(message);
    this.name = 'InterruptedError';
  }
}

/**
 * Rejected vocabulary — `whoami`, `report`, `progress`, public `session
 * prompt`, and the compatibility aliases. These must FAIL, and they must fail
 * saying where the capability went; silently not existing would leave an agent
 * that learned the old grammar guessing.
 */
export class RetiredCommandError extends CliError {
  constructor(readonly command: string, replacement: string) {
    super(`\`tm8 ${command}\` no longer exists — ${replacement}`, EXIT_USAGE, {
      hint: 'run `tm8 help` for the current grammar',
    });
    this.name = 'RetiredCommandError';
  }
}

type WithExit = { exitCode: ExitCode };

function hasExitCode(err: unknown): err is WithExit {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { exitCode?: unknown }).exitCode === 'number'
  );
}

/**
 * The single funnel every thrown value passes through. An error nobody
 * classified is exit 10, not exit 0 and not exit 1: an unrecognized failure is
 * a protocol/implementation failure of this CLI and must be visibly one.
 */
export function exitCodeFor(err: unknown): ExitCode {
  if (hasExitCode(err)) return err.exitCode;
  return EXIT_PROTOCOL;
}

/**
 * The stderr rendering. Diagnostics NEVER go to stdout (§7.1), so this returns
 * lines for the caller to write to stderr rather than printing anything.
 *
 * Shape: `tm8: <code>: <message>` plus, when present, the Server's own
 * `reason`, its `requestId`, and retry advice. Every one of those is a fact
 * the Server sent; none is invented here.
 */
export function errorLines(err: unknown): string[] {
  if (err instanceof ApiError) {
    const parts = [`tm8: ${err.code}: ${err.message}`];
    const reason = err.reason;
    if (reason) parts.push(`reason: ${reason}`);
    if (err.requestId) parts.push(`requestId: ${err.requestId}`);
    const lines = [parts.join(' · ')];
    if (err.retryable) {
      lines.push('  retryable: retry with the SAME --mutation-id; a new id is a new mutation');
    }
    if (err.code === 'not_implemented') {
      lines.push('  this operation is catalogued but not implemented on this node (honest 501)');
    }
    return lines;
  }
  if (err instanceof CliError) {
    const lines = [`tm8: ${err.message}`];
    if (err.hint) lines.push(`  ${err.hint}`);
    return lines;
  }
  if (err instanceof TransportError || err instanceof ProtocolError) {
    return [`tm8: ${err.message}`];
  }
  if (err instanceof UnsettledDeliveryError) {
    return [`tm8: ${err.message}`, '  the message IS stored; do not resend'];
  }
  // The default message is 'interrupted' (SIGINT), but the attach stream's
  // close path constructs this with the WS close code and the server's reason;
  // rendering a fixed string here silently discarded "no live PTY for session".
  if (err instanceof InterruptedError) return [`tm8: ${err.message}`];
  return [`tm8: unexpected failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}`];
}
