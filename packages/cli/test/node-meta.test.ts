/**
 * `tm8 node meta` — `meta.get` (GET /v2/meta, TM8 Mobile S2).
 *
 * Drives the real `run()` against a loopback stub that records every request,
 * so each cell asserts the exact route the command sent and what it printed.
 * The stub's digest is either this CLI's own catalog digest or another one, so
 * the human line that compares them is checked both ways.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { MetaGetResult } from '@tm8/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/run.js';
import { ledger } from '../src/discovery/availability.js';
import { CATALOG_DIGEST } from '../src/discovery/operations.js';

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

const OWN_HEX = CATALOG_DIGEST.replace(/^sha256:/, '');
const OTHER_HEX = 'b'.repeat(64);
const META: MetaGetResult = {
  contractVersion: '0.1.0',
  catalogSha256: OWN_HEX,
  eventSchemaVersion: 1,
  features: ['meta.get', 'identity.get', 'events.subscribe'],
  minClients: {},
};

interface Recorded { method: string; path: string; headers: IncomingHttpHeaders }
let recorded: Recorded[] = [];
let answer: MetaGetResult = META;

let server: Server;
let baseUrl: string;
let configDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      recorded.push({ method: req.method ?? '', path: url.pathname, headers: req.headers });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && url.pathname === '/v2/meta') {
        res.statusCode = 200;
        res.end(JSON.stringify({ data: answer, requestId: 'req_t' }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'no such route in the stub', requestId: 'req_t', retryable: false } }));
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
  configDir = mkdtempSync(join(tmpdir(), 'tm8-node-meta-'));
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_JOURNAL_CLASS = 'human';
  recorded = [];
  answer = META;
  ledger.clear();
});

afterEach(() => {
  for (const k of SAVED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(configDir, { recursive: true, force: true });
  ledger.clear();
});

describe('tm8 node meta', () => {
  it('reads GET /v2/meta, with no credential when the CLI holds none', async () => {
    const r = await tm8(['node', 'meta', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(recorded.map((q) => `${q.method} ${q.path}`)).toEqual(['GET /v2/meta']);
    expect(recorded[0]!.headers.authorization).toBeUndefined();
    expect(r.stdout).toContain('contract: 0.1.0');
    expect(r.stdout).toContain(`catalog: ${CATALOG_DIGEST} (the catalog this CLI was built from)`);
    expect(r.stdout).toContain('event schema: 1');
    expect(r.stdout).toContain('features: 3 operations mounted (--format json lists them)');
    expect(r.stdout).toContain('minimum clients: none');
  });

  it('says when the Server was built from another catalog, and names both digests', async () => {
    answer = { ...META, catalogSha256: OTHER_HEX };
    const r = await tm8(['node', 'meta', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`catalog: sha256:${OTHER_HEX} (this CLI was built from ${CATALOG_DIGEST})`);
  });

  it('lists each client minimum the Server names', async () => {
    answer = { ...META, minClients: { 'tm8-mobile': '1.2.0', 'tm8-ui': '0.3.0' } };
    const r = await tm8(['node', 'meta', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('minimum clients: tm8-mobile 1.2.0, tm8-ui 0.3.0');
  });

  it('--format json carries the whole answer, the feature list included', async () => {
    const r = await tm8(['node', 'meta', '--format', 'json']);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(META);
  });

  it('refuses arguments and unknown options without calling the Server', async () => {
    const extra = await tm8(['node', 'meta', 'acme-node']);
    expect(extra.code).toBe(2);
    expect(extra.stderr).toContain('usage: tm8 node meta');
    const option = await tm8(['node', 'meta', '--features']);
    expect(option.code).toBe(2);
    expect(recorded).toEqual([]);
  });
});

describe('tm8 help finds it', () => {
  it('help node meta names the syntax, the operation and the anonymous access', async () => {
    const r = await tm8(['help', 'node', 'meta', '--format', 'human']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('syntax\n  tm8 node meta\n');
    expect(r.stdout).toContain('operations\n  meta.get\n');
    expect(r.stdout).toContain('answers without any credential, on purpose');
    expect(r.stdout).toContain('an expired or revoked token is refused');
  });

  for (const query of ['contract version', 'server features and minimum client version', 'catalog digest']) {
    it(`help --query "${query}" ranks node meta`, async () => {
      const r = await tm8(['help', '--query', query, '--format', 'json']);
      expect(r.code, r.stderr).toBe(0);
      const dto = JSON.parse(r.stdout) as { matches: { command: string }[] };
      expect(dto.matches.map((m) => m.command), query).toContain('node meta');
    });
  }
});
