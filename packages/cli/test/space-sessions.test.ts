/**
 * W3-client, CLI half (task 01a0d9fd a2, a4).
 *
 * `tm8 auth space enter <id>` stores the pinned token next to the stored gate
 * credential, keyed by space; `tm8 --space <id> …` then presents it. A space
 * with no stored token is refused by an enforcing Server, and the CLI answers
 * that refusal with the command that fixes it. Under `agents` the Server
 * refuses nothing and the CLI sends the gate exactly as before.
 *
 * The fake node keeps #848's rule: under enforce, a request whose bearer is
 * not pinned may reach only `/v2/spaces` and `/v2/auth/*`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { run } from '../src/run.js';

const SPACE_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const SPACE_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const GATE = 'tm8s_gate-1.gate-secret';

const ACCOUNT = {
  accountId: '00000000-0000-4000-8000-00000000000a',
  identityId: '00000000-0000-4000-8000-00000000000b',
  username: 'alice',
  displayName: 'Alice',
  isNodeAdmin: false,
  isOwner: false,
};

interface Seen {
  path: string;
  authorization: string | undefined;
  status: number;
}

const ENV_KEYS = [
  'TM8_BASE_URL',
  'TM8_AGENT_TOKEN',
  'TM8_SESSION_ID',
  'TM8_TEAM_MEMBER_ID',
  'TM8_SPACE_ID',
  'TM8_CONFIG_PATH',
  'TM8_CREDENTIALS_PATH',
  'TM8_CREDENTIALS_MODE',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let mode: 'agents' | 'enforce' = 'enforce';
let seen: Seen[] = [];
let minted = 0;
const pins = new Map<string, string>(); // token -> space
const revoked = new Set<string>();
let api: Server;
let apiUrl = '';
let credPath = '';
const scratch: string[] = [];
let stdout = '';
let stderr = '';

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text ? (JSON.parse(text) as unknown) : undefined);
    });
  });
}

function stored(): Record<string, { token: string }> {
  return (JSON.parse(readFileSync(credPath, 'utf8')) as { credentials: Record<string, { token: string }> })
    .credentials;
}

function seedGate(token = GATE): void {
  mkdirSync(dirname(credPath), { recursive: true });
  writeFileSync(credPath, JSON.stringify({ version: 1, credentials: { [apiUrl]: { token } } }), { mode: 0o600 });
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  api = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const authorization = req.headers.authorization;
    const token = authorization?.replace(/^Bearer /, '');
    const send = (status: number, payload: unknown) => {
      seen.push({ path, authorization, status });
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    const refuse = (status: number, code: string, message: string) =>
      send(status, { error: { code, message, requestId: 'r', retryable: false } });

    if (path === '/v2/auth/login') {
      return send(200, {
        data: {
          token: 'tm8s_gate-2.second-gate',
          account: ACCOUNT,
          session: { sessionId: 'gate-2', kind: 'cli', label: null, expiresAt: '2099-01-01T00:00:00.000Z' },
        },
        requestId: 'r',
      });
    }
    if (!token || revoked.has(token)) return refuse(401, 'unauthenticated', 'invalid or expired token');
    const pinnedTo = pins.get(token);
    if (path === '/v2/auth/space/enter') {
      if (pinnedTo) return refuse(403, 'forbidden', 'a space-pinned session cannot enter a space; use the gate session');
      const spaceId = (body as { spaceId: string }).spaceId;
      const sessionId = `pin-${++minted}`;
      const pinned = `tm8s_${sessionId}.pin-secret-${minted}`;
      pins.set(pinned, spaceId);
      return send(200, {
        data: {
          token: pinned,
          spaceId,
          session: { sessionId, kind: 'cli', label: null, spaceId, expiresAt: '2099-01-01T00:00:00.000Z' },
        },
        requestId: 'r',
      });
    }
    if (path === '/v2/auth/logout') {
      revoked.add(token);
      return send(200, { data: { sessionId: token.slice(5, token.indexOf('.')), revoked: true }, requestId: 'r' });
    }
    const gateRoute = path === '/v2/spaces' || path.startsWith('/v2/auth/');
    if (mode === 'enforce' && !pinnedTo && !gateRoute) {
      return refuse(403, 'forbidden', 'this session is not in a space; call auth.space.enter first');
    }
    return send(200, { data: { items: [], nextCursor: null }, requestId: 'r' });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) => api.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  const dir = mkdtempSync(join(tmpdir(), 'tm8-space-sessions-'));
  scratch.push(dir);
  credPath = join(dir, 'credentials.json');
  process.env.TM8_CREDENTIALS_PATH = credPath;
  process.env.TM8_BASE_URL = apiUrl;
  mode = 'enforce';
  seen = [];
  pins.clear();
  revoked.clear();
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

describe('tm8 --space under TM8_SPACE_SESSIONS=enforce (a2)', () => {
  it('a space with no stored token is refused, and the CLI prompts for auth space enter', async () => {
    seedGate();
    expect(await run(['inbox', 'list', '--space', SPACE_A])).not.toBe(0);
    expect(seen.at(-1)).toMatchObject({ path: '/v2/inbox', authorization: `Bearer ${GATE}`, status: 403 });
    expect(stderr).toContain(`tm8 auth space enter ${SPACE_A}`);
  });

  it('auth space enter stores the pinned token by space; --space <id> then presents it, and the gate stays', async () => {
    seedGate();
    expect(await run(['auth', 'space', 'enter', SPACE_A])).toBe(0);
    expect(seen.at(-1)).toMatchObject({ path: '/v2/auth/space/enter', authorization: `Bearer ${GATE}`, status: 200 });
    const pinA = [...pins].find(([, space]) => space === SPACE_A)![0];
    // Stored, never echoed.
    expect(stdout).not.toContain(pinA);
    expect(stdout).toContain(`tm8 --space ${SPACE_A}`);
    const creds = stored();
    expect(creds[apiUrl]!.token).toBe(GATE);
    expect(Object.values(creds).map((c) => c.token)).toContain(pinA);

    expect(await run(['inbox', 'list', '--space', SPACE_A])).toBe(0);
    expect(seen.at(-1)).toMatchObject({ path: '/v2/inbox', authorization: `Bearer ${pinA}`, status: 200 });

    // Another space: still the gate, still refused, prompt names B.
    stderr = '';
    expect(await run(['inbox', 'list', '--space', SPACE_B])).not.toBe(0);
    expect(seen.at(-1)).toMatchObject({ authorization: `Bearer ${GATE}`, status: 403 });
    expect(stderr).toContain(`tm8 auth space enter ${SPACE_B}`);

    // The gate enters B too, because `auth` commands keep the gate.
    expect(await run(['auth', 'space', 'enter', SPACE_B, '--space', SPACE_A])).toBe(0);
    expect(seen.at(-1)).toMatchObject({ path: '/v2/auth/space/enter', authorization: `Bearer ${GATE}`, status: 200 });
    const pinB = [...pins].find(([, space]) => space === SPACE_B)![0];
    expect(await run(['inbox', 'list', '--space', SPACE_B])).toBe(0);
    expect(seen.at(-1)).toMatchObject({ authorization: `Bearer ${pinB}`, status: 200 });
  });

  it('--format json does not carry a stored token', async () => {
    seedGate();
    expect(await run(['auth', 'space', 'enter', SPACE_A, '--format', 'json'])).toBe(0);
    const pinA = [...pins].find(([, space]) => space === SPACE_A)![0];
    expect(stdout).not.toContain(pinA);
    expect(JSON.parse(stdout)).not.toHaveProperty('token');
  });

  it('re-entering a space revokes the pin it replaces', async () => {
    seedGate();
    expect(await run(['auth', 'space', 'enter', SPACE_A])).toBe(0);
    const first = [...pins.keys()].at(-1)!;
    expect(await run(['auth', 'space', 'enter', SPACE_A])).toBe(0);
    await vi.waitFor(() => expect(revoked.has(first)).toBe(true));
    expect(Object.values(stored()).map((c) => c.token)).not.toContain(first);
  });

  it('a revoked pinned token prompts to enter again', async () => {
    seedGate();
    expect(await run(['auth', 'space', 'enter', SPACE_A])).toBe(0);
    revoked.add([...pins.keys()].at(-1)!);
    expect(await run(['inbox', 'list', '--space', SPACE_A])).not.toBe(0);
    expect(stderr).toContain(`tm8 auth space enter ${SPACE_A}`);
  });

  it('logout revokes every pinned session with its own token and forgets them', async () => {
    seedGate();
    expect(await run(['auth', 'space', 'enter', SPACE_A])).toBe(0);
    expect(await run(['auth', 'space', 'enter', SPACE_B])).toBe(0);
    const minted = [...pins].filter(([t]) => !revoked.has(t)).map(([t]) => t);
    expect(await run(['auth', 'logout'])).toBe(0);
    await vi.waitFor(() => expect(minted.every((t) => revoked.has(t))).toBe(true));
    expect(stored).toThrow(); // the file is gone: nothing left for this origin
  });

  it('a fresh login forgets the pins of the previous gate', async () => {
    seedGate();
    expect(await run(['auth', 'space', 'enter', SPACE_A])).toBe(0);
    const pinA = [...pins.keys()].at(-1)!;
    expect(await run(['auth', 'login', 'alice', '--password', 'pw'])).toBe(0);
    expect(Object.values(stored()).map((c) => c.token)).toEqual(['tm8s_gate-2.second-gate']);
    await vi.waitFor(() => expect(revoked.has(pinA)).toBe(true));
  });

  it('with no store (--print-token) the pinned token is printed once, as before', async () => {
    seedGate();
    expect(await run(['auth', 'space', 'enter', SPACE_A, '--print-token'])).toBe(0);
    const pinA = [...pins.keys()].at(-1)!;
    expect(stdout).toContain(`export TM8_AGENT_TOKEN=${pinA}`);
    expect(Object.keys(stored())).toEqual([apiUrl]);
  });
});

describe('tm8 --space under TM8_SPACE_SESSIONS=agents (a4)', () => {
  it('sends the stored gate for --space, is served, and never mints', async () => {
    mode = 'agents';
    seedGate();
    expect(await run(['inbox', 'list', '--space', SPACE_A])).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ path: '/v2/inbox', authorization: `Bearer ${GATE}`, status: 200 });
    expect(Object.keys(stored())).toEqual([apiUrl]);
  });
});
