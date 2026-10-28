// Admit fast (379): `SpawnService.admit` answers once the launch is ADMITTED —
// its row written, its worktree reserved — and the boot runs on behind it,
// recording lane → briefing → agent on the row before `running` makes it live.
//
// What these pin:
//   * the answer comes before any of the boot's work, and the boot then runs
//     whole, its phases in order, with `running` last;
//   * a boot that fails is on the row (status failed, a "Failed to launch"
//     reason) and `boot` RESOLVES — nothing rejects behind a caller that
//     already has its answer;
//   * a session stopped while it boots gets no process;
//   * a ledger replay of the same launch, in ANY phase, answers with the same
//     session and boots nothing;
//   * a worktree launch's row records the reserved path before the checkout
//     exists, and the reconciler treats that reservation as in flight.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { ECHO_AGENT_CMD } from '../src/spawn/manifest.js';
import { LAUNCH_FAILED_PREFIX, SpawnService } from '../src/spawn/SpawnService.js';
import type { WorktreeAllocationRow } from '../src/spawn/types.js';
import { WorktreeManager } from '../src/worktree/WorktreeManager.js';
import { FakeGraph } from './fake-graph.js';

const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const REQUEST = {
  clientMutationId: 'mutation-admit-1',
  spaceId: '11111111-1111-4111-8111-111111111111',
  teamMemberId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  taskIds: ['44444444-4444-4444-8444-444444444444'],
};

/** A promise the test opens by hand. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

describe('SpawnService.admit — answer at admission, boot behind it', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  let graph: FakeGraph;
  let service: SpawnService;
  let spawnIfAbsent: ReturnType<typeof vi.spyOn>;
  let settlement: ReturnType<typeof vi.spyOn>;
  let kill: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-admit-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-admit-project-'));
    pty = new PtyHostService();
    graph = new FakeGraph({ workingDir: projectDir, sessionId: SESSION_ID });
    service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4611',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 25,
    });
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    spawnIfAbsent = vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false } as never);
    settlement = vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
    kill = vi.spyOn(pty, 'kill');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('answers once the row exists, before any boot work, then boots lane → briefing → agent → running', async () => {
    const held = gate();
    const issue = graph.issueWorkSessionAgentToken.bind(graph);
    vi.spyOn(graph, 'issueWorkSessionAgentToken').mockImplementation(async (...args) => {
      await held.opened;
      return issue(...args);
    });

    const { admission, boot } = await service.admit(AUTH, REQUEST);

    expect(admission).toMatchObject({ sessionId: SESSION_ID, reused: false, cwd: projectDir });
    expect(admission.timings.phases).toHaveProperty('createWorkSession');
    expect(graph.created).toHaveLength(1);
    expect(graph.manifests).toEqual([]);
    expect(graph.bootPhaseReports).toEqual([]);
    expect(spawnIfAbsent).not.toHaveBeenCalled();

    held.open();
    const outcome = await boot;

    expect(outcome.ok).toBe(true);
    expect(graph.bootPhaseReports.map((r) => r.bootPhase)).toEqual(['lane', 'briefing', 'agent']);
    expect(graph.transitions).toEqual([{ sessionId: SESSION_ID, status: 'running' }]);
    expect(spawnIfAbsent).toHaveBeenCalledTimes(1);
    expect(graph.manifests).toHaveLength(1);
    if (outcome.ok) expect(outcome.result.timings?.phases).toHaveProperty('transitionRunning');
  });

  it('spawn() still answers only once the session is running', async () => {
    const result = await service.spawn(AUTH, REQUEST);

    expect(result.sessionId).toBe(SESSION_ID);
    expect(graph.transitions.at(-1)).toEqual({ sessionId: SESSION_ID, status: 'running' });
    expect(spawnIfAbsent).toHaveBeenCalledTimes(1);
  });

  it('a boot that fails says so on the row, cleans up, and RESOLVES rather than rejects', async () => {
    vi.spyOn(graph, 'recordManifest').mockRejectedValue(new Error('manifest row refused'));

    const { admission, boot } = await service.admit(AUTH, REQUEST);
    const outcome = await boot;

    expect(admission.sessionId).toBe(SESSION_ID);
    expect(outcome.ok).toBe(false);
    expect(graph.transitions).toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        status: 'failed',
        error: 'manifest row refused',
        endedReason: `${LAUNCH_FAILED_PREFIX}manifest row refused`,
      }),
    ]);
    expect(spawnIfAbsent).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(SESSION_ID);
  });

  it('spawn() rejects with the boot failure, for the in-process callers that await the boot', async () => {
    vi.spyOn(graph, 'recordManifest').mockRejectedValue(new Error('manifest row refused'));
    await expect(service.spawn(AUTH, REQUEST)).rejects.toThrow('manifest row refused');
  });

  it('a session stopped while it is briefed gets no process', async () => {
    graph.refuseBootPhase = 'briefing';

    const { boot } = await service.admit(AUTH, REQUEST);
    const outcome = await boot;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(String((outcome.error as Error).message)).toContain('stopped while it was starting');
    expect(spawnIfAbsent).not.toHaveBeenCalled();
    expect(graph.bootPhaseReports.map((r) => r.bootPhase)).toEqual(['lane']);
  });

  describe('a ledger replay of the same launch boots nothing, in every phase', () => {
    async function replayWhileHeld(hold: (released: Promise<void>) => void): Promise<void> {
      const held = gate();
      hold(held.opened);

      const first = await service.admit(AUTH, REQUEST);
      // Let the first boot run up to the hold.
      await new Promise((resolve) => setTimeout(resolve, 50));
      graph.replaySessionId = SESSION_ID;
      const replay = await service.admit(AUTH, REQUEST);

      expect(replay.admission).toMatchObject({ sessionId: SESSION_ID, reused: true });
      const replayed = await replay.boot;
      expect(replayed.ok).toBe(true);
      if (replayed.ok) expect(replayed.result.reused).toBe(true);

      held.open();
      const booted = await first.boot;
      expect(booted.ok).toBe(true);
      expect(graph.created).toHaveLength(1);
      expect(graph.issuedAgentTokens).toHaveLength(1);
      expect(graph.manifests).toHaveLength(1);
      expect(spawnIfAbsent).toHaveBeenCalledTimes(1);
      expect(graph.transitions.filter((t) => t.status === 'running')).toHaveLength(1);
    }

    it('during the lane phase', async () => {
      await replayWhileHeld((released) => {
        const pin = graph.recordInteractionProfilePin.bind(graph);
        vi.spyOn(graph, 'recordInteractionProfilePin').mockImplementation(async (...args) => {
          await released;
          return pin(...args);
        });
      });
    });

    it('during the briefing phase', async () => {
      await replayWhileHeld((released) => {
        const record = graph.recordManifest.bind(graph);
        vi.spyOn(graph, 'recordManifest').mockImplementation(async (...args) => {
          await released;
          return record(...args);
        });
      });
    });

    it('during the agent phase', async () => {
      await replayWhileHeld((released) => {
        settlement.mockImplementation(async () => {
          await released;
          return null;
        });
      });
    });
  });
});

describe('SpawnService.admit — a worktree launch', () => {
  let dataDir: string;
  let projectDir: string;
  let worktreeRoot: string;
  let graph: FakeGraph;
  let service: SpawnService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-admit-wt-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-admit-wt-project-'));
    worktreeRoot = await mkdtemp(join(tmpdir(), 'tm8-admit-wt-root-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' });
    git('init', '--initial-branch', 'main');
    git('config', 'user.email', 'lane@test');
    git('config', 'user.name', 'lane');
    git('commit', '--allow-empty', '-m', 'root');

    graph = new FakeGraph({ workingDir: projectDir, sessionId: SESSION_ID });
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

  const WORKTREE_REQUEST = { ...REQUEST, clientMutationId: 'mutation-admit-wt', workdir: { mode: 'worktree' as const } };

  it('records the reserved path on the row before the checkout exists; the boot then checks it out there', async () => {
    const held = gate();
    const pin = graph.recordInteractionProfilePin.bind(graph);
    vi.spyOn(graph, 'recordInteractionProfilePin').mockImplementation(async (...args) => {
      await held.opened;
      return pin(...args);
    });

    const { admission, boot } = await service.admit(AUTH, WORKTREE_REQUEST);
    const [reserved] = [...graph.worktreeAllocations.values()];

    expect(graph.created[0]?.workdirPath).toBe(reserved?.path);
    expect(admission.cwd).toBe(reserved?.path);

    // While the boot runs, the reconciler leaves the reservation alone however
    // old it looks.
    graph.nodeWorktreeAllocations = [
      { ...(reserved as WorktreeAllocationRow), updatedAt: new Date(Date.now() - 3_600_000).toISOString() },
    ];
    graph.projectWorkingDirs.set(REQUEST.projectId, projectDir);
    const report = await service.reconcileNodeWorktrees(AUTH);
    expect(report.repaired.find((r) => r.worktreeId === reserved?.worktreeId)?.action).toContain('boot in flight');

    held.open();
    const outcome = await boot;

    expect(outcome.ok).toBe(true);
    expect(existsSync(join(reserved?.path ?? '', '.git'))).toBe(true);
    expect(graph.worktreeCalls.map((c) => c.call)).toEqual(['reserve', 'createEntity', 'lease', 'edge', 'state:ready']);
  });

  it('a replay abandons its own reservation: the original launch already has its checkout', async () => {
    await service.spawn(AUTH, WORKTREE_REQUEST);
    graph.replaySessionId = SESSION_ID;

    const replay = await service.admit(AUTH, WORKTREE_REQUEST);

    expect(replay.admission).toMatchObject({ sessionId: SESSION_ID, reused: true });
    const allocations = [...graph.worktreeAllocations.values()];
    expect(allocations.map((a) => a.state).sort()).toEqual(['failed', 'ready']);
    expect(allocations.find((a) => a.state === 'failed')?.failureCode).toBe('spawn_replayed');
  });
});
