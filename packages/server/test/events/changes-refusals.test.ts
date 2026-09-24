/**
 * `events.changes` refusals ride EXISTING error codes (spec doc 01a0cf35 §6,
 * step 4 item 5): the reason is `details.reason`, never a new code. The
 * refusals themselves are exercised against a real database in
 * changes.pg.test.ts; this pins that none of them widened the closed code set,
 * and the byte-aware cut the multi-byte worst case relies on.
 */
import { describe, expect, it } from 'vitest';
import { ERROR_STATUS, type CommandErrorCode, type EventChangesRefusal } from '@tm8/contract';

import { truncateBytes } from '../../src/events/changes.js';

/** Each refusal reason and the existing code it rides. */
const REFUSALS: Record<EventChangesRefusal, CommandErrorCode> = {
  index_incomplete: 'invalid_cursor',
  scope_too_large: 'invalid_input',
  digest_group_too_large: 'payload_too_large',
};

describe('events.changes refusals', () => {
  it('ride existing codes: no reason is itself an error code', () => {
    for (const [reason, code] of Object.entries(REFUSALS)) {
      expect(ERROR_STATUS[code], code).toBeGreaterThanOrEqual(400);
      expect(Object.keys(ERROR_STATUS)).not.toContain(reason);
    }
  });

  it('leave the closed error-code set exactly as it was', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([
      'conflict', 'context_budget_too_small', 'forbidden',
      // Forms W1 (#734) added these five; #733's pin predates them on main.
      'form_answers_invalid', 'form_not_open', 'form_respondent_not_allowed', 'form_response_limit',
      'form_structure_frozen',
      'invalid_cursor', 'invalid_input',
      'invariant_violation', 'limit_exceeded', 'not_found', 'not_implemented', 'payload_too_large',
      'rate_limited', 'unauthenticated', 'upstream_unavailable', 'version_conflict',
    ]);
  });
});

describe('truncateBytes', () => {
  const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

  it('returns text that fits unchanged', () => {
    expect(truncateBytes('short', 120)).toBe('short');
    expect(truncateBytes('会'.repeat(40), 120)).toBe('会'.repeat(40));
  });

  it('cuts multi-byte text on a code-point boundary, within the cap, ending in …', () => {
    const cut = truncateBytes('会'.repeat(200), 120);
    expect(bytes(cut)).toBeLessThanOrEqual(120);
    expect(cut).toBe(`${'会'.repeat(39)}…`);
    // A 4-byte astral character is never split into a lone surrogate.
    const astral = truncateBytes('😀'.repeat(50), 10);
    expect(astral).toBe('😀…');
    expect(bytes(astral)).toBeLessThanOrEqual(10);
  });
});
