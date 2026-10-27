/**
 * L3 — `tm8 entity ref add|list|remove` (cross-space references, 279).
 *
 * Drives the real `run()` against a loopback stub that records every request.
 * `--link` resolves through the home Space's links to the link id; the global
 * `--space` is refused for `entity ref add`, because it would run the whole
 * command inside the linked Space. Each refusal is paired with a positive.
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

const HOME = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const ENTITY = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const REF = '88888888-8888-4888-8888-888888888888';

const VIEW = {
  id: LINK, homeSpaceId: HOME, targetSpaceId: TARGET, targetServerId: null, targetSpaceName: 'Space B',
  createdAt: '2026-10-02T08:00:00.000Z', statusSummary: { signedIn: 1, signedOut: 0, left: 0, unreachable: 0 },
  mine: {
    memberId: '44444444-4444-4444-8444-444444444444', status: 'signed_in', allowSpawn: false, spawnBudget: 0,
    alias: 'bee', sessionId: null, expiresAt: null, lastUsedAt: null,
  },
};
const REF_ROW = {
  id: REF, spaceId: HOME, entityId: ENTITY, linkId: LINK, targetSpaceId: TARGET, targetServerId: null,
  targetEntityId: OTHER, kind: 'doc', titleSnapshot: 'Spec in B', live: null,
  createdBy: '44444444-4444-4444-8444-444444444444', createdAt: '2026-10-02T08:00:00.000Z', updatedAt: '2026-10-02T08:00:00.000Z',
};

interface Recorded { method: string; path: string; body: Record<string, unknown> }
let recorded: Recorded[] = [];
let server: Server;
let baseUrl: string;
let configDir: string;

const ok = (data: unknown) => ({ status: 200, body: { data, requestId: 'req_t' } });
const routes: Record<string, () => { status: number; body: unknown }> = {
  [`GET /v2/spaces/${HOME}/space-links`]: () => ok([VIEW]),
  [`POST /v2/entities/${ENTITY}/refs`]: () => ok(REF_ROW),
  [`GET /v2/entities/${ENTITY}/refs`]: () => ok([{ ...REF_ROW, live: { kind: 'doc', title: 'Spec in B v2', updatedAt: REF_ROW.updatedAt } }]),
  [`DELETE /v2/entities/${ENTITY}/refs/${REF}`]: () => ok({ id: REF, entityId: ENTITY, removed: true }),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const raw = Buffer.concat(chunks).toString('utf8');
      recorded.push({ method: req.method ?? '', path: url.pathname, body: raw === '' ? {} : JSON.parse(raw) });
      const route = routes[`${req.method} ${url.pathname}`];
      const reply = route ? route() : { status: 404, body: { error: { code: 'not_found', message: 'no route', requestId: 'r', retryable: false } } };
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
  configDir = mkdtempSync(join(tmpdir(), 'tm8-entity-ref-'));
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = HOME;
  process.env.TM8_SESSION_ID = '77777777-7777-4777-8777-777777777777';
  process.env.TM8_JOURNAL_CLASS = 'human';
  recorded = [];
  ledger.clear();
});

afterEach(() => {
  for (const k of SAVED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(configDir, { recursive: true, force: true });
  ledger.clear();
});

const paths = () => recorded.map((r) => `${r.method} ${r.path}`);

describe('tm8 entity ref', () => {
  it('add resolves --link by alias to the link id and posts one entities.refs.add on home', async () => {
    const r = await tm8(['entity', 'ref', 'add', ENTITY, OTHER, '--link', 'bee', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual([`GET /v2/spaces/${HOME}/space-links`, `POST /v2/entities/${ENTITY}/refs`]);
    expect(recorded[1]!.body).toMatchObject({ link: LINK, targetEntityId: OTHER });
    expect(JSON.parse(r.stdout)).toMatchObject({ id: REF, titleSnapshot: 'Spec in B' });
  });

  it('add without --link is a usage error and sends nothing', async () => {
    const r = await tm8(['entity', 'ref', 'add', ENTITY, OTHER]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/--link/);
    expect(paths()).toEqual([]);
  });

  it('add with the global --space is refused before any request, with the --link hint', async () => {
    const r = await tm8(['--space', 'bee', 'entity', 'ref', 'add', ENTITY, OTHER]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/--link bee/);
    expect(paths()).toEqual([]);
  });

  it('list renders the live title when the server resolved one', async () => {
    const r = await tm8(['entity', 'ref', 'list', ENTITY]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Spec in B v2');
    expect(r.stdout).toContain('(live)');
  });

  it('remove sends DELETE on the ref', async () => {
    const r = await tm8(['entity', 'ref', 'remove', ENTITY, REF]);
    expect(r.code, r.stderr).toBe(0);
    expect(paths()).toEqual([`DELETE /v2/entities/${ENTITY}/refs/${REF}`]);
  });
});
