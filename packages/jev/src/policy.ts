// @tm8/jev — the routing policy.
//
// JEV OWNS THE JUDGEMENTS. THIS FILE OWNS THE DECISION. That split is the whole
// architecture: the model says how deep the reasoning is, how broad the context
// is and how bad a mistake would be; tm8 decides what those facts are worth.
// Weights and thresholds below are data, so re-routing the whole backlog on a
// changed weight costs nothing and re-runs no inference.
//
// Nothing here does I/O. Given the same answers it returns the same verdict, so
// the policy is testable without a network and a verdict can be recomputed from
// a stored answer set.

import {
  isChoice,
  isNoul,
  isScore,
  topTwoMass,
  type JevAnswer,
  type JevResponse,
} from './primitives.js';
import { TIER_LADDER, TIER_ORDER, rung, type TierName } from './tiers.js';

export interface RoutingWeights {
  readonly depth: number;
  readonly breadth: number;
  readonly radius: number;
  /** Upper bound of each tier on the 0..3 composite, ascending. */
  readonly thresholds: readonly [number, number, number];
  /** blast_radius at or above this forces at least `premium`. */
  readonly productionFloor: number;
  /** needs_long_context above this forces `frontier`. */
  readonly longContextGate: number;
  /** harness_fit must be at least this concentrated to move a session to Codex. */
  readonly harnessConfidence: number;
}

/**
 * Calibrated on 60 real tm8 tasks. See §9 of the design doc for the threshold
 * that would have shipped broken and why it is no longer a gate.
 */
export const DEFAULT_WEIGHTS: RoutingWeights = {
  depth: 0.45,
  breadth: 0.3,
  radius: 0.25,
  thresholds: [0.8, 1.6, 2.3],
  productionFloor: 2.0,
  longContextGate: 0.6,
  harnessConfidence: 0.6,
};

export interface RoutingSignals {
  readonly workKind: string;
  readonly workKindConfidence: number;
  readonly reasoningDepth: number;
  readonly contextBreadth: number;
  readonly blastRadius: number;
  readonly needsLongContext: number;
  readonly specComplete: number;
  readonly humanNamedModel: number;
  readonly harnessFit: string;
  readonly harnessConfidence: number;
  /** Top-2 mass on harness_fit — the safety signal, not `confidence`. See §5.1. */
  readonly harnessTopTwo: number;
}

export interface RoutingVerdict {
  readonly tier: TierName;
  readonly model: string;
  readonly agentTool: 'claude-code' | 'codex';
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** The 0..3 composite. Recorded so a verdict can be re-read without Jev. */
  readonly need: number;
  /** Human-readable, one line, for the activation record. */
  readonly rationale: string;
  /** Which rules fired, in order. The audit trail for a surprising route. */
  readonly reasons: readonly string[];
  /**
   * Attention points 1-100, or 0 for none.
   *
   * spec_complete is NOT a gate. Gating on it blocked 36 of 60 real tm8 tasks,
   * because the median real task scores 0.22 — tm8 tasks are genuinely terse
   * and an agent starts anyway. It raises attention instead: a human sees the
   * thin ones, and nothing stalls waiting for a human who is not there.
   */
  readonly attentionPoints: number;
  readonly signals: RoutingSignals;
}

/** Pull the eight answers out of a response, or null if the shape is wrong. */
export function readSignals(answers: Record<string, JevAnswer>): RoutingSignals | null {
  const kind = answers.work_kind;
  const depth = answers.reasoning_depth;
  const breadth = answers.context_breadth;
  const radius = answers.blast_radius;
  const longctx = answers.needs_long_context;
  const spec = answers.spec_complete;
  const named = answers.human_named_model;
  const harness = answers.harness_fit;

  if (
    !isChoice(kind) ||
    !isScore(depth) ||
    !isScore(breadth) ||
    !isScore(radius) ||
    !isNoul(longctx) ||
    !isNoul(spec) ||
    !isNoul(named) ||
    !isChoice(harness)
  ) {
    return null;
  }

  return {
    workKind: kind.choice,
    workKindConfidence: kind.confidence,
    reasoningDepth: depth.score,
    contextBreadth: breadth.score,
    blastRadius: radius.score,
    needsLongContext: longctx.noul,
    specComplete: spec.noul,
    humanNamedModel: named.noul,
    harnessFit: harness.choice,
    harnessConfidence: harness.confidence,
    harnessTopTwo: topTwoMass(harness),
  };
}

/**
 * The composite, and the ladder position it lands on.
 *
 * Three axes rather than one "difficulty" score because they disagree in useful
 * ways: a one-line credential change is shallow, narrow and production-
 * affecting, and only the third fact should keep it off Haiku.
 */
export function decide(
  signals: RoutingSignals,
  weights: RoutingWeights = DEFAULT_WEIGHTS,
): RoutingVerdict {
  const need =
    weights.depth * signals.reasoningDepth +
    weights.breadth * signals.contextBreadth +
    weights.radius * signals.blastRadius;

  const [t0, t1, t2] = weights.thresholds;
  let idx = need < t0 ? 0 : need < t1 ? 1 : need < t2 ? 2 : 3;
  const reasons: string[] = [
    `need=${need.toFixed(2)} (depth ${signals.reasoningDepth.toFixed(2)}, breadth ${signals.contextBreadth.toFixed(2)}, radius ${signals.blastRadius.toFixed(2)}) -> ${TIER_ORDER[idx]}`,
  ];

  // Policy floors. These are not judgements and Jev does not get a vote.
  if (signals.blastRadius >= weights.productionFloor && idx < 2) {
    idx = 2;
    reasons.push(`blast_radius ${signals.blastRadius.toFixed(2)} >= ${weights.productionFloor}: production-affecting work does not run cheap -> premium`);
  }
  if (signals.needsLongContext > weights.longContextGate && idx < 3) {
    idx = 3;
    reasons.push(`needs_long_context ${signals.needsLongContext.toFixed(2)} > ${weights.longContextGate}: 1M context is a capability, not a luxury -> frontier`);
  }

  const tier = TIER_ORDER[idx] ?? 'standard';
  const ladder = rung(tier);
  let model: string = ladder.claude;
  let agentTool: 'claude-code' | 'codex' = 'claude-code';

  // Harness choice, gated on top-2 mass rather than argmax confidence. A
  // long-context session stays on Claude Code regardless: the 1M variant is the
  // reason it was promoted, and Codex has no counterpart for it.
  if (
    signals.harnessFit === 'codex' &&
    signals.harnessTopTwo > weights.harnessConfidence &&
    signals.needsLongContext <= weights.longContextGate
  ) {
    model = ladder.codex;
    agentTool = 'codex';
    reasons.push(`harness_fit=codex at top-2 mass ${signals.harnessTopTwo.toFixed(2)} -> ${model} on codex`);
  }

  return {
    tier,
    model,
    agentTool,
    effort: ladder.effort,
    need: Number(need.toFixed(3)),
    rationale: `${tier} · ${model} · effort=${ladder.effort} · need=${need.toFixed(2)} · ${signals.workKind}`,
    reasons,
    attentionPoints: attentionFor(signals),
    signals,
  };
}

/**
 * Under-specification becomes attention, never a block.
 *
 * Linear in how far spec_complete sits below even odds, floored at 20 so a flag
 * that fires is worth a human's glance, capped at 100 by the tm8 primitive.
 */
export function attentionFor(signals: RoutingSignals): number {
  if (signals.specComplete >= 0.5) return 0;
  const raw = Math.round((0.5 - signals.specComplete) * 2 * 70) + 20;
  return Math.max(1, Math.min(100, raw));
}

/** One-shot: response in, verdict out. `null` when the answers do not parse. */
export function verdictFrom(
  response: JevResponse,
  weights: RoutingWeights = DEFAULT_WEIGHTS,
): RoutingVerdict | null {
  const signals = readSignals(response.answers);
  return signals ? decide(signals, weights) : null;
}

/** Ladder models, for a caller that wants to show the whole ladder. */
export function ladderModels(): readonly string[] {
  return TIER_LADDER.map((r) => r.claude);
}
