// The advisor is the seam, so these tests are mostly about what it does when
// things go WRONG — a routing service that is down must never stop a spawn.
import { describe, expect, it, vi } from 'vitest';
import { JevClient } from '../src/client.js';
import { JevRoutingAdvisor, nullRoutingAdvisor } from '../src/advisor.js';
import type { JevResponse } from '../src/primitives.js';

const ANSWERS: JevResponse['answers'] = {
  work_kind: { choice: 'implement', confidence: 0.95, distribution: { implement: 0.95, review: 0.05 } },
  reasoning_depth: { score: 0.1, confidence: 0.9 },
  context_breadth: { score: 0.1, confidence: 0.9 },
  blast_radius: { score: 0.1, confidence: 0.9 },
  needs_long_context: { noul: 0.02 },
  spec_complete: { noul: 0.9 },
  human_named_model: { noul: 0.01 },
  harness_fit: { choice: 'either', confidence: 0.9, distribution: { either: 0.9, codex: 0.05, claude_code: 0.05 } },
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

function advisorWith(fetchImpl: typeof fetch, policy: 'off' | 'advise' | 'auto' = 'advise') {
  return new JevRoutingAdvisor({
    client: new JevClient({ apiKey: 'k', fetchImpl, retries: 0 }),
    policy,
  });
}

const TASK = { title: 'Fix a typo', description: 'One word in one file.' };
const OK = { model: 'jev-1.13.0', answers: ANSWERS, usage: { input_tokens: 1200, output_tokens: 0 } };

describe('the default advisor', () => {
  it('has no opinion, so an unwired node behaves exactly as it does today', async () => {
    expect(await nullRoutingAdvisor.advise(TASK, {})).toBeNull();
  });
});

describe('fail-open', () => {
  it('returns null on a transport failure', async () => {
    const boom = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await advisorWith(boom).advise(TASK, {})).toBeNull();
  });

  it('returns null on a 500', async () => {
    expect(await advisorWith(fakeFetch({}, 500)).advise(TASK, {})).toBeNull();
  });

  it('returns null on a 401, and does not retry a request that cannot succeed', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 401 }));
    const advisor = new JevRoutingAdvisor({
      client: new JevClient({ apiKey: 'bad', fetchImpl: spy as unknown as typeof fetch, retries: 3 }),
    });
    expect(await advisor.advise(TASK, {})).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns null when the body parses but carries no answers', async () => {
    expect(await advisorWith(fakeFetch({ model: 'jev-1' })).advise(TASK, {})).toBeNull();
  });

  it('returns null when answers are present but malformed', async () => {
    const bad = { model: 'jev-1', answers: { work_kind: { choice: 'implement', confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 0 } };
    expect(await advisorWith(fakeFetch(bad)).advise(TASK, {})).toBeNull();
  });

  it('times out rather than holding a spawn open', async () => {
    const hang = (async (_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const advisor = new JevRoutingAdvisor({
      client: new JevClient({ apiKey: 'k', fetchImpl: hang, timeoutMs: 20, retries: 0 }),
    });
    expect(await advisor.advise(TASK, {})).toBeNull();
  });
});

describe('declining to guess', () => {
  it('has no opinion when there is no task to route on', async () => {
    expect(await advisorWith(fakeFetch(OK)).advise(null, {})).toBeNull();
  });

  it('has no opinion when the task is empty', async () => {
    expect(await advisorWith(fakeFetch(OK)).advise({ title: '', description: '' }, {})).toBeNull();
  });

  it('never calls Jev at all when the policy is off', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(OK), { status: 200 }));
    const advisor = new JevRoutingAdvisor({
      client: new JevClient({ apiKey: 'k', fetchImpl: spy as unknown as typeof fetch }),
      policy: 'off',
    });
    expect(await advisor.advise(TASK, {})).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('precedence', () => {
  it('routes when nobody named a model — the loop and dispatcher case', async () => {
    const adv = await advisorWith(fakeFetch(OK)).advise(TASK, {});
    expect(adv?.model).toBe('claude-haiku-4-5-20251001');
    expect(adv?.activation.changed).toBe(true);
  });

  it("under 'advise', keeps a human's explicit model and flags the disagreement", async () => {
    const adv = await advisorWith(fakeFetch(OK), 'advise').advise(TASK, { requestedModel: 'claude-opus-5' });
    expect(adv?.model).toBeNull();
    expect(adv?.activation.appliedModel).toBe('claude-opus-5');
    expect(adv?.activation.overriddenByHuman).toBe(true);
    // The verdict is still recorded — that is what makes the disagreement visible.
    expect(adv?.activation.verdict.model).toBe('claude-haiku-4-5-20251001');
  });

  it("under 'auto', overrides the human and says so", async () => {
    const adv = await advisorWith(fakeFetch(OK), 'auto').advise(TASK, { requestedModel: 'claude-opus-5' });
    expect(adv?.model).toBe('claude-haiku-4-5-20251001');
    expect(adv?.activation.changed).toBe(true);
    expect(adv?.activation.overriddenByHuman).toBe(false);
  });

  it('treats the persona default as a baseline, not as a human choice', async () => {
    const adv = await advisorWith(fakeFetch(OK), 'advise').advise(TASK, { memberModel: 'claude-opus-5' });
    expect(adv?.model).toBe('claude-haiku-4-5-20251001');
    expect(adv?.activation.baselineModel).toBe('claude-opus-5');
  });
});

describe('the activation record', () => {
  it('records what would have run, what will run, and what Jev cost', async () => {
    const adv = await advisorWith(fakeFetch(OK)).advise(TASK, { memberModel: 'claude-opus-5' }, 'on-demand');
    const a = adv!.activation;
    expect(a.mode).toBe('on-demand');
    expect(a.jevModel).toBe('jev-1.13.0');
    expect(a.jevInputTokens).toBe(1200);
    // $42 per billion input tokens.
    expect(a.jevCostUsd).toBeCloseTo(1200 * 42e-9, 12);
    expect(a.baselineModel).toBe('claude-opus-5');
    expect(a.appliedModel).toBe('claude-haiku-4-5-20251001');
    expect(a.savings?.savedUsd).toBeGreaterThan(0);
    expect(a.summary).toContain('claude-haiku-4-5-20251001');
  });

  it('nets Jev’s own cost off the saving', async () => {
    const adv = await advisorWith(fakeFetch(OK)).advise(TASK, { memberModel: 'claude-opus-5' });
    const s = adv!.activation.savings!;
    expect(s.netSavedUsd).toBeCloseTo(s.savedUsd - s.jevCostUsd, 12);
  });

  it('never claims a saving is measured', async () => {
    const adv = await advisorWith(fakeFetch(OK)).advise(TASK, { memberModel: 'claude-opus-5' });
    expect(adv!.activation.savings!.measured).toBe(false);
    expect(adv!.activation.savings!.assumption).toMatch(/[Cc]ounterfactual/);
  });
});
