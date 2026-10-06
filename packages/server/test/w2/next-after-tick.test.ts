/**
 * `nextAfterTick` — the step a `task.tick` receipt hands the holder once no
 * criterion is left open (Spec D1 §6.3 R3, P0h). The receipt path that calls
 * it runs against Postgres in `receipt.pg.test.ts`; this pins the rule itself.
 */
import { describe, expect, it } from 'vitest';
import { nextAfterTick } from '../../src/facade/receipt.js';

const T = '01a111b2-b190-7252-af93-6f28e0c764a6';

describe('nextAfterTick', () => {
  it('names task complete at the version the tick left, once nothing is open', () => {
    expect(nextAfterTick(T, 'working', 'none', 9, 0, 3)).toBe(`tm8 task complete ${T} --expect-version 9`);
    expect(nextAfterTick(T, 'open', null, 2, 0, 1)).toBe(`tm8 task complete ${T} --expect-version 2`);
    expect(nextAfterTick(T, 'in_review', 'none', 5, 0, 2)).toBe(`tm8 task complete ${T} --expect-version 5`);
  });

  it('moves a task with the opt-in pr_merged gate to in_review, and stops there', () => {
    expect(nextAfterTick(T, 'working', 'pr_merged', 9, 0, 3)).toBe(`tm8 task transition ${T} in_review`);
    expect(nextAfterTick(T, 'in_review', 'pr_merged', 9, 0, 3)).toBeUndefined();
  });

  it('says nothing while criteria are open, with no criteria, or once the task is closed', () => {
    expect(nextAfterTick(T, 'working', 'none', 9, 1, 3)).toBeUndefined();
    expect(nextAfterTick(T, 'working', 'none', 9, 0, 0)).toBeUndefined();
    expect(nextAfterTick(T, 'done', 'none', 9, 0, 3)).toBeUndefined();
    expect(nextAfterTick(T, 'cancelled', 'none', 9, 0, 3)).toBeUndefined();
  });
});
