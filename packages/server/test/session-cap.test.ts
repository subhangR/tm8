// `TM8_SESSION_CAP` — the operator's control over the concurrency ceiling that
// used to be a hard-coded 8.
//
// The interesting cases are the ones where a naive implementation silently does
// the OPPOSITE of what was asked: `0` meaning unlimited must not reach the RPC's
// `greatest(coalesce(cap, 8), 1)` clamp as a cap of one, and "unlimited" must not
// overflow the `integer` parameter it has to pass through.

import { describe, expect, it } from 'vitest';
import { resolveSessionCap } from '../src/facade/execution-handlers.js';

const INT4_MAX = 2_147_483_647;

describe('resolveSessionCap', () => {
  it('keeps the historical default when unset, so upgrading changes nothing', () => {
    expect(resolveSessionCap({})).toBe(8);
    expect(resolveSessionCap({ TM8_SESSION_CAP: '' })).toBe(8);
    expect(resolveSessionCap({ TM8_SESSION_CAP: '   ' })).toBe(8);
  });

  it('honours an explicit number', () => {
    expect(resolveSessionCap({ TM8_SESSION_CAP: '32' })).toBe(32);
    expect(resolveSessionCap({ TM8_SESSION_CAP: '1' })).toBe(1);
    expect(resolveSessionCap({ TM8_SESSION_CAP: ' 64 ' })).toBe(64);
  });

  it('treats 0 and the words for "no limit" as a saturating cap, never as 1', () => {
    // The trap: the SQL guard is `>= greatest(coalesce(cap, 8), 1)`, so a 0
    // passed through would clamp UP to 1 and refuse the second session — the
    // exact opposite of "remove all limits".
    for (const value of ['0', 'unlimited', 'none', 'off', 'UNLIMITED', 'None']) {
      expect(resolveSessionCap({ TM8_SESSION_CAP: value })).toBe(INT4_MAX);
    }
  });

  it('never returns a value that would overflow the integer RPC parameter', () => {
    // `internal.execution_spawn(p_session_cap integer)` is int4. A JS-safe
    // integer here would make every spawn fail instead of none.
    expect(resolveSessionCap({ TM8_SESSION_CAP: 'unlimited' })).toBeLessThanOrEqual(INT4_MAX);
    expect(resolveSessionCap({ TM8_SESSION_CAP: '9007199254740991' })).toBe(INT4_MAX);
  });

  it('falls back to the default on garbage rather than to a smaller cap', () => {
    // A typo must not quietly throttle a node to one session.
    for (const value of ['abc', '-5', '0.5x', 'NaN']) {
      expect(resolveSessionCap({ TM8_SESSION_CAP: value })).toBe(8);
    }
  });
});
