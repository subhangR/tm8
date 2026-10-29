/**
 * `tm8 device register|update|unregister` (TM8 Mobile S1, migration 392) — the
 * real `run()` against a loopback stub that records every request, so each case
 * asserts the operation reached and the body sent.
 *
 * The rules that matter: the push token comes from stdin or a file and never
 * from argv, it is sent only in the body, and nothing the CLI prints carries
 * it — success, refusal or local usage error alike. And `tm8 help --query`
 * finds the verbs by what a person would ask.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/run.js';
import { ledger } from '../src/discovery/availability.js';

// The first run() loads the whole CLI; on a loaded node that alone can pass 5 s.
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

const DEVICE = '01a1867c-76d4-717a-ba18-cef48e00d469';
const TOKEN = 'ExponentPushToken[clitokenSECRET000000001]';
const ROTATED = 'ExponentPushToken[clitokenSECRET000000002]';

interface Recorded { method: string; path: string; body: Record<string, unknown> }
type Reply = { status: number; body: unknown };
let recorded: Recorded[] = [];
let routes: Record<string, (body: Record<string, unknown>) => Reply> = {};

const ok = (data: unknown): Reply => ({ status: 200, body: { data, requestId: 'req_t' } });
const fail = (status: number, code: string, message: string): Reply => ({
  status,
  body: { error: { code, message, requestId: 'req_t', retryable: false } },
});

function view(version: number, extra: Record<string, unknown> = {}) {
  return {
    deviceId: DEVICE,
    device: {
      id: DEVICE, platform: 'ios', relay: 'expo', appVersion: '1.0.0', locale: 'en-US', previews: 'sender',
      label: 'TM8 Mobile', quietUntil: null, version, createdAt: '2026-10-29T08:00:00.000Z',
      updatedAt: '2026-10-29T08:00:00.000Z', ...extra,
    },
  };
}

let server: Server;
let baseUrl: string;
let scratch: string;
let tokenFile: string;
let rotatedFile: string;

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

const SAVED = ['TM8_BASE_URL', 'TM8_SPACE_ID', 'TM8_ACTOR_ID', 'TM8_CONFIG_PATH', 'TM8_SESSION_ID', 'TM8_AGENT_TOKEN', 'TM8_JOURNAL_CLASS', 'TM8_NO_CACHE', 'XDG_CONFIG_HOME'] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of SAVED) { saved[k] = process.env[k]; delete process.env[k]; }
  scratch = mkdtempSync(join(tmpdir(), 'tm8-device-'));
  tokenFile = join(scratch, 'token');
  rotatedFile = join(scratch, 'rotated');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  writeFileSync(rotatedFile, ROTATED, { mode: 0o600 });
  process.env.XDG_CONFIG_HOME = scratch;
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_JOURNAL_CLASS = 'human';
  process.env.TM8_NO_CACHE = '1';
  recorded = [];
  routes = {};
  ledger.clear();
});

afterEach(() => {
  for (const k of SAVED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(scratch, { recursive: true, force: true });
  ledger.clear();
});

const REGISTER = ['device', 'register', '--platform', 'ios', '--app-version', '1.0.0', '--locale', 'en-US', '--label', 'TM8 Mobile'];

function expectNoToken(r: { stdout: string; stderr: string }): void {
  for (const text of [r.stdout, r.stderr]) {
    expect(text).not.toContain('clitokenSECRET');
  }
}

describe('tm8 device register', () => {
  it('reads the token from a file and sends it in the body only; the answer and output carry none', async () => {
    routes['POST /v2/devices'] = () => ok(view(1));
    const r = await tm8([...REGISTER, '--token', `@${tokenFile}`, '--previews', 'none', '--quiet-until', '2026-10-30T07:00:00Z']);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ method: 'POST', path: '/v2/devices' });
    expect(recorded[0]!.body).toMatchObject({
      platform: 'ios', relay: 'expo', token: TOKEN, appVersion: '1.0.0', locale: 'en-US', label: 'TM8 Mobile',
      previews: 'none', quietUntil: '2026-10-30T07:00:00Z',
    });
    expect(typeof recorded[0]!.body.clientMutationId).toBe('string');
    expect(r.stdout).toContain(`device ${DEVICE} v1`);
    expectNoToken(r);
  });

  it('refuses a token typed on the command line, sends nothing, and does not echo it', async () => {
    const r = await tm8([...REGISTER, '--token', TOKEN]);
    expect(r.code).toBe(2);
    expect(recorded).toHaveLength(0);
    expect(r.stderr).toContain('--token takes - (stdin) or @<file>');
    expectNoToken(r);
  });

  it('requires --token, and leaves previews and quietUntil to the server when absent', async () => {
    const missing = await tm8(REGISTER);
    expect(missing.code).toBe(2);
    expect(recorded).toHaveLength(0);
    routes['POST /v2/devices'] = () => ok(view(1));
    expect((await tm8([...REGISTER, '--token', `@${tokenFile}`])).code).toBe(0);
    expect(recorded[0]!.body).not.toHaveProperty('previews');
    expect(recorded[0]!.body).not.toHaveProperty('quietUntil');
  });

  it('a refusal reaches the person in the node\'s words, still without the token', async () => {
    routes['POST /v2/devices'] = () => fail(403, 'forbidden', 'credential operations are available to human sessions only');
    const r = await tm8([...REGISTER, '--token', `@${tokenFile}`]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('credential operations are available to human sessions only');
    expectNoToken(r);
  });
});

describe('tm8 device update and unregister', () => {
  it('update needs --expect-version and something to change', async () => {
    expect((await tm8(['device', 'update', DEVICE, '--previews', 'full'])).code).toBe(2);
    expect((await tm8(['device', 'update', DEVICE, '--expect-version', '1'])).code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('update rotates the token from a file, and --quiet-until none sends null', async () => {
    routes[`PUT /v2/devices/${DEVICE}`] = () => ok(view(2, { previews: 'full' }));
    const r = await tm8(['device', 'update', DEVICE, '--expect-version', '1', '--token', `@${rotatedFile}`, '--quiet-until', 'none']);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded[0]).toMatchObject({ method: 'PUT', path: `/v2/devices/${DEVICE}` });
    expect(recorded[0]!.body).toMatchObject({ expectedVersion: 1, token: ROTATED, quietUntil: null });
    expect(recorded[0]!.body).not.toHaveProperty('previews');
    expectNoToken(r);
  });

  it('unregister sends DELETE with a mutation id and says when there was nothing to remove', async () => {
    routes[`DELETE /v2/devices/${DEVICE}`] = () => ok({ deviceId: DEVICE, unregistered: false });
    const r = await tm8(['device', 'unregister', DEVICE]);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded[0]!.method).toBe('DELETE');
    expect(typeof recorded[0]!.body.clientMutationId).toBe('string');
    expect(recorded[0]!.body).not.toHaveProperty('expectedVersion');
    expect(r.stdout).toContain('nothing to unregister');
  });
});

describe('discovery (ac2)', () => {
  it('`tm8 help --query "register a phone for push notifications"` answers device register first', async () => {
    const r = await tm8(['help', '--query', 'register a phone for push notifications', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    const dto = JSON.parse(r.stdout) as { matches: Array<{ command: string | null; operation: string }> };
    expect(dto.matches[0]).toMatchObject({ command: 'device register', operation: 'devices.register' });
    const ops = dto.matches.map((m) => m.operation);
    expect(ops).toEqual(expect.arrayContaining(['devices.register', 'devices.update', 'devices.unregister']));
  });

  it('every verb has help text naming the token rule', async () => {
    for (const verb of ['register', 'update', 'unregister']) {
      const r = await tm8(['help', 'device', verb]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain(`tm8 device ${verb}`);
    }
    expect((await tm8(['help', 'device', 'register'])).stdout).toContain('never the token itself');
  });
});
