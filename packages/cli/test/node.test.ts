/**
 * `tm8 node mode` and `tm8 node mode set` through `run()` against a mock
 * Server. The Server holds every switch rule; the CLI validates the argument,
 * sends `{ mode }` and nothing else (never a password), and maps a refusal to
 * its exit code.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/run.js';

const ENV_KEYS = ['TM8_BASE_URL', 'TM8_AGENT_TOKEN', 'TM8_SESSION_ID', 'TM8_TEAM_MEMBER_ID', 'TM8_CONFIG_PATH', 'TM8_CREDENTIALS_PATH'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

interface Seen { method: string; path: string; body: unknown }

let api: Server;
let apiUrl = '';
let seen: Seen[] = [];
let status: Record<string, unknown> = {};
let refusal: { status: number; code: string; reason: string } | null = null;
let scratch = '';
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

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  scratch = mkdtempSync(join(tmpdir(), 'tm8-node-test-'));
  api = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    seen.push({ method: req.method ?? '', path, body });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && path === '/v2/auth/claim') {
      res.end(JSON.stringify({ data: status, requestId: 'req-status' }));
      return;
    }
    if (req.method === 'PUT' && path === '/v2/node/mode') {
      if (refusal) {
        res.statusCode = refusal.status;
        res.end(JSON.stringify({
          error: { code: refusal.code, message: `refused: ${refusal.reason}`, details: { reason: refusal.reason }, requestId: 'req-mode', retryable: false },
        }));
        return;
      }
      const mode = (body as { mode: string }).mode;
      res.end(JSON.stringify({
        data: { previous: 'personal', mode, source: 'file', restartRequired: mode === 'server' },
        requestId: 'req-mode',
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 'not_found', message: `no route ${path}`, requestId: 'req-404', retryable: false } }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('no TCP address');
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await new Promise<void>((resolve, reject) => api.close((e) => (e ? reject(e) : resolve())));
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.TM8_BASE_URL = apiUrl;
  process.env.TM8_CREDENTIALS_PATH = join(scratch, 'credentials.json');
  seen = [];
  refusal = null;
  status = { claimed: true, mode: 'peer', modeSet: true, modeSource: 'file', signupPath: 'invite' };
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

// The first run() loads the command tree lazily: seconds on a loaded runner.
describe('tm8 node mode', { timeout: 20_000 }, () => {
  it('reads the mode and its source from auth.claim.status', async () => {
    expect(await run(['node', 'mode'])).toBe(0);
    expect(seen).toMatchObject([{ method: 'GET', path: '/v2/auth/claim' }]);
    expect(stdout).toContain('node mode: peer (from file)');
    expect(stdout).toContain('switch with: tm8 node mode set <personal|peer|server>');
  });

  it('says a pinned mode cannot be switched here', async () => {
    status = { ...status, mode: 'server', modeSource: 'env' };
    expect(await run(['node', 'mode'])).toBe(0);
    expect(stdout).toContain('node mode: server (from env)');
    expect(stdout).toContain('pinned by TM8_NODE_MODE');
    expect(stdout).not.toContain('switch with');
  });

  it('an unchosen mode reads as the default', async () => {
    status = { ...status, mode: 'personal', modeSet: false, modeSource: 'default' };
    expect(await run(['node', 'mode'])).toBe(0);
    expect(stdout).toContain('node mode: personal (default, no mode chosen yet)');
  });

  it('refuses an argument', async () => {
    expect(await run(['node', 'mode', 'peer'])).toBe(2);
    expect(seen).toEqual([]);
  });
});

describe('tm8 node mode set', { timeout: 20_000 }, () => {
  it('sends only { mode }, and says when a restart applies it', async () => {
    expect(await run(['node', 'mode', 'set', 'server'])).toBe(0);
    expect(seen).toMatchObject([{ method: 'PUT', path: '/v2/node/mode', body: { mode: 'server' } }]);
    expect(Object.keys(seen[0]!.body as object)).toEqual(['mode']);
    expect(stdout).toContain('mode: personal → server');
    expect(stdout).toContain('restart the Server to apply');
  });

  it('needs no restart line when the arm does not move', async () => {
    expect(await run(['node', 'mode', 'set', 'Peer'])).toBe(0);
    expect(seen[0]!.body).toEqual({ mode: 'peer' });
    expect(stdout).not.toContain('restart');
  });

  it('refuses a missing, extra or unknown mode (the legacy aliases included) without calling the Server', async () => {
    for (const args of [[], ['peer', 'server'], ['multi'], ['single'], ['owner']]) {
      expect(await run(['node', 'mode', 'set', ...args])).toBe(2);
    }
    expect(seen).toEqual([]);
    expect(stderr).toContain('usage: tm8 node mode set <personal|peer|server>');
  });

  it('maps the Server\'s refusals to their exit codes', async () => {
    const cases = [
      { refusal: { status: 409, code: 'conflict', reason: 'mode_pinned' }, exit: 6 },
      { refusal: { status: 409, code: 'conflict', reason: 'node_unclaimed' }, exit: 6 },
      { refusal: { status: 403, code: 'forbidden', reason: 'owner_session_required' }, exit: 4 },
      { refusal: { status: 401, code: 'unauthenticated', reason: 'anonymous' }, exit: 3 },
    ];
    for (const c of cases) {
      refusal = c.refusal;
      stderr = '';
      expect(await run(['node', 'mode', 'set', 'personal'])).toBe(c.exit);
      expect(stderr).toContain(c.refusal.code);
    }
  });
});
