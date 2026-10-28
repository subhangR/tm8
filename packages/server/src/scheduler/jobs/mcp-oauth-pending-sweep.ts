/**
 * Expired pending MCP sign-ins (plan §5.4, migrations 342 and 376).
 *
 * 342 sweeps expired `internal.mcp_oauth_pending` rows inside every begin, so on
 * a busy node they never pile up. On a quiet one nobody begins a connect, and an
 * abandoned sign-in's sealed envelope would sit there indefinitely. This job
 * deletes them through `public.sweep_mcp_oauth_pending` (node admin).
 */

import type { Db, DbClaims } from '../../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const MCP_OAUTH_PENDING_SWEEP_JOB_NAME = 'sweep.mcp-oauth-pending';

export interface McpOAuthPendingSweepOptions {
  db: Pick<Db, 'rpc'>;
  /** Node-owner claims — the sweep door is node-admin only. */
  claims: () => Promise<DbClaims>;
  intervalMs?: number;
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runMcpOAuthPendingSweepTick(options: McpOAuthPendingSweepOptions): Promise<JobOutcome> {
  const removed = Number(await options.db.rpc<number | string>(await options.claims(), 'public.sweep_mcp_oauth_pending', []));
  if (removed === 0) return { skipped: true, reason: 'no expired pending MCP sign-in' };
  return { affected: removed };
}

export function createMcpOAuthPendingSweepJob(options: McpOAuthPendingSweepOptions): ScheduledJob {
  return {
    name: MCP_OAUTH_PENDING_SWEEP_JOB_NAME,
    intervalMs: options.intervalMs ?? 30 * 60_000,
    jitterRatio: 0.1,
    runOnStart: true,
    timeoutMs: 60_000,
    async run(_ctx: JobContext): Promise<JobOutcome> {
      return runMcpOAuthPendingSweepTick(options);
    },
  };
}
