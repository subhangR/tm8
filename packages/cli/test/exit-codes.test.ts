/**
 * RED-FIRST: the frozen exit-code table (TM8-CLI-GRAMMAR-REDESIGN §7.6).
 *
 * The shipped kernel shipped FOUR codes and two of them collided semantically
 * with the frozen table:
 *
 *   shipped  3 = EXIT_REFUSED     ("the server refused")
 *   frozen   3 = unauthenticated
 *   shipped  4 = EXIT_UNAVAILABLE ("transport, 5xx, or not_implemented")
 *   frozen   4 = forbidden
 *
 * So a shipped exit 3 and a frozen exit 3 were different facts, and a shipped
 * exit 4 (a handler that does not exist) read under the frozen table as "you
 * are not allowed to do that". A script that branches on the exit code could
 * not tell those apart, which is the whole point of having exit codes.
 *
 * The first block is written against the ApiError surface so the collision is
 * proven behaviourally rather than asserted by fiat. Its recorded red was:
 *   expected 3 to be 4   (403 forbidden)
 *   expected 4 to be 8   (501 not_implemented)
 *   expected 3 to be 5   (404 not_found)
 */
import { describe, expect, it } from 'vitest';
import type { CommandErrorCode } from '@tm8/contract';
import { ERROR_STATUS } from '@tm8/contract';
import { ApiError, EXIT_BY_COMMAND_ERROR, errorLines, exitCodeForCommandError } from '../src/errors.js';
import { EXIT_CODES, EXIT_MEANING, isExitCode } from '../src/exit.js';

function exitFor(status: number, code: CommandErrorCode): number {
  return new ApiError(status, code, 'x', 'req_1', false, undefined).exitCode;
}

describe('frozen exit-code table §7.6', () => {
  it('401 unauthenticated exits 3 and 403 forbidden exits 4 — they are different codes', () => {
    expect(exitFor(401, 'unauthenticated')).toBe(3);
    expect(exitFor(403, 'forbidden')).toBe(4);
  });

  it('501 not_implemented exits 8, never 4 (4 is forbidden)', () => {
    expect(exitFor(501, 'not_implemented')).toBe(8);
  });

  it('404 not_found exits 5, 409 version_conflict exits 6, 413 payload_too_large exits 9', () => {
    expect(exitFor(404, 'not_found')).toBe(5);
    expect(exitFor(409, 'version_conflict')).toBe(6);
    expect(exitFor(413, 'payload_too_large')).toBe(9);
  });

  it('is exactly the frozen table — no 1, no 12, nothing invented', () => {
    // 13 and 14 joined 2026-08-02 for `event watch --until-match` (F7), by the
    // same scoped-extension route 11 took for `--wait settled`. 15 joined
    // 2026-09-15 by that route too, for the one memory refusal a retry can
    // never clear. 12 stays skipped: Node itself can exit 12, so this table
    // cannot own it.
    expect([...EXIT_CODES]).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 130]);
    expect(EXIT_MEANING[3]).toBe('unauthenticated');
    expect(EXIT_MEANING[4]).toBe('forbidden');
    expect(EXIT_MEANING[8]).toBe('not implemented');
    expect(isExitCode(1)).toBe(false);
    expect(isExitCode(12)).toBe(false);
    expect(isExitCode(130)).toBe(true);
  });

  it('11 is reserved for --wait settled and collides with nothing', () => {
    const eleven = Object.values(EXIT_BY_COMMAND_ERROR).filter((c) => c === 11);
    expect(eleven).toHaveLength(0);
    expect(EXIT_MEANING[11]).toMatch(/deliveries are incomplete or non-delivered/);
  });

  it('13 and 14 are reserved for `event watch --until-match` and no server error maps to them', () => {
    const reserved = Object.values(EXIT_BY_COMMAND_ERROR).filter((c) => c === 13 || c === 14);
    expect(reserved).toHaveLength(0);
    expect(EXIT_MEANING[13]).toMatch(/no matching event arrived/);
    expect(EXIT_MEANING[14]).toMatch(/events\.poll fallback/);
  });

  it('15 is the already-corrected memory refusal, and no error CLASS maps to it', () => {
    // It is reached by the Server's `details.reason`, never by the taxonomy
    // code alone: `invariant_violation` on its own still exits 6, because
    // almost every invariant violation IS worth re-reading and retrying.
    const reserved = Object.values(EXIT_BY_COMMAND_ERROR).filter((c) => c === 15);
    expect(reserved).toHaveLength(0);
    expect(exitFor(409, 'invariant_violation')).toBe(6);
    expect(EXIT_MEANING[15]).toMatch(/already corrected that memory/);
  });
});

describe('a memory already corrected by somebody else', () => {
  const details = {
    reason: 'memory_already_corrected',
    correction: 'The daily sweep runs at 04:00 UTC, not 02:00, and it skips spaces with no memories.',
  };
  const refusal = (message: string): ApiError =>
    new ApiError(409, 'invariant_violation', message, 'req_9', false, details);

  it('exits 15 rather than 6 — the same write can never succeed, so a retry loop is wrong', () => {
    expect(refusal('Someone else corrected this memory first.').exitCode).toBe(15);
  });

  it('the same code with no such reason keeps exit 6', () => {
    expect(
      new ApiError(409, 'invariant_violation', 'x', 'req_9', false, { reason: 'project_not_linked' })
        .exitCode,
    ).toBe(6);
    expect(new ApiError(409, 'invariant_violation', 'x', 'req_9', false, undefined).exitCode).toBe(6);
  });

  it('prints the other correction in full when the server had to shorten it', () => {
    const lines = errorLines(refusal('Someone else corrected this memory first. Their correction says: "The daily sweep runs at 04:00 UTC…".'));
    expect(lines.join('\n')).toContain(details.correction);
    // No identifier anywhere in what the reader sees, and no retry advice: the
    // write is not retryable and saying so would send a script into a loop.
    expect(lines.join('\n')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(lines.join('\n')).not.toContain('retryable');
  });

  it('does not repeat the words when the server already fitted them in the message', () => {
    const whole = `Someone else corrected this memory first. Their correction says: "${details.correction}".`;
    const body = errorLines(refusal(whole)).join('\n');
    expect(body).toContain(details.correction);
    expect(body).not.toContain('their correction, in full:');
  });
});

describe('the closed taxonomy maps onto it exhaustively', () => {
  // Driven off the contract's own ERROR_STATUS keys: if a CommandErrorCode is
  // added upstream and not mapped here, this iterates it and fails.
  const codes = Object.keys(ERROR_STATUS) as CommandErrorCode[];

  it('covers every CommandErrorCode the contract defines', () => {
    expect(codes.length).toBe(13);
    for (const code of codes) {
      const exit = exitCodeForCommandError(code);
      expect(isExitCode(exit), `${code} -> ${exit}`).toBe(true);
      expect(exit).not.toBe(0);
      expect(exit).not.toBe(11);
    }
  });

  it('maps each code to the row §7.6 names for it', () => {
    expect(EXIT_BY_COMMAND_ERROR).toEqual({
      invalid_input: 2,
      invalid_cursor: 2,
      unauthenticated: 3,
      forbidden: 4,
      not_found: 5,
      version_conflict: 6,
      conflict: 6,
      invariant_violation: 6,
      payload_too_large: 9,
      rate_limited: 7,
      limit_exceeded: 7,
      not_implemented: 8,
      upstream_unavailable: 7,
    });
  });
});
