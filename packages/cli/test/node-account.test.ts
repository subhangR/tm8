/**
 * Account administration (migration 324): `tm8 node account create|reset|enable|admin|add-to-space`
 * and `tm8 auth setup resolve|redeem`.
 *
 * Same loopback-stub harness as node-path-grant.test.ts: each cell asserts the
 * exact route and body. Authorization is the server's (pg test
 * account-admin.pg.test.ts); the CLI must address the right account and print
 * the one-time link exactly once.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/run.js';
import { ledger } from '../src/discovery/availability.js';

// The first run() in a worker loads the command table cold; on a loaded CI box
// that alone can pass vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

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

const SPACE = '11111111-1111-4111-8111-111111111111';
const ALICE = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';

const ACCOUNTS = {
  accounts: [
    { accountId: ADMIN, username: 'root', status: 'active', isNodeAdmin: true },
    { accountId: ALICE, username: 'alice', displayName: 'Alice', status: 'active' },
  ],
};
const LINK = { setupToken: 'tm8a_secret', setupUrl: 'https://tm8.example/#setup=tm8a_secret', expiresAt: '2026-10-16T09:00:00.000Z' };

interface Recorded { method: string; path: string; query: string; body: Record<string, unknown> }
type Reply = { status: number; body: unknown };
let recorded: Recorded[] = [];
let routes: Record<string, (r: Recorded) => Reply> = {};

const ok = (data: unknown): Reply => ({ status: 200, body: { data, requestId: 'req_t' } });
const fail = (status: number, code: string, message: string, details?: unknown): Reply => ({
  status,
  body: { error: { code, message, requestId: 'req_t', retryable: false, ...(details === undefined ? {} : { details }) } },
});

function defaultRoutes(): typeof routes {
  return {
    'GET /v2/node/accounts': () => ok(ACCOUNTS),
    'POST /v2/node/accounts': (r) => ok({
      account: { accountId: 'new-id', username: r.body.username, status: 'active', isNodeAdmin: r.body.isNodeAdmin === true },
      ...LINK,
      ...(r.body.spaceId ? { membership: { spaceId: r.body.spaceId, memberId: 'mem-id', role: r.body.role } } : {}),
    }),
    [`POST /v2/node/accounts/${ALICE}/reset`]: () => ok({ accountId: ALICE, username: 'alice', revokedSessionCount: 2, ...LINK }),
    [`POST /v2/accounts/${ALICE}/enable`]: () => ok({ accountId: ALICE, status: 'active' }),
    [`POST /v2/accounts/${ALICE}/disable`]: () => ok({ accountId: ALICE, status: 'disabled', disabledAt: 'x', revokedSessionCount: 1, stoppedSessionIds: [] }),
    [`PUT /v2/node/accounts/${ALICE}/node-admin`]: (r) => ok({ accountId: ALICE, isNodeAdmin: r.body.isNodeAdmin }),
    [`POST /v2/node/accounts/${ALICE}/memberships`]: (r) => ok({ accountId: ALICE, spaceId: r.body.spaceId, memberId: 'mem-id', role: r.body.role, created: true }),
    'POST /v2/auth/setup/resolve': () => ok({ status: 'valid', username: 'alice', purpose: 'create', expiresAt: LINK.expiresAt }),
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
      const entry: Recorded = {
        method: req.method ?? '',
        path: url.pathname,
        query: url.search,
        body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
      };
      recorded.push(entry);
      const route = routes[`${entry.method} ${entry.path}`];
      const reply = route ? route(entry) : fail(404, 'not_found', 'no such route in the stub');
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
  configDir = mkdtempSync(join(tmpdir(), 'tm8-node-account-'));
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = SPACE;
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

const paths = () => recorded.map((r) => `${r.method} ${r.path}${r.query}`);

describe('tm8 node account', () => {
  it('create sends node.accounts.create and prints the one-time link', async () => {
    const r = await tm8(['node', 'account', 'create', 'bob', '--display-name', 'Bob', '--node-admin',
      '--join-space', SPACE, '--role', 'member', '--expires-hours', '24', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual(['POST /v2/node/accounts']);
    expect(recorded[0]!.body).toMatchObject({ username: 'bob', displayName: 'Bob', isNodeAdmin: true, spaceId: SPACE, role: 'member', expiresInHours: 24 });
    expect(recorded[0]!.body).toHaveProperty('clientMutationId');
    expect(r.stdout).toContain(`added to space ${SPACE} as member`);
    expect(r.stdout).toContain(LINK.setupUrl);
  });

  it('create refuses a role without a space, and a bad expiry, before any request', async () => {
    expect((await tm8(['node', 'account', 'create', 'bob', '--role', 'member'])).code).toBe(2);
    expect((await tm8(['node', 'account', 'create', 'bob', '--expires-hours', '9999'])).code).toBe(2);
    expect(recorded).toEqual([]);
  });

  it('reset resolves a username, requires --yes, and prints the new link', async () => {
    expect((await tm8(['node', 'account', 'reset', 'alice'])).code).toBe(2);
    expect(recorded).toEqual([]);
    const r = await tm8(['node', 'account', 'reset', 'alice', '--yes', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual(['GET /v2/node/accounts', `POST /v2/node/accounts/${ALICE}/reset`]);
    expect(r.stdout).toContain('sessions revoked 2');
    expect(r.stdout).toContain(LINK.setupUrl);
  });

  it('enable, disable, admin grant|revoke and add-to-space address the account by username', async () => {
    expect((await tm8(['node', 'account', 'enable', 'alice'])).code).toBe(0);
    expect((await tm8(['node', 'account', 'disable', 'alice', '--yes'])).code).toBe(0);
    expect((await tm8(['node', 'account', 'admin', 'alice', 'grant'])).code).toBe(0);
    expect((await tm8(['node', 'account', 'admin', 'alice', 'revoke'])).code).toBe(0);
    expect((await tm8(['node', 'account', 'add-to-space', 'alice', SPACE, '--role', 'admin'])).code).toBe(0);
    expect(paths().filter((p) => !p.startsWith('GET'))).toEqual([
      `POST /v2/accounts/${ALICE}/enable`,
      `POST /v2/accounts/${ALICE}/disable`,
      `PUT /v2/node/accounts/${ALICE}/node-admin`,
      `PUT /v2/node/accounts/${ALICE}/node-admin`,
      `POST /v2/node/accounts/${ALICE}/memberships`,
    ]);
    const admin = recorded.filter((r) => r.path.endsWith('/node-admin')).map((r) => r.body.isNodeAdmin);
    expect(admin).toEqual([true, false]);
    expect(recorded.at(-1)!.body).toMatchObject({ spaceId: SPACE, role: 'admin' });
    expect((await tm8(['node', 'account', 'admin', 'alice', 'maybe'])).code).toBe(2);
  });
});

describe('tm8 auth setup', () => {
  it('resolve reads auth.setup.resolve with the token in the body', async () => {
    const r = await tm8(['auth', 'setup', 'resolve', '--token', 'tm8a_secret', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual(['POST /v2/auth/setup/resolve']);
    expect(recorded[0]!.body).toEqual({ token: 'tm8a_secret' });
    expect(r.stdout).toContain('new account for alice');
  });
});
