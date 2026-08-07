// Gate G4 (worktree design §9 Phase 4) — startup reconciliation against REAL
// git repositories in throwaway temp directories.
//
// Every row of the §6.2 repair table gets a case, and so does every prohibition
// in §6.3 — the prohibitions are the half that matters, because a reconciler
// that repairs eagerly is worse than one that does nothing.
//
//   G4.1  preparing, no directory, no git entry      → failed (safe to retry)
//   G4.2  preparing, directory + git entry, no entity → removed
//   G4.3  preparing with a committed entity           → published ready
//   G4.4  ready, directory gone                       → missing, STATUS UNTOUCHED
//   G4.5  cleanup_pending                             → retried, bounded
//   G4.6  stale lease                                 → released
//   G4.7  foreign git worktree in the node's area     → quarantined, UNTOUCHED
//   G4.8  never infers merged/abandoned, under any input
//   G4.9  never throws — an unreadable graph is a report, not a boot failure

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runGit } from '../worktree/git-invoker.js';
import { WorktreeManager } from '../worktree/WorktreeManager.js';
import { reconcileNodeWorktrees } from './worktree-reconcile.js';
import type { GraphAuth, GraphPort, WorktreeAllocationRow } from './types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NODE_ID = 'test-node:1';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const AUTH: GraphAuth = { identityId: 'i-1' } as unknown as GraphAuth;

let base: string;
let repoRoot: string;
let worktreeRoot: string;
let manager: WorktreeManager;

async function git(args: string[], cwd: string): Promise<string> {
  const res = await runGit(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function uuidN(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function allocation(over: Partial<WorktreeAllocationRow> & { worktreeId: string }): WorktreeAllocationRow {
  return {
    projectId: PROJECT_ID,
    state: 'preparing',
    path: null,
    branch: null,
    leaseSessionId: null,
    attempts: 0,
    failureCode: null,
    entityExists: false,
    worktreeStatus: null,
    leaseSessionStatus: null,
    ...over,
  };
}

/**
 * Only the calls reconciliation is allowed to make. Anything else — notably a
 * status write — would have to be added here first, which is the point: the
 * §6.3 prohibitions are enforced by the port's SHAPE, not by remembering.
 */
function graphWith(rows: WorktreeAllocationRow[]) {
  const calls: Array<{ call: string; worktreeId: string; state?: string }> = [];
  const graph = {
    listNodeWorktreeAllocations: async () => rows,
    setWorktreeAllocationState: async (
      _auth: GraphAuth,
      input: { worktreeId: string; state: string },
    ) => {
      calls.push({ call: 'state', worktreeId: input.worktreeId, state: input.state });
    },
    releaseWorktreeLease: async (_auth: GraphAuth, worktreeId: string) => {
      calls.push({ call: 'unlease', worktreeId });
    },
  } as unknown as GraphPort;
  return { graph, calls };
}

function run(rows: WorktreeAllocationRow[], hasLivePty: (id: string) => boolean = () => false) {
  const { graph, calls } = graphWith(rows);
  return reconcileNodeWorktrees({
    auth: AUTH,
    graph,
    manager,
    nodeId: NODE_ID,
    hasLivePty,
    repoRootFor: async () => repoRoot,
  }).then((report) => ({ report, calls }));
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'tm8-wt-reconcile-'));
  repoRoot = join(base, 'repo');
  worktreeRoot = join(base, 'worktrees');
  await mkdir(repoRoot, { recursive: true });
  await git(['init', '-b', 'main'], repoRoot);
  await writeFile(join(repoRoot, 'README.md'), 'hello\n');
  await git(['add', '.'], repoRoot);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'initial'], repoRoot);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  manager = new WorktreeManager({ worktreeRoot });
});

describe('§6.2 — the repair table', () => {
  it('G4.1 preparing with nothing on disk and no git entry → failed, safe to retry', async () => {
    const id = uuidN(1);
    const { report, calls } = await run([
      allocation({ worktreeId: id, path: join(worktreeRoot, PROJECT_ID, id) }),
    ]);
    expect(calls).toEqual([{ call: 'state', worktreeId: id, state: 'failed' }]);
    expect(report.repaired[0]?.action).toContain('safe to retry');
  });

  it('G4.2 preparing with a real checkout but no entity → the checkout is removed', async () => {
    const id = uuidN(2);
    const oid = await git(['rev-parse', 'HEAD^{commit}'], repoRoot);
    const { path } = await manager.add({
      repoRoot,
      projectId: PROJECT_ID,
      worktreeId: id,
      branch: `tm8/${id.slice(-8)}`,
      baseCommitOid: oid,
    });
    await expect(stat(path)).resolves.toBeTruthy();

    const { calls } = await run([allocation({ worktreeId: id, path, entityExists: false })]);
    expect(calls).toEqual([{ call: 'state', worktreeId: id, state: 'failed' }]);
    // Removing a half-finished reservation nothing references is not deleting
    // user work — it is undoing the reservation.
    await expect(stat(path)).rejects.toThrow();
  });

  it('G4.3 preparing whose entity DID commit → published ready, never removed', async () => {
    const id = uuidN(3);
    const oid = await git(['rev-parse', 'HEAD^{commit}'], repoRoot);
    const { path } = await manager.add({
      repoRoot,
      projectId: PROJECT_ID,
      worktreeId: id,
      branch: `tm8/${id.slice(-8)}`,
      baseCommitOid: oid,
    });

    const { calls } = await run([allocation({ worktreeId: id, path, entityExists: true })]);
    expect(calls).toEqual([{ call: 'state', worktreeId: id, state: 'ready' }]);
    // The honest repair for "step 6 committed, step 7 did not" is to FINISH.
    await expect(stat(path)).resolves.toBeTruthy();
  });

  it('G4.4 ready with the directory gone → missing, and the ENTITY STATUS is untouched', async () => {
    const id = uuidN(4);
    const { report, calls } = await run([
      allocation({
        worktreeId: id,
        state: 'ready',
        path: join(worktreeRoot, PROJECT_ID, id),
        entityExists: true,
        worktreeStatus: 'active',
      }),
    ]);
    expect(calls).toEqual([{ call: 'state', worktreeId: id, state: 'missing' }]);
    expect(report.repaired[0]?.action).toContain('entity status untouched');
  });

  it('G4.5 cleanup_pending retries, and the retry budget is BOUNDED', async () => {
    const spent = allocation({
      worktreeId: uuidN(5),
      state: 'cleanup_pending',
      attempts: 5,
      path: join(worktreeRoot, PROJECT_ID, uuidN(5)),
    });
    const { report, calls } = await run([spent]);
    // An unbounded retry against a checkout git keeps refusing is a boot loop.
    expect(calls).toEqual([]);
    expect(report.repaired[0]?.action).toContain('retry budget exhausted');
  });

  it('G4.6 a lease held by a terminal session with no live PTY is released', async () => {
    const id = uuidN(6);
    const { calls } = await run([
      allocation({
        worktreeId: id,
        state: 'ready',
        path: join(worktreeRoot, PROJECT_ID, id),
        entityExists: true,
        leaseSessionId: 'session-dead',
        leaseSessionStatus: 'exited',
      }),
    ]);
    expect(calls[0]).toEqual({ call: 'unlease', worktreeId: id });
  });

  it('a lease whose session still has a LIVE PTY is left alone', async () => {
    const id = uuidN(7);
    const oid = await git(['rev-parse', 'HEAD^{commit}'], repoRoot);
    const { path } = await manager.add({
      repoRoot,
      projectId: PROJECT_ID,
      worktreeId: id,
      branch: `tm8/${id.slice(-8)}`,
      baseCommitOid: oid,
    });
    const { calls } = await run(
      [
        allocation({
          worktreeId: id,
          state: 'ready',
          path,
          entityExists: true,
          leaseSessionId: 'session-live',
          leaseSessionStatus: 'exited',
        }),
      ],
      (sessionId) => sessionId === 'session-live',
    );
    expect(calls.some((c) => c.call === 'unlease')).toBe(false);
    await manager.remove({ repoRoot, path, force: true });
  });
});

describe('§6.3 — the prohibitions, which are the half that matters', () => {
  it('G4.7 a foreign git worktree in the node area is QUARANTINED, not deleted', async () => {
    // A checkout inside the node's own area that no allocation row claims —
    // exactly what a crashed provisioning run, or a human, could leave behind.
    const foreign = join(worktreeRoot, PROJECT_ID, 'someone-elses-work');
    await mkdir(join(worktreeRoot, PROJECT_ID), { recursive: true });
    await git(['worktree', 'add', '-b', 'human/branch', foreign, 'HEAD'], repoRoot);

    const { report, calls } = await run([]);
    expect(calls).toEqual([]);
    expect(report.quarantined.map((q) => q.path)).toContain(await realpathish(foreign));
    // TOUCHED NOTHING. The repository may be shared with a human's own
    // worktrees, and a reconciler that deletes what it does not recognise is
    // one that eventually deletes someone's afternoon.
    await expect(stat(foreign)).resolves.toBeTruthy();

    await manager.remove({ repoRoot, path: foreign, force: true });
  });

  it('G4.8 never infers merged or abandoned — not for a vanished directory, not for a deleted branch', async () => {
    const rows = [
      allocation({ worktreeId: uuidN(8), state: 'ready', path: '/nonexistent/gone', entityExists: true, worktreeStatus: 'active' }),
      allocation({ worktreeId: uuidN(9), state: 'preparing', path: '/nonexistent/never', entityExists: false }),
      allocation({ worktreeId: uuidN(10), state: 'missing', path: '/nonexistent/x', entityExists: true, worktreeStatus: 'active' }),
      allocation({ worktreeId: uuidN(11), state: 'failed', path: '/nonexistent/y', entityExists: true, worktreeStatus: 'active' }),
    ];
    const { calls } = await run(rows);
    const states = calls.map((c) => c.state).filter(Boolean);
    expect(states).not.toContain('merged');
    expect(states).not.toContain('abandoned');
    // Stronger than an assertion about values: the port reconciliation is given
    // has no way to write `worktrees.status` at all.
    expect(states.every((s) => ['failed', 'ready', 'missing', 'cleanup_pending'].includes(s!))).toBe(true);
  });

  it('G4.9 never throws — an unreadable graph is a report, not a boot failure', async () => {
    const graph = {
      listNodeWorktreeAllocations: async () => {
        throw new Error('database is not up yet');
      },
    } as unknown as GraphPort;

    const report = await reconcileNodeWorktrees({
      auth: AUTH,
      graph,
      manager,
      nodeId: NODE_ID,
      hasLivePty: () => false,
    });
    expect(report.examined).toBe(0);
    expect(report.errors[0]?.message).toContain('database is not up yet');
  });

  it('a repair that throws does not stop the sweep', async () => {
    const bad = uuidN(12);
    const good = uuidN(13);
    const calls: string[] = [];
    const graph = {
      listNodeWorktreeAllocations: async () => [
        allocation({ worktreeId: bad, state: 'ready', path: '/nonexistent/a', entityExists: true }),
        allocation({ worktreeId: good, state: 'ready', path: '/nonexistent/b', entityExists: true }),
      ],
      setWorktreeAllocationState: async (_a: GraphAuth, input: { worktreeId: string }) => {
        if (input.worktreeId === bad) throw new Error('row is locked');
        calls.push(input.worktreeId);
      },
      releaseWorktreeLease: async () => undefined,
    } as unknown as GraphPort;

    const report = await reconcileNodeWorktrees({
      auth: AUTH,
      graph,
      manager,
      nodeId: NODE_ID,
      hasLivePty: () => false,
    });
    expect(calls).toEqual([good]);
    expect(report.errors[0]?.worktreeId).toBe(bad);
  });
});

/** The manager realpaths its area, so compare against the resolved form. */
async function realpathish(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(path);
}
