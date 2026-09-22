// @tm8/jev — Jev as tm8's decisioning layer.
//
// Jev decides WHICH model runs; it is never the model that runs. It generates
// no text and cannot be a coding agent, so nothing in this package replaces an
// agent — it chooses one, and gets out of the way.
//
// Wiring is opt-in and fail-open at every level: no key, no advisor, no
// opinion, no change. See `nullRoutingAdvisor`.

export * from './primitives.js';
export * from './client.js';
export * from './questions.js';
export * from './tiers.js';
export * from './policy.js';
export * from './savings.js';
export * from './advisor.js';
export * from './rerank.js';
export * from './context.js';
export * from './roster.js';
export * from './from-env.js';
export * from './ledger.js';

export * from './usage.js';
export * from './activation.js';
export * from './context-intent.js';
