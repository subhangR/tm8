/**
 * Exit codes — the agent-facing contract of this CLI.
 *
 * This is the frozen table from TM8-CLI-GRAMMAR-REDESIGN §7.6, verbatim. It
 * replaces the prototype's four-code set, which did not merely lack codes: it
 * *collided* with this one.
 *
 *   prototype  3 = "the server refused"    frozen  3 = unauthenticated
 *   prototype  4 = "could not answer"      frozen  4 = forbidden
 *
 * A script branching on `$?` therefore read a missing handler (prototype 4) as
 * "you are not allowed to do that" (frozen 4), and read every server refusal —
 * not-found, version conflict, forbidden — as one undifferentiated 3. Exit
 * codes exist precisely so that branch can be written without parsing prose,
 * so a semantic collision in this table is a defect in the contract itself,
 * not a missing convenience.
 *
 * Machine consumers inspect the typed `CommandErrorCode` on the JSON error;
 * these codes stay broad shell categories. There is deliberately no 1 and no
 * 12: 1 is the shell's own "generic failure" and reserving it would make a
 * crashed node process indistinguishable from a considered CLI verdict.
 */

/** 0 — the command did what it said. */
export const EXIT_OK = 0;
/** 2 — CLI usage, local validation, invalid input or cursor. Never reached the network. */
export const EXIT_USAGE = 2;
/** 3 — unauthenticated: the Server does not know who is calling. */
export const EXIT_UNAUTHENTICATED = 3;
/** 4 — forbidden: the Server knows who is calling and says no. */
export const EXIT_FORBIDDEN = 4;
/** 5 — not found. */
export const EXIT_NOT_FOUND = 5;
/** 6 — version conflict or invariant violation. Re-read, then retry deliberately. */
export const EXIT_CONFLICT = 6;
/** 7 — retryable capacity/upstream/transport failure. The same mutation id may be reused. */
export const EXIT_RETRYABLE = 7;
/** 8 — not implemented on this node. An honest 501 (DEV-13), not a refusal. */
export const EXIT_NOT_IMPLEMENTED = 8;
/** 9 — payload too large. */
export const EXIT_PAYLOAD_TOO_LARGE = 9;
/** 10 — other Server/protocol failure: an answer that is not contract-shaped. */
export const EXIT_PROTOCOL = 10;
/** 11 — `--wait settled` only: stored, but a requested delivery is incomplete/non-delivered. */
export const EXIT_UNSETTLED = 11;
/** 13 — `event watch --until-match` only: `--timeout` expired before a matching event arrived. */
export const EXIT_WAIT_TIMEOUT = 13;
/**
 * 14 — `event watch --until-match` only: a matching event WAS found, but via
 * the `events.poll` fallback after the socket was lost. The match is real and
 * printed; the distinct code exists so a script can notice its live
 * subscription did not survive without parsing stderr. (12 is skipped: Node
 * itself exits 12 on a bad debug argument, and a code the runtime can emit on
 * its own is not a code this table can own.)
 */
export const EXIT_MATCHED_VIA_POLL = 14;
/** 130 — interrupted (SIGINT). */
export const EXIT_INTERRUPTED = 130;

/**
 * The complete frozen table. Keyed by code so a reader can go from a `$?` they
 * observed back to the sentence that explains it, and so the CLI's own help
 * renders the table rather than paraphrasing it.
 */
export const EXIT_MEANING = {
  0: 'success',
  2: 'CLI usage / local validation / invalid input or cursor',
  3: 'unauthenticated',
  4: 'forbidden',
  5: 'not found',
  6: 'version conflict or invariant violation',
  7: 'retryable capacity/upstream/transport failure',
  8: 'not implemented',
  9: 'payload too large',
  10: 'other Server/protocol failure',
  11: 'stored, but one or more requested work-session deliveries are incomplete or non-delivered (--wait settled only)',
  13: 'no matching event arrived before --timeout expired (event watch --until-match only)',
  14: 'matched, but via the events.poll fallback after the event socket was lost (event watch --until-match only)',
  130: 'interrupted',
} as const;

export type ExitCode = keyof typeof EXIT_MEANING;

/** Every code in the frozen table, ascending. */
export const EXIT_CODES: readonly ExitCode[] = Object.keys(EXIT_MEANING)
  .map((k) => Number(k) as ExitCode)
  .sort((a, b) => a - b);

export function isExitCode(code: number): code is ExitCode {
  return Object.prototype.hasOwnProperty.call(EXIT_MEANING, code);
}

/**
 * A failure the CLI decided locally: bad usage, a missing required flag, an
 * unreadable `@file`, a cursor it will not decode. Defaults to 2 because a
 * locally-decided failure that reached the network is a different bug.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly detail: unknown;
  /** Rendered on its own stderr line under the message — a next command to try. */
  readonly hint: string | undefined;

  constructor(
    message: string,
    exitCode: ExitCode = EXIT_USAGE,
    opts: { detail?: unknown; hint?: string } = {},
  ) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.detail = opts.detail;
    this.hint = opts.hint;
  }
}
