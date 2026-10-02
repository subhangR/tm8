/**
 * Space-scoped projects L1 (migration 282): `tm8 node path-grant list|add|revoke|mine`
 * and `tm8 node account list`.
 *
 * Drives the real `run()` against a loopback stub that records every request,
 * so each cell asserts the exact route, query and body the command sent. The
 * server decides who may grant what; the CLI only has to address the right
 * account (a username resolves through node.accounts.list) and say so plainly.
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
const GRANT = '44444444-4444-4444-8444-444444444444';

const ACCOUNTS = {
  accounts: [
    { accountId: ADMIN, username: 'root', status: 'active', isNodeAdmin: true },
    { accountId: ALICE, username: 'alice', displayName: 'Alice', status: 'active' },
  ],
};
const LIVE = {
  id: GRANT, accountId: ALICE, rootPath: '/srv/repos', mode: 'select', grantedAt: '2026-10-02T09:00:00.000Z',
  note: 'for the web repo', grantee: ACCOUNTS.accounts[1], grantedBy: { accountId: ADMIN, username: 'root' },
};
const REVOKED = { ...LIVE, revokedAt: '2026-10-02T10:00:00.000Z' };

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
    'GET /v2/node/path-grants': (r) => ok({ grants: r.query.includes('includeRevoked=true') ? [LIVE, { ...REVOKED, id: 'g2' }] : [LIVE] }),
    'POST /v2/node/path-grants': () => ok(LIVE),
    [`POST /v2/node/path-grants/${GRANT}/revoke`]: () => ok(REVOKED),
    'GET /v2/identity/path-grants': () => ok({ grants: [{ id: GRANT, accountId: ALICE, rootPath: '/srv/repos', mode: 'select', grantedAt: LIVE.grantedAt }] }),
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
  configDir = mkdtempSync(join(tmpdir(), 'tm8-path-grant-'));
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

describe('tm8 node path-grant', () => {
  it('list reads node.pathGrants.list, live grants only unless --include-revoked', async () => {
    const live = await tm8(['node', 'path-grant', 'list', '--format', 'human']);
    expect(live.code, live.stderr).toBe(0);
    expect(paths()).toEqual(['GET /v2/node/path-grants']);
    expect(live.stdout).toContain(`${GRANT}  alice  /srv/repos  granted 2026-10-02T09:00:00.000Z  — for the web repo`);

    recorded = [];
    const all = await tm8(['node', 'path-grant', 'list', '--include-revoked', '--format', 'human']);
    expect(all.code, all.stderr).toBe(0);
    expect(paths()).toEqual(['GET /v2/node/path-grants?includeRevoked=true']);
    expect(all.stdout).toContain('g2  alice  /srv/repos  revoked 2026-10-02T10:00:00.000Z');
  });

  it('add by account id sends the grant straight away, with the note', async () => {
    const r = await tm8(['node', 'path-grant', 'add', ALICE, '/srv/repos', '--note', 'for the web repo', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual(['POST /v2/node/path-grants']);
    expect(recorded[0]!.body).toMatchObject({ accountId: ALICE, rootPath: '/srv/repos', note: 'for the web repo' });
    expect(typeof recorded[0]!.body.clientMutationId).toBe('string');
    expect(JSON.parse(r.stdout)).toMatchObject({ id: GRANT, rootPath: '/srv/repos' });
  });

  it('add by username resolves it through node.accounts.list, case-insensitively', async () => {
    const r = await tm8(['node', 'path-grant', 'add', 'ALICE', '/srv/repos', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual(['GET /v2/node/accounts', 'POST /v2/node/path-grants']);
    expect(recorded[1]!.body).toMatchObject({ accountId: ALICE, rootPath: '/srv/repos' });
    expect(recorded[1]!.body).not.toHaveProperty('note');
    expect(r.stdout).toContain(`granted  ${GRANT}  alice  /srv/repos`);
  });

  it('add for an unknown username is refused before any write', async () => {
    const r = await tm8(['node', 'path-grant', 'add', 'mallory', '/srv/repos']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('no account named mallory on this node');
    expect(paths()).toEqual(['GET /v2/node/accounts']);
  });

  it('add without both arguments is a usage error and sends nothing', async () => {
    const r = await tm8(['node', 'path-grant', 'add', ALICE]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('usage: tm8 node path-grant add');
    expect(recorded).toEqual([]);
  });

  it('the server refusal (a path outside the roots) reaches the caller as one', async () => {
    routes['POST /v2/node/path-grants'] = () => fail(403, 'forbidden', 'path is outside the allowed project roots', { reason: 'path_not_allowed' });
    const r = await tm8(['node', 'path-grant', 'add', ALICE, '/etc']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('path is outside the allowed project roots');
  });

  it('revoke posts to the grant\'s own revoke route', async () => {
    const r = await tm8(['node', 'path-grant', 'revoke', GRANT, '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual([`POST /v2/node/path-grants/${GRANT}/revoke`]);
    expect(typeof recorded[0]!.body.clientMutationId).toBe('string');
    expect(r.stdout).toContain(`revoked  ${GRANT}  alice  /srv/repos  revoked 2026-10-02T10:00:00.000Z`);
  });

  it('mine reads identity.pathGrants.list, and says how to get a grant when there is none', async () => {
    const r = await tm8(['node', 'path-grant', 'mine', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual(['GET /v2/identity/path-grants']);
    expect(r.stdout).toContain('/srv/repos');

    routes['GET /v2/identity/path-grants'] = () => ok({ grants: [] });
    const none = await tm8(['node', 'path-grant', 'mine', '--format', 'human']);
    expect(none.code, none.stderr).toBe(0);
    expect(none.stdout).toContain('tm8 node path-grant add');
  });
});

describe('tm8 node account list', () => {
  it('names every account and marks the node admins', async () => {
    const r = await tm8(['node', 'account', 'list', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual(['GET /v2/node/accounts']);
    expect(r.stdout).toContain(`${ADMIN}  root  active  node admin`);
    expect(r.stdout).toContain(`${ALICE}  alice (Alice)  active`);
  });
});
