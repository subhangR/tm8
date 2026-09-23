// Choosing WHO does the work.
//
// The claims worth testing are all about the cases a single Choice cannot
// express: the best fit is busy, nobody fits at all, and the roster is empty.
// Each of those has a right answer that is NOT "name somebody anyway".

import { describe, expect, it, vi } from 'vitest';
import { JevClient } from '../src/client.js';
import {
  JevRosterAdvisor,
  NO_FIT_BELOW,
  describeTeammate,
  nullRosterAdvisor,
  pickFrom,
  type TeammateCandidate,
  type TeammateFit,
} from '../src/roster.js';

const TASK = { title: 'Rewrite the deploy script', description: 'It targets the wrong instance.' };

const ROSTER: TeammateCandidate[] = [
  { id: 'draco', name: 'Draco', role: 'PTY engineer', skills: ['terminal'] },
  { id: 'astra', name: 'Astra', role: 'Release engineer', skills: ['deploy', 'runbooks'] },
  { id: 'lumen', name: 'Lumen', role: 'Designer', skills: ['palette'] },
];

function fit(id: string, score: number, available = true): TeammateFit {
  return { id, name: id, score, confidence: 0.9, rank: 0, available };
}

function clientScoring(scores: number[]): JevClient {
  const fetchImpl = vi.fn(async () => {
    const answers: Record<string, unknown> = {};
    scores.forEach((s, i) => {
      answers[`c${i}`] = { score: s, confidence: 0.9 };
    });
    return new Response(
      JSON.stringify({ model: 'jev-1', answers, usage: { input_tokens: 900, output_tokens: 0 } }),
      { status: 200 },
    );
  });
  return new JevClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
}

describe('pickFrom', () => {
  it('takes the best fit when they are free', () => {
    const out = pickFrom([fit('a', 2.9), fit('b', 2.0)]);
    expect(out.pick?.id).toBe('a');
    expect(out.noFit).toBe(false);
  });

  it('walks past a busy best fit to the next one who still clears the bar', () => {
    const out = pickFrom([fit('a', 2.9, false), fit('b', 2.0), fit('c', 0.2)]);
    expect(out.pick?.id).toBe('b');
    // The better fit is still named, so "why not them" stays answerable.
    expect(out.best?.id).toBe('a');
  });

  it('refuses rather than dispatching someone Jev rated a bad match', () => {
    // Everyone free is below the bar. Promoting them would be exactly the
    // failure the dispatcher instruction warns about — inventing a fit.
    const out = pickFrom([fit('a', 2.9, false), fit('b', 0.3)]);
    expect(out.pick).toBeNull();
    expect(out.noFit).toBe(false);
  });

  it('says nobody fits when nobody does', () => {
    const out = pickFrom([fit('a', 0.4), fit('b', 0.1)]);
    expect(out.noFit).toBe(true);
    expect(out.pick).toBeNull();
  });

  it('says nobody fits on an empty roster instead of throwing', () => {
    expect(pickFrom([])).toEqual({ pick: null, best: null, noFit: true });
  });
});

describe('describeTeammate', () => {
  it('leads with role and equipment, which is what answers the question', () => {
    const text = describeTeammate(ROSTER[1]!);
    expect(text.startsWith('Astra — Release engineer')).toBe(true);
    expect(text).toContain('deploy, runbooks');
  });

  it('bounds a long persona instead of sending the whole thing', () => {
    const text = describeTeammate({ id: 'x', name: 'X', role: 'r', identity: 'z'.repeat(5_000) });
    expect(text.length).toBeLessThan(800);
  });
});

describe('JevRosterAdvisor', () => {
  it('ranks the whole roster in one call and picks the best fit', async () => {
    const advisor = new JevRosterAdvisor({ client: clientScoring([1.2, 2.9, 0.1]) });
    const v = (await advisor.choose(TASK, ROSTER))!;
    expect(v.pick?.name).toBe('Astra');
    expect(v.ranked.map((t) => t.name)).toEqual(['Astra', 'Draco', 'Lumen']);
    expect(v.jevCostUsd).toBeGreaterThan(0);
    // The record says who was passed over, which is the sentence the
    // dispatcher persona is required to post on the task.
    expect(v.summary).toContain('over Draco');
  });

  it('queues rather than dispatching when the only fit is busy', async () => {
    const busy = ROSTER.map((t) => (t.id === 'astra' ? { ...t, available: false } : { ...t, available: false }));
    const advisor = new JevRosterAdvisor({ client: clientScoring([1.2, 2.9, 0.1]) });
    const v = (await advisor.choose(TASK, busy))!;
    expect(v.pick).toBeNull();
    expect(v.best?.name).toBe('Astra');
    expect(v.summary).toContain('Queue it');
  });

  it('reports no fit rather than naming the least-bad option', async () => {
    const advisor = new JevRosterAdvisor({ client: clientScoring([0.3, 0.2, 0.1]) });
    const v = (await advisor.choose(TASK, ROSTER))!;
    expect(v.noFit).toBe(true);
    expect(v.pick).toBeNull();
    expect(v.summary).toContain(NO_FIT_BELOW.toFixed(2));
  });

  it('has no opinion with no task or an empty roster', async () => {
    const advisor = new JevRosterAdvisor({ client: clientScoring([1]) });
    expect(await advisor.choose(null, ROSTER)).toBeNull();
    expect(await advisor.choose(TASK, [])).toBeNull();
  });

  it('fails open when Jev is down', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const advisor = new JevRosterAdvisor({
      client: new JevClient({ apiKey: 'k', retries: 0, fetchImpl: fetchImpl as unknown as typeof fetch }),
    });
    expect(await advisor.choose(TASK, ROSTER)).toBeNull();
  });

  it('the null advisor is opinionated nowhere', async () => {
    expect(await nullRosterAdvisor.choose(TASK, ROSTER)).toBeNull();
  });
});
