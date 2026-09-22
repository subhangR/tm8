// @tm8/jev — context engineering at SPAWN, not just model routing at dispatch.
//
// THE GAP THIS CLOSES. A tm8 spawn injects a persona's memories and its
// resolved skills into the launch manifest. Today neither is chosen:
//
//   - `member.memories` reaches `composeManifest` WHOLE. Every memory a
//     teammate owns ships on every spawn, whatever the task is about.
//   - `resolveSkills` cuts its tail by HIERARCHY DISTANCE (`maxSkills`
//     nearest-first). Distance up an org chart is not relevance to a task.
//
// Both proxies are structural. Neither has read the task. The result is a
// persona that arrives knowing forty things about subjects it was not asked
// about, and — when the chain is deep — missing the one skill it needed
// because that skill happened to be equipped two levels up.
//
// WHAT JEV DOES HERE. It scores each candidate against the task on one
// four-level relevance scale, in ONE request (state is ingested once and
// questions answer in parallel, so ranking 41 memories is 41 questions, not 41
// calls). Code keeps every other decision: the budget, the floor, the ordering
// and the cut are all here, in pure functions, and are unit-testable without a
// network. Jev supplies the one judgement ordinary code cannot make — "would
// knowing this change how the agent approaches THIS work".
//
// WHY BYTES. §8.1 makes bytes authoritative — `combinedInitialInjection` is
// 32,768 of them and `assertWithinBudget` THROWS rather than truncating,
// because silent truncation is a contract failure. So the cut must happen
// BEFORE composition. That is the whole reason this runs at spawn: after
// composition the only options left are refuse the launch or ship a clipped
// prompt, and both are worse than dropping the least relevant memory on
// purpose and saying so on the manifest.
//
// WHAT IT WILL NOT DO. It never empties a persona. A teammate that arrives
// with no memory and no skill is a bigger and stranger change than a slightly
// over-full prompt, so `floor` keeps the top few whatever they scored — see
// `selectByRelevance`.

import type { JevClient } from './client.js';
import type { JevLogger } from './primitives.js';
import type { TaskFacts } from './questions.js';
import { routingState } from './questions.js';
import { rankByRelevanceDetailed, type RankCandidate, type RankedCandidate, type RankResult } from './rerank.js';
import { failureActivation, type JevActivationResult } from './activation.js';

export type ContextSource = 'persona' | 'task' | 'sheet' | 'jev';

/** One memory or one skill, as the spawn path already holds it. */
export interface ContextCandidate {
  readonly entityId?: string | null;
  readonly entityVersion?: number | null;
  readonly widened?: boolean;
  readonly source?: ContextSource;
  readonly id: string;
  /** What Jev judges, and what is measured against the byte budget. */
  readonly text: string;
  /** Display name for the record. Memories have none; skills do. */
  readonly name?: string;
}

/** What the spawn was about to inject, before Jev saw it. */
export interface ContextIntent {
  readonly memories: readonly ContextCandidate[];
  readonly skills: readonly ContextCandidate[];
  /**
   * Material read out of the GRAPH for this spawn, competing for the same
   * injection budget as the persona's own memories and skills.
   *
   * Today the caller fills this with the bodies of the OTHER tasks in a
   * multi-task assignment (see `contextIntentFor`), which are the largest
   * graph-sourced thing a spawn injects. It is deliberately a plain candidate
   * list rather than a task-shaped one: when a loader later adds linked
   * entities, a parent session's outcome or a thread digest, they join this
   * group and inherit the same ranked selection with no new code here.
   *
   * Absent is read as "none", so every caller predating this field is valid.
   */
  readonly graph?: readonly ContextCandidate[];
  /**
   * How to WORD the relevance question for `graph`, e.g. "other task assigned
   * to this agent". The subject noun is what the score means, so it belongs to
   * whoever assembled the group rather than being guessed here. Defaults to a
   * neutral phrasing.
   */
  readonly graphSubject?: string;
}

export interface ContextBudget {
  /**
   * UTF-8 bytes available to memories and skills TOGETHER. They compete: a
   * persona with many skills should not also carry forty memories. Defaults
   * to half of `combinedInitialInjection`, leaving the other half for the
   * kernel, the task snapshot and the control block.
   */
  readonly bytes?: number;
  /**
   * Score below which a candidate is dropped even when it would have fitted.
   * A memory Jev calls irrelevant is pure cost: it buys no behaviour and is
   * charged on every turn for the life of the session. 0.5 sits below
   * `Background`, so only a clear irrelevance is cut on this rule.
   */
  readonly minScore?: number;
  /**
   * Kept whatever they scored, per group. The guard against a blank persona:
   * if Jev rates everything irrelevant, the likeliest explanation is a thin
   * task description, not a teammate who knows nothing useful.
   */
  readonly floor?: number;
}

export const DEFAULT_CONTEXT_BUDGET: Required<ContextBudget> = {
  bytes: 16_384,
  minScore: 0.5,
  floor: 3,
};

/** One candidate's fate, and why. This is the audit trail, not a debug log. */
export interface ContextDecision {
  readonly entityId: string | null;
  readonly entityVersion: number | null;
  readonly widened: boolean;
  readonly source: ContextSource;
  readonly id: string;
  readonly name: string | null;
  readonly kept: boolean;
  readonly score: number;
  readonly confidence: number;
  readonly rank: number;
  readonly bytes: number;
  /** `relevance` — scored below the floor. `budget` — ranked out by bytes. */
  readonly reason: 'kept' | 'relevance' | 'budget';
}

export interface ContextGroupPlan {
  readonly keptIds: readonly string[];
  readonly decisions: readonly ContextDecision[];
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  /**
   * Candidates Jev rated `Critical` that the BYTE budget cut anyway. Never
   * empty quietly: the point of ranking was to stop losing the row that
   * mattered, so a caller that sees these is expected to say so out loud.
   */
  readonly droppedCritical: readonly string[];
}

/**
 * The durable record of one context-engineering activation, written onto the
 * manifest beside `routing`. Same argument as `RoutingActivation`: a decision
 * nobody can see did not happen.
 */
export interface ContextActivation {
  readonly at: string;
  readonly jevModel: string | null;
  /** Concrete versions across groups/chunks; jevModel is null if mixed or unknown. */
  readonly jevModels: readonly string[];
  readonly latencyMs: number;
  readonly jevInputTokens: number;
  readonly jevCostUsd: number;
  readonly memories: ContextGroupPlan;
  readonly skills: ContextGroupPlan;
  /**
   * Absent — not an empty plan — when the spawn offered no graph candidates,
   * so a reader can tell "nothing was offered" from "everything was cut".
   */
  readonly graph?: ContextGroupPlan;
  readonly bytesSaved: number;
  /** Prompt bytes that no longer reach the agent, as a share of what was offered. */
  readonly pctSaved: number;
  readonly summary: string;
}

export interface ContextPlan {
  readonly activation: ContextActivation;
  /** Null for a group Jev had no opinion on — the caller keeps all of it. */
  readonly keepMemoryIds: readonly string[] | null;
  readonly keepSkillIds: readonly string[] | null;
  /**
   * Which graph candidates survived. Optional so that a caller reading an
   * older plan sees `undefined` and keeps everything — the same meaning `null`
   * has for the other two groups.
   */
  readonly keepGraphIds?: readonly string[] | null;
}

export interface ContextAdvisorPort {
  /**
   * `null` means no opinion, for ANY reason: no task, nothing to select from,
   * Jev down, malformed answers, missing key. Callers keep every candidate,
   * which is today's behaviour exactly.
   */
  plan(task: TaskFacts | null, intent: ContextIntent): Promise<ContextPlan | null>;
  planDetailed?(task: TaskFacts | null, intent: ContextIntent): Promise<JevActivationResult<ContextPlan, ContextActivation>>;
}

/** The default. Wired everywhere, opinionated nowhere. */
export const nullContextAdvisor: ContextAdvisorPort = {
  async plan() {
    return null;
  },
};

// -- the pure half ------------------------------------------------------------

function utf8(text: string): number {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf8');
  return new TextEncoder().encode(text).length;
}

/**
 * Turn a ranking into a selection, given a byte budget.
 *
 * SELECTS, NEVER REORDERS. The caller's own order is meaningful — skills come
 * out of `resolveSkills` nearest-first, and that ordering is a documented
 * property callers rely on for a byte-identical manifest across two spawns of
 * an unchanged graph. Jev decides WHICH rows survive; it does not get to
 * decide what order a persona reads its own skills in. Rank governs the cut,
 * original order governs the output.
 */
export function selectByRelevance(
  candidates: readonly ContextCandidate[],
  ranked: readonly RankedCandidate[],
  budget: Required<ContextBudget>,
): ContextGroupPlan {
  const byId = new Map(ranked.map((r) => [r.id, r]));
  const bytesBefore = candidates.reduce((n, c) => n + utf8(c.text), 0);

  // A candidate Jev did not score (a dropped answer, a chunk that failed) is
  // ranked LAST but never pre-emptively cut — an unparsed answer is our
  // failure, not evidence against the row.
  const ordered = [...candidates].sort((a, b) => {
    const ra = byId.get(a.id)?.rank ?? Number.MAX_SAFE_INTEGER;
    const rb = byId.get(b.id)?.rank ?? Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });

  const keep = new Set<string>();
  const reasons = new Map<string, ContextDecision['reason']>();
  let used = 0;

  ordered.forEach((c, position) => {
    const r = byId.get(c.id);
    const bytes = utf8(c.text);
    const withinFloor = position < budget.floor;
    const scored = r?.score ?? 0;

    if (!withinFloor && r && scored < budget.minScore) {
      reasons.set(c.id, 'relevance');
      return;
    }
    // THE FLOOR EXEMPTS FROM SCORE, NOT FROM BYTES — except for the very first
    // row kept, which is exempt from everything.
    //
    // Measured on a real persona: three SKILL.md files totalling 45,677 bytes
    // with `floor: 3` kept all three, because a floor that bypassed the byte
    // check could not be overspent. That is the floor defeating the budget it
    // shares a function with, and downstream `assertWithinBudget` THROWS rather
    // than truncating — so the trim that was supposed to prevent a failed spawn
    // would have caused one.
    //
    // "Never empty a persona" needs the group to keep SOMETHING, not everything.
    // So one row always survives whatever it costs, and the budget binds from
    // the second row on.
    if (keep.size > 0 && used + bytes > budget.bytes) {
      reasons.set(c.id, 'budget');
      return;
    }
    keep.add(c.id);
    reasons.set(c.id, 'kept');
    used += bytes;
  });

  const decisions: ContextDecision[] = candidates.map((c) => {
    const r = byId.get(c.id);
    return {
      id: c.id,
      entityId: c.entityId ?? null,
      entityVersion: c.entityVersion ?? null,
      widened: c.widened ?? false,
      source: c.source ?? 'persona',
      name: c.name ?? null,
      kept: keep.has(c.id),
      score: r?.score ?? 0,
      confidence: r?.confidence ?? 0,
      rank: r?.rank ?? 0,
      bytes: utf8(c.text),
      reason: reasons.get(c.id) ?? 'kept',
    };
  });

  return {
    keptIds: candidates.filter((c) => keep.has(c.id)).map((c) => c.id),
    decisions,
    bytesBefore,
    bytesAfter: used,
    droppedCritical: decisions
      .filter((d) => !d.kept && d.score >= 2.5)
      .map((d) => d.id),
  };
}

/**
 * Split one shared byte budget across N groups, proportional to demand.
 *
 * Returns a budget per group, positionally. Two properties are load-bearing:
 *
 *  - A group that asks for nothing is HANDED nothing, and does not consume a
 *    share of the guarantee. Otherwise a persona with no skills would donate a
 *    third of the budget to an empty array and starve the groups that are real.
 *  - Every group that does ask is guaranteed `1/(n+1)` of the total before the
 *    remainder is shared by demand, so no group can be starved by another being
 *    enormous. At n = 2 that is exactly the "a third each" this function
 *    guaranteed when it only knew about memories and skills.
 */
export function splitBudgetAcross(
  groups: readonly (readonly ContextCandidate[])[],
  total: number,
): number[] {
  const demand = groups.map((g) => g.reduce((n, c) => n + utf8(c.text), 0));
  if (demand.reduce((a, b) => a + b, 0) <= total) return demand;

  const live = demand.map((d, i) => (d > 0 ? i : -1)).filter((i) => i >= 0);
  const out = demand.map(() => 0);
  if (live.length === 0) return out;
  if (live.length === 1) {
    out[live[0]!] = total;
    return out;
  }

  const floorEach = Math.floor(total / (live.length + 1));
  const rest = total - floorEach * live.length;
  const asked = live.reduce((n, i) => n + demand[i]!, 0);
  let handed = 0;
  live.forEach((i, k) => {
    // The last live group takes the rounding remainder, so the shares always
    // sum to `rest` exactly and no byte is invented or lost.
    const share =
      k === live.length - 1 ? rest - handed : Math.round((rest * demand[i]!) / asked);
    handed += share;
    out[i] = floorEach + share;
  });
  return out;
}

/** The two-group case, unchanged, for callers that have no graph material. */
export function splitBudget(
  memories: readonly ContextCandidate[],
  skills: readonly ContextCandidate[],
  total: number,
): { memories: number; skills: number } {
  const [m = 0, s = 0] = splitBudgetAcross([memories, skills], total);
  return { memories: m, skills: s };
}

// -- the async half -----------------------------------------------------------

export interface JevContextAdvisorOptions {
  client: JevClient;
  budget?: ContextBudget;
  logger?: JevLogger;
  now?: () => Date;
}

/** $42 per billion input tokens; output is free. Same figure `savings.ts` uses. */
const JEV_USD_PER_INPUT_TOKEN = 42 / 1_000_000_000;

export class JevContextAdvisor implements ContextAdvisorPort {
  private readonly client: JevClient;
  private readonly budget: Required<ContextBudget>;
  private readonly logger: JevLogger | undefined;
  private readonly now: () => Date;

  constructor(options: JevContextAdvisorOptions) {
    this.client = options.client;
    this.budget = { ...DEFAULT_CONTEXT_BUDGET, ...options.budget };
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  async plan(task: TaskFacts | null, intent: ContextIntent): Promise<ContextPlan | null> {
    return (await this.planDetailed(task, intent)).value;
  }

  async planDetailed(task: TaskFacts | null, intent: ContextIntent): Promise<JevActivationResult<ContextPlan, ContextActivation>> {
    if (!task || !(task.title || task.description)) return { value: null, activation: null };
    const memories = intent.memories.filter((c) => c.text.trim());
    const skills = intent.skills.filter((c) => c.text.trim());
    const graph = (intent.graph ?? []).filter((c) => c.text.trim());
    if (memories.length === 0 && skills.length === 0 && graph.length === 0) return { value: null, activation: null };

    const state = routingState(task);
    const usage = { caller: 'context' as const, subjectId: task.id, spaceId: task.spaceId };
    // Three subjects, three question sets, but the SAME small state — asking
    // them separately costs one round trip and re-sends a few hundred tokens of
    // task. Asking them together would blur the question wording ("this memory"
    // vs "this skill" vs "this other assigned task"), and the wording is what
    // the score means. They run under one `Promise.all`, so a third group costs
    // no wall-clock beyond the slowest call.
    const graphSubject = intent.graphSubject ?? 'entity read from the work graph';
    const [mRank, sRank, gRank] = await Promise.all([
      memories.length
        ? rankByRelevanceDetailed(this.client, { usage, task: state, candidates: asRank(memories), subject: 'memory' })
        : empty(),
      skills.length
        ? rankByRelevanceDetailed(this.client, { usage, task: state, candidates: asRank(skills), subject: 'skill' })
        : empty(),
      graph.length
        ? rankByRelevanceDetailed(this.client, { usage, task: state, candidates: asRank(graph), subject: graphSubject })
        : empty(),
    ]);
    if (!mRank.ok || !sRank.ok || !gRank.ok) {
      const results = [mRank, sRank, gRank];
      const failed = results.find((result) => !result.ok)!;
      if (!failed.ok) return {
        value: null,
        activation: failureActivation('context', {
          ...failed, latencyMs: Math.max(...results.map((r) => r.latencyMs)),
          inputTokens: results.reduce((n, r) => n + r.inputTokens, 0),
        }, this.now().toISOString()),
      };
      return { value: null, activation: null };
    }

    const [mBytes = 0, sBytes = 0, gBytes = 0] = splitBudgetAcross(
      [memories, skills, graph],
      this.budget.bytes,
    );
    const mPlan = selectByRelevance(memories, mRank.ranked, { ...this.budget, bytes: mBytes });
    const sPlan = selectByRelevance(skills, sRank.ranked, { ...this.budget, bytes: sBytes });
    const gPlan = selectByRelevance(graph, gRank.ranked, { ...this.budget, bytes: gBytes });

    const plans = graph.length ? [mPlan, sPlan, gPlan] : [mPlan, sPlan];
    const bytesSaved = plans.reduce((n, pl) => n + (pl.bytesBefore - pl.bytesAfter), 0);
    const bytesBefore = plans.reduce((n, pl) => n + pl.bytesBefore, 0);
    const jevInputTokens = mRank.inputTokens + sRank.inputTokens + gRank.inputTokens;

    const ranks = [mRank, sRank, gRank].filter((r) => r.ranked.length > 0);
    const models = [...new Set(ranks.flatMap((r) => r.jevModels))];
    const activation: ContextActivation = {
      at: this.now().toISOString(),
      jevModel: models.length === 1 && ranks.every((r) => r.jevModel !== null) ? models[0]! : null,
      jevModels: models,
      latencyMs: Math.max(mRank.latencyMs, sRank.latencyMs, gRank.latencyMs),
      jevInputTokens,
      jevCostUsd: jevInputTokens * JEV_USD_PER_INPUT_TOKEN,
      memories: mPlan,
      skills: sPlan,
      ...(graph.length ? { graph: gPlan } : {}),
      bytesSaved,
      pctSaved: bytesBefore === 0 ? 0 : (bytesSaved / bytesBefore) * 100,
      summary: summarise(plans, bytesSaved, bytesBefore),
    };

    this.logger?.info?.('jev: context plan', {
      taskId: task.id,
      memoriesKept: `${mPlan.keptIds.length}/${memories.length}`,
      skillsKept: `${sPlan.keptIds.length}/${skills.length}`,
      ...(graph.length ? { graphKept: `${gPlan.keptIds.length}/${graph.length}` } : {}),
      bytesSaved,
    });

    return {
      value: {
        activation,
        keepMemoryIds: memories.length ? mPlan.keptIds : null,
        keepSkillIds: skills.length ? sPlan.keptIds : null,
        keepGraphIds: graph.length ? gPlan.keptIds : null,
      },
      activation,
    };
  }
}

function asRank(candidates: readonly ContextCandidate[]): RankCandidate[] {
  // Long bodies are excerpted for the QUESTION only — the kept row ships
  // whole. A relevance judgement does not need the tail of a 9KB skill, and
  // sending it would make ranking cost more than the thing it is saving.
  return candidates.map((c) => ({ id: c.id, text: c.text.slice(0, 1200) }));
}

async function empty(): Promise<RankResult & { ok: true }> {
  return { ok: true, ranked: [], latencyMs: 0, inputTokens: 0, jevModel: null, jevModels: [] };
}

function summarise(
  plans: readonly ContextGroupPlan[],
  bytesSaved: number,
  bytesBefore: number,
): string {
  const labels = ['memories', 'skills', 'graph entities'];
  const parts = plans
    .map((pl, i) => (pl.decisions.length ? `${pl.keptIds.length}/${pl.decisions.length} ${labels[i]}` : null))
    .filter((x): x is string => x !== null);
  const pct = bytesBefore === 0 ? 0 : Math.round((bytesSaved / bytesBefore) * 100);
  const head = `Jev kept ${parts.join(', ')} — ${bytesSaved} prompt bytes saved (${pct}%).`;
  const critical = plans.flatMap((pl) => pl.droppedCritical);
  return critical.length
    ? `${head} WARNING: the byte budget cut ${critical.length} candidate(s) Jev rated critical.`
    : head;
}
