/**
 * Task 01a1876f-cb04: on the desktop profile a tool run is recorded under the
 * desktop node id, and the next launch reconciles what the last one left.
 *
 * The desktop app listens on an ephemeral port, so `<host>:<port>` changes on
 * every launch. The execution runtime has always used `desktopNodeId(dataDir)`
 * there. ToolRuntime used `<host>:<port>`, and `ToolRuntime.reconcile` only
 * retires its own node's rows, so a tool run left `running` by a launch that died
 * was never retired by the next one: it kept its cap slot and its token.
 *
 * Two launches of the production composition, on two different ports, over one
 * data directory and one database, exactly as two desktop launches are.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { desktopNodeId } from '../../src/desktop.js';
import { loadConfig } from '../../src/http/config.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { createTestDb, type TestDb } from '../events/pg-harness.js';
import { claimsFor, ownerOfSpace } from '../events/ws-e2e-harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

let database: W1ScratchDatabase;
let rpcDb: TestDb;
let dataDir: string;
const servers: BootstrappedServer[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('no free port');
  return address.port;
}

/** One desktop launch: TM8_DESKTOP=1, its own port, the shared data dir and database. */
async function launch(): Promise<BootstrappedServer> {
  const prior = { desktop: process.env['TM8_DESKTOP'], delivery: process.env['TM8_DELIVERY_DATABASE_URL'] };
  process.env['TM8_DESKTOP'] = '1';
  delete process.env['TM8_DELIVERY_DATABASE_URL'];
  try {
    const config = loadConfig({
      ...process.env,
      TM8_BIND: '127.0.0.1',
      TM8_PORT: String(await freePort()),
      TM8_DATABASE_URL: database.url,
      TM8_DATA_DIR: dataDir,
      TM8_AGENT_CMD: 'echo-agent',
    });
    const server = await bootstrap({ config });
    servers.push(server);
    return server;
  } finally {
    for (const [key, value] of [['TM8_DESKTOP', prior.desktop], ['TM8_DELIVERY_DATABASE_URL', prior.delivery]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function stop(server: BootstrappedServer): Promise<void> {
  servers.splice(servers.indexOf(server), 1);
  await server.server.close();
  await server.delivery?.close();
  await server.db?.end();
}

async function call<T>(server: BootstrappedServer, method: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(new URL(path, server.url), {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientMutationId: randomUUID(), ...body }),
  });
  const parsed = (await response.json()) as { data?: T; error?: { code: string; message: string } };
  return { status: response.status, data: parsed.data, error: parsed.error };
}

async function sessionRow(id: string) {
  const [row] = await database.query<{ node_id: string; tool_state: string }>(
    'select node_id, tool_state from public.work_sessions where entity_id = $1', [id]);
  return row!;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('desktop_node_id');
  database.apply(migrationFiles());
  rpcDb = createTestDb(database.url);
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-desktop-node-id-'));
});

afterAll(async () => {
  for (const server of [...servers]) await stop(server);
  await rpcDb?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

it('records a desktop tool run under desktopNodeId, and the next launch on another port reconciles it', async () => {
  const first = await launch();
  const space = await call<{ space: { id: string } }>(first, 'POST', '/v2/spaces', { name: 'Desktop node id' });
  expect(space.status, JSON.stringify(space.error)).toBe(201);
  const spaceId = space.data!.space.id;
  const tool = await call<{ id: string; version: number }>(first, 'POST', `/v2/spaces/${spaceId}/tools`, {
    definition: { name: 'desktop-node-id', description: 'Desktop node id fixture', help: 'Usage', runtime: 'bash',
      source: 'printf ok', tm8Access: 'none', timeoutSeconds: 30, inputs: [] },
  });
  expect(tool.status, JSON.stringify(tool.error)).toBe(200);

  // A run on the first launch is recorded under the desktop node id, not the
  // launch's own <host>:<port>.
  const run = await call<{ sessionId: string }>(first, 'POST', `/v2/tools/${tool.data!.id}/run`, {
    expectedVersion: tool.data!.version, inputs: {}, keepOpen: false,
  });
  expect(run.status, JSON.stringify(run.error)).toBe(200);
  await vi.waitFor(async () => expect((await sessionRow(run.data!.sessionId)).tool_state).toBe('exited'), { timeout: 15_000 });
  const recorded = (await sessionRow(run.data!.sessionId)).node_id;
  expect(recorded).toBe(desktopNodeId(dataDir));
  expect(recorded).not.toMatch(/^127\.0\.0\.1:/);

  // What a launch that dies mid-run leaves behind: a tool session still marked
  // running under the node id that launch records, with no process anywhere.
  // A second one belongs to another node and must be left alone.
  const owner = await ownerOfSpace(database, spaceId);
  const leftover = async (nodeId: string) => (await rpcDb.rpc<{ entity: { id: string } }>(claimsFor(owner.identityId),
    'public.start_tool_session', [spaceId, tool.data!.id, tool.data!.version, {}, false, nodeId, dataDir, 8, null,
      `cmid_${randomUUID()}`])).entity.id;
  const orphan = await leftover(recorded);
  const elsewhere = await leftover('tm8-desktop:another-install');
  expect((await sessionRow(orphan)).tool_state).toBe('running');
  await stop(first);

  // The relaunch listens on a different port, so <host>:<port> differs. Its
  // startup reconcile, which bootstrap awaits, must still retire the orphan.
  await launch();
  expect(await sessionRow(orphan)).toEqual({ node_id: desktopNodeId(dataDir), tool_state: 'killed' });
  expect((await sessionRow(elsewhere)).tool_state).toBe('running');
});
