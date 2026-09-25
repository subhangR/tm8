/**
 * `header_long` (task 01a0da5a, D2): a whenToUse past the 400-character
 * guidance is written WHOLE and the write instructs, never refuses. Every door
 * (header set, entity create, artifact publish) reaches it through
 * `setEntityHeader`.
 */
import { describe, expect, it } from 'vitest';

import { headerLongWarning, setEntityHeader } from '../../src/headers/write.js';
import type { Querier } from '../../src/db/types.js';

const ok = { entity: { id: 'e' } } as never;

describe('headerLongWarning', () => {
  it('is silent at the guidance, and names the length past it', () => {
    expect(headerLongWarning({ whenToUse: 'w'.repeat(400) }, ok)).toBeNull();
    expect(headerLongWarning({ whenToUse: `  ${'w'.repeat(400)}  ` }, ok)).toBeNull();
    expect(headerLongWarning({ summary: 's'.repeat(5000) }, ok)).toBeNull();
    const warning = headerLongWarning({ whenToUse: '😀'.repeat(401) }, ok)!;
    expect(warning.code).toBe('header_long');
    expect(warning.message).toContain('401 characters and was written whole');
    expect(warning.message).not.toContain('shown cut');
    expect(headerLongWarning({ whenToUse: 'w'.repeat(2001) }, ok)!.message).toContain('past 2000 it is shown cut, declared in clipped');
  });

  it('says nothing when the RPC stored nothing (its own warning explains why)', () => {
    for (const code of ['header_not_stored', 'header_empty']) {
      expect(headerLongWarning({ whenToUse: 'w'.repeat(500) }, { ...ok, warnings: [{ code, message: 'x' }] })).toBeNull();
    }
  });
});

describe('setEntityHeader', () => {
  it('passes the text to the RPC uncut, and appends header_long after the RPC\'s own warnings', async () => {
    const calls: unknown[][] = [];
    const q = { rpc: async (_name: string, args: unknown[]) => { calls.push(args); return { ...ok, warnings: [{ code: 'other', message: 'o' }] }; } } as unknown as Querier;
    const long = 'w'.repeat(700);
    const result = await setEntityHeader(q, 'e', { whenToUse: long }, 0, null, null);
    expect(calls[0]![3]).toBe(long);
    expect(result.warnings!.map((w) => w.code)).toEqual(['other', 'header_long']);
    const short = await setEntityHeader(q, 'e', { whenToUse: 'Open when X' }, 0, null, null);
    expect(short.warnings!.map((w) => w.code)).toEqual(['other']);
  });
});
