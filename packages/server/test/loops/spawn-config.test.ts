/**
 * `spawnRequestForLoop` — the §3.4 "spawn" mapping (PR3, task 01a182d5-e482).
 *
 * The regression this guards: before PR3 a loop firing sent only `model`,
 * `agentTool` and `accessMode` and FORCED `projectId` to null, so a loop could
 * not run in a project checkout, pick a reasoning effort or hand over
 * memories. Each `LoopSpawnConfig` field is asserted to arrive on the request
 * under the name `execution.spawn` would have given it.
 */
import { describe, expect, it } from 'vitest';
import { CollabError } from '@tm8/contract';
import { loopSpawnConfig, spawnRequestForLoop } from '../../src/loops/spawn-config.js';

const loop = {
  spaceId: '00000000-0000-4000-8000-00000000aaaa',
  teamMemberId: '00000000-0000-4000-8000-00000000bbbb',
  title: 'Nightly check',
  prompt: 'sweep the graph',
};
const TASK = '00000000-0000-4000-8000-00000000cccc';
const PROJECT = '00000000-0000-4000-8000-0000000000d1';
const PROFILE = '00000000-0000-4000-8000-0000000000e1';
const MEMORY_A = '00000000-0000-4000-8000-0000000000f1';
const MEMORY_B = '00000000-0000-4000-8000-0000000000f2';

describe('spawnRequestForLoop', () => {
  it('maps every LoopSpawnConfig field 1:1 onto the SpawnRequest, projectId included', () => {
    const request = spawnRequestForLoop({
      ...loop,
      config: {
        model: 'claude-opus-5-5',
        agentTool: 'claude-code',
        reasoningEffort: 'xhigh',
        accessMode: 'acceptEdits',
        mode: 'coordinated-worker',
        projectId: PROJECT,
        workdir: { mode: 'worktree', baseRef: 'origin/main' },
        memoryIds: [MEMORY_A, MEMORY_B],
        credentialSource: 'space',
        interactionProfileId: PROFILE,
      },
    }, TASK, 'loop-1:2026-10-28T20:00:00.000Z');

    expect(request).toEqual({
      spaceId: loop.spaceId,
      teamMemberId: loop.teamMemberId,
      parentSessionId: null,
      taskIds: [TASK],
      projectId: PROJECT,
      workdir: { mode: 'worktree', baseRef: 'origin/main' },
      interactionProfileId: PROFILE,
      mode: 'coordinated-worker',
      model: 'claude-opus-5-5',
      agentTool: 'claude-code',
      reasoningEffort: 'xhigh',
      accessMode: 'acceptEdits',
      credentialSource: 'space',
      memoryIds: [MEMORY_A, MEMORY_B],
      title: 'Nightly check',
      promptExtra: 'sweep the graph',
      clientMutationId: 'loop-fire:loop-1:2026-10-28T20:00:00.000Z',
    });
    // The provenance root is a SERVER FACT in spawn's second argument (348),
    // never a request field a client could have set.
    expect(request).not.toHaveProperty('triggeredByLoopId');
  });

  it('with no config at all, nullable fields are null and optional ones are ABSENT, not undefined', () => {
    const request = spawnRequestForLoop({ ...loop, prompt: '', config: null }, TASK, 'k');
    expect(request).toEqual({
      spaceId: loop.spaceId,
      teamMemberId: loop.teamMemberId,
      parentSessionId: null,
      taskIds: [TASK],
      projectId: null,
      mode: null,
      model: null,
      agentTool: null,
      reasoningEffort: null,
      accessMode: null,
      credentialSource: null,
      title: 'Nightly check',
      promptExtra: null,
      clientMutationId: 'loop-fire:k',
    });
    // `SpawnRequest` is written under exactOptionalPropertyTypes: an explicit
    // `undefined` for workdir/memoryIds/interactionProfileId is not an absence.
    for (const key of ['workdir', 'interactionProfileId', 'memoryIds']) expect(request).not.toHaveProperty(key);
  });

  it('keeps a workdir with no baseRef, a null baseRef, and drops an empty memory list', () => {
    expect(spawnRequestForLoop({ ...loop, config: { workdir: { mode: 'scratch' }, memoryIds: [] } }, TASK, 'k'))
      .toMatchObject({ workdir: { mode: 'scratch' } });
    expect(spawnRequestForLoop({ ...loop, config: { workdir: { mode: 'scratch' } } }, TASK, 'k').workdir)
      .not.toHaveProperty('baseRef');
    expect(spawnRequestForLoop({ ...loop, config: { workdir: { mode: 'project', baseRef: null } } }, TASK, 'k').workdir)
      .toEqual({ mode: 'project', baseRef: null });
    expect(spawnRequestForLoop({ ...loop, config: { memoryIds: [] } }, TASK, 'k')).not.toHaveProperty('memoryIds');
  });

  it('explicit nulls in the stored config read as "not set"', () => {
    const request = spawnRequestForLoop({
      ...loop,
      config: { model: null, projectId: null, workdir: null, interactionProfileId: null, credentialSource: null },
    }, TASK, 'k');
    expect(request.projectId).toBeNull();
    expect(request.model).toBeNull();
    expect(request).not.toHaveProperty('workdir');
    expect(request).not.toHaveProperty('interactionProfileId');
  });
});

describe('loopSpawnConfig at fire time', () => {
  it('strips an unknown key (a pre-schema row must still fire) but refuses an invalid known value', () => {
    expect(loopSpawnConfig({ model: 'm', legacyKey: true })).toEqual({ model: 'm' });
    let error: unknown;
    try { loopSpawnConfig({ accessMode: 'root' }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(CollabError);
    expect(error).toMatchObject({ code: 'invalid_input', details: { field: 'definition.config' } });
    expect((error as Error).message).toContain('accessMode');
  });

  it('reads null and undefined as an empty config', () => {
    expect(loopSpawnConfig(null)).toEqual({});
    expect(loopSpawnConfig(undefined)).toEqual({});
  });
});
