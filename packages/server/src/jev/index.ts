/**
 * The server's Jev module (design 01a0cb80 §7.3). Everything here depends on
 * `JevAdvisorPort`; only `jev-adapter.ts` imports `@tm8/jev`.
 */
export { registerJevHandlers, type JevHandlerOptions } from './handlers.js';
export type {
  JevAdvisorPort,
  JevCallRecord,
  JevCandidate,
  JevModelResult,
  JevRankedCandidate,
  JevRankResult,
  JevSubject,
} from './port.js';
export { CANDIDATE_LIMIT, TEXT_LIMIT } from './candidates.js';
export { costOf, levelOf, runGroup } from './groups.js';
export { insertCalls, linkSession, runTotals, upsertRun } from './store.js';
