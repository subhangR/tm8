// A spawn refused by `execution_spawn` AFTER its worktree was provisioned.
//
// The saga creates the checkout and its entity before the work_session row
// exists (the row must persist the real path). If the row write then refuses,
// the allocation was left `preparing` with its entity committed — which the
// reconciler reads as "step 7 never published" and PUBLISHES as ready: a lane
// no session owns, kept forever. The refusal must hand it over as
// `cleanup_pending` so the reconciler removes it instead.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { ECHO_AGENT_CMD } from '../src/spawn/manifest.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { WorktreeManager } from '../src/worktree/WorktreeManager.js';
import { FakeGraph } from './fake-graph.js';

const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };
const REQUEST = {
  clientMutationId: 'mutation-worktree-refused',
  spaceId: '11111111-1111-4111-8111-111111111111',
  teamMemberId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  workdir: { mode: 'worktree' as const },
};

describe('SpawnService — a worktree spawn the row write refuses', () => {
  let dataDir: string;
  let projectDir: string;
  let worktreeRoot: string;
  let graph: FakeGraph;
  let service: SpawnService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-wt-refused-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-wt-refused-project-'));
    worktreeRoot = await mkdtemp(join(tmpdir(), 'tm8-wt-refused-root-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' });
    git('init', '--initial-branch', 'main');
    git('config', 'user.email', 'lane@test');
    git('config', 'user.name', 'lane');
    git('commit', '--allow-empty', '-m', 'root');

    graph = new FakeGraph({ workingDir: projectDir });
    const pty = new PtyHostService();
    service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 25,
      nodeId: 'node-1',
      worktrees: new WorktreeManager({ worktreeRoot }),
    });
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false } as never);
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  it('marks the fresh checkout cleanup_pending and rethrows the refusal', async () => {
    const refusal = new Error('project not found');
    graph.failNextCreate = refusal;

    await expect(service.spawn(AUTH, REQUEST)).rejects.toBe(refusal);

    const allocations = [...graph.worktreeAllocations.values()];
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ state: 'cleanup_pending', failureCode: 'spawn_refused' });
    expect(graph.created).toEqual([]);
  });

  it('a spawn the row write accepts publishes its worktree ready, untouched by the refusal path', async () => {
    const result = await service.spawn(AUTH, REQUEST);

    const allocations = [...graph.worktreeAllocations.values()];
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.state).toBe('ready');
    expect(graph.created[0]?.workdirPath).toBe(allocations[0]?.path);
    expect(result.cwd).toBe(allocations[0]?.path);
  });
});
