// Prompt v2 on the live spawn path (spec ca8d §2): a profile that opts a
// worker into `tm8.core.v2` stamps the manifest, and the first turn embeds the
// task's context DTO rendered for the new session — or degrades visibly.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const DTO = {
  schemaVersion: 'tm8.entity-context.v2',
  id: TASK_ID,
  kind: 'task',
  version: 7,
  status: 'working',
  acceptance: [{ id: 'c1', done: false, text: 'ship it' }],
  asOfSeq: 4242,
};

describe('SpawnService prompt v2', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-v2-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-v2-project-'));
    pty = new PtyHostService();
    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false } as never);
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  async function spawn(options: Omit<FakeGraphOptions, 'workingDir'>) {
    const graph = new FakeGraph({ workingDir: projectDir, sessionId: '55555555-5555-4555-8555-555555555555', ...options });
    const service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4611',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TM8_AGENT_CMD: ECHO_AGENT_CMD },
      bootSettlementMs: 25,
    });
    await service.spawn(AUTH, REQUEST);
    return { graph, recorded: graph.manifests[0]! };
  }

  it('keeps v1, and renders no context, when the profile does not opt in', async () => {
    const { graph, recorded } = await spawn({});
    expect(recorded.manifest.promptVersion).toBe('1');
    expect(graph.taskContextReads).toEqual([]);
    expect(recorded.prompts.system).toContain('<tm8_system_prompt version="1.0"');
  });

  it('embeds the DTO rendered as the new session, and no raw body', async () => {
    const { graph, recorded } = await spawn({ profileSnapshot: V2_PROFILE, taskContext: DTO });
    expect(recorded.manifest.promptVersion).toBe('2');
    expect(graph.taskContextReads).toHaveLength(1);
    expect(graph.taskContextReads[0]).toMatchObject({
      auth: AUTH,
      sessionId: recorded.sessionId,
      taskId: TASK_ID,
      totalBytes: 16384,
    });
    expect(recorded.prompts.system).toContain('<tm8_system_prompt version="2.0" mode="worker">');
    // The session cwd, not a project-root fallback (task 01a0cf21-4560).
    expect(recorded.prompts.system).toContain(`cwd="${recorded.manifest.session.workingDirectory}"`);
    expect(recorded.prompts.task).toContain(`task="${TASK_ID}" version="7" as_of_seq="4242"`);
    expect(recorded.prompts.task).toContain(`<untrusted_data type="entity-context" encoding="json">${JSON.stringify(DTO)}</untrusted_data>`);
    expect(recorded.prompts.task).not.toContain('Description:');
    expect(recorded.prompts.system).not.toContain('<repo>');
  });

  it('adds the graph line when the session cwd holds a code graph', async () => {
    await mkdir(join(projectDir, 'graphify-out'));
    await writeFile(join(projectDir, 'graphify-out', 'merged-graph.json'), '{}');
    const { recorded } = await spawn({ profileSnapshot: V2_PROFILE, taskContext: DTO });
    expect(recorded.prompts.system).toContain('<repo>');
  });

  it('launches degraded, never refused, when the render fails', async () => {
    const failure = Object.assign(new Error('boom'), { code: 'upstream_unavailable' });
    const { recorded } = await spawn({ profileSnapshot: V2_PROFILE, taskContext: failure });
    expect(recorded.prompts.task).toContain('snapshot="unavailable" reason="upstream_unavailable"');
    expect(recorded.prompts.task).toContain(`Run \`tm8 entity context ${TASK_ID}\` before anything else.`);
  });
});
