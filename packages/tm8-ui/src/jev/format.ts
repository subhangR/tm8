import type { JevCost, JevFailure, JevSkipReason, RankedEntitySource } from '@tm8/contract';

/** `$0.00004` — five places below a cent, because a Jev call costs fractions of one. */
export function formatUsd(usd: number): string {
  return `$${usd >= 0.01 ? usd.toFixed(4) : usd.toFixed(5)}`;
}

/** `0.4 s` */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** One group's cost: `$0.00004 · 0.4 s` (design §6). */
export function formatGroupCost(cost: JevCost): string {
  return `${formatUsd(cost.usd)} · ${formatSeconds(cost.latencyMs)}`;
}

/** The run's footer: `✦ 7 calls · 1.1 s · $0.00021` (design §6). */
export function formatRunCost(run: JevCost): string {
  return `✦ ${String(run.calls)} ${run.calls === 1 ? 'call' : 'calls'} · ${formatSeconds(run.latencyMs)} · ${formatUsd(run.usd)}`;
}

export const FAILURE_WORDS: Record<JevFailure, string> = {
  no_key: 'no TypeSafe key is saved',
  timeout: 'Jev timed out',
  budget: 'Jev ran out of its time budget',
  rate_limited: 'Jev is rate limited',
  overloaded: 'Jev is overloaded',
  server_error: 'Jev had a server error',
  http_error: 'the request was refused',
  network: 'the network failed',
  unparsed: 'Jev’s answer could not be read',
};

export const SKIP_WORDS: Record<JevSkipReason, string> = {
  no_candidates: 'nothing to rank',
  no_subject_text: 'the subject has no title or description to read',
  no_teammate: 'pick a teammate first',
};

export const SOURCE_WORDS: Record<RankedEntitySource, string> = {
  teammate: 'teammate',
  inherited: 'inherited',
  task: 'task',
  parent: 'parent task',
  space: 'space',
};
