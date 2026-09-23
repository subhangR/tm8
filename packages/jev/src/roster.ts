// @tm8/jev — choosing WHO does the work.
//
// tm8 already has this job written down. `DISPATCHER_IDENTITY_INSTRUCTION`
// tells a resident agent to "read the teammate roster and the memory graph,
// choose the best-fit EXISTING teammate ... then spawn that teammate", and to
// post on the task why it picked them over the rest of the roster. That is a
// whole coding-model session — context window, tool calls, latency and spend —
// spent producing one identifier and a sentence.
//
// WHY A RANKING AND NOT A SINGLE CHOICE. A Choice returns the best teammate; it
// does not return the second best. tm8 caps concurrent sessions and teammates
// are frequently busy, so "the best one" is a fact the dispatcher often cannot
// use. An ordering survives contact with a busy roster: code walks it until it
// finds someone free, and the reason each was passed over is still on the
// record. The docs make the same point from the other side — comparable
// per-item Scores are the primitive for graded ranking.
//
// WHAT CODE KEEPS. Availability, concurrency caps, permissions, and the final
// spawn. Jev never learns who is busy and never picks; it says who FITS.

import type { JevClient } from './client.js';
import type { JevLogger } from './primitives.js';
import type { TaskFacts } from './questions.js';
import { routingState } from './questions.js';
import { rankByRelevance, type RankCandidate } from './rerank.js';

/** One teammate, as the roster already describes them. */
export interface TeammateCandidate {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  /** The persona text. Trimmed for the question; the row is never changed. */
  readonly identity?: string;
  /** Skills the roster shows them equipped with, for fit rather than for loading. */
  readonly skills?: readonly string[];
  /** Code's business, not Jev's — carried through so a caller can filter on it. */
  readonly available?: boolean;
}

export interface TeammateFit {
  readonly id: string;
  readonly name: string;
  readonly score: number;
  readonly confidence: number;
  readonly rank: number;
  readonly available: boolean;
}

export interface RosterVerdict {
  /** Best FIT that is also available, or null when nobody free fits. */
  readonly pick: TeammateFit | null;
  /** Best fit overall, available or not. Equal to `pick` on a free roster. */
  readonly best: TeammateFit | null;
  /** Every candidate, best first. The "why not them" record. */
  readonly ranked: readonly TeammateFit[];
  readonly latencyMs: number;
  readonly jevInputTokens: number;
  readonly jevCostUsd: number;
  /**
   * True when no candidate scored above {@link NO_FIT_BELOW}. The dispatcher
   * instruction already has the right answer for this case — "If no teammate
   * fits, say so on the thread rather than inventing one" — and a router that
   * cannot say "nobody" will always name somebody.
   */
  readonly noFit: boolean;
  readonly summary: string;
}

/**
 * Below this, the best candidate is a bad match rather than a narrow win.
 * 1.0 is the boundary between the `Background` and `Useful` levels: a teammate
 * whose fit is merely background-related is not a teammate for this task.
 */
export const NO_FIT_BELOW = 1.0;

const JEV_USD_PER_INPUT_TOKEN = 42 / 1_000_000_000;

export interface RosterAdvisorPort {
  /** `null` = no opinion. The caller dispatches exactly as it does today. */
  choose(task: TaskFacts | null, roster: readonly TeammateCandidate[]): Promise<RosterVerdict | null>;
}

export const nullRosterAdvisor: RosterAdvisorPort = {
  async choose() {
    return null;
  },
};

/** What Jev is shown about one teammate. Roles and skills first: they are the
 *  part that answers "would this person be handed this work". */
export function describeTeammate(t: TeammateCandidate): string {
  const parts = [`${t.name} — ${t.role}`];
  if (t.skills?.length) parts.push(`Equipped with: ${t.skills.join(', ')}.`);
  if (t.identity) parts.push(t.identity.slice(0, 600));
  return parts.join(' ');
}

/**
 * Turn a ranking into a dispatch decision. Pure, and separated from the call
 * so the availability rule — the part that is tm8's policy, not Jev's
 * judgement — is testable without a network.
 */
export function pickFrom(ranked: readonly TeammateFit[]): {
  pick: TeammateFit | null;
  best: TeammateFit | null;
  noFit: boolean;
} {
  const best = ranked[0] ?? null;
  const noFit = !best || best.score < NO_FIT_BELOW;
  if (noFit) return { pick: null, best, noFit: true };
  // Walk down to the first FREE teammate who still clears the bar. A busy best
  // fit must not silently promote someone Jev rated as a bad match.
  const pick = ranked.find((t) => t.available && t.score >= NO_FIT_BELOW) ?? null;
  return { pick, best, noFit: false };
}

export interface JevRosterAdvisorOptions {
  client: JevClient;
  logger?: JevLogger;
}

export class JevRosterAdvisor implements RosterAdvisorPort {
  private readonly client: JevClient;
  private readonly logger: JevLogger | undefined;

  constructor(options: JevRosterAdvisorOptions) {
    this.client = options.client;
    this.logger = options.logger;
  }

  async choose(
    task: TaskFacts | null,
    roster: readonly TeammateCandidate[],
  ): Promise<RosterVerdict | null> {
    if (!task || !(task.title || task.description)) return null;
    if (roster.length === 0) return null;

    const candidates: RankCandidate[] = roster.map((t) => ({ id: t.id, text: describeTeammate(t) }));
    const result = await rankByRelevance(this.client, {
      task: routingState(task),
      candidates,
      subject: 'teammate',
    });
    if (!result) {
      this.logger?.warn?.('jev: roster ranking failed; dispatching unchanged', { taskId: task.id });
      return null;
    }

    const byId = new Map(roster.map((t) => [t.id, t]));
    const ranked: TeammateFit[] = result.ranked.map((r) => ({
      id: r.id,
      name: byId.get(r.id)?.name ?? r.id,
      score: r.score,
      confidence: r.confidence,
      rank: r.rank,
      // Absent means available: a roster that does not track busy-ness is a
      // roster where everyone can be asked.
      available: byId.get(r.id)?.available !== false,
    }));

    const { pick, best, noFit } = pickFrom(ranked);
    const jevCostUsd = result.inputTokens * JEV_USD_PER_INPUT_TOKEN;

    this.logger?.info?.('jev: roster verdict', {
      taskId: task.id,
      pick: pick?.name ?? null,
      candidates: ranked.length,
      latencyMs: result.latencyMs,
    });

    return {
      pick,
      best,
      ranked,
      latencyMs: result.latencyMs,
      jevInputTokens: result.inputTokens,
      jevCostUsd,
      noFit,
      summary: summarise(pick, best, ranked, noFit),
    };
  }
}

function summarise(
  pick: TeammateFit | null,
  best: TeammateFit | null,
  ranked: readonly TeammateFit[],
  noFit: boolean,
): string {
  if (noFit) {
    const top = best ? `${best.name} scored ${best.score.toFixed(2)}` : 'the roster is empty';
    return `Jev found no teammate who fits this task (${top}; the bar is ${NO_FIT_BELOW.toFixed(2)}). Say so rather than inventing one.`;
  }
  if (!pick) {
    return `Jev's best fit is ${best?.name} (${best?.score.toFixed(2)}) but nobody who fits is free. Queue it rather than dispatching a worse match.`;
  }
  const runnerUp = ranked.find((t) => t.id !== pick.id);
  const over = runnerUp ? ` over ${runnerUp.name} (${runnerUp.score.toFixed(2)})` : '';
  const queued = best && best.id !== pick.id ? `, with ${best.name} the better fit but busy` : '';
  return `Jev picked ${pick.name} (fit ${pick.score.toFixed(2)})${over}${queued}.`;
}
