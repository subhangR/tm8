/**
 * THE seam between the server and Jev (design 01a0cb80 §7.1–7.3).
 *
 * Every piece of server code that needs Jev depends on THIS interface and
 * nothing else. `jev-adapter.ts` is the one file that maps it onto
 * `@tm8/jev`; tests use a fake. That keeps candidates, suggestion rules and
 * persistence — which are tm8's — testable without a key, a network or the
 * client package, and keeps the client package free of graph and database.
 *
 * The shapes mirror `@tm8/jev`'s public API (root task, "Interface
 * contracts"): the port NEVER throws for a Jev-side failure, it reports one of
 * the `JevFailure` reasons, and it returns one `JevCallRecord` for every HTTP
 * call it made — failures included — so each call can be costed.
 */
import type { JevFailure, ModelSuggestion, RelevanceLevel } from '@tm8/contract';

import type { DbClaims } from '../db/types.js';

/** One HTTP call to Jev, as the client measured it. Nothing here is text. */
export interface JevCallRecord {
  /** The concrete version the API echoed, never an alias; null when no response arrived. */
  jevModel: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  outcome: 'ok' | JevFailure;
}

/**
 * What Jev is told about the work (§4.1, model row). The draft, when the UI
 * sent one, has already replaced `title` and `description`.
 */
export interface JevSubject {
  title: string;
  description: string;
  priority?: string;
  status?: string;
  acceptanceCriteriaCount?: number;
  parentTitle?: string;
}

/** One candidate as Jev sees it: an id and at most a few hundred characters of text. */
export interface JevCandidate {
  id: string;
  text: string;
}

export interface JevRankedCandidate {
  id: string;
  /** 0..3 — irrelevant, background, useful, critical. */
  score: number;
  confidence?: number;
  level?: RelevanceLevel;
}

export type JevRankResult =
  | { ok: true; ranked: JevRankedCandidate[]; calls: JevCallRecord[] }
  | { ok: false; reason: JevFailure; calls: JevCallRecord[] };

export type JevModelResult =
  | { ok: true; verdict: ModelSuggestion; call: JevCallRecord }
  | { ok: false; reason: JevFailure; call: JevCallRecord };

export interface JevAdvisorPort {
  /**
   * One relevance score per candidate. The implementation chunks and runs the
   * chunks IN PARALLEL; `calls[i]` is chunk `i`.
   */
  rank(input: { task: JevSubject; candidates: JevCandidate[]; noun: string }): Promise<JevRankResult>;
  /** The routing verdict for the subject — a suggestion only, applied by a click. */
  model(subject: JevSubject): Promise<JevModelResult>;
}

/**
 * The advisor for ONE `launch.suggest` request, chosen from the caller's
 * claims (`advisor.ts`): their own key, else the node's, else null → `no_key`.
 */
export type JevAdvisorResolver = (claims: DbClaims) => Promise<JevAdvisorPort | null>;
