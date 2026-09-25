// The task turn's version is the task's version AFTER the spawn started it
// (task 01a0daa4-ed02). `loadSpawnContext` reads before `execution_spawn`,
// which moves an unstarted task to `working` and bumps its version, so every
// version the prompt rendered was one behind, and an agent that used it on its
// first versioned write (`tm8 task tick … --expect-version`) was refused with
// version_conflict: 6 of 6 D13 re-run lanes that ticked from the turn.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { ECHO_AGENT_CMD } from '../src/spawn/manifest.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph, type FakeGraphOptions } from './fake-graph.js';

const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST = {
  clientMutationId: 'mutation-1',
  spaceId: '11111111-1111-4111-8111-111111111111',
  teamMemberId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  taskIds: [TASK_ID],
};
const V2_PROFILE = { agentProjection: { promptPolicy: { kernelTemplate: 'tm8.core.v2' } } };

describe('the task turn renders the version the agent will write against', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  const warnings: unknown[][] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-version-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-version-project-'));
    pty = new PtyHostService();
    warnings.length = 0;
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false } as never);
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  async function spawn(options: Omit<FakeGraphOptions, 'workingDir'>, arrange?: (graph: FakeGraph) => void) {
    const graph = new FakeGraph({ workingDir: projectDir, sessionId: '55555555-5555-4555-8555-555555555555', ...options });
    arrange?.(graph);
    const service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4611',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 25,
      logger: { info: () => {}, error: () => {}, debug: () => {}, warn: (...args: unknown[]) => warnings.push(args) } as never,
    });
    await service.spawn(AUTH, REQUEST);
    return { graph, recorded: graph.manifests[0]! };
  }

  /** The task as the server holds it when the agent sends its first request. */
  const atFirstRequest = (graph: FakeGraph) => graph.taskState.get(TASK_ID)!;

  it('v1: the manifest and the trusted <task> line carry the post-start version and status', async () => {
    const { graph, recorded } = await spawn({});
    const current = atFirstRequest(graph);
    expect(current).toEqual({ version: 2, status: 'working' });
    expect(graph.taskVersionReads).toEqual([[TASK_ID]]);
    expect(recorded.manifest.tasks[0]).toMatchObject({ id: TASK_ID, version: current.version, status: current.status });
    expect(recorded.prompts.task).toContain(`<task id="${TASK_ID}" version="${current.version}" />`);
    expect(recorded.prompts.task).toContain('Status: working');
    expect(recorded.prompts.task).not.toContain(`<task id="${TASK_ID}" version="1"`);
  });

  it('v2 without a snapshot: the header names the post-start version', async () => {
    const { graph, recorded } = await spawn({ profileSnapshot: V2_PROFILE, taskContext: new Error('render failed') });
    expect(recorded.manifest.promptVersion).toBe('2');
    expect(recorded.prompts.task).toContain(`task="${TASK_ID}" version="${atFirstRequest(graph).version}"`);
    expect(recorded.prompts.task).not.toContain(`task="${TASK_ID}" version="1"`);
  });

  it('reads the version rather than predicting it: a task already started keeps its own', async () => {
    const { graph, recorded } = await spawn({}, (g) => g.taskState.set(TASK_ID, { version: 5, status: 'working' }));
    expect(atFirstRequest(graph)).toEqual({ version: 5, status: 'working' });
    expect(recorded.prompts.task).toContain(`<task id="${TASK_ID}" version="5" />`);
  });

  it('a failed read never fails the launch: it keeps the pre-spawn values and warns', async () => {
    const { recorded } = await spawn({}, (g) => {
      g.loadTaskVersions = async () => {
        throw new Error('read refused');
      };
    });
    expect(recorded.manifest.tasks[0]).toMatchObject({ id: TASK_ID, version: 1, status: 'open' });
    expect(warnings.some(([message]) => String(message).includes('task versions not refreshed'))).toBe(true);
  });
});
