/**
 * `createLoopsJob(...).run()` — the firing loop itself, against a fake port.
 *
 * The reviewer measured ZERO coverage here, and that is how B1 and B2 shipped:
 * every piece around this function was tested (the grammar, the migration, the
 * doors, the wiring) and the function that decides WHETHER AND HOW EACH LOOP
 * FIRES was not. This file exists so that stops being true.
 *
 * The port is faked deliberately. `LoopExecutorPort` exists precisely so the
 * job can be driven without a PTY host or a live spawn, and a fake lets a test
 * assert the thing that actually matters: what the job DID — which loops fired,
 * what mutation-shaped identity each firing carried, and what got written back.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Db, DbClaims } from '../../src/db/types.js';
import { createLoopsJob, type DueLoop, type LoopExecutorPort } from '../../src/scheduler/jobs/loops.js';
import type { JobContext } from '../../src/scheduler/types.js';

const CLAIMS: DbClaims = { identityId: 'owner', nodeAdmin: true, requestId: 'test' };

function dueLoop(over: Partial<DueLoop> = {}): DueLoop {
  return {
    entityId: 'loop-1',
    spaceId: 'space-1',
    title: 'Nightly',
    schedule: 'every 1d',
    teamMemberId: 'tm-1',
    subjectId: null,
    prompt: 'do it',
    config: null,
    version: 1,
    ...over,
  };
}

interface Recorded {
  rpcs: Array<{ fn: string; args: readonly unknown[] }>;
  fired: Array<{ loopId: string; firedAt: string }>;
}

/**
 * A Db whose only read is the due-loop query, plus an edge-existence read for
 * the overlap guard. Everything else is recorded rather than executed.
 */
function harness(opts: {
  due: DueLoop[];
  live?: string[];
  liveFiringSrcIds?: string[];
  fire?: LoopExecutorPort['fire'];
}): { db: Db; port: LoopExecutorPort; rec: Recorded } {
  const rec: Recorded = { rpcs: [], fired: [] };
  const db = {
    query: async <R>(_c: DbClaims, sql: string): Promise<R[]> => {
      if (sql.includes('from public.loops')) return opts.due as unknown as R[];
      // The overlap guard's `triggered_by` probe.
      if (sql.includes("type = 'triggered_by'")) {
        return (opts.liveFiringSrcIds ?? []).map((id) => ({ id })) as unknown as R[];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    tx: async <T>(_c: DbClaims, fn: (q: unknown) => Promise<T>): Promise<T> =>
      fn({
        query: async () => [],
        rpc: async (fnName: string, args: readonly unknown[] = []) => {
          rec.rpcs.push({ fn: fnName, args });
          return {};
        },
      }),
  } as unknown as Db;

  const port: LoopExecutorPort = {
    claimsFor: async () => CLAIMS,
    liveSessionIds: () => opts.live ?? [],
    fire: opts.fire
      ?? (async (loop, _claims, firedAt) => {
        rec.fired.push({ loopId: loop.entityId, firedAt: firedAt.toISOString() });
        return { taskId: 'task-1', sessionId: `session-${rec.fired.length}` };
      }),
  };
  return { db, port, rec };
}

function ctx(firedAt = new Date('2026-08-09T10:00:00Z')): JobContext {
  return {
    name: 'loops.execute-due',
    firedAt,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
    signal: new AbortController().signal,
  };
}

describe('the due sweep', () => {
  it('reports a skip with a reason when nothing is due, never a silent no-op', async () => {
    const { db, port } = harness({ due: [] });
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    expect(outcome).toMatchObject({ skipped: true });
    expect((outcome as { reason: string }).reason).toBeTruthy();
  });

  it('fires each due loop once and reports the tally', async () => {
    const { db, port, rec } = harness({ due: [dueLoop(), dueLoop({ entityId: 'loop-2' })] });
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    expect(rec.fired.map((f) => f.loopId)).toEqual(['loop-1', 'loop-2']);
    expect(outcome).toMatchObject({ affected: 2, detail: { due: 2, fired: 2, failed: 0 } });
  });

  it('hands the port the scheduler firing instant, which keys the firing', async () => {
    // B1's fix depends on this reaching the port at all. If the job ever went
    // back to letting the port read its own clock, two firings could collide.
    const at = new Date('2026-08-09T11:22:33Z');
    const { db, port, rec } = harness({ due: [dueLoop()] });
    await createLoopsJob({ db, port }).run(ctx(at));
    expect(rec.fired[0]!.firedAt).toBe(at.toISOString());
  });
});

describe('two firings of one loop are two distinct commands (B1)', () => {
  it('passes a DIFFERENT firedAt on each tick, so the firing key differs', async () => {
    const seen: string[] = [];
    const { db, port } = harness({
      due: [dueLoop()],
      fire: async (loop, _c, firedAt) => {
        seen.push(`loop-fire:${loop.entityId}:${firedAt.toISOString()}`);
        return { taskId: 'task-1', sessionId: `session-${seen.length}` };
      },
    });
    const job = createLoopsJob({ db, port });

    await job.run(ctx(new Date('2026-08-09T10:00:00Z')));
    await job.run(ctx(new Date('2026-08-10T10:00:00Z')));

    // The exact regression: with a (loop, task)-keyed id these two strings were
    // identical, `execution_spawn`'s ledger replay returned the day-1 session
    // and day 2 booted nothing.
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(new Set(seen).size).toBe(2);
  });
});

describe('the overlap guard', () => {
  it('skips a loop whose previous firing is still live, and still advances it', async () => {
    const { db, port, rec } = harness({
      due: [dueLoop()],
      live: ['session-old'],
      liveFiringSrcIds: ['session-old'],
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx());

    expect(rec.fired).toHaveLength(0);
    expect(outcome).toMatchObject({ detail: { skipped: 1, fired: 0 } });
    // Still advanced: a skipped loop that stayed due would be re-selected on
    // every tick forever.
    const update = rec.rpcs.find((r) => r.fn === 'update_loop');
    expect(update).toBeDefined();
    expect(update!.args[12]).not.toBeNull();
  });

  it('does not consult the guard at all when nothing is live', async () => {
    const { db, port, rec } = harness({ due: [dueLoop()], live: [] });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rec.fired).toHaveLength(1);
  });
});

describe('failure handling', () => {
  it('records the error, still advances the schedule, and never disables the loop', async () => {
    const { db, port, rec } = harness({
      due: [dueLoop()],
      fire: async () => { throw new Error('spawn refused: capacity'); },
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx());

    expect(outcome).toMatchObject({ detail: { failed: 1, fired: 0 } });
    const update = rec.rpcs.find((r) => r.fn === 'update_loop');
    expect(update).toBeDefined();
    // `enabled` is arg 11 and must be untouched (null = merge): a transient
    // refusal must not retire a schedule a human set up.
    expect(update!.args[11]).toBeNull();
    expect(String(update!.args[15])).toContain('spawn refused');
  });

  it('advances from NOW rather than backfilling a missed burst', async () => {
    // Misfire policy. A node down six hours must not wake and spawn 72
    // sessions; `next_run_at` is recomputed from the firing instant.
    const at = new Date('2026-08-09T10:00:00Z');
    const { db, port, rec } = harness({ due: [dueLoop({ schedule: 'every 5m' })] });
    await createLoopsJob({ db, port }).run(ctx(at));

    const update = rec.rpcs.find((r) => r.fn === 'update_loop')!;
    expect(update.args[12]).toBe(new Date(at.getTime() + 5 * 60_000).toISOString());
  });

  it('records an unsatisfiable schedule without firing and without disabling', async () => {
    const { db, port, rec } = harness({ due: [dueLoop({ schedule: '0 0 30 2 *' })] });
    const outcome = await createLoopsJob({ db, port }).run(ctx());

    expect(rec.fired).toHaveLength(0);
    expect(outcome).toMatchObject({ detail: { failed: 1 } });
    const update = rec.rpcs.find((r) => r.fn === 'update_loop')!;
    expect(String(update.args[15])).toContain('never matches');
    expect(update.args[11]).toBeNull();
  });

  it('refuses an unparseable schedule the same way', async () => {
    const { db, port, rec } = harness({ due: [dueLoop({ schedule: 'hourly' })] });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rec.fired).toHaveLength(0);
    expect(rec.rpcs.some((r) => r.fn === 'update_loop')).toBe(true);
  });
});

describe('abort', () => {
  it('stops mid-sweep when the scheduler is stopping', async () => {
    const controller = new AbortController();
    const { db, port, rec } = harness({
      due: [dueLoop(), dueLoop({ entityId: 'loop-2' })],
      fire: async (loop, _c, firedAt) => {
        rec.fired.push({ loopId: loop.entityId, firedAt: firedAt.toISOString() });
        controller.abort();
        return { taskId: 't', sessionId: 's' };
      },
    });
    const signalled = { ...ctx(), signal: controller.signal } as JobContext;
    await createLoopsJob({ db, port }).run(signalled);
    expect(rec.fired.map((f) => f.loopId)).toEqual(['loop-1']);
  });
});

vi.setConfig({ testTimeout: 20_000 });
