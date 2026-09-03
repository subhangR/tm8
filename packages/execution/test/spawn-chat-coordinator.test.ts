// 176 — A CHAT SPAWNS A WORKER, AND THE WORKER IS TOLD SO.
//
// Before 176 a chat had no entity id, so every worker a chat dispatched was
// born parentless and its `<reply_address>` pointed at nothing. Now a chat may
// parent a work session, which means the id in `coordinator_session_id` is no
// longer necessarily a work session — and a worker that assumes it is will go
// looking for a terminal, a transcript and a coordinator agent that do not
// exist, then wonder why nobody answered.
//
// The assertions here are on the COMPOSED PROMPT as well as the manifest,
// because the manifest is a document nobody reads aloud: the prompt is what the
// agent is actually told, and every layer between the graph read and that
// sentence is a place the fact can be silently dropped. `spawn-manifest.test.ts`
// owns the composition unit; this owns the chain.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composePrompt } from '@tm8/prompt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { FakeGraph } from './fake-graph.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const CHAT_ID = '66666666-6666-4666-8666-666666666666';
const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };

describe('a worker whose coordinator is a chat', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;

  async function serviceOver(parentKind: 'chat' | 'work_session' | null) {
    const graph = new FakeGraph({ workingDir: projectDir, parentKind });
    const service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4615',
      dataDir,
      nodeId: 'test-node',
      env: { ...process.env, TM8_AGENT_CMD: 'echo-agent' },
    });
    return { graph, service };
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-chatcoord-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-chatcoord-proj-'));
    pty = new PtyHostService();
  });

  afterEach(async () => {
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('asks the graph what the parent IS, in the same read as the persona', async () => {
    const { graph, service } = await serviceOver('chat');

    await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      parentSessionId: CHAT_ID,
      mode: 'coordinated-worker',
    });

    // One read, not two: the persona and the parent's kind must describe the
    // same instant, which is the whole reason loadSpawnContext is a transaction.
    expect(graph.spawnContextInputs).toHaveLength(1);
    expect(graph.spawnContextInputs[0]?.parentSessionId).toBe(CHAT_ID);
  });

  it('carries the chat all the way into the sentence the agent reads', async () => {
    const { service } = await serviceOver('chat');

    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      parentSessionId: CHAT_ID,
      mode: 'coordinated-worker',
    });

    expect(result.manifest.coordinator).toEqual({ sessionId: CHAT_ID, kind: 'chat' });

    const { system } = composePrompt(result.manifest, { sessionId: result.sessionId });
    expect(system).toContain(`<coordinator_session_id>${CHAT_ID}</coordinator_session_id>`);
    expect(system).toContain('<coordinator_kind>chat</coordinator_kind>');
    expect(system).toMatch(/A CHAT spawned you/);
    // The transport is unchanged — a chat is an anchor like any other, and the
    // brief must not invent a second protocol for reaching one.
    expect(system).toContain('tm8 message send --to &lt;coordinator-session-id&gt;');
  });

  it('still says work_session when a work session is the parent', async () => {
    const { service } = await serviceOver('work_session');

    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      parentSessionId: CHAT_ID,
      mode: 'coordinated-worker',
    });

    expect(result.manifest.coordinator).toEqual({
      sessionId: CHAT_ID,
      kind: 'work_session',
    });
    const { system } = composePrompt(result.manifest, { sessionId: result.sessionId });
    expect(system).toContain('<coordinator_kind>work_session</coordinator_kind>');
    expect(system).not.toMatch(/A CHAT spawned you/);
  });

  it('launches on the pre-176 reading when the parent kind cannot be resolved', async () => {
    // A label the loader could not read must not refuse a launch: the thing a
    // coordinated mode actually requires is the return ADDRESS, and that guard
    // lives in resolveCoordinatorSessionId.
    const { service } = await serviceOver(null);

    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      parentSessionId: CHAT_ID,
      mode: 'coordinated-worker',
    });

    expect(result.manifest.coordinator).toEqual({
      sessionId: CHAT_ID,
      kind: 'work_session',
    });
  });

  it('passes a null parent for a root spawn rather than omitting the field', async () => {
    const { graph, service } = await serviceOver(null);

    await service.spawn(AUTH, { spaceId: SPACE_ID, teamMemberId: MEMBER_ID });

    expect(graph.spawnContextInputs[0]?.parentSessionId).toBeNull();
  });
});
