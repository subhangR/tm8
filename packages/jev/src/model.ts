// @tm8/jev — the model suggestion: eight questions in, one ladder rung out.
//
// JEV OWNS THE JUDGEMENTS. THIS FILE OWNS THE DECISION. Jev says how deep the
// reasoning is, how broad the context is and how bad a mistake would be; tm8
// decides what those facts are worth. Weights, floors and the ladder are data,
// so re-deciding on a changed weight re-runs no inference.
//
// The suggestion is ADVICE. It is shown on the launch sheet and changes nothing
// until a person clicks Apply (design 01a0cb80 §4.2).

import type { JevAgentTool, JevFailure, LaunchReasoningEffort, ModelSuggestion, ModelTier } from '@tm8/contract';

import type { JevCallRecord, JevClient } from './client.js';
import { isChoice, isNoul, isScore, topTwoMass, type JevAnswer, type JevQuestionSet } from './wire.js';

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------
//
// Eight questions, one call, evaluated in parallel against one state.
//
// MEASURED 2026-09-22 against the live API (jev-1.13.0). This exact set was run
// twice over 57 real tm8 tasks read out of the graph: 57/57 answered both
// times, zero failures, median 341ms, 103,774 input tokens per pass, $0.0044
// per pass. Run-to-run agreement was 95% on the final model, 96% on the tier
// and 98% on the harness.
//
// WHY EIGHT AND NOT THREE. The marginal cost of a question is its own tokens
// and no extra latency. The three Scores decide the tier; the Nouls are
// independent gates that must not be folded into a score (a Noul at 0.5 means
// "as likely as not", which is not a middling amount of anything); the two
// Choices carry the harness decision and the work-kind label.
//
// Question IDs are never sent to the model, so every question states its own
// full meaning rather than leaning on its key.

export const ROUTING_QUESTIONS: JevQuestionSet = {
  work_kind: {
    type: 'choice',
    instructions:
      'What kind of work does this tm8 task ask an autonomous coding agent to perform?',
    criteria: {
      implement: 'Write or change source code to add or fix behaviour.',
      review:
        "Read someone else's diff or code and report findings; produces judgement, not code.",
      investigate: 'Diagnose a defect or unknown behaviour whose cause is not yet known.',
      coordinate:
        'Orchestrate other agents or sequence other tasks; the work itself is delegation and tracking.',
      operate:
        'Run a deployment, migration, release or other production operation against live infrastructure.',
      design:
        'Produce analysis, a design document, a specification or an artifact; little or no shipped code.',
      unclear: 'The task does not say enough to tell what it is asking for.',
    },
  },

  // --- the three axes that decide the tier ---------------------------------
  reasoning_depth: {
    type: 'score',
    instructions:
      'How much original reasoning must the agent do to finish this task correctly?',
    criteria: [
      'Mechanical: the steps are fully written out; following them is the whole job.',
      'Routine: a known pattern applied to a named place; the agent decides details, not approach.',
      'Analytical: the agent must work out the cause or the approach itself from evidence it gathers.',
      'Novel design: the agent must invent an approach and defend trade-offs nobody has settled yet.',
    ],
  },
  context_breadth: {
    type: 'score',
    instructions:
      'How much of the codebase must the agent read and hold at once to do this task?',
    criteria: [
      'One file or one named diff.',
      'A handful of files inside one package.',
      'Several packages, or a whole subsystem and its tests.',
      'The whole repository, or a long transcript history, held at once.',
    ],
  },
  blast_radius: {
    type: 'score',
    instructions:
      'If the agent gets this task wrong, how bad and how reversible is the consequence?',
    criteria: [
      'Local and reversible: a bad edit in a branch nobody has merged.',
      'Visible but recoverable: a wrong review, a failing CI run, a reverted commit.',
      'Production-affecting: a live deploy, a migration, a credential or auth change.',
      'Irreversible: data loss, a leaked secret, or a published artifact that cannot be withdrawn.',
    ],
  },

  // --- independent gates ----------------------------------------------------
  needs_long_context: {
    type: 'noul',
    instructions:
      'Does this task require holding more than roughly 200,000 tokens of material at once — a very large diff, many packages, or a long prior transcript?',
    criteria: {
      true: 'Explicitly large scope, many files, or a long history to re-read.',
      false: 'The material named fits comfortably in a normal context window.',
    },
  },
  spec_complete: {
    type: 'noul',
    instructions:
      'Is this task specified well enough that an agent could start work without asking a human a clarifying question first?',
    criteria: {
      true: 'Goal, scope and done-condition are all stated or plainly inferable.',
      false: 'Something essential is missing, empty or contradictory.',
    },
  },
  human_named_model: {
    type: 'noul',
    instructions:
      "Does the task text itself name a specific model, tier or agent tool that the requester wants used (for example 'opus', 'sonnet', 'gpt-5', 'codex', '1M')?",
    criteria: {
      true: 'A model, tier or tool is named in the request.',
      false: 'No model or tool is named anywhere in the request.',
    },
  },

  // --- harness fit ----------------------------------------------------------
  // tm8 is harness-plural. This question is what keeps the suggestion from
  // being a Claude-only decision with an OpenAI afterthought.
  harness_fit: {
    type: 'choice',
    instructions:
      'tm8 can launch this work on Claude Code (Anthropic models) or Codex (OpenAI models). Which harness suits this task better, judged only on the nature of the work?',
    criteria: {
      claude_code:
        'Long prose judgement, design writing, review narrative, or work that leans on a large context window.',
      codex:
        'Tightly-scoped mechanical code edits, test-loop iteration, or work where a cheap high-effort reasoning dial is the main need.',
      either: 'Nothing about the work prefers one over the other.',
    },
  },
};

/** What the model group is asked about: the task a person is about to launch. */
export interface ModelSubject {
  title: string;
  description: string;
  priority?: string;
  status?: string;
  acceptanceCriteriaCount?: number;
  parentTitle?: string | null;
}

/**
 * The state Jev sees: named JSON fields, not a concatenated blob, so a question
 * can reference `task.description` and mean it. Only the task record a human
 * wrote — no credential, no prompt.
 */
export function routingState(subject: ModelSubject): Record<string, unknown> {
  return {
    title: subject.title,
    description: subject.description,
    ...(subject.priority ? { priority: subject.priority } : {}),
    ...(subject.status ? { status: subject.status } : {}),
    ...(subject.acceptanceCriteriaCount !== undefined
      ? { acceptance_criteria_count: subject.acceptanceCriteriaCount }
      : {}),
    ...(subject.parentTitle ? { parent_task: subject.parentTitle } : {}),
  };
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export interface TierRung {
  readonly tier: ModelTier;
  /** Anthropic model, run on claude-code. */
  readonly claude: string;
  /** OpenAI counterpart at the same rung, run on codex. */
  readonly codex: string;
  /** Reasoning-effort stop for this rung. */
  readonly effort: LaunchReasoningEffort;
}

/**
 * `frontier` is the 1M-context variant rather than a different family: what
 * separates it from `premium` is a capability (holding the whole thing at
 * once), not more intelligence, which is why only `needs_long_context`
 * promotes into it.
 *
 * Every model here must exist in `LAUNCH_MODEL_CATALOG` with the rung's effort;
 * `test/model.test.ts` holds that, so a ladder typo fails CI rather than a
 * launch. Kimi and the Groq rows are in the catalog but not on the ladder:
 * their keys are account-wide and displace anthropic / openai, which a
 * suggestion cannot see.
 */
export const TIER_LADDER: readonly TierRung[] = [
  { tier: 'economy', claude: 'claude-haiku-4-5-20251001', codex: 'gpt-5.6-luna', effort: 'medium' },
  { tier: 'standard', claude: 'claude-sonnet-5', codex: 'gpt-5.6-terra', effort: 'high' },
  { tier: 'premium', claude: 'claude-opus-5', codex: 'gpt-6-astra', effort: 'high' },
  { tier: 'frontier', claude: 'claude-opus-5[1m]', codex: 'gpt-6-astra', effort: 'max' },
];

const TIER_ORDER: readonly ModelTier[] = ['economy', 'standard', 'premium', 'frontier'];

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

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
  /** harness_fit top-2 mass must exceed this to suggest Codex. */
  readonly harnessConfidence: number;
}

/**
 * Exercised against 57 real tm8 tasks on 2026-09-22 (jev-1.13.0), which is not
 * the same as calibrated: a considered starting point that produced a
 * defensible spread on real work — 2 economy, 31 standard, 22 premium,
 * 2 frontier — not numbers fitted to an outcome.
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
  /** Top-2 mass on harness_fit — the safety signal, not `confidence`. */
  readonly harnessTopTwo: number;
}

/** Pull the eight answers out of a response, or null if any is missing or mis-shaped. */
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
 * The composite, the ladder position it lands on, the floors, and the harness.
 *
 * Three axes rather than one "difficulty" score because they disagree in useful
 * ways: a one-line credential change is shallow, narrow and production-
 * affecting, and only the third fact should keep it off Haiku.
 */
export function decide(signals: RoutingSignals, weights: RoutingWeights = DEFAULT_WEIGHTS): ModelSuggestion {
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

  const rung = TIER_LADDER[idx] ?? TIER_LADDER[1]!;
  let model = rung.claude;
  let agentTool: JevAgentTool = 'claude-code';

  // Harness, gated on top-2 mass rather than argmax confidence. Long-context
  // work stays on Claude Code regardless: the 1M variant is why it was
  // promoted, and Codex has no counterpart for it.
  if (
    signals.harnessFit === 'codex' &&
    signals.harnessTopTwo > weights.harnessConfidence &&
    signals.needsLongContext <= weights.longContextGate
  ) {
    model = rung.codex;
    agentTool = 'codex';
    reasons.push(`harness_fit=codex at top-2 mass ${signals.harnessTopTwo.toFixed(2)} -> ${model} on codex`);
  }

  return {
    tier: rung.tier,
    model,
    agentTool,
    effort: rung.effort,
    need: Number(need.toFixed(3)),
    workKind: signals.workKind,
    reasons,
  };
}

export type AdviseModelResult =
  | { ok: true; verdict: ModelSuggestion; call: JevCallRecord }
  | { ok: false; reason: JevFailure; call: JevCallRecord };

/**
 * Ask the eight questions about one subject and turn the answers into a
 * suggestion. Never throws. A response whose answers do not read as the eight
 * signals fails as `unparsed`, and its call record says so — the tokens were
 * still spent.
 */
export async function adviseModel(
  client: JevClient,
  subject: ModelSubject,
  weights: RoutingWeights = DEFAULT_WEIGHTS,
): Promise<AdviseModelResult> {
  const result = await client.ask(routingState(subject), ROUTING_QUESTIONS);
  if (!result.ok) return result;
  const signals = readSignals(result.response.answers);
  if (!signals) return { ok: false, reason: 'unparsed', call: { ...result.call, outcome: 'unparsed' } };
  return { ok: true, verdict: decide(signals, weights), call: result.call };
}
