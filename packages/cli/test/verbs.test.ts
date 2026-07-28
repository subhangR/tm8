/**
 * End-to-end through `run()` — the kernel's own behaviour, and the retirement
 * of the prototype's verb surface.
 *
 * This file used to assert `whoami`, `task report *` and `session report *`
 * against a stub server. Those are REJECTED VOCABULARY under the frozen
 * grammar (§1): state changes are explicit domain commands and durable
 * communication is always a message. They are not deleted quietly — an agent
 * that learned them must be told where the capability went — so what is
 * asserted here now is that each retired form FAILS with a discovery hint and
 * the right exit code, and that no retired form touches the network.
 *
 * The stub server is retained deliberately. Its status: acceptable Slot A
 * scaffolding, NOT G4 evidence. Real-Server integration is a later slot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { run, USAGE, VERSION } from '../src/run.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/manifest.sample.json', import.meta.url));

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
let stdout: string[] = [];
let stderr: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      recorded.push({
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0] ?? '',
        body: raw ? JSON.parse(raw) : undefined,
      });
      res.setHeader('content-type', 'application/json');
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
  stdout = [];
  stderr = [];
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SESSION_ID = 'ws_session';
  process.env.TM8_MANIFEST_PATH = FIXTURE;
  delete process.env.TM8_AGENT_TOKEN;
  delete process.env.TM8_CONFIG_PATH;
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    stdout.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    stderr.push(String(c));
    return true;
  });
});

describe('rejected vocabulary fails with a discovery hint (conformance D6)', () => {
  const cases: { argv: string[]; expect: RegExp }[] = [
    { argv: ['whoami'], expect: /identity get/ },
    { argv: ['task', 'report', 'progress', 'ent_1', 'made progress'], expect: /task transition/ },
    { argv: ['task', 'report', 'complete', 'ent_1', 'all done'], expect: /task complete/ },
    { argv: ['task', 'report', 'blocked', 'ent_1', 'waiting'], expect: /message send/ },
    { argv: ['session', 'report', 'progress', 'status text'], expect: /message send/ },
    { argv: ['session', 'report', 'complete', 'finished'], expect: /message send/ },
    { argv: ['session', 'prompt', 'ws_1', 'do the thing'], expect: /message send --to <work-session-id>/ },
    { argv: ['progress', 'ent_1', 'hi'], expect: /message send/ },
  ];

  for (const { argv, expect: pattern } of cases) {
    it(`\`tm8 ${argv.join(' ')}\` → exit 2, names its replacement, sends nothing`, async () => {
      expect(await run(argv)).toBe(2);
      const diagnostics = stderr.join('');
      expect(diagnostics).toMatch(/no longer exists/);
      expect(diagnostics).toMatch(pattern);
      expect(diagnostics).toContain('tm8 help');
      // A refusal is a diagnostic: nothing on stdout, nothing on the wire.
      expect(stdout).toEqual([]);
      expect(recorded).toHaveLength(0);
    });
  }

  it('the retired --json flag fails rather than silently aliasing to --format json', async () => {
    expect(await run(['--json', 'worker', 'init'])).toBe(2);
    expect(stderr.join('')).toContain('--format json');
    expect(stdout).toEqual([]);
  });
});

describe('the kernel router', () => {
  it('an unknown command is exit 2 with a pointer at help, and never touches the network', async () => {
    expect(await run(['nonsense'])).toBe(2);
    expect(await run(['entity', 'yeet', 'ent_1'])).toBe(2);
    expect(stderr.join('')).toContain('tm8 help');
    expect(recorded).toHaveLength(0);
  });

  it('a bare invocation is exit 2 with usage on STDERR', async () => {
    expect(await run([])).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('tm8 <noun>');
  });

  it('`help` and `--help` are exit 0 with usage on STDOUT — help is requested data', async () => {
    expect(await run(['help'])).toBe(0);
    expect(stdout.join('')).toContain('tm8 <noun>');
    stdout = [];
    expect(await run(['--help'])).toBe(0);
    expect(stdout.join('')).toContain('tm8 <noun>');
  });

  it('usage prints the frozen exit table, so an operator can decode a $? they saw', async () => {
    expect(USAGE).toContain('  3  unauthenticated');
    expect(USAGE).toContain('  4  forbidden');
    expect(USAGE).toContain('130  interrupted');
  });

  it('--version prints the version', async () => {
    expect(await run(['--version'])).toBe(0);
    expect(stdout.join('')).toBe(`${VERSION}\n`);
  });

  it('a malformed global option fails before dispatch', async () => {
    expect(await run(['--format', 'yaml', 'worker', 'init'])).toBe(2);
    expect(stderr.join('')).toContain('--format expects human|json|jsonl');
  });
});

describe('worker init — the harness bootstrap, carried on the new output layer', () => {
  it('boots with no Server at all: booting must not need the network', async () => {
    process.env.TM8_BASE_URL = 'http://127.0.0.1:1';
    expect(await run(['worker', 'init'])).toBe(0);
    expect(recorded).toHaveLength(0);
    expect(stdout.join('')).toContain('Phoenix');
  });

  it('--format json emits the composed envelope as the exact DTO', async () => {
    expect(await run(['worker', 'init', '--format', 'json'])).toBe(0);
    const parsed = JSON.parse(stdout.join('')) as { system: string; task: string };
    expect(typeof parsed.system).toBe('string');
    expect(typeof parsed.task).toBe('string');
    expect(stderr).toEqual([]);
  });

  it('no manifest is a usage error naming the env var', async () => {
    delete process.env.TM8_MANIFEST_PATH;
    expect(await run(['worker', 'init'])).toBe(2);
    expect(stderr.join('')).toContain('TM8_MANIFEST_PATH');
  });
});
