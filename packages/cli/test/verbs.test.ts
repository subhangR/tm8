/**
 * End-to-end verb tests against a stub server that speaks the wire envelope.
 *
 * Why a stub rather than the real frame: the real frame answers 501 for every
 * operation until the facade handlers land, and `messages.post` is the FIRST
 * call every report verb makes — so against a live 501 server the complete /
 * work / read-version bindings are never reached and would ship unexercised.
 * The stub asserts the exact (method, path, body) each verb puts on the wire,
 * which is the thing that has to match the catalog.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { run } from '../src/run.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/manifest.sample.json', import.meta.url));

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
/** Per-path responses; default is a 200 envelope with `{}`. */
let responses: Record<string, { status: number; body: unknown }> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '').split('?')[0] ?? '';
      recorded.push({
        method: req.method ?? '',
        path,
        body: raw ? JSON.parse(raw) : undefined,
      });
      const canned = responses[`${req.method} ${path}`];
      res.setHeader('content-type', 'application/json');
      if (canned) {
        res.statusCode = canned.status;
        res.end(JSON.stringify(canned.body));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ data: { ok: true }, requestId: 'req_test' }));
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

beforeEach(() => {
  recorded = [];
  responses = {};
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SESSION_ID = 'ws_session';
  process.env.TM8_MANIFEST_PATH = FIXTURE;
  delete process.env.TM8_AGENT_TOKEN;
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

describe('catalog binding — the paths the verbs actually put on the wire', () => {
  it('task report progress → POST /v2/messages anchored to the task', async () => {
    const code = await run(['task', 'report', 'progress', 'ent_1', 'made progress']);
    expect(code).toBe(0);
    expect(recorded).toEqual([
      { method: 'POST', path: '/v2/messages', body: { anchorId: 'ent_1', body: 'made progress' } },
    ]);
  });

  it('task report complete → message, then read version, then the closed complete binding', async () => {
    responses['GET /v2/entities/ent_1'] = {
      status: 200,
      body: { data: { id: 'ent_1', version: 7 }, requestId: 'req_test' },
    };
    const code = await run(['task', 'report', 'complete', 'ent_1', 'all done']);
    expect(code).toBe(0);
    expect(recorded.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v2/messages',
      'GET /v2/entities/ent_1',
      'POST /v2/entities/ent_1/commands/complete',
    ]);
    expect(recorded[0]?.body).toEqual({ anchorId: 'ent_1', body: '**Complete** — all done' });
    // completerIds default to the manifest's own team_member — the session
    // doing the work is the completer.
    expect(recorded[2]?.body).toEqual({ expectedVersion: 7, completerIds: ['tm_01HZPHOENIX'] });
  });

  it('--expected-version skips the read entirely', async () => {
    const code = await run(['task', 'report', 'complete', 'ent_1', 'done', '--expected-version', '3']);
    expect(code).toBe(0);
    expect(recorded.map((r) => r.path)).toEqual(['/v2/messages', '/v2/entities/ent_1/commands/complete']);
    expect(recorded[1]?.body).toMatchObject({ expectedVersion: 3 });
  });

  it('--as overrides who gets credit', async () => {
    await run(['task', 'report', 'complete', 'ent_1', 'done', '--expected-version', '1', '--as', 'tm_a,tm_b']);
    expect(recorded[1]?.body).toMatchObject({ completerIds: ['tm_a', 'tm_b'] });
  });

  it('task report blocked → message, then commands/work with status blocked', async () => {
    const code = await run(['task', 'report', 'blocked', 'ent_1', 'waiting on Deneb']);
    expect(code).toBe(0);
    expect(recorded.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v2/messages',
      'POST /v2/entities/ent_1/commands/work',
    ]);
    expect(recorded[1]?.body).toEqual({ status: 'blocked', note: 'waiting on Deneb' });
  });

  it('session report anchors to the session, never to a task', async () => {
    for (const kind of ['progress', 'complete', 'blocked']) {
      recorded = [];
      const code = await run(['session', 'report', kind, 'status text']);
      expect(code).toBe(0);
      expect(recorded[0]?.path).toBe('/v2/messages');
      expect(recorded[0]?.body).toMatchObject({ anchorId: 'ws_session' });
    }
  });

  it('session report never writes work_session status — R29 single writer', async () => {
    await run(['session', 'report', 'complete', 'finished']);
    expect(recorded.every((r) => !r.path.includes('/commands/'))).toBe(true);
  });

  it('whoami → GET /v2/identity', async () => {
    const code = await run(['whoami']);
    expect(code).toBe(0);
    expect(recorded).toEqual([{ method: 'GET', path: '/v2/identity', body: undefined }]);
  });

  it('sends a bearer only when TM8_AGENT_TOKEN is set', async () => {
    let auth: string | undefined;
    const probe = createServer((req, res) => {
      auth = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: {}, requestId: 'r' }));
    });
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const addr = probe.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no address');
    process.env.TM8_BASE_URL = `http://127.0.0.1:${addr.port}`;

    await run(['whoami']);
    expect(auth).toBeUndefined();

    process.env.TM8_AGENT_TOKEN = 'tok_123';
    await run(['whoami']);
    expect(auth).toBe('Bearer tok_123');

    await new Promise<void>((res, rej) => probe.close((e) => (e ? rej(e) : res())));
  });
});

describe('exit codes — the agent must tell refusal from absence', () => {
  it('501 not_implemented is UNAVAILABLE (4), not a refusal', async () => {
    responses['POST /v2/messages'] = {
      status: 501,
      body: {
        error: {
          code: 'not_implemented',
          message: 'operation messages.post is not implemented on this node',
          requestId: 'req_1',
          retryable: false,
        },
      },
    };
    expect(await run(['task', 'report', 'progress', 'ent_1', 'hi'])).toBe(4);
  });

  it('a contract error the server chose to return is REFUSED (3)', async () => {
    responses['POST /v2/messages'] = {
      status: 409,
      body: {
        error: { code: 'version_conflict', message: 'stale version', requestId: 'req_2', retryable: false },
      },
    };
    expect(await run(['task', 'report', 'progress', 'ent_1', 'hi'])).toBe(3);
  });

  it('an unreachable server is UNAVAILABLE (4)', async () => {
    process.env.TM8_BASE_URL = 'http://127.0.0.1:1';
    expect(await run(['whoami'])).toBe(4);
  });

  it('a 200 without the DEV-6 envelope is UNAVAILABLE (4), not a silent success', async () => {
    responses['GET /v2/identity'] = { status: 200, body: { whoops: true } };
    expect(await run(['whoami'])).toBe(4);
  });

  it('bad usage is 2, and never touches the network', async () => {
    expect(await run(['task', 'report', 'progress'])).toBe(2);
    expect(await run(['task', 'report', 'sideways', 'ent_1', 'x'])).toBe(2);
    expect(await run(['session', 'report', 'progress'])).toBe(2);
    expect(await run(['nonsense'])).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('session report without a session is a usage error, not a request to nowhere', async () => {
    delete process.env.TM8_SESSION_ID;
    process.env.TM8_MANIFEST_PATH = '/nonexistent/manifest.json';
    expect(await run(['session', 'report', 'progress', 'hello'])).toBe(2);
    expect(recorded).toHaveLength(0);
  });

  it('worker init with no manifest is a usage error naming the env var', async () => {
    delete process.env.TM8_MANIFEST_PATH;
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });
    expect(await run(['worker', 'init'])).toBe(2);
    expect(stderr.join('')).toContain('TM8_MANIFEST_PATH');
  });

  it('worker init succeeds with no server at all — booting must not need the network', async () => {
    process.env.TM8_BASE_URL = 'http://127.0.0.1:1';
    expect(await run(['worker', 'init'])).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it('--help is 0, a bare invocation is 2', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(await run([])).toBe(2);
  });
});
