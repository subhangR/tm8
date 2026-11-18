/**
 * The laptop path of the Slack setup kit over the real server: TM8_SLACK_RUNTIME=1
 * alone makes the node mint a `slack-runtime` bridge_runtime session, write its
 * token file (0600) under the data dir, and start `node --import tsx
 * src/runtime-main.ts` in the runtime's directory with TM8_SERVER_URL, the token
 * file and TM8_SLACK_STATE_DIR; that runtime's hello is answered. The WhatsApp
 * runtime's token (its own label) stays live beside it.
 *
 * The runtime here is a stub in a temp dir standing in for integrations/slack-bridge
 * (TM8_SLACK_RUNTIME_CWD), with an empty `tsx` package: node 22 strips the types
 * itself, so the exact default argv runs without the real runtime's dependencies.
 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/http/config.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

let database: W1ScratchDatabase;
let server: BootstrappedServer;
let dataDir = '';
let stubDir = '';
let outFile = '';
const saved: Record<string, string | undefined> = {};
const ENV = ['TM8_SLACK_RUNTIME', 'TM8_SLACK_RUNTIME_CWD', 'TM8_SLACK_RUNTIME_TOKEN_FILE', 'TM8_SLACK_RUNTIME_COMMAND',
  'TM8_SLACK_STATE_DIR', 'TM8_BRIDGE_RUNTIME_TOKEN_FILE', 'TM8_BRIDGE_RUNTIME_COMMAND', 'SLACK_STUB_OUT'];

const STUB = `import { readFileSync, writeFileSync } from 'node:fs';
const tokenFile: string = process.env.TM8_BRIDGE_RUNTIME_TOKEN_FILE!;
const token = readFileSync(tokenFile, 'utf8').trim();
const res = await fetch(new URL('/v2/bridge-runtime/hello', process.env.TM8_SERVER_URL), {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'slack', version: 4, runtimeId: 'slack-setup-kit', capabilities: {} }),
});
writeFileSync(process.env.SLACK_STUB_OUT!, JSON.stringify({
  status: res.status, body: await res.json().catch(() => null), cwd: process.cwd(),
  tokenFile, stateDir: process.env.TM8_SLACK_STATE_DIR, serverUrl: process.env.TM8_SERVER_URL,
}));
setInterval(() => {}, 60_000);
`;

async function until<T>(probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('slack_setup_kit');
  database.apply(migrationFiles());
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-slack-kit-'));
  stubDir = join(dataDir, 'slack-bridge');
  await mkdir(join(stubDir, 'src'), { recursive: true });
  await mkdir(join(stubDir, 'node_modules', 'tsx'), { recursive: true });
  await writeFile(join(stubDir, 'node_modules', 'tsx', 'package.json'), JSON.stringify({ name: 'tsx', type: 'module', exports: './index.js' }));
  await writeFile(join(stubDir, 'node_modules', 'tsx', 'index.js'), '');
  await writeFile(join(stubDir, 'src', 'runtime-main.ts'), STUB);
  outFile = join(dataDir, 'stub-out.json');

  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  process.env.TM8_SLACK_RUNTIME = '1';
  process.env.TM8_SLACK_RUNTIME_CWD = stubDir;
  process.env.SLACK_STUB_OUT = outFile;
  // The WhatsApp runtime's mint, with no command: both labels must stay live.
  process.env.TM8_BRIDGE_RUNTIME_TOKEN_FILE = join(dataDir, 'wa-runtime.token');

  const configured = loadConfig({
    ...process.env,
    TM8_BIND: '127.0.0.1',
    TM8_PORT: '4611',
    TM8_NODE_MODE: 'single',
    TM8_DATABASE_URL: database.url,
    TM8_DATA_DIR: dataDir,
  });
  server = await bootstrap({ config: { ...configured, port: 0, dataDir } });
});

afterAll(async () => {
  await server?.server.close();
  await server?.db?.end();
  await database?.destroy();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('TM8_SLACK_RUNTIME=1 (the laptop path of SETUP.md)', () => {
  it('starts the runtime in its directory with its token file and state dir, and its hello is answered', async () => {
    const out = await until(async () => JSON.parse(await readFile(outFile, 'utf8')) as {
      status: number; body: { connections: unknown[] }; cwd: string; tokenFile: string; stateDir: string; serverUrl: string;
    });
    expect(out.status).toBe(200);
    expect(Array.isArray(out.body.connections)).toBe(true);
    expect(out.cwd).toBe(stubDir);
    expect(out.tokenFile).toBe(join(dataDir, 'bridges', 'slack-runtime.token'));
    expect(out.stateDir).toBe(join(dataDir, 'bridges', 'slack-runtime'));
    expect(out.serverUrl).toBe(server.url);
    expect((await stat(out.tokenFile)).mode & 0o777).toBe(0o600);
  });

  it('holds one live session per label, Slack beside WhatsApp', async () => {
    const live = await database.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      const r = await c.query<{ label: string; n: string }>(
        `select label, count(*)::text as n from public.auth_sessions
          where kind = 'bridge_runtime' and revoked_at is null group by label order by label`);
      return r.rows;
    });
    expect(live).toEqual([{ label: 'slack-runtime', n: '1' }, { label: 'whatsapp-runtime', n: '1' }]);
  });
});
