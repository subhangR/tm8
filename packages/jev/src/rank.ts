// @tm8/jev — relevance ranking for the launch sheet's memory, skill and
// teammate groups.
//
// Each group picks a few rows out of many, and none of the structural orders
// tm8 used before (recency, nearest ancestor, whatever a dispatcher reasoned
// its way to) knows what the task is about. Jev scores each candidate against
// the task on four concrete levels; the caller decides what to tick.
//
// ONE QUESTION PER CANDIDATE, ONE CALL PER CHUNK. State is ingested once and
// questions run in parallel, so ranking 41 memories is one request with 41
// questions (measured: 1,123 ms, $0.000289). The request context is 64k, so a
// long list is split into chunks, and the chunks run CONCURRENTLY: each re-sends
// the small task state, and waiting for one before sending the next would spend
// the 5 s budget per chunk in series for no gain.

import type { JevFailure, RelevanceLevel } from '@tm8/contract';

import type { JevCallRecord, JevClient } from './client.js';
import { isScore, type JevQuestionSet } from './wire.js';

export interface RankCandidate {
  readonly id: string;
  /** What the ranker judges. Keep it short: every candidate pays its own tokens. */
  readonly text: string;
}

export interface RankedCandidate {
  readonly id: string;
  readonly text: string;
  /** 0..3 on the four levels below. */
  readonly score: number;
  readonly confidence: number;
  readonly level: RelevanceLevel;
}

export type RankResult =
  | { ok: true; ranked: RankedCandidate[]; calls: JevCallRecord[] }
  | { ok: false; reason: JevFailure; calls: JevCallRecord[] };

export const DEFAULT_CHUNK_SIZE = 60;

/**
 * Four concrete levels, lowest first. "Somewhat relevant" would tell the model
 * nothing — a Score level must describe a situation that stands on its own.
 */
export const RELEVANCE_LEVELS: readonly string[] = [
  'Irrelevant: knowing this would not change how the agent approaches the work at all.',
  'Background: mildly related subject matter, but it would not change any decision.',
  'Useful: it would save the agent time or steer a choice it is going to face.',
  'Critical: without this the agent is likely to take a wrong turn it cannot easily undo.',
];

const LEVEL_NAMES: readonly RelevanceLevel[] = ['irrelevant', 'background', 'useful', 'critical'];

/** The nearest of the four levels. Halves round up; anything off the scale clamps to it. */
export function levelOf(score: number): RelevanceLevel {
  if (!Number.isFinite(score)) return 'irrelevant';
  const index = Math.min(3, Math.max(0, Math.round(score)));
  return LEVEL_NAMES[index] ?? 'irrelevant';
}

function relevanceQuestions(candidates: readonly RankCandidate[], noun: string): JevQuestionSet {
  const questions: JevQuestionSet = {};
  candidates.forEach((c, i) => {
    questions[`c${i}`] = {
      type: 'score',
      instructions: `How relevant is the following ${noun} to the work described in \`task\`?\n\n${noun}: ${c.text}`,
      criteria: RELEVANCE_LEVELS,
    };
  });
  return questions;
}

/**
 * Rank candidates by relevance to a task, most relevant first.
 *
 * Every chunk's call record comes back on both branches, so a failed ranking
 * still reports what it cost. One failed chunk fails the ranking: a partial
 * order would rank the answered half above the unanswered half for no reason
 * the user could see.
 */
export async function rankByRelevance(
  client: JevClient,
  input: {
    task: unknown;
    candidates: readonly RankCandidate[];
    /** Used in the question text: 'memory', 'skill', 'teammate'. */
    noun: string;
    chunkSize?: number;
  },
): Promise<RankResult> {
  if (input.candidates.length === 0) return { ok: true, ranked: [], calls: [] };

  const requested = input.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const size = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : DEFAULT_CHUNK_SIZE;
  const chunks: RankCandidate[][] = [];
  for (let i = 0; i < input.candidates.length; i += size) {
    chunks.push(input.candidates.slice(i, i + size));
  }

  const results = await Promise.all(
    chunks.map((group) => client.ask({ task: input.task }, relevanceQuestions(group, input.noun))),
  );
  const calls = results.map((r) => r.call);

  const failed = results.find((r) => !r.ok);
  if (failed && !failed.ok) return { ok: false, reason: failed.reason, calls };

  const ranked: RankedCandidate[] = [];
  results.forEach((result, chunk) => {
    if (!result.ok) return;
    chunks[chunk]?.forEach((c, i) => {
      const answer = result.response.answers[`c${i}`];
      if (!isScore(answer)) return;
      ranked.push({ id: c.id, text: c.text, score: answer.score, confidence: answer.confidence, level: levelOf(answer.score) });
    });
  });
  // Scores are comparable across chunks: every candidate is scored on the same
  // levels against the same state. The sort is stable, so ties keep input order.
  ranked.sort((a, b) => b.score - a.score);
  return { ok: true, ranked, calls };
}
