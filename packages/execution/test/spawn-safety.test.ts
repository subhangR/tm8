// Spawn acknowledgement and ledger replay safety at mocked process boundaries.
// No child process is started in this suite.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { PromptSettlementWaiter } from '../src/pty/PromptSettlementWaiter.js';
import { ECHO_AGENT_CMD } from '../src/spawn/manifest.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { SpawnError } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };
const REQUEST = {
  clientMutationId: 'mutation-1',
  spaceId: '11111111-1111-4111-8111-111111111111',
  teamMemberId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  interactionProfileId: '44444444-4444-4444-8444-444444444444',
};

describe('SpawnService spawn acknowledgement safety', () => {
  let dataDir: string;
  let projectDir: string;
  let graph: FakeGraph;
  let pty: PtyHostService;
  let service: SpawnService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-spawn-safety-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-spawn-safety-project-'));
    graph = new FakeGraph({ workingDir: projectDir });
    pty = new PtyHostService();
    service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      // `assertAgentRuntime` resolves the agent binary on PATH before anything
      // this suite mocks gets a chance to run. Without an override that binary is
      // the real `claude`, so on a machine that has not installed it every spawn
      // died as `not_found` and the boot-settlement assertions below were never
      // reached — the suite passed only on a developer laptop. ECHO_AGENT_CMD is
      // the built-in smoke agent: it renders as `node <script>`, so the preflight
      // resolves against the node already running the test, and the suite keeps
      // its header promise that no child process is started.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 25,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('does not write, pin, transition, or spawn again on a command-ledger replay', async () => {
    const priorSessionId = '55555555-5555-4555-8555-555555555555';
    graph.replaySessionId = priorSessionId;
    const spawn = vi.spyOn(pty, 'spawnIfAbsent');

    const result = await service.spawn(AUTH, REQUEST);

    expect(result.sessionId).toBe(priorSessionId);
    expect(result.reused).toBe(true);
    expect(result.commandResult).toMatchObject({ entityId: priorSessionId });
    expect(spawn).not.toHaveBeenCalled();
    expect(graph.profilePins).toEqual([]);
    expect(graph.manifests).toEqual([]);
    expect(graph.transitions).toEqual([]);
  });

  it('rejects an early child death and leaves the durable session failed', async () => {
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue({ exitCode: 127, signal: null });

    let caught: unknown;
    try {
      await service.spawn(AUTH, REQUEST);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SpawnError);
    expect((caught as SpawnError).message).toContain('boot settlement window');
    expect(graph.profilePins).toHaveLength(1);
    expect(graph.manifests).toHaveLength(1);
    // `running` is not written speculatively anymore: the child died before
    // its first-turn proof, so the only durable transition is terminal.
    expect(graph.transitions.map((transition) => transition.status)).toEqual(['failed']);
    expect(graph.transitions.at(-1)).toMatchObject({
      status: 'failed',
      exitCode: 127,
      error: 'agent process exited with code 127',
    });
  });

  it('refuses spawn acknowledgement when the first turn never settles', async () => {
    const waiter = new PromptSettlementWaiter();
    const wiredPty = new PtyHostService({ onPromptSettled: waiter.resolve });
    const wiredService = new SpawnService({
      graph,
      pty: wiredPty,
      promptSettlement: waiter,
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 1,
      firstPromptSettlementMs: 10,
    });
    vi.spyOn(wiredPty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(wiredPty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    vi.spyOn(wiredPty, 'waitForBootSettlement').mockResolvedValue(null);

    try {
      await expect(
        wiredService.spawn(AUTH, {
          ...REQUEST,
          taskIds: ['66666666-6666-4666-8666-666666666666'],
        }),
      ).rejects.toThrow('first_prompt_settlement_timeout');
      expect(graph.transitions.map((transition) => transition.status)).toEqual(['failed']);
    } finally {
      wiredPty.shutdownAll();
    }
  });

  it('queues the first task through the closed loop before marking the session running', async () => {
    const promptSettlement = {
      awaitOutcome: vi.fn(async () => ({ outcome: 'delivered' as const })),
      cancel: vi.fn(),
    };
    service = new SpawnService({
      graph,
      pty,
      promptSettlement,
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 1,
    });
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
    const deliver = vi.spyOn(pty, 'deliverPrompt').mockResolvedValue(true);

    await expect(
      service.spawn(AUTH, {
        ...REQUEST,
        taskIds: ['66666666-6666-4666-8666-666666666666'],
      }),
    ).resolves.toMatchObject({ reused: false });

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[1]).toContain('<tm8_task_prompt count="1">');
    expect(graph.transitions.map((transition) => transition.status)).toEqual(['running']);
    expect(promptSettlement.cancel).not.toHaveBeenCalled();
  });

  /**
   * THE EMPTY-SESSION FIX. A provider whose binary takes a positional prompt
   * gets its first turn in ARGV, where a boot race cannot reach it — and must
   * therefore NOT also be sent through the PTY, or the agent would receive its
   * assignment twice. The test above is the mirror image: an operator wrapper
   * (`TM8_AGENT_CMD`) cannot take a positional, so it keeps the PTY path.
   *
   * Together they pin the invariant that matters: the first turn is delivered
   * exactly once, by exactly one of the two mechanisms.
   */
  it('carries the first turn in argv for a real provider, and does not also type it', async () => {
    const promptSettlement = {
      awaitOutcome: vi.fn(async () => ({ outcome: 'delivered' as const })),
      cancel: vi.fn(),
    };
    service = new SpawnService({
      graph,
      pty,
      promptSettlement,
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      // A real provider name, so `supportsPositionalPrompt` says yes. The
      // binary is never executed: `spawnIfAbsent` is mocked, and the PATH
      // preflight is stubbed so the suite keeps working on a machine that has
      // not installed the CLI (the header promise of this file).
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: 'claude' },
      bootSettlementMs: 1,
    });
    vi.spyOn(
      service as unknown as { assertAgentRuntime: () => Promise<void> },
      'assertAgentRuntime',
    ).mockResolvedValue(undefined);
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
    const deliver = vi.spyOn(pty, 'deliverPrompt').mockResolvedValue(true);

    await expect(
      service.spawn(AUTH, {
        ...REQUEST,
        taskIds: ['66666666-6666-4666-8666-666666666666'],
      }),
    ).resolves.toMatchObject({ reused: false });

    // The assignment is in the command line...
    const spawned = vi.mocked(pty.spawnIfAbsent).mock.calls[0]?.[0];
    expect(spawned?.command).toContain('<tm8_task_prompt count="1">');
    expect(spawned?.command).toContain('--append-system-prompt');
    // ...and nothing was typed into the terminal.
    expect(deliver).not.toHaveBeenCalled();
    expect(promptSettlement.awaitOutcome).not.toHaveBeenCalled();
    expect(graph.transitions.map((transition) => transition.status)).toEqual(['running']);
  });

  it('retries a failed terminal-state write after a spawn error', async () => {
    service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 25,
      failedTransitionRetryMs: 1,
    });
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'spawnIfAbsent').mockImplementation(() => {
      throw new Error('injected spawn failure');
    });
    const transition = vi.spyOn(graph, 'transition')
      .mockRejectedValueOnce(new Error('injected graph outage'))
      .mockImplementation(async (_auth, input) => {
        graph.transitions.push(input);
      });

    await expect(service.spawn(AUTH, REQUEST)).rejects.toThrow('injected spawn failure');

    expect(graph.created).toHaveLength(1);
    await vi.waitFor(() => {
      expect(graph.transitions.map((item) => item.status)).toEqual(['failed']);
    });
    expect(transition).toHaveBeenCalledTimes(2);
  });
});
