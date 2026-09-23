// The client's bounds and its call record. Adapted from PR #644's
// client-budget, client-hard-deadline and client-usage suites.

import { describe, expect, it, vi } from 'vitest';
import type { JevFailure } from '@tm8/contract';
import { createJevClient, jevClientFromEnv, type JevAskResult, type JevClientOptions } from '../src/client.js';
import { costOf } from '../src/cost.js';

const QUESTIONS = {
  one: { type: 'score' as const, instructions: 'score this fixture', criteria: ['no', 'yes'] },
};

const okBody = (model = 'jev-1.13.0', inputTokens = 23) => ({
  model,
  answers: { one: { score: 1, confidence: 0.9 } },
  usage: { input_tokens: inputTokens, output_tokens: 4 },
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A fetch that never answers on its own, and rejects when its signal aborts. */
const stall = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });

function client(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, extra: Partial<JevClientOptions> = {}) {
  return createJevClient({
    apiKey: 'fixture-key',
    totalBudgetMs: 1_000,
    attemptTimeoutMs: 200,
    retries: 1,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...extra,
  });
}

/** The one invariant every outcome must satisfy. */
function expectOneRecord(result: JevAskResult) {
  const { call } = result;
  expect(call.outcome).toBe(result.ok ? 'ok' : result.reason);
  expect(call.costUsd).toBeCloseTo(costOf({ inputTokens: call.inputTokens }), 15);
  expect(call.latencyMs).toBeGreaterThanOrEqual(0);
  expect(Object.keys(call).sort()).toEqual(['costUsd', 'inputTokens', 'jevModel', 'latencyMs', 'outcome', 'outputTokens']);
}

describe('the defaults', () => {
  it('are 5 s total, 2 s per attempt, one retry', async () => {
    const mod = await import('../src/client.js');
    expect(mod.JEV_DEFAULT_TOTAL_BUDGET_MS).toBe(5_000);
    expect(mod.JEV_DEFAULT_ATTEMPT_TIMEOUT_MS).toBe(2_000);
    expect(mod.JEV_DEFAULT_RETRIES).toBe(1);
  });
});

describe('the total budget', () => {
  it('holds across a retry, including a stalled second attempt', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 503 });
      return stall(init);
    });
    const started = performance.now();
    const result = await client(fetchImpl, { totalBudgetMs: 60, attemptTimeoutMs: 500, retries: 3 }).ask({}, QUESTIONS);
    const elapsed = performance.now() - started;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('budget');
    expect(calls).toBe(2);
    expect(elapsed).toBeLessThan(250);
    expectOneRecord(result);
  });

  it('adds no grace beyond a one-millisecond budget', async () => {
    const started = performance.now();
    const result = await client(async (_u, init) => stall(init), { totalBudgetMs: 1, attemptTimeoutMs: 2_000, retries: 3 }).ask({}, QUESTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('budget');
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('refuses a zero budget without a request', async () => {
    const fetchImpl = vi.fn(async () => json(okBody()));
    const result = await client(fetchImpl, { totalBudgetMs: 0 }).ask({}, QUESTIONS);
    expect(!result.ok && result.reason).toBe('budget');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the per-attempt timeout', () => {
  it('cuts each attempt at its own limit, aborts it, and retries once', async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      return stall(init);
    });
    const started = performance.now();
    const result = await client(fetchImpl, { totalBudgetMs: 2_000, attemptTimeoutMs: 40, retries: 1 }).ask({}, QUESTIONS);
    const elapsed = performance.now() - started;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
    // Two 40 ms attempts, nowhere near the 2 s total.
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(400);
    expectOneRecord(result);
  });

  it('ignores a body that lands after its attempt timed out', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 60));
      return json(okBody('jev-late', 999));
    });
    const result = await client(fetchImpl, { attemptTimeoutMs: 20, retries: 0 }).ask({}, QUESTIONS);
    await new Promise((r) => setTimeout(r, 80));
    expect(!result.ok && result.reason).toBe('timeout');
    expect(result.call).toMatchObject({ inputTokens: 0, jevModel: null });
    expect(calls).toBe(1);
  });
});

describe('what is retried', () => {
  it.each<[number, JevFailure]>([
    [429, 'rate_limited'],
    [529, 'overloaded'],
    [500, 'server_error'],
    [503, 'server_error'],
  ])('retries %i once, then reports %s', async (status, reason) => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status }));
    const result = await client(fetchImpl).ask({}, QUESTIONS);
    expect(!result.ok && result.reason).toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expectOneRecord(result);
  });

  it('retries a network error once', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await client(fetchImpl).ask({}, QUESTIONS);
    expect(!result.ok && result.reason).toBe('network');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 422])('stops at once on HTTP %i', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status }));
    const result = await client(fetchImpl, { retries: 3 }).ask({}, QUESTIONS);
    expect(!result.ok && result.reason).toBe('http_error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expectOneRecord(result);
  });

  it('stops at once on malformed JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('not-json', { status: 200 }));
    const result = await client(fetchImpl, { retries: 3 }).ask({}, QUESTIONS);
    expect(!result.ok && result.reason).toBe('unparsed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops at once on answers of the wrong shape, and still records the billed tokens', async () => {
    const body = { ...okBody('jev-1.13.0', 31), answers: { one: { score: 7, confidence: 0.9 } } };
    const fetchImpl = vi.fn(async () => json(body));
    const result = await client(fetchImpl, { retries: 3 }).ask({}, QUESTIONS);
    expect(!result.ok && result.reason).toBe('unparsed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.call).toMatchObject({ inputTokens: 31, jevModel: 'jev-1.13.0', outcome: 'unparsed' });
  });

  it('stops at once, with no request, when there is no key', async () => {
    const fetchImpl = vi.fn(async () => json(okBody()));
    const result = await client(fetchImpl, { apiKey: '  ' }).ask({}, QUESTIONS);
    expect(!result.ok && result.reason).toBe('no_key');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.call).toMatchObject({ inputTokens: 0, costUsd: 0, jevModel: null, outcome: 'no_key' });
  });

  it('succeeds on the retry with one record carrying only the answered attempt', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response('{}', { status: 529 }) : json(okBody('jev-1.13.0', 23));
    });
    const result = await client(fetchImpl).ask({}, QUESTIONS);
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(result.call).toMatchObject({ jevModel: 'jev-1.13.0', inputTokens: 23, outputTokens: 4, outcome: 'ok' });
    expect(result.call.costUsd).toBeCloseTo(23 * 42e-9, 15);
    expectOneRecord(result);
  });
});

describe('the recorded model', () => {
  it.each(['jev-latest', 'latest', 'jev', 'jev-default', 'jev:auto', '', '   '])('records alias %j as null', async (model) => {
    const result = await client(async () => json(okBody(model))).ask({}, QUESTIONS);
    expect(result.ok).toBe(true);
    expect(result.call.jevModel).toBeNull();
  });

  it.each(['jev-1.13.0', 'jev-2026-09-22-build-17'])('records concrete version %j as itself', async (model) => {
    const result = await client(async () => json(okBody(model))).ask({}, QUESTIONS);
    expect(result.call.jevModel).toBe(model);
  });
});

describe('ask never throws', () => {
  it('reports state that cannot be serialised as unparsed', async () => {
    const fetchImpl = vi.fn(async () => json(okBody()));
    const result = await client(fetchImpl).ask({ big: 1n }, QUESTIONS);
    expect(!result.ok && result.reason).toBe('unparsed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a fetch that throws synchronously as network', async () => {
    const fetchImpl = ((): never => {
      throw new Error('boom');
    }) as unknown as (url: string) => Promise<Response>;
    const result = await client(fetchImpl, { retries: 0 }).ask({}, QUESTIONS);
    expect(!result.ok && result.reason).toBe('network');
  });

  it('sends the key only as a bearer header, and the state, model and questions as the body', async () => {
    const fetchImpl = vi.fn(async (_u: string, _init?: RequestInit) => json(okBody()));
    await client(fetchImpl).ask({ task: 'x' }, QUESTIONS);
    const init = fetchImpl.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fixture-key');
    expect(JSON.parse(init.body as string)).toEqual({ state: { task: 'x' }, model: 'jev-latest', questions: QUESTIONS });
    expect(init.body as string).not.toContain('fixture-key');
  });
});

describe('jevClientFromEnv', () => {
  it('reads TYPESAFE_API_KEY', async () => {
    const fetchImpl = vi.fn(async () => json(okBody()));
    const c = jevClientFromEnv({ TYPESAFE_API_KEY: ' k ' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(c).not.toBeNull();
    expect((await c!.ask({}, QUESTIONS)).ok).toBe(true);
  });

  it('reads nothing else — no JEV_API_KEY fallback, no policy switch', () => {
    expect(jevClientFromEnv({ JEV_API_KEY: 'k', TM8_ROUTING_POLICY: 'auto' })).toBeNull();
    expect(jevClientFromEnv({ TYPESAFE_API_KEY: '   ' })).toBeNull();
    expect(jevClientFromEnv({})).toBeNull();
  });
});
