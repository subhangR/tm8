/**
 * The remote_ref watcher (W7b, 274).
 *
 * A `remote_ref` in home space A caches the status of an entity that
 * `spaceLinks.invoke` created (or spawned) in the link's target B, so a
 * `depends_on` edge onto it gates on that cached status. This job refreshes
 * the cache: `public.poll_remote_refs` (node admin only) reads B's
 * workspace_events ONLY for the ids a ref names, ONLY while the ref's link
 * row is signed_in, advances each ref's cursor, and writes a changed status as
 * the system (no bound actor). Everything is in that one SQL call; this job
 * is its clock.
 *
 * It holds no link token and presents none: the SQL reads B's event log in
 * place (same server). A cross-server link is W8's.
 */

import type { Db, DbClaims } from '../../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const REMOTE_REF_WATCHER_JOB_NAME = 'spaceLinks.remote-ref-watcher';

export interface RemoteRefWatcherOptions {
  db: Pick<Db, 'rpc'>;
  /** Node-owner claims — the poll door is node-admin only. */
  claims: () => Promise<DbClaims>;
  /** Refs per tick (SQL clamps to 1..1000). */
  batchSize?: number;
  intervalMs?: number;
  runOnStart?: boolean;
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runRemoteRefWatcherTick(options: RemoteRefWatcherOptions): Promise<JobOutcome> {
  const claims = await options.claims();
  const result = await options.db.rpc<{ polled?: number; changed?: number }>(
    claims, 'poll_remote_refs', [options.batchSize ?? 200],
  );
  const polled = Number(result?.polled ?? 0);
  const changed = Number(result?.changed ?? 0);
  if (polled === 0) return { skipped: true, reason: 'no remote_ref on a signed-in link' };
  return { affected: changed, detail: { polled, changed } };
}

export function createRemoteRefWatcherJob(options: RemoteRefWatcherOptions): ScheduledJob {
  return {
    name: REMOTE_REF_WATCHER_JOB_NAME,
    // A gate opening a few seconds after B completes the task is the product
    // bar; half a minute keeps the event scan off the hot path.
    intervalMs: options.intervalMs ?? 30_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 60_000,
    async run(_ctx: JobContext): Promise<JobOutcome> {
      return runRemoteRefWatcherTick(options);
    },
  };
}
