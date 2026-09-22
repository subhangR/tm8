// @tm8/jev — relevance ranking for the three Tier-1 selection surfaces:
// memory, skill and team_member.
//
// WHY THIS IS THE SAME PROBLEM THREE TIMES. Each of them picks a few rows out
// of many to spend a fixed budget on, and each currently picks by a structural
// proxy rather than by relevance: memories come in by recency, skills by
// nearest-ancestor-wins, teammates by whatever the dispatcher reasons its way
// to. None of those proxies knows what the task is about.
//
// WHY ONE CALL AND NOT N. State is ingested once and questions run in parallel,
// so ranking 41 memories is ONE request with 41 questions, not 41 requests.
// Measured: 41 real tm8 memories ranked in 1,123ms for $0.000289.
//
// The budget itself stays code's job. Jev orders the candidates; tm8 decides how
// many fit — `combinedInitialInjection` is 32,768 bytes and throws rather than
// truncating, so the cut has to be made before composition, not after.

import type { JevQuestionSet } from './primitives.js';
import { isScore } from './primitives.js';
import type { JevClient, JevCallFailure } from './client.js';
import type { JevUsageContext } from './usage.js';

export interface RankCandidate {
  readonly id: string;
  /** What the ranker judges. Keep it short: every candidate pays its own tokens. */
  readonly text: string;
  /** Carried through untouched so a caller can map back to its own row. */
  readonly meta?: Record<string, unknown>;
}

export interface RankedCandidate extends RankCandidate {
  readonly score: number;
  readonly confidence: number;
  readonly rank: number;
}

export interface RankResult {
  readonly ranked: readonly RankedCandidate[];
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly jevModel: string | null;
  readonly jevModels: readonly string[];
}

/**
 * Four concrete levels. "Somewhat relevant" would tell the model nothing — the
 * docs are explicit that a Score level must describe a situation that stands on
 * its own, and these are written so a human could apply them unaided.
 */
const RELEVANCE_LEVELS: readonly string[] = [
  'Irrelevant: knowing this would not change how the agent approaches the work at all.',
  'Background: mildly related subject matter, but it would not change any decision.',
  'Useful: it would save the agent time or steer a choice it is going to face.',
  'Critical: without this the agent is likely to take a wrong turn it cannot easily undo.',
];

function relevanceQuestions(
  candidates: readonly RankCandidate[],
  subject: string,
): JevQuestionSet {
  const questions: JevQuestionSet = {};
  candidates.forEach((c, i) => {
    questions[`c${i}`] = {
      type: 'score',
      instructions: `How relevant is the following ${subject} to the work described in \`task\`?\n\n${subject}: ${c.text}`,
      criteria: RELEVANCE_LEVELS,
    };
  });
  return questions;
}

/**
 * Rank candidates by relevance to a task. Returns null on any failure — the
 * caller then keeps whatever order it already had, which is today's behaviour.
 *
 * `chunk` exists because the request context is 64k: a very long candidate list
 * is split, and each chunk re-sends the (small) task state. Ordering across
 * chunks is by score, which is comparable because every candidate is scored
 * against the same levels and the same state.
 */
export interface RankInput {
  task: Record<string, unknown>;
  candidates: readonly RankCandidate[];
  subject: string;
  chunk?: number;
  usage?: JevUsageContext;
}

export async function rankByRelevance(client: JevClient, input: RankInput): Promise<RankResult | null> {
  const result = await rankByRelevanceDetailed(client, input);
  return result.ok ? result : null;
}

export async function rankByRelevanceDetailed(
  client: JevClient, input: RankInput,
): Promise<(RankResult & { ok: true }) | JevCallFailure> {
  const chunkSize = Math.max(1, Math.floor(input.chunk ?? 60));
  const out: RankedCandidate[] = [];
  let latency = 0;
  let tokens = 0;
  const models = new Set<string>();
  let unknownModel = false;
  for (let i = 0; i < input.candidates.length; i += chunkSize) {
    const group = input.candidates.slice(i, i + chunkSize);
    const call = await client.askDetailed({ task: input.task }, relevanceQuestions(group, input.subject), {
      usage: input.usage,
    });
    latency += call.latencyMs;
    if (!call.ok) return { ...call, latencyMs: latency, inputTokens: tokens + call.inputTokens };
    tokens += call.response.usage?.input_tokens ?? 0;
    if (call.jevModel) models.add(call.jevModel);
    else unknownModel = true;
    group.forEach((c, j) => {
      const answer = call.response.answers[`c${j}`];
      if (isScore(answer)) out.push({ ...c, score: answer.score, confidence: answer.confidence, rank: 0 });
    });
  }
  out.sort((a, b) => b.score - a.score);
  return {
    ok: true, ranked: out.map((c, i) => ({ ...c, rank: i + 1 })),
    latencyMs: latency, inputTokens: tokens, jevModels: [...models],
    jevModel: !unknownModel && models.size === 1 ? [...models][0]! : null,
  };
}

/**
 * Take the top N, but never silently drop a candidate that scored as `Critical`.
 *
 * A budget that cuts a critical memory is worse than a budget slightly
 * exceeded: the whole point of ranking was to stop losing the row that mattered.
 * The caller gets both lists and decides.
 */
export function applyBudget(
  ranked: readonly RankedCandidate[],
  limit: number,
  criticalAt = 2.5,
): { readonly keep: readonly RankedCandidate[]; readonly droppedCritical: readonly RankedCandidate[] } {
  const keep = ranked.slice(0, Math.max(0, limit));
  const droppedCritical = ranked.slice(Math.max(0, limit)).filter((c) => c.score >= criticalAt);
  return { keep, droppedCritical };
}
