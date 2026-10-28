/**
 * THE WARM LANE POOL'S UPKEEP.
 *
 * A worktree launch takes a warm lane — a checkout this node made in advance
 * (`@tm8/execution`'s warm-pool.ts) — instead of running `git worktree add`.
 * A warm lane is checked out at its project's default base AS IT WAS when the
 * lane was made, and that base moves every time any lane fetches: a launch
 * that claims a lane 40 commits behind has to check the difference out
 * itself, measured at 1.3-3.2 s on a loaded node. Each tick moves warm lanes
 * the base has passed, tops pools back up after a burst of launches, and
 * gives back the disk of projects no launch has wanted for a day.
 *
 * CONTRACT
 *   Called by: the R26 scheduler, registered in main.ts when the node keeps a
 *   pool. Calls: `maintain()`, which is `WarmLanePool.maintainAll()` and never
 *   rejects. Everything it does is background work on this node's own disk;
 *   no launch waits on a tick, and a tick needs no database.
 */
import type { PoolMaintenanceReport } from '@tm8/execution';

import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const WORKTREE_POOL_JOB_NAME = 'execution.worktree-pool';

/** Often enough that a claimed lane is rarely more than a few merges behind. */
export const DEFAULT_WORKTREE_POOL_INTERVAL_MS = 5 * 60_000;

export interface WorktreePoolJobOptions {
  maintain(): Promise<PoolMaintenanceReport>;
  intervalMs?: number;
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runWorktreePoolTick(options: WorktreePoolJobOptions): Promise<JobOutcome> {
  const report = await options.maintain();
  if (report.projects === 0) {
    return { skipped: true, reason: 'no project has launched a worktree lane on this node yet' };
  }
  return { affected: report.lanes.warm ?? 0, detail: { projects: report.projects, lanes: report.lanes } };
}

export function createWorktreePoolJob(options: WorktreePoolJobOptions): ScheduledJob {
  return {
    name: WORKTREE_POOL_JOB_NAME,
    intervalMs: options.intervalMs ?? DEFAULT_WORKTREE_POOL_INTERVAL_MS,
    jitterRatio: 0.1,
    // Startup already warms the projects in use (worktree reconciliation).
    runOnStart: false,
    // A refresh is a checkout of the difference; a fill a whole one.
    timeoutMs: 10 * 60_000,
    async run(_ctx: JobContext): Promise<JobOutcome> {
      return runWorktreePoolTick(options);
    },
  };
}
