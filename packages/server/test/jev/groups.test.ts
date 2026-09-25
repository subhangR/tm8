/**
 * The §4.2 suggestion rules and `runGroup`'s never-throw contract, against a
 * fake `JevAdvisorPort` (design 01a0cb80 §4.2, §8).
 *
 * The rules are the budget fill (design 01a0d348 §10 Q5): a per-group floor
 * and a byte budget filled in rank order, frame included for an index group.
 * Rule-carrying tests here were each broken once on purpose and went red; see
 * the PR's negative controls.
 */
import { describe, expect, it } from 'vitest';

import type { CandidateSet } from '../../src/jev/candidates.js';
import { costOf, fillByBudget, filledBytes, levelOf, runGroup, type FillRule } from '../../src/jev/groups.js';
import type { JevAdvisorPort, JevCallRecord } from '../../src/jev/port.js';

const SUBJECT = { title: 'Fix the login redirect', description: 'Users land on /404 after SSO.' };

const call = (over: Partial<JevCallRecord> = {}): JevCallRecord => ({
  jevModel: 'jev-1.13.0', inputTokens: 1000, outputTokens: 10, costUsd: 0.000042, latencyMs: 300, outcome: 'ok', ...over,
});

function set(
  kind: 'memory' | 'skill' | 'team_member' | 'doc',
  ids: string[],
  opts: { bytes?: Record<string, number>; defaults?: string[] } = {},
): CandidateSet {
  return {
    items: ids.map((id) => ({
      entityId: id, kind, title: `t-${id}`, text: `text ${id}`, sources: ['space'],
      default: opts.defaults?.includes(id) ?? false,
      promptBytes: opts.bytes?.[id] ?? 100,
      header: { whenToUse: null, summary: `text ${id}`, keywords: [], source: 'derived', version: 0 },
    })),
    considered: ids.length,
    total: ids.length,
  };
}

/** A floor with no budget: the rule the budget-less groups run. */
const FLOOR = (floor: number): FillRule => ({ budget: null, floor });

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

describe('the budget fill (design 01a0d348 §10 Q5.2)', () => {
  const MEMORIES: FillRule = { budget: 1000, floor: 1.5, criticalAlwaysFits: true };

  it('never ticks a row under the floor, whatever room is left', async () => {
    const { result } = await runGroup(rankingPort({ a: 1.49, b: 1.5, c: 2.7, d: 0.2 }), 'memories', set('memory', ['a', 'b', 'c', 'd']), SUBJECT, MEMORIES);
    if (result.status !== 'ok') throw new Error(result.status);
    const ticked = Object.fromEntries(result.value.items.map((i) => [i.entityId, [i.suggested, i.reason ?? null]]));
    expect(ticked).toEqual({ a: [false, 'below-floor'], b: [true, null], c: [true, null], d: [false, 'below-floor'] });
    expect(result.value).toMatchObject({ budget: 1000, floor: 1.5 });
  });

  it('fills in rank order; a row that does not fit is skipped and a smaller lower-ranked one still fills', async () => {
    // 600 + 300 = 900 fit; 200 would make 1100; 100 makes 1000, exactly the budget.
    const bytes = { a: 600, b: 300, c: 200, d: 100 };
    const { result } = await runGroup(rankingPort({ a: 2.4, b: 2.2, c: 2.0, d: 1.6 }), 'memories', set('memory', ['a', 'b', 'c', 'd'], { bytes }), SUBJECT, MEMORIES);
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.value.items.map((i) => [i.entityId, i.suggested, i.reason ?? null])).toEqual([
      ['a', true, null], ['b', true, null], ['c', false, 'over-budget'], ['d', true, null],
    ]);
    expect(filledBytes(result.value.items, MEMORIES)).toBe(1000);
  });

  it('ticks a critical memory whatever the budget (spawn never collapses one), and it uses the room up', () => {
    const items = fillByBudget([
      { ...set('memory', ['c'], { bytes: { c: 1500 } }).items[0]!, score: 3, level: 'critical', suggested: false },
      { ...set('memory', ['u'], { bytes: { u: 10 } }).items[0]!, score: 2, level: 'useful', suggested: false },
    ] as never, MEMORIES);
    expect(items.map((i) => [i.entityId, i.suggested, i.reason ?? null])).toEqual([['c', true, null], ['u', false, 'over-budget']]);
    // Without the memories exemption a critical row is budgeted like any other.
    const skills = fillByBudget(items.map((i) => ({ ...i, suggested: false })), { budget: 1000, floor: 1.5 });
    expect(skills.map((i) => [i.entityId, i.suggested])).toEqual([['c', false], ['u', true]]);
  });

  it('charges an index group its frame, so a ticked set that fits is one the launch trim keeps whole', async () => {
    const frame = (count: number) => 50 + String(count).length;
    const rule: FillRule = { budget: 251, floor: 1.5, frameBytes: frame };
    // Two entries of 100: 200 + frame(2) = 251 fits; a third never does.
    const { result } = await runGroup(rankingPort({ a: 2, b: 2, c: 2 }), 'references', set('doc', ['a', 'b', 'c']), SUBJECT, rule);
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.value.items.map((i) => i.suggested)).toEqual([true, true, false]);
    expect(filledBytes(result.value.items, rule)).toBe(251);
  });

  it('a group with no budget of its own ticks by the floor alone, at any size', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `s${i}`);
    const { result } = await runGroup(rankingPort(Object.fromEntries(ids.map((id) => [id, 2]))), 'skills', set('skill', ids, { bytes: Object.fromEntries(ids.map((id) => [id, 5000])) }), SUBJECT, FLOOR(1.5));
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.value.items.every((i) => i.suggested)).toBe(true);
    expect(result.value.budget).toBeNull();
  });

  it('breaks a score tie toward a default, so an over-budget default is the one a person must choose to drop last', async () => {
    const { result } = await runGroup(rankingPort({ pick: 2, dflt: 2 }), 'skills', set('skill', ['pick', 'dflt'], { defaults: ['dflt'] }), SUBJECT, { budget: 150, floor: 1.5 });
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.value.items.map((i) => [i.entityId, i.default, i.suggested, i.reason ?? null])).toEqual([
      ['dflt', true, true, null], ['pick', false, false, 'over-budget'],
    ]);
  });

  it('lists EVERY candidate — one Jev left unscored stays at 0, irrelevant, unticked; an invented id is dropped', async () => {
    const port: JevAdvisorPort = {
      rank: async () => ({ ok: true, ranked: [{ id: 'a', score: 2 }, { id: 'ghost', score: 3 }], calls: [call()] }),
      model: async () => { throw new Error('not asked'); },
    };
    const { result } = await runGroup(port, 'memories', set('memory', ['a', 'b']), SUBJECT, MEMORIES);
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.value.items.map((i) => [i.entityId, i.score, i.level, i.suggested])).toEqual([
      ['a', 2, 'useful', true],
      ['b', 0, 'irrelevant', false],
    ]);
    expect(result.value).toMatchObject({ considered: 2, total: 2 });
  });

  it('asks about a reference as a reference', async () => {
    const nouns: string[] = [];
    const port: JevAdvisorPort = {
      rank: async ({ candidates, noun }) => { nouns.push(noun); return { ok: true, ranked: candidates.map((c) => ({ id: c.id, score: 2 })), calls: [call()] }; },
      model: async () => { throw new Error('not asked'); },
    };
    await runGroup(port, 'references', set('doc', ['d']), SUBJECT, FLOOR(1.5));
    expect(nouns).toEqual(['reference']);
  });
});

describe('teammates', () => {
  it('ranks by score; rows at or above the floor fit', async () => {
    const { result } = await runGroup(rankingPort({ t1: 0.9, t2: 2.2, t3: 1.0 }), 'teammates', set('team_member', ['t1', 't2', 't3']), SUBJECT, FLOOR(1.0));
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.value.items.map((i) => [i.entityId, i.suggested])).toEqual([['t2', true], ['t3', true], ['t1', false]]);
    expect(result.value).toMatchObject({ noFit: false, floor: 1.0 });
  });

  it('says noFit when the best score is below the floor', async () => {
    const { result } = await runGroup(rankingPort({ t1: 0.9, t2: 0.4 }), 'teammates', set('team_member', ['t1', 't2']), SUBJECT, FLOOR(1.0));
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.value.noFit).toBe(true);
    expect(result.value.items.every((i) => !i.suggested && i.reason === 'below-floor')).toBe(true);
  });

  it('a profile floor moves who fits', async () => {
    const { result } = await runGroup(rankingPort({ t1: 1.2 }), 'teammates', set('team_member', ['t1']), SUBJECT, FLOOR(1.5));
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.value.noFit).toBe(true);
  });
});

describe('runGroup never throws', () => {
  it('no client is failed: no_key, costing nothing', async () => {
    const { result, calls } = await runGroup(null, 'skills', set('skill', ['s']), SUBJECT, FLOOR(1.5));
    expect(result).toEqual({ status: 'failed', reason: 'no_key', cost: costOf([]) });
    expect(calls).toEqual([]);
  });

  it('no candidates is skipped: no_candidates, and Jev is not asked', async () => {
    const port: JevAdvisorPort = { rank: async () => { throw new Error('asked'); }, model: async () => { throw new Error('asked'); } };
    const { result } = await runGroup(port, 'memories', set('memory', []), SUBJECT, FLOOR(1.5));
    expect(result).toMatchObject({ status: 'skipped', reason: 'no_candidates', cost: { calls: 0 } });
  });

  it('a reported failure keeps its reason and is still costed, calls included', async () => {
    const failedCall = call({ outcome: 'timeout', outputTokens: 0, latencyMs: 2000 });
    const port: JevAdvisorPort = {
      rank: async () => ({ ok: false, reason: 'timeout', calls: [failedCall] }),
      model: async () => ({ ok: false, reason: 'rate_limited', call: call({ outcome: 'rate_limited' }) }),
    };
    const ranked = await runGroup(port, 'skills', set('skill', ['s']), SUBJECT, FLOOR(1.5));
    expect(ranked.result).toMatchObject({ status: 'failed', reason: 'timeout', cost: { calls: 1, latencyMs: 2000 } });
    expect(ranked.calls).toEqual([failedCall]);
    const model = await runGroup(port, 'model', null, SUBJECT);
    expect(model.result).toMatchObject({ status: 'failed', reason: 'rate_limited', cost: { calls: 1 } });
  });

  it('a port that throws becomes a failed group, not an exception', async () => {
    const port: JevAdvisorPort = { rank: async () => { throw new Error('boom'); }, model: async () => { throw new Error('boom'); } };
    await expect(runGroup(port, 'skills', set('skill', ['s']), SUBJECT, FLOOR(1.5))).resolves.toMatchObject({ result: { status: 'failed' } });
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
