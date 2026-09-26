/**
 * Migration 250 — the session host registry (task 01a0db31, design doc
 * 01a0db5e R5), through the adapter the server boots with.
 *
 * The table holds each host's controller token, which drives every agent that
 * host keeps alive: tm8_app must not read it, and only a node admin reaches it
 * through the RPCs. Rows are scoped per node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import { createDbSessionHostRegistry } from '../../src/facade/session-host-registry.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const ADMIN = 'session-hosts-admin';
const MEMBER = 'session-hosts-member';
const DATA_DIR = '/var/lib/tm8-test';
const TOKEN = 'x'.repeat(43);

let database: W1ScratchDatabase;
let db: PgDb;

beforeAll(async () => {
  database = await createW1ScratchDatabase('session_hosts');
  database.apply(migrationFiles());
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(
      `insert into public.accounts(identity_id, username, is_node_admin, is_owner)
       values ($1, 'sh-admin', true, false), ($2, 'sh-member', false, false)`,
      [ADMIN, MEMBER],
    );
  });
  db = new PgDb({ databaseUrl: database.url });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

const registry = (identityId: string, nodeId = 'node-a') =>
  createDbSessionHostRegistry({ db, claims: { identityId, nodeAdmin: true }, nodeId, dataDir: DATA_DIR });

describe('session_hosts registry', () => {
  it('round-trips a node admin\'s rows, scoped to its node', async () => {
    const a = registry(ADMIN);
    const b = registry(ADMIN, 'node-b');
    await a.insert({ generation: 'abc123', socketPath: `${DATA_DIR}/session-host/abc123.sock`, token: TOKEN, pid: 4242 });
    await a.setPid('abc123', 4343);
    expect(await a.list()).toEqual([
      { generation: 'abc123', socketPath: `${DATA_DIR}/session-host/abc123.sock`, token: TOKEN, pid: 4343 },
    ]);
    expect(await b.list()).toEqual([]);
    // ownerOf answers across nodes: another node's socket in this data dir is not ours to take.
    expect(await b.ownerOf('abc123')).toBe('node-a');
    expect(await a.ownerOf('nope')).toBeNull();
    await a.remove('abc123');
    expect(await a.list()).toEqual([]);
  });

  it('refuses a caller who is not a node admin', async () => {
    await expect(registry(MEMBER).list()).rejects.toThrow(/node admin required/);
  });

  it('refuses a malformed row rather than storing it', async () => {
    await expect(
      registry(ADMIN).insert({ generation: 'Bad Gen', socketPath: '/tmp/x.sock', token: TOKEN, pid: 1 }),
    ).rejects.toThrow();
    await expect(
      registry(ADMIN).insert({ generation: 'ok', socketPath: 'relative.sock', token: TOKEN, pid: 1 }),
    ).rejects.toThrow();
  });

  it('keeps the token table unreadable to tm8_app', async () => {
    await expect(
      database.transaction(async (c) => {
        await c.query('set local role tm8_app');
        await c.query('select token from internal.session_hosts');
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
