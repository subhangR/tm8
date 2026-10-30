// Step 5 with a warm lane pool (worktree/warm-pool.ts), against a REAL
// temporary repository: materializeWorktree takes a warm lane when the pool has
// one and checks out cold when it does not, writes the same graph calls and
// returns the same facts either way, and leaves the pool refilling behind it.

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runGit } from '../worktree/git-invoker.js';
import { WorktreeManager } from '../worktree/WorktreeManager.js';
import type { WarmLanePool } from '../worktree/warm-pool.js';
import { materializeWorktree, reserveWorktree, type ProvisionWorktreeParams } from './worktree-provisioning.js';
import type { GraphAuth, GraphPort } from './types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PROJECT_ID = '66666666-6666-4666-8666-666666666666';
const SPACE_ID = '77777777-7777-4777-8777-777777777777';
const AUTH = { identityId: 'i-1' } as unknown as GraphAuth;

let base: string;
let repoRoot: string;
let headOid: string;

async function git(args: string[], cwd: string): Promise<string> {
  const res = await runGit(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

async function waitForWarm(pool: WarmLanePool, n: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (pool.snapshot(PROJECT_ID).filter((l) => l.state === 'warm').length < n) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} warm lane(s)`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function graphRecorder() {
  const calls: Array<{ call: string; worktreeId: string; state?: string }> = [];
  const graph = {
    reserveWorktreeAllocation: async (_auth: GraphAuth, input: { worktreeId: string }) => {
      calls.push({ call: 'reserve', worktreeId: input.worktreeId });
    },
    createWorktreeEntity: async (_auth: GraphAuth, input: { worktreeId: string }) => {
      calls.push({ call: 'entity', worktreeId: input.worktreeId });
    },
    setWorktreeAllocationState: async (_auth: GraphAuth, input: { worktreeId: string; state: string }) => {
      calls.push({ call: 'state', worktreeId: input.worktreeId, state: input.state });
    },
  } as unknown as GraphPort;
  return { graph, calls };
}

function managerIn(dir: string): WorktreeManager {
  return new WorktreeManager({
    worktreeRoot: join(dir, 'worktrees'),
    pool: { root: join(dir, 'worktrees-pool'), size: 1 },
  });
}

function params(graph: GraphPort, manager: WorktreeManager): ProvisionWorktreeParams {
  return {
    auth: AUTH,
    graph,
    manager,
    spaceId: SPACE_ID,
    projectId: PROJECT_ID,
    projectWorkingDir: repoRoot,
    requestedBaseRef: null,
    nodeId: 'test-node:1',
    cap: 0,
    clientMutationId: null,
  };
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'tm8-wt-materialize-pool-'));
  repoRoot = join(base, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await git(['init', '-b', 'main'], repoRoot);
  await writeFile(join(repoRoot, 'README.md'), 'hello\n');
  await git(['add', '.'], repoRoot);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'initial'], repoRoot);
  headOid = await git(['rev-parse', 'HEAD^{commit}'], repoRoot);
  repoRoot = (await new WorktreeManager({ worktreeRoot: join(base, 'probe') }).validateRepository(repoRoot)).repoRoot;
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('materializeWorktree with a warm lane pool', () => {
  it('takes a warm lane: the reserved path and branch, the same graph calls, and the pool refills', async () => {
    const manager = managerIn(join(base, 'warm'));
    const pool = manager.pool!;
    pool.replenish(PROJECT_ID, repoRoot);
    await waitForWarm(pool, 1);
    const [warmLane] = pool.snapshot(PROJECT_ID);

    const { graph, calls } = graphRecorder();
    const reserved = await reserveWorktree(params(graph, manager));
    const provisioned = await materializeWorktree(params(graph, manager), reserved);

    const { repoRoot: _repoRoot, ...facts } = reserved;
    expect(provisioned).toEqual(facts);
    expect(calls).toEqual([
      { call: 'reserve', worktreeId: reserved.worktreeId },
      { call: 'entity', worktreeId: reserved.worktreeId },
    ]);
    // It IS the warm lane, moved: the pool's directory is gone, the lane is on its branch.
    await expect(stat(warmLane!.path)).rejects.toThrow();
    expect(await git(['symbolic-ref', '--short', 'HEAD'], provisioned.path)).toBe(reserved.branch);
    expect(await git(['rev-parse', 'HEAD'], provisioned.path)).toBe(headOid);
    expect(await git(['status', '--porcelain'], provisioned.path)).toBe('');

    await waitForWarm(pool, 1);
    expect(pool.snapshot(PROJECT_ID).map((l) => l.path)).not.toContain(warmLane!.path);
    await manager.remove({ projectId: PROJECT_ID, repoRoot, path: provisioned.path, force: true });
    await pool.drain();
  });

  it('with no warm lane checks out cold, identically, and starts the project pool behind it', async () => {
    const manager = managerIn(join(base, 'cold'));
    const pool = manager.pool!;
    expect(pool.snapshot(PROJECT_ID)).toEqual([]);

    const { graph, calls } = graphRecorder();
    const reserved = await reserveWorktree(params(graph, manager));
    const provisioned = await materializeWorktree(params(graph, manager), reserved);

    const { repoRoot: _repoRoot, ...facts } = reserved;
    expect(provisioned).toEqual(facts);
    expect(calls).toEqual([
      { call: 'reserve', worktreeId: reserved.worktreeId },
      { call: 'entity', worktreeId: reserved.worktreeId },
    ]);
    expect(await git(['symbolic-ref', '--short', 'HEAD'], provisioned.path)).toBe(reserved.branch);
    expect(await git(['status', '--porcelain'], provisioned.path)).toBe('');

    // The cold launch told the pool this project wants warm lanes.
    await waitForWarm(pool, 1);
    await manager.remove({ projectId: PROJECT_ID, repoRoot, path: provisioned.path, force: true });
    await pool.drain();
  });
});
