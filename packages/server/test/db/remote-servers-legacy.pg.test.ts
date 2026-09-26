/**
 * W8 — legacy 044 visibility across the 991 repoint (lead ruling 09:52Z (a)).
 *
 * A 044 row is written through the PRE-991 path (the old
 * `create_server_connection` RPC, on a chain that stops before 991), then 991
 * is applied on top. The three readers that moved to `server_directory` — the
 * `serverConnections.list` / `.get` service and the relay's target resolver —
 * must still show it, with the same name and URL, to exactly the callers 044's
 * RLS admitted before (node admins). No backfill: 991 inserts nothing into
 * `servers`, so the row is visible through the view's union arm only.
 *
 * Paired: once adopted, the row appears ONCE (as the entity), never twice —
 * and never again as a 044 row, even after the entity is soft-deleted (lead
 * ruling: delete means gone), even for a node admin outside the home space.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { W2ServerConnectionsService } from '../../src/facade/services/w2/server-connections.js';
import type { RequestContext, RequestIdentity } from '../../src/http/types.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { directoryTargetResolver } from '../../src/remote/directory-resolver.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const W8 = '991_remote_servers.sql';
const NAME = 'legacy-pre';
const URL_ = 'https://legacy-pre.example';

let database: W1ScratchDatabase;
let db: Db;
let service: W2ServerConnectionsService;
let legacyId: string;
let serverId: string;
const spaceA = randomUUID();
const memberNA = randomUUID();
const memberMA = randomUUID();
const adminN = `legacy-n-${randomUUID()}`; // node admin, owner of A
const adminN2 = `legacy-n2-${randomUUID()}`; // node admin, in no space
const plainM = `legacy-m-${randomUUID()}`; // member of A, not a node admin
const node: Record<string, boolean> = { [adminN]: true, [adminN2]: true, [plainM]: false };

const OWNER = { identityId: 'legacy-not-the-owner', isNodeAdmin: false } as unknown as LoopbackOwner;

function bearer(identityId: string): RequestIdentity {
  return { kind: 'bearer', identityId, nodeAdmin: node[identityId], authKind: 'browser' };
}

function ctx(identityId: string, params: Record<string, string> = {}): RequestContext {
  return { identity: bearer(identityId), requestId: `legacy-${randomUUID()}`, params } as unknown as RequestContext;
}

interface Seen { list: Array<{ name: string; baseUrl: string }>; get: { name: string; baseUrl: string } | string; relay: string | null }

async function readAll(identityId: string): Promise<Seen> {
  const list = (await service.list(ctx(identityId))).filter((c) => c.name === NAME).map((c) => ({ name: c.name, baseUrl: c.baseUrl }));
  let get: Seen['get'];
  try {
    const one = await service.get(ctx(identityId, { name: NAME }));
    get = { name: one.name, baseUrl: one.baseUrl };
  } catch (err) {
    get = (err as { code?: string }).code ?? 'error';
  }
  const relay = await directoryTargetResolver(db, async () => OWNER)(NAME, bearer(identityId));
  return { list, get, relay };
}

async function directory(identityId: string): Promise<Array<{ legacy: boolean }>> {
  return db.query({ identityId, nodeAdmin: node[identityId], authKind: 'browser', requestId: `legacy-dir-${randomUUID()}` },
    `select legacy from public.server_directory where name = $1`, [NAME]);
}

async function adoptedDirect(identityId: string): Promise<boolean> {
  const [row] = await db.query<{ adopted: boolean }>(
    { identityId, nodeAdmin: node[identityId], authKind: 'browser', requestId: `legacy-direct-${randomUUID()}` },
    `select internal.server_connection_adopted($1) as adopted`, [legacyId]);
  return row!.adopted;
}

const VISIBLE: Seen = { list: [{ name: NAME, baseUrl: URL_ }], get: { name: NAME, baseUrl: URL_ }, relay: URL_ };
const HIDDEN: Seen = { list: [], get: 'not_found', relay: null };

beforeAll(async () => {
  database = await createW1ScratchDatabase('remote_servers_legacy');
  const files = migrationFiles();
  expect(files.at(-1)).toBe(W8);
  database.apply(files.filter((f) => f !== W8));
  db = createDb(database.url, { max: 4 });

  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'N'), ($2, 'N2'), ($3, 'M')`,
      [adminN, adminN2, plainM]);
    // 002 require_node_admin reads the ACCOUNT; 044's RLS reads the claim. Both agree here.
    await client.query(
      `insert into public.accounts(id, identity_id, username, is_node_admin)
       values (gen_random_uuid(), $1, 'legacy-n', true), (gen_random_uuid(), $2, 'legacy-n2', true),
              (gen_random_uuid(), $3, 'legacy-m', false)`,
      [adminN, adminN2, plainM]);
    await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Legacy A', $2)`, [spaceA, adminN]);
    for (const [id, identity, role] of [[memberNA, adminN, 'owner'], [memberMA, plainM, 'member']] as const) {
      await client.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`, [id, spaceA]);
      await client.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, 'x')`, [id, spaceA, identity, role]);
    }
  });

  // THE PRE-991 PATH: 044's own RPC, as a node admin, on the 990-level chain.
  const claims: DbClaims = { identityId: adminN, nodeAdmin: true, authKind: 'browser', requestId: 'legacy-seed' };
  await db.rpc(claims, 'create_server_connection', [NAME, URL_, null, `legacy-seed-${randomUUID()}`]);
  const before = await db.query<{ n: number }>({ ...claims, requestId: 'legacy-count' },
    `select count(*)::int as n from public.server_connections where name = $1`, [NAME]);
  expect(before[0]!.n).toBe(1);
  // A plain member could not read 044 before 991.
  expect(await db.query({ identityId: plainM, authKind: 'browser', requestId: 'legacy-m' },
    `select 1 from public.server_connections`)).toHaveLength(0);

  legacyId = (await database.query<{ id: string }>(`select id::text from public.server_connections where name = $1`, [NAME]))[0]!.id;

  database.apply([W8]);
  service = new W2ServerConnectionsService({ db, owner: async () => OWNER } as unknown as FacadeDeps);
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

describe('lead 09:52Z (a) — a pre-991 044 row after the repoint', () => {
  it('991 backfilled nothing: no servers row, and the 044 row is byte-identical', async () => {
    expect(await database.query(`select 1 from public.servers`)).toHaveLength(0);
    const rows = await database.query<{ name: string; base_url: string }>(
      `select name, base_url from public.server_connections`);
    expect(rows).toEqual([{ name: NAME, base_url: URL_ }]);
  });

  it('a node admin sees it through all three readers, same name and URL (via the view\'s union arm)', async () => {
    expect(await readAll(adminN)).toEqual(VISIBLE);
    expect(await readAll(adminN2)).toEqual(VISIBLE);
  });

  it('a plain member did not see it before 991 and does not now: 044\'s RLS is unchanged', async () => {
    expect(await readAll(plainM)).toEqual(HIDDEN);
  });

  it('PAIRED: once adopted, the home member sees the entity ONCE, and the node admin in no space sees nothing — no duplicate, no resurrected legacy row', async () => {
    const adopted = await db.rpc<{ id: string }>({ identityId: adminN, nodeAdmin: true, authKind: 'browser', requestId: 'legacy-adopt' },
      'adopt_server_connection', [spaceA, NAME, `legacy-adopt-${randomUUID()}`]);
    serverId = adopted.id;
    expect(await readAll(adminN)).toEqual(VISIBLE);  // the entity (home member)
    expect(await readAll(plainM)).toEqual(VISIBLE);  // a home member now sees the entity
    // Outside A, the entity is invisible and the 044 row is shadowed anyway:
    // the exclusion does not depend on this reader's RLS on servers.
    expect(await readAll(adminN2)).toEqual(HIDDEN);
    expect(await directory(adminN)).toEqual([{ legacy: false }]);
    expect(await directory(adminN2)).toEqual([]);
  });

  it('the helper answers only callers who can already see every 044 row: a plain member gets false, node admins get true', async () => {
    expect(await adoptedDirect(plainM)).toBe(false);
    expect(await adoptedDirect(adminN)).toBe(true);
    expect(await adoptedDirect(adminN2)).toBe(true);
  });

  it('delete means gone: after the adopted server is soft-deleted, every reader returns NOTHING for both node admins and the member', async () => {
    await db.rpc({ identityId: adminN, nodeAdmin: true, authKind: 'browser', requestId: 'legacy-remove' },
      'remove_server', [serverId, `legacy-remove-${randomUUID()}`]);
    expect(await readAll(adminN)).toEqual(HIDDEN);
    expect(await readAll(adminN2)).toEqual(HIDDEN);
    expect(await readAll(plainM)).toEqual(HIDDEN);
    expect(await directory(adminN)).toEqual([]);
    expect(await directory(adminN2)).toEqual([]);
    // Still no rewrite: the 044 row is where it was.
    expect(await database.query(`select name, base_url from public.server_connections`))
      .toEqual([{ name: NAME, base_url: URL_ }]);
    expect(await adoptedDirect(adminN2)).toBe(true);
  });

  it('restore_entity brings the ENTITY back, once; the 044 row stays shadowed', async () => {
    await db.rpc({ identityId: adminN, nodeAdmin: true, authKind: 'browser', requestId: 'legacy-restore' },
      'restore_entity', [serverId, null, `legacy-restore-${randomUUID()}`]);
    expect(await readAll(adminN)).toEqual(VISIBLE);
    expect(await directory(adminN)).toEqual([{ legacy: false }]);
    expect(await readAll(adminN2)).toEqual(HIDDEN);
  });
});
