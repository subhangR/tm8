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
//
// Steps 1-4 (`reserveWorktree`) and 5-6 (`materializeWorktree`) are separately
// callable because their costs differ by orders of magnitude: the reservation
// is a few Git reads and one insert, the checkout is `git worktree add` of the
// whole tree. An admitted spawn writes its session row with the reserved path
// between the two and answers its caller before the checkout exists.

import { randomBytes } from 'node:crypto';
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

/**
 * Steps 1-4 done, nothing on disk yet: the allocation row is `preparing` and
 * every fact the session row records about its workdir is already final. The
 * path is deterministic (`computeWorktreePath` of an id minted in step 3), so a
 * launch can be admitted — its row written with this exact path — before step 5
 * creates the directory.
 */
export interface ReservedWorktree {
  worktreeId: string;
  /** The path step 5 will create: `computeWorktreePath(projectId, worktreeId)`. */
  path: string;
  branch: string;
  /** The SYMBOLIC ref, kept as provenance only. */
  baseRef: string;
  /** What step 5 will check out. Refs move; this does not. */
  baseCommitOid: string;
  /** The validated repository root step 5 runs `git worktree add` against. */
  repoRoot: string;
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
 * A UUIDv7, matching `internal.new_id()`.
 *
 * `randomUUID()` would be a v4, and `001:112-114` calls `internal.new_id()`
 * "the single id source for the whole schema" — every other entity id in the
 * system is time-ordered. This is the one id the NODE has to mint rather than
 * the database (§4.4 needs it before any write), so it has to hold up its end
 * of that invariant itself. Nothing reads the timestamp out of a worktree id
 * today; the failure if this stayed v4 would be the quiet kind — an index or a
 * cursor that assumes ordering, silently degrading for exactly one kind.
 *
 * Layout per RFC 9562 §5.7: 48-bit big-endian ms timestamp, version 7, 74 bits
 * of randomness, variant 10.
 */
function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = Date.now();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((bytes[6] as number) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f); // variant 10
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * `tm8/<the whole worktree id>` (§4.4).
 *
 * Server-computed from a uuid, so no client-influenced byte reaches a ref name
 * — which is belt to `assertSafeBranchName`'s braces and to the argv array's
 * actual guarantee.
 *
 * It used to be the first 8 hex. A uuidv7's first 6 bytes are a 48-bit big-endian
 * millisecond clock, so 8 hex characters retain the TOP 32 BITS of it and discard
 * the low 16 plus all 74 bits of randomness — the name was `floor(ms / 65536)`.
 * Two worktrees in the same 65,536 ms bucket therefore derived the SAME branch,
 * `git worktree add -b` refused the duplicate, and the second spawn died with
 * `worktree_add_failed`. That is a bucket, not a sliding window: two spawns 200 ms
 * apart inside one bucket always collide, and any real fan-out is a burst.
 *
 * Measured on prod 2026-08-31: 16 of 47 `worktree_allocations` rows (34%) were
 * `worktree_add_failed`, across 4 duplicate `(project_id, branch)` groups whose
 * failure counts sum to exactly 16 — every such failure was a collision. The worst
 * group had 10 failures behind one winner.
 *
 * The full id is what `computeWorktreePath` already uses one call later, and what
 * `compose.ts`'s `tm8/chat/<rootMessageId>` has shipped with all along. A uuid is
 * hex and hyphens, so it passes `assertSafeRefName` unchanged, and
 * `worktrees.branch` is varchar(255).
 */
export function branchNameFor(worktreeId: string): string {
  return `tm8/${worktreeId}`;
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
 * The in-process lock key the step 4 reservation serializes under.
 *
 * NOT the project's Git lock. The reservation is one database insert whose only
 * shared state is the per-project cap count, so it has to serialize against
 * other reservations of the same project (two concurrent counts would both pass
 * the cap) and against nothing else. Holding the Git lock for it would make
 * every launch's admission wait behind another launch's `git worktree add` —
 * seconds per queued checkout on a large repository, which is exactly the
 * fan-out case.
 */
function reservationLockKey(projectId: string): string {
  return `${projectId}:reserve`;
}

/**
 * Steps 1-6. Returns once the checkout exists on disk AND the entity that names
 * it exists in the graph; the lease, the edge and the `ready` publish are step
 * 7's business and belong to the caller, because they need the session id.
 *
 * Exactly {@link reserveWorktree} then {@link materializeWorktree}. A caller
 * that can record the reserved path before the checkout exists (an admitted
 * spawn) calls the two halves itself, with its own work in between.
 */
export async function provisionWorktree(
  params: ProvisionWorktreeParams,
): Promise<ProvisionedWorktree> {
  return materializeWorktree(params, await reserveWorktree(params));
}

/**
 * Steps 1-4: validate, resolve the base, mint the id and its path, reserve.
 * Nothing touches the disk, so a refusal here leaves nothing to clean, and the
 * returned path is the one step 5 will create.
 */
export async function reserveWorktree(params: ProvisionWorktreeParams): Promise<ReservedWorktree> {
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
  const worktreeId = uuidv7();
  const branch = branchNameFor(worktreeId);
  const path = await manager.computeWorktreePath(params.projectId, worktreeId);

  // Step 4 (§4.5) — reserve. Nothing is on disk yet, so a failure here leaves
  // nothing to clean. Under the reservation lock, not the Git lock: see
  // `reservationLockKey`.
  await manager.withProjectLock(reservationLockKey(params.projectId), async () => {
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
  });

  return { worktreeId, path, branch, baseRef, baseCommitOid, repoRoot };
}

/**
 * Steps 5-6 for a reservation {@link reserveWorktree} made: the checkout, the
 * shared-path links and the entity. Every failure settles the allocation
 * exactly as an unsplit provisioning would.
 */
export async function materializeWorktree(
  params: ProvisionWorktreeParams,
  reserved: ReservedWorktree,
): Promise<ProvisionedWorktree> {
  const { auth, graph, manager } = params;
  const { worktreeId, path, branch, baseRef, baseCommitOid, repoRoot } = reserved;

  // Steps 5-6 under the per-project Git lock, taken OUTSIDE every ledgered
  // door below it (§5.1). `git worktree add/remove/prune` mutate shared
  // `.git/worktrees` metadata; distinct projects still proceed concurrently.
  return manager.withProjectLock(params.projectId, async () => {
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

    // Step 5b — borrow the launch project's gitignored shared paths (the code
    // graph) by symlink. Best-effort by design: a lane without the graph is a
    // slower lane, not a broken one, so a failure here never fails the spawn.
    try {
      await manager.linkSharedPaths(repoRoot, path);
    } catch (error) {
      params.logger?.warn?.('worktree: linking shared paths failed', {
        worktreeId,
        path,
        message: error instanceof Error ? error.message : String(error),
      });
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
