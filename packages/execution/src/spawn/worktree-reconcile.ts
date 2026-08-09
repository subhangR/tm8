// @tm8/execution — startup reconciliation for worktree allocations (design §6).
//
// It cross-checks the sources §6.1 names — the allocation rows for this node,
// the entities behind them, the filesystem, `git worktree list --porcelain`,
// and the live PTY map — and applies only the repairs §6.2 permits.
//
// §6.3, which is the important half, in the order the temptations arrive:
//
//   * NEVER INFER `merged` OR `abandoned`. Absence of evidence is not a merge.
//     No timeout, no heuristic, no "the branch is gone so it must have landed."
//     Nothing in this file can even express those transitions: it does not call
//     `update_worktree` at all, and `worktrees.status` is that door's alone.
//   * NEVER DELETE AN UNRECOGNISED GIT WORKTREE. The repository is shared with
//     the user's own worktrees. Quarantine means: record it, surface it, touch
//     nothing.
//   * NEVER THROW. Reconciliation is cleanup, not a precondition for serving
//     traffic. Every repair is individually guarded and every failure is
//     reported in the returned record instead of aborting the sweep.

import { readdir, stat } from 'node:fs/promises';

import type { WorktreeManager } from '../worktree/WorktreeManager.js';
import type { Logger } from '../pty/types.js';
import type {
  GraphAuth,
  GraphPort,
  WorktreeAllocationRow,
  WorktreeAllocationState,
} from './types.js';

export interface WorktreeRepair {
  worktreeId: string;
  observed: string;
  action: string;
  state: WorktreeAllocationState | null;
}

export interface WorktreeQuarantine {
  projectId: string;
  path: string;
  branch: string | null;
  reason: string;
}

export interface WorktreeReconcileReport {
  examined: number;
  repaired: WorktreeRepair[];
  /** Foreign checkouts found inside this node's area. Reported, never touched. */
  quarantined: WorktreeQuarantine[];
  errors: Array<{ worktreeId: string | null; message: string }>;
}

export interface ReconcileParams {
  auth: GraphAuth;
  graph: GraphPort;
  manager: WorktreeManager;
  nodeId: string;
  /** The live PTY map. Only the node owning a terminal can say whether it is gone. */
  hasLivePty: (sessionId: string) => boolean;
  /**
   * `project.working_dir` per project id. Reconciliation needs a repository
   * root to run `git worktree list/remove/prune` against, and allocations only
   * carry the project id. Absent → the Git-side checks for that project are
   * skipped, which is a narrower sweep, never a wrong repair.
   */
  repoRootFor?: (projectId: string) => Promise<string | null>;
  logger?: Logger | undefined;
}

const TERMINAL_SESSION_STATUSES = new Set(['exited', 'failed']);

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * The §6.2 table, one row per branch, in the order the table lists them.
 *
 * Returns a record rather than logging and forgetting: what a reconciler
 * decided about a checkout is exactly the kind of thing an operator needs to
 * read afterwards, and "it printed something at boot" is not a surface.
 */
export async function reconcileNodeWorktrees(
  params: ReconcileParams,
): Promise<WorktreeReconcileReport> {
  const report: WorktreeReconcileReport = {
    examined: 0,
    repaired: [],
    quarantined: [],
    errors: [],
  };

  let rows: WorktreeAllocationRow[];
  try {
    rows = await params.graph.listNodeWorktreeAllocations(params.auth, params.nodeId);
  } catch (error) {
    // A node whose graph is briefly unreachable at boot must still start.
    report.errors.push({
      worktreeId: null,
      message: `could not read allocations: ${error instanceof Error ? error.message : String(error)}`,
    });
    return report;
  }
  report.examined = rows.length;

  // Git state is read once per project, not once per allocation: `git worktree
  // list` is a repository-wide answer and asking it N times would serialize the
  // whole sweep behind N subprocesses for no new information.
  const gitPaths = new Map<string, Set<string>>();
  const repoRoots = new Map<string, string>();
  const projectIds = new Set(rows.map((r) => r.projectId).filter((id): id is string => !!id));

  // §6.1's third source: the FILESYSTEM under `<worktreeRoot>/<projectId>/`.
  //
  // Unioned in rather than derived from the rows, and that is the whole point
  // of quarantine: a checkout with no allocation row belongs to a project this
  // node may have no surviving rows for at all. Scanning only the projects the
  // rows mention would look everywhere except where the orphans are.
  let area: string | null = null;
  try {
    area = await params.manager.worktreeRoot();
    for (const entry of await readdir(area, { withFileTypes: true })) {
      if (entry.isDirectory()) projectIds.add(entry.name);
    }
  } catch {
    // No area yet, or unreadable. Narrower sweep, never a wrong repair.
  }

  for (const projectId of projectIds) {
    try {
      const repoRoot = params.repoRootFor ? await params.repoRootFor(projectId) : null;
      if (!repoRoot) continue;
      repoRoots.set(projectId, repoRoot);
      const entries = await params.manager.list(repoRoot);
      gitPaths.set(projectId, new Set(entries.map((e) => e.path)));
    } catch (error) {
      report.errors.push({
        worktreeId: null,
        message: `git worktree list failed for project ${projectId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  for (const row of rows) {
    try {
      await reconcileOne(params, row, gitPaths, repoRoots, report);
    } catch (error) {
      report.errors.push({
        worktreeId: row.worktreeId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // §6.2 last row, and §6.3's second prohibition: a Git worktree inside this
  // node's area with no allocation row is QUARANTINED. It is reported and left
  // exactly as found — the repository may be shared with a human's own
  // worktrees, and a reconciler that deletes what it does not recognise is a
  // reconciler that eventually deletes someone's afternoon.
  const known = new Set(rows.map((r) => r.path).filter((p): p is string => !!p));
  if (area) {
    for (const [projectId, paths] of gitPaths) {
      for (const path of paths) {
        if (known.has(path)) continue;
        if (!path.startsWith(`${area}/`)) continue; // outside our area: not ours to have an opinion about
        report.quarantined.push({
          projectId,
          path,
          branch: null,
          reason: 'git worktree inside the node area with no allocation row',
        });
      }
    }
  }

  if (report.repaired.length || report.quarantined.length) {
    params.logger?.info?.('worktree reconciliation', {
      examined: report.examined,
      repaired: report.repaired.length,
      quarantined: report.quarantined.length,
      errors: report.errors.length,
    });
  }
  return report;
}

async function reconcileOne(
  params: ReconcileParams,
  row: WorktreeAllocationRow,
  gitPaths: Map<string, Set<string>>,
  repoRoots: Map<string, string>,
  report: WorktreeReconcileReport,
): Promise<void> {
  const { auth, graph } = params;
  const path = row.path;
  const projectId = row.projectId;
  const onDisk = path ? await exists(path) : false;
  // `undefined` means "we could not ask Git about this project", which is not
  // the same as "Git does not know it" — and treating the two alike is how a
  // sweep that could not run a subprocess starts deleting checkouts.
  const inGit = projectId && gitPaths.has(projectId) ? gitPaths.get(projectId)!.has(path ?? '') : undefined;
  const repoRoot = projectId ? repoRoots.get(projectId) ?? null : null;

  const record = (observed: string, action: string, state: WorktreeAllocationState | null): void => {
    report.repaired.push({ worktreeId: row.worktreeId, observed, action, state });
  };

  // §6.2 row 6 — a lease held by a session with no live PTY and a terminal
  // status. Checked first and independently of state: a stale lease blocks
  // reuse of a perfectly healthy worktree, and it is the cheapest repair here.
  if (
    row.leaseSessionId &&
    !params.hasLivePty(row.leaseSessionId) &&
    row.leaseSessionStatus !== null &&
    TERMINAL_SESSION_STATUSES.has(row.leaseSessionStatus)
  ) {
    await graph.releaseWorktreeLease(auth, row.worktreeId);
    record('lease held by a terminal session with no live PTY', 'released lease', null);
  }

  switch (row.state) {
    case 'preparing': {
      // Three §6.2 rows, distinguished by how far step 4→6 got before the
      // process died.
      if (!onDisk && inGit !== true) {
        // Row 1 — nothing was created. Safe to retry.
        await graph.setWorktreeAllocationState(auth, {
          worktreeId: row.worktreeId,
          state: 'failed',
          failureCode: 'reconciled_never_created',
        });
        record('preparing, no directory, no git entry', 'marked failed (safe to retry)', 'failed');
        return;
      }
      if (row.entityExists) {
        // Step 6 committed but step 7 never published. The checkout is real and
        // named; the honest repair is to finish, not to undo.
        await graph.setWorktreeAllocationState(auth, { worktreeId: row.worktreeId, state: 'ready' });
        record('preparing with a committed entity', 'published ready', 'ready');
        return;
      }
      // Rows 2 and 3 — disk (and possibly Git) leads the database, and the
      // database never caught up. Nothing references this checkout, so removing
      // it is not deleting user work: it is undoing a half-finished
      // reservation. Removal still goes through the same guarded path.
      await removeAndSettle(params, row, repoRoot, path, report, 'preparing with no entity');
      return;
    }

    case 'ready': {
      if (!path) return;
      if (!onDisk) {
        // §6.2 row 4 — directory gone. `missing`, and the ENTITY STATUS IS
        // UNTOUCHED. A vanished directory says nothing about whether the work
        // merged, and inferring that it did is §6.3's first prohibition.
        await graph.setWorktreeAllocationState(auth, {
          worktreeId: row.worktreeId,
          state: 'missing',
          failureCode: 'reconciled_directory_missing',
        });
        record('ready, directory gone', 'marked missing (entity status untouched)', 'missing');
      }
      return;
    }

    case 'cleanup_pending': {
      // §6.2 row 5 — retry `remove` + `prune` with bounded backoff. The bound
      // matters: an un-bounded retry against a checkout Git keeps refusing is a
      // boot-time loop, and every attempt is counted so it can be seen.
      if (row.attempts >= CLEANUP_MAX_ATTEMPTS) {
        record(
          `cleanup_pending after ${String(row.attempts)} attempts`,
          'left for an operator (retry budget exhausted)',
          null,
        );
        return;
      }
      await removeAndSettle(params, row, repoRoot, path, report, 'cleanup_pending');
      return;
    }

    case 'missing':
    case 'failed':
      // Terminal for reconciliation. Evidence, not work in progress.
      return;
  }
}

const CLEANUP_MAX_ATTEMPTS = 5;

/**
 * Remove a checkout and settle the allocation. The removal is `force: false`
 * for exactly the reason §5.3 gives — dirty and unpushed protection is not a
 * courtesy — so a checkout with uncommitted work stays `cleanup_pending` and
 * stays on disk, which is the outcome the design wants over a tidy database.
 */
async function removeAndSettle(
  params: ReconcileParams,
  row: WorktreeAllocationRow,
  repoRoot: string | null,
  path: string | null,
  report: WorktreeReconcileReport,
  observed: string,
): Promise<void> {
  const { auth, graph } = params;
  if (!path) {
    await graph.setWorktreeAllocationState(auth, {
      worktreeId: row.worktreeId,
      state: 'failed',
      failureCode: 'reconciled_no_path',
    });
    report.repaired.push({
      worktreeId: row.worktreeId,
      observed,
      action: 'marked failed (no recorded path to clean)',
      state: 'failed',
    });
    return;
  }
  if (!repoRoot) {
    // Without a repository root there is no safe `git worktree remove`, and
    // `rm -rf` on a Git checkout leaves `.git/worktrees` metadata behind. Wait
    // for a sweep that can see the repository.
    report.repaired.push({
      worktreeId: row.worktreeId,
      observed,
      action: 'deferred (no repository root available this sweep)',
      state: null,
    });
    return;
  }

  try {
    await params.manager.withProjectLock(row.projectId ?? repoRoot, () =>
      params.manager.remove({ repoRoot, path }),
    );
  } catch (error) {
    await graph.setWorktreeAllocationState(auth, {
      worktreeId: row.worktreeId,
      state: 'cleanup_pending',
      failureCode: 'reconciled_remove_refused',
      failureDetail: { message: error instanceof Error ? error.message : String(error) },
      countAttempt: true,
    });
    report.repaired.push({
      worktreeId: row.worktreeId,
      observed,
      action: 'remove refused (dirty or locked) — left on disk, attempt counted',
      state: 'cleanup_pending',
    });
    return;
  }

  await graph.setWorktreeAllocationState(auth, {
    worktreeId: row.worktreeId,
    state: 'failed',
    failureCode: 'reconciled_removed',
  });
  report.repaired.push({
    worktreeId: row.worktreeId,
    observed,
    action: 'removed the checkout and pruned',
    state: 'failed',
  });
}
