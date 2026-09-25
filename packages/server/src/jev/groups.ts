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

/**
 * Critical: considered first, and a critical MEMORY is always ticked — spawn
 * never collapses one (design 01a0d348 §10 Q1), so it is in the prompt
 * whatever the budget says. Every other row fills its group's byte budget in
 * rank order (§10 Q5), past a per-group score floor
 * (`CONTEXT_FLOOR_DEFAULTS`, a profile's `contextFloors`).
 */
export const CRITICAL_SCORE = 2.5;

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
 * Jev's scores joined back onto the candidates, best first — a default before
 * a non-default on a tie, then candidate order. A candidate Jev returned no
 * score for stays in the list at 0 (the person can still tick it), and an id
 * Jev invented is dropped.
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
        default: candidate.default,
        promptBytes: candidate.promptBytes,
        header: candidate.header,
      };
    })
    // Stable: equal scores and equal default-ness keep candidate order (direct sources first).
    .sort((a, b) => b.score - a.score || Number(b.default) - Number(a.default));
}

/** A group's fill rule: its byte budget (null: none of its own) and its score floor. */
export interface FillRule {
  budget: number | null;
  floor: number;
  /**
   * The bytes a group of `count` entries costs beside them: an index group's
   * frame (`contextGroupFrameBytes`), which spawn's trim charges against the
   * same budget. Absent: nothing (memories are entries in `<memory>`).
   */
  frameBytes?: (count: number) => number;
  /** Critical rows are ticked whatever the budget (memories: spawn never collapses them). */
  criticalAlwaysFits?: boolean;
}

/**
 * The budget fill (design 01a0d348 §10 Q5.2). `items` is in rank order, so
 * critical rows come first. A row under the floor is never ticked; above it,
 * a row is ticked while the group's bytes (frame included) stay within the
 * budget, and one that does not fit is skipped while smaller, lower-ranked
 * rows still may — a greedy fill in rank order. Every unticked row says why.
 */
export function fillByBudget(items: readonly RankedEntity[], rule: FillRule): RankedEntity[] {
  let used = 0;
  let count = 0;
  const frame = rule.frameBytes ?? (() => 0);
  return items.map((item): RankedEntity => {
    const { reason: _stale, ...row } = item;
    if (item.score < rule.floor) return { ...row, suggested: false, reason: 'below-floor' };
    const forced = rule.criticalAlwaysFits === true && item.score >= CRITICAL_SCORE;
    if (rule.budget !== null && !forced && frame(count + 1) + used + item.promptBytes > rule.budget) {
      return { ...row, suggested: false, reason: 'over-budget' };
    }
    used += item.promptBytes;
    count += 1;
    return { ...row, suggested: true };
  });
}

/** Bytes a ticked set takes: its entries and, for an index group, its frame. */
export function filledBytes(items: readonly RankedEntity[], rule: Pick<FillRule, 'frameBytes'>): number {
  const ticked = items.filter((item) => item.suggested);
  if (ticked.length === 0) return 0;
  return ticked.reduce((sum, item) => sum + item.promptBytes, 0) + (rule.frameBytes ?? (() => 0))(ticked.length);
}

/** §4.2 teammates: ranked by score; every row at or above the floor fits; nobody does → `noFit`. */
export function suggestTeammates(items: RankedEntity[], floor: number): TeammateSuggestion {
  const marked = items.map((item): RankedEntity => {
    const { reason: _stale, ...row } = item;
    return item.score >= floor ? { ...row, suggested: true } : { ...row, suggested: false, reason: 'below-floor' };
  });
  return { items: marked, noFit: !marked.some((item) => item.suggested), floor };
}

/** What each group Jev ranks is called in the question it is asked. */
const NOUN: Record<Exclude<LaunchSuggestGroup, 'model'>, string> = {
  teammates: 'teammate',
  memories: 'memory',
  skills: 'skill',
  references: 'reference',
};

const NO_RULE: FillRule = { budget: null, floor: 0 };

export function runGroup(port: JevAdvisorPort | null, group: 'model', candidates: null, subject: JevSubject): Promise<GroupRun<ModelSuggestion>>;
export function runGroup(port: JevAdvisorPort | null, group: 'teammates', candidates: CandidateSet, subject: JevSubject, rule: FillRule): Promise<GroupRun<TeammateSuggestion>>;
export function runGroup(port: JevAdvisorPort | null, group: 'memories' | 'skills' | 'references', candidates: CandidateSet, subject: JevSubject, rule: FillRule): Promise<GroupRun<EntitySuggestion>>;
export async function runGroup(
  port: JevAdvisorPort | null,
  group: LaunchSuggestGroup,
  candidates: CandidateSet | null,
  subject: JevSubject,
  rule: FillRule = NO_RULE,
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
  const noun = NOUN[group];
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
    return { result: { status: 'ok', value: suggestTeammates(items, rule.floor), cost }, calls: answer.calls };
  }
  const value: EntitySuggestion = {
    items: fillByBudget(items, rule),
    considered: set.considered,
    total: set.total,
    budget: rule.budget,
    floor: rule.floor,
  };
  return { result: { status: 'ok', value, cost }, calls: answer.calls };
}
