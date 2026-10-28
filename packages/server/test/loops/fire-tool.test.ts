/**
 * The `action='tool'` branch of `createLoopExecutorPort.fire` against a FAKE
 * tool runtime (PR3, task 01a182d5-e482; seam ruled on 01a182ca, built by
 * Tools PR-C as `ToolRuntime.runScheduled`).
 *
 * The runtime is faked on purpose: its own contract (pinned version, marked
 * edge, mint, replay) is proved in test/tools/scheduled-runs*.test.ts. What
 * this file asserts is the LOOP SIDE of the seam — exactly what the port hands
 * the runtime, that it hands it under the firing's own claims, that it writes
 * nothing of its own (no derived task, no loop-side `triggered_by`), and that
 * the runtime's refusals reach the job unchanged so they land as `last_error`.
 */
import { describe, expect, it, vi } from 'vitest';
import { CollabError } from '@tm8/contract';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createLoopExecutorPort } from '../../src/facade/execution-handlers.js';
import { firingKeyFor } from '../../src/loops/firing.js';
import type { DueLoop } from '../../src/scheduler/jobs/loops.js';
import type { ToolRuntime } from '../../src/tools/runtime.js';

const LOOP = '00000000-0000-4000-8000-0000000000a1';
const SPACE = '00000000-0000-4000-8000-0000000000b1';
const PERSONA = '00000000-0000-4000-8000-0000000000c1';
const TOOL = '00000000-0000-4000-8000-0000000000d1';
const AT = new Date('2026-10-28T20:00:00.000Z');
const CLAIMS: DbClaims = { identityId: 'loop-armer', nodeAdmin: false, requestId: `loop-executor:${LOOP}` };

type ToolLoop = DueLoop & { action: 'spawn' | 'dispatch' | 'tool'; toolId: string | null; toolInputs: Record<string, unknown> };
function toolLoop(over: Partial<ToolLoop> = {}): ToolLoop {
  return {
    entityId: LOOP, spaceId: SPACE, title: 'Nightly check', schedule: 'every 1d',
    teamMemberId: PERSONA, subjectId: null, prompt: '', config: null, version: 1, actAsIdentity: 'loop-armer',
    action: 'tool', toolId: TOOL, toolInputs: { target: 'db-1' },
    ...over,
  };
}

interface Recorded { rpcs: Array<{ fn: string; args: readonly unknown[] }>; queries: string[] }

/** A Db that records every write and answers only the reads the port may make. */
function fakeDb(loopRow?: { action: string | null; toolId: string | null; toolInputs: Record<string, unknown> | null }): { db: Db; rec: Recorded } {
  const rec: Recorded = { rpcs: [], queries: [] };
  const db = {
    query: async (_c: DbClaims, sql: string) => {
      rec.queries.push(sql);
      if (sql.includes('from public.loops')) return loopRow ? [loopRow] : [];
      throw new Error(`unexpected query: ${sql}`);
    },
    rpc: async (_c: DbClaims, fn: string, args: readonly unknown[] = []) => {
      rec.rpcs.push({ fn, args });
      if (fn === 'public.derive_task_for_entity') return { taskId: 'task-1' };
      return {};
    },
    tx: async <T>(_c: DbClaims, fn: (q: unknown) => Promise<T>) => fn({
      query: async () => [],
      rpc: async (fn: string, args: readonly unknown[] = []) => { rec.rpcs.push({ fn, args }); return {}; },
    }),
  } as unknown as Db;
  return { db, rec };
}

/** A runtime that replays a seen firingKey, as the real one does through the ledger. */
function fakeRuntime(behaviour: 'ok' | Error = 'ok') {
  const seen = new Map<string, string>();
  const calls: Array<{ claims: DbClaims; request: Parameters<ToolRuntime['runScheduled']>[1] }> = [];
  const runScheduled = vi.fn(async (claims: DbClaims, request: Parameters<ToolRuntime['runScheduled']>[1]) => {
    calls.push({ claims, request });
    if (behaviour !== 'ok') throw behaviour;
    const existing = seen.get(request.firingKey);
    const sessionId = existing ?? `session-${seen.size + 1}`;
    seen.set(request.firingKey, sessionId);
    return { sessionId, toolVersion: 3, sourceSha256: 'b'.repeat(64) };
  });
  return { tools: { runScheduled }, calls };
}

function port(opts: { db: Db; tools?: Pick<ToolRuntime, 'runScheduled'>; spawn?: ReturnType<typeof vi.fn> }) {
  const spawn = opts.spawn ?? vi.fn(async () => ({ sessionId: 'session-spawned' }));
  const p = createLoopExecutorPort({
    db: opts.db,
    pty: { liveSessionIds: () => [] } as never,
    spawnService: { spawn } as never,
    resolveOwner: async () => ({ identityId: 'owner', isNodeAdmin: true }) as never,
    ...(opts.tools ? { tools: opts.tools } : {}),
  });
  return { port: p, spawn };
}

describe('a tool firing', () => {
  it('calls exactly runScheduled(claims, { toolId, inputs, firingKey, triggeredByLoopId, runAsTeamMemberId, title }) and returns { taskId: null, sessionId }', async () => {
    const { db, rec } = fakeDb();
    const runtime = fakeRuntime();
    const { port: p, spawn } = port({ db, tools: runtime.tools });

    const fired = await p.fire(toolLoop(), CLAIMS, AT);

    expect(fired).toEqual({ taskId: null, sessionId: 'session-1' });
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]!.claims).toBe(CLAIMS); // the firing's own claims, never a substitute
    expect(runtime.calls[0]!.request).toEqual({
      toolId: TOOL,
      inputs: { target: 'db-1' },
      firingKey: `${LOOP}:2026-10-28T20:00:00.000Z`,
      triggeredByLoopId: LOOP,
      runAsTeamMemberId: PERSONA,
      title: 'Nightly check',
    });
    // The loop side writes NOTHING: no derived task, no triggered_by, no spawn.
    expect(rec.rpcs).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    // And reads nothing when the due row already carries the runner columns.
    expect(rec.queries).toEqual([]);
  });

  it('omits runAsTeamMemberId for a persona-less tool loop (tm8Access none needs none)', async () => {
    const runtime = fakeRuntime();
    const { port: p } = port({ db: fakeDb().db, tools: runtime.tools });
    await p.fire(toolLoop({ teamMemberId: null }), CLAIMS, AT);
    expect(runtime.calls[0]!.request).not.toHaveProperty('runAsTeamMemberId');
  });

  it('surfaces the runtime\'s invalid_input UNCHANGED (stale inputs, named) and writes nothing', async () => {
    const refusal = new CollabError('invalid_input', 'Loop inputs do not fit tool nightly v3: tagret (not declared); target (required)');
    const { db, rec } = fakeDb();
    const runtime = fakeRuntime(refusal);
    const { port: p } = port({ db, tools: runtime.tools });

    await expect(p.fire(toolLoop({ toolInputs: { tagret: 'db-1' } }), CLAIMS, AT)).rejects.toBe(refusal);
    // The job records error.message as the run's launch error and last_error:
    // the text must be the runtime's, naming every offending input.
    expect(refusal.message).toContain('tagret (not declared); target (required)');
    expect(rec.rpcs).toEqual([]);
  });

  it.each([
    ['a launch failure', new CollabError('upstream_unavailable', 'Tool launch failed')],
    ['a refused mint', new CollabError('forbidden', 'loop tool bearer acts only as the loop\'s runs-as persona')],
    ['an unavailable credential', new CollabError('forbidden', 'Tool credential is unavailable')],
    ['the member cap', new CollabError('limit_exceeded', 'Tool session cap of 8 reached; idle keep-open shells count. Close an open tool tab and retry.')],
    ['a stale source', new CollabError('version_conflict', 'tool source changed or execution settings changed; reload before running')],
    ['a non-contract error', new Error('socket hang up')],
  ])('propagates %s as-is, so the job records its message', async (_label, error) => {
    const { db, rec } = fakeDb();
    const runtime = fakeRuntime(error);
    const { port: p, spawn } = port({ db, tools: runtime.tools });
    await expect(p.fire(toolLoop(), CLAIMS, AT)).rejects.toBe(error);
    expect(rec.rpcs).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses with not_implemented on a node without a tool runtime, before touching anything', async () => {
    const { db, rec } = fakeDb();
    const { port: p, spawn } = port({ db });
    await expect(p.fire(toolLoop(), CLAIMS, AT)).rejects.toMatchObject({ code: 'not_implemented' });
    expect(rec.rpcs).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a tool loop that names no tool as an invariant violation', async () => {
    const runtime = fakeRuntime();
    const { port: p } = port({ db: fakeDb().db, tools: runtime.tools });
    await expect(p.fire(toolLoop({ toolId: null }), CLAIMS, AT)).rejects.toMatchObject({ code: 'invariant_violation' });
    expect(runtime.calls).toEqual([]);
  });
});

describe('one firingKey on both paths (PR-C\'s binding rule)', () => {
  it('a retry of one firing hands the runtime the SAME key, so it replays; the next firing is a new run', async () => {
    const runtime = fakeRuntime();
    const { port: p } = port({ db: fakeDb().db, tools: runtime.tools });

    const first = await p.fire(toolLoop(), CLAIMS, AT);
    const retry = await p.fire(toolLoop(), CLAIMS, AT);
    const next = await p.fire(toolLoop(), CLAIMS, new Date('2026-10-28T20:05:00.000Z'));

    expect(runtime.calls.map((c) => c.request.firingKey)).toEqual([
      `${LOOP}:2026-10-28T20:00:00.000Z`, `${LOOP}:2026-10-28T20:00:00.000Z`, `${LOOP}:2026-10-28T20:05:00.000Z`,
    ]);
    expect(retry.sessionId).toBe(first.sessionId);
    expect(next.sessionId).not.toBe(first.sessionId);
    // The port never builds the cmid itself: `tool-fire:` is the runtime's prefix.
    for (const call of runtime.calls) expect(call.request.firingKey.startsWith('tool-fire:')).toBe(false);
  });

  it('a claimed run id IS the key, on the tool path and on the spawn path alike', async () => {
    const runtime = fakeRuntime();
    const spawn = vi.fn(async () => ({ sessionId: 'session-spawned' }));
    const { port: p } = port({ db: fakeDb().db, tools: runtime.tools, spawn });

    await p.fire(toolLoop(), CLAIMS, AT, 'run-77');
    await p.fire(toolLoop({ action: 'spawn', toolId: null, toolInputs: {} }), CLAIMS, AT, 'run-78');

    expect(runtime.calls[0]!.request.firingKey).toBe('run-77');
    expect(spawn.mock.calls[0]![1]).toMatchObject({ clientMutationId: 'loop-fire:run-78' });
    expect(firingKeyFor({ entityId: LOOP }, AT, 'run-77')).toBe('run-77');
    expect(firingKeyFor({ entityId: LOOP }, AT)).toBe(`${LOOP}:2026-10-28T20:00:00.000Z`);
    expect(firingKeyFor({ entityId: LOOP }, AT, null)).toBe(`${LOOP}:2026-10-28T20:00:00.000Z`);
  });

  it('the spawn cmid and the tool key derive from one value for one firing', async () => {
    const runtime = fakeRuntime();
    const spawn = vi.fn(async () => ({ sessionId: 'session-spawned' }));
    const { port: p } = port({ db: fakeDb().db, tools: runtime.tools, spawn });
    await p.fire(toolLoop(), CLAIMS, AT);
    await p.fire(toolLoop({ action: 'spawn', toolId: null, toolInputs: {} }), CLAIMS, AT);
    const toolKey = runtime.calls[0]!.request.firingKey;
    expect((spawn.mock.calls[0]![1] as { clientMutationId: string }).clientMutationId).toBe(`loop-fire:${toolKey}`);
  });
});

describe('the interim runner read (deleted once DueLoop carries action/toolId/toolInputs)', () => {
  it('a due row without an action is read from public.loops under the firing claims, and a tool loop fires as a tool', async () => {
    const { db, rec } = fakeDb({ action: 'tool', toolId: TOOL, toolInputs: { target: 'db-1' } });
    const runtime = fakeRuntime();
    const { port: p, spawn } = port({ db, tools: runtime.tools });
    const legacyRow: DueLoop = {
      entityId: LOOP, spaceId: SPACE, title: 'Nightly check', schedule: 'every 1d',
      teamMemberId: PERSONA, subjectId: null, prompt: '', config: null, version: 1, actAsIdentity: 'loop-armer',
    };
    const fired = await p.fire(legacyRow, CLAIMS, AT);
    expect(fired).toEqual({ taskId: null, sessionId: 'session-1' });
    expect(rec.queries).toHaveLength(1);
    expect(rec.queries[0]).toContain('from public.loops');
    expect(runtime.calls[0]!.request).toMatchObject({ toolId: TOOL, inputs: { target: 'db-1' } });
    expect(spawn).not.toHaveBeenCalled();
    expect(rec.rpcs).toEqual([]);
  });

  it('a pre-378 row with no action keeps its old meaning: runner → spawn, no runner → dispatch (no tool call)', async () => {
    const { db } = fakeDb({ action: null, toolId: null, toolInputs: null });
    const runtime = fakeRuntime();
    const spawn = vi.fn(async () => ({ sessionId: 'session-spawned' }));
    const { port: p } = port({ db, tools: runtime.tools, spawn });
    const row: DueLoop = {
      entityId: LOOP, spaceId: SPACE, title: 'Legacy', schedule: 'every 1d',
      teamMemberId: PERSONA, subjectId: null, prompt: 'do it', config: { model: 'm' }, version: 1, actAsIdentity: 'loop-armer',
    };
    const fired = await p.fire(row, CLAIMS, AT);
    expect(fired).toEqual({ taskId: 'task-1', sessionId: 'session-spawned' });
    expect(runtime.calls).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('the spawn branch carries the whole config (ac1)', () => {
  it('every LoopSpawnConfig field reaches SpawnService.spawn, with the loop id only in the server facts', async () => {
    const { db, rec } = fakeDb();
    const spawn = vi.fn(async () => ({ sessionId: 'session-spawned' }));
    const { port: p } = port({ db, spawn });
    const PROJECT = '00000000-0000-4000-8000-0000000000e1';
    const PROFILE = '00000000-0000-4000-8000-0000000000e2';
    const MEMORY = '00000000-0000-4000-8000-0000000000e3';
    const fired = await p.fire(toolLoop({
      action: 'spawn', toolId: null, toolInputs: {}, prompt: 'sweep',
      config: {
        model: 'claude-opus-5-5', agentTool: 'claude-code', reasoningEffort: 'high', accessMode: 'plan',
        mode: 'worker', projectId: PROJECT, workdir: { mode: 'worktree', baseRef: 'origin/main' },
        memoryIds: [MEMORY], credentialSource: 'node', interactionProfileId: PROFILE,
      },
    }), CLAIMS, AT);

    expect(fired).toEqual({ taskId: 'task-1', sessionId: 'session-spawned' });
    const [claims, request, server] = spawn.mock.calls[0] as unknown as [DbClaims, Record<string, unknown>, Record<string, unknown>];
    expect(claims).toBe(CLAIMS);
    expect(request).toEqual({
      spaceId: SPACE, teamMemberId: PERSONA, parentSessionId: null, taskIds: ['task-1'],
      projectId: PROJECT, workdir: { mode: 'worktree', baseRef: 'origin/main' }, interactionProfileId: PROFILE,
      mode: 'worker', model: 'claude-opus-5-5', agentTool: 'claude-code', reasoningEffort: 'high', accessMode: 'plan',
      credentialSource: 'node', memoryIds: [MEMORY], title: 'Nightly check', promptExtra: 'sweep',
      clientMutationId: `loop-fire:${LOOP}:2026-10-28T20:00:00.000Z`,
    });
    expect(server).toEqual({ triggeredByLoopId: LOOP });
    // The task edge is still written on this branch (run history), the session edge is spawn's.
    expect(rec.rpcs.map((r) => r.fn)).toEqual(['public.derive_task_for_entity', 'write_edge']);
  });

  it('an invalid stored config refuses the firing with invalid_input before any spawn', async () => {
    const { db } = fakeDb();
    const spawn = vi.fn(async () => ({ sessionId: 'session-spawned' }));
    const { port: p } = port({ db, spawn });
    await expect(p.fire(toolLoop({ action: 'spawn', toolId: null, toolInputs: {}, config: { reasoningEffort: 'infinite' } }), CLAIMS, AT))
      .rejects.toMatchObject({ code: 'invalid_input', details: { path: 'definition.config' } });
    expect(spawn).not.toHaveBeenCalled();
  });
});
