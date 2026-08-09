// Spawn acknowledgement and ledger replay safety at mocked process boundaries.
// No child process is started in this suite.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
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
    expect(graph.transitions.map((transition) => transition.status)).toEqual(['running', 'failed']);
    expect(graph.transitions.at(-1)).toMatchObject({
      status: 'failed',
      exitCode: 127,
      error: 'agent process exited with code 127',
    });
  });
});
