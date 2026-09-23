// The policy is pure, so these are the real assertions about how tm8 routes.
// Every number here came from the 60-task calibration run, not from taste.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  attentionFor,
  decide,
  readSignals,
  verdictFrom,
} from '../src/policy.js';
import { assertLadderIsLaunchable, tierOfModel } from '../src/tiers.js';
import type { RoutingSignals } from '../src/policy.js';

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
  it('only names models the node can actually launch', () => {
    // A ladder typo routes a session to a model the CLI rejects at boot, which
    // reads as a Jev outage rather than a one-character mistake.
    expect(() => assertLadderIsLaunchable()).not.toThrow();
  });
});

describe('tier from the composite', () => {
  it('puts shallow, narrow, harmless work on economy', () => {
    expect(decide(base).tier).toBe('economy');
  });

  it('climbs monotonically as the axes rise', () => {
    // need = 0.45d + 0.30b + 0.25r, cut at 0.8 / 1.6 / 2.3.
    expect(decide({ ...base, reasoningDepth: 2 }).need).toBeCloseTo(0.9, 6);
    expect(decide({ ...base, reasoningDepth: 2 }).tier).toBe('standard');
    // 1.35 + 0.60 = 1.95 — high, but short of frontier. Reaching the top rung
    // on the composite alone takes all three axes, which is the intent: only a
    // long-context capability gate should promote there cheaply.
    expect(decide({ ...base, reasoningDepth: 3, contextBreadth: 2 }).tier).toBe('premium');
    expect(decide({ ...base, reasoningDepth: 3, contextBreadth: 3, blastRadius: 1 }).tier).toBe('frontier');
  });

  it('weights depth above breadth above radius', () => {
    const d = decide({ ...base, reasoningDepth: 3 }).need;
    const b = decide({ ...base, contextBreadth: 3 }).need;
    const r = decide({ ...base, blastRadius: 3 }).need;
    expect(d).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(r);
  });
});

describe('policy floors — these are not judgements and Jev gets no vote', () => {
  it('never runs production-affecting work on a cheap tier', () => {
    // Shallow and narrow: the composite alone says economy. The radius says no.
    const v = decide({ ...base, blastRadius: 2.2 });
    expect(v.tier).toBe('premium');
    expect(v.reasons.some((r) => r.includes('production-affecting'))).toBe(true);
  });

  it('promotes to frontier when the work needs 1M context', () => {
    const v = decide({ ...base, needsLongContext: 0.8 });
    expect(v.tier).toBe('frontier');
    expect(v.model).toBe('claude-opus-5[1m]');
  });

  it('does not promote on a long-context noul that is merely uncertain', () => {
    // 0.5 means "as likely as not", never "medium intensity" — it must not
    // spend frontier money on a coin flip.
    expect(decide({ ...base, needsLongContext: 0.5 }).tier).toBe('economy');
  });
});

describe('harness choice', () => {
  it('moves to codex on a concentrated harness_fit', () => {
    const v = decide({ ...base, harnessFit: 'codex', harnessTopTwo: 0.9 });
    expect(v.agentTool).toBe('codex');
    expect(v.model).toBe('gpt-5.6-luna');
  });

  it('gates on top-2 mass, not argmax confidence', () => {
    // High argmax confidence but a scattered distribution must NOT move vendor.
    const v = decide({ ...base, harnessFit: 'codex', harnessConfidence: 0.99, harnessTopTwo: 0.4 });
    expect(v.agentTool).toBe('claude-code');
  });

  it('keeps long-context work on claude-code, because codex has no 1M rung', () => {
    const v = decide({ ...base, harnessFit: 'codex', harnessTopTwo: 0.99, needsLongContext: 0.9 });
    expect(v.tier).toBe('frontier');
    expect(v.agentTool).toBe('claude-code');
  });
});

describe('spec_complete raises attention and never blocks', () => {
  // The bug this replaced: gating on spec_complete < 0.35 blocked 36 of 60 real
  // tm8 tasks, because the median real task scores 0.22.
  it('returns a verdict for a badly under-specified task', () => {
    const v = decide({ ...base, specComplete: 0.05 });
    expect(v.model).toBeTruthy();
    expect(v.attentionPoints).toBeGreaterThan(0);
  });

  it('raises nothing when the task is specified', () => {
    expect(attentionFor({ ...base, specComplete: 0.6 })).toBe(0);
  });

  it('stays inside the tm8 1-100 primitive', () => {
    for (const specComplete of [0, 0.1, 0.25, 0.49]) {
      const pts = attentionFor({ ...base, specComplete });
      expect(pts).toBeGreaterThanOrEqual(1);
      expect(pts).toBeLessThanOrEqual(100);
    }
  });
});

describe('reading answers off the wire', () => {
  it('returns null rather than half a verdict when a question is missing', () => {
    expect(readSignals({ work_kind: { choice: 'implement', confidence: 1 } })).toBeNull();
  });

  it('returns null when a score arrives shaped like a noul', () => {
    const answers = {
      work_kind: { choice: 'implement', confidence: 1 },
      reasoning_depth: { noul: 0.5 },
      context_breadth: { score: 1, confidence: 1 },
      blast_radius: { score: 1, confidence: 1 },
      needs_long_context: { noul: 0 },
      spec_complete: { noul: 1 },
      human_named_model: { noul: 0 },
      harness_fit: { choice: 'either', confidence: 1 },
    };
    expect(readSignals(answers as never)).toBeNull();
    expect(verdictFrom({ model: 'jev-1', answers: answers as never, usage: { input_tokens: 1, output_tokens: 0 } })).toBeNull();
  });
});

describe('weights are data', () => {
  it('re-routes on changed thresholds without new inference', () => {
    const signals = { ...base, reasoningDepth: 1.5 };
    const strict = decide(signals, { ...DEFAULT_WEIGHTS, thresholds: [0.1, 0.2, 0.3] });
    const loose = decide(signals, { ...DEFAULT_WEIGHTS, thresholds: [3, 3, 3] });
    expect(strict.tier).toBe('frontier');
    expect(loose.tier).toBe('economy');
  });
});

describe('tierOfModel', () => {
  it('maps both vendors onto the same ladder', () => {
    expect(tierOfModel('claude-haiku-4-5-20251001')).toBe('economy');
    expect(tierOfModel('gpt-6-astra')).toBe('premium');
    expect(tierOfModel('claude-fable-5')).toBeNull();
  });
});
