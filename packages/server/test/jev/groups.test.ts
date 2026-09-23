/**
 * The §4.2 suggestion rules and `runGroup`'s never-throw contract, against a
 * fake `JevAdvisorPort` (design 01a0cb80 §4.2, §8).
 *
 * Rule-carrying tests here were each broken once on purpose (the threshold
 * moved, the cap removed) and went red; see the PR's negative controls.
 */
import { describe, expect, it } from 'vitest';

import type { CandidateSet } from '../../src/jev/candidates.js';
import { costOf, levelOf, runGroup } from '../../src/jev/groups.js';
import type { JevAdvisorPort, JevCallRecord } from '../../src/jev/port.js';

const SUBJECT = { title: 'Fix the login redirect', description: 'Users land on /404 after SSO.' };

const call = (over: Partial<JevCallRecord> = {}): JevCallRecord => ({
  jevModel: 'jev-1.13.0', inputTokens: 1000, outputTokens: 10, costUsd: 0.000042, latencyMs: 300, outcome: 'ok', ...over,
});

function set(kind: 'memory' | 'skill' | 'team_member', ids: string[]): CandidateSet {
  return {
    items: ids.map((id) => ({ entityId: id, kind, title: `t-${id}`, text: `text ${id}`, sources: ['space'] })),
    considered: ids.length,
    total: ids.length,
  };
}

function rankingPort(scores: Record<string, number>, calls: JevCallRecord[] = [call()]): JevAdvisorPort {
  return {
    rank: async ({ candidates }) => ({
      ok: true,
      ranked: candidates.filter((c) => c.id in scores).map((c) => ({ id: c.id, score: scores[c.id]! })),
      calls,
    }),
    model: async () => { throw new Error('not asked'); },
  };
}

describe('levelOf — the score rounded to the nearest level', () => {
  it('maps 0..3 onto irrelevant, background, useful, critical', () => {
    expect([0, 0.4, 0.6, 1.49, 1.5, 2.4, 2.5, 3].map(levelOf)).toEqual([
      'irrelevant', 'irrelevant', 'background', 'background', 'useful', 'useful', 'critical', 'critical',
    ]);
  });
});

describe('memories', () => {
  it('pre-ticks at useful (score ≥ 1.5) and not below', async () => {
    const { result } = await runGroup(rankingPort({ a: 1.49, b: 1.5, c: 2.7, d: 0.2 }), 'memories', set('memory', ['a', 'b', 'c', 'd']), SUBJECT);
    if (result.status !== 'ok') throw new Error(result.status);
    const ticked = Object.fromEntries(result.value.items.map((i) => [i.entityId, i.suggested]));
    expect(ticked).toEqual({ a: false, b: true, c: true, d: false });
  });

  it('ticks at most 32, leaving the LOWEST-scored beyond the cap unticked', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `m${i}`);
    // m0..m9 critical (3), m10..m39 useful (1.5 + i/100): 40 wanted, 32 allowed.
    const scores = Object.fromEntries(ids.map((id, i) => [id, i < 10 ? 3 : 1.5 + i / 100]));
    const { result } = await runGroup(rankingPort(scores), 'memories', set('memory', ids), SUBJECT);
    if (result.status !== 'ok') throw new Error(result.status);
    const ticked = result.value.items.filter((i) => i.suggested).map((i) => i.entityId);
    expect(ticked).toHaveLength(32);
    // Every critical row survives the cap; the 8 dropped are the 8 lowest useful ones.
    for (let i = 0; i < 10; i += 1) expect(ticked).toContain(`m${i}`);
    for (let i = 10; i < 18; i += 1) expect(ticked).not.toContain(`m${i}`);
  });

  it('lists EVERY candidate — one Jev left unscored stays at 0, irrelevant, unticked; an invented id is dropped', async () => {
    const port: JevAdvisorPort = {
      rank: async () => ({ ok: true, ranked: [{ id: 'a', score: 2 }, { id: 'ghost', score: 3 }], calls: [call()] }),
      model: async () => { throw new Error('not asked'); },
    };
    const { result } = await runGroup(port, 'memories', set('memory', ['a', 'b']), SUBJECT);
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.value.items.map((i) => [i.entityId, i.score, i.level, i.suggested])).toEqual([
      ['a', 2, 'useful', true],
      ['b', 0, 'irrelevant', false],
    ]);
    expect(result.value).toMatchObject({ considered: 2, total: 2 });
  });
});

describe('skills', () => {
  it('pre-ticks at useful (score ≥ 1.5)', async () => {
    const { result } = await runGroup(rankingPort({ s1: 1.4, s2: 1.5 }), 'skills', set('skill', ['s1', 's2']), SUBJECT);
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.value.items.map((i) => [i.entityId, i.suggested])).toEqual([['s2', true], ['s1', false]]);
  });
});

describe('teammates', () => {
  it('ranks by score; rows at or above 1.0 fit', async () => {
    const { result } = await runGroup(rankingPort({ t1: 0.9, t2: 2.2, t3: 1.0 }), 'teammates', set('team_member', ['t1', 't2', 't3']), SUBJECT);
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.value.items.map((i) => [i.entityId, i.suggested])).toEqual([['t2', true], ['t3', true], ['t1', false]]);
    expect(result.value.noFit).toBe(false);
  });

  it('says noFit when the best score is below 1.0', async () => {
    const { result } = await runGroup(rankingPort({ t1: 0.9, t2: 0.4 }), 'teammates', set('team_member', ['t1', 't2']), SUBJECT);
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.value.noFit).toBe(true);
    expect(result.value.items.every((i) => !i.suggested)).toBe(true);
  });
});

describe('runGroup never throws', () => {
  it('no client is failed: no_key, costing nothing', async () => {
    const { result, calls } = await runGroup(null, 'skills', set('skill', ['s']), SUBJECT);
    expect(result).toEqual({ status: 'failed', reason: 'no_key', cost: costOf([]) });
    expect(calls).toEqual([]);
  });

  it('no candidates is skipped: no_candidates, and Jev is not asked', async () => {
    const port: JevAdvisorPort = { rank: async () => { throw new Error('asked'); }, model: async () => { throw new Error('asked'); } };
    const { result } = await runGroup(port, 'memories', set('memory', []), SUBJECT);
    expect(result).toMatchObject({ status: 'skipped', reason: 'no_candidates', cost: { calls: 0 } });
  });

  it('a reported failure keeps its reason and is still costed, calls included', async () => {
    const failedCall = call({ outcome: 'timeout', outputTokens: 0, latencyMs: 2000 });
    const port: JevAdvisorPort = {
      rank: async () => ({ ok: false, reason: 'timeout', calls: [failedCall] }),
      model: async () => ({ ok: false, reason: 'rate_limited', call: call({ outcome: 'rate_limited' }) }),
    };
    const ranked = await runGroup(port, 'skills', set('skill', ['s']), SUBJECT);
    expect(ranked.result).toMatchObject({ status: 'failed', reason: 'timeout', cost: { calls: 1, latencyMs: 2000 } });
    expect(ranked.calls).toEqual([failedCall]);
    const model = await runGroup(port, 'model', null, SUBJECT);
    expect(model.result).toMatchObject({ status: 'failed', reason: 'rate_limited', cost: { calls: 1 } });
  });

  it('a port that throws becomes a failed group, not an exception', async () => {
    const port: JevAdvisorPort = { rank: async () => { throw new Error('boom'); }, model: async () => { throw new Error('boom'); } };
    await expect(runGroup(port, 'skills', set('skill', ['s']), SUBJECT)).resolves.toMatchObject({ result: { status: 'failed' } });
    await expect(runGroup(port, 'model', null, SUBJECT)).resolves.toMatchObject({ result: { status: 'failed' } });
  });
});

describe('costOf', () => {
  it('sums tokens and dollars; latency is the slowest call, because chunks run in parallel', () => {
    expect(costOf([call({ latencyMs: 300 }), call({ latencyMs: 900, inputTokens: 500, costUsd: 0.000021 })])).toEqual({
      calls: 2, inputTokens: 1500, outputTokens: 20, usd: 0.000042 + 0.000021, latencyMs: 900,
    });
  });
});
