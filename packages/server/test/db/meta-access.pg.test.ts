/**
 * `meta.get` (GET /v2/meta, TM8 Mobile S2): the chosen access, over the REAL
 * identity resolver and the production composition root, on a scratch
 * database. The node boots with the loopback auto-owner arm off
 * (TM8_DISABLE_AUTO_OWNER=1), so a request with no credential is a stranger,
 * and under TM8_SPACE_SESSIONS=enforce, the strictest gate.
 *
 * The decision under test: the route is UNAUTHENTICATED. A client reads it
 * while it adds a server, before it has sent a password, to learn whether this
 * node serves its version; refusing strangers would move that check behind the
 * password it exists to stop. The answer holds only build facts. Two limits are
 * proved alongside it: a gate session reads it too (enforce admits it), and a
 * credential that is sent must still be valid (no silent downgrade).
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONTRACT_VERSION, MetaGetResultSchema, OPERATIONS, RESERVED_OPERATIONS } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/http/config.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

// One scratch database and every migration: well past vitest's 10s hook default.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let database: W1ScratchDatabase | undefined;
let node: BootstrappedServer | undefined;
let dataDir: string | undefined;

beforeAll(async () => {
  database = await createW1ScratchDatabase('meta_access');
  database.apply(migrationFiles());
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-meta-'));
  const configured = loadConfig({
    ...process.env,
    TM8_BIND: '127.0.0.1',
    TM8_PORT: '4610',
    TM8_NODE_MODE: 'single',
    TM8_DATABASE_URL: database.url,
    TM8_DATA_DIR: dataDir,
    TM8_DISABLE_AUTO_OWNER: '1',
    TM8_SPACE_SESSIONS: 'enforce',
  });
  node = await bootstrap({ config: { ...configured, port: 0 } });
});

afterAll(async () => {
  await node?.server.close();
  await node?.db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(new URL(path, node!.url), { headers });
  return { status: res.status, body: await res.json() as { data?: unknown; error?: { code: string; message: string } } };
}

describe('GET /v2/meta on a node with no auto-owner, under enforce', () => {
  it('answers a caller with NO credential: 200, the full answer, parsed by the contract schema', async () => {
    const res = await get('/v2/meta');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const meta = MetaGetResultSchema.parse(res.body.data);
    expect(meta.contractVersion).toBe(CONTRACT_VERSION);
    expect(meta.catalogSha256).toBe(createHash('sha256').update(JSON.stringify(OPERATIONS)).digest('hex'));
    expect(meta.minClients).toEqual({});
  });

  it('features are exactly the v1 rows the production composition mounted, never a reserved one', async () => {
    const meta = MetaGetResultSchema.parse((await get('/v2/meta')).body.data);
    const registry = node!.server.registry;
    expect(meta.features).toEqual(
      OPERATIONS.filter((op) => op.status === 'v1' && (op.method === 'WS' || registry.has(op.name))).map((op) => op.name),
    );
    expect(meta.features).toEqual(expect.arrayContaining(['meta.get', 'auth.login', 'identity.get', 'events.subscribe']));
    for (const op of RESERVED_OPERATIONS) expect(meta.features).not.toContain(op.name);
  });

  it('the same stranger is refused a signed-in read: the node really has no auto-owner', async () => {
    const res = await get('/v2/identity');
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthenticated');
  });

  it('a gate session (signed in, no space) reads it under enforce, and is refused a space read', async () => {
    // Claim the node with the token boot printed: that mints a cli session with
    // no space, which is exactly a gate session.
    const token = (await readFile(join(dataDir!, 'setup-token'), 'utf8')).trim();
    const claim = await fetch(new URL('/v2/auth/claim', node!.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, username: 'amber', password: 'a-real-password-8+', kind: 'cli' }),
    });
    expect(claim.status).toBe(200);
    const bearer = { authorization: `Bearer ${((await claim.json()) as { data: { token: string } }).data.token}` };

    const meta = await get('/v2/meta', bearer);
    expect(meta.status, JSON.stringify(meta.body)).toBe(200);
    expect(MetaGetResultSchema.parse(meta.body.data).features).toContain('meta.get');

    const space = await get('/v2/spaces/019f9896-928d-79b6-ba1c-1cdcc1d30a6f', bearer);
    expect(space.status).toBe(403);
    expect(space.body.error?.message).toMatch(/auth\.space\.enter/);
  });

  it('a credential that is sent must be valid: a dead token is refused, not downgraded to anonymous', async () => {
    const res = await get('/v2/meta', { authorization: 'Bearer tm8s_not-a-real-session' });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthenticated');
  });
});
