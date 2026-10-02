/**
 * L5 (280) — `tm8 request create|list|get|approve|deny` against a loopback
 * stub that records every request: what is sent, to which path, and that a
 * local refusal (an op off the allow-list, no justification, bad JSON) sends
 * nothing at all.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/run.js';
import { ledger } from '../src/discovery/availability.js';

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
const TARGET = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';

const VIEW = {
  id: REQUEST, spaceId: SPACE, op: 'spaceLinks.add', label: 'Link a space',
  params: { spaceId: SPACE }, input: { targetSpaceId: TARGET }, justification: 'read the docs space',
  title: `Link a space: spaceId=${SPACE}, targetSpaceId=${TARGET}`, status: 'pending', approver: 'requester',
  requestedBy: '44444444-4444-4444-8444-444444444444', requestingSessionId: '55555555-5555-4555-8555-555555555555',
  decidedBy: null, decidedAt: null, decisionNote: null, result: null, error: null, canDecide: true,
  createdAt: '2026-10-02T09:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z', version: 1,
};

interface Recorded { method: string; path: string; query: string; body: Record<string, unknown> }
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
    [`POST /v2/spaces/${SPACE}/op-requests`]: () => ok(VIEW),
    [`GET /v2/spaces/${SPACE}/op-requests`]: () => ok([VIEW]),
    [`GET /v2/op-requests/${REQUEST}`]: () => ok(VIEW),
    [`POST /v2/op-requests/${REQUEST}/approve`]: (body) => ok({
      request: { ...VIEW, status: 'succeeded', decisionNote: body.note ?? null, result: { id: 'link-1' }, canDecide: false },
      notified: true,
    }),
    [`POST /v2/op-requests/${REQUEST}/deny`]: () => fail(403, 'forbidden', 'only a human can approve or deny an op request',
      { reason: 'op_requests_human_only' }),
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
      recorded.push({ method: req.method ?? '', path: url.pathname, query: url.search, body });
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
  configDir = mkdtempSync(join(tmpdir(), 'tm8-request-'));
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

describe('tm8 request create', () => {
  it('files the op, params, input and justification on this Space', async () => {
    const r = await tm8(['request', 'create', 'spaceLinks.setSpawn', '--params', '{"linkId":"L1"}',
      '--input', '{"allowSpawn":true}', '--justification', 'I need to start a worker there', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      method: 'POST', path: `/v2/spaces/${SPACE}/op-requests`,
      body: { op: 'spaceLinks.setSpawn', params: { linkId: 'L1' }, input: { allowSpawn: true },
        justification: 'I need to start a worker there' },
    });
    expect(typeof recorded[0]!.body.clientMutationId).toBe('string');
    expect(JSON.parse(r.stdout)).toMatchObject({ id: REQUEST, status: 'pending' });
  });

  it('refuses locally, sending nothing: an op off the allow-list, no justification, a non-object input', async () => {
    const off = await tm8(['request', 'create', 'spaces.members.remove', '--justification', 'x']);
    expect(off.code).toBe(2);
    expect(off.stderr).toContain('requestable ops: spaceLinks.add');
    const why = await tm8(['request', 'create', 'spaceLinks.add', '--input', `{"targetSpaceId":"${TARGET}"}`]);
    expect(why.code).toBe(2);
    expect(why.stderr).toContain('--justification');
    const arr = await tm8(['request', 'create', 'spaceLinks.add', '--input', '[1]', '--justification', 'x']);
    expect(arr.code).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('the text output tells the agent the outcome comes back as a message', async () => {
    const r = await tm8(['request', 'create', 'spaceLinks.add', '--input', `{"targetSpaceId":"${TARGET}"}`, '--justification', 'x', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('PENDING');
    expect(r.stdout).toContain('the outcome is messaged to this session');
  });
});

describe('tm8 request list|get|approve|deny', () => {
  it('list passes --status and --limit as the query', async () => {
    const r = await tm8(['request', 'list', '--status', 'pending', '--limit', '5', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded[0]).toMatchObject({ method: 'GET', path: `/v2/spaces/${SPACE}/op-requests` });
    expect(new URLSearchParams(recorded[0]!.query).get('status')).toBe('pending');
    expect(new URLSearchParams(recorded[0]!.query).get('limit')).toBe('5');
    expect(r.stdout).toContain(REQUEST);
    const bad = await tm8(['request', 'list', '--status', 'nope']);
    expect(bad.code).toBe(2);
  });

  it('get reads one request', async () => {
    const r = await tm8(['request', 'get', REQUEST, '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('why: read the docs space');
    expect(r.stdout).toContain('(you can decide it)');
  });

  it('approve sends the note and prints the outcome', async () => {
    const r = await tm8(['request', 'approve', REQUEST, '--note', 'go ahead', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded[0]).toMatchObject({ method: 'POST', path: `/v2/op-requests/${REQUEST}/approve`, body: { note: 'go ahead' } });
    expect(r.stdout).toContain('SUCCEEDED');
    expect(r.stdout).toContain('the requesting session was messaged');
  });

  it('a human-only refusal says only a human decides', async () => {
    const r = await tm8(['request', 'deny', REQUEST]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('only a human approves or denies');
  });
});
