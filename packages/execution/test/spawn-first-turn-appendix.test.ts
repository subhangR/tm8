// Forms W2 spawn modes (215): a server-side spawn on another session's behalf.
//
// Two request fields carry it, and both are tested at the manifest and the
// recorded first turn rather than at argv, because these spawns run under the
// hermetic echo-agent wrapper (see spawn-posture-inheritance.test.ts):
//   * `inheritPosture` — the REQUESTER's recorded posture, in place of the
//     parent's. The spawned session must never exceed what the requester ran.
//   * `firstTurnAppendix` — the form_response envelope, appended to the first
//     turn once the session id exists, within what the combined budget leaves.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BYTE_BUDGETS, utf8Bytes } from '@tm8/prompt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import { SpawnError } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '55555555-5555-4555-8555-555555555555';
const TASK_ID = '66666666-6666-4666-8666-666666666666';
const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };

describe('a spawn on a requester\'s behalf', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;
  let graph: FakeGraph;
  let service: SpawnService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-appendix-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-appendix-proj-'));
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

  it('inherits the requester posture, narrower than its parent, and never reads the parent', async () => {
    graph.postures.set(PARENT_ID, { accessMode: 'fullAccess', permissionMode: 'bypassPermissions' });

    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      parentSessionId: PARENT_ID,
      inheritPosture: { accessMode: 'plan', permissionMode: 'readOnly' },
    });

    expect(graph.postureQueries).toEqual([]);
    expect(result.manifest.launch).toMatchObject({ accessMode: 'plan', permissionMode: 'readOnly' });
  });

  it('appends the envelope to the first turn, addressed to the minted session id', async () => {
    const seen: Array<{ sessionId: string; maxBytes: number }> = [];
    const result = await service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      taskIds: [TASK_ID],
      firstTurnAppendix: (sessionId, maxBytes) => {
        seen.push({ sessionId, maxBytes });
        return `<to session_id="${sessionId}" />`;
      },
    });

    expect(seen).toEqual([{ sessionId: result.sessionId, maxBytes: expect.any(Number) }]);
    const { prompts } = graph.manifests.find((m) => m.sessionId === result.sessionId)!;
    // The task assignment first, never cut; the appendix after it.
    expect(prompts.task).toContain(TASK_ID);
    expect(prompts.task.endsWith(`\n\n<to session_id="${result.sessionId}" />`)).toBe(true);
    expect(utf8Bytes(`${prompts.system}\n\n${prompts.task}`)).toBeLessThanOrEqual(BYTE_BUDGETS.combinedInitialInjection);
    // What it was offered is exactly what the combined budget had left.
    const before = prompts.task.slice(0, prompts.task.length - `\n\n<to session_id="${result.sessionId}" />`.length);
    expect(seen[0]!.maxBytes).toBe(
      BYTE_BUDGETS.combinedInitialInjection - utf8Bytes(`${prompts.system}\n\n${before}\n\n`));
  });

  it('refuses a launch whose appendix ignores its allowance, rather than clipping it', async () => {
    await expect(service.spawn(AUTH, {
      spaceId: SPACE_ID,
      teamMemberId: MEMBER_ID,
      firstTurnAppendix: (_sessionId, maxBytes) => 'x'.repeat(maxBytes + 1),
    })).rejects.toSatisfy((e: unknown) => e instanceof SpawnError && e.code === 'invalid_input');
  });
});
