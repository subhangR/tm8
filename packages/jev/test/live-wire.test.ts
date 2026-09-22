// The shape of the real wire, pinned.
//
// Every other test in this package injects a fetch that returns a response this
// repository invented. That is how a field-name mismatch survived 112 passing
// tests: the fixtures agreed with the code because the same hand wrote both.
// These tests read a response the API actually sent.

import { describe, expect, it } from 'vitest';
import { LIVE_ROUTING_RESPONSE } from './fixtures/live-routing-response.js';
import {
  isChoice,
  isNoul,
  isScore,
  massOf,
  topTwoMass,
  type JevChoiceAnswer,
} from '../src/primitives.js';
import { DEFAULT_WEIGHTS, decide, readSignals } from '../src/policy.js';
import { ROUTING_QUESTIONS } from '../src/questions.js';

const answers = LIVE_ROUTING_RESPONSE.answers as Record<string, never>;

describe('the live jev wire', () => {
  it('answers every question we ask, and nothing we did not', () => {
    expect(Object.keys(answers).sort()).toEqual(Object.keys(ROUTING_QUESTIONS).sort());
  });

  it('names the mass `probabilities`, which is why `distribution` alone was a bug', () => {
    const harness = answers.harness_fit as unknown as JevChoiceAnswer;
    expect(harness.probabilities).toBeDefined();
    expect(harness.distribution).toBeUndefined();
    expect(massOf(harness)).toBe(harness.probabilities);
  });

  it('reads top-2 mass far above the argmax confidence it used to fall back to', () => {
    const harness = answers.harness_fit as unknown as JevChoiceAnswer;
    // The numbers the API actually returned. They are not close, and the gate
    // sits between them: 0.29 fails `> 0.6`, 0.89 passes it.
    expect(harness.confidence).toBeCloseTo(0.29, 2);
    expect(topTwoMass(harness)).toBeCloseTo(0.89, 2);
    expect(harness.confidence).toBeLessThan(DEFAULT_WEIGHTS.harnessConfidence);
    expect(topTwoMass(harness)).toBeGreaterThan(DEFAULT_WEIGHTS.harnessConfidence);
  });

  it('a codex-leaning real answer opens the codex gate — and would not have before the fix', () => {
    // Same real answer, with the mass leaning the other way. Everything else is
    // the recorded response.
    const codexLeaning = {
      ...(answers.harness_fit as unknown as JevChoiceAnswer),
      choice: 'codex',
      confidence: 0.31,
      probabilities: { codex: 0.55, either: 0.34, claude_code: 0.11 },
    };
    const signals = readSignals({ ...answers, harness_fit: codexLeaning } as never);
    expect(signals).not.toBeNull();
    expect(signals!.harnessTopTwo).toBeCloseTo(0.89, 2);

    const withMass = decide(signals!, DEFAULT_WEIGHTS);

    // The pre-fix reading: no `probabilities`, so topTwoMass returned confidence.
    const preFix = readSignals({
      ...answers,
      harness_fit: { choice: 'codex', confidence: 0.31 },
    } as never);
    expect(preFix!.harnessTopTwo).toBeCloseTo(0.31, 2);
    const withConfidence = decide(preFix!, DEFAULT_WEIGHTS);

    expect(withMass.agentTool).toBe('codex');
    expect(withConfidence.agentTool).toBe('claude-code');
    expect(withMass.model).not.toBe(withConfidence.model);
  });

  it('parses into signals, so the real shape reaches the ladder', () => {
    const signals = readSignals(answers as never);
    expect(signals).not.toBeNull();
    expect(signals!.workKind).toBe('implement');
    expect(signals!.reasoningDepth).toBeGreaterThan(0);
    expect(signals!.needsLongContext).toBeGreaterThanOrEqual(0);
  });

  it('carries the three primitive kinds the narrowings expect', () => {
    expect(isChoice(answers.work_kind)).toBe(true);
    expect(isScore(answers.reasoning_depth)).toBe(true);
    expect(isNoul(answers.needs_long_context)).toBe(true);
  });

  it('reports usage, which is what the cost line is computed from', () => {
    expect(LIVE_ROUTING_RESPONSE.usage.input_tokens).toBeGreaterThan(0);
    expect(LIVE_ROUTING_RESPONSE.model).toMatch(/^jev-\d+\.\d+\.\d+$/);
  });
});
