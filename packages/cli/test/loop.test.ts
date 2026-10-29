import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoopRun, LoopView, ToolView } from '@tm8/contract';
import { run } from '../src/run.js';
import { loopState, pauseUntil, renderLoop } from '../src/commands/loop.js';
import { nounHelp } from '../src/discovery/help.js';
import { matchIntent, tokenize } from '../src/discovery/search.js';
import { searchHelp } from '../src/discovery/help.js';

const LOOP = '11111111-1111-7111-8111-111111111111';
const RUN = '22222222-2222-7222-8222-222222222222';
const SPACE = '33333333-3333-7333-8333-333333333333';
const MEMBER = '44444444-4444-7444-8444-444444444444';
const TOOL = '55555555-5555-7555-8555-555555555555';
const SESSION = '66666666-6666-7666-8666-666666666666';
const OTHER_TOOL = '77777777-7777-7777-8777-777777777777';
const OTHER_SPACE = '88888888-8888-7888-8888-888888888888';
const MEMORY = '99999999-9999-7999-8999-999999999999';
const SUBJECT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
let loop: LoopView;
let tools: Record<string, ToolView>;
const toolView = (id: string, name: string, inputs: ToolView['definition']['inputs'], over: Partial<ToolView> = {}): ToolView => ({
  id, spaceId: SPACE, version: 1, sourceSha256: '0'.repeat(64), executionVersion: 1, configRevision: 0, config: {}, secretBindings: [],
  definition: { name, description: '', help: '', runtime: 'bash', source: 'echo hi', inputs, tm8Access: 'none', timeoutSeconds: 60 },
  ...over,
});
const loopRun = (): LoopRun => ({ id: RUN, loopId: LOOP, spaceId: SPACE, firedAt: '2026-10-28T10:00:00.000Z', trigger: 'manual',
  requestedBy: null, action: 'spawn', attempt: 1, status: 'running', skipReason: null, error: null, taskId: null, sessionId: SESSION,
  startedAt: '2026-10-28T10:00:01.000Z', endedAt: null, durationMs: null, exitCode: null, outputTail: null,
  actedAs: { id: MEMBER, kind: 'team_member', displayName: 'Opus' } as LoopRun['actedAs'], endedKind: null, usage: null });
let server: Server, baseUrl: string;
let requests: Array<{ method: string; path: string; query: URLSearchParams; body: Record<string, any> }> = [];
let stdout = '', stderr = '', previewValid = true, notImplemented = false, conflict = false, headerFails = false;

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
      const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message, retryable: false, requestId: 'test' } });
      let data: unknown = loop;
      if (notImplemented && (url.pathname.endsWith('/run') || url.pathname.includes('/loop-runs/') || url.pathname.endsWith('/runs'))) {
        fail(501, 'not_implemented', 'ships in PR2'); return;
      }
      if (conflict && (req.method === 'PATCH' || /\/(enable|disable|pause|resume)$/.test(url.pathname))) {
        fail(409, 'version_conflict', 'version conflict'); return;
      }
      if (headerFails && url.pathname.endsWith('/header')) { fail(400, 'invalid_input', 'bad header'); return; }
      if (url.pathname.endsWith('/schedule-preview')) data = previewValid
        ? { valid: true, problem: null, summary: 'every 6 hours', next: ['2026-10-28T12:00:00.000Z', '2026-10-28T18:00:00.000Z'] }
        : { valid: false, problem: 'every 0m is not a schedule', summary: '', next: [] };
      // A decoy whose title CONTAINS the real one: a substring match would find two loops.
      else if (url.pathname.endsWith('/loops') && req.method === 'GET') data = { items: [{ ...loop, id: RUN, definition: { ...loop.definition, title: `${loop.definition.title} v2` } }, loop], nextCursor: null };
      else if (url.pathname.endsWith('/tools')) data = { items: Object.values(tools), nextCursor: null };
      else if (url.pathname.startsWith('/v2/tools/')) data = tools[url.pathname.slice('/v2/tools/'.length)];
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
  tools = {
    [TOOL]: toolView(TOOL, 'triage', [{ name: 'repo', type: 'string', required: true }, { name: 'limit', type: 'int' }, { name: 'token', type: 'secret' }]),
    [OTHER_TOOL]: toolView(OTHER_TOOL, 'deploy', [{ name: 'ref', type: 'string' }]),
  };
  requests = []; stdout = ''; stderr = ''; previewValid = true; notImplemented = false; conflict = false; headerFails = false;
  vi.stubEnv('TM8_BASE_URL', baseUrl); vi.stubEnv('TM8_SPACE_ID', SPACE); vi.stubEnv('TM8_CREDENTIALS_MODE', 'off');
  vi.stubEnv('TM8_SESSION_ID', ''); vi.stubEnv('TM8_AGENT_TOKEN', ''); vi.stubEnv('TM8_TEAM_MEMBER_ID', '');
  vi.stubEnv('TM8_JOURNAL_CLASS', 'human'); vi.stubEnv('TM8_NO_TERSE_DEFAULT', '1');
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const last = () => requests.at(-1)!;
const writes = () => requests.filter(r => r.method !== 'GET' && !r.path.endsWith('/collections/query'));
const asToolLoop = (inputs: Record<string, unknown> = { repo: 'owner/repo', limit: 5 }, persona: string | null = null) => {
  loop = { ...loop, definition: { ...loop.definition, action: 'tool', toolId: TOOL, teamMemberId: persona, toolInputs: inputs as never } };
};

describe('tm8 loop create', () => {
  it('resolves a teammate name and sends a spawn definition with launch config', async () => {
    expect(await run(['loop', 'create', 'Nightly triage', '--schedule', '0 2 * * *', '--timezone', 'Europe/London',
      '--teammate', 'opus 5.5 1m teammate', '--prompt', 'Triage the inbox', '--model', 'claude-opus-5-5', '--workdir', 'worktree',
      '--base-ref', 'origin/main', '--memory', MEMORY, '--credential-source', 'space', '--concurrency', 'queue',
      '--max-runtime', '3600', '--retry', '2', '--mutation-id', 'mut-1'])).toBe(0);
    const query = requests.find(r => r.path.endsWith('/collections/query'))!;
    expect(query.body).toMatchObject({ spaceId: SPACE, kinds: ['team_member'], filters: { titleContains: 'opus 5.5 1m teammate' } });
    const create = requests.find(r => r.method === 'POST' && r.path === `/v2/spaces/${SPACE}/loops`)!;
    expect(create.body).toMatchObject({ clientMutationId: 'mut-1', enabled: true, definition: {
      title: 'Nightly triage', schedule: '0 2 * * *', timezone: 'Europe/London', action: 'spawn', teamMemberId: MEMBER,
      prompt: 'Triage the inbox', concurrency: 'queue', maxRuntimeSeconds: 3600, retry: { attempts: 2 },
      config: { model: 'claude-opus-5-5', workdir: { mode: 'worktree', baseRef: 'origin/main' }, memoryIds: [MEMORY], credentialSource: 'space' },
    } });
    expect(stdout).toContain(`loop ${LOOP} v4 · enabled`);
    expect(stdout).toContain('schedule: 0 2 * * * (Europe/London) — at 02:00 every day (Europe/London)');
  });
  it('a worktree without --base-ref sends no baseRef; --base-ref belongs to the worktree variant only', async () => {
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--workdir', 'worktree'])).toBe(0);
    expect(last().body.definition.config).toEqual({ workdir: { mode: 'worktree' } });
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--base-ref', 'origin/main'])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--workdir', 'project', '--base-ref', 'origin/main'])).toBe(2);
    expect(writes()).toHaveLength(1);
  });
  it('types --input by the tool\'s declared inputs and can start disabled', async () => {
    expect(await run(['loop', 'create', 'Sweep', '--schedule', 'every 6h', '--tool', 'triage', '--input', 'limit=5', '--input', 'repo=1234', '--disabled'])).toBe(0);
    expect(requests.some(r => r.path === `/v2/tools/${TOOL}`)).toBe(true);
    // repo is declared a string: "1234" stays one, where a JSON parse would have stored the number.
    expect(last().body).toMatchObject({ enabled: false, definition: { action: 'tool', toolId: TOOL, toolInputs: { limit: 5, repo: '1234' } } });
  });
  it('refuses a secret, an undeclared input, a mistyped value and a missing required input before writing', async () => {
    const base = ['loop', 'create', 'Sweep', '--schedule', 'every 6h', '--tool', 'triage', '--input', 'repo=owner/repo'];
    expect(await run([...base, '--input', 'token=ghp_secret123'])).toBe(2);
    expect(stderr).toContain('token is a secret input');
    expect(stderr).toContain('tm8 tool secret set triage token');
    expect(stderr).not.toContain('ghp_secret123');
    expect(await run([...base, '--input', 'branch=main'])).toBe(2);
    expect(stderr).toContain('Tool triage has no input branch; its inputs: repo, limit, token');
    expect(await run([...base, '--input', 'limit=five'])).toBe(2);
    expect(await run([...base, '--input', 'limit=5', '--input', 'limit=6'])).toBe(2);
    expect(await run(['loop', 'create', 'Sweep', '--schedule', 'every 6h', '--tool', 'triage'])).toBe(2);
    expect(stderr).toContain('--input repo=<value>');
    expect(writes()).toHaveLength(0);
    // A required input the tool's config or a default covers needs no value here.
    tools[TOOL] = { ...tools[TOOL]!, config: { repo: 'owner/repo' } };
    expect(await run(['loop', 'create', 'Sweep', '--schedule', 'every 6h', '--tool', 'triage'])).toBe(0);
    expect(last().body.definition.toolInputs).toEqual({});
  });
  it('with --tool, --teammate names the persona; a tool that reaches tm8 needs one', async () => {
    expect(await run(['loop', 'create', 'Sweep', '--schedule', 'every 6h', '--tool', 'triage', '--input', 'repo=r', '--teammate', 'opus 5.5 1m teammate'])).toBe(0);
    expect(last().body).toMatchObject({ definition: { action: 'tool', toolId: TOOL, teamMemberId: MEMBER } });
    tools[TOOL] = { ...tools[TOOL]!, definition: { ...tools[TOOL]!.definition, tm8Access: 'write' } };
    expect(await run(['loop', 'create', 'Sweep', '--schedule', 'every 6h', '--tool', 'triage', '--input', 'repo=r'])).toBe(2);
    expect(stderr).toContain('reaches tm8 (tm8Access write)');
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--teammate', MEMBER])).toBe(2);
  });
  it('warns when a required secret has no binding, without refusing', async () => {
    tools[TOOL] = toolView(TOOL, 'triage', [{ name: 'token', type: 'secret', required: true }]);
    expect(await run(['loop', 'create', 'Sweep', '--schedule', 'every 6h', '--tool', 'triage'])).toBe(0);
    expect(stderr).toContain('needs the secret token and none is bound');
  });
  it('sets selection headers through entities.header.set, then rereads the loop', async () => {
    expect(await run(['loop', 'create', 'Sweep', '--schedule', 'every 1d', '--dispatch', '--when-to-use', 'Open when triage stalls', '--mutation-id', 'mut-h'])).toBe(0);
    const header = requests.find(r => r.path.endsWith('/header'))!;
    expect(header.body).toMatchObject({ clientMutationId: 'mut-h:header', whenToUse: 'Open when triage stalls' });
    expect(last()).toMatchObject({ method: 'GET', path: `/v2/loops/${LOOP}` });
  });
  it('checks the header flags before the create, and names the created loop when its header fails', async () => {
    expect(await run(['loop', 'create', 'Sweep', '--schedule', 'every 1d', '--dispatch', '--summary', 'a', '--summary', 'b'])).toBe(2);
    expect(writes()).toHaveLength(0);
    headerFails = true;
    expect(await run(['loop', 'create', 'Sweep', '--schedule', 'every 1d', '--dispatch', '--summary', 'a', '--mutation-id', 'mut-x'])).not.toBe(0);
    expect(stderr).toContain(`loop ${LOOP} was created (enabled) but its header was not set`);
    expect(stderr).toContain('--mutation-id mut-x');
  });
  it('refuses usage errors locally with exit 2', async () => {
    expect(await run(['loop', 'create', 'X', '--teammate', MEMBER])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h'])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--tool', 'triage'])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--tool', TOOL, '--input', 'repo=r', '--model', 'm'])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--credential-source', 'anthropic=member'])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--concurrency', 'parallel'])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--disabled=false'])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--subject', 'roadmap'])).toBe(2);
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--memory', 'm1'])).toBe(2);
    expect(writes()).toHaveLength(0);
  });
  it('checks the contract\'s ranges locally', async () => {
    const create = (...flags: string[]) => run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', ...flags]);
    for (const flags of [['--max-runtime', '0'], ['--max-runtime', '86401'], ['--retry', '6'], ['--retry', '-1'], ['--retry-delay', '5'], ['--retry-delay', '3601']]) {
      expect(await create(...flags)).toBe(2);
    }
    expect(writes()).toHaveLength(0);
    expect(await create('--max-runtime', '60', '--retry', '5', '--retry-delay', '30')).toBe(0);
    expect(last().body.definition).toMatchObject({ maxRuntimeSeconds: 60, retry: { attempts: 5, delaySeconds: 30 } });
  });
  it('prints the LoopView as JSON on --format json', async () => {
    expect(await run(['loop', 'create', 'X', '--schedule', 'every 1h', '--dispatch', '--format', 'json'])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ id: LOOP, version: 4 });
  });
});

describe('tm8 loop edit', () => {
  it('sends only the flags given and requires --expect-version', async () => {
    expect(await run(['loop', 'edit', LOOP, '--schedule', 'every 30m'])).toBe(2);
    expect(await run(['loop', 'edit', LOOP, '--expect-version', '4'])).toBe(2);
    expect(await run(['loop', 'edit', LOOP, '--schedule', 'every 30m', '--subject', 'none', '--retry-delay', '60', '--expect-version', '4'])).toBe(0);
    expect(last()).toMatchObject({ method: 'PATCH', path: `/v2/loops/${LOOP}`,
      body: { expectedVersion: 4, definition: { schedule: 'every 30m', subjectId: null, retry: { delaySeconds: 60 } } } });
    expect(Object.keys(last().body.definition).sort()).toEqual(['retry', 'schedule', 'subjectId']);
    expect(await run(['loop', 'edit', LOOP, '--subject', SUBJECT, '--max-runtime', 'none', '--expect-version', '4'])).toBe(0);
    expect(last().body.definition).toEqual({ subjectId: SUBJECT, maxRuntimeSeconds: null });
  });
  it('overlays launch flags on the stored config, so untouched settings survive; none unsets one', async () => {
    loop = { ...loop, definition: { ...loop.definition, config: { model: 'claude-opus-5-5', accessMode: 'plan',
      workdir: { mode: 'worktree', baseRef: 'origin/main' }, memoryIds: [MEMORY], credentialSource: 'space' } } };
    expect(await run(['loop', 'edit', LOOP, '--reasoning-effort', 'high', '--expect-version', '4'])).toBe(0);
    expect(last().body.definition).toEqual({ config: { model: 'claude-opus-5-5', accessMode: 'plan', reasoningEffort: 'high',
      workdir: { mode: 'worktree', baseRef: 'origin/main' }, memoryIds: [MEMORY], credentialSource: 'space' } });
    expect(await run(['loop', 'edit', LOOP, '--model', 'none', '--memory', 'none', '--expect-version', '4'])).toBe(0);
    expect(last().body.definition.config).toEqual({ accessMode: 'plan', workdir: { mode: 'worktree', baseRef: 'origin/main' }, memoryIds: [], credentialSource: 'space' });
    // --base-ref alone retimes the stored worktree; a mode change drops a ref that no longer applies.
    expect(await run(['loop', 'edit', LOOP, '--base-ref', 'origin/release', '--expect-version', '4'])).toBe(0);
    expect(last().body.definition.config.workdir).toEqual({ mode: 'worktree', baseRef: 'origin/release' });
    // --base-ref none drops the stored ref (never a ref named "none"); the loop stays on a worktree.
    expect(await run(['loop', 'edit', LOOP, '--base-ref', 'none', '--expect-version', '4'])).toBe(0);
    expect(last().body.definition.config.workdir).toEqual({ mode: 'worktree' });
    expect(JSON.stringify(last().body)).not.toContain('"baseRef":"none"');
    expect(await run(['loop', 'edit', LOOP, '--workdir', 'project', '--expect-version', '4'])).toBe(0);
    expect(last().body.definition.config.workdir).toEqual({ mode: 'project' });
    expect(await run(['loop', 'edit', LOOP, '--workdir', 'scratch', '--base-ref', 'x', '--expect-version', '4'])).toBe(2);
  });
  it('overlays --input on the stored inputs while the tool stays; a new tool starts from none', async () => {
    asToolLoop();
    expect(await run(['loop', 'edit', LOOP, '--input', 'limit=10', '--expect-version', '4'])).toBe(0);
    expect(last().body.definition).toEqual({ toolInputs: { repo: 'owner/repo', limit: 10 } });
    expect(await run(['loop', 'edit', LOOP, '--clear-inputs', '--input', 'repo=other/repo', '--expect-version', '4'])).toBe(0);
    expect(last().body.definition).toEqual({ toolInputs: { repo: 'other/repo' } });
    expect(await run(['loop', 'edit', LOOP, '--tool', 'deploy', '--expect-version', '4'])).toBe(0);
    expect(last().body.definition).toEqual({ toolId: OTHER_TOOL, toolInputs: {} });
    expect(await run(['loop', 'edit', LOOP, '--clear-inputs', '--expect-version', '4'])).toBe(2);
    expect(stderr).toContain('--input repo=<value>');
  });
  it('reads the flags against the stored action: --teammate on a tool loop is its persona', async () => {
    expect(await run(['loop', 'edit', LOOP, '--input', 'limit=5', '--expect-version', '4'])).toBe(2);
    asToolLoop();
    expect(await run(['loop', 'edit', LOOP, '--teammate', MEMBER, '--expect-version', '4'])).toBe(0);
    expect(last().body.definition).toEqual({ teamMemberId: MEMBER });
    expect(await run(['loop', 'edit', LOOP, '--teammate', MEMBER, '--clear-tool', '--expect-version', '4'])).toBe(0);
    expect(last().body.definition).toEqual({ action: 'spawn', teamMemberId: MEMBER, toolId: null, toolInputs: {} });
    expect(await run(['loop', 'edit', LOOP, '--model', 'm', '--expect-version', '4'])).toBe(2);
    expect(await run(['loop', 'edit', LOOP, '--dispatch', '--expect-version', '4'])).toBe(0);
    expect(last().body.definition).toEqual({ action: 'dispatch', teamMemberId: null, toolId: null, toolInputs: {} });
  });
  it('a loop that becomes a tool loop drops its launch config and keeps no stray persona', async () => {
    loop = { ...loop, definition: { ...loop.definition, config: { model: 'claude-opus-5-5' } } };
    expect(await run(['loop', 'edit', LOOP, '--tool', 'deploy', '--expect-version', '4'])).toBe(0);
    expect(last().body.definition).toEqual({ action: 'tool', toolId: OTHER_TOOL, teamMemberId: null, config: {}, toolInputs: {} });
    tools[OTHER_TOOL] = { ...tools[OTHER_TOOL]!, definition: { ...tools[OTHER_TOOL]!.definition, tm8Access: 'read' } };
    expect(await run(['loop', 'edit', LOOP, '--tool', 'deploy', '--expect-version', '4'])).toBe(2);
    expect(await run(['loop', 'edit', LOOP, '--tool', 'deploy', '--teammate', MEMBER, '--expect-version', '4'])).toBe(0);
    expect(last().body.definition).toMatchObject({ action: 'tool', toolId: OTHER_TOOL, teamMemberId: MEMBER });
  });
  it('refuses --clear-tool without a new runner, and on a loop that runs no tool', async () => {
    expect(await run(['loop', 'edit', LOOP, '--clear-tool', '--teammate', MEMBER, '--expect-version', '4'])).toBe(2);
    asToolLoop();
    expect(await run(['loop', 'edit', LOOP, '--clear-tool', '--expect-version', '4'])).toBe(2);
    expect(stderr).toContain('--clear-tool makes the loop a spawn loop');
    expect(writes()).toHaveLength(0);
  });
  it('resolves teammate and tool names in the loop\'s own Space', async () => {
    loop = { ...loop, spaceId: OTHER_SPACE };
    expect(await run(['loop', 'edit', LOOP, '--teammate', 'Opus 5.5 1M Teammate', '--expect-version', '4'])).toBe(0);
    expect(requests.find(r => r.path.endsWith('/collections/query'))!.body.spaceId).toBe(OTHER_SPACE);
    expect(await run(['loop', 'edit', LOOP, '--tool', 'deploy', '--expect-version', '4'])).toBe(0);
    expect(requests.some(r => r.path === `/v2/spaces/${OTHER_SPACE}/tools`)).toBe(true);
  });
  it('refuses header flags (they belong to tm8 entity header set)', async () => {
    expect(await run(['loop', 'edit', LOOP, '--summary', 'x', '--expect-version', '4'])).toBe(2);
  });
  it('says a version conflict usually means the loop just fired', async () => {
    conflict = true;
    expect(await run(['loop', 'edit', LOOP, '--schedule', 'every 1h', '--expect-version', '3'])).toBe(6);
    expect(stderr).toContain(`a loop's version also moves each time it fires: read it again with \`tm8 loop show ${LOOP}\``);
  });
});

describe('tm8 loop controls', () => {
  it('resolves a loop by exact title, after the trim the server stored it with', async () => {
    expect(await run(['loop', 'enable', '  Nightly triage ', '--expect-version', '4'])).toBe(0);
    expect(requests[0]!.query.get('words')).toBe('Nightly triage');
    expect(last()).toMatchObject({ method: 'POST', path: `/v2/loops/${LOOP}/enable`, body: { expectedVersion: 4 } });
    expect(await run(['loop', 'show', 'Missing'])).toBe(5);
  });
  it.each(['enable', 'disable', 'resume'])('%s posts the expected version without reading the loop first', async verb => {
    expect(await run(['loop', verb, LOOP])).toBe(2);
    expect(await run(['loop', verb, LOOP, '--expect-version', '4'])).toBe(0);
    expect(requests).toHaveLength(1);
    expect(last()).toMatchObject({ method: 'POST', path: `/v2/loops/${LOOP}/${verb}`, body: { expectedVersion: 4 } });
  });
  it('pause takes an ISO instant with its offset, or a relative +<n>{m|h|d}', async () => {
    expect(await run(['loop', 'pause', LOOP, '--until', '2026-11-01T00:00:00Z', '--expect-version', '4'])).toBe(0);
    expect(last()).toMatchObject({ path: `/v2/loops/${LOOP}/pause`, body: { expectedVersion: 4, until: '2026-11-01T00:00:00.000Z' } });
    expect(await run(['loop', 'pause', LOOP, '--until', 'tomorrow', '--expect-version', '4'])).toBe(2);
    expect(pauseUntil('+2h', new Date('2026-10-28T10:00:00Z'))).toBe('2026-10-28T12:00:00.000Z');
    expect(pauseUntil('+3d', new Date('2026-10-28T10:00:00Z'))).toBe('2026-10-31T10:00:00.000Z');
    expect(pauseUntil('2026-11-01T09:30+01:00')).toBe('2026-11-01T08:30:00.000Z');
    // No offset (read in this host's zone), an impossible date, an empty or out-of-bound span: refused, never guessed.
    for (const raw of ['2026-11-01T00:00:00', '2026-02-30T00:00:00Z', '2026-11-01T24:00:00Z', '+0h', '+366d', '+999999999999d']) {
      expect(() => pauseUntil(raw), raw).toThrow();
    }
  });
});

describe('tm8 loop reads', () => {
  it('show renders the definition, state and run health', async () => {
    expect(await run(['loop', 'show', LOOP])).toBe(0);
    expect(stdout).toContain(`action: spawn ${MEMBER}`);
    expect(stdout).toContain('next run: 2026-10-29T02:00:00.000Z · last run: never');
    expect(stdout).toContain('schedule from now: 2026-10-29T02:00:00.000Z');
    expect(stdout).toContain('runs: 0 total');
    expect(stdout).toContain('  Triage the inbox');
  });
  it('renders a tool loop with its persona and inputs', () => {
    asToolLoop({ repo: 'owner/repo' }, MEMBER);
    const text = renderLoop(loop);
    expect(text).toContain(`action: tool ${TOOL} as ${MEMBER}`);
    expect(text).toContain('tool inputs: {"repo":"owner/repo"}');
  });
  it('a pause that has run out reads as enabled, and an invalid schedule shows beside a live pause', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    loop = { ...loop, state: { ...loop.state, pausedUntil: '2026-10-29T10:00:00.000Z' } };
    expect(loopState(loop, now)).toBe('enabled');
    loop = { ...loop, state: { ...loop.state, pausedUntil: '2026-10-30T10:00:00.000Z' }, schedule: { ...loop.schedule, valid: false, problem: 'never matches' } };
    expect(loopState(loop, now)).toBe('paused until 2026-10-30T10:00:00.000Z · invalid: never matches');
    expect(loopState({ ...loop, state: { ...loop.state, enabled: false } }, now)).toBe('disabled');
  });
  it('list maps --enabled/--disabled onto the enabled filter and checks --limit', async () => {
    expect(await run(['loop', 'list', '--disabled', '--action', 'spawn', '--limit', '5'])).toBe(0);
    expect(last().query.get('enabled')).toBe('false'); expect(last().query.get('action')).toBe('spawn'); expect(last().query.get('limit')).toBe('5');
    expect(stdout).toContain('Nightly triage');
    expect(await run(['loop', 'list', '--enabled', '--disabled'])).toBe(2);
    expect(await run(['loop', 'list', '--enabled=false'])).toBe(2);
    expect(await run(['loop', 'list', '--limit', '0'])).toBe(2);
    expect(await run(['loop', 'list', '--limit', 'ten'])).toBe(2);
  });
  it('preview prints the summary and instants; an invalid schedule exits 2', async () => {
    expect(await run(['loop', 'preview', '--schedule', 'every 6h', '--count', '2'])).toBe(0);
    expect(last().body).toEqual({ schedule: 'every 6h', count: 2 });
    expect(stdout).toContain('every 6 hours\n2026-10-28T12:00:00.000Z');
    expect(await run(['loop', 'preview', '--schedule', 'every 6h', '--count', '0'])).toBe(2);
    expect(await run(['loop', 'preview', '--schedule', 'every 6h', '--count', '11'])).toBe(2);
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
    expect(await run(['loop', 'runs', LOOP, '--limit', '0'])).toBe(2);
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
  it('help --query routes setting up recurring work to loop create', () => {
    for (const query of ['schedule a teammate', 'run a teammate nightly', 'run a teammate weekly', 'create a loop', 'set up a cron job']) {
      expect(matchIntent(query)?.candidates[0]?.path, query).toEqual(['loop', 'create']);
    }
  });
  it('routes steering an existing loop to its own verb, never to loop create (review of #1405)', () => {
    const routes: Array<[string, string[]]> = [
      ['run a loop now', ['loop', 'run-now']],
      ['run the nightly loop', ['loop', 'run-now']],
      ['fire the loop now', ['loop', 'run-now']],
      ['trigger the loop again', ['loop', 'run-now']],
      ['start the loop', ['loop', 'enable']],
      ["set a loop's schedule", ['loop', 'edit']],
      ["change the loop's timezone", ['loop', 'edit']],
      ['add a teammate to the loop', ['loop', 'edit']],
    ];
    for (const [query, path] of routes) expect(matchIntent(query)?.candidates[0]?.path, query).toEqual(path);
    // Creating stays a create, with or without a cadence word, and "set up" is one verb.
    for (const query of ['schedule a loop', 'make a nightly loop', 'add a new loop with a weekly schedule',
      'set up a loop', 'set up a nightly loop', 'set up a loop for nightly triage', 'set-up a loop',
      'make a loop that runs every day']) {
      expect(matchIntent(query)?.candidates[0]?.path, query).toEqual(['loop', 'create']);
    }
  });
  it('stopping a run is loop stop, and no stopping, resuming or enabling phrasing ever fires or creates a loop', () => {
    for (const query of ['stop a loop run', 'stop the loop run', 'cancel the loop run', 'kill the loop run', 'abort the loop run',
      'end the loop run', 'terminate the running loop', 'halt the loop runs']) {
      expect(matchIntent(query)?.candidates[0]?.path, query).toEqual(['loop', 'stop']);
    }
    for (const query of ['cancel the loop run', 'kill the loop run', 'resume the loop now', 'enable the loop now', 'pause the loop now',
      'disable the loop now', 'stop the loop now', 'cancel the loop now', 'abort the loop', 'stop running the loop again']) {
      // The whole answer a caller reads first, route or ranker.
      const path = searchHelp(query).matches[0]?.command;
      expect(matchIntent(query)?.candidates[0]?.path, query).not.toEqual(['loop', 'run-now']);
      expect(matchIntent(query)?.candidates[0]?.path, query).not.toEqual(['loop', 'create']);
      expect(path, query).not.toBe('loop run-now');
      expect(path, query).not.toBe('loop create');
    }
    expect(matchIntent('enable the loop now')?.candidates[0]?.path).toEqual(['loop', 'enable']);
    expect(matchIntent('start the loop now')?.candidates[0]?.path).toEqual(['loop', 'enable']);
  });
  it('removing a field or a run is never deleting the loop (nor a create or a run)', () => {
    for (const query of ['remove the subject from the loop', 'remove the teammate from the loop', 'remove the tool from the loop',
      'remove the prompt from the loop', 'remove the memory from the loop', 'remove the max runtime from the loop',
      "delete the loop's schedule", 'clear the loop subject']) {
      expect(matchIntent(query)?.candidates[0]?.path, query).toEqual(['loop', 'edit']);
    }
    for (const query of ['delete the loop run', 'delete the loop runs', 'remove a loop run', 'remove the subject from the loop',
      "delete the loop's schedule", 'remove the memory from the loop']) {
      const top = searchHelp(query).matches[0]?.command;
      for (const bad of ['entity delete', 'loop create', 'loop run-now']) expect(top, query).not.toBe(bad);
    }
    expect(matchIntent('delete the loop run')?.candidates[0]?.path).toEqual(['loop', 'runs']);
    // Deleting the loop itself still is.
    expect(matchIntent('stop and delete the loop')?.candidates[0]?.path).toEqual(['entity', 'delete']);
  });
  it('removing a loop is the entity delete, never a create or a run', () => {
    for (const query of ['delete a loop', 'delete the nightly loop', 'remove the loop', 'archive the loop', 'delete loops']) {
      expect(matchIntent(query)?.candidates[0]?.path, query).toEqual(['entity', 'delete']);
      const top = searchHelp(query).matches[0]?.command;
      expect(top, query).toBe('entity delete');
      expect(top, query).not.toBe('loop create');
      expect(top, query).not.toBe('loop run-now');
    }
  });
  it('leaves steering, reading and one-off work to the ranker', () => {
    for (const query of ['pause the nightly loop', 'list loops', 'stop a loop run', 'disable a loop', 'preview a cron schedule',
      'delete a loop', 'send a daily report', 'run every test']) {
      expect(matchIntent(query)?.candidates[0]?.path, query).not.toEqual(['loop', 'create']);
    }
    expect(matchIntent('list teammates')?.candidates[0]?.path).toEqual(['teammate', 'list']);
  });
  it('help lists every verb', () => {
    const text = JSON.stringify(nounHelp('loop'));
    for (const verb of ['create', 'list', 'show', 'edit', 'enable', 'disable', 'pause', 'resume', 'run-now', 'runs', 'run-show', 'stop', 'preview']) {
      expect(text).toContain(`"command":"loop ${verb}"`);
    }
  });
});

/*
 * THE ROUTING CORPUS (review of #1405, rounds 1-4). Every phrasing a reviewer
 * measured, with the command `tm8 help --query` must answer FIRST — route or
 * ranker. Each round of review found a new misroute; this table is where the
 * next one is added, so a fix for one row cannot quietly break another.
 */
const ROUTING_CORPUS: ReadonlyArray<readonly [query: string, top: string]> = [
  // setting up recurring work
  ['schedule a teammate', 'loop create'], ['run a teammate nightly', 'loop create'], ['run a teammate weekly', 'loop create'],
  ['create a loop', 'loop create'], ['set up a cron job', 'loop create'], ['schedule a loop', 'loop create'],
  ['make a nightly loop', 'loop create'], ['add a new loop with a weekly schedule', 'loop create'], ['set up a loop', 'loop create'],
  ['set up a nightly loop', 'loop create'], ['set up a loop for nightly triage', 'loop create'], ['set-up a loop', 'loop create'],
  ['setup a loop', 'loop create'], ['make a loop that runs every day', 'loop create'],
  // firing an existing loop
  ['run a loop now', 'loop run-now'], ['run the nightly loop', 'loop run-now'], ['fire the loop now', 'loop run-now'],
  ['trigger the loop again', 'loop run-now'],
  // starting, enabling, resuming, pausing, disabling
  ['start the loop', 'loop enable'], ['start the loop now', 'loop enable'], ['arm the loop now', 'loop enable'],
  ['enable the loop now', 'loop enable'], ['resume the loop now', 'loop resume'], ['pause the loop now', 'loop pause'],
  ['disable the loop now', 'loop disable'], ['disable a loop', 'loop disable'],
  // stopping a run, or the loop
  ['stop a loop run', 'loop stop'], ['stop the loop run', 'loop stop'], ['cancel the loop run', 'loop stop'],
  ['kill the loop run', 'loop stop'], ['abort the loop run', 'loop stop'], ['end the loop run', 'loop stop'],
  ['terminate the running loop', 'loop stop'], ['halt the loop runs', 'loop stop'], ['stop running the loop again', 'loop stop'],
  ['stop the loop now', 'loop disable'], ['cancel the loop now', 'loop disable'], ['kill the loop', 'loop disable'],
  ['abort the loop', 'loop disable'], ['halt the loop', 'loop disable'], ['stop the loop', 'loop disable'],
  // editing, including clearing a field
  ["set a loop's schedule", 'loop edit'], ["change the loop's timezone", 'loop edit'], ['add a teammate to the loop', 'loop edit'],
  ['remove the subject from the loop', 'loop edit'], ['remove the teammate from the loop', 'loop edit'],
  ['remove the tool from the loop', 'loop edit'], ['remove the prompt from the loop', 'loop edit'],
  ['remove the memory from the loop', 'loop edit'], ['remove the max runtime from the loop', 'loop edit'],
  ["delete the loop's schedule", 'loop edit'], ['clear the loop subject', 'loop edit'],
  // runs: read them; a run is never deleted on its own
  ['delete the loop run', 'loop runs'], ['delete the loop runs', 'loop runs'], ['remove a loop run', 'loop runs'],
  // deleting the loop itself
  ['delete a loop', 'entity delete'], ['delete the nightly loop', 'entity delete'], ['remove the loop', 'entity delete'],
  ['archive the loop', 'entity delete'], ['trash the loop', 'entity delete'], ['delete loops', 'entity delete'],
  ['stop and delete the loop', 'entity delete'],
  // reading
  ['list loops', 'loop list'], ['preview a cron schedule', 'loop preview'],
];

/** The only words a destructive answer may carry besides the loop: its verbs and plain descriptions of which loop. */
const LOOP_ONLY_OBJECT = new Set(['loop', 'loops', 'delete', 'remove', 'archive', 'destroy', 'trash', 'stop',
  'nightly', 'daily', 'weekly', 'hourly', 'old', 'stale', 'unused']);

describe('tm8 help --query: the routing corpus', () => {
  it.each(ROUTING_CORPUS)('"%s" answers %s first', (query, top) => {
    expect(searchHelp(query).matches[0]?.command).toBe(top);
  });
  it('a destructive answer (entity delete) only ever answers a phrasing whose sole object is the loop itself', () => {
    for (const [query] of ROUTING_CORPUS) {
      if (searchHelp(query).matches[0]?.command !== 'entity delete') continue;
      const others = tokenize(query).filter(token => !LOOP_ONLY_OBJECT.has(token));
      expect(others, `"${query}" deletes the loop but names more than the loop`).toEqual([]);
    }
  });
});
