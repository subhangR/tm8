/**
 * MCP audit retention (plan §5.6, migration 346).
 *
 * `mcp_call_audit` gains a row for every proxied call, refusals included, so it
 * grows with use. This job deletes rows older than the node's retention window
 * — 90 days unless `TM8_MCP_AUDIT_RETENTION_DAYS` says otherwise, 0 keeping
 * everything — through `public.prune_mcp_call_audit` (node admin), one bounded
 * batch at a time so a first run on a large table never holds a long lock.
 */

import type { Db, DbClaims } from '../../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const MCP_AUDIT_RETENTION_JOB_NAME = 'retention.mcp-call-audit';
export const MCP_AUDIT_RETENTION_DAYS_DEFAULT = 90;

export interface McpAuditRetentionOptions {
  db: Pick<Db, 'rpc'>;
  /** Node-owner claims — the prune door is node-admin only. */
  claims: () => Promise<DbClaims>;
  /** Days a row is kept; 0 keeps every row. */
  retentionDays?: number;
  /** Rows per delete; the tick repeats until a batch comes back short. */
  batchSize?: number;
  /** Batches per tick, so one tick is bounded too. */
  maxBatches?: number;
  intervalMs?: number;
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runMcpAuditRetentionTick(options: McpAuditRetentionOptions, signal?: AbortSignal): Promise<JobOutcome> {
  const days = options.retentionDays ?? MCP_AUDIT_RETENTION_DAYS_DEFAULT;
  if (days === 0) return { skipped: true, reason: 'TM8_MCP_AUDIT_RETENTION_DAYS=0 keeps every MCP audit row' };
  const batch = options.batchSize ?? 5000;
  const claims = await options.claims();
  let removed = 0;
  for (let i = 0; i < (options.maxBatches ?? 100) && !signal?.aborted; i += 1) {
    const n = Number(await options.db.rpc<number | string>(claims, 'public.prune_mcp_call_audit', [`${String(days)} days`, batch]));
    removed += n;
    if (n < batch) break;
  }
  if (removed === 0) return { skipped: true, reason: `no MCP audit row older than ${String(days)} days` };
  return { affected: removed, detail: { retentionDays: days } };
}

export function createMcpAuditRetentionJob(options: McpAuditRetentionOptions): ScheduledJob {
  return {
    name: MCP_AUDIT_RETENTION_JOB_NAME,
    intervalMs: options.intervalMs ?? 6 * 60 * 60_000,
    jitterRatio: 0.1,
    runOnStart: true,
    timeoutMs: 10 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runMcpAuditRetentionTick(options, ctx.signal);
    },
  };
}
