/**
 * Bridges D63 (migration 403): `/remember` proposals nobody accepted or
 * dropped expire 14 days after they were proposed, and their inbox items are
 * cleared. The decision door already refuses an expired proposal; this job
 * makes the status and the inbox say so. Runs `public.expire_bridge_memory_proposals`
 * as the node admin.
 */

import type { Db, DbClaims } from '../../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const BRIDGE_MEMORY_PROPOSAL_EXPIRY_JOB_NAME = 'sweep.bridge-memory-proposals';

export interface BridgeMemoryProposalExpiryOptions {
  db: Pick<Db, 'rpc'>;
  /** Node-owner claims — the expiry door is node-admin only. */
  claims: () => Promise<DbClaims>;
  intervalMs?: number;
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runBridgeMemoryProposalExpiryTick(options: BridgeMemoryProposalExpiryOptions): Promise<JobOutcome> {
  const expired = Number(await options.db.rpc<number | string>(await options.claims(), 'public.expire_bridge_memory_proposals', [500]));
  if (expired === 0) return { skipped: true, reason: 'no memory proposal past its 14 days' };
  return { affected: expired };
}

export function createBridgeMemoryProposalExpiryJob(options: BridgeMemoryProposalExpiryOptions): ScheduledJob {
  return {
    name: BRIDGE_MEMORY_PROPOSAL_EXPIRY_JOB_NAME,
    intervalMs: options.intervalMs ?? 60 * 60_000,
    jitterRatio: 0.1,
    runOnStart: true,
    timeoutMs: 60_000,
    async run(_ctx: JobContext): Promise<JobOutcome> {
      return runBridgeMemoryProposalExpiryTick(options);
    },
  };
}
