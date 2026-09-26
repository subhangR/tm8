/**
 * W7 — `tm8 --space <alias|id>` through `spaceLinks.invoke`, and `tm8 link *`.
 *
 * Drives the real `run()` against a loopback stub that records EVERY request,
 * so each cell can assert not only what was sent but that nothing else was:
 * the only route to another Space is one `spaceLinks.invoke` on home, and the
 * refused set is the home server's to apply. Each refusal is paired with a
 * positive. No secret is ever printed: the stub plants token-shaped values in
 * success and error bodies and the cells assert none reaches stdout or stderr.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/run.js';
import { REDACTED, scrubSecrets, scrubText } from '../src/commands/link.js';
import { ledger } from '../src/discovery/availability.js';

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
const DOC = '55555555-5555-4555-8555-555555555555';
const STRANGER = '99999999-9999-4999-8999-999999999999';

// Token-shaped plants. Built by concatenation so this file holds no literal.
const PLANT_SESSION = 'tm8s' + '_' + 'Q'.repeat(12) + 'x9Zk_'.repeat(6);
const PLANT_CRED = 'tm8c' + '_' + 'abcDEF123-'.repeat(5);
const PLANT_B64 = 'Zm9v' + 'YmFyYmF6'.repeat(8);
const PLANT_HEX = 'deadbeef'.repeat(8);
const PLANTS = [PLANT_SESSION, PLANT_CRED, PLANT_B64, PLANT_HEX];

/** No tm8 token prefix and no long base64url/hex run anywhere in the text. */
function expectNoTokenShapes(text: string): void {
  for (const plant of PLANTS) expect(text).not.toContain(plant);
  expect(text).not.toMatch(/tm8[a-z]{0,3}_[A-Za-z0-9_-]{6,}/);
  expect(text).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  expect(text).not.toMatch(/[0-9a-fA-F]{32,}/);
}

const VIEW = {
  id: LINK,
  homeSpaceId: HOME,
  targetSpaceId: TARGET,
  targetServerId: null,
  targetSpaceName: 'Space B',
  createdAt: '2026-09-26T09:00:00.000Z',
  statusSummary: { signed_in: 1 },
  mine: {
    memberId: '44444444-4444-4444-8444-444444444444', status: 'signed_in', allowSpawn: false, spawnBudget: 0,
    alias: 'bee', sessionId: '66666666-6666-4666-8666-666666666666', expiresAt: null, lastUsedAt: null,
  },
};

interface Recorded { method: string; path: string; body: unknown }
type Reply = { status: number; body: unknown };
let recorded: Recorded[] = [];
let routes: Record<string, (body: Record<string, unknown>) => Reply> = {};

const ok = (data: unknown): Reply => ({ status: 200, body: { data, requestId: 'req_t' } });
const fail = (status: number, code: string, message: string, details?: unknown): Reply => ({
  status,
  body: { error: { code, message, requestId: 'req_t', retryable: false, ...(details === undefined ? {} : { details }) } },
});

function defaultRoutes(): typeof routes {
  return {
    [`GET /v2/spaces/${HOME}/space-links`]: () => ok([VIEW]),
    [`POST /v2/spaces/${HOME}/space-links/${LINK}/invoke`]: (body) => {
      // The home refused set, as the Server applies it (stubbed by op name).
      const op = String(body.op);
      if (op.startsWith('credentials.') || op === 'voice.token.create') {
        return fail(403, 'forbidden', `refused through a space link: token_minting`, {
          reason: 'space_link_refused', refusal: 'token_minting',
        });
      }
      return ok({ op, linkId: LINK, targetSpaceId: TARGET, auditId: 'audit-1', result: { id: DOC, kind: 'doc', spaceId: TARGET, title: 'B doc' } });
    },
  };
}

let server: Server;
let baseUrl: string;
let configDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      recorded.push({ method: req.method ?? '', path: url.pathname, body });
      const route = routes[`${req.method} ${url.pathname}`];
      const reply = route ? route(body) : fail(404, 'not_found', 'no such route in the stub');
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

const SAVED = ['TM8_BASE_URL', 'TM8_SPACE_ID', 'TM8_ACTOR_ID', 'TM8_CONFIG_PATH', 'TM8_SESSION_ID', 'TM8_AGENT_TOKEN', 'TM8_JOURNAL_CLASS', 'XDG_CONFIG_HOME'] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of SAVED) { saved[k] = process.env[k]; delete process.env[k]; }
  configDir = mkdtempSync(join(tmpdir(), 'tm8-space-link-'));
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = HOME;
  process.env.TM8_SESSION_ID = '77777777-7777-4777-8777-777777777777';
  process.env.TM8_JOURNAL_CLASS = 'human';
  recorded = [];
  routes = defaultRoutes();
  ledger.clear();
});

afterEach(() => {
  for (const k of SAVED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(configDir, { recursive: true, force: true });
  ledger.clear();
});

const paths = () => recorded.map((r) => `${r.method} ${r.path}`);
const LIST = `GET /v2/spaces/${HOME}/space-links`;
const INVOKE = `POST /v2/spaces/${HOME}/space-links/${LINK}/invoke`;

describe('tm8 --space <other> — only through spaceLinks.invoke on home', () => {
  it('an alias routes: home list, then ONE invoke carrying the op; nothing reaches any other path', async () => {
    const r = await tm8(['--space', 'bee', 'entity', 'get', DOC, '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual([LIST, INVOKE]);
    expect(recorded[1]!.body).toMatchObject({ op: 'entities.get', params: { id: DOC } });
    expect(JSON.parse(r.stdout)).toMatchObject({ id: DOC, title: 'B doc' });
  });

  it('the link id and the target Space id resolve to the same link', async () => {
    for (const ref of [LINK, TARGET, 'BEE']) {
      recorded = [];
      const r = await tm8(['--space', ref, 'entity', 'get', DOC, '--format', 'json']);
      expect(r.code, `${ref}: ${r.stderr}`).toBe(0);
      expect(paths()).toEqual([LIST, INVOKE]);
    }
  });

  it('refused op via --space is refused by home (403, space_link_refused); paired allowed op passes; both only via invoke', async () => {
    const refused = await tm8(['--space', 'bee', 'voice', 'token', DOC]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/space_link_refused|refused through a space link/);
    expect(paths()).toEqual([LIST, INVOKE]);
    expect(recorded[1]!.body).toMatchObject({ op: 'voice.token.create', params: { id: DOC } });

    recorded = [];
    const allowed = await tm8(['--space', 'bee', 'entity', 'get', DOC, '--format', 'json']);
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(paths()).toEqual([LIST, INVOKE]);
  });

  it('a raw id with no link fails with "ask your human to run `tm8 link add`", and nothing is invoked', async () => {
    const r = await tm8(['--space', STRANGER, 'entity', 'get', DOC]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('ask your human to run `tm8 link add`');
    expect(paths()).toEqual([LIST]);
  });

  it('positive for the rule: --space equal to the session Space is not routed', async () => {
    routes[`GET /v2/entities/${DOC}`] = () => ok({ id: DOC, kind: 'doc', spaceId: HOME, title: 'A doc' });
    const r = await tm8(['--space', HOME, 'entity', 'get', DOC, '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual([`GET /v2/entities/${DOC}`]);
  });

  it('positive for the rule: a shell with no session marker keeps --space\'s old meaning, even with TM8_SPACE_ID', async () => {
    delete process.env.TM8_SESSION_ID;
    routes[`GET /v2/entities/${DOC}`] = () => ok({ id: DOC, kind: 'doc', spaceId: TARGET, title: 'B doc' });
    const r = await tm8(['--space', TARGET, 'entity', 'get', DOC, '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual([`GET /v2/entities/${DOC}`]);
  });

  it('commands with their own transport or home-only state are refused up front, with no request', async () => {
    for (const argv of [
      ['event', 'watch'],
      ['file', 'upload', '/nonexistent'],
      ['file', 'download', DOC],
      ['session', 'attach', DOC],
      ['link', 'list'],
      ['auth', 'logout'],
    ]) {
      recorded = [];
      const r = await tm8(['--space', 'bee', ...argv]);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr).toContain('cannot run through a space link');
      expect(paths(), argv.join(' ')).toEqual([]);
    }
  });

  it('--server with a linked --space is refused before any request', async () => {
    const r = await tm8(['--space', 'bee', '--server', 'other', 'entity', 'get', DOC]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--server and a linked --space are exclusive');
    expect(paths()).toEqual([]);
  });
});

describe('tm8 link list|add|login|audit', () => {
  it('list reads home and renders the alias and target', async () => {
    const r = await tm8(['link', 'list']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual([LIST]);
    expect(r.stdout).toContain('bee');
    expect(r.stdout).toContain('Space B');
  });

  it('add posts the target, alias and a mutation id', async () => {
    routes[`POST /v2/spaces/${HOME}/space-links`] = () => ok(VIEW);
    const r = await tm8(['link', 'add', TARGET, '--alias', 'bee', '--mutation-id', 'm-1']);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded.at(-1)!.body).toEqual({ targetSpaceId: TARGET, alias: 'bee', clientMutationId: 'm-1' });
    expect(r.stdout).toContain('tm8 link login bee');
  });

  it('login resolves the alias to the link id and posts to it', async () => {
    routes[`POST /v2/space-links/${LINK}/login`] = () => ok(VIEW);
    const r = await tm8(['link', 'login', 'bee', '--mutation-id', 'm-2']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual([LIST, `POST /v2/space-links/${LINK}/login`]);
  });

  it('audit resolves the link and passes limit', async () => {
    routes[`GET /v2/space-links/${LINK}/audit`] = () => ok([
      { id: 'a1', linkId: LINK, op: 'entities.get', result: 'ok', reason: null, createdAt: '2026-09-26T09:30:00.000Z' },
    ]);
    const r = await tm8(['link', 'audit', 'bee', '--limit', '5']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual([LIST, `GET /v2/space-links/${LINK}/audit`]);
    expect(r.stdout).toContain('entities.get');
  });

  it('an agent refused by the Server gets the human-only hint; the CLI sends the call and adds no bypass', async () => {
    routes[`POST /v2/spaces/${HOME}/space-links`] = () => fail(403, 'forbidden', 'space link writes need a human session');
    const r = await tm8(['link', 'add', TARGET, '--mutation-id', 'm-3']);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('ask your human');
    expect(paths()).toEqual([`POST /v2/spaces/${HOME}/space-links`]);
  });
});

describe('tm8 link login|add never print a secret', () => {
  const planted = {
    ...VIEW,
    targetSpaceName: `B ${PLANT_B64}`,
    sessionToken: PLANT_SESSION,
    credential: PLANT_CRED,
    mine: { ...VIEW.mine, sessionId: PLANT_HEX },
  };

  for (const format of ['human', 'json']) {
    it(`success path (${format}): login and add scrub every token shape`, async () => {
      routes[`POST /v2/space-links/${LINK}/login`] = () => ok(planted);
      routes[`POST /v2/spaces/${HOME}/space-links`] = () => ok(planted);
      const extra = format === 'json' ? ['--format', 'json'] : [];
      const login = await tm8(['link', 'login', 'bee', '--mutation-id', 'm-4', ...extra]);
      const add = await tm8(['link', 'add', TARGET, '--mutation-id', 'm-5', ...extra]);
      for (const r of [login, add]) {
        expect(r.code, r.stderr).toBe(0);
        expectNoTokenShapes(r.stdout + r.stderr);
      }
      expect(login.stdout).toContain(LINK);
    });
  }

  it('error path: a token in the message, hint or details never reaches the output', async () => {
    routes[`POST /v2/space-links/${LINK}/login`] = () =>
      fail(400, 'invalid_input', `target refused ${PLANT_SESSION}`, { token: PLANT_CRED, echoed: [PLANT_HEX, PLANT_B64] });
    routes[`POST /v2/spaces/${HOME}/space-links`] = () =>
      fail(403, 'forbidden', `no: ${PLANT_HEX}`, { gate: PLANT_SESSION });
    for (const format of [[], ['--format', 'json']]) {
      const login = await tm8(['link', 'login', 'bee', '--mutation-id', 'm-6', ...format]);
      const add = await tm8(['link', 'add', TARGET, '--mutation-id', 'm-7', ...format]);
      for (const r of [login, add]) {
        expect(r.code).not.toBe(0);
        expectNoTokenShapes(r.stdout + r.stderr);
      }
    }
  });

  it('scrubText keeps UUIDs, ids and prose; scrubSecrets walks nested values', () => {
    expect(scrubText(`link ${LINK} → ${TARGET}`)).toBe(`link ${LINK} → ${TARGET}`);
    expect(scrubText('tm8 link login bee')).toBe('tm8 link login bee');
    expect(scrubText(`a ${PLANT_SESSION} b`)).toBe(`a ${REDACTED} b`);
    expect(scrubSecrets({ a: [{ b: PLANT_HEX }], n: 3, x: null })).toEqual({ a: [{ b: REDACTED }], n: 3, x: null });
  });
});
