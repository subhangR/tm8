// Launch v3 (lane C): a spawn's own task (`newTask`), and a dispatcher launched
// on a task ROUTES it (DISPATCH verb + Launch).
//
// Asserted at the manifest and the recorded first turn, under the hermetic
// echo-agent wrapper, like spawn-first-turn-appendix.test.ts. The SQL half —
// the task created in the spawn transaction and the dispatcher's missing
// working_on / assigned_to edges — is the server's launch-v3-new-task.pg test.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '66666666-6666-4666-8666-666666666666';
const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };

describe('launch v3: newTask and dispatcher routing', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  let graph: FakeGraph;
  let service: SpawnService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-launch-v3-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-launch-v3-proj-'));
    graph = new FakeGraph({ workingDir: projectDir, permissionMode: 'interactive' });
    pty = new PtyHostService();
    service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      nodeId: 'test-node',
      env: { ...process.env, TM8_AGENT_CMD: 'echo-agent' },
    });
  });

  afterEach(async () => {
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('hands newTask to the spawn RPC and assigns the created task in the first turn', async () => {
    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      newTask: { title: 'Fix the flaky test' },
    });

    expect(graph.created.at(-1)?.newTaskTitle).toBe('Fix the flaky test');
    expect(result.createdTaskId).toEqual(expect.any(String));
    expect(result.routedTaskIds).toBeUndefined();
    const created = result.manifest.tasks.find((t) => t.id === result.createdTaskId);
    expect(created).toMatchObject({ title: 'Fix the flaky test', status: 'working', version: 2 });
    const { prompts } = graph.manifests.find((m) => m.sessionId === result.sessionId)!;
    expect(prompts.task).toContain(result.createdTaskId!);
    expect(prompts.task).toContain('kind="task_assignment"');
  });

  it('gives a dispatcher launched on a task a routing turn, not an assignment', async () => {
    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      taskIds: [TASK_ID],
      mode: 'dispatcher',
    });

    expect(result.routedTaskIds).toEqual([TASK_ID]);
    // The RPC still receives the task: it is 267's SQL that declines to write
    // the dispatcher as working on or assigned to it.
    expect(graph.created.at(-1)?.taskIds).toEqual([TASK_ID]);
    expect(result.manifest.tasks).toEqual([]);
    const { prompts } = graph.manifests.find((m) => m.sessionId === result.sessionId)!;
    expect(prompts.task).toContain('kind="dispatch_request"');
    expect(prompts.task).toContain(`<dispatch task_id="${TASK_ID}"`);
    expect(prompts.task).toContain(`<to session_id="${result.sessionId}" />`);
    expect(prompts.task).not.toContain('kind="task_assignment"');
  });

  it('routes a dispatcher\'s newTask too', async () => {
    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      newTask: { title: 'Route this new work' },
      mode: 'dispatcher',
    });

    expect(result.routedTaskIds).toEqual([result.createdTaskId]);
    const { prompts } = graph.manifests.find((m) => m.sessionId === result.sessionId)!;
    expect(prompts.task).toContain(`<dispatch task_id="${result.createdTaskId}"`);
  });

  it('leaves a dispatcher launched on nothing exactly as it was', async () => {
    const result = await service.spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID, mode: 'dispatcher' });
    expect(result.routedTaskIds).toBeUndefined();
    const { prompts } = graph.manifests.find((m) => m.sessionId === result.sessionId)!;
    expect(prompts.task).not.toContain('dispatch_request');
  });
});
