/**
 * Lane L1 — cross-space discoverability: `space-link`, `task create`,
 * `teammate list`, `whoami`, the `--space` help, and the help --query synonyms.
 *
 * Drives the real `run()` against a loopback stub that records every request,
 * so each alias is shown to send exactly what the command it spells sends.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, USAGE } from '../src/run.js';
import { ledger } from '../src/discovery/availability.js';
import { rootHelp, searchHelp } from '../src/discovery/help.js';
import { commandDiscovery, commandsForNoun } from '../src/discovery/operations.js';
import { matchIntent, tokenize } from '../src/discovery/search.js';

async function tm8(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true; });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true; });
  try {
    const code = await run(argv);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

const HOME = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const ACTOR = '44444444-4444-4444-8444-444444444444';
const SESSION = '77777777-7777-4777-8777-777777777777';
const TASK = '55555555-5555-4555-8555-555555555555';

const VIEW = {
  id: LINK, homeSpaceId: HOME, targetSpaceId: TARGET, targetServerId: null, targetSpaceName: 'Space B',
  createdAt: '2026-09-26T09:00:00.000Z', statusSummary: { signed_in: 1 },
  mine: { memberId: ACTOR, status: 'signed_in', allowSpawn: false, spawnBudget: 0, alias: 'bee', sessionId: SESSION, expiresAt: null, lastUsedAt: null },
};

interface Recorded { method: string; path: string; body: Record<string, unknown> }
type Reply = { status: number; body: unknown };
let recorded: Recorded[] = [];
const ok = (data: unknown): Reply => ({ status: 200, body: { data, requestId: 'req_t' } });

const ROUTES: Record<string, (body: Record<string, unknown>) => Reply> = {
  [`GET /v2/spaces/${HOME}/space-links`]: () => ok([VIEW]),
  [`POST /v2/spaces/${HOME}/space-links/${LINK}/invoke`]: (body) =>
    ok({ op: body.op, linkId: LINK, targetSpaceId: TARGET, auditId: 'audit-1', result: { page: { items: [] } } }),
  'GET /v2/identity': () => ok({ identityId: 'id_1', username: 'sam', actingAs: ACTOR, memberships: [] }),
  'POST /v2/collections/query': () =>
    ok({ page: { items: [{ id: ACTOR, kind: 'team_member', title: 'Worker', version: 1 }] } }),
  'POST /v2/entities': () => ok({ entity: { id: TASK, kind: 'task', title: 'T', version: 1 } }),
};

let server: Server;
let baseUrl: string;
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      recorded.push({ method: req.method ?? '', path: url.pathname, body });
      const route = ROUTES[`${req.method} ${url.pathname}`];
      const reply = route
        ? route(body)
        : { status: 404, body: { error: { code: 'not_found', message: 'no such route', requestId: 'r', retryable: false } } };
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

const SAVED = [
  'TM8_BASE_URL', 'TM8_SPACE_ID', 'TM8_ACTOR_ID', 'TM8_CONFIG_PATH', 'TM8_SESSION_ID', 'TM8_AGENT_TOKEN',
  'TM8_JOURNAL_CLASS', 'XDG_CONFIG_HOME', 'TM8_MANIFEST_PATH', 'TM8_MODE', 'TM8_TEAM_MEMBER_ID', 'TM8_JOURNAL_PATH',
] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of SAVED) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), 'tm8-l1-'));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = HOME;
  process.env.TM8_ACTOR_ID = ACTOR;
  process.env.TM8_SESSION_ID = SESSION;
  process.env.TM8_JOURNAL_CLASS = 'human';
  recorded = [];
  ledger.clear();
});

afterEach(() => {
  for (const k of SAVED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
  ledger.clear();
});

const paths = () => recorded.map((r) => `${r.method} ${r.path}`);

describe('space-link is a runnable alias of the link noun', () => {
  it('`space-link list` sends exactly what `link list` sends', async () => {
    const a = await tm8(['space-link', 'list', '--format', 'json']);
    expect(a.code, a.stderr).toBe(0);
    const viaAlias = paths();
    recorded = [];
    const b = await tm8(['link', 'list', '--format', 'json']);
    expect(b.code, b.stderr).toBe(0);
    expect(viaAlias).toEqual(paths());
    expect(a.stdout).toEqual(b.stdout);
  });

  it('`help space-link` names all four verbs and the --space route', async () => {
    const names = commandsForNoun('space-link').map((c) => c.command);
    expect(names).toEqual(expect.arrayContaining(['space-link list', 'space-link add', 'space-link login', 'space-link audit']));
    expect(commandDiscovery(['space-link', 'list'])?.notes.join(' ')).toContain('tm8 --space <alias|space-id> <command>');
  });

  it('cannot itself run through a link', async () => {
    const r = await tm8(['--space', 'bee', 'space-link', 'list']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot run through a space link');
    expect(recorded).toEqual([]);
  });
});

describe('task create is entity create task', () => {
  it('sends one entities.create with kind task and the same flags', async () => {
    const r = await tm8(['task', 'create', 'Write the doc', '--parent', TASK, '--mutation-id', 'm-1']);
    expect(r.code, r.stderr).toBe(0);
    const create = recorded.find((x) => x.path === '/v2/entities');
    expect(create?.body).toMatchObject({ kind: 'task', title: 'Write the doc', parentId: TASK, spaceId: HOME, clientMutationId: 'm-1' });
  });

  it('through a link it is ONE spaceLinks.invoke of entities.create in the target', async () => {
    const r = await tm8(['--space', 'bee', 'task', 'create', 'Over there']);
    expect(r.code, r.stderr).toBe(0);
    const invoke = recorded.find((x) => x.path.endsWith('/invoke'));
    expect(invoke?.body).toMatchObject({ op: 'entities.create' });
    expect(recorded.some((x) => x.path === '/v2/entities')).toBe(false);
  });

  it('a missing title names the task create syntax', async () => {
    const r = await tm8(['task', 'create']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('tm8 task create <title>');
    expect(recorded).toEqual([]);
  });
});

describe('teammate list', () => {
  it('queries team_member in the session Space', async () => {
    const r = await tm8(['teammate', 'list', '--limit', '5']);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded.find((x) => x.path === '/v2/collections/query')?.body).toEqual({ spaceId: HOME, kinds: ['team_member'], limit: 5 });
    expect(r.stdout).toContain(`${ACTOR}  team_member  Worker`);
  });
});

describe('whoami', () => {
  it('reports session, Space, actor, mode and access mode, plus the resolved identity', async () => {
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({
      manifestVersion: '1', sessionId: SESSION, spaceId: HOME, mode: 'coordinated-worker',
      agent: { teamMemberId: ACTOR, name: 'Worker' }, launch: { tool: 'claude-code', accessMode: 'fullAccess' },
    }));
    process.env.TM8_MANIFEST_PATH = manifest;
    process.env.TM8_MODE = 'coordinated-worker';
    const r = await tm8(['whoami', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      sessionId: SESSION, spaceId: HOME, actorId: ACTOR, mode: 'coordinated-worker', accessMode: 'fullAccess',
      identity: { identityId: 'id_1' },
    });
    expect(paths()).toEqual(['GET /v2/identity']);
  });

  it('works without a manifest; access mode is null, not invented', async () => {
    const r = await tm8(['whoami', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ sessionId: SESSION, accessMode: null });
  });

  it('is refused through a link: it describes this session', async () => {
    const r = await tm8(['--space', 'bee', 'whoami']);
    expect(r.code).toBe(2);
    expect(recorded).toEqual([]);
  });
});

describe('--space help names links', () => {
  it('root usage and the global options say an alias routes through a link, with an example', () => {
    expect(USAGE).toContain('--space <space-id|alias>');
    expect(USAGE).toContain('tm8 --space <alias>');
    const space = rootHelp().globalOptions.find((g) => g.option.startsWith('--space'));
    expect(space?.summary).toContain('tm8 link list');
    expect(space?.summary).toContain('tm8 --space <alias>');
  });

  it('an unknown alias names the links this Space has', async () => {
    const r = await tm8(['--space', 'nope', 'entity', 'get', TASK]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('this Space links to: bee');
  });
});

describe('help --query synonyms', () => {
  it('expands create-task, teammates and other-space', () => {
    expect(tokenize('create-task')).toEqual(expect.arrayContaining(['create', 'task']));
    expect(tokenize('teammates')).toContain('teammate');
    expect(tokenize('work in another space')).toEqual(expect.arrayContaining(['another-space', 'cross-space', 'link']));
  });

  it.each([
    ['create-task', 'task create'],
    ['create a task', 'task create'],
    ['teammates', 'teammate list'],
    ['cross-space', 'link list'],
    ['other-space', 'link list'],
    ['act in the other space', 'link list'],
    ['space link', 'link list'],
  ])('%s → %s first', (query, command) => {
    expect(searchHelp(query).matches[0]?.command).toBe(command);
  });

  it('a PR or commit link keeps its own answer', () => {
    expect(matchIntent('link a pr to my task')).toBeUndefined();
    expect(searchHelp('link a pr to my task').matches[0]?.command).toBe('task link-pr');
    expect(matchIntent('link commit')).toBeUndefined();
  });

  it('chat with a teammate is not hijacked by the teammate route', () => {
    expect(matchIntent('start a chat with a teammate')).toBeUndefined();
  });
});
