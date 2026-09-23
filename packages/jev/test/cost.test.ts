import { describe, expect, it } from 'vitest';
import { JEV_INPUT_USD_PER_TOKEN, costOf } from '../src/cost.js';

describe('costOf', () => {
  it('is $42 per billion input tokens', () => {
    expect(JEV_INPUT_USD_PER_TOKEN).toBe(42 / 1e9);
    expect(costOf({ input_tokens: 1e9 })).toBeCloseTo(42, 9);
  });

  it('prices the recorded live call: 1,289 input tokens', () => {
    expect(costOf({ input_tokens: 1289, output_tokens: 213 } as { input_tokens: number })).toBeCloseTo(0.000054138, 12);
  });

  it('takes a call record as well as a wire usage block', () => {
    expect(costOf({ inputTokens: 500 })).toBe(costOf({ input_tokens: 500 }));
  });

  it('charges nothing for output', () => {
    expect(costOf({ input_tokens: 0, output_tokens: 1e9 } as { input_tokens: number })).toBe(0);
  });

  it('prices a missing, negative or non-finite count as zero, never NaN', () => {
    expect(costOf({})).toBe(0);
    expect(costOf({ input_tokens: -5 })).toBe(0);
    expect(costOf({ inputTokens: Number.NaN })).toBe(0);
    expect(costOf({ input_tokens: Number.POSITIVE_INFINITY })).toBe(0);
  });
});
