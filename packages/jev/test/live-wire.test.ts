// The shape of the real wire, pinned.
//
// Every other test in this package injects a fetch that returns a response this
// repository invented. That is how a field-name mismatch once survived 112
// passing tests: the fixtures agreed with the code because the same hand wrote
// both. These tests read a response the API actually sent.

import { describe, expect, it } from 'vitest';
import { LIVE_ROUTING_RESPONSE } from './fixtures/live-routing-response.js';
import { createJevClient } from '../src/client.js';
import { DEFAULT_WEIGHTS, ROUTING_QUESTIONS, adviseModel, decide, readSignals } from '../src/model.js';
import { isChoice, isNoul, isScore, topTwoMass, type JevChoiceAnswer } from '../src/wire.js';

const answers = LIVE_ROUTING_RESPONSE.answers as Record<string, never>;
const harness = answers.harness_fit as unknown as JevChoiceAnswer;

/** The recorded response with harness_fit leaning the other way; everything else verbatim. */
const codexLeaning: JevChoiceAnswer = {
  ...harness,
  choice: 'codex',
  confidence: 0.31,
  probabilities: { codex: 0.55, either: 0.34, claude_code: 0.11 },
};

describe('the live jev wire', () => {
  it('answers every question we ask, and nothing we did not', () => {
    expect(Object.keys(answers).sort()).toEqual(Object.keys(ROUTING_QUESTIONS).sort());
  });

  it('names the mass `probabilities` — there is no `distribution` on the wire', () => {
    expect(harness.probabilities).toBeDefined();
    expect((harness as unknown as Record<string, unknown>).distribution).toBeUndefined();
  });

  it('reads top-2 mass from `probabilities`, far above the argmax confidence', () => {
    // The numbers the API actually returned. The gate sits between them:
    // 0.29 fails `> 0.6`, 0.89 passes it.
    expect(harness.confidence).toBeCloseTo(0.29, 2);
    expect(topTwoMass(harness)).toBeCloseTo(0.89, 2);
    expect(harness.confidence).toBeLessThan(DEFAULT_WEIGHTS.harnessConfidence);
    expect(topTwoMass(harness)).toBeGreaterThan(DEFAULT_WEIGHTS.harnessConfidence);
  });

  it('routes the codex-leaning real answer to codex, because the top-2 mass is read', () => {
    const signals = readSignals({ ...answers, harness_fit: codexLeaning } as never);
    expect(signals).not.toBeNull();
    expect(signals!.harnessTopTwo).toBeCloseTo(0.89, 2);

    const verdict = decide(signals!);
    expect(verdict.agentTool).toBe('codex');
    expect(verdict.model).toBe('gpt-6-astra');
    expect(verdict.tier).toBe('premium');
  });

  it('keeps an answer without `probabilities` on claude-code — no fallback to confidence', () => {
    const noMass = { choice: 'codex', confidence: 0.95 };
    const signals = readSignals({ ...answers, harness_fit: noMass } as never);
    expect(signals!.harnessTopTwo).toBe(0);
    expect(decide(signals!).agentTool).toBe('claude-code');
  });

  it('carries the three primitive kinds the narrowings expect', () => {
    expect(isChoice(answers.work_kind)).toBe(true);
    expect(isScore(answers.reasoning_depth)).toBe(true);
    expect(isNoul(answers.needs_long_context)).toBe(true);
  });

  it('reports usage and a concrete model version, which is what the call record is built from', () => {
    expect(LIVE_ROUTING_RESPONSE.usage.input_tokens).toBeGreaterThan(0);
    expect(LIVE_ROUTING_RESPONSE.model).toMatch(/^jev-\d+\.\d+\.\d+$/);
  });
});

describe('adviseModel on the recorded response', () => {
  const clientReturning = (body: unknown) =>
    createJevClient({
      apiKey: 'fixture-key',
      fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch,
    });

  it("reproduces today's decision: premium, claude-opus-5, high effort, on claude-code", async () => {
    // need = 0.45*1.99 + 0.30*1.95 + 0.25*1.64 = 1.89 -> premium; no floor
    // fires; harness_fit is claude_code. Cross-checked against main's
    // `verdictFrom` (policy.ts at 63f89331) on the same response.
    const out = await adviseModel(clientReturning(LIVE_ROUTING_RESPONSE), { title: 't', description: 'd' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.verdict).toMatchObject({
      tier: 'premium',
      model: 'claude-opus-5',
      agentTool: 'claude-code',
      effort: 'high',
      workKind: 'implement',
    });
    expect(out.verdict.need).toBeCloseTo(1.89, 2);
    expect(out.call).toMatchObject({ jevModel: 'jev-1.13.0', inputTokens: 1289, outputTokens: 213, outcome: 'ok' });
  });

  it('routes the codex-leaning variant to codex end to end', async () => {
    const body = { ...LIVE_ROUTING_RESPONSE, answers: { ...answers, harness_fit: codexLeaning } };
    const out = await adviseModel(clientReturning(body), { title: 't', description: 'd' });
    expect(out.ok && out.verdict.agentTool).toBe('codex');
    expect(out.ok && out.verdict.model).toBe('gpt-6-astra');
  });
});
