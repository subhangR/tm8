/**
 * `tm8 style` (styles spec 01a0fc22 v8 §5) — the real `run()` against a
 * loopback stub that records every request, so each case asserts the
 * operations the CLI reached and the bodies it sent, not only its exit code.
 *
 * The cases that matter most are the ones an agent leans on: a bare uuid
 * finding the right style, `set` surviving exactly one concurrent edit (and no
 * more), `push` re-versioning the style it was pushed as, and `--strict`
 * turning warnings into a non-zero exit.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/run.js';
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

const SPACE = '11111111-1111-4111-8111-111111111111';
const PERSONAL = '22222222-2222-4222-8222-222222222222';
const SPACE_STYLE = '33333333-3333-4333-8333-333333333333';
const PUBLISHED = '44444444-4444-4444-8444-444444444444';

interface Recorded { method: string; path: string; query: string; body: Record<string, unknown> }
type Reply = { status: number; body: unknown };
let recorded: Recorded[] = [];
let routes: Record<string, (body: Record<string, unknown>, query: URLSearchParams) => Reply> = {};

const ok = (data: unknown): Reply => ({ status: 200, body: { data, requestId: 'req_t' } });
const fail = (status: number, code: string, message: string, details?: unknown): Reply => ({
  status,
  body: { error: { code, message, requestId: 'req_t', retryable: false, ...(details === undefined ? {} : { details }) } },
});

const DOC = { schemaVersion: 1, foundation: 'builtin:atelier-dark', vars: { '--pn-brand': '#111111' }, css: null };

function personalGet(version: number, publishedAs: string | null = null) {
  const style = {
    id: PERSONAL, ref: `personal:${PERSONAL}`, title: 'Mine', description: null, tags: [], version,
    doc: DOC, resolvedHash: 'sha256:x', publishedAs, pulledFrom: null,
    createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
  };
  return {
    origin: 'personal', ref: style.ref, id: PERSONAL, title: 'Mine', description: null, tags: [], version,
    doc: DOC, resolvedHash: 'sha256:x', resolved: { cssVars: {}, hash: 'sha256:r' }, warnings: [], personal: style,
  };
}

function writeResult(version: number) {
  return { style: { id: PERSONAL, ref: `personal:${PERSONAL}`, title: 'Mine', version }, warnings: [], clamped: [] };
}

const PREFS = {
  currentStyle: 'builtin:atelier-light', darkStyle: null, followOs: false, trustedCss: [],
  snapshot: { current: null, dark: null, currentHash: null, currentTitle: null }, revision: 1,
  updatedAt: '2026-10-02T00:00:00.000Z',
};

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
      // Refs carry a `:`; whether the client percent-encodes it is not the
      // behaviour under test, so the stub matches on the decoded path.
      const path = decodeURIComponent(url.pathname);
      recorded.push({ method: req.method ?? '', path, query: url.search, body });
      const route = routes[`${req.method} ${path}`];
      const reply = route ? route(body, url.searchParams) : fail(404, 'not_found', 'no such route in the stub');
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
  configDir = mkdtempSync(join(tmpdir(), 'tm8-style-'));
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = SPACE;
  process.env.TM8_JOURNAL_CLASS = 'human';
  // Every read must reach the stub: the call lists below are the assertion.
  process.env.TM8_NO_CACHE = '1';
  recorded = [];
  routes = {};
  ledger.clear();
});

afterEach(() => {
  for (const k of SAVED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(configDir, { recursive: true, force: true });
  ledger.clear();
});

const calls = () => recorded.map((r) => `${r.method} ${r.path}`);
const GET_PERSONAL = `GET /v2/styles/personal:${PERSONAL}`;
const GET_SPACE = `GET /v2/styles/space:${SPACE_STYLE}`;
const PATCH_PERSONAL = `PATCH /v2/identity/styles/${PERSONAL}`;

describe('tm8 style — references', () => {
  it('a typed ref costs no lookup: get personal:<id> is ONE styles.get', async () => {
    routes[GET_PERSONAL] = () => ok(personalGet(3));
    const r = await tm8(['style', 'get', `personal:${PERSONAL}`, '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(calls()).toEqual([GET_PERSONAL]);
    recorded = [];
    routes['GET /v2/styles/builtin:atelier-dark'] = () => ok({ ...personalGet(1), origin: 'builtin', ref: 'builtin:atelier-dark' });
    const b = await tm8(['style', 'get', 'builtin:atelier-dark', '--format', 'json']);
    expect(b.code, b.stderr).toBe(0);
    expect(calls()).toEqual(['GET /v2/styles/builtin:atelier-dark']);
  });

  it('a bare uuid is personal first, then space when the personal read is not_found', async () => {
    routes[`GET /v2/styles/personal:${SPACE_STYLE}`] = () => fail(404, 'not_found', 'personal style not found');
    routes[GET_SPACE] = () => ok({ ...personalGet(2), origin: 'space', ref: `space:${SPACE_STYLE}`, id: SPACE_STYLE });
    const r = await tm8(['style', 'get', SPACE_STYLE, '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(calls()).toEqual([`GET /v2/styles/personal:${SPACE_STYLE}`, GET_SPACE, GET_SPACE]);
  });

  it('a bare uuid that is the caller\'s personal style stops at the first read', async () => {
    routes[GET_PERSONAL] = () => ok(personalGet(1));
    const r = await tm8(['style', 'get', PERSONAL, '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(calls()).not.toContain(`GET /v2/styles/space:${PERSONAL}`);
  });

  it('something that is neither a typed ref nor a uuid is a usage error with no request', async () => {
    const r = await tm8(['style', 'get', 'midnight']);
    expect(r.code).toBe(2);
    expect(recorded).toEqual([]);
  });
});

describe('tm8 style set / unset — merge patch with one retry', () => {
  it('without --expect-version: reads the version, PATCHes the merge patch under it', async () => {
    routes[GET_PERSONAL] = () => ok(personalGet(7));
    routes[PATCH_PERSONAL] = () => ok(writeResult(8));
    const r = await tm8(['style', 'set', `personal:${PERSONAL}`, '--pn-brand=#4F7DF3', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    const patches = recorded.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toMatchObject({ vars: { '--pn-brand': '#4F7DF3' }, expectedVersion: 7 });
    expect(typeof patches[0]!.body.clientMutationId).toBe('string');
  });

  it('a version_conflict retries EXACTLY once, at details.currentVersion, with a fresh mutation id', async () => {
    routes[GET_PERSONAL] = () => ok(personalGet(7));
    let n = 0;
    routes[PATCH_PERSONAL] = (body) => {
      n += 1;
      return body.expectedVersion === 9 ? ok(writeResult(10)) : fail(409, 'version_conflict', 'stale', { currentVersion: 9 });
    };
    const r = await tm8(['style', 'set', `personal:${PERSONAL}`, '--pn-brand=#4F7DF3', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(n).toBe(2);
    const patches = recorded.filter((c) => c.method === 'PATCH');
    expect(patches.map((p) => p.body.expectedVersion)).toEqual([7, 9]);
    expect(patches[1]!.body.vars).toEqual({ '--pn-brand': '#4F7DF3' });
    expect(patches[1]!.body.clientMutationId).not.toBe(patches[0]!.body.clientMutationId);
  });

  it('a second conflict surfaces: no third attempt, non-zero exit', async () => {
    routes[GET_PERSONAL] = () => ok(personalGet(7));
    routes[PATCH_PERSONAL] = () => fail(409, 'version_conflict', 'stale', { currentVersion: 11 });
    const r = await tm8(['style', 'set', `personal:${PERSONAL}`, '--pn-brand=#4F7DF3']);
    expect(r.code).toBe(6);
    expect(recorded.filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  it('with --expect-version: one guarded write, no read and no retry', async () => {
    routes[PATCH_PERSONAL] = () => fail(409, 'version_conflict', 'stale', { currentVersion: 5 });
    const r = await tm8(['style', 'set', `personal:${PERSONAL}`, '--pn-brand=#4F7DF3', '--expect-version', '4']);
    expect(r.code).toBe(6);
    expect(calls()).toEqual([PATCH_PERSONAL]);
    expect(recorded[0]!.body.expectedVersion).toBe(4);
  });

  it('unset sends each named variable as null (the merge patch\'s delete)', async () => {
    routes[GET_PERSONAL] = () => ok(personalGet(2));
    routes[PATCH_PERSONAL] = () => ok(writeResult(3));
    const r = await tm8(['style', 'unset', `personal:${PERSONAL}`, '--pn-paper', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    const patch = recorded.find((c) => c.method === 'PATCH')!;
    expect(patch.body.vars).toEqual({ '--pn-paper': null });
    expect(patch.body.expectedVersion).toBe(2);
  });

  it('set refuses a space style: it is read-only (no write is attempted)', async () => {
    const r = await tm8(['style', 'set', `space:${SPACE_STYLE}`, '--pn-brand=#4F7DF3']);
    expect(r.code).toBe(2);
    expect(recorded.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('tm8 style push', () => {
  it('without --to: targets the personal style\'s publishedAs', async () => {
    routes[GET_PERSONAL] = () => ok(personalGet(4, PUBLISHED));
    routes['POST /v2/styles/push'] = () => ok({ style: { id: PUBLISHED, ref: `space:${PUBLISHED}`, title: 'Mine', version: 2 }, warnings: [], clamped: [] });
    const r = await tm8(['style', 'push', `personal:${PERSONAL}`, '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    const push = recorded.find((c) => c.path === '/v2/styles/push')!;
    expect(push.body).toMatchObject({ personalStyleId: PERSONAL, spaceId: SPACE, targetStyleId: PUBLISHED });
    expect(push.body).not.toHaveProperty('expectedVersion');
  });

  it('a never-pushed style sends no target: the server creates a new space style', async () => {
    routes[GET_PERSONAL] = () => ok(personalGet(1, null));
    routes['POST /v2/styles/push'] = () => ok({ style: { id: PUBLISHED, ref: `space:${PUBLISHED}`, title: 'Mine', version: 1 }, warnings: [], clamped: [] });
    const r = await tm8(['style', 'push', `personal:${PERSONAL}`, '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded.find((c) => c.path === '/v2/styles/push')!.body).not.toHaveProperty('targetStyleId');
  });

  it('--to wins over publishedAs', async () => {
    routes['POST /v2/styles/push'] = () => ok({ style: { id: SPACE_STYLE, ref: `space:${SPACE_STYLE}`, title: 'Mine', version: 5 }, warnings: [], clamped: [] });
    const r = await tm8(['style', 'push', `personal:${PERSONAL}`, '--to', `space:${SPACE_STYLE}`, '--expect-version', '4', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded.find((c) => c.path === '/v2/styles/push')!.body)
      .toMatchObject({ targetStyleId: SPACE_STYLE, expectedVersion: 4 });
  });
});

describe('tm8 style resolve --strict', () => {
  const resolved = (warnings: unknown[]) => ok({
    resolved: { cssVars: { '--pn-paper': '#000000' }, hash: 'sha256:r' }, warnings, clamped: [],
  });

  it('exits 2 when the resolver warns', async () => {
    routes[GET_PERSONAL] = () => ok(personalGet(1));
    routes['POST /v2/styles/resolve'] = () => resolved([{ code: 'low-contrast', key: '--pn-ink-3', message: '2.9:1' }]);
    const r = await tm8(['style', 'resolve', `personal:${PERSONAL}`, '--strict', '--format', 'json']);
    expect(r.code).toBe(2);
    expect(recorded.find((c) => c.path === '/v2/styles/resolve')!.body).toEqual({ doc: DOC });
  });

  it('exits 0 with --strict when there are no warnings, and 0 without --strict when there are', async () => {
    routes[GET_PERSONAL] = () => ok(personalGet(1));
    routes['POST /v2/styles/resolve'] = () => resolved([]);
    expect((await tm8(['style', 'resolve', `personal:${PERSONAL}`, '--strict', '--format', 'json'])).code).toBe(0);
    routes['POST /v2/styles/resolve'] = () => resolved([{ code: 'low-contrast', key: '--pn-ink-3', message: '2.9:1' }]);
    expect((await tm8(['style', 'resolve', `personal:${PERSONAL}`, '--format', 'json'])).code).toBe(0);
  });
});

describe('tm8 style use / default', () => {
  it('use <space-ref> --dark <builtin> --follow-os --trust-css builds the whole prefs body', async () => {
    routes['PUT /v2/identity/style-prefs'] = () => ok({ prefs: PREFS, resolved: { current: {}, dark: null } });
    const r = await tm8(['style', 'use', `space:${SPACE_STYLE}`, '--dark', 'builtin:atelier-dark', '--follow-os', '--trust-css', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    const put = recorded.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({
      currentStyle: `space:${SPACE_STYLE}`,
      darkStyle: 'builtin:atelier-dark',
      followOs: true,
      trustedCss: { add: [SPACE_STYLE] },
    });
  });

  it('--trust-css on a built-in is refused before any write', async () => {
    const r = await tm8(['style', 'use', 'builtin:atelier-dark', '--trust-css']);
    expect(r.code).toBe(2);
    expect(recorded.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('default with no ref reads spaces.styleDefault.get; with a ref it sets', async () => {
    const path = `/v2/spaces/${SPACE}/style-default`;
    routes[`GET ${path}`] = () => ok({ spaceId: SPACE, defaultStyle: 'builtin:atelier-light', setBy: null, revision: 0, updatedAt: null });
    routes[`PUT ${path}`] = (body) => ok({ spaceId: SPACE, defaultStyle: body.defaultStyle, setBy: null, revision: 1, updatedAt: null });

    const read = await tm8(['style', 'default', '--format', 'json']);
    expect(read.code, read.stderr).toBe(0);
    expect(calls()).toEqual([`GET ${path}`]);

    recorded = [];
    const write = await tm8(['style', 'default', `space:${SPACE_STYLE}`, '--format', 'json']);
    expect(write.code, write.stderr).toBe(0);
    expect(calls()).toEqual([`PUT ${path}`]);
    expect(recorded[0]!.body).toMatchObject({ defaultStyle: `space:${SPACE_STYLE}` });
  });

  it('default refuses a personal style (other members cannot see it) without writing', async () => {
    const r = await tm8(['style', 'default', `personal:${PERSONAL}`]);
    expect(r.code).toBe(2);
    expect(recorded.filter((c) => c.method === 'PUT')).toEqual([]);
  });
});
