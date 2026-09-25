/**
 * The Jev cost strings are the design's (§6), per group and per run.
 */
import { describe, expect, it } from 'vitest';

import { formatGroupCost, formatRunCost } from './format';
import { cost } from './test-support';

describe('cost strings (design §6)', () => {
  it('per group and per run', () => {
    expect(formatGroupCost(cost(1, 0.00004, 400))).toBe('$0.00004 · 0.4 s');
    expect(formatRunCost(cost(7, 0.00021, 1100))).toBe('✦ 7 calls · 1.1 s · $0.00021');
    expect(formatRunCost(cost(1, 0.00004, 400))).toBe('✦ 1 call · 0.4 s · $0.00004');
  });
});
