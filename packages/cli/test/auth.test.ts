/**
 * `tm8 auth …` + the per-server credential store, end to end through `run()`
 * against mock HTTP servers — the same in-process pattern as server.test.ts.
 *
 * What must hold (doc 13 §4.1, §4.3; the server-target refusal):
 *  - `auth login` stores the pass under the Server ORIGIN and never prints it;
 *    `--print-token` and agent contexts print once and store nothing.
 *  - a later command presents the stored pass as `Authorization: Bearer`.
 *  - `--server b` presents B's OWN stored credential to B; A's is presented
 *    only to A, and never carried across the hop.
 *  - `auth logout` revokes and removes the matching stored entry — including
 *    when the Server says the session is already dead.
 *  - a refused stored credential surfaces as a re-login prompt, not a bare 401.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { run } from '../src/run.js';

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

const ACCOUNT = {
  accountId: '00000000-0000-4000-8000-00000000000a',
  identityId: '00000000-0000-4000-8000-00000000000b',
  username: 'alice',
  displayName: 'Alice',
  isNodeAdmin: false,
  isOwner: false,
};

const SESSION = {
  sessionId: 'sess-1',
  kind: 'cli',
  actingAsTeamMemberId: null,
  label: null,
  expiresAt: '2026-11-01T00:00:00.000Z',
};

const TOKEN = 'tm8s_sess-1.secret-value-1';

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text ? (JSON.parse(text) as unknown) : undefined);
    });
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

function unauthenticatedBody(): string {
  return JSON.stringify({
    error: {
      code: 'unauthenticated',
      message: 'invalid or expired token',
      requestId: 'req-401',
      retryable: false,
    },
  });
}

const ENV_KEYS = [
  'TM8_BASE_URL',
  'TM8_AGENT_TOKEN',
  'TM8_SESSION_ID',
  'TM8_TEAM_MEMBER_ID',
  'TM8_CONFIG_PATH',
  'TM8_CREDENTIALS_PATH',
  'TM8_CREDENTIALS_MODE',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let credPath = '';
let scratchDirs: string[] = [];

function freshCredPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tm8-auth-test-'));
  scratchDirs.push(dir);
  return join(dir, 'credentials.json');
}

function seedCredential(origin: string, token: string): void {
  mkdirSync(dirname(credPath), { recursive: true });
  writeFileSync(
    credPath,
    JSON.stringify({ version: 1, credentials: { [origin]: { token } } }),
    { mode: 0o600 },
  );
}

function storedCredentials(): Record<string, { token: string }> {
  return (JSON.parse(readFileSync(credPath, 'utf8')) as {
    credentials: Record<string, { token: string }>;
  }).credentials;
}

let stdout = '';
let stderr = '';

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs = [];
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  credPath = freshCredPath();
  process.env.TM8_CREDENTIALS_PATH = credPath;
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auth login / logout against one Server', () => {
  let api: Server;
  let apiUrl = '';
  let seen: SeenRequest[] = [];
  /** Behaviour toggles, reset per test. */
  let logoutStatus: 200 | 401 = 200;

  beforeAll(async () => {
    api = createServer(async (req, res) => {
      const body = await readBody(req);
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      seen.push({
        method: req.method ?? '',
        path,
        authorization: req.headers.authorization,
        body,
      });
      res.setHeader('content-type', 'application/json');
      if (path === '/v2/auth/login') {
        res.end(JSON.stringify({ data: { token: TOKEN, account: ACCOUNT, session: SESSION }, requestId: 'req-login' }));
        return;
      }
      if (path === '/v2/auth/logout') {
        if (logoutStatus === 401) {
          res.statusCode = 401;
          res.end(unauthenticatedBody());
          return;
        }
        const requested = (body as { sessionId?: string } | undefined)?.sessionId ?? SESSION.sessionId;
        res.end(JSON.stringify({ data: { sessionId: requested, revoked: true }, requestId: 'req-logout' }));
        return;
      }
      if (path === '/v2/spaces') {
        if (req.headers.authorization === 'Bearer tm8s_stale.dead') {
          res.statusCode = 401;
          res.end(unauthenticatedBody());
          return;
        }
        res.end(JSON.stringify({ data: { items: [], nextCursor: null }, requestId: 'req-spaces' }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'not_found', message: `no route ${path}`, requestId: 'req-404', retryable: false } }));
    });
    apiUrl = await listen(api);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => api.close((e) => (e ? reject(e) : resolve())));
  });

  beforeEach(() => {
    seen = [];
    logoutStatus = 200;
    process.env.TM8_BASE_URL = apiUrl;
  });

  it('login stores the pass under the Server origin and never prints it', async () => {
    expect(await run(['auth', 'login', 'alice', '--password', 'pw'])).toBe(0);
    expect(storedCredentials()[apiUrl]?.token).toBe(TOKEN);
    expect(stdout).toContain(`credential stored for ${apiUrl} (file)`);
    expect(stdout).not.toContain(TOKEN);
    expect(stderr).toBe('');
    // The login request itself is claim-free: no bearer header.
    expect(seen).toMatchObject([{ method: 'POST', path: '/v2/auth/login', authorization: undefined }]);
  });

  it('login --print-token prints once and stores nothing', async () => {
    expect(await run(['auth', 'login', 'alice', '--password', 'pw', '--print-token'])).toBe(0);
    expect(existsSync(credPath)).toBe(false);
    expect(stdout).toContain(`export TM8_AGENT_TOKEN=${TOKEN}`);
  });

  it('an agent context prints once and never writes the human store', async () => {
    process.env.TM8_SESSION_ID = 'ws_spawned';
    expect(await run(['auth', 'login', 'alice', '--password', 'pw'])).toBe(0);
    expect(existsSync(credPath)).toBe(false);
    expect(stdout).toContain(`export TM8_AGENT_TOKEN=${TOKEN}`);
  });

  it('a later command presents the stored pass as a bearer', async () => {
    seedCredential(apiUrl, TOKEN);
    expect(await run(['space', 'list', '--format', 'json'])).toBe(0);
    expect(seen).toMatchObject([{ method: 'GET', path: '/v2/spaces', authorization: `Bearer ${TOKEN}` }]);
  });

  it('a stale stored credential fails WITH a re-login prompt', async () => {
    seedCredential(apiUrl, 'tm8s_stale.dead');
    expect(await run(['space', 'list', '--format', 'json'])).toBe(3);
    expect(stderr).toContain('unauthenticated');
    expect(stderr).toContain(`the stored credential for ${apiUrl} was refused`);
    expect(stderr).toContain('tm8 auth login');
  });

  it('logout revokes the stored session and removes the entry', async () => {
    seedCredential(apiUrl, TOKEN);
    expect(await run(['auth', 'logout'])).toBe(0);
    expect(seen).toMatchObject([{ method: 'POST', path: '/v2/auth/logout', authorization: `Bearer ${TOKEN}` }]);
    expect(existsSync(credPath)).toBe(false);
    expect(stdout).toContain('revoked session sess-1');
    expect(stdout).toContain(`removed the stored credential for ${apiUrl}`);
  });

  it('logout --session-id of a SIBLING session leaves this credential alone', async () => {
    seedCredential(apiUrl, TOKEN);
    expect(await run(['auth', 'logout', '--session-id', 'sess-other'])).toBe(0);
    expect(storedCredentials()[apiUrl]?.token).toBe(TOKEN);
    expect(stdout).toContain('revoked session sess-other');
    expect(stdout).not.toContain('removed the stored credential');
  });

  it('logout of an already-dead session still clears the store, exit 0', async () => {
    seedCredential(apiUrl, TOKEN);
    logoutStatus = 401;
    expect(await run(['auth', 'logout'])).toBe(0);
    expect(existsSync(credPath)).toBe(false);
    expect(stdout).toContain(`removed the stored credential for ${apiUrl}`);
  });
});

describe('--server routes each origin its OWN credential', () => {
  let registry: Server;
  let remote: Server;
  let registryUrl = '';
  let remoteUrl = '';
  let registrySeen: SeenRequest[] = [];
  let remoteSeen: SeenRequest[] = [];

  beforeAll(async () => {
    remote = createServer(async (req, res) => {
      const body = await readBody(req);
      remoteSeen.push({
        method: req.method ?? '',
        path: new URL(req.url ?? '/', 'http://x').pathname,
        authorization: req.headers.authorization,
        body,
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { items: [], nextCursor: null }, requestId: 'remote-request' }));
    });
    remoteUrl = await listen(remote);

    registry = createServer(async (req, res) => {
      const body = await readBody(req);
      registrySeen.push({
        method: req.method ?? '',
        path: new URL(req.url ?? '/', 'http://x').pathname,
        authorization: req.headers.authorization,
        body,
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        data: {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'work',
          baseUrl: remoteUrl,
          username: 'operator',
          createdAt: '2026-07-29T00:00:00.000Z',
          updatedAt: '2026-07-29T00:00:00.000Z',
        },
        requestId: 'registry-request',
      }));
    });
    registryUrl = await listen(registry);
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) => registry.close((e) => (e ? reject(e) : resolve()))),
      new Promise<void>((resolve, reject) => remote.close((e) => (e ? reject(e) : resolve()))),
    ]);
  });

  beforeEach(() => {
    registrySeen = [];
    remoteSeen = [];
    process.env.TM8_BASE_URL = registryUrl;
  });

  it('presents A\'s credential to A and B\'s credential to B', async () => {
    mkdirSync(dirname(credPath), { recursive: true });
    writeFileSync(
      credPath,
      JSON.stringify({
        version: 1,
        credentials: {
          [registryUrl]: { token: 'tm8s_a.secret-a' },
          [remoteUrl]: { token: 'tm8s_b.secret-b' },
        },
      }),
      { mode: 0o600 },
    );
    expect(await run(['--server', 'work', 'space', 'list', '--format', 'json'])).toBe(0);
    expect(registrySeen).toMatchObject([
      { path: '/v2/server-connections/work', authorization: 'Bearer tm8s_a.secret-a' },
    ]);
    expect(remoteSeen).toMatchObject([
      { path: '/v2/spaces', authorization: 'Bearer tm8s_b.secret-b' },
    ]);
  });

  it('with only A stored, B receives NO credential — never A\'s', async () => {
    seedCredential(registryUrl, 'tm8s_a.secret-a');
    expect(await run(['--server', 'work', 'space', 'list', '--format', 'json'])).toBe(0);
    expect(registrySeen).toMatchObject([
      { path: '/v2/server-connections/work', authorization: 'Bearer tm8s_a.secret-a' },
    ]);
    expect(remoteSeen).toMatchObject([{ path: '/v2/spaces', authorization: undefined }]);
  });
});
