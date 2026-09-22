import { describe, expect, it } from 'vitest';
import { JevClient } from '../src/client.js';

const QUESTIONS = {
  one: {
    type: 'score' as const,
    instructions: 'score this fixture',
    criteria: ['no', 'yes'],
  },
};

const response = (model: string) => ({
  model,
  answers: { one: { score: 1, confidence: 0.9 } },
  usage: { input_tokens: 23, output_tokens: 0 },
});

function client(fetchImpl: typeof fetch, usageSink: (row: unknown) => void | Promise<void>) {
  return new JevClient({
    apiKey: 'fixture-key',
    budgetMs: 500,
    attemptTimeoutMs: 100,
    retries: 1,
    fetchImpl,
    usage: { caller: 'routing', spaceId: 'space-fixture', subjectId: 'subject-fixture' },
    usageSink,
  });
}

describe('JevClient usage ledger', () => {
  it('writes exactly one row after a retry succeeds and records the concrete model', async () => {
    let calls = 0;
    const rows: unknown[] = [];
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? new Response('{}', { status: 529 })
        : new Response(JSON.stringify(response('claude-2026-09-22-build-17')), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl, (row) => { rows.push(row); }).askDetailed({}, QUESTIONS);

    expect(result.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      caller: 'routing',
      spaceId: 'space-fixture',
      subjectId: 'subject-fixture',
      jevModel: 'claude-2026-09-22-build-17',
      inputTokens: 23,
      outcome: 'ok',
    });
  });

  it('normalizes aliases and unavailable identities to null without rejecting dated IDs', async () => {
    const rows: unknown[] = [];
    const aliases = ['jev-latest', ''];
    for (const model of aliases) {
      const result = await client(
        (async () => new Response(JSON.stringify(response(model)), { status: 200 })) as unknown as typeof fetch,
        (row) => { rows.push(row); },
      ).askDetailed({}, QUESTIONS);
      expect(result.ok).toBe(true);
    }
    expect(rows[0]).toMatchObject({ jevModel: null });
    expect(rows[1]).toMatchObject({ jevModel: null });
  });

  it('emits one no_key row without making a network request', async () => {
    const rows: unknown[] = [];
    let calls = 0;
    const result = await new JevClient({
      apiKey: '',
      usage: { caller: 'advise' },
      usageSink: (row) => { rows.push(row); },
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify(response('jev-2026-build')), { status: 200 });
      }) as unknown as typeof fetch,
    }).askDetailed({}, QUESTIONS);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_key');
    expect(calls).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'no_key', jevModel: null, inputTokens: 0 });
  });

  it('swallows usage sink failures after preserving the call result', async () => {
    const result = await client(
      (async () => new Response(JSON.stringify(response('jev-2026-build')), { status: 200 })) as unknown as typeof fetch,
      async () => { throw new Error('ledger unavailable'); },
    ).askDetailed({}, QUESTIONS);

    expect(result.ok).toBe(true);
  });

  it('does not let a never-settling usage sink hold the logical call deadline', async () => {
    const result = await client(
      (async () => new Response(JSON.stringify(response('jev-2026-build')), { status: 200 })) as unknown as typeof fetch,
      () => new Promise<void>(() => undefined),
    ).askDetailed({}, QUESTIONS);

    expect(result.ok).toBe(true);
  });
});
