/**
 * Loops end to end (design 01a182d4 §11): the production facade AND its
 * scheduler on a throwaway Postgres, real PTYs (echo-agent) and the built CLI
 * as a subprocess, so every step is what a human or an agent at a terminal
 * does. The value over loop-runs.pg.test.ts (a hand-built job, ticked by the
 * test) is the real timer: the loop is created through `tm8 loop create` and
 * the node's own scheduler fires it, a minute later, unprompted.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { LoopRun, LoopRunListResult, LoopRunResult, LoopSchedulePreview, LoopView } from '@tm8/contract';
import { startWsE2eNode, type WsE2eNode } from '../events/ws-e2e-harness.js';
import { REPO_ROOT } from '../db/w1-pg.js';

// The scheduler's first tick is 60 s after boot and then every 60 s; one case waits for a real one.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

let node: WsE2eNode, spaceId: string, runner: string, loopId: string;
const sessions = new Set<string>();

async function cli(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [join(REPO_ROOT, 'packages/cli/dist/index.js'), ...args], {
      cwd: REPO_ROOT, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
      // The harness may run inside a production tm8 session: never inherit its
      // actor, token, server or manifest into this scratch node.
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/tmp',
        TM8_BASE_URL: node.baseUrl, TM8_SPACE_ID: spaceId, TM8_CREDENTIALS_MODE: 'off',
        TM8_SESSION_ID: '', TM8_AGENT_TOKEN: '', TM8_MANIFEST_PATH: '', TM8_TEAM_MEMBER_ID: '',
        TM8_JOURNAL_CLASS: 'human', TM8_NO_TERSE_DEFAULT: '1',
      },
    }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed)) return reject(error);
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

async function json<T>(args: string[]): Promise<T> {
  const result = await cli(['--format', 'json', ...args]);
  expect(result.code, `tm8 ${args.join(' ')}: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as T;
}

beforeAll(async () => {
  node = await startWsE2eNode('loops', { startBackgroundJobs: true });
  const created = await node.request<{ space: { id: string } }>('POST', '/v2/spaces', { name: 'Loops e2e', clientMutationId: randomUUID() });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  spaceId = created.data!.space.id;
  // A house teammate the new space was seeded with runs each firing.
  const [row] = await node.database.query<{ id: string }>(
    `select e.id from public.entities e join public.team_members t on t.entity_id = e.id
      where e.space_id = $1 and e.deleted_at is null order by (t.name = 'Worker') desc, t.name limit 1`, [spaceId]);
  expect(row, 'the new space has a teammate').toBeTruthy();
  runner = row!.id;
});

afterAll(async () => {
  // The scheduler first, so no tick fires into a database that is going away.
  await node?.production.scheduler?.stop(2_000);
  for (const id of sessions) node?.production.execution?.pty.kill(id);
  await node?.close();
});

const loopCount = async () => (await node.database.query<{ count: number }>(
  "select count(*)::int as count from public.entities where space_id = $1 and kind = 'loop'", [spaceId]))[0]!.count;

it('previews a schedule in the loop\'s own timezone and stores nothing', async () => {
  const before = await loopCount();
  const preview = await json<LoopSchedulePreview>(['loop', 'preview', '--schedule', '0 9 * * 1-5', '--timezone', 'Asia/Kolkata', '--count', '3']);
  expect(preview).toMatchObject({ valid: true, problem: null });
  expect(preview.summary).toContain('Asia/Kolkata');
  expect(preview.next).toHaveLength(3);
  // 09:00 in Kolkata is 03:30 UTC, on weekdays only.
  for (const instant of preview.next) {
    expect(instant).toMatch(/T03:30:00\.000Z$/);
    expect([1, 2, 3, 4, 5]).toContain(new Date(instant).getUTCDay());
  }
  const invalid = await cli(['loop', 'preview', '--schedule', 'every 0m']);
  expect(invalid.code).toBe(2);
  expect(invalid.stdout).toMatch(/^invalid: /);
  expect(await loopCount()).toBe(before);
});

it('a loop created through the CLI fires on the node\'s own tick, records the run, and its session points home', async () => {
  const loop = await json<LoopView>(['loop', 'create', 'Every minute', '--schedule', '* * * * *', '--teammate', runner, '--prompt', 'e2e: say hello']);
  expect(loop.state.enabled).toBe(true);
  expect(loop.state.nextRunAt, 'the server computed the first deadline').not.toBeNull();
  loopId = loop.id;
  let run: LoopRun | undefined;
  await vi.waitFor(async () => {
    const page = await json<LoopRunListResult>(['loop', 'runs', loopId]);
    run = page.items.find(item => item.trigger === 'schedule' && item.sessionId !== null);
    expect(run, 'a scheduled run with a session').toBeTruthy();
  }, { timeout: 200_000, interval: 2_000 });
  sessions.add(run!.sessionId!);
  expect(run).toMatchObject({ loopId, action: 'spawn', attempt: 1 });
  expect(run!.taskId).not.toBeNull();
  const edges = await node.database.query<{ src_id: string }>(
    "select src_id from public.edges where dst_id = $1 and type = 'triggered_by'", [loopId]);
  expect(edges.map(edge => edge.src_id)).toEqual(expect.arrayContaining([run!.sessionId, run!.taskId]));
  const shown = await json<LoopView>(['loop', 'show', loopId]);
  expect(shown.state.lastRunAt).not.toBeNull();
  expect(Date.parse(shown.state.nextRunAt!)).toBeGreaterThan(Date.parse(run!.firedAt));
});

it('Run now refuses while a run is live, then fires at once when forced; stop settles it', async () => {
  const refused = await cli(['loop', 'run-now', loopId]);
  expect(refused.code, refused.stdout).toBe(6);
  expect(refused.stderr).toContain('loop_run_overlap');

  const { run } = await json<LoopRunResult>(['loop', 'run-now', loopId, '--force']);
  expect(run).toMatchObject({ loopId, trigger: 'manual', status: 'running' });
  expect(run.sessionId, 'Run now answers the session it started').not.toBeNull();
  sessions.add(run.sessionId!);

  const stopped = await json<LoopRunResult>(['loop', 'stop', run.id]);
  expect(stopped.run.status).toBe('stopped');
  const again = await cli(['loop', 'stop', run.id]);
  expect(again.code, 'stopping a stopped run is answered as it is').toBe(0);

  // Every tick moves the version (a firing or a skipped one), so a refused disable is read again and retried.
  await vi.waitFor(async () => {
    const version = (await json<LoopView>(['loop', 'show', loopId])).version;
    const disabled = await cli(['--format', 'json', 'loop', 'disable', loopId, '--expect-version', String(version)]);
    expect(disabled.code, disabled.stderr).toBe(0);
    expect((JSON.parse(disabled.stdout) as LoopView).state.enabled).toBe(false);
  }, { timeout: 30_000, interval: 500 });
});
