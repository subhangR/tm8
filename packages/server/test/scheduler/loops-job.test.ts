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
 * The database is faked at the DOOR boundary: the four 385 doors and 384's
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
  isThisNodesSession,
  outcomeOfExitedSession,
  SESSION_LOST,
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
  /** Bridges L: runs `replace` ends, interactive runs gone idle, held posts released. */
  toReplace?: Array<{ runId: string; sessionId: string }>;
  idle?: Array<{ runId: string; loopId: string; spaceId: string; sessionId: string; actAsIdentity: string | null }>;
  released?: number;
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
    if (fn === 'loop_release_held') return opts.released ?? 0;
    return {};
  };
  const db = {
    query: async <R>(_c: DbClaims, sql: string): Promise<R[]> => {
      if (sql.includes('loops_park_orphans')) return (opts.parked ?? []) as unknown as R[];
      if (sql.includes('loops_claimable')) return (opts.due ?? []) as unknown as R[];
      if (sql.includes('loop_runs_open_for_executor')) return (opts.open ?? []) as unknown as R[];
      if (sql.includes('loop_runs_to_replace')) return (opts.toReplace ?? []) as unknown as R[];
      if (sql.includes('loop_runs_idle_interactive')) return (opts.idle ?? []) as unknown as R[];
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
    // The tick's own sweep (Bridges L: held posts released) is not a write for this loop.
    expect(rec.rpcs.map((r) => r.fn).filter((fn) => fn !== 'loop_release_held')).toEqual(['loop_run_claim']);
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

describe('per-claim liveness and isolation (review 1398 items 4 and 8)', () => {
  it('reads the live set at each claim, not once per tick', async () => {
    let reads = 0;
    const { db, port, rec } = harness({
      due: [dueLoop(), dueLoop({ entityId: 'loop-2' })],
      claims: [{ claimed: true, runId: 'run-1', launch: 'fired' }, { claimed: true, runId: 'run-2', launch: 'fired' }],
    });
    port.liveSessionIds = () => { reads += 1; return [`live-${reads}`]; };
    await createLoopsJob({ db, port }).run(ctx());
    const claimed = rpcsNamed(rec, 'loop_run_claim').map((r) => r.args[3]);
    expect(claimed).toHaveLength(2);
    expect(claimed[0]).not.toEqual(claimed[1]);
  });

  it('a claim that raises (a loop deleted since the read, a lock conflict) ends only its own loop', async () => {
    const warnings: string[] = [];
    const { db, port, rec } = harness({
      due: [dueLoop(), dueLoop({ entityId: 'loop-2' })],
      claims: [{ claimed: true, runId: 'run-2', launch: 'fired' }],
    });
    const original = db.rpc.bind(db);
    let first = true;
    (db as { rpc: Db['rpc'] }).rpc = async (c, fn, args) => {
      if (fn === 'loop_run_claim' && first) { first = false; throw new Error('loop not found'); }
      return original(c, fn, args);
    };
    const outcome = await createLoopsJob({ db, port }).run(ctx(AT, warnings));
    expect(rec.fired.map((f) => f.loopId)).toEqual(['loop-2']);
    expect(outcome).toMatchObject({ detail: { fired: 1, failed: 1 } });
    expect(warnings.some((w) => w.includes('could not be claimed'))).toBe(true);
  });
});

describe('actions', () => {
  it('a bookkeeping write that fails AFTER a successful fire is retried once, logged, and never recorded as a launch failure', async () => {
    // Recording it as a failure would re-arm a retry and fire this deadline again while the first session runs.
    const warnings: string[] = [];
    const { db, port, rec } = harness({ due: [dueLoop()] });
    const original = db.rpc.bind(db);
    (db as { rpc: Db['rpc'] }).rpc = async (c, fn, args) => {
      if (fn === 'loop_run_launched') {
        rec.rpcs.push({ fn, args: args ?? [] });
        throw new Error('statement timeout');
      }
      return original(c, fn, args);
    };
    const outcome = await createLoopsJob({ db, port }).run(ctx(AT, warnings));
    expect(rec.fired).toHaveLength(1);
    expect(rpcsNamed(rec, 'loop_run_launched')).toHaveLength(2);
    expect(rpcsNamed(rec, 'loop_run_launch_failed')).toHaveLength(0);
    expect(outcome).toMatchObject({ detail: { fired: 1, failed: 0 } });
    expect(warnings.some((w) => w.includes('could not record it'))).toBe(true);
  });

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

  it('never stops a ghost past its max runtime: liveness is the PTY map, not the row', async () => {
    // Status still says running but no PTY: the session died with the node; within the grace it is left alone.
    const { db, port, rec } = harness({
      open: [openRun({ maxRuntimeSeconds: 60, firedAt: new Date(AT.getTime() - 120_000).toISOString(), sessionStatus: 'running' })],
      live: [],
    });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rec.stopped).toHaveLength(0);
    expect(rpcsNamed(rec, 'loop_run_settle')).toHaveLength(0);
  });

  it('settles a run whose session is gone from the PTY map past the grace "failed: session lost" (review 1398 B1: a restart)', async () => {
    // Ghost reconciliation lists sessions under the node owner's RLS and misses
    // a human's space; the sweep is what keeps a dead run from holding its loop.
    const { db, port, rec } = harness({
      open: [
        openRun({ runId: 'r-ghost', sessionId: 's-ghost', sessionStatus: 'running', firedAt: new Date(AT.getTime() - 11 * 60_000).toISOString() }),
        openRun({ runId: 'r-young', sessionId: 's-young', sessionStatus: 'spawning', firedAt: new Date(AT.getTime() - 60_000).toISOString() }),
        openRun({ runId: 'r-live', sessionId: 's-live', sessionStatus: 'running', firedAt: '2020-01-01T00:00:00Z' }),
      ],
      live: ['s-live'],
    });
    const job = createLoopsJob({ db, port });
    // The first sweep that finds it missing only notes it (the reaper's first-missing rule, item 17).
    expect(await job.run(ctx())).toMatchObject({ skipped: true });
    expect(rpcsNamed(rec, 'loop_run_settle')).toHaveLength(0);
    // Still missing a tick later: lost. The young run is still inside its launch grace.
    const outcome = await job.run(ctx(new Date(AT.getTime() + 60_000)));
    expect(rpcsNamed(rec, 'loop_run_settle').map((r) => r.args)).toEqual([['r-ghost', 'failed', SESSION_LOST]]);
    expect(rec.stopped).toHaveLength(0);
    expect(outcome).toMatchObject({ detail: { lost: 1 } });
  });

  it('a session missing on one sweep and exited by the next settles from its facts, never as lost (review 1398 item 17)', async () => {
    // A PTY leaves the map the moment it exits; the row turns terminal a little
    // later (handlePtyExit). A sweep in that gap must not record a clean exit as lost.
    const firedAt = new Date(AT.getTime() - 11 * 60_000).toISOString();
    const opts: Parameters<typeof harness>[0] = {
      open: [openRun({ runId: 'r-exit', sessionId: 's-exit', sessionStatus: 'running', firedAt })],
      live: [],
    };
    const { db, port, rec } = harness(opts);
    const job = createLoopsJob({ db, port });
    await job.run(ctx());
    expect(rpcsNamed(rec, 'loop_run_settle')).toHaveLength(0);
    opts.open = [openRun({ runId: 'r-exit', sessionId: 's-exit', sessionStatus: 'exited', exitCode: 0, firedAt })];
    const outcome = await job.run(ctx(new Date(AT.getTime() + 60_000)));
    expect(rpcsNamed(rec, 'loop_run_settle').map((r) => r.args)).toEqual([['r-exit', 'completed', null]]);
    expect(outcome).toMatchObject({ detail: { settled: 1 } });
  });

  it('waits until the session has been missing for LOST_CONFIRM_MS, not merely for two sweeps (review 1398 item 17)', async () => {
    const { db, port, rec } = harness({
      open: [openRun({ runId: 'r-ghost', sessionId: 's-ghost', firedAt: new Date(AT.getTime() - 11 * 60_000).toISOString() })],
      live: [],
    });
    const job = createLoopsJob({ db, port });
    await job.run(ctx());
    await job.run(ctx(new Date(AT.getTime() + 10_000)));
    expect(rpcsNamed(rec, 'loop_run_settle')).toHaveLength(0);
    await job.run(ctx(new Date(AT.getTime() + 30_000)));
    expect(rpcsNamed(rec, 'loop_run_settle').map((r) => r.args)).toEqual([['r-ghost', 'failed', SESSION_LOST]]);
  });

  it('calls lost only a session this node hosts (or one with no node recorded): another node\'s may be live there (review 1398 item 18)', async () => {
    const firedAt = new Date(AT.getTime() - 11 * 60_000).toISOString();
    const h = harness({
      open: [
        openRun({ runId: 'r-other', sessionId: 's-other', sessionNodeId: 'node-b', maxRuntimeSeconds: 60, firedAt }),
        openRun({ runId: 'r-mine', sessionId: 's-mine', sessionNodeId: 'node-a', firedAt }),
        openRun({ runId: 'r-unrecorded', sessionId: 's-unrecorded', sessionNodeId: null, firedAt }),
      ],
      live: [],
    });
    const job = createLoopsJob({ db: h.db, port: { ...h.port, nodeId: 'node-a' } });
    await job.run(ctx());
    const outcome = await job.run(ctx(new Date(AT.getTime() + 60_000)));
    expect(rpcsNamed(h.rec, 'loop_run_settle').map((r) => r.args)).toEqual([
      ['r-mine', 'failed', SESSION_LOST],
      ['r-unrecorded', 'failed', SESSION_LOST],
    ]);
    // Nor is its max runtime this node's to enforce: the node that hosts it stops it.
    expect(h.rec.stopped).toHaveLength(0);
    expect(outcome).toMatchObject({ detail: { lost: 2 } });
  });

  it('isThisNodesSession: SpawnService\'s rule, where a missing node on either side counts as this node', () => {
    expect(isThisNodesSession('node-a', 'node-a')).toBe(true);
    expect(isThisNodesSession('node-b', 'node-a')).toBe(false);
    expect(isThisNodesSession(null, 'node-a')).toBe(true);
    expect(isThisNodesSession(undefined, 'node-a')).toBe(true);
    expect(isThisNodesSession('node-b', null)).toBe(true);
    expect(isThisNodesSession('node-b', undefined)).toBe(true);
  });

  it('settles an open dispatch run completed, and never stops its session: it is the shared dispatcher (review 1398 item 5)', async () => {
    const { db, port, rec } = harness({
      open: [openRun({ runId: 'r-dispatch', action: 'dispatch', sessionId: 'dispatcher', maxRuntimeSeconds: 60,
        firedAt: new Date(AT.getTime() - 120_000).toISOString() })],
      live: ['dispatcher'],
    });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rpcsNamed(rec, 'loop_run_settle').map((r) => [r.args[0], r.args[1]])).toEqual([['r-dispatch', 'completed']]);
    expect(rec.stopped).toHaveLength(0);
  });

  it('a dispatch run with no session yet is still in flight, not delivered: the launch rule applies (review 1398 item 16)', async () => {
    // A Run now of a dispatch loop may still be spawning the dispatcher when a
    // tick's sweep runs; settling it 'completed' would make its failure unrecordable.
    const { db, port, rec } = harness({
      open: [
        openRun({ runId: 'r-in-flight', action: 'dispatch', sessionId: null, sessionStatus: null, firedAt: new Date(AT.getTime() - 60_000).toISOString() }),
        openRun({ runId: 'r-died', action: 'dispatch', sessionId: null, sessionStatus: null, firedAt: new Date(AT.getTime() - 11 * 60_000).toISOString() }),
      ],
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    expect(rpcsNamed(rec, 'loop_run_settle').map((r) => r.args)).toEqual([
      ['r-died', 'failed', 'the launch was never recorded (the server may have restarted mid-firing)'],
    ]);
    expect(outcome).toMatchObject({ detail: { abandoned: 1 } });
  });

  it('settles a session someone stopped (outcome stopped) as stopped, not completed (review 1398 nit 10)', async () => {
    const { db, port, rec } = harness({ open: [openRun({ runId: 'r-stopped', sessionStatus: 'exited', sessionOutcome: 'stopped' })] });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rpcsNamed(rec, 'loop_run_settle').map((r) => [r.args[0], r.args[1]])).toEqual([['r-stopped', 'stopped']]);
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

describe('bridge loops (Bridges L, D26)', () => {
  it('a post loop fires with no session and settles at delivery', async () => {
    const { db, port, rec } = harness({
      due: [dueLoop({ action: 'post', teamMemberId: null })],
      fire: async (loop, _c, firedAt, runId) => {
        rec.fired.push({ loopId: loop.entityId, firedAt: firedAt.toISOString(), runId, identity: undefined });
        return { taskId: null, sessionId: null };
      },
    });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rpcsNamed(rec, 'loop_run_launched').map(r => r.args)).toEqual([['run-1', null, null]]);
    expect(rpcsNamed(rec, 'loop_run_settle').map(r => r.args)).toEqual([['run-1', 'completed', null]]);
  });

  it('concurrency replace stops the previous live run and settles it stopped BEFORE claiming the new one', async () => {
    const { db, port, rec } = harness({
      due: [dueLoop({ concurrency: 'replace' })],
      toReplace: [{ runId: 'run-old', sessionId: 'session-old' }],
      live: ['session-old'],
    });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rec.stopped.map(s => s.sessionId)).toEqual(['session-old']);
    expect(rec.stopped[0]!.identity).toBe('identity-space-1-owner');
    const order = rec.rpcs.map(r => `${r.fn}:${String(r.args[0])}`);
    expect(order.indexOf('loop_run_settle:run-old')).toBeLessThan(order.indexOf('loop_run_claim:loop-1'));
    expect(rpcsNamed(rec, 'loop_run_settle')[0]!.args).toEqual(['run-old', 'stopped', 'replaced by a newer run']);
    expect(rec.fired).toHaveLength(1);
  });

  it('a skip loop never stops a previous run', async () => {
    const { db, port, rec } = harness({ due: [dueLoop()], toReplace: [{ runId: 'run-old', sessionId: 'session-old' }] });
    await createLoopsJob({ db, port }).run(ctx());
    expect(rec.stopped).toEqual([]);
  });

  it('closes an interactive run idle for 30 minutes (stop, then completed) and reports held posts released', async () => {
    const { db, port, rec } = harness({
      idle: [{ runId: 'run-i', loopId: 'loop-i', spaceId: 'space-1', sessionId: 'session-i', actAsIdentity: 'identity-space-1-owner' }],
      released: 2,
    });
    const outcome = await createLoopsJob({ db, port }).run(ctx());
    expect(rec.stopped).toEqual([{ sessionId: 'session-i', reason: 'interactive loop idle for 30 minutes', identity: 'identity-space-1-owner' }]);
    expect(rpcsNamed(rec, 'loop_run_settle').map(r => r.args)).toEqual([['run-i', 'completed', null]]);
    expect(rpcsNamed(rec, 'loop_release_held')).toHaveLength(1);
    expect(outcome).toMatchObject({ detail: { idleClosed: 1, released: 2 } });
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
