// Context engineering — the half of Jev that decides what a persona KNOWS.
//
// The claims, in the order they matter:
//   1. It only ever REMOVES, and it never reorders. The caller's order is a
//      documented property of `resolveSkills`; a ranker may not spend it.
//   2. It never empties a persona. `floor` survives any score.
//   3. A candidate it could not score is ranked last but never cut for it —
//      an unparsed answer is our failure, not evidence against the row.
//   4. Failure is fail-OPEN: no plan, and the caller keeps everything.

import { describe, expect, it, vi } from 'vitest';
import { JevClient } from '../src/client.js';
import {
  DEFAULT_CONTEXT_BUDGET,
  JevContextAdvisor,
  nullContextAdvisor,
  selectByRelevance,
  splitBudget,
  splitBudgetAcross,
  type ContextCandidate,
} from '../src/context.js';
import type { RankedCandidate } from '../src/rerank.js';

const TASK = { title: 'Fix the deploy script', description: 'It targets the wrong instance.' };

function cand(id: string, text: string): ContextCandidate {
  return { id, text };
}
function ranked(rows: [string, number][]): RankedCandidate[] {
  return rows.map(([id, score], i) => ({ id, text: '', score, confidence: 0.8, rank: i + 1 }));
}

describe('selectByRelevance', () => {
  const budget = { ...DEFAULT_CONTEXT_BUDGET, floor: 0 };

  it('keeps the caller’s order among the survivors, never the rank order', () => {
    const list = [cand('a', 'aaa'), cand('b', 'bbb'), cand('c', 'ccc')];
    // Jev's order is c, a, b — the output must still read a, c.
    const plan = selectByRelevance(list, ranked([['c', 3], ['a', 2], ['b', 0.1]]), budget);
    expect(plan.keptIds).toEqual(['a', 'c']);
  });

  it('drops a clearly irrelevant candidate even when it would have fitted', () => {
    const list = [cand('a', 'aaa'), cand('b', 'bbb')];
    const plan = selectByRelevance(list, ranked([['a', 2.8], ['b', 0.2]]), budget);
    expect(plan.keptIds).toEqual(['a']);
    expect(plan.decisions.find((d) => d.id === 'b')?.reason).toBe('relevance');
  });

  it('never empties a persona, whatever the scores say', () => {
    const list = [cand('a', 'aaa'), cand('b', 'bbb'), cand('c', 'ccc'), cand('d', 'ddd')];
    const plan = selectByRelevance(list, ranked([['a', 0], ['b', 0], ['c', 0], ['d', 0]]), {
      ...DEFAULT_CONTEXT_BUDGET,
      floor: 3,
    });
    // A teammate that wakes up knowing nothing is a stranger failure than a
    // slightly fuller prompt, so the floor outranks every score.
    expect(plan.keptIds).toHaveLength(3);
  });

  it('cuts by bytes once relevance has ordered the queue, and says which rule cut what', () => {
    const list = [cand('big', 'x'.repeat(900)), cand('small', 'y'.repeat(50))];
    const plan = selectByRelevance(list, ranked([['small', 3], ['big', 2.9]]), {
      ...DEFAULT_CONTEXT_BUDGET,
      bytes: 100,
      floor: 0,
    });
    expect(plan.keptIds).toEqual(['small']);
    expect(plan.decisions.find((d) => d.id === 'big')?.reason).toBe('budget');
    // Rated critical and cut anyway: the caller has to be able to see that.
    expect(plan.droppedCritical).toEqual(['big']);
    expect(plan.bytesBefore).toBe(950);
    expect(plan.bytesAfter).toBe(50);
  });

  it('keeps a candidate whose answer never parsed', () => {
    const list = [cand('a', 'aaa'), cand('unscored', 'bbb')];
    const plan = selectByRelevance(list, ranked([['a', 3]]), budget);
    expect(plan.keptIds).toEqual(['a', 'unscored']);
  });
});

describe('splitBudget', () => {
  it('gives each side exactly what it needs when both fit', () => {
    const split = splitBudget([cand('m', 'x'.repeat(100))], [cand('s', 'y'.repeat(200))], 10_000);
    expect(split).toEqual({ memories: 100, skills: 200 });
  });

  it('guarantees a starved side its third when the other is enormous', () => {
    const split = splitBudget(
      [cand('m', 'x'.repeat(100_000))],
      [cand('s', 'y'.repeat(300))],
      3_000,
    );
    expect(split.skills).toBeGreaterThanOrEqual(1_000);
    expect(split.memories + split.skills).toBeLessThanOrEqual(3_000);
  });
});

describe('JevContextAdvisor', () => {
  function clientReturning(memoryScores: number[], skillScores: number[]): JevClient {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      const scores = call++ === 0 ? memoryScores : skillScores;
      const answers: Record<string, unknown> = {};
      scores.forEach((s, i) => {
        answers[`c${i}`] = { score: s, confidence: 0.9 };
      });
      return new Response(
        JSON.stringify({ model: 'jev-1', answers, usage: { input_tokens: 400, output_tokens: 0 } }),
        { status: 200 },
      );
    });
    return new JevClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
  }

  const intent = {
    memories: [cand('m0', 'the deploy box is prod'), cand('m1', 'a css comment eats the next rule')],
    skills: [cand('s0', 'deploy runbook'), cand('s1', 'figma connector')],
  };

  it('plans both groups and reports what it saved', async () => {
    const advisor = new JevContextAdvisor({
      client: clientReturning([3.0, 0.1], [2.9, 0.2]),
      budget: { floor: 0 },
    });
    const plan = (await advisor.plan(TASK, intent))!;
    expect(plan.keepMemoryIds).toEqual(['m0']);
    expect(plan.keepSkillIds).toEqual(['s0']);
    expect(plan.activation.bytesSaved).toBeGreaterThan(0);
    expect(plan.activation.pctSaved).toBeGreaterThan(0);
    // Jev's own cost is on the record beside the saving, always.
    expect(plan.activation.jevCostUsd).toBeGreaterThan(0);
    expect(plan.activation.summary).toContain('1/2 memories');
  });

  it('asks both groups in parallel, not one after the other', async () => {
    const started: number[] = [];
    const fetchImpl = vi.fn(async () => {
      started.push(Date.now());
      await new Promise((r) => setTimeout(r, 30));
      return new Response(
        JSON.stringify({ model: 'jev-1', answers: { c0: { score: 3, confidence: 0.9 }, c1: { score: 3, confidence: 0.9 } }, usage: { input_tokens: 10 } }),
        { status: 200 },
      );
    });
    const advisor = new JevContextAdvisor({
      client: new JevClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }),
    });
    await advisor.plan(TASK, intent);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Overlapping starts. Sequencing them would add a whole round trip to
    // every spawn to buy nothing.
    expect(Math.abs((started[1] ?? 0) - (started[0] ?? 0))).toBeLessThan(25);
  });

  it('has no opinion when there is no task to judge against', async () => {
    const advisor = new JevContextAdvisor({ client: clientReturning([3], [3]) });
    expect(await advisor.plan(null, intent)).toBeNull();
    expect(await advisor.plan({ title: '', description: '' }, intent)).toBeNull();
  });

  it('has no opinion when there is nothing to select from', async () => {
    const advisor = new JevContextAdvisor({ client: clientReturning([], []) });
    expect(await advisor.plan(TASK, { memories: [], skills: [] })).toBeNull();
  });

  it('fails open when Jev is down — no plan, so the caller keeps everything', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const advisor = new JevContextAdvisor({
      client: new JevClient({ apiKey: 'k', retries: 0, fetchImpl: fetchImpl as unknown as typeof fetch }),
    });
    expect(await advisor.plan(TASK, intent)).toBeNull();
  });

  it('the null advisor is wired everywhere and opinionated nowhere', async () => {
    expect(await nullContextAdvisor.plan(TASK, intent)).toBeNull();
  });
});

// -- the graph group ----------------------------------------------------------
//
// The third thing competing for a spawn's injection budget is material read out
// of the graph — today the bodies of the other tasks in a multi-task assignment.
// It is the same ranked selection as memories and skills, so these tests are
// about the two things that are NOT the same: that a third group costs no extra
// round trip, and that it cannot starve the other two.

describe('the graph group', () => {
  function clientForGroups(groups: number[][]): JevClient {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      const scores = groups[call++] ?? [];
      const answers: Record<string, unknown> = {};
      scores.forEach((s, i) => {
        answers[`c${i}`] = { score: s, confidence: 0.9 };
      });
      return new Response(
        JSON.stringify({ model: 'jev-1', answers, usage: { input_tokens: 100, output_tokens: 0 } }),
        { status: 200 },
      );
    });
    return new JevClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
  }

  const withGraph = {
    memories: [cand('m0', 'the deploy box is prod')],
    skills: [cand('s0', 'deploy runbook')],
    graph: [cand('t1', 'Rewrite the invite emails'), cand('t2', 'Fix the deploy target')],
    graphSubject: 'other task assigned to the same agent',
  };

  it('ranks graph candidates as their own group and reports them separately', async () => {
    const advisor = new JevContextAdvisor({
      client: clientForGroups([[3.0], [3.0], [0.1, 3.0]]),
      budget: { floor: 0 },
    });
    const plan = (await advisor.plan(TASK, withGraph))!;
    expect(plan.keepGraphIds).toEqual(['t2']);
    // The unrelated task is gone; the persona's own context is untouched.
    expect(plan.keepMemoryIds).toEqual(['m0']);
    expect(plan.keepSkillIds).toEqual(['s0']);
    expect(plan.activation.graph?.keptIds).toEqual(['t2']);
    expect(plan.activation.summary).toContain('1/2 graph entities');
  });

  it('asks the graph group in the same round trip as the other two', async () => {
    const started: number[] = [];
    const fetchImpl = vi.fn(async () => {
      started.push(Date.now());
      await new Promise((r) => setTimeout(r, 30));
      return new Response(
        JSON.stringify({
          model: 'jev-1',
          answers: { c0: { score: 3, confidence: 0.9 }, c1: { score: 3, confidence: 0.9 } },
          usage: { input_tokens: 10 },
        }),
        { status: 200 },
      );
    });
    const advisor = new JevContextAdvisor({
      client: new JevClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }),
    });
    await advisor.plan(TASK, withGraph);
    expect(started).toHaveLength(3);
    // All three start before any finishes: a third group buys no extra latency.
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(25);
  });

  it('records nothing rather than an empty plan when no graph material was offered', async () => {
    const advisor = new JevContextAdvisor({ client: clientForGroups([[3.0], [3.0]]) });
    const plan = (await advisor.plan(TASK, {
      memories: withGraph.memories,
      skills: withGraph.skills,
    }))!;
    // A reader must be able to tell "nothing was offered" from "all of it was
    // cut", so the field is absent rather than a zero-row group plan.
    expect(plan.activation.graph).toBeUndefined();
    expect(plan.keepGraphIds).toBeNull();
    expect(plan.activation.summary).not.toContain('graph');
  });
});

describe('splitBudgetAcross', () => {
  it('reproduces the two-group split exactly', () => {
    const m = [cand('m', 'x'.repeat(900))];
    const s = [cand('s', 'y'.repeat(100))];
    const pair = splitBudget(m, s, 300);
    expect(splitBudgetAcross([m, s], 300)).toEqual([pair.memories, pair.skills]);
    expect(pair.memories + pair.skills).toBe(300);
  });

  it('gives a group that asks for nothing nothing, and does not spend its guarantee', () => {
    const m = [cand('m', 'x'.repeat(900))];
    const g = [cand('t1', 'y'.repeat(900))];
    const out = splitBudgetAcross([m, [], g], 300);
    expect(out[1]).toBe(0);
    // Two live groups, so the guarantee is a third each — the empty array in
    // the middle does not quietly take a share and starve the two that are real.
    expect(out[0]).toBeGreaterThanOrEqual(100);
    expect(out[2]).toBeGreaterThanOrEqual(100);
    expect(out.reduce((a, b) => a + b, 0)).toBe(300);
  });

  it('guarantees each of three live groups a quarter, then shares the rest by demand', () => {
    const big = [cand('a', 'x'.repeat(10_000))];
    const small1 = [cand('b', 'y'.repeat(50))];
    const small2 = [cand('c', 'z'.repeat(50))];
    const out = splitBudgetAcross([big, small1, small2], 400);
    expect(out[1]).toBeGreaterThanOrEqual(100);
    expect(out[2]).toBeGreaterThanOrEqual(100);
    expect(out[0]).toBeGreaterThan(out[1]!);
    expect(out.reduce((a, b) => a + b, 0)).toBe(400);
  });
});

describe('the floor may not overspend the budget', () => {
  // Found by measuring, not by reading: three real SKILL.md files (45,677
  // bytes) with `floor: 3` kept all three, because a floor that bypassed the
  // byte check could not be overspent — and the budget it overspent is the one
  // that THROWS downstream rather than truncating.
  const big = [
    cand('a', 'x'.repeat(15_000)),
    cand('b', 'y'.repeat(15_000)),
    cand('c', 'z'.repeat(15_000)),
  ];

  it('keeps the best row whatever it costs, and stops there', () => {
    const plan = selectByRelevance(big, ranked([['b', 3], ['a', 2.9], ['c', 2.8]]), {
      ...DEFAULT_CONTEXT_BUDGET,
      bytes: 10_000,
      floor: 3,
    });
    // One row survives — the persona is never empty — and it survives even
    // though it alone is larger than the whole budget.
    expect(plan.keptIds).toEqual(['b']);
    expect(plan.bytesAfter).toBe(15_000);
    expect(plan.decisions.find((d) => d.id === 'a')?.reason).toBe('budget');
    // Cut by bytes despite being inside the floor AND rated critical: exactly
    // the case the caller has to be told about.
    expect(plan.droppedCritical).toEqual(['a', 'c']);
  });

  it('still keeps the whole floor when the floor actually fits', () => {
    const small = [cand('a', 'aaa'), cand('b', 'bbb'), cand('c', 'ccc'), cand('d', 'ddd')];
    const plan = selectByRelevance(small, ranked([['a', 0], ['b', 0], ['c', 0], ['d', 0]]), {
      ...DEFAULT_CONTEXT_BUDGET,
      floor: 3,
    });
    expect(plan.keptIds).toHaveLength(3);
  });
});
