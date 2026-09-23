// @tm8/jev — a pure client for Jev, the TypeSafe decisioning model.
//
// Four things, nothing else: a bounded HTTP call (`createJevClient`), relevance
// ranking (`rankByRelevance`), a model suggestion from the eight routing
// answers (`adviseModel`), and the price of a call (`costOf`). No database, no
// graph, no filesystem, no environment policy, no logging. Jev runs only when a
// person presses Ask Jev on the launch sheet, and what it says takes effect
// only through an Apply click (design 01a0cb80 §7.2).
//
// This list is the root task's frozen public API; `test/surface.test.ts` holds
// it exactly.

export {
  createJevClient,
  jevClientFromEnv,
  type JevAskResult,
  type JevCallRecord,
  type JevClient,
  type JevClientOptions,
} from './client.js';
export { rankByRelevance, levelOf, type RankCandidate, type RankedCandidate, type RankResult } from './rank.js';
export {
  adviseModel,
  ROUTING_QUESTIONS,
  readSignals,
  decide,
  TIER_LADDER,
  DEFAULT_WEIGHTS,
  type AdviseModelResult,
  type ModelSubject,
  type RoutingSignals,
  type RoutingWeights,
  type TierRung,
} from './model.js';
export { costOf, JEV_INPUT_USD_PER_TOKEN } from './cost.js';
export type { JevAnswer, JevQuestion, JevQuestionSet, JevResponse, JevUsage } from './wire.js';
