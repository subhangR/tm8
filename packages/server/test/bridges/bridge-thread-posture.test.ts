/**
 * 444, coordinator ruling (security): a Slack thread session is grouped under
 * the bridge's target session, but launches EXACTLY as a /work worker from the
 * same bridge. It must not inherit the target's posture (access mode,
 * credential sources) and runs in mode 'worker', never as a coordinated worker
 * reporting to the target.
 *
 * Real: the bridges' worker port (createBridgeWorkerPort) and the execution
 * SpawnService's posture logic. Faked: the graph (execution's FakeGraph, whose
 * persona says `interactive`) and the agent (the hermetic echo-agent wrapper).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHostService, SpawnService, type SpawnResult } from '@tm8/execution';

import type { Db } from '../../src/db/types.js';
import { createBridgeWorkerPort } from '../../src/facade/execution-handlers.js';
import type { SpawnWorkerRequest } from '../../src/bridges/commands/ports.js';
import { FakeGraph } from '../../../execution/test/fake-graph.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '55555555-5555-4555-8555-555555555555';
const BRIDGE_ID = '66666666-6666-4666-8666-666666666666';
const ROOT_ID = '77777777-7777-4777-8777-777777777777';
const AUTH = { identityId: 'identity-1', nodeAdmin: false, requestId: 'posture' };

describe('444: a thread session does not inherit the target session posture', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  let graph: FakeGraph;
  let results: SpawnResult[];
  let port: ReturnType<typeof createBridgeWorkerPort>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-thread-posture-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-thread-posture-proj-'));
    graph = new FakeGraph({ workingDir: projectDir, permissionMode: 'interactive' });
    // The target session was launched wide open.
    graph.postures.set(TARGET_ID, { accessMode: 'fullAccess', permissionMode: 'bypassPermissions' });
    pty = new PtyHostService();
    const service = new SpawnService({
      graph, pty, baseUrl: 'http://127.0.0.1:4614', dataDir, nodeId: 'test-node',
      env: { ...process.env, TM8_AGENT_CMD: 'echo-agent' },
    });
    results = [];
    const spy = {
      spawn: async (...args: Parameters<SpawnService['spawn']>) => {
        const result = await service.spawn(...args);
        results.push(result);
        return result;
      },
    } as unknown as SpawnService;
    port = createBridgeWorkerPort({ db: {} as Db, spawnService: spy });
  });

  afterEach(async () => {
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  const request = (over: Partial<SpawnWorkerRequest>): SpawnWorkerRequest => ({
    spaceId: SPACE_ID, teamMemberId: MEMBER_ID, taskId: null, projectId: null, effort: null,
    title: 'Thread', clientMutationId: `m-${Math.random()}`,
    origins: [{ bridgeId: BRIDGE_ID, messageId: ROOT_ID, providerMessageId: '1790000000.000100', sender: {}, command: '/thread' }],
    ...over,
  });

  it('keeps the parent link, but launches on the persona posture as a worker, like /work', async () => {
    await port.spawnWorker(AUTH, request({ parentSessionId: TARGET_ID }));
    await port.spawnWorker(AUTH, request({ parentSessionId: null, origins: [{ ...request({}).origins[0]!, command: '/work' }] }));
    const [thread, work] = results;

    // The target's posture is never even read.
    expect(graph.postureQueries).toEqual([]);
    expect(thread!.launchFacts).toMatchObject({ parentSessionId: TARGET_ID, accessMode: 'safe', accessModeSource: 'persona' });
    expect(thread!.manifest.launch).toMatchObject({ permissionMode: 'interactive', accessMode: 'safe' });
    // A worker, not a coordinated worker briefed to report to the target.
    expect(thread!.manifest.mode).toBe('worker');
    expect(thread!.manifest.coordinator).toBeNull();
    expect(thread!.manifest.launch.permissionMode).not.toBe('bypassPermissions');

    // Exactly the posture a /work worker from the same bridge gets.
    expect(work!.launchFacts).toMatchObject({ parentSessionId: null, accessMode: 'safe', accessModeSource: 'persona' });
    expect(thread!.manifest.mode).toBe(work!.manifest.mode);
    for (const key of ['permissionMode', 'accessMode'] as const) {
      expect(thread!.manifest.launch[key]).toBe(work!.manifest.launch[key]);
    }
    expect(thread!.launchFacts?.credentials).toEqual(work!.launchFacts?.credentials);
  });
});
