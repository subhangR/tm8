/**
 * Spec §8.1: a style document is at most 64 KiB and an oversized one is a 400.
 *
 * The request schemas cap each part (≤ 200 vars of ≤ 512 chars, css ≤ 16 KiB),
 * but those caps add up to well over 64 KiB. The whole-document cap is the
 * write path's: `normalizeForWrite` (create, update after the merge, and
 * resolve) parses with `StyleDocSchema`, whose size refine runs BEFORE
 * normalisation drops anything. So an oversized document is `invalid_input`
 * in the handler, and never reaches 284's `pg_column_size(vars)` check
 * (23514 → invariant_violation).
 */
import { describe, expect, it } from 'vitest';

import { CollabError, STYLE_MAX_DOC_BYTES } from '@tm8/contract';

import { normalizeForWrite } from '../../src/facade/services/w2/style-validation.js';

function docWithVars(count: number, valueLength: number) {
  const vars: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) vars[`--pn-size-${String(i).padStart(3, '0')}`] = 'a'.repeat(valueLength);
  return { schemaVersion: 1, foundation: 'builtin:atelier-light', vars, css: null };
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

describe('style document size (§8.1)', () => {
  it('refuses a document over 64 KiB with invalid_input, even when every var is within its own cap', () => {
    const doc = docWithVars(140, 500);
    expect(bytes(doc)).toBeGreaterThan(STYLE_MAX_DOC_BYTES);
    let caught: unknown;
    try {
      normalizeForWrite(doc);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CollabError);
    expect((caught as CollabError).code).toBe('invalid_input');
    expect((caught as CollabError).message).toContain(`larger than ${STYLE_MAX_DOC_BYTES} bytes`);
  });

  it('accepts a document under the cap (unknown keys are then dropped with a warning, not refused)', () => {
    const doc = docWithVars(100, 500);
    expect(bytes(doc)).toBeLessThan(STYLE_MAX_DOC_BYTES);
    const write = normalizeForWrite(doc);
    expect(write.warnings.some((w) => w.code === 'unknown-key')).toBe(true);
  });
});
