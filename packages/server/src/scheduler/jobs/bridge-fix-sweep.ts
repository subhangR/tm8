/**
 * The Bridges F fix-notice sweep (migration 412, BRIDGE-ENTITY-DESIGN D70 and
 * D72). Fix notices are event-driven: a merge, a tracks edge, a status move or
 * a settled answer posts them in the commit that caused it. This job only
 * closes the two waits that need a clock: a no-PR report whose 10-minute
 * close-out window ended with no close-out, and a refused notice still
 * retrying (it gives up with an fyi after 5 attempts or 30 minutes).
 */

import type { Db } from '../../db/types.js';
import { bridgesWorkerClaims } from '../../bridges/outbox.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const BRIDGE_FIX_SWEEP_JOB_NAME = 'sweep.bridge-fix-notices';

export interface BridgeFixSweepOptions {
  db: Pick<Db, 'rpc'>;
  intervalMs?: number;
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runBridgeFixSweepTick(options: BridgeFixSweepOptions): Promise<JobOutcome> {
  const r = await options.db.rpc<{ closeouts?: number; retries?: number }>(
    bridgesWorkerClaims('bridge-fix-sweep'), 'internal.bridge_fix_sweep', []);
  const affected = Number(r?.closeouts ?? 0) + Number(r?.retries ?? 0);
  if (affected === 0) return { skipped: true, reason: 'no fix notice waiting' };
  return { affected };
}

export function createBridgeFixSweepJob(options: BridgeFixSweepOptions): ScheduledJob {
  return {
    name: BRIDGE_FIX_SWEEP_JOB_NAME,
    intervalMs: options.intervalMs ?? 2 * 60_000,
    jitterRatio: 0.1,
    runOnStart: true,
    timeoutMs: 60_000,
    async run(_ctx: JobContext): Promise<JobOutcome> {
      return runBridgeFixSweepTick(options);
    },
  };
}
