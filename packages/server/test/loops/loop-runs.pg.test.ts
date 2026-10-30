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
 * run past its max runtime by stopping its real PTY. Loops PR3 adds a TOOL
 * run: Run now fires it through the server's ToolRuntime, and both stops end
 * it through the tool's own launcher.
 *
 * Needs TM8_W1_ADMIN_DATABASE_URL (the test cluster). Skipped without one.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LoopRunListResultSchema, LoopRunSchema, LoopViewSchema, ToolRunSchema, type LoopRun, type LoopView } from '@tm8/contract';
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

    const stopCmid = cmid();
    const stopped = LoopRunSchema.parse(ok(await request<{ run: LoopRun }>('POST', `/v2/loop-runs/${run.id}/stop`, { clientMutationId: stopCmid })).run);
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

    // A transport retry of the same stop replays its answer (review 1398 item 6); it is not a second stop.
    const again = LoopRunSchema.parse(ok(await request<{ run: LoopRun }>('POST', `/v2/loop-runs/${run.id}/stop`, { clientMutationId: stopCmid })).run);
    expect(again).toMatchObject({ id: run.id, status: 'stopped', endedAt: stopped.endedAt });
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
    // The queuer is held back by its LIVE Run-now run, so the due read does not
    // return it at all (no tick slot spent on it); it stays due and waits.
    expect(outcome).toMatchObject({ detail: { due: 1, fired: 0, skipped: 1, queued: 0 } });

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

  it('a replayed Run now whose launch failed answers the failed run and starts no session', async () => {
    const loop = await createLoop({ title: 'Replay after a failed launch' });
    const clientMutationId = cmid();
    await sql('update public.entities set deleted_at = now() where id = $1', [persona]);
    try {
      const first = await request<{ run: LoopRun }>('POST', `/v2/loops/${loop.id}/run`, { clientMutationId });
      expect(first.status, JSON.stringify(first)).toBeGreaterThanOrEqual(400);
    } finally {
      await sql('update public.entities set deleted_at = null where id = $1', [persona]);
    }
    // The persona is back, so firing again WOULD start a session that no run records.
    const replay = ok(await request<{ run: LoopRun }>('POST', `/v2/loops/${loop.id}/run`, { clientMutationId }));
    expect(replay.run).toMatchObject({ status: 'failed', sessionId: null });
    expect((await listRuns(loop.id)).items).toHaveLength(1);
  });

  it("a dispatch run is timed by its own firing, never by the shared dispatcher session", async () => {
    const loop = await createLoop({ title: 'Dispatcher stand-in' });
    const { run } = ok(await runNow(loop.id));
    live.add(run.sessionId!);
    try {
      // A request delivered into that long-lived session an hour later, settled at delivery.
      const [row] = await sql(
        `insert into public.loop_runs(loop_id, space_id, fired_at, trigger, action, launch, session_id, outcome, ended_at)
         values ($1, $2, now() + interval '1 hour', 'schedule', 'dispatch', 'fired', $3, 'completed', now() + interval '1 hour')
         returning id`, [loop.id, spaceId, run.sessionId]);
      const dispatched = await getRun(String(row!['id']));
      expect(dispatched.startedAt).toBe(dispatched.firedAt);
      expect(dispatched.endedAt).toBe(dispatched.firedAt);
      expect(dispatched.durationMs).toBe(0);
      expect(dispatched.usage).toBeNull();
    } finally {
      ok(await request('POST', `/v2/loop-runs/${run.id}/stop`, {}));
      live.delete(run.sessionId!);
    }
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

  it('a session stopped outside the loop reads stopped before any sweep, and the sweep settles it stopped (review 1398 nit 10, item 18)', async () => {
    const loop = await createLoop({ title: 'Stopped by an operator' });
    const run = LoopRunSchema.parse(ok(await runNow(loop.id)).run);
    // execution.terminate, not loops.runs.stop: the loop learns of it only from the session.
    ok(await request('POST', `/v2/entities/${run.sessionId}/commands/terminate`, {}));
    await vi.waitFor(() => expect(node.production.execution!.pty.hasSession(run.sessionId!)).toBe(false), { timeout: 15_000 });
    const stopped = await waitForStatus(run.id, 'stopped');
    expect(stopped.endedAt).not.toBeNull();
    await tick();
    const [row] = await node.database.query<{ outcome: string | null }>('select outcome from public.loop_runs where id = $1', [run.id]);
    expect(row!.outcome).toBe('stopped');
  });

  it('an overlap with a launch still in flight says how to get its result, not to force (review 1398 nit 25)', async () => {
    const loop = await createLoop({ title: 'Still launching' });
    // A firing claimed but with no session yet: what a Run now that timed out on
    // the client leaves behind while the server is still launching it.
    const [fixture] = await sql(
      `insert into public.loop_runs (loop_id, space_id, fired_at, trigger, action, launch)
       values ($1, $2, now(), 'manual', 'spawn', 'fired') returning id`, [loop.id, spaceId]);
    const runId = fixture!['id'] as string;
    expect(await getRun(runId)).toMatchObject({ status: 'running', sessionId: null });
    // A re-send with a NEW id: refused as an overlap that names the launching run.
    const error = refused(await runNow(loop.id), 409, 'conflict') as { message: string; details?: unknown };
    expect(error.message).toBe(`a run of this loop is still launching (run ${runId}): re-send with the same clientMutationId to get its result, or read loops.runs.get; force starts a second run`);
    expect(error.details).toEqual({ reason: 'loop_run_overlap', runId, launching: true });
    await sql('delete from public.loop_runs where id = $1', [runId]);
  });

  describe('a TOOL run (loops PR3): stop and max runtime end it through the same port', () => {
    // What the Tools lane asked PR3 to pin (msg 01a1884b-c443). Both stops go
    // through the port's stopSession (SpawnService.terminate), and the tool's own
    // launcher must still settle the run: recorded killed and its run-scoped
    // token revoked, not left 'running' for a restart's reconcile, and nothing
    // left holding one of the member's tool slots.
    const tokensOf = (sessionId: string) => node.database.query<{ revoked: boolean }>(
      'select revoked_at is not null as revoked from public.auth_sessions where work_session_id = $1', [sessionId]);

    async function toolLoop(title: string, extra: Record<string, unknown> = {}) {
      // tm8Access read, so the run mints a run-scoped token for the stop to revoke.
      const tool = ok(await request<{ id: string }>('POST', `/v2/spaces/${spaceId}/tools`, { definition: {
        name: `sleeper-${randomUUID().slice(0, 8)}`, description: '', help: '', runtime: 'bash', source: 'sleep 300',
        inputs: [], tm8Access: 'read', timeoutSeconds: 600,
      } }));
      return { toolId: tool.id, loop: await createLoop({ title, action: 'tool', toolId: tool.id, toolInputs: {}, ...extra }) };
    }

    async function fireToolRun(loop: LoopView): Promise<LoopRun> {
      const run = LoopRunSchema.parse(ok(await runNow(loop.id)).run);
      expect(run).toMatchObject({ action: 'tool', status: 'running', taskId: null });
      live.add(run.sessionId!);
      expect(node.production.execution!.pty.hasSession(run.sessionId!)).toBe(true);
      expect(await tokensOf(run.sessionId!)).toEqual([{ revoked: false }]);
      // The tool's own run view (Tools #1412) labels it with its loop, from the
      // provenance-marked triggered_by edge 394's start_tool_session writes.
      const toolRun = ToolRunSchema.parse(ok(await request<unknown>('GET', `/v2/tool-runs/${run.sessionId}`)));
      expect(toolRun.triggeredBy).toEqual({ id: loop.id, title: loop.definition.title });
      return run;
    }

    async function expectToolRunEnded(toolId: string, sessionId: string) {
      // (2) The launcher's own settle: the PTY went away with no status file.
      type Ended = { status: string; outcome: string | null; ended_kind: string | null; tool_state: string | null; tool_keep_open: boolean };
      let ended: Ended | undefined;
      await vi.waitFor(async () => {
        [ended] = await node.database.query<Ended>(
          'select status, outcome, ended_kind, tool_state, tool_keep_open from public.work_sessions where entity_id = $1', [sessionId]);
        expect(ended?.tool_state).toBe('killed');
      }, { timeout: 15_000, interval: 100 });
      // (1) The work session is terminal, an operator stop.
      expect(['exited', 'failed']).toContain(ended!.status);
      expect(ended).toMatchObject({ outcome: 'stopped', ended_kind: 'stopped_by_operator', tool_keep_open: false });
      // (3) Its one run-scoped token is revoked.
      expect(await tokensOf(sessionId)).toEqual([{ revoked: true }]);
      // (5) No PTY, and no session of this tool in a state 318's tool_session_count
      // counts. A loop run is never keep-open: 389 refuses one (tools/scheduled-runs.pg).
      expect(node.production.execution!.pty.hasSession(sessionId)).toBe(false);
      const [held] = await node.database.query<{ n: number }>(
        "select count(*)::int as n from public.work_sessions where tool_id = $1 and status in ('spawning', 'running', 'idle')", [toolId]);
      expect(held!.n).toBe(0);
      live.delete(sessionId);
    }

    it('loops.runs.stop: the tool is recorded killed, its token revoked, and the run reads stopped', async () => {
      const { toolId, loop } = await toolLoop('Tool run, stopped');
      const run = await fireToolRun(loop);
      const stopped = LoopRunSchema.parse(ok(await request<{ run: LoopRun }>('POST', `/v2/loop-runs/${run.id}/stop`, {})).run);
      // (4)
      expect(stopped.status).toBe('stopped');
      await expectToolRunEnded(toolId, run.sessionId!);
      expect((await getRun(run.id)).status).toBe('stopped');
    });

    it('max runtime: the sweep stops the tool, which is recorded killed, its token revoked, and the run timed_out', async () => {
      const { toolId, loop } = await toolLoop('Tool run, bounded', { maxRuntimeSeconds: 60 });
      const run = await fireToolRun(loop);
      await sql(`update public.loop_runs set fired_at = now() - interval '2 minutes' where id = $1`, [run.id]);
      expect(await tick()).toMatchObject({ detail: { timedOut: 1 } });
      // (4)
      const timedOut = await waitForStatus(run.id, 'timed_out');
      expect(timedOut.error).toMatch(/maximum runtime/);
      await expectToolRunEnded(toolId, run.sessionId!);
      expect((await getRun(run.id)).status).toBe('timed_out');
    });
  });
});
