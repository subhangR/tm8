import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { harness, validInput, withoutRequestId, type Harness } from './support.js';

// Review addendum 2, C4: the broker checks every input through boundedSafeParse with a budget of 0,
// so a body of thousands of bad elements costs one zod issue, not one or more per element
// (src/bounded-parse.ts, GHSA-mrhx-c7xc-m3w5). This wraps the real helper to see each call. Every
// value here is synthetic.

const parses = vi.hoisted(() => [] as { budget: number; success: boolean; overBudget: boolean }[]);
vi.mock('../../src/bounded-parse.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/bounded-parse.js')>();
  return {
    ...real,
    boundedSafeParse(schema: ZodTypeAny, value: unknown, budget: number) {
      const result = real.boundedSafeParse(schema, value, budget);
      parses.push({ budget, success: result.success, overBudget: 'overBudget' in result });
      return result;
    },
  };
});

const opened: Harness[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((h) => h.close()));
  parses.length = 0;
});

describe('the broker bounds every input check (review addendum 2, C4)', () => {
  it('refuses vault.imports.commit rows at the first issue, with the answer one bad row gets', async () => {
    const h = await harness();
    opened.push(h);
    const many = await h.send('vault.imports.commit', { input: { ...validInput('vault.imports.commit'), rows: Array.from({ length: 5000 }, () => ({})) } });
    expect(many.status).toBe(400);
    expect(many.json.error.code).toBe('invalid_input');
    expect(parses).toEqual([{ budget: 0, success: false, overBudget: true }]);
    const one = await h.send('vault.imports.commit', { input: { ...validInput('vault.imports.commit'), rows: [{}] } });
    expect(withoutRequestId(one)).toEqual(withoutRequestId(many));
  });

  it('passes a valid input at the same budget', async () => {
    const h = await harness();
    opened.push(h);
    await h.send('vault.imports.commit');
    expect(parses[0]).toEqual({ budget: 0, success: true, overBudget: false });
  });
});
