// @tm8/execution — the worktree provisioning saga (design §4).
//
// Seven numbered steps, each naming its own failure behaviour, and the whole
// point of the numbering is that a crash BETWEEN any two of them leaves a state
// the reconciler can finish or undo (§6.2). That is why this is a sequence of
// small graph calls rather than one `provision()` RPC: hiding the boundaries
// would hide the states, and the states are the design.
//
// Two invariants that are easy to lose and expensive to lose:
//
//   * THE LOCK IS TAKEN HERE, NOT IN SQL. `internal.ledger_replay` is the first
//     statement of every ledgered door and takes an advisory lock on the
//     mutation id, so a spawn already runs under one. Nesting the per-project
//     Git lock beneath it is the documented deadlock (§5.1). `withProjectLock`
//     therefore wraps the ledgered call from outside, in this process.
//
//   * NEVER FALL BACK. A node that cannot provision a worktree refuses with a
//     named reason. It does not quietly hand back the project directory —
//     silently downgrading isolation is the single failure this whole feature
//     is an argument against (§7.4, prohibition 1).

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';

import { WorktreeError } from '../worktree/git-invoker.js';
import type { WorktreeManager } from '../worktree/WorktreeManager.js';
import { SpawnError } from './types.js';
import type { Logger } from '../pty/types.js';
import type { GraphAuth, GraphPort } from './types.js';

export interface ProvisionedWorktree {
  worktreeId: string;
  /** The path `git worktree add` created and the post-creation assertion re-validated. */
  path: string;
  branch: string;
  /** The SYMBOLIC ref, kept as provenance only. */
  baseRef: string;
  /** What was actually checked out. Refs move; this does not. */
  baseCommitOid: string;
}

export interface ProvisionWorktreeParams {
  auth: GraphAuth;
  graph: GraphPort;
  manager: WorktreeManager;
  spaceId: string;
  projectId: string;
  /** `public.projects.working_dir`, straight from the graph. Never client input. */
  projectWorkingDir: string;
  /** Client intent: a symbolic ref, or absent for the repository's own HEAD. */
  requestedBaseRef: string | null;
  nodeId: string;
  cap: number;
  clientMutationId: string | null;
  logger?: Logger | undefined;
}

/**
 * `tm8/<first 8 hex of the worktree id>` (§4.4).
 *
 * Server-computed from a uuid, so no client-influenced byte reaches a ref name
 * — which is belt to `assertSafeBranchName`'s braces and to the argv array's
 * actual guarantee.
 */
export function branchNameFor(worktreeId: string): string {
  return `tm8/${worktreeId.replace(/-/g, '').slice(0, 8)}`;
}

/** Git's own error taxonomy is already the contract's; carry it, do not invent one. */
function asSpawnError(error: unknown, fallback: string): SpawnError {
  if (error instanceof WorktreeError) {
    return new SpawnError(error.message, error.code, { reason: error.reason, ...error.detail });
  }
  if (error instanceof SpawnError) return error;
  return new SpawnError(
    `${fallback}: ${error instanceof Error ? error.message : String(error)}`,
    'internal',
  );
}

async function directoryExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Steps 1-6. Returns once the checkout exists on disk AND the entity that names
 * it exists in the graph; the lease, the edge and the `ready` publish are step
 * 7's business and belong to the caller, because they need the session id.
 */
export async function provisionWorktree(
  params: ProvisionWorktreeParams,
): Promise<ProvisionedWorktree> {
  const { auth, graph, manager } = params;

  // Step 1 (§4.2) — repository validation. A working directory that is not a
  // Git repository is `invalid_input`, never a downgrade to project mode.
  let repoRoot: string;
  let baseRef: string;
  let baseCommitOid: string;
  try {
    ({ repoRoot } = await manager.validateRepository(params.projectWorkingDir));
    // Step 2 (§4.3) — base ref resolution. The symbolic ref is provenance; the
    // resolved OID is what gets stored and checked out, so a ref that moves
    // between here and step 5 cannot change what the session actually gets.
    const resolved = await manager.resolveBaseRef(repoRoot, params.requestedBaseRef ?? undefined);
    baseRef = resolved.ref;
    baseCommitOid = resolved.oid;
  } catch (error) {
    throw asSpawnError(error, 'worktree repository validation failed');
  }

  // Step 3 (§4.4) — path and branch, server-computed, from an id generated
  // HERE. Generating it now rather than deriving it from a session id that does
  // not exist yet is what lets the reservation and the entity be the same row's
  // two halves — and is why `worktree_allocations` can have no foreign key
  // without that being an accident.
  const worktreeId = randomUUID();
  const branch = branchNameFor(worktreeId);
  const path = await manager.computeWorktreePath(params.projectId, worktreeId);

  // Steps 4-6 under the per-project Git lock, taken OUTSIDE every ledgered
  // door below it (§5.1). `git worktree add/remove/prune` mutate shared
  // `.git/worktrees` metadata; distinct projects still proceed concurrently.
  return manager.withProjectLock(params.projectId, async () => {
    // Step 4 (§4.5) — reserve. Nothing is on disk yet, so a failure here leaves
    // nothing to clean.
    try {
      await graph.reserveWorktreeAllocation(auth, {
        worktreeId,
        spaceId: params.spaceId,
        projectId: params.projectId,
        nodeId: params.nodeId,
        path,
        branch,
        cap: params.cap,
      });
    } catch (error) {
      throw asSpawnError(error, 'worktree reservation failed');
    }

    // Step 5 (§4.6) — `git worktree add`, argv-only, against the resolved OID.
    try {
      await manager.add({ repoRoot, projectId: params.projectId, worktreeId, branch, baseCommitOid });
    } catch (error) {
      // Disk state decides the repair: a directory that got partially created
      // is a cleanup obligation, and nothing on disk is simply a failure that
      // is safe to retry.
      const partial = await directoryExists(path);
      await graph
        .setWorktreeAllocationState(auth, {
          worktreeId,
          state: partial ? 'cleanup_pending' : 'failed',
          failureCode: error instanceof WorktreeError ? error.reason : 'worktree_add_failed',
          failureDetail: {
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof WorktreeError ? error.detail ?? {} : {}),
          },
        })
        .catch(() => undefined);
      throw asSpawnError(error, 'git worktree add failed');
    }

    // Step 6 (§4.7) — the entity that names what step 5 created. The path
    // persisted here is the exact string step 5 created and step 3's
    // post-creation assertion re-validated.
    try {
      await graph.createWorktreeEntity(auth, {
        worktreeId,
        spaceId: params.spaceId,
        projectId: params.projectId,
        path,
        branch,
        baseRef,
        baseCommitOid,
        clientMutationId: params.clientMutationId,
      });
    } catch (error) {
      // The one window where disk leads the database, and deliberately the SAFE
      // direction: an unreferenced directory is recoverable, a row pointing at
      // nothing is not. The reconciler removes it.
      await graph
        .setWorktreeAllocationState(auth, {
          worktreeId,
          state: 'cleanup_pending',
          failureCode: 'create_worktree_failed',
          failureDetail: { message: error instanceof Error ? error.message : String(error) },
        })
        .catch(() => undefined);
      params.logger?.warn?.('worktree: entity creation failed after the checkout existed', {
        worktreeId,
        path,
      });
      throw asSpawnError(error, 'create_worktree failed');
    }

    return { worktreeId, path, branch, baseRef, baseCommitOid };
  });
}
