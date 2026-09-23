import { describe, expect, it, vi } from 'vitest';
import { createJevClient } from '../src/client.js';
import { levelOf, rankByRelevance } from '../src/rank.js';

type Question = { instructions: string };

/**
 * A fake Jev that answers every relevance question it is sent, scoring each
 * candidate by its text. It records how many calls are in flight at once, and
 * refuses any chunk carrying a candidate named in `refuse`.
 */
function fakeJev(scores: Record<string, number>, opts: { delayMs?: number; refuse?: string } = {}) {
  let inFlight = 0;
  const stats = { maxInFlight: 0, calls: 0 };
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    stats.calls += 1;
    inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 25));
      const { questions } = JSON.parse(init!.body as string) as { questions: Record<string, Question> };
      const texts = Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [id, q.instructions.split(': ').pop()!]),
      );
      if (opts.refuse && Object.values(texts).includes(opts.refuse)) return new Response('{}', { status: 400 });
      const answers = Object.fromEntries(
        Object.entries(texts).map(([id, text]) => [id, { score: scores[text] ?? 0, confidence: 0.8 }]),
      );
      return new Response(
        JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 0 } }),
        { status: 200 },
      );
    } finally {
      inFlight -= 1;
    }
  });
  const client = createJevClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
  return { client, stats, fetchImpl };
}

const many = (n: number) => Array.from({ length: n }, (_v, i) => ({ id: `id${i}`, text: `m${i}` }));

describe('chunks', () => {
  it('go out concurrently, not one after another', async () => {
    const { client, stats } = fakeJev({}, { delayMs: 30 });
    const out = await rankByRelevance(client, { task: {}, candidates: many(5), noun: 'memory', chunkSize: 2 });
    expect(out.ok).toBe(true);
    expect(stats.calls).toBe(3);
    // All three chunks were in flight together.
    expect(stats.maxInFlight).toBe(3);
  });

  it('return one call record per chunk', async () => {
    const { client } = fakeJev({});
    const out = await rankByRelevance(client, { task: {}, candidates: many(5), noun: 'memory', chunkSize: 2 });
    expect(out.calls).toHaveLength(3);
    expect(out.calls.every((c) => c.outcome === 'ok' && c.inputTokens === 100)).toBe(true);
  });

  it('default to 60 candidates each', async () => {
    const { client, stats } = fakeJev({});
    await rankByRelevance(client, { task: {}, candidates: many(121), noun: 'skill' });
    expect(stats.calls).toBe(3);
  });

  it('rank the whole list in ONE call when it fits', async () => {
    const { client, stats } = fakeJev({});
    await rankByRelevance(client, { task: {}, candidates: many(3), noun: 'memory' });
    expect(stats.calls).toBe(1);
  });
});

describe('ranking', () => {
  it('orders by score across chunks and labels each level', async () => {
    const { client } = fakeJev({ m0: 1.0, m1: 0.1, m2: 2.9, m3: 1.6 });
    const out = await rankByRelevance(client, { task: { title: 'deploy' }, candidates: many(4), noun: 'memory', chunkSize: 2 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ranked.map((r) => r.id)).toEqual(['id2', 'id3', 'id0', 'id1']);
    expect(out.ranked.map((r) => r.level)).toEqual(['critical', 'useful', 'background', 'irrelevant']);
    expect(out.ranked[0]).toMatchObject({ id: 'id2', text: 'm2', score: 2.9, confidence: 0.8 });
  });

  it('asks about the task using the given noun', async () => {
    const { client, fetchImpl } = fakeJev({});
    await rankByRelevance(client, { task: { title: 'x' }, candidates: many(1), noun: 'teammate' });
    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(sent.state).toEqual({ task: { title: 'x' } });
    expect(sent.questions.c0.instructions).toContain('teammate: m0');
    expect(sent.questions.c0.criteria).toHaveLength(4);
  });

  it('makes no call for an empty list', async () => {
    const { client, stats } = fakeJev({});
    expect(await rankByRelevance(client, { task: {}, candidates: [], noun: 'memory' })).toEqual({ ok: true, ranked: [], calls: [] });
    expect(stats.calls).toBe(0);
  });
});

describe('a failing chunk', () => {
  it('fails the ranking and still returns every call record', async () => {
    const { client, stats } = fakeJev({}, { refuse: 'm2' });
    const out = await rankByRelevance(client, { task: {}, candidates: many(5), noun: 'memory', chunkSize: 2 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('http_error');
    expect(stats.calls).toBe(3);
    expect(out.calls.map((c) => c.outcome)).toEqual(['ok', 'http_error', 'ok']);
  });
});

describe('levelOf', () => {
  it.each([
    [0, 'irrelevant'],
    [0.49, 'irrelevant'],
    [0.5, 'background'],
    [1, 'background'],
    [1.49, 'background'],
    [1.5, 'useful'],
    [2.49, 'useful'],
    [2.5, 'critical'],
    [3, 'critical'],
  ] as const)('rounds %d to %s', (score, level) => {
    expect(levelOf(score)).toBe(level);
  });

  it('clamps anything off the scale', () => {
    expect(levelOf(-1)).toBe('irrelevant');
    expect(levelOf(9)).toBe('critical');
    expect(levelOf(Number.NaN)).toBe('irrelevant');
  });
});
