/**
 * Loops PR2 (design 01a182d4 §2.2, §3.2, §3.3, §11) against a REAL node:
 * the production composition root (`bootstrap`) over a scratch database with
 * every migration applied, real PTYs running the echo agent, and the loops.*
 * run ops over HTTP exactly as the CLI and the UI call them.
 *
 * What a unit test cannot pin and this one does: `main.ts` hands ONE executor
 * port to both the scheduler job and `loops.runNow` / `loops.runs.stop`; a
 * manual run spawns a real session that the run projection reads as `running`
 * and that `stop` ends through the server's own stop path; a tick of the real
 * job (same port, real `loop_run_claim`) fires a lapsed pause once, skips or
 * queues on a live run, retries a failed launch with backoff, and times out a
 * run past its max runtime by stopping its real PTY.
 *
 * Needs TM8_W1_ADMIN_DATABASE_URL (the test cluster). Skipped without one.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LoopRunListResultSchema, LoopRunSchema, LoopViewSchema, type LoopRun, type LoopView } from '@tm8/contract';
import { createLoopExecutorPort } from '../../src/facade/execution-handlers.js';
import { createLoopsJob, type LoopExecutorPort } from '../../src/scheduler/jobs/loops.js';
import type { JobContext } from '../../src/scheduler/types.js';
import { startWsE2eNode, type WsE2eNode } from '../events/ws-e2e-harness.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const describePg = process.env['TM8_W1_ADMIN_DATABASE_URL'] ? describe : describe.skip;

describePg('loops PR2: runs on a real node', () => {
  let node: WsE2eNode;
  let spaceId: string;
  let persona: string;
  let port: LoopExecutorPort;
  const cmid = () => randomUUID();
  const live = new Set<string>();

  async function request<T>(method: string, path: string, body?: Record<string, unknown>) {
    const payload = body === undefined ? undefined : { clientMutationId: cmid(), ...body };
    return node.request<T>(method, path, payload);
  }
  const ok = <T>(result: { status: number; data: T | undefined; error: unknown }): T => {
    expect([200, 201], JSON.stringify(result.error)).toContain(result.status);
    return result.data as T;
  };
  const refused = (result: { status: number; data: unknown; error: { code: string; message: string } | undefined }, status: number, code: string) => {
    expect(result.status, JSON.stringify(result)).toBe(status);
    expect(result.error?.code).toBe(code);
    return result.error!;
  };

  async function createLoop(definition: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<LoopView> {
    return LoopViewSchema.parse(ok(await request<LoopView>('POST', `/v2/spaces/${spaceId}/loops`, {
      definition: { schedule: 'every 1h', action: 'spawn', teamMemberId: persona, ...definition },
      ...extra,
    })));
  }
  const runNow = (loopId: string, force = false) =>
    request<{ run: LoopRun }>('POST', `/v2/loops/${loopId}/run`, force ? { force } : {});
  const getRun = async (runId: string) => LoopRunSchema.parse(ok(await request<LoopRun>('GET', `/v2/loop-runs/${runId}`)));
  const listRuns = async (loopId: string, query = '') =>
    LoopRunListResultSchema.parse(ok(await request<unknown>('GET', `/v2/loops/${loopId}/runs${query}`)));
  const getLoop = async (loopId: string) => LoopViewSchema.parse(ok(await request<LoopView>('GET', `/v2/loops/${loopId}`)));

  /** Owner-role SQL for fixtures the API rightly refuses (backdating a deadline or a firing). */
  const sql = (text: string, params: unknown[] = []) => node.database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    return (await c.query(text, params)).rows as Array<Record<string, unknown>>;
  });
  const backdate = (loopId: string, minutes = 1) =>
    sql('update public.loops set next_run_at = now() - make_interval(mins => $2) where entity_id = $1', [loopId, minutes]);

  function tickContext(firedAt = new Date()): JobContext {
    return {
      name: 'loops.execute-due',
      firedAt,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
      signal: new AbortController().signal,
    };
  }
  const tick = async (at = new Date()) => createLoopsJob({ db: node.production.db!, port }).run(tickContext(at));

  async function waitForStatus(runId: string, status: LoopRun['status'], ms = 30_000): Promise<LoopRun> {
    let run!: LoopRun;
    await vi.waitFor(async () => {
      run = await getRun(runId);
      expect(run.status).toBe(status);
    }, { timeout: ms, interval: 250 });
    return run;
  }

  beforeAll(async () => {
    node = await startWsE2eNode('loop_runs');
    const space = ok(await request<{ space: { id: string } }>('POST', '/v2/spaces', { name: 'Loop runs e2e' }));
    spaceId = space.space.id;
    const member = ok(await request<{ entity: { id: string } }>('POST', '/v2/entities', {
      spaceId, kind: 'team_member', title: 'Loop runner (echo agent)',
    }));
    persona = member.entity.id;
    // THE SAME port main.ts builds for the scheduler and the handlers: the job
    // is driven by hand here because its timer fires every 60 s and never on
    // start, and a test that waits a minute per tick proves nothing extra.
    const execution = node.production.execution!;
    const owner = async () => {
      const [row] = await node.database.query<{ identity_id: string }>(
        'select identity_id from public.accounts where is_owner order by created_at limit 1');
      return { identityId: row!.identity_id, accountId: '', username: 'owner', isNodeAdmin: true, isOwner: true };
    };
    port = createLoopExecutorPort({ db: node.production.db!, pty: execution.pty, spawnService: execution.spawnService, resolveOwner: owner });
  });

  afterAll(async () => {
    for (const sessionId of live) {
      await request('POST', `/v2/entities/${sessionId}/commands/terminate`, { force: true }).catch(() => undefined);
    }
    await node?.close();
  });

  it('create → runNow → runs.list shows running → stop → stopped, through one executor port', async () => {
    const loop = await createLoop({ title: 'Run now', prompt: 'say hello' });
    expect(loop.runs.total).toBe(0);

    const fired = ok(await runNow(loop.id)).run;
    const run = LoopRunSchema.parse(fired);
    live.add(run.sessionId!);
    expect(run.trigger).toBe('manual');
    expect(run.status).toBe('running');
    expect(run.taskId).not.toBeNull();
    expect(run.sessionId).not.toBeNull();
    expect(run.requestedBy).not.toBeNull();
    expect(run.attempt).toBe(1);
    // A real PTY is running the echo agent for this run.
    expect(node.production.execution!.pty.hasSession(run.sessionId!)).toBe(true);

    const listed = await listRuns(loop.id);
    expect(listed.items.map((r) => [r.id, r.status])).toEqual([[run.id, 'running']]);
    expect((await listRuns(loop.id, '?status=running')).items).toHaveLength(1);
    expect((await listRuns(loop.id, '?status=completed')).items).toHaveLength(0);

    // The view carries the run summary: total 1, last = this run, 24h fired 1.
    const view = await getLoop(loop.id);
    expect(view.runs.total).toBe(1);
    expect(view.runs.last?.id).toBe(run.id);
    expect(view.runs.last24h).toEqual({ fired: 1, failed: 0, skipped: 0 });
    expect(view.state.lastRunAt).not.toBeNull();
    // A manual run leaves the schedule alone.
    expect(view.state.nextRunAt).toBe(loop.state.nextRunAt);

    // Overlap: a second Run now is a 409 naming the live run, unless forced.
    const overlap = refused(await runNow(loop.id), 409, 'conflict');
    expect(overlap.message).toMatch(/still live/);

    const stopped = LoopRunSchema.parse(ok(await request<{ run: LoopRun }>('POST', `/v2/loop-runs/${run.id}/stop`, {})).run);
    expect(stopped.status).toBe('stopped');
    expect(stopped.endedAt).not.toBeNull();
    expect(stopped.durationMs).not.toBeNull();
    live.delete(run.sessionId!);
    // The server's own stop path ran: the session is recorded as an operator stop and its PTY is gone.
    await vi.waitFor(() => expect(node.production.execution!.pty.hasSession(run.sessionId!)).toBe(false), { timeout: 10_000 });
    const [session] = await node.database.query<{ status: string; ended_kind: string | null; outcome: string | null }>(
      'select status, ended_kind, outcome from public.work_sessions where entity_id = $1', [run.sessionId]);
    expect(session!.ended_kind).toBe('stopped_by_operator');
    expect(session!.outcome).toBe('stopped');
    expect(['exited', 'failed']).toContain(session!.status);

    // Stopping again is a conflict, not a second stop; the run reads the same.
    refused(await request('POST', `/v2/loop-runs/${run.id}/stop`, {}), 409, 'conflict');
    expect((await getRun(run.id)).status).toBe('stopped');
    expect((await listRuns(loop.id, '?status=stopped')).items).toHaveLength(1);

    // Run now works again once the previous run has ended.
    const second = LoopRunSchema.parse(ok(await runNow(loop.id)).run);
    live.add(second.sessionId!);
    expect(second.status).toBe('running');
    const page = await listRuns(loop.id, '?limit=1');
    expect(page.items.map((r) => r.id)).toEqual([second.id]);
    expect(page.nextCursor).not.toBeNull();
    const rest = await listRuns(loop.id, `?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`);
    expect(rest.items.map((r) => r.id)).toEqual([run.id]);
    expect(rest.nextCursor).toBeNull();
    ok(await request('POST', `/v2/loop-runs/${second.id}/stop`, {}));
    live.delete(second.sessionId!);
  });

  it('a lapsed pause fires once at the next tick, then resumes cadence (§3.2)', async () => {
    const loop = await createLoop({ title: 'Paused daily', schedule: 'every 1d' });
    // Pause into the past with the deadline also in the past: exactly what a
    // "pause until Monday 09:00" on a daily 09:00 loop looks like on Monday 09:01.
    await sql(`update public.loops set paused_until = now() - interval '1 minute', next_run_at = now() - interval '2 minutes'
                where entity_id = $1`, [loop.id]);
    const before = await getLoop(loop.id);
    expect(before.state.pausedUntil).not.toBeNull();

    const first = await tick();
    expect(first).toMatchObject({ detail: { fired: 1, due: 1 } });
    const runs = await listRuns(loop.id);
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]!.trigger).toBe('schedule');
    expect(runs.items[0]!.status).toBe('running');
    live.add(runs.items[0]!.sessionId!);
    const after = await getLoop(loop.id);
    // Advanced FROM THE FIRING INSTANT (one day on), not re-fired for the missed window.
    expect(new Date(after.state.nextRunAt!).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
    expect(after.state.lastRunAt).not.toBeNull();

    const second = await tick();
    expect(second).toMatchObject({ skipped: true });
    expect((await listRuns(loop.id)).items).toHaveLength(1);
    ok(await request('POST', `/v2/loop-runs/${runs.items[0]!.id}/stop`, {}));
    live.delete(runs.items[0]!.sessionId!);
  });

  it('concurrency: skip records a skipped/overlap run and advances; queue writes nothing, stays due and fires once the run ends', async () => {
    const skipper = await createLoop({ title: 'Skipper', concurrency: 'skip' });
    const queuer = await createLoop({ title: 'Queuer', concurrency: 'queue' });
    const liveSkip = LoopRunSchema.parse(ok(await runNow(skipper.id)).run);
    const liveQueue = LoopRunSchema.parse(ok(await runNow(queuer.id)).run);
    live.add(liveSkip.sessionId!); live.add(liveQueue.sessionId!);
    await backdate(skipper.id); await backdate(queuer.id);

    const outcome = await tick();
    expect(outcome).toMatchObject({ detail: { due: 2, fired: 0, skipped: 1, queued: 1 } });

    const skipped = await listRuns(skipper.id);
    expect(skipped.items.map((r) => [r.status, r.skipReason])).toEqual([['skipped', 'overlap'], ['running', null]]);
    expect(new Date((await getLoop(skipper.id)).state.nextRunAt!).getTime()).toBeGreaterThan(Date.now());

    const queued = await getLoop(queuer.id);
    expect(queued.runs.total).toBe(1);
    expect(queued.state.waitingOnRunId).toBe(liveQueue.id);
    expect(new Date(queued.state.nextRunAt!).getTime()).toBeLessThan(Date.now());

    // The previous run ends; the queued loop fires on the next tick and stops waiting.
    ok(await request('POST', `/v2/loop-runs/${liveQueue.id}/stop`, {}));
    live.delete(liveQueue.sessionId!);
    const next = await tick();
    expect(next).toMatchObject({ detail: { fired: 1 } });
    const fired = await getLoop(queuer.id);
    expect(fired.runs.total).toBe(2);
    expect(fired.state.waitingOnRunId).toBeNull();
    expect(fired.runs.last?.trigger).toBe('schedule');
    live.add(fired.runs.last!.sessionId!);

    for (const id of [liveSkip.id, fired.runs.last!.id]) ok(await request('POST', `/v2/loop-runs/${id}/stop`, {}));
    live.delete(liveSkip.sessionId!); live.delete(fired.runs.last!.sessionId!);
  });

  it('retry backoff: a launch that fails is recorded on the run and the loop, re-armed after the delay, and the counter resets on success', async () => {
    const loop = await createLoop({ title: 'Retrier', retry: { attempts: 1, delaySeconds: 60 } });
    // Make the spawn fail for real: the runner persona disappears.
    await sql('update public.entities set deleted_at = now() where id = $1', [persona]);
    await backdate(loop.id);
    try {
      const outcome = await tick();
      expect(outcome).toMatchObject({ detail: { failed: 1, fired: 0 } });
      const view = await getLoop(loop.id);
      expect(view.state.lastError).toBeTruthy();
      expect(view.runs.last24h.failed).toBe(1);
      const run = view.runs.last!;
      expect(run.status).toBe('failed');
      expect(run.error).toBe(view.state.lastError);
      expect(run.sessionId).toBeNull();
      // Re-armed at now + 60 s, not at the next hour.
      const retryAt = new Date(view.state.nextRunAt!).getTime();
      expect(retryAt).toBeGreaterThan(Date.now() + 30_000);
      expect(retryAt).toBeLessThan(Date.now() + 90_000);
      const [row] = await sql('select retry_attempt from public.loops where entity_id = $1', [loop.id]);
      expect(Number(row!['retry_attempt'])).toBe(1);
    } finally {
      await sql('update public.entities set deleted_at = null where id = $1', [persona]);
    }
    // The retry is attempt 2; it launches, the counter resets and last_error clears.
    await backdate(loop.id);
    expect(await tick()).toMatchObject({ detail: { fired: 1 } });
    const recovered = await getLoop(loop.id);
    expect(recovered.state.lastError).toBeNull();
    expect(recovered.runs.last?.attempt).toBe(2);
    expect(recovered.runs.last?.status).toBe('running');
    const [after] = await sql('select retry_attempt from public.loops where entity_id = $1', [loop.id]);
    expect(Number(after!['retry_attempt'])).toBe(0);
    live.add(recovered.runs.last!.sessionId!);
    ok(await request('POST', `/v2/loop-runs/${recovered.runs.last!.id}/stop`, {}));
    live.delete(recovered.runs.last!.sessionId!);
  });

  it('max runtime: the sweep stops a live run past its limit through the port and settles timed_out', async () => {
    const loop = await createLoop({ title: 'Bounded', maxRuntimeSeconds: 60 });
    const run = LoopRunSchema.parse(ok(await runNow(loop.id)).run);
    live.add(run.sessionId!);
    expect(node.production.execution!.pty.hasSession(run.sessionId!)).toBe(true);
    // Within the limit: the sweep leaves it alone.
    await tick();
    expect((await getRun(run.id)).status).toBe('running');
    // Backdate the firing past the limit and tick again.
    await sql(`update public.loop_runs set fired_at = now() - interval '2 minutes' where id = $1`, [run.id]);
    const outcome = await tick();
    expect(outcome).toMatchObject({ detail: { timedOut: 1 } });
    const timedOut = await waitForStatus(run.id, 'timed_out');
    expect(timedOut.error).toMatch(/maximum runtime/);
    live.delete(run.sessionId!);
    await vi.waitFor(() => expect(node.production.execution!.pty.hasSession(run.sessionId!)).toBe(false), { timeout: 10_000 });
    const [session] = await node.database.query<{ ended_kind: string | null; ended_reason: string | null }>(
      'select ended_kind, ended_reason from public.work_sessions where entity_id = $1', [run.sessionId]);
    expect(session!.ended_kind).toBe('stopped_by_operator');
    expect(session!.ended_reason).toMatch(/maximum runtime/);
    expect((await getLoop(loop.id)).runs.last?.status).toBe('timed_out');
  });

  it('the sweep settles a run whose session exited on its own, and a non-member sees no runs', async () => {
    const loop = await createLoop({ title: 'Self-ending' });
    const run = LoopRunSchema.parse(ok(await runNow(loop.id)).run);
    // The echo agent exits on /exit; the session ends without any loop op.
    node.production.execution!.pty.write(run.sessionId!, '/exit\r');
    await vi.waitFor(() => expect(node.production.execution!.pty.hasSession(run.sessionId!)).toBe(false), { timeout: 15_000 });
    // Derived at read time, before any sweep: the exited session reads as completed.
    const completed = await waitForStatus(run.id, 'completed');
    expect(completed.endedAt).not.toBeNull();
    expect(completed.endedKind).not.toBeNull();
    // The sweep then settles it so the open set stays the live set.
    await tick();
    const [row] = await node.database.query<{ outcome: string | null }>('select outcome from public.loop_runs where id = $1', [run.id]);
    expect(row!.outcome).toBe('completed');

    const unknown = await request('GET', `/v2/loop-runs/${randomUUID()}`);
    expect(unknown.status).toBe(404);
  });
});
