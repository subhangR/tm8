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
import { ApiError, EXIT_BY_COMMAND_ERROR, exitCodeForCommandError } from '../src/errors.js';
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
    expect([...EXIT_CODES]).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 130]);
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
