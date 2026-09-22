import { describe, expect, it, vi } from 'vitest';
import { JevClient } from '../src/client.js';

const QUESTIONS = {
  one: {
    type: 'score' as const,
    instructions: 'score this fixture',
    criteria: ['no', 'yes'],
  },
};

const OK = {
  model: 'jev-2026-09-22-build-17',
  answers: { one: { score: 1, confidence: 0.9 } },
  usage: { input_tokens: 17, output_tokens: 0 },
};

describe('JevClient bounded calls', () => {
  it('enforces one hard budget across retries, including a stalled attempt', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 503 });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const client = new JevClient({
      apiKey: 'fixture-key',
      budgetMs: 45,
      attemptTimeoutMs: 500,
      retries: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const started = performance.now();
    const result = await client.askDetailed({ fixture: true }, QUESTIONS);
    const elapsed = performance.now() - started;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('budget');
    expect(calls).toBe(2);
    expect(elapsed).toBeLessThan(250);
  });

  it('stops immediately on a definitive HTTP failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    const client = new JevClient({
      apiKey: 'fixture-key',
      budgetMs: 500,
      attemptTimeoutMs: 100,
      retries: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.askDetailed({}, QUESTIONS);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('http_error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves legacy ask null-on-failure behavior', async () => {
    const client = new JevClient({
      apiKey: 'fixture-key',
      budgetMs: 500,
      attemptTimeoutMs: 100,
      retries: 0,
      fetchImpl: (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch,
    });

    await expect(client.ask({}, QUESTIONS)).resolves.toBeNull();
  });

  it('stops retry exhaustion with one detailed failure outcome', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response('{}', { status: 503 });
    });
    const client = new JevClient({
      apiKey: 'fixture-key', budgetMs: 500, attemptTimeoutMs: 100, retries: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.askDetailed({}, QUESTIONS);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('5xx');
    expect(calls).toBe(3);
  });

  it('classifies malformed JSON as unparsed without retrying', async () => {
    const fetchImpl = vi.fn(async () => new Response('not-json', { status: 200 }));
    const client = new JevClient({
      apiKey: 'fixture-key', budgetMs: 500, attemptTimeoutMs: 100, retries: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.askDetailed({}, QUESTIONS);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unparsed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
