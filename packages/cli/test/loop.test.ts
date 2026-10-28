import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoopRun, LoopView } from '@tm8/contract';
import { run } from '../src/run.js';
import { pauseUntil } from '../src/commands/loop.js';
import { nounHelp } from '../src/discovery/help.js';
import { matchIntent } from '../src/discovery/search.js';

const LOOP = '11111111-1111-7111-8111-111111111111';
const RUN = '22222222-2222-7222-8222-222222222222';
const SPACE = '33333333-3333-7333-8333-333333333333';
const MEMBER = '44444444-4444-7444-8444-444444444444';
const TOOL = '55555555-5555-7555-8555-555555555555';
const SESSION = '66666666-6666-7666-8666-666666666666';
let loop: LoopView;
const loopRun = (): LoopRun => ({ id: RUN, loopId: LOOP, spaceId: SPACE, firedAt: '2026-10-28T10:00:00.000Z', trigger: 'manual',
  requestedBy: null, action: 'spawn', attempt: 1, status: 'running', skipReason: null, error: null, taskId: null, sessionId: SESSION,
  startedAt: '2026-10-28T10:00:01.000Z', endedAt: null, durationMs: null, exitCode: null, outputTail: null,
  actedAs: { id: MEMBER, kind: 'team_member', displayName: 'Opus' } as LoopRun['actedAs'], endedKind: null, usage: null });
let server: Server, baseUrl: string;
let requests: Array<{ method: string; path: string; query: URLSearchParams; body: Record<string, any> }> = [];
let stdout = '', stderr = '', previewValid = true, notImplemented = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://localhost');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any> : {};
      requests.push({ method: req.method!, path: url.pathname, query: url.searchParams, body });
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload));
      };
      let data: unknown = loop;
      if (notImplemented && (url.pathname.endsWith('/run') || url.pathname.includes('/loop-runs/') || url.pathname.endsWith('/runs'))) {
        reply(501, { error: { code: 'not_implemented', message: 'ships in PR2', retryable: false, requestId: 'test' } }); return;
      }
      if (url.pathname.endsWith('/schedule-preview')) data = previewValid
        ? { valid: true, problem: null, summary: 'every 6 hours', next: ['2026-10-28T12:00:00.000Z', '2026-10-28T18:00:00.000Z'] }
        : { valid: false, problem: 'every 0m is not a schedule', summary: '', next: [] };
      else if (url.pathname.endsWith('/loops') && req.method === 'GET') data = { items: [{ ...loop, definition: { ...loop.definition, title: 'Other' } }, loop], nextCursor: null };
      else if (url.pathname.endsWith('/tools')) data = { items: [{ id: TOOL, definition: { name: 'triage' } }], nextCursor: null };
      else if (url.pathname.endsWith('/collections/query')) data = { page: { items: [{ id: MEMBER, title: 'Opus 5.5 1M Teammate' }], nextCursor: null } };
      else if (url.pathname.endsWith('/run') || url.pathname.endsWith('/stop')) data = { run: loopRun() };
      else if (url.pathname.endsWith('/runs')) data = { items: [loopRun()], nextCursor: null };
      else if (url.pathname.includes('/loop-runs/')) data = { ...loopRun(), status: 'completed', outputTail: 'done\n' };
      else if (url.pathname.endsWith('/header')) data = { ok: true };
      reply(200, { data, requestId: 'test' });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port');
  baseUrl = `http://127.0.0.1:${address.port}`;
  // The first command of a cold worker loads the CLI's module graph; pay for it
  // here, not inside the first test's timeout.
  vi.stubEnv('TM8_BASE_URL', baseUrl); vi.stubEnv('TM8_SPACE_ID', SPACE); vi.stubEnv('TM8_CREDENTIALS_MODE', 'off');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await run(['loop', 'preview', '--schedule', 'every 1h']);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
}, 180_000);
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  loop = {
    id: LOOP, spaceId: SPACE, version: 4,
    definition: { title: 'Nightly triage', schedule: '0 2 * * *', timezone: 'Europe/London', action: 'spawn', teamMemberId: MEMBER,
      subjectId: null, toolId: null, toolInputs: {}, prompt: 'Triage the inbox', config: {}, concurrency: 'skip',
      maxRuntimeSeconds: null, retry: { attempts: 0, delaySeconds: 300 } },
    schedule: { valid: true, problem: null, summary: 'at 02:00 every day (Europe/London)', next: ['2026-10-29T02:00:00.000Z'] },
    state: { enabled: true, pausedUntil: null, nextRunAt: '2026-10-29T02:00:00.000Z', lastRunAt: null, lastError: null,
      armedBy: null, armedAt: null, actingAs: { identity: null, via: 'none' }, waitingOnRunId: null },
    runs: { total: 0, last: null, last24h: { fired: 0, failed: 0, skipped: 0 }, usage: { inputTokens: null, outputTokens: null, costUsd: null } },
    createdBy: null, createdAt: '2026-10-28T09:00:00.000Z', updatedAt: '2026-10-28T09:00:00.000Z',
    capabilities: { canEdit: true, canControl: true, canRun: true, canDelete: true },
  } as LoopView;
  requests = []; stdout = ''; stderr = ''; previewValid = true; notImplemented = false;
  vi.stubEnv('TM8_BASE_URL', baseUrl); vi.stubEnv('TM8_SPACE_ID', SPACE); vi.stubEnv('TM8_CREDENTIALS_MODE', 'off');
  vi.stubEnv('TM8_SESSION_ID', ''); vi.stubEnv('TM8_AGENT_TOKEN', ''); vi.stubEnv('TM8_TEAM_MEMBER_ID', '');
  vi.stubEnv('TM8_JOURNAL_CLASS', 'human'); vi.stubEnv('TM8_NO_TERSE_DEFAULT', '1');
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const last = () => requests.at(-1)!;

describe('tm8 loop create', () => {
  it('resolves a teammate name and sends a spawn definition with launch config', async () => {
    expect(await run(['loop', 'create', 'Nightly triage', '--schedule', '0 2 * * *', '--timezone', 'Europe/London',
      '--teammate', 'opus 5.5 1m teammate', '--prompt', 'Triage the inbox', '--model', 'claude-opus-5-5', '--workdir', 'worktree',
      '--base-ref', 'origin/main', '--memory', 'm1', '--memory', 'm2', '--credential-source', 'space', '--concurrency', 'queue',
      '--max-runtime', '3600', '--retry', '2', '--mutation-id', 'mut-1'])).toBe(0);
    expect(requests.some(r => r.path.endsWith('/collections/query') && r.body.kinds?.[0] === 'team_member')).toBe(true);
    const create = requests.find(r => r.method === 'POST' && r.path === `/v2/spaces/${SPACE}/loops`)!;
    expect(create.body).toMatchObject({ clientMutationId: 'mut-1', enabled: true, definition: {
      title: 'Nightly triage', schedule: '0 2 * * *', timezone: 'Europe/London', action: 'spawn', teamMemberId: MEMBER,
      prompt: 'Triage the inbox', concurrency: 'queue', maxRuntimeSeconds: 3600, retry: { attempts: 2 },
      config: { model: 'claude-opus-5-5', workdir: { mode: 'worktree', baseRef: 'origin/main' }, memoryIds: ['m1', 'm2'], credentialSource: 'space' },
    } });
    expect(stdout).toContain(`loop ${LOOP} v4 · enabled`);
    expect(stdout).toContain('schedule: 0 2 * * * (Europe/London) — at 02:00 every day (Europe/London)');
  });
  it('resolves a tool name, types --input values and can start disabled', async () => {
    expect(await run(['loop', 'create', 'Sweep', '--schedule', 'every 6h', '--tool', 'triage', '--input', 'limit=5', '--input', 'repo=owner/repo', '--disabled'])).toBe(0);
    expect(last().body).toMatchObject({ enabled: false, definition: { action: 'tool', toolId: TOOL, toolInputs: { limit: 5, repo: 'owner/repo' } } });
  });
  it('sets selection headers through entities.header.set, then rereads the loop', async () => {
    expect(await run(['loop', 'create', 'Sweep', '--schedule', 'every 1d', '--dispatch', '--when-to-use', 'Open when triage stalls', '--mutation-id', 'mut-h'])).toBe(0);
    const header = requests.find(r => r.path.endsWith('/header'))!;
    expect(header.body).toMatchObject({ clientMutationId: 'mut-h:header', whenToUse: 'Open when triage stalls' });
    expect(last()).toMatchObject({ method: 'GET', path: `/v2/loops/${LOOP}` });
  });
  it('refuses usage errors locally with exit 2', async () => {
    expect(await run(['loop', 'create', 'X', '--teammate', MEMBER])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h'])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--tool', 'triage'])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--tool', TOOL, '--model', 'm'])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--credential-source', 'anthropic=member'])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--concurrency', 'parallel'])).toBe(2);
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
  });
  it('prints the LoopView as JSON on --format json', async () => {
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--format', 'json'])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ id: LOOP, version: 4 });
  });
});

describe('tm8 loop edit and controls', () => {
  it('edit sends only the flags given and requires --expect-version', async () => {
    expect(await run(['loop', 'edit', LOOP, '--schedule', 'every 30m'])).toBe(2);
    expect(await run(['loop', 'edit', LOOP, '--expect-version', '4'])).toBe(2);
    expect(await run(['loop', 'edit', LOOP, '--schedule', 'every 30m', '--clear-subject', '--retry-delay', '60', '--expect-version', '4'])).toBe(0);
    expect(last()).toMatchObject({ method: 'PATCH', path: `/v2/loops/${LOOP}`,
      body: { expectedVersion: 4, definition: { schedule: 'every 30m', subjectId: null, retry: { delaySeconds: 60 } } } });
    expect(Object.keys(last().body.definition).sort()).toEqual(['retry', 'schedule', 'subjectId']);
  });
  it('edit refuses header flags (they belong to tm8 entity header set)', async () => {
    expect(await run(['loop', 'edit', LOOP, '--summary', 'x', '--expect-version', '4'])).toBe(2);
  });
  it('resolves a loop by exact title, not by substring', async () => {
    expect(await run(['loop', 'enable', 'Nightly triage', '--expect-version', '4'])).toBe(0);
    expect(requests[0]!.query.get('words')).toBe('Nightly triage');
    expect(last()).toMatchObject({ method: 'POST', path: `/v2/loops/${LOOP}/enable`, body: { expectedVersion: 4 } });
    expect(await run(['loop', 'show', 'Missing'])).toBe(5);
  });
  it.each(['enable', 'disable', 'resume'])('%s posts the expected version', async verb => {
    expect(await run(['loop', verb, LOOP])).toBe(2);
    expect(await run(['loop', verb, LOOP, '--expect-version', '4'])).toBe(0);
    expect(last()).toMatchObject({ method: 'POST', path: `/v2/loops/${LOOP}/${verb}`, body: { expectedVersion: 4 } });
  });
  it('pause takes ISO or a relative +<n>{m|h|d}', async () => {
    expect(await run(['loop', 'pause', LOOP, '--until', '2026-11-01T00:00:00Z', '--expect-version', '4'])).toBe(0);
    expect(last()).toMatchObject({ path: `/v2/loops/${LOOP}/pause`, body: { expectedVersion: 4, until: '2026-11-01T00:00:00.000Z' } });
    expect(await run(['loop', 'pause', LOOP, '--until', 'tomorrow', '--expect-version', '4'])).toBe(2);
    expect(pauseUntil('+2h', new Date('2026-10-28T10:00:00Z'))).toBe('2026-10-28T12:00:00.000Z');
    expect(pauseUntil('+3d', new Date('2026-10-28T10:00:00Z'))).toBe('2026-10-31T10:00:00.000Z');
  });
});

describe('tm8 loop reads', () => {
  it('show renders the definition, state and run health', async () => {
    expect(await run(['loop', 'show', LOOP])).toBe(0);
    expect(stdout).toContain(`action: spawn ${MEMBER}`);
    expect(stdout).toContain('next run: 2026-10-29T02:00:00.000Z · last run: never');
    expect(stdout).toContain('runs: 0 total');
    expect(stdout).toContain('  Triage the inbox');
  });
  it('list maps --enabled/--disabled onto the enabled filter', async () => {
    expect(await run(['loop', 'list', '--disabled', '--action', 'spawn', '--limit', '5'])).toBe(0);
    expect(last().query.get('enabled')).toBe('false'); expect(last().query.get('action')).toBe('spawn'); expect(last().query.get('limit')).toBe('5');
    expect(stdout).toContain('Nightly triage');
    expect(await run(['loop', 'list', '--enabled', '--disabled'])).toBe(2);
  });
  it('preview prints the summary and instants; an invalid schedule exits 2', async () => {
    expect(await run(['loop', 'preview', '--schedule', 'every 6h', '--count', '2'])).toBe(0);
    expect(last().body).toEqual({ schedule: 'every 6h', count: 2 });
    expect(stdout).toContain('every 6 hours\n2026-10-28T12:00:00.000Z');
    previewValid = false; stdout = '';
    expect(await run(['loop', 'preview', '--schedule', 'every 0m'])).toBe(2);
    expect(stdout).toContain('invalid: every 0m is not a schedule');
  });
});

describe('tm8 loop runs', () => {
  it('run-now prints the run, its session and the transcript hint', async () => {
    expect(await run(['loop', 'run-now', LOOP, '--force'])).toBe(0);
    expect(last()).toMatchObject({ method: 'POST', path: `/v2/loops/${LOOP}/run`, body: { force: true } });
    expect(stdout).toContain(`run ${RUN} · running`);
    expect(stdout).toContain(`transcript: tm8 session transcript ${SESSION}`);
    expect(stdout).toContain('acted as Opus');
  });
  it('runs lists, run-show reads one run with its output, stop posts the run id', async () => {
    expect(await run(['loop', 'runs', LOOP, '--status', 'running'])).toBe(0);
    expect(last().query.get('status')).toBe('running'); expect(stdout).toContain(`${RUN}  running  manual`);
    expect(await run(['loop', 'runs', LOOP, '--status', 'bogus'])).toBe(2);
    stdout = '';
    expect(await run(['loop', 'run-show', RUN])).toBe(0);
    expect(last().path).toBe(`/v2/loop-runs/${RUN}`); expect(stdout).toContain('output:\ndone');
    expect(await run(['loop', 'stop', RUN])).toBe(0);
    expect(last()).toMatchObject({ method: 'POST', path: `/v2/loop-runs/${RUN}/stop` });
  });
  it('surfaces the server 501 while run handlers are pending', async () => {
    notImplemented = true;
    expect(await run(['loop', 'run-show', RUN])).not.toBe(0);
    expect(stderr).toContain('not_implemented');
  });
});

describe('tm8 loop discovery', () => {
  it('help --query routes scheduling intents to loop create, and leaves the roster read alone', () => {
    expect(matchIntent('schedule a teammate')?.candidates[0]?.path).toEqual(['loop', 'create']);
    expect(matchIntent('run a teammate nightly')?.candidates[0]?.path).toEqual(['loop', 'create']);
    expect(matchIntent('list teammates')?.candidates[0]?.path).toEqual(['teammate', 'list']);
  });
  it('help lists every verb', () => {
    const text = JSON.stringify(nounHelp('loop'));
    for (const verb of ['create', 'list', 'show', 'edit', 'enable', 'disable', 'pause', 'resume', 'run-now', 'runs', 'run-show', 'stop', 'preview']) {
      expect(text).toContain(`"command":"loop ${verb}"`);
    }
  });
});
