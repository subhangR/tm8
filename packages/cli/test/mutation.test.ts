/**
 * §7.4 idempotency.
 *
 * The load-bearing assertion is the negative one: a supplied `--mutation-id`
 * is passed through VERBATIM. A CLI that normalizes it breaks the one
 * mechanism that makes retry-after-transport-uncertainty safe — the caller
 * re-sends the same id expecting either a replay or an honest
 * `invariant_violation`, and a regenerated id silently produces a duplicate
 * write instead.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveMutationId,
  refuseMutationId,
  resolveMutationId,
  UUID_PATTERN,
  uuidv7,
} from '../src/mutation.js';
import { CliError } from '../src/exit.js';

describe('uuidv7', () => {
  it('is a well-formed v7 UUID: version nibble 7, variant 10', () => {
    const id = uuidv7();
    expect(id).toMatch(UUID_PATTERN);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
  });

  it('encodes the millisecond timestamp big-endian, so ids sort chronologically', () => {
    const early = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_001_000);
    expect(early.slice(0, 13) < later.slice(0, 13)).toBe(true);
    expect(early.slice(0, 8)).toBe(Math.floor(1_700_000_000_000 / 2 ** 16).toString(16).padStart(8, '0'));
  });

  it('two ids in the same millisecond still differ', () => {
    expect(uuidv7(1_700_000_000_000)).not.toBe(uuidv7(1_700_000_000_000));
  });
});

describe('resolveMutationId', () => {
  it('generates one when omitted', () => {
    expect(resolveMutationId(undefined)).toMatch(UUID_PATTERN);
  });

  it('returns a supplied id VERBATIM — including one that is not a UUID', () => {
    expect(resolveMutationId('c9f0e2b4-1111-7222-8333-444455556666')).toBe('c9f0e2b4-1111-7222-8333-444455556666');
    expect(resolveMutationId('batch-2026-07-27-retry-3')).toBe('batch-2026-07-27-retry-3');
    expect(resolveMutationId('AbC-UPPER')).toBe('AbC-UPPER');
  });

  it('refuses rather than normalizes a whitespace-padded id', () => {
    // Trimming would be the "helpful" thing and it is exactly wrong: the
    // trimmed id is a DIFFERENT mutation than the one the caller sent before.
    try {
      resolveMutationId(' abc ');
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).message).toMatch(/will not normalize/);
    }
  });

  it('refuses an empty id', () => {
    expect(() => resolveMutationId('')).toThrowError(CliError);
  });
});

describe('reads do not take a mutation id', () => {
  it('accepts absence', () => {
    expect(() => refuseMutationId('entity get', undefined)).not.toThrow();
  });

  it('refuses presence, naming the command', () => {
    try {
      refuseMutationId('entity get', 'm_1');
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).message).toContain('entity get');
    }
  });
});

describe('composed commands derive one id per catalog mutation (§4.10)', () => {
  const root = '018f4c6a-0000-7000-8000-000000000000';

  it('is deterministic, so a resumed composition derives the same stage ids', () => {
    expect(deriveMutationId(root, 'files.uploadInit')).toBe(deriveMutationId(root, 'files.uploadInit'));
  });

  it('never reuses one id across two operations', () => {
    const ids = ['files.uploadInit', 'files.uploadComplete', 'files.uploadAbort'].map((s) => deriveMutationId(root, s));
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain(root);
  });

  it('stays a well-formed UUID (v8 — derived, honestly not time-ordered)', () => {
    const id = deriveMutationId(root, 'files.uploadInit');
    expect(id).toMatch(UUID_PATTERN);
    expect(id[14]).toBe('8');
    expect('89ab').toContain(id[19]);
  });

  it('different roots derive different stage ids', () => {
    expect(deriveMutationId(root, 'files.uploadInit')).not.toBe(deriveMutationId('other', 'files.uploadInit'));
  });
});
