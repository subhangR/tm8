/**
 * `createLoopsJob(...).run()` — claim-then-fire, against a fake port and a fake
 * database (design 01a182d4 §3.2–§3.3).
 *
 * The port is faked deliberately. `LoopExecutorPort` exists precisely so the
 * job can be driven without a PTY host or a live spawn, and a fake lets a test
 * assert the thing that actually matters: what the job DID — which loops were
 * claimed and fired, what each claim carried (the advanced instant, the live
 * set, the acting identity), what landed on each run (launched / failed /
 * settled), and which sessions the sweep stopped.
 *
 * The database is faked at the DOOR boundary: the four 382 doors and 378's
 * settle are recorded as calls and answered from a scripted table, so every
 * branch of the job is reachable without Postgres. The doors themselves are
 * covered by db/test/loop_rpcs.test.mjs and the pg suites.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Db, DbClaims } from '../../src/db/types.js';
import type { LoopRunClaim } from '../../src/loops/bookkeeping.js';
import {
  advanceFor,
  createLoopsJob,
  outcomeOfExitedSession,
  type DueLoop,
  type LoopExecutorPort,
  type OpenLoopRun,
} from '../../src/scheduler/jobs/loops.js';
import type { JobContext } from '../../src/scheduler/types.js';

const WORKER: DbClaims = { identityId: 'owner', nodeAdmin: true, requestId: 'test', backgroundJob: 'loops.execute-due' };
const AT = new Date('2026-08-09T10:00:00Z');

function dueLoop(over: Partial<DueLoop> = {}): DueLoop {
  return {
    entityId: 'loop-1',
    spaceId: 'space-1',
    title: 'Nightly',
    schedule: 'every 1d',
    timezone: 'UTC',
    action: 'spawn',
    teamMemberId: 'tm-1',
    subjectId: null,
    toolId: null,
    toolInputs: {},
    prompt: 'do it',
    config: null,
    version: 1,
    concurrency: 'skip',
    maxRuntimeSeconds: null,
    retryAttempts: 0,
    retryDelaySeconds: 300,
    retryAttempt: 0,
    pausedUntil: null,
    nextRunAt: AT.toISOString(),
    actAsIdentity: 'identity-space-1-owner',
    ...over,
  };
}

function openRun(over: Partial<OpenLoopRun> = {}): OpenLoopRun {
  return {
    runId: 'run-open',
    loopId: 'loop-1',
    spaceId: 'space-1',
    action: 'spawn',
    trigger: 'schedule',
    firedAt: new Date(AT.getTime() - 60_000).toISOString(),
    sessionId: 'session-open',
    maxRuntimeSeconds: null,
    sessionStatus: 'running',
    sessionKind: 'agent',
    exitCode: null,
    toolExitCode: null,
    exitedAt: null,
    actAsIdentity: 'identity-space-1-owner',
    ...over,
  };
}

interface Recorded {
  rpcs: Array<{ fn: string; args: readonly unknown[] }>;
  fired: Array<{ loopId: string; firedAt: string; runId: string | undefined; identity: string | undefined }>;
  stopped: Array<{ sessionId: string; reason: string; identity: string | undefined }>;
}

/**
 * A Db whose reads are the three worker doors (orphans, claimable, open runs)
 * and whose rpcs are recorded and answered from `opts.claim`. Each claim
 * answers in order, then the last answer repeats.
 */
function harness(opts: {
  due?: DueLoop[];
  parked?: Array<{ entityId: string; spaceId: string; title: string }>;
  open?: OpenLoopRun[];
  live?: string[];
  claims?: LoopRunClaim[];
  fire?: LoopExecutorPort['fire'];
  stop?: LoopExecutorPort['stopSession'];
}): { db: Db; port: LoopExecutorPort; rec: Recorded } {
  const rec: Recorded = { rpcs: [], fired: [], stopped: [] };
  const claims = opts.claims ?? [{ claimed: true, runId: 'run-1', launch: 'fired', attempt: 1 }];
  let claimIndex = 0;
  const rpc = async (fn: string, args: readonly unknown[] = []): Promise<unknown> => {
    rec.rpcs.push({ fn, args });
    if (fn === 'loop_run_claim') {
      const answer = claims[Math.min(claimIndex, claims.length - 1)]!;
      claimIndex += 1;
      return answer;
    }
    if (fn === 'loop_run_settle') return { runId: args[0], outcome: args[1] };
    if (fn === 'loop_run_launch_failed') return { runId: args[0], retryAt: null };
    return {};
  };
  const db = {
    query: async <R>(_c: DbClaims, sql: string): Promise<R[]> => {
      if (sql.includes('loops_park_orphans')) return (opts.parked ?? []) as unknown as R[];
      if (sql.includes('loops_claimable')) return (opts.due ?? []) as unknown as R[];
      if (sql.includes('loop_runs_open_for_executor')) return (opts.open ?? []) as unknown as R[];
      throw new Error(`unexpected query: ${sql}`);
    },
    rpc: async <T>(_c: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> => rpc(fn, args) as Promise<T>,
    tx: async <T>(_c: DbClaims, fn: (q: unknown) => Promise<T>): Promise<T> =>
      fn({ query: async () => [], rpc }),
  } as unknown as Db;

  const port: LoopExecutorPort = {
    dueReadClaims: async () => WORKER,
    claimsForLoop: (loop, actAsIdentity) => ({ identityId: actAsIdentity, nodeAdmin: false, requestId: `loop-executor:${loop.entityId}` }),
    liveSessionIds: () => opts.live ?? [],
    fire: opts.fire
      ?? (async (loop, claims, firedAt, runId) => {
        rec.fired.push({ loopId: loop.entityId, firedAt: firedAt.toISOString(), runId, identity: claims.identityId });
        return { taskId: 'task-1', sessionId: `session-${rec.fired.length}` };
      }),
    stopSession: opts.stop
      ?? (async (claims, sessionId, request) => {
        rec.stopped.push({ sessionId, reason: request.reason, identity: claims.identityId });
      }),
  };
  return { db, port, rec };
}

function ctx(firedAt = AT, warnings: string[] = []): JobContext {
  return {
    name: 'loops.execute-due',
    firedAt,
    logger: { debug: () => {}, info: () => {}, warn: (m: string) => void warnings.push(m), error: () => {} } as never,
    signal: new AbortController().signal,
  };
}

const rpcsNamed = (rec: Recorded, fn: string) => rec.rpcs.filter((r) => r.fn === fn);

describe('the due sweep', () => {
  it('reports a skip with a reason when nothing is due or open, never a silent no-op', async () => {
    const { db, port } = harness({});
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    expect(outcome).toMatchObject({ skipped: true });
    expect((outcome as { reason: string }).reason).toBeTruthy();
  });

  it('claims then fires each due loop once, records the launch, and reports the tally', async () => {
    const { db, port, rec } = harness({
      due: [dueLoop(), dueLoop({ entityId: 'loop-2' })],
      claims: [{ claimed: true, runId: 'run-1', launch: 'fired' }, { claimed: true, runId: 'run-2', launch: 'fired' }],
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx());

    expect(rec.fired.map((f) => f.loopId)).toEqual(['loop-1', 'loop-2']);
    // The claim PRECEDES the fire, and the fire carries the claimed run id.
    const order = rec.rpcs.map((r) => r.fn);
    expect(order.indexOf('loop_run_claim')).toBeLessThan(order.indexOf('loop_run_launched'));
    expect(rec.fired.map((f) => f.runId)).toEqual(['run-1', 'run-2']);
    const launched = rpcsNamed(rec, 'loop_run_launched');
    expect(launched.map((r) => r.args)).toEqual([['run-1', 'task-1', 'session-1'], ['run-2', 'task-1', 'session-2']]);
    expect(outcome).toMatchObject({ affected: 2, detail: { due: 2, fired: 2, skipped: 0, failed: 0 } });
  });

  it('hands the claim the advanced instant FROM THE FIRING INSTANT (misfire: skip, never backfill) and the live set', async () => {
    const at = new Date('2026-08-09T11:22:33Z');
    const { db, port, rec } = harness({ due: [dueLoop({ schedule: 'every 5m' })], live: ['s-live'] });
    await createLoopsJob({ db, port }).run(ctx(at));
    const [claim] = rpcsNamed(rec, 'loop_run_claim');
    expect(claim!.args[0]).toBe('loop-1');
    expect(claim!.args[1]).toBe(at.toISOString());
    expect(claim!.args[2]).toBe('schedule');
    expect(claim!.args[3]).toEqual(['s-live']);
    // next_run_at = firedAt + 5m, not the missed deadline.
    expect(claim!.args[4]).toBe(new Date(at.getTime() + 5 * 60_000).toISOString());
    expect(claim!.args[5]).toBeNull();
    // The acting identity the due read resolved travels onto the run row.
    expect(claim!.args[6]).toBe('identity-space-1-owner');
  });

  it('evaluates the cron half in the loop timezone', () => {
    // 09:00 in London on a BST day is 08:00Z.
    const from = new Date('2026-08-09T10:00:00Z');
    const { nextRunAt, scheduleError } = advanceFor({ schedule: '0 9 * * *', timezone: 'Europe/London' }, from);
    expect(scheduleError).toBeNull();
    expect(nextRunAt?.toISOString()).toBe('2026-08-10T08:00:00.000Z');
  });

  it('fires under the loop claims for the acting identity, never the worker claim', async () => {
    const { db, port, rec } = harness({ due: [dueLoop({ actAsIdentity: 'identity-alice' })] });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rec.fired[0]!.identity).toBe('identity-alice');
  });
});

describe('two firings of one loop are two distinct commands', () => {
  it('passes a DIFFERENT run id and firedAt on each tick, so the firing key differs', async () => {
    const seen: string[] = [];
    const { db, port } = harness({
      due: [dueLoop()],
      claims: [{ claimed: true, runId: 'run-a', launch: 'fired' }, { claimed: true, runId: 'run-b', launch: 'fired' }],
      fire: async (loop, _c, firedAt, runId) => {
        seen.push(`loop-fire:${runId ?? `${loop.entityId}:${firedAt.toISOString()}`}`);
        return { taskId: 'task-1', sessionId: `session-${seen.length}` };
      },
    });
    const job = createLoopsJob({ db, port });
    await job.run(ctx(new Date('2026-08-09T10:00:00Z')));
    await job.run(ctx(new Date('2026-08-10T10:00:00Z')));
    expect(new Set(seen).size).toBe(2);
  });
});

describe('concurrency (§3.3)', () => {
  it('skip: a claim the door answered skipped/overlap fires nothing and counts as skipped', async () => {
    const { db, port, rec } = harness({
      due: [dueLoop()],
      live: ['session-old'],
      claims: [{ claimed: true, runId: 'run-skip', launch: 'skipped', skipReason: 'overlap', waitingOnRunId: 'run-open' }],
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    expect(rec.fired).toHaveLength(0);
    expect(rpcsNamed(rec, 'loop_run_launched')).toHaveLength(0);
    expect(outcome).toMatchObject({ detail: { skipped: 1, fired: 0 } });
  });

  it('queue: a claim the door answered queued writes nothing and counts as queued, and the loop stays due', async () => {
    const { db, port, rec } = harness({
      due: [dueLoop({ concurrency: 'queue' })],
      claims: [{ claimed: false, reason: 'queued', waitingOnRunId: 'run-open' }],
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    expect(rec.fired).toHaveLength(0);
    expect(rec.rpcs.map((r) => r.fn)).toEqual(['loop_run_claim']);
    expect(outcome).toMatchObject({ detail: { queued: 1, fired: 0, skipped: 0 } });
  });

  it('a loop a human edited between the read and the claim (not_due) is left alone', async () => {
    const { db, port, rec } = harness({ due: [dueLoop()], claims: [{ claimed: false, reason: 'not_due' }] });
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    expect(rec.fired).toHaveLength(0);
    expect(outcome).toMatchObject({ detail: { notDue: 1 } });
  });
});

describe('failure handling', () => {
  it('records a launch failure on the run (retry and last_error live in the door) and never disables the loop', async () => {
    const { db, port, rec } = harness({
      due: [dueLoop({ retryAttempts: 2 })],
      fire: async () => { throw new Error('spawn refused: capacity'); },
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    expect(outcome).toMatchObject({ detail: { failed: 1, fired: 0 } });
    const [failed] = rpcsNamed(rec, 'loop_run_launch_failed');
    expect(failed!.args[0]).toBe('run-1');
    expect(String(failed!.args[1])).toContain('spawn refused');
    expect(failed!.args[2]).toBe(AT.toISOString());
    expect(rpcsNamed(rec, 'loop_run_launched')).toHaveLength(0);
    // No door that could disable a loop is ever called by the job.
    expect(rec.rpcs.some((r) => r.fn === 'update_loop')).toBe(false);
  });

  it('parks an unsatisfiable schedule through the claim with the reason, without firing', async () => {
    const warnings: string[] = [];
    const { db, port, rec } = harness({
      due: [dueLoop({ schedule: '0 0 30 2 *' })],
      claims: [{ claimed: true, runId: 'run-parked', launch: 'skipped', skipReason: 'schedule_invalid' }],
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx(AT, warnings));
    expect(rec.fired).toHaveLength(0);
    const [claim] = rpcsNamed(rec, 'loop_run_claim');
    expect(claim!.args[4]).toBeNull();
    expect(String(claim!.args[5])).toContain('never matches');
    expect(outcome).toMatchObject({ detail: { skipped: 1 } });
    expect(warnings.some((w) => w.includes('parked'))).toBe(true);
  });

  it('hands an unparseable schedule to the claim the same way', async () => {
    const { db, port, rec } = harness({
      due: [dueLoop({ schedule: 'hourly' })],
      claims: [{ claimed: true, runId: 'run-parked', launch: 'skipped', skipReason: 'schedule_invalid' }],
    });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rec.fired).toHaveLength(0);
    expect(typeof rpcsNamed(rec, 'loop_run_claim')[0]!.args[5]).toBe('string');
  });

  it('a failure to RECORD a failure is logged, not swallowed, and does not end the tick', async () => {
    const warnings: string[] = [];
    const { db, port, rec } = harness({
      due: [dueLoop(), dueLoop({ entityId: 'loop-2' })],
      claims: [{ claimed: true, runId: 'run-1', launch: 'fired' }, { claimed: true, runId: 'run-2', launch: 'fired' }],
      fire: async (loop, _c, firedAt, runId) => {
        if (loop.entityId === 'loop-1') throw new Error('spawn refused');
        rec.fired.push({ loopId: loop.entityId, firedAt: firedAt.toISOString(), runId, identity: undefined });
        return { taskId: 't', sessionId: 's' };
      },
    });
    const original = db.rpc.bind(db);
    (db as { rpc: Db['rpc'] }).rpc = async (c, fn, args) => {
      if (fn === 'loop_run_launch_failed') throw new Error('door refused');
      return original(c, fn, args);
    };
    const outcome = await createLoopsJob({ db, port }).run(ctx(AT, warnings));
    expect(outcome).toMatchObject({ detail: { fired: 1, failed: 1 } });
    expect(warnings.some((w) => w.includes('could not be recorded'))).toBe(true);
    expect(rec.fired.map((f) => f.loopId)).toEqual(['loop-2']);
  });
});

describe('actions', () => {
  it('settles a dispatch firing completed at once: the dispatcher session is not the run', async () => {
    const { db, port, rec } = harness({ due: [dueLoop({ action: 'dispatch', teamMemberId: null })] });
    await createLoopsJob({ db, port }).run(ctx());
    const settle = rpcsNamed(rec, 'loop_run_settle');
    expect(settle.map((r) => r.args)).toEqual([['run-1', 'completed', null]]);
  });

  it('leaves a spawn firing open for the sweep to settle', async () => {
    const { db, port, rec } = harness({ due: [dueLoop()] });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rpcsNamed(rec, 'loop_run_settle')).toHaveLength(0);
  });

  it('records a tool firing with no derived task', async () => {
    const { db, port, rec } = harness({
      due: [dueLoop({ action: 'tool', toolId: 'tool-1', toolInputs: { name: 'x' } })],
      fire: async () => ({ taskId: null, sessionId: 'tool-run-1' }),
    });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rpcsNamed(rec, 'loop_run_launched')[0]!.args).toEqual(['run-1', null, 'tool-run-1']);
  });
});

describe('orphans (§3.2, §7)', () => {
  it('reports every parked loop loudly and does not fire it', async () => {
    const warnings: string[] = [];
    const { db, port, rec } = harness({ parked: [{ entityId: 'loop-orphan', spaceId: 'space-x', title: 'Lonely' }] });
    const outcome = await createLoopsJob({ db, port }).run(ctx(AT, warnings));
    expect(rec.fired).toHaveLength(0);
    expect(outcome).toMatchObject({ detail: { orphaned: 1 } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no active member to act as');
  });
});

describe('the max-runtime and settle sweep (§3.3)', () => {
  it('stops a LIVE session past fired_at + max_runtime_seconds through the port and settles timed_out', async () => {
    const { db, port, rec } = harness({
      open: [openRun({ maxRuntimeSeconds: 60, firedAt: new Date(AT.getTime() - 61_000).toISOString() })],
      live: ['session-open'],
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    expect(rec.stopped).toEqual([{ sessionId: 'session-open', reason: 'loop max runtime of 60s exceeded', identity: 'identity-space-1-owner' }]);
    expect(rpcsNamed(rec, 'loop_run_settle').map((r) => r.args)).toEqual([['run-open', 'timed_out', 'exceeded the maximum runtime of 60 seconds']]);
    expect(outcome).toMatchObject({ detail: { timedOut: 1 } });
  });

  it('leaves a live run within its max runtime alone', async () => {
    const { db, port, rec } = harness({
      open: [openRun({ maxRuntimeSeconds: 600, firedAt: new Date(AT.getTime() - 60_000).toISOString() })],
      live: ['session-open'],
    });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rec.stopped).toHaveLength(0);
    expect(rpcsNamed(rec, 'loop_run_settle')).toHaveLength(0);
  });

  it('never stops a run with no max runtime', async () => {
    const { db, port, rec } = harness({ open: [openRun({ firedAt: '2020-01-01T00:00:00Z' })], live: ['session-open'] });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rec.stopped).toHaveLength(0);
  });

  it('does not settle timed_out when the stop itself failed — the process may still be running', async () => {
    const { db, port, rec } = harness({
      open: [openRun({ maxRuntimeSeconds: 60, firedAt: new Date(AT.getTime() - 120_000).toISOString() })],
      live: ['session-open'],
      stop: async () => { throw new Error('EPERM'); },
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    expect(rpcsNamed(rec, 'loop_run_settle')).toHaveLength(0);
    expect(outcome).toMatchObject({ skipped: true });
  });

  it('settles an exited session completed, a failed session failed, a non-zero tool exit failed', async () => {
    const { db, port, rec } = harness({
      open: [
        openRun({ runId: 'r-ok', sessionId: 's-ok', sessionStatus: 'exited', exitCode: 0 }),
        openRun({ runId: 'r-dead', sessionId: 's-dead', sessionStatus: 'failed' }),
        openRun({ runId: 'r-tool', sessionId: 's-tool', sessionStatus: 'exited', sessionKind: 'tool', toolExitCode: 2 }),
        openRun({ runId: 'r-tool-ok', sessionId: 's-tool-ok', sessionStatus: 'exited', sessionKind: 'tool', toolExitCode: 0 }),
      ],
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    expect(rpcsNamed(rec, 'loop_run_settle').map((r) => [r.args[0], r.args[1]])).toEqual([
      ['r-ok', 'completed'], ['r-dead', 'failed'], ['r-tool', 'failed'], ['r-tool-ok', 'completed'],
    ]);
    expect(outcome).toMatchObject({ detail: { settled: 4 } });
  });

  it('fails a launch that never recorded a session after the grace period, and waits for a fresh one', async () => {
    const { db, port, rec } = harness({
      open: [
        openRun({ runId: 'r-stale', sessionId: null, firedAt: new Date(AT.getTime() - 11 * 60_000).toISOString() }),
        openRun({ runId: 'r-fresh', sessionId: null, firedAt: new Date(AT.getTime() - 60_000).toISOString() }),
      ],
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    const settled = rpcsNamed(rec, 'loop_run_settle');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.args[0]).toBe('r-stale');
    expect(settled[0]!.args[1]).toBe('failed');
    expect(outcome).toMatchObject({ detail: { abandoned: 1 } });
  });

  it('maps session facts to outcomes', () => {
    expect(outcomeOfExitedSession({ sessionStatus: 'running', sessionKind: 'agent', toolExitCode: null, exitCode: null })).toBeNull();
    expect(outcomeOfExitedSession({ sessionStatus: 'exited', sessionKind: 'agent', toolExitCode: null, exitCode: 1 })?.outcome).toBe('completed');
    expect(outcomeOfExitedSession({ sessionStatus: 'failed', sessionKind: 'agent', toolExitCode: null, exitCode: null })?.outcome).toBe('failed');
    expect(outcomeOfExitedSession({ sessionStatus: 'exited', sessionKind: 'tool', toolExitCode: 3, exitCode: 3 })?.outcome).toBe('failed');
  });
});

describe('abort', () => {
  it('stops mid-sweep when the scheduler is stopping', async () => {
    const controller = new AbortController();
    const { db, port, rec } = harness({
      due: [dueLoop(), dueLoop({ entityId: 'loop-2' })],
      claims: [{ claimed: true, runId: 'run-1', launch: 'fired' }, { claimed: true, runId: 'run-2', launch: 'fired' }],
      fire: async (loop, _c, firedAt, runId) => {
        rec.fired.push({ loopId: loop.entityId, firedAt: firedAt.toISOString(), runId, identity: undefined });
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
