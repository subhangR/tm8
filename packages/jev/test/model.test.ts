// The decision is pure, so these are the real assertions about what Jev
// suggests. Every number came from the 57-task calibration run, not from taste.

import { describe, expect, it } from 'vitest';
import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';
import type { JevAskResult, JevCallRecord, JevClient } from '../src/client.js';
import {
  DEFAULT_WEIGHTS,
  ROUTING_QUESTIONS,
  TIER_LADDER,
  adviseModel,
  decide,
  readSignals,
  routingState,
  type RoutingSignals,
} from '../src/model.js';

const base: RoutingSignals = {
  workKind: 'implement',
  workKindConfidence: 0.9,
  reasoningDepth: 0,
  contextBreadth: 0,
  blastRadius: 0,
  needsLongContext: 0,
  specComplete: 0.9,
  humanNamedModel: 0,
  harnessFit: 'either',
  harnessConfidence: 0.9,
  harnessTopTwo: 0.95,
};

describe('the ladder', () => {
  it('names only models the node can launch, at efforts they accept', () => {
    // A ladder typo would suggest a model the CLI rejects at boot.
    for (const rung of TIER_LADDER) {
      for (const model of [rung.claude, rung.codex]) {
        expect(LAUNCH_MODEL_CATALOG.some((e) => e.model === model), model).toBe(true);
      }
      const entry = LAUNCH_MODEL_CATALOG.find((e) => e.model === rung.claude)!;
      expect((entry.efforts as readonly string[]).includes(rung.effort), `${rung.claude} ${rung.effort}`).toBe(true);
    }
    expect(TIER_LADDER.map((r) => r.tier)).toEqual(['economy', 'standard', 'premium', 'frontier']);
  });
});

describe('tier from the composite', () => {
  it('puts shallow, narrow, harmless work on economy', () => {
    expect(decide(base)).toMatchObject({ tier: 'economy', model: 'claude-haiku-4-5-20251001', effort: 'medium' });
  });

  it('climbs as the axes rise: need = 0.45d + 0.30b + 0.25r, cut at 0.8 / 1.6 / 2.3', () => {
    expect(decide({ ...base, reasoningDepth: 2 }).need).toBeCloseTo(0.9, 6);
    expect(decide({ ...base, reasoningDepth: 2 }).tier).toBe('standard');
    expect(decide({ ...base, reasoningDepth: 3, contextBreadth: 2 }).tier).toBe('premium');
    expect(decide({ ...base, reasoningDepth: 3, contextBreadth: 3, blastRadius: 1 }).tier).toBe('frontier');
  });

  it('carries the work kind and the reasons into the suggestion', () => {
    const v = decide({ ...base, workKind: 'review' });
    expect(v.workKind).toBe('review');
    expect(v.reasons[0]).toMatch(/^need=0\.00/);
    expect(Object.keys(v).sort()).toEqual(['agentTool', 'effort', 'model', 'need', 'reasons', 'tier', 'workKind']);
  });
});

describe('policy floors — Jev gets no vote', () => {
  it('lifts blast radius >= 2 to premium', () => {
    const v = decide({ ...base, blastRadius: 2 });
    expect(v.tier).toBe('premium');
    expect(v.reasons.some((r) => r.includes('production-affecting'))).toBe(true);
  });

  it('does not lift blast radius just under 2', () => {
    expect(decide({ ...base, blastRadius: 1.99 }).tier).toBe('economy');
  });

  it('promotes long context > .6 to frontier on the 1M model', () => {
    const v = decide({ ...base, needsLongContext: 0.61 });
    expect(v).toMatchObject({ tier: 'frontier', model: 'claude-opus-5[1m]', effort: 'max' });
  });

  it('does not promote long context of exactly .6, nor a coin flip', () => {
    expect(decide({ ...base, needsLongContext: 0.6 }).tier).toBe('economy');
    expect(decide({ ...base, needsLongContext: 0.5 }).tier).toBe('economy');
  });
});

describe('the codex gate', () => {
  it('opens when codex is chosen at top-2 mass > .6', () => {
    const v = decide({ ...base, harnessFit: 'codex', harnessTopTwo: 0.61 });
    expect(v).toMatchObject({ agentTool: 'codex', model: 'gpt-5.6-luna' });
    expect(v.reasons.at(-1)).toContain('harness_fit=codex');
  });

  it('stays shut at exactly .6', () => {
    expect(decide({ ...base, harnessFit: 'codex', harnessTopTwo: 0.6 }).agentTool).toBe('claude-code');
  });

  it('gates on top-2 mass, not argmax confidence', () => {
    const v = decide({ ...base, harnessFit: 'codex', harnessConfidence: 0.99, harnessTopTwo: 0.4 });
    expect(v.agentTool).toBe('claude-code');
  });

  it('keeps long-context work on claude-code, because codex has no 1M rung', () => {
    const v = decide({ ...base, harnessFit: 'codex', harnessTopTwo: 0.99, needsLongContext: 0.9 });
    expect(v).toMatchObject({ tier: 'frontier', agentTool: 'claude-code' });
  });
});

describe('weights are data', () => {
  it('re-decides on changed thresholds without new inference', () => {
    const signals = { ...base, reasoningDepth: 1.5 };
    expect(decide(signals, { ...DEFAULT_WEIGHTS, thresholds: [0.1, 0.2, 0.3] }).tier).toBe('frontier');
    expect(decide(signals, { ...DEFAULT_WEIGHTS, thresholds: [3, 3, 3] }).tier).toBe('economy');
  });
});

describe('readSignals', () => {
  it('returns null rather than half a suggestion when a question is missing', () => {
    expect(readSignals({ work_kind: { choice: 'implement', confidence: 1 } })).toBeNull();
  });
});

describe('routingState', () => {
  it('sends named fields, and only the ones present', () => {
    expect(routingState({ title: 't', description: 'd' })).toEqual({ title: 't', description: 'd' });
    expect(
      routingState({ title: 't', description: 'd', priority: 'high', status: 'open', acceptanceCriteriaCount: 0, parentTitle: 'p' }),
    ).toEqual({ title: 't', description: 'd', priority: 'high', status: 'open', acceptance_criteria_count: 0, parent_task: 'p' });
  });
});

describe('adviseModel', () => {
  const call: JevCallRecord = { jevModel: 'jev-1.13.0', inputTokens: 900, outputTokens: 0, costUsd: 900 * 42e-9, latencyMs: 12, outcome: 'ok' };
  const fake = (result: JevAskResult): JevClient & { asked: unknown[] } => {
    const asked: unknown[] = [];
    return {
      asked,
      ask: async (state, questions) => {
        asked.push({ state, questions });
        return result;
      },
    };
  };

  it('asks the eight routing questions about the subject', async () => {
    const client = fake({ ok: false, reason: 'timeout', call: { ...call, outcome: 'timeout' } });
    await adviseModel(client, { title: 't', description: 'd' });
    expect(client.asked).toEqual([{ state: { title: 't', description: 'd' }, questions: ROUTING_QUESTIONS }]);
  });

  it('passes a client failure through with its call record', async () => {
    const failed = { ...call, outcome: 'rate_limited' as const };
    const out = await adviseModel(fake({ ok: false, reason: 'rate_limited', call: failed }), { title: 't', description: 'd' });
    expect(out).toEqual({ ok: false, reason: 'rate_limited', call: failed });
  });

  it('fails as unparsed when the answers do not read as the eight signals, keeping the spent tokens', async () => {
    const response = { model: 'jev-1.13.0', answers: { work_kind: { choice: 'implement', confidence: 1 } }, usage: { input_tokens: 900, output_tokens: 0 } };
    const out = await adviseModel(fake({ ok: true, response, call }), { title: 't', description: 'd' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('unparsed');
    expect(out.call).toMatchObject({ outcome: 'unparsed', inputTokens: 900, jevModel: 'jev-1.13.0' });
  });
});
