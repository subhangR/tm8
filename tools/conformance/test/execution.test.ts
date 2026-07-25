/**
 * execution.* family (R16) — capability-gated conformance. The graph engine
 * gate (M1) may honestly 501 these (execution lands at M3/W4); what is NEVER
 * acceptable is a 404 (the operations exist in the catalog) or a non-contract
 * response shape once implemented.
 *
 * Server-hosted PTY is the only spawn path (AM-1): these routes assume no
 * desktop shell anywhere.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EntityDetailSchema, ExecutionSpawnInputSchema, StreamAttachGrantSchema,
  WorkSessionStatusSchema, type EntityDetail,
} from '@tm8/contract';
import { api, isWireError } from '../src/client.js';
import { buildWorld, expectValid, type World } from '../src/world.js';

let w: World;

beforeAll(async () => {
  w = await buildWorld('exec');
});

/** Run `fn`; treat an honest 501 as "gated" and anything else as live. */
async function gated<T>(fn: () => Promise<T>): Promise<{ gated: true } | { gated: false; value: T }> {
  try {
    return { gated: false, value: await fn() };
  } catch (e) {
    if (isWireError(e) && e.code === 'not_implemented' && e.status === 501 && !e.malformedBody) {
      return { gated: true };
    }
    throw e;
  }
}

describe('execution.* (R16)', () => {
  it('spawn input schema itself enforces persona/mode/project/workdir shapes (contract-side)', () => {
    expect(ExecutionSpawnInputSchema.safeParse({ spaceId: w.spaceId, teamMemberId: w.forge }).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({ spaceId: w.spaceId }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({ spaceId: w.spaceId, teamMemberId: w.forge, mode: 'boss' }).success).toBe(false);
    // AM-2 §1: typed projectId + worktree semantics; the untyped projectRef is dead
    expect(ExecutionSpawnInputSchema.safeParse({
      spaceId: w.spaceId, teamMemberId: w.forge, projectId: 'proj_1', workdir: { mode: 'worktree', baseRef: 'main' },
    }).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({
      spaceId: w.spaceId, teamMemberId: w.forge, projectRef: '~/code/x',
    }).success).toBe(false);
  });

  it('execution.spawn: 501-gated, capacity-refused (limit_exceeded, AM-2 §4), or a schema-valid work_session', async () => {
    try {
      const res = await gated(() => api.command('execution.spawn', {
        spaceId: w.spaceId, teamMemberId: w.forge, taskIds: [w.t104],
        clientMutationId: `cmid-spawn-${Date.now()}`,
      }));
      if (res.gated) return; // honest gate — allowed before M3
      const result = res.value as { entity?: EntityDetail };
      const ws = expectValid(EntityDetailSchema, result.entity, 'work_session detail');
      expect(ws.kind).toBe('work_session');
      if (ws.state.kind === 'work_session') {
        expect(WorkSessionStatusSchema.safeParse(ws.state.status).success).toBe(true);
      }
      // working_on edge to the task must exist
      const types = ws.connections.outgoing.map((g) => g.type);
      expect(types).toContain('working_on');
    } catch (e) {
      // The governance refusal path: a node at its session concurrency cap
      // must answer 429 limit_exceeded (retryable), never queue silently.
      if (isWireError(e) && e.code === 'limit_exceeded' && !e.malformedBody) {
        expect(e.status).toBe(429);
        expect(e.retryable).toBe(true);
        return;
      }
      throw e;
    }
  });

  it('execution.prompt / terminate: 501-gated, or a typed refusal on a non-work_session target', async () => {
    // Without a live work_session these are probed for honesty: a live
    // implementation must refuse a task target with a typed error.
    const REFUSALS = new Set(['invalid_input', 'not_found', 'invariant_violation']);
    for (const [name, body] of [['execution.prompt', { message: 'status?' }], ['execution.terminate', {}]] as const) {
      try {
        await api.command(name, body, { id: w.t104 });
        throw new Error(`${name} accepted a non-work_session target`);
      } catch (e) {
        if (isWireError(e) && !e.malformedBody &&
            (e.code === 'not_implemented' || REFUSALS.has(e.code))) continue;
        throw e;
      }
    }
  });

  it('execution.streams.attach: 501-gated or returns a StreamAttachGrant (bytes never in the graph)', async () => {
    const res = await gated(() => api.command('execution.streams.attach', { mode: 'view' }, { id: w.t104 }));
    if (res.gated) return;
    expectValid(StreamAttachGrantSchema, res.value, 'stream attach grant');
  });

  it('work_session is not client-creatable through entities.create (R16)', async () => {
    const { expectError } = await import('../src/client.js');
    await expectError(api.command('entities.create', {
      spaceId: w.spaceId, kind: 'work_session', title: 'forged session',
    }), 'invalid_input');
  });
});
