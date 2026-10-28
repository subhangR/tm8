// The provisioning saga split in two (admit-fast spawn): steps 1-4 reserve and
// name the path without touching the disk; steps 5-6 create the checkout at
// exactly that path. Against a REAL temporary repository, because the claim
// under test is about what is and is not on disk.

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runGit } from '../worktree/git-invoker.js';
import { WorktreeManager } from '../worktree/WorktreeManager.js';
import {
  materializeWorktree,
  provisionWorktree,
  reserveWorktree,
  type ProvisionWorktreeParams,
} from './worktree-provisioning.js';
import type { GraphAuth, GraphPort } from './types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const SPACE_ID = '44444444-4444-4444-8444-444444444444';
const AUTH = { identityId: 'i-1' } as unknown as GraphAuth;

let base: string;
let repoRoot: string;
let worktreeRoot: string;
let manager: WorktreeManager;
let headOid: string;

async function git(args: string[], cwd: string): Promise<string> {
  const res = await runGit(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function graphRecorder() {
  const calls: Array<{ call: string; worktreeId: string; path?: string; state?: string }> = [];
  const graph = {
    reserveWorktreeAllocation: async (_auth: GraphAuth, input: { worktreeId: string; path: string }) => {
      calls.push({ call: 'reserve', worktreeId: input.worktreeId, path: input.path });
    },
    createWorktreeEntity: async (_auth: GraphAuth, input: { worktreeId: string; path: string }) => {
      calls.push({ call: 'entity', worktreeId: input.worktreeId, path: input.path });
    },
    setWorktreeAllocationState: async (_auth: GraphAuth, input: { worktreeId: string; state: string }) => {
      calls.push({ call: 'state', worktreeId: input.worktreeId, state: input.state });
    },
  } as unknown as GraphPort;
  return { graph, calls };
}

function params(graph: GraphPort): ProvisionWorktreeParams {
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
  base = await mkdtemp(join(tmpdir(), 'tm8-wt-split-'));
  repoRoot = join(base, 'repo');
  worktreeRoot = join(base, 'worktrees');
  await mkdir(repoRoot, { recursive: true });
  await git(['init', '-b', 'main'], repoRoot);
  await writeFile(join(repoRoot, 'README.md'), 'hello\n');
  await git(['add', '.'], repoRoot);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'initial'], repoRoot);
  headOid = await git(['rev-parse', 'HEAD^{commit}'], repoRoot);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  manager = new WorktreeManager({ worktreeRoot });
});

describe('reserveWorktree — steps 1-4', () => {
  it('reserves the deterministic path and leaves the disk untouched', async () => {
    const { graph, calls } = graphRecorder();
    const reserved = await reserveWorktree(params(graph));

    expect(reserved.path).toBe(await manager.computeWorktreePath(PROJECT_ID, reserved.worktreeId));
    expect(reserved.branch).toBe(`tm8/${reserved.worktreeId}`);
    expect(reserved.baseRef).toBe('main');
    expect(reserved.baseCommitOid).toBe(headOid);
    expect(calls).toEqual([{ call: 'reserve', worktreeId: reserved.worktreeId, path: reserved.path }]);
    expect(await exists(reserved.path)).toBe(false);
  });

  it('does not wait behind the project Git lock', async () => {
    // A held Git lock is another launch's `git worktree add` in progress.
    let releaseGit!: () => void;
    const gitHeld = manager.withProjectLock(PROJECT_ID, () => new Promise<void>((r) => { releaseGit = r; }));
    const { graph } = graphRecorder();
    try {
      const outcome = await Promise.race([
        reserveWorktree(params(graph)).then(() => 'reserved'),
        new Promise((r) => setTimeout(() => r('blocked'), 5_000)),
      ]);
      expect(outcome).toBe('reserved');
    } finally {
      releaseGit();
      await gitHeld;
    }
  });

  it('refuses a directory that is not a repository before reserving anything', async () => {
    const { graph, calls } = graphRecorder();
    await expect(reserveWorktree({ ...params(graph), projectWorkingDir: base })).rejects.toMatchObject({
      name: 'SpawnError',
    });
    expect(calls).toEqual([]);
  });
});

describe('materializeWorktree — steps 5-6', () => {
  it('creates the checkout at exactly the reserved path, then names it', async () => {
    const { graph, calls } = graphRecorder();
    const reserved = await reserveWorktree(params(graph));
    const provisioned = await materializeWorktree(params(graph), reserved);

    const { repoRoot: _repoRoot, ...facts } = reserved;
    expect(provisioned).toEqual(facts);
    expect(await exists(join(reserved.path, 'README.md'))).toBe(true);
    expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], reserved.path)).toBe(reserved.branch);
    expect(calls.map((c) => c.call)).toEqual(['reserve', 'entity']);
    expect(calls[1]).toEqual({ call: 'entity', worktreeId: reserved.worktreeId, path: reserved.path });
    await manager.remove({ repoRoot, path: reserved.path, force: true });
  });

  it('settles the allocation failed when the checkout cannot be created', async () => {
    const { graph, calls } = graphRecorder();
    const reserved = await reserveWorktree(params(graph));
    // The branch already exists, so `git worktree add -b` refuses and nothing
    // lands on disk: a failure that is safe to retry.
    await git(['branch', reserved.branch, headOid], repoRoot);
    try {
      await expect(materializeWorktree(params(graph), reserved)).rejects.toMatchObject({ name: 'SpawnError' });
      expect(calls.at(-1)).toEqual({ call: 'state', worktreeId: reserved.worktreeId, state: 'failed' });
      expect(await exists(reserved.path)).toBe(false);
    } finally {
      await git(['branch', '-D', reserved.branch], repoRoot);
    }
  });
});

describe('provisionWorktree — the two halves composed', () => {
  it('reserves, checks out and names, in that order, at one path', async () => {
    const { graph, calls } = graphRecorder();
    const provisioned = await provisionWorktree(params(graph));

    expect(calls.map((c) => c.call)).toEqual(['reserve', 'entity']);
    expect(calls.every((c) => c.path === provisioned.path)).toBe(true);
    expect(await exists(join(provisioned.path, 'README.md'))).toBe(true);
    await manager.remove({ repoRoot, path: provisioned.path, force: true });
  });
});
