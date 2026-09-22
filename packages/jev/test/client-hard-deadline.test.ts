import { describe, expect, it } from 'vitest';
import { JevClient } from '../src/client.js';

const QUESTIONS = {
  one: { type: 'score' as const, instructions: 'fixture', criteria: ['no', 'yes'] },
};

describe('hard logical deadline', () => {
  it('does not add grace beyond a one millisecond total budget', async () => {
    const client = new JevClient({
      apiKey: 'fixture-key',
      budgetMs: 1,
      attemptTimeoutMs: 2_000,
      retries: 3,
      fetchImpl: (async () => new Promise<Response>(() => {})) as unknown as typeof fetch,
    });
    const started = performance.now();
    const result = await client.askDetailed({}, QUESTIONS);
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('budget');
    expect(elapsed).toBeLessThan(100);
  });
});
