/**
 * Migration 344: the server-key guard under CONCURRENCY, and `tm8` as a key.
 *
 * Migration 340 enforces one effective server key per Space with a TRIGGER
 * rather than a unique index (it cannot be an index: the key must be unique
 * among LIVE connectors only, and an index cannot read `entities.deleted_at`).
 * Its check was a plain `exists` read with no lock, so two admins registering
 * the same key at once each read a snapshot in which the other's row does not
 * exist, and both commit. 344 takes `pg_advisory_xact_lock` over the Space
 * first.
 *
 * WHAT THE RACE ACTUALLY NEEDS, and why these names: two connectors whose
 * DEFINITION NAMES DIFFER but whose effective keys match — `my-api` and
 * `my_api`. A pair that shares a name (`Gmail` / `gmail`) proves nothing here,
 * because `mcp_servers.title` is `lower(name)` under a `(space_id, title)`
 * unique constraint, so Postgres already serialises that pair whatever the
 * trigger does. The key is `internal.mcp_effective_server_key`, which no index
 * covers, and these two are exactly the pair 340 admits as pre-existing data.
 *
 * WHY THESE TESTS DRIVE CONNECTIONS BY HAND rather than racing two
 * `Promise.all` writes: a race passes by accident whenever the two transactions
 * happen not to overlap. Here the second writer is OBSERVED blocked while the
 * first is still uncommitted, so overlap is a fact of the test, not a hope.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 180000, hookTimeout: 300000 });

let scratch: W1ScratchDatabase;
const spaceId = randomUUID(), otherSpaceId = randomUUID(), adminMember = randomUUID();
const adminIdentity = 'mcp-key-lock-admin-' + randomUUID();

const definition = (name: string) => JSON.stringify({
  name, transport: 'http', url: 'https://example.test/mcp',
  envKeys: [], headerKeys: [], auth: { type: 'none' }, approved: true,
});

/** `Db.tx`'s claim binding, by hand: this suite must hold transactions open. */
async function open(claims = true): Promise<PoolClient> {
  const client = await scratch.pool.connect();
  await client.query('begin');
  await client.query(claims
    ? `select set_config('tm8.identity_id',$1,true), set_config('tm8.request_id',$2,true),
        set_config('tm8.auth_kind','browser',true), set_config('tm8.api_scope','write',true),
        set_config('role','tm8_app',true)`
    : `select set_config('role','tm8_app',true), $1::text, $2::text`,
  [adminIdentity, randomUUID()]);
  return client;
}

interface Created { id: string; version: number }

async function createConnector(client: PoolClient, name: string): Promise<Created> {
  const { rows } = await client.query<{ create_mcp_server_entity: { entity: Created } }>(
    'select * from public.create_mcp_server_entity($1,$2,$3,$4)',
    [spaceId, definition(name), null, randomUUID()]);
  return rows[0]!.create_mcp_server_entity.entity;
}

const renameConnector = (client: PoolClient, target: Created, name: string) =>
  client.query('select * from public.update_mcp_server_entity($1,$2,$3,$4,$5)',
    [target.id, target.version, definition(name), null, randomUUID()]);

const backendPid = async (client: PoolClient): Promise<number> =>
  (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;

/** Wait until `pid` is blocked on `event` — the overlap this suite asserts on. */
async function waitForLock(pid: number, event: 'advisory' | null): Promise<void> {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const [row] = await scratch.query<{ type: string | null; event: string | null }>(
      `select wait_event_type as type, wait_event as event from pg_stat_activity where pid=$1`, [pid]);
    if (row?.type === 'Lock' && (event === null || row.event === event)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`pid ${pid} never blocked on ${event ?? 'a lock'}`);
}

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('mcp_server_key_lock');
  scratch.apply(migrationFiles());
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [adminIdentity]);
    await c.query('insert into public.accounts(identity_id,username,display_name,is_node_admin,is_owner) values($1,$1,$1,false,false)', [adminIdentity]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'MCP key lock',$2),($3,'Other',$2)",
      [spaceId, adminIdentity, otherSpaceId]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [adminMember, spaceId]);
    await c.query('insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,$4,$3)',
      [adminMember, spaceId, adminIdentity, 'owner']);
  });
});

afterAll(async () => { await scratch?.destroy(); });

it('holds a per-Space lock to commit, so a second key check waits instead of reading a stale snapshot', async () => {
  const holder = await open(false), waiter = await open(false), elsewhere = await open(false);
  const pid = await backendPid(waiter);
  try {
    await holder.query('select internal.assert_mcp_server_key_free($1,$2,$3::jsonb)',
      [spaceId, randomUUID(), definition('my-api')]);
    const [held] = await scratch.query<{ n: number }>(
      `select count(*)::int as n from pg_locks where locktype='advisory' and granted
         and ((classid::bigint<<32)|objid::bigint)=hashtextextended($1,340)`, [spaceId]);
    expect(held?.n).toBe(1);

    // A DIFFERENT Space must not wait on this one: the lock is per Space, so
    // registering a connector never serialises the whole node.
    await elsewhere.query('select internal.assert_mcp_server_key_free($1,$2,$3::jsonb)',
      [otherSpaceId, randomUUID(), definition('my-api')]);

    const blocked = waiter.query('select internal.assert_mcp_server_key_free($1,$2,$3::jsonb)',
      [spaceId, randomUUID(), definition('my_api')]);
    await waitForLock(pid, 'advisory');
    await holder.query('commit');
    await blocked;
  } finally {
    for (const client of [holder, waiter, elsewhere]) {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  }
});

/**
 * THE RACE, END TO END — and it is the RENAME path, not registration.
 *
 * MEASURED on a scratch cluster with 340's lock-free body restored: two
 * concurrent `create_mcp_server_entity` calls do NOT both commit, because the
 * entity write ahead of the guard already serialises per Space (the second
 * waits on `transactionid`). Two concurrent `update_mcp_server_entity` calls
 * moving two connectors' keys onto one value DO both commit, and leave the
 * Space holding two live connectors with the same effective key — the exact
 * state 340 exists to make impossible. Do not "simplify" this test back to two
 * creates: that version passes with the lock removed.
 */
it('lets only one of two overlapping renames onto one effective key commit', async () => {
  const seed = await open();
  const first = await createConnector(seed, 'alpha');
  const second = await createConnector(seed, 'beta');
  await seed.query('commit');
  seed.release();

  const renamer = await open(), loser = await open();
  const pid = await backendPid(loser);
  try {
    await renameConnector(renamer, first, 'my-api');
    const blocked = renameConnector(loser, second, 'my_api');
    await waitForLock(pid, 'advisory');
    await renamer.query('commit');
    await expect(blocked).rejects.toMatchObject({ code: '23505' });
    await loser.query('rollback');
  } finally {
    renamer.release();
    loser.release();
  }
  const duplicates = await scratch.query<{ key: string; n: string }>(
    `select internal.mcp_effective_server_key(m.definition) as key, count(*) as n
       from public.mcp_servers m join public.entities e on e.id=m.entity_id
      where m.space_id=$1 and e.deleted_at is null group by 1 having count(*)>1`, [spaceId]);
  expect(duplicates).toEqual([]);
  const keys = await scratch.query<{ key: string }>(
    `select internal.mcp_effective_server_key(m.definition) as key from public.mcp_servers m
       join public.entities e on e.id=m.entity_id where m.space_id=$1 and e.deleted_at is null order by 1`, [spaceId]);
  expect(keys.map(row => row.key)).toEqual(['beta', 'my_api']);
});

it("refuses a connector whose NAME normalises onto tm8, the launcher's own bridge entry", async () => {
  const client = await open();
  try {
    // `tm8` itself is already refused by the name rule; `tm8--` passes it and
    // normalises onto the reserved key, which is the hole 344 closes.
    await expect(createConnector(client, 'tm8--')).rejects.toMatchObject({ message: /tm8 is reserved/ });
    // And `tm8` is still refused by the earlier name rule, with its own message.
    await client.query('rollback');
    await client.query('begin');
    await expect(scratch.query('select internal.validate_mcp_definition($1::jsonb)', [definition('tm8')]))
      .rejects.toMatchObject({ code: '22023' });
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
});
