/**
 * THE SESSION ARTIFACT RECLAIM.
 *
 * A session leaves three things under the node's data root, and before this
 * job nothing removed them: its Codex home
 * (`<dataDir>/manifests/mcp-homes/<session>/codex`), its space-key home
 * (`<dataDir>/credentials/sessions/<session>/`) and its manifest file
 * (`<dataDir>/manifests/<session>.json`). A node running a 30-minute loop kept
 * ~600 Codex homes, 9.4 GB in two weeks, until its disk filled; another kept
 * 956 manifest files.
 *
 * The PTY exit already removes the login copies and the rebuildable caches.
 * What stays is the conversation, which resume (and, for a space-key home,
 * the transcript door) reads back, so a home goes only when nothing can read
 * it again: no row, a deleted row, or (Codex home only) a worktree session
 * whose checkout is gone. A manifest file goes as soon as its session is not
 * running, because resume writes a fresh one. The exact rules are in
 * packages/execution/src/spawn/session-artifact-reclaim.ts.
 *
 * `TM8_SESSION_HOME_RETENTION_DAYS` also lets an operator remove the homes of
 * sessions that ended more than that many days ago. That gives up resume and
 * the transcript of those sessions, so it is off unless set. The older
 * `TM8_CODEX_HOME_RETENTION_DAYS` still applies to Codex homes alone when the
 * new name is unset. A live session, or one being resumed on this node, is
 * never touched.
 *
 * Node-local like the artifacts themselves: each node sweeps its own data root.
 */
import type { SessionHomeRetention } from '@tm8/execution';

import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const SESSION_ARTIFACT_RECLAIM_JOB_NAME = 'execution.session-artifact-reclaim';

const DAY_MS = 24 * 60 * 60_000;

const KEEP_WHILE_USEFUL: SessionHomeRetention = { codexHomeMs: null, spaceHomeMs: null };

export interface SessionArtifactReclaimOptions {
  reclaim(retention: SessionHomeRetention): Promise<{ reclaimed: number; errors: Array<{ message: string }> }>;
  /** Unset keeps the home of every session that can still be resumed or read. */
  retention?: SessionHomeRetention;
  intervalMs?: number;
  runOnStart?: boolean;
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runSessionArtifactReclaimTick(
  options: SessionArtifactReclaimOptions,
  log?: (message: string) => void,
): Promise<JobOutcome> {
  const { reclaimed, errors } = await options.reclaim(options.retention ?? KEEP_WHILE_USEFUL);
  if (errors.length > 0) {
    log?.(`${SESSION_ARTIFACT_RECLAIM_JOB_NAME}: ${errors.length} problem(s): ${
      errors.slice(0, 5).map((e) => e.message).join('; ')}`);
  }
  if (reclaimed === 0 && errors.length === 0) {
    return { skipped: true, reason: 'no session artifact belongs to a session that can no longer use it' };
  }
  return { affected: reclaimed, detail: { reclaimed, failed: errors.length } };
}

/** Unset, empty, 0 or invalid all mean "not set". */
function daysMs(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  const days = trimmed ? Number(trimmed) : NaN;
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : null;
}

/**
 * `TM8_SESSION_HOME_RETENTION_DAYS` for both homes. When it is unset, the
 * older `TM8_CODEX_HOME_RETENTION_DAYS` keeps its meaning: Codex homes only,
 * so an operator who set it is not opted in to removing space-key homes too.
 */
export function sessionHomeRetentionFromEnv(env: NodeJS.ProcessEnv = process.env): SessionHomeRetention {
  const both = daysMs(env['TM8_SESSION_HOME_RETENTION_DAYS']);
  if (both !== null) return { codexHomeMs: both, spaceHomeMs: both };
  return { codexHomeMs: daysMs(env['TM8_CODEX_HOME_RETENTION_DAYS']), spaceHomeMs: null };
}

export function createSessionArtifactReclaimJob(options: SessionArtifactReclaimOptions): ScheduledJob {
  return {
    name: SESSION_ARTIFACT_RECLAIM_JOB_NAME,
    // Disk fills over days, not minutes. Hourly with a per-tick cap catches up
    // on a node with a large backlog without one long burst of deletes.
    intervalMs: options.intervalMs ?? 60 * 60_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 10 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runSessionArtifactReclaimTick(options, (m) => { ctx.logger.warn(m); });
    },
  };
}
