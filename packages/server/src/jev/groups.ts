/**
 * One group, one job (design 01a0cb80 §4.2): ask Jev, then apply tm8's
 * suggestion rules to what it said.
 *
 * The RULES are tm8 code, not Jev's: Jev scores, tm8 decides what is
 * pre-ticked. `runGroup` never throws — a port failure becomes
 * `failed(reason)`, no candidates become `skipped: no_candidates`, and every
 * outcome carries the cost of the calls it made, failures included, plus the
 * call records themselves for `jev_calls`.
 */
import type {
  EntitySuggestion,
  JevCost,
  JevFailure,
  JevGroupResult,
  LaunchSuggestGroup,
  ModelSuggestion,
  RankedEntity,
  RelevanceLevel,
  TeammateSuggestion,
} from '@tm8/contract';

import type { CandidateSet } from './candidates.js';
import type { JevAdvisorPort, JevCallRecord, JevRankedCandidate, JevSubject } from './port.js';

/** A teammate scoring at least this "fits" (§4.2). Below it for everyone: `noFit`. */
export const TEAMMATE_FIT_SCORE = 1.0;
/** Useful: a memory or skill at or above this is pre-ticked. */
export const TICK_SCORE = 1.5;
/** Critical: always ticked — it outranks every merely useful row for the 32 slots. */
export const CRITICAL_SCORE = 2.5;
/** The spawn schema's `selection.memoryIds` bound. */
export const MEMORY_TICK_LIMIT = 32;

const LEVELS: readonly RelevanceLevel[] = ['irrelevant', 'background', 'useful', 'critical'];

/** The score rounded to the nearest of the four levels. */
export function levelOf(score: number): RelevanceLevel {
  return LEVELS[Math.min(3, Math.max(0, Math.round(score)))]!;
}

export const ZERO_COST: JevCost = Object.freeze({ calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, latencyMs: 0 });

/**
 * What a group's calls cost. `latencyMs` is the LONGEST call, not the sum:
 * a group's chunks run in parallel, so the slowest one is how long the group
 * took.
 */
export function costOf(calls: readonly JevCallRecord[]): JevCost {
  return {
    calls: calls.length,
    inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
    usd: calls.reduce((sum, call) => sum + call.costUsd, 0),
    latencyMs: calls.reduce((max, call) => Math.max(max, call.latencyMs), 0),
  };
}

export interface GroupRun<T> {
  result: JevGroupResult<T>;
  /** Every HTTP call the group made, in chunk order. Persisted one row each. */
  calls: JevCallRecord[];
}

const failed = <T>(reason: JevFailure, calls: JevCallRecord[]): GroupRun<T> =>
  ({ result: { status: 'failed', reason, cost: costOf(calls) }, calls });

/**
 * A port that THROWS broke its own contract (it reports failures, it does not
 * raise them). The group still answers — as a transport failure, with no call
 * recorded because none can be proven to have happened.
 */
const THROWN: JevFailure = 'network';

const clampScore = (score: number): number => (Number.isFinite(score) ? Math.min(3, Math.max(0, score)) : 0);

/**
 * Jev's scores joined back onto the candidates, best first. A candidate Jev
 * returned no score for stays in the list at 0 — the person can still tick it —
 * and an id Jev invented is dropped.
 */
function rankItems(candidates: CandidateSet, ranked: readonly JevRankedCandidate[]): RankedEntity[] {
  const scores = new Map(ranked.map((row) => [row.id, clampScore(row.score)]));
  return candidates.items
    .map((candidate): RankedEntity => {
      const score = scores.get(candidate.entityId) ?? 0;
      return {
        entityId: candidate.entityId,
        kind: candidate.kind,
        title: candidate.title,
        sources: [...candidate.sources],
        score,
        level: levelOf(score),
        suggested: false,
      };
    })
    // Stable: equal scores keep candidate order (direct sources first).
    .sort((a, b) => b.score - a.score);
}

/** §4.2 teammates: ranked by score; every row at or above 1.0 fits; nobody does → `noFit`. */
export function suggestTeammates(items: RankedEntity[]): TeammateSuggestion {
  const marked = items.map((item) => ({ ...item, suggested: item.score >= TEAMMATE_FIT_SCORE }));
  return { items: marked, noFit: !marked.some((item) => item.suggested) };
}

/**
 * §4.2 memories: ticked at useful (≥ 1.5), critical (≥ 2.5) always ticked, at
 * most 32 — `items` is sorted best first, so the rows beyond the 32nd tick are
 * the lowest-scored and are the ones left unticked. Critical rows outrank every
 * useful row, so they take the 32 slots first.
 */
export function suggestMemories(items: RankedEntity[]): RankedEntity[] {
  let ticked = 0;
  return items.map((item) => {
    // Critical (≥ CRITICAL_SCORE) is above TICK_SCORE, so it is always wanted.
    const suggested = item.score >= TICK_SCORE && ticked < MEMORY_TICK_LIMIT;
    if (suggested) ticked += 1;
    return { ...item, suggested };
  });
}

/** §4.2 skills: ticked at useful (≥ 1.5). Spawn's 32 KiB index budget still decides at launch. */
export function suggestSkills(items: RankedEntity[]): RankedEntity[] {
  return items.map((item) => ({ ...item, suggested: item.score >= TICK_SCORE }));
}

export function runGroup(port: JevAdvisorPort | null, group: 'model', candidates: null, subject: JevSubject): Promise<GroupRun<ModelSuggestion>>;
export function runGroup(port: JevAdvisorPort | null, group: 'teammates', candidates: CandidateSet, subject: JevSubject): Promise<GroupRun<TeammateSuggestion>>;
export function runGroup(port: JevAdvisorPort | null, group: 'memories' | 'skills', candidates: CandidateSet, subject: JevSubject): Promise<GroupRun<EntitySuggestion>>;
export async function runGroup(
  port: JevAdvisorPort | null,
  group: LaunchSuggestGroup,
  candidates: CandidateSet | null,
  subject: JevSubject,
): Promise<GroupRun<ModelSuggestion | TeammateSuggestion | EntitySuggestion>> {
  if (!port) return failed('no_key', []);

  if (group === 'model') {
    try {
      const answer = await port.model(subject);
      if (!answer.ok) return failed(answer.reason, [answer.call]);
      return { result: { status: 'ok', value: answer.verdict, cost: costOf([answer.call]) }, calls: [answer.call] };
    } catch {
      return failed(THROWN, []);
    }
  }

  const set = candidates ?? { items: [], considered: 0, total: 0 };
  if (set.items.length === 0) {
    return { result: { status: 'skipped', reason: 'no_candidates', cost: { ...ZERO_COST } }, calls: [] };
  }
  const noun = group === 'teammates' ? 'teammate' : group === 'memories' ? 'memory' : 'skill';
  let answer;
  try {
    answer = await port.rank({
      task: subject,
      candidates: set.items.map((item) => ({ id: item.entityId, text: item.text })),
      noun,
    });
  } catch {
    return failed(THROWN, []);
  }
  if (!answer.ok) return failed(answer.reason, answer.calls);
  const cost = costOf(answer.calls);
  const items = rankItems(set, answer.ranked);
  if (group === 'teammates') {
    return { result: { status: 'ok', value: suggestTeammates(items), cost }, calls: answer.calls };
  }
  const value: EntitySuggestion = {
    items: group === 'memories' ? suggestMemories(items) : suggestSkills(items),
    considered: set.considered,
    total: set.total,
  };
  return { result: { status: 'ok', value, cost }, calls: answer.calls };
}
