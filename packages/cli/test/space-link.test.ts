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
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/run.js';
import { REMOTE_LINK_HINT, Tm8Client, type ClientOptions } from '../src/client.js';
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
        return fail(403, 'forbidden', `refused through a space link: grant`, {
          reason: 'space_link_refused', refusal: 'grant',
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

  it('a link to another server: home refuses cleanly (no forwarder, or W8 disabled) and the CLI says why; paired same-node link passes', async () => {
    for (const reply of [
      fail(501, 'not_implemented', 'this node cannot forward to a remote space link yet'),
      fail(403, 'forbidden', 'remote space links are disabled on this node', { reason: 'space_link_remote_disabled' }),
    ]) {
      routes[INVOKE] = () => reply;
      recorded = [];
      const r = await tm8(['--space', 'bee', 'entity', 'get', DOC]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(REMOTE_LINK_HINT);
      expect(paths()).toEqual([LIST, INVOKE]);
    }

    // Scope: a reserved op's own 501 through the link is not a remote refusal.
    routes[INVOKE] = () => fail(501, 'not_implemented', 'this operation is reserved');
    const reserved = await tm8(['--space', 'bee', 'entity', 'get', DOC]);
    expect(reserved.code).not.toBe(0);
    expect(reserved.stderr).not.toContain(REMOTE_LINK_HINT);

    routes = defaultRoutes();
    recorded = [];
    const refused = await tm8(['--space', 'bee', 'voice', 'token', DOC]);
    expect(refused.stderr).not.toContain(REMOTE_LINK_HINT);
    recorded = [];
    const allowed = await tm8(['--space', 'bee', 'entity', 'get', DOC, '--format', 'json']);
    expect(allowed.code, allowed.stderr).toBe(0);
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

describe('W7 review follow-ups (#887)', () => {
  it('a multi-value query key through a link is refused before any request; paired one-value key rides the invoke', async () => {
    const link = { homeSpaceId: HOME, linkId: LINK, targetSpaceId: TARGET };
    const client = new Tm8Client({ baseUrl, token: undefined, timeoutMs: 5_000, fresh: true, link });

    await expect(
      client.invoke('entities.get', { params: { id: DOC }, query: { include: ['a', 'b'] } }),
    ).rejects.toThrow(/carries one value per query key; --include was given 2/);
    expect(paths()).toEqual([]);

    const res = await client.invoke('entities.get', { params: { id: DOC }, query: { include: ['a'] } });
    expect(res).toMatchObject({ id: DOC });
    expect(paths()).toEqual([INVOKE]);
    expect(recorded[0]!.body).toMatchObject({ op: 'entities.get', params: { id: DOC }, query: { include: 'a' } });
  });

  it('an auth.space.enter refusal through a link points at HOME, never at entering the linked Space; paired direct call keeps its hint', async () => {
    const gate = () => fail(403, 'forbidden', 'this call needs a session pinned to the space (auth.space.enter)');
    routes[INVOKE] = gate;
    const linked = await tm8(['--space', 'bee', 'entity', 'get', DOC]);
    expect(linked.code).not.toBe(0);
    expect(paths()).toEqual([LIST, INVOKE]);
    expect(linked.stderr).not.toContain(`auth space enter ${TARGET}`);
    expect(linked.stderr).toContain(`do not enter the linked Space ${TARGET}`);
    expect(linked.stderr).toContain(`tm8 auth space enter ${HOME}`);

    // Pair: no session marker, so --space keeps its old meaning; the direct
    // hint still names the Space the call went to.
    delete process.env.TM8_SESSION_ID;
    recorded = [];
    routes[`GET /v2/entities/${DOC}`] = gate;
    const direct = await tm8(['--space', TARGET, 'entity', 'get', DOC]);
    expect(direct.code).not.toBe(0);
    expect(paths()).toEqual([`GET /v2/entities/${DOC}`]);
    expect(direct.stderr).toContain(`tm8 auth space enter ${TARGET}`);
  });

  it('while a link is active, a client built without it throws however it is built; paired with-link client builds; nothing outlives the invocation', async () => {
    class Sub extends Tm8Client {
      constructor(o: ClientOptions) { super(o); }
    }
    const Alias = Tm8Client;
    const opts: ClientOptions = { baseUrl, token: undefined, timeoutMs: 1_000 };
    const attempts: Record<string, string> = {};
    const tryBuild = (name: string, build: () => unknown): void => {
      try { build(); attempts[name] = 'built'; } catch (e) { attempts[name] = (e as Error).message; }
    };
    const home = defaultRoutes()[INVOKE]!;
    // The stub runs in this process, mid-invocation: the link is active here.
    routes[INVOKE] = (body) => {
      tryBuild('literal', () => new Tm8Client({ baseUrl, timeoutMs: 1_000 }));
      tryBuild('variable options', () => new Tm8Client(opts));
      tryBuild('alias', () => new Alias(opts));
      tryBuild('subclass', () => new Sub(opts));
      tryBuild('with link', () => new Tm8Client({ ...opts, link: { homeSpaceId: HOME, linkId: LINK, targetSpaceId: TARGET } }));
      return home(body);
    };
    const r = await tm8(['--space', 'bee', 'entity', 'get', DOC, '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    for (const name of ['literal', 'variable options', 'alias', 'subclass']) {
      expect(attempts[name], name).toMatch(/without the active space link/);
    }
    expect(attempts['with link']).toBe('built');
    expect(() => new Tm8Client(opts)).not.toThrow();

    // A linked invocation that FAILS clears it too.
    routes[INVOKE] = () => fail(403, 'forbidden', 'refused through a space link: grant', { reason: 'space_link_refused' });
    const refused = await tm8(['--space', 'bee', 'entity', 'get', DOC]);
    expect(refused.code).not.toBe(0);
    expect(() => new Tm8Client(opts)).not.toThrow();
  });

  it('source scan: the exact count of `new Tm8Client` per file that does not forward ctx.link (a lint; the constructor is the guard)', () => {
    // Keyed by path and count: a second unforwarded client in an allowed
    // file, or one in a file of the same basename elsewhere, fails.
    const ALLOWED: Record<string, number> = {
      // The link lookup itself is a home read, built before the link exists.
      'space-link-route.ts': 1,
      // Reached only with --server, which routeThroughSpaceLink refuses when a
      // link would be set (cell "--server with a linked --space").
      'server-target.ts': 1,
    };
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
    const unforwarded: Record<string, number> = {};
    const indirect: string[] = [];
    let forwarding = 0;
    for (const file of files) {
      const rel = relative(src, join(src, file)).split(sep).join('/');
      const text = readFileSync(join(src, file), 'utf8');
      // An alias or subclass hides constructions from this scan; the
      // constructor check still refuses them (previous cell).
      if (rel !== 'client.ts' && /extends\s+Tm8Client\b|=\s*Tm8Client\b|Tm8Client\s+as\b/.test(text)) indirect.push(rel);
      for (const m of text.matchAll(/new\s+Tm8Client\s*\(\s*/g)) {
        let end = m.index + m[0].length;
        let args = '';
        if (text[end] === '{') {
          for (let depth = 0; end < text.length; end += 1) {
            if (text[end] === '{') depth += 1;
            else if (text[end] === '}' && (depth -= 1) === 0) break;
          }
          args = text.slice(m.index, end + 1);
        }
        // Options from a variable cannot be read here: counted as unforwarded.
        if (/\blink\s*:\s*ctx\.link\b/.test(args)) forwarding += 1;
        else unforwarded[rel] = (unforwarded[rel] ?? 0) + 1;
      }
    }
    expect(indirect).toEqual([]);
    expect(unforwarded).toEqual(ALLOWED);
    expect(forwarding).toBeGreaterThanOrEqual(2);
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

  it('a secret with a tm8 prefix in its MIDDLE is redacted whole; its head never stays visible', () => {
    // generateSecret() is 32 random bytes as base64url (43 chars): about 7 in
    // 2,000,000 carry `tm8x_` somewhere inside. The head before it is under 40.
    const head = 'Qw3rTy9UioP' + 'a8Sd7Fg6Hj5Kl4Zx3Cv';
    const secret = head + 'tm8x_' + 'Bn2Mq1Wz';
    expect(secret).toHaveLength(43);
    const out = scrubText(`login refused for ${secret} (retry)`);
    expect(out).toBe(`login refused for ${REDACTED} (retry)`);
    expect(out).not.toContain(head.slice(0, 8));
    // Pair: a plain prefixed token and prose around it keep working.
    expect(scrubText(`use ${PLANT_CRED} now`)).toBe(`use ${REDACTED} now`);
    expect(scrubText('tm8 link login bee')).toBe('tm8 link login bee');
  });

  it('a name-shaped run made of a UUID pair or dashed hex is redacted; paired names with years and hex-letter words are kept', () => {
    const uuidPair = `${LINK}-${TARGET}`;
    expect(scrubText(`pair ${uuidPair} end`)).toBe(`pair ${REDACTED} end`);
    const lowerPair = 'c0ffee00-1234-4abc-9def-0123456789ab_' + '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
    expect(scrubText(lowerPair)).toBe(REDACTED);
    const dashedHex = 'a1b2-c3d4-e5f6-a7b8-c9d0-e1f2-a3b4-c5d6-e7f8';
    expect(dashedHex.length).toBeGreaterThanOrEqual(40);
    expect(scrubText(dashedHex)).toBe(REDACTED);
    // Pair: words that are hex-lettered or all digits, but not hex ids.
    const names = ['quarterly-review-2026-09-research-space-notes', 'dead-code-audit-for-the-face-and-cafe-teams'];
    for (const name of names) {
      expect(name.length).toBeGreaterThanOrEqual(40);
      expect(scrubText(name)).toBe(name);
    }
    // One UUID alone is under 40 and stays readable.
    expect(scrubText(`link ${LINK}`)).toBe(`link ${LINK}`);
  });

  it('long aliases and names are kept; a token of the same length is still redacted', () => {
    const alias = 'my-research-space-for-the-quarterly-review';
    const name = 'project_documentation_and_research_notes_2026';
    expect(alias.length).toBeGreaterThanOrEqual(40);
    expect(scrubText(`linked: ${alias} (${name})`)).toBe(`linked: ${alias} (${name})`);
    // Pair: same length, token-shaped (mixed case, one long word) — redacted.
    // Word-joined like a name, so only its case marks it as a token.
    const token = 'Ab3' + 'xY9-kQ2_'.repeat(5) + 'Zz';
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(scrubText(`a ${token} b`)).toBe(`a ${REDACTED} b`);
    // A lowercase run with no word breaks is not a name either.
    expect(scrubText('a ' + 'q'.repeat(44) + ' b')).toBe(`a ${REDACTED} b`);
    // Nor is one whose words are longer than any name's.
    expect(scrubText('a ' + 'q'.repeat(30) + '-' + 'r'.repeat(15) + ' b')).toBe(`a ${REDACTED} b`);
    for (const plant of PLANTS) expect(scrubText(plant)).toBe(REDACTED);
  });
});
