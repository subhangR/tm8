// The session lane fact (107): `checkout_branch`, captured at spawn.
//
// Three claims under test, matching the migration's honesty rules:
//   1. a PROJECT-mode spawn records the shared checkout's current branch;
//   2. a non-repo (or detached) checkout records NOTHING — null is a measured
//      absence and SpawnService does not even call the door for it;
//   3. the lane-fact write is NEVER load-bearing: a graph door that throws
//      leaves the spawn fully successful.
//
// Worktree mode is deliberately not exercised here — its branch comes from
// the provisioning saga (worktree-provisioning.ts computes it before any
// git runs) and the value equality `checkoutBranch === worktree.branch` is a
// straight-line assignment; the saga itself has its own suite.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { detectCheckoutBranch } from '../src/spawn/checkout-branch.js';
import { ECHO_AGENT_CMD } from '../src/spawn/manifest.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';

const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };
const REQUEST = {
  clientMutationId: 'mutation-1',
  spaceId: '11111111-1111-4111-8111-111111111111',
  teamMemberId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
};

/** A real repo on a named branch — config is local so the host's cannot leak. */
function initRepo(dir: string, branch: string): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '--initial-branch', branch);
  git('config', 'user.email', 'lane@test');
  git('config', 'user.name', 'lane');
  git('commit', '--allow-empty', '-m', 'root');
}

describe('detectCheckoutBranch', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm8-lane-detect-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('answers the current branch of a real checkout', async () => {
    initRepo(dir, 'feat/lane-facts');
    expect(await detectCheckoutBranch(dir)).toBe('feat/lane-facts');
  });

  it('answers null for a directory that is not a repository', async () => {
    expect(await detectCheckoutBranch(dir)).toBeNull();
  });

  it('answers null for a detached HEAD — an empty line is not a branch', async () => {
    initRepo(dir, 'main');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '--detach', head], { cwd: dir, stdio: 'ignore' });
    expect(await detectCheckoutBranch(dir)).toBeNull();
  });

  it('answers null for a directory that does not exist', async () => {
    expect(await detectCheckoutBranch(join(dir, 'never-created'))).toBeNull();
  });
});

describe('SpawnService lane-fact capture', () => {
  let dataDir: string;
  let projectDir: string;
  let graph: FakeGraph;
  let pty: PtyHostService;
  let service: SpawnService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-lane-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-lane-project-'));
    graph = new FakeGraph({ workingDir: projectDir });
    pty = new PtyHostService();
    service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 25,
    });
    // No child process in this suite — the same mocked boundary
    // spawn-safety.test.ts uses for its healthy-path assertions.
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false } as never);
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('records the shared checkout branch for a project-mode spawn', async () => {
    initRepo(projectDir, 'release/2026-08');

    const result = await service.spawn(AUTH, REQUEST);

    expect(graph.checkoutBranches).toEqual([
      { sessionId: result.sessionId, branch: 'release/2026-08' },
    ]);
  });

  it('records nothing when the project directory is not a repository', async () => {
    await service.spawn(AUTH, REQUEST);

    expect(graph.checkoutBranches).toEqual([]);
  });

  it('spawns successfully even when the lane-fact write throws', async () => {
    initRepo(projectDir, 'main');
    graph.checkoutBranchError = new Error('lane door down');

    const result = await service.spawn(AUTH, REQUEST);

    expect(result.sessionId).toBeTruthy();
    expect(result.reused).toBe(false);
    // The spawn completed its full arc despite the failed fact write.
    expect(graph.transitions.map((t) => t.status)).toEqual(['running']);
    expect(graph.checkoutBranches).toEqual([]);
  });
});
