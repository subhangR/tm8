/**
 * THE CODEX HOME RECLAIM.
 *
 * Every Codex launch and resume writes a per-session CODEX_HOME under the
 * node's data root (`<dataDir>/manifests/mcp-homes/<session>/codex`), and
 * before this job nothing removed one. A node running a 30-minute loop kept
 * ~600 of them, 9.4 GB in two weeks, until its disk filled.
 *
 * The PTY exit already removes the login copy and the rebuildable caches. What
 * stays is the conversation, which `codex resume` reads back, so this job
 * removes a home only when its session cannot come back: no row, a deleted
 * row, or a worktree session whose checkout is gone. `TM8_CODEX_HOME_RETENTION_DAYS`
 * also lets an operator remove homes of sessions that ended more than that
 * many days ago. That gives up resume for those sessions, so it is off unless
 * set. A live session, or one being resumed on this node, is never touched.
 *
 * Node-local like the homes themselves: each node sweeps its own data root.
 */
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const CODEX_HOME_RECLAIM_JOB_NAME = 'execution.codex-home-reclaim';

const DAY_MS = 24 * 60 * 60_000;

export interface CodexHomeReclaimOptions {
  reclaim(retentionMs: number | null): Promise<{ reclaimed: number; errors: Array<{ message: string }> }>;
  /** Null keeps the home of every resumable session. */
  retentionMs?: number | null;
  intervalMs?: number;
  runOnStart?: boolean;
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runCodexHomeReclaimTick(
  options: CodexHomeReclaimOptions,
  log?: (message: string) => void,
): Promise<JobOutcome> {
  const { reclaimed, errors } = await options.reclaim(options.retentionMs ?? null);
  if (errors.length > 0) {
    log?.(`${CODEX_HOME_RECLAIM_JOB_NAME}: ${errors.length} problem(s): ${
      errors.slice(0, 5).map((e) => e.message).join('; ')}`);
  }
  if (reclaimed === 0 && errors.length === 0) {
    return { skipped: true, reason: 'no Codex home belongs to a session that can no longer be resumed' };
  }
  return { affected: reclaimed, detail: { reclaimed, failed: errors.length } };
}

/** `TM8_CODEX_HOME_RETENTION_DAYS`: unset, empty, 0 or invalid all mean "keep while resumable". */
export function codexHomeRetentionMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env['TM8_CODEX_HOME_RETENTION_DAYS']?.trim();
  const days = raw ? Number(raw) : NaN;
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : null;
}

export function createCodexHomeReclaimJob(options: CodexHomeReclaimOptions): ScheduledJob {
  return {
    name: CODEX_HOME_RECLAIM_JOB_NAME,
    // Disk fills over days, not minutes. Hourly with a per-tick cap catches up
    // on a node with a large backlog without one long burst of deletes.
    intervalMs: options.intervalMs ?? 60 * 60_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 10 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runCodexHomeReclaimTick(options, (m) => { ctx.logger.warn(m); });
    },
  };
}
