import { describe, expect, it, vi } from 'vitest';
import { JevClient } from '../src/client.js';
import { applyBudget, rankByRelevance } from '../src/rerank.js';

const candidates = [
  { id: 'a', text: 'deploy runbook' },
  { id: 'b', text: 'css trivia' },
  { id: 'c', text: 'worktree trap' },
];

function respond(scores: number[]) {
  return vi.fn(async () => {
    const answers: Record<string, unknown> = {};
    scores.forEach((s, i) => {
      answers[`c${i}`] = { score: s, confidence: 0.9 };
    });
    return new Response(JSON.stringify({ model: 'jev-1', answers, usage: { input_tokens: 500, output_tokens: 0 } }), { status: 200 });
  });
}

describe('ranking', () => {
  it('orders by relevance and numbers the ranks', async () => {
    const fetchImpl = respond([1.0, 0.1, 2.9]);
    const client = new JevClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = (await rankByRelevance(client, { task: { title: 'deploy' }, candidates, subject: 'memory' }))!;
    expect(out.ranked.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(out.ranked[0]!.rank).toBe(1);
    expect(out.inputTokens).toBe(500);
  });

  it('ranks the whole list in ONE call, not one call per candidate', async () => {
    const fetchImpl = respond([1, 2, 3]);
    const client = new JevClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await rankByRelevance(client, { task: {}, candidates, subject: 'memory' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('splits a long list into chunks that fit the request context', async () => {
    const many = Array.from({ length: 5 }, (_v, i) => ({ id: `m${i}`, text: `m${i}` }));
    const fetchImpl = respond([1, 1]);
    const client = new JevClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await rankByRelevance(client, { task: {}, candidates: many, subject: 'memory', chunk: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns null on failure, so the caller keeps the order it already had', async () => {
    const client = new JevClient({ apiKey: 'k', fetchImpl: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch, retries: 0 });
    expect(await rankByRelevance(client, { task: {}, candidates, subject: 'memory' })).toBeNull();
  });

  it('does no work and makes no call for an empty candidate list', async () => {
    const fetchImpl = respond([]);
    const client = new JevClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = (await rankByRelevance(client, { task: {}, candidates: [], subject: 'memory' }))!;
    expect(out.ranked).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the budget', () => {
  const ranked = [
    { id: 'a', text: '', score: 2.9, confidence: 1, rank: 1 },
    { id: 'b', text: '', score: 2.7, confidence: 1, rank: 2 },
    { id: 'c', text: '', score: 0.2, confidence: 1, rank: 3 },
  ];

  it('keeps the top N', () => {
    expect(applyBudget(ranked, 2).keep.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('reports a critical row the budget would have cut, rather than dropping it silently', () => {
    // Losing the row that mattered is the failure ranking was meant to prevent.
    const out = applyBudget(ranked, 1);
    expect(out.droppedCritical.map((c) => c.id)).toEqual(['b']);
  });

  it('does not report merely-irrelevant rows as dropped criticals', () => {
    expect(applyBudget(ranked, 2).droppedCritical).toEqual([]);
  });
});
