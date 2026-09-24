/**
 * `tm8 kind list` is what the bootstrap prompt points an agent at instead of
 * inlining a kind inventory, so its output has to answer "what is this kind
 * FOR and how do I make one" on its own: grouped, one purpose line per kind,
 * the create command, custom kinds described by their fields.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { CORE_KIND_INFO, CoreEntityKindSchema } from '@tm8/contract';
import { run } from '../src/run.js';

const ROWS = [
  { kind: 'task', origin: 'core', fieldSchema: [] },
  { kind: 'message', origin: 'core', fieldSchema: [] },
  { kind: 'work_session', origin: 'core', fieldSchema: [] },
  { kind: 'c:recipe', origin: 'custom', fieldSchema: [{ name: 'servings', type: 'number' }] },
  { kind: 'mystery', origin: 'core', fieldSchema: [] },
];

let server: Server;
let stdout: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: ROWS, requestId: 'req_test' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  process.env.TM8_BASE_URL = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  stdout = [];
  process.env.TM8_SPACE_ID = 'spc_test';
  delete process.env.TM8_CONFIG_PATH;
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    stdout.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

// The first `run()` imports the whole command registry; give it room on a cold start.
describe('tm8 kind list', { timeout: 30_000 }, () => {
  it('groups kinds and gives each a purpose and the command that creates it', async () => {
    expect(await run(['kind', 'list'])).toBe(0);
    const text = stdout.join('');
    expect(text).toContain('5 entity kinds in this space (4 core, 1 custom).');
    expect(text).toMatch(/^Work\n {2}task +work with a status.*→ tm8 entity create task$/m);
    expect(text).toMatch(/^Talk\n {2}message +a post on an anchor entity.*→ tm8 message send \| tm8 message reply$/m);
    expect(text).toMatch(/^ {2}work_session +a running agent session.*→ tm8 session spawn$/m);
    expect(text).toMatch(/^Custom\n {2}c:recipe +custom kind, 1 field: servings \(number\) +→ tm8 entity create c:recipe$/m);
    expect(text).toMatch(/^Other\n {2}mystery +no description yet/m);
    expect(text).toContain('Find entities of a kind: tm8 entity query --kind <kind>.');
  });

  it('adds the same description to the json rows', async () => {
    expect(await run(['kind', 'list', '--format', 'json'])).toBe(0);
    const rows = JSON.parse(stdout.join('')) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ kind: 'task', group: 'work', createWith: ['entity create task'] });
    expect(rows[3]).toMatchObject({ kind: 'c:recipe', group: 'custom', createWith: ['entity create c:recipe'] });
  });

  it('describes every core kind the schema knows', () => {
    for (const kind of CoreEntityKindSchema.options) {
      expect(CORE_KIND_INFO[kind], kind).toBeDefined();
    }
  });
});
