/**
 * W8 — remote servers (migration 991). The DB half:
 *
 *   · a4: 044 is read-only — create/delete refuse 42501 and its rows are
 *     untouched; a 044 row gets an entity only through `adopt` (node admin),
 *     and `server_directory` shows it once, before and after.
 *   · add/remove are human-only and space-scoped; remove is creator or admin.
 *   · the sealed gate row: own-row RLS, no ciphertext/nonce for tm8_app, AAD
 *     bound to the row, and `open` refuses an agent.
 *   · a server in a space the caller is not in is P0002, like a missing one.
 *
 * Fixture: spaces A and B. H owns A; H2 is a member of A; H3 owns B only.
 * Every refusal is paired with a positive through the same RPC. No secret is
 * printed or logged: the "ciphertext" here is random bytes.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { RESTRICTED_LIFECYCLE_KINDS, W2EntitiesCommandsTrackingService } from '../../src/facade/services/w2/entities-commands-tracking.js';
import { loadConfig, type ServerConfig } from '../../src/http/config.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import type { RequestContext } from '../../src/http/types.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  spaceA: string; spaceB: string;
  identityH: string; identityH2: string; identityH3: string;
  memberHA: string; memberH2A: string; memberH3B: string;
  legacyId: string;
}

interface ServerJson { id: string; name: string; baseUrl: string; homeSpaceId: string; legacyConnectionId: string | null }

let database: W1ScratchDatabase;
let db: Db;
let f: Fixture;

function as<T>(identityId: string, fn: (q: Querier) => Promise<T>, opts: { authKind?: string; nodeAdmin?: boolean } = {}): Promise<T> {
  const claims: DbClaims = {
    identityId,
    authKind: opts.authKind ?? 'browser',
    nodeAdmin: opts.nodeAdmin ?? false,
    requestId: `remote-servers-${randomUUID()}`,
  };
  return db.tx(claims, fn);
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const code = (err as { details?: { sqlstate?: string } }).details?.sqlstate
      ?? (err as { cause?: { code?: string } }).cause?.code
      ?? (err as { code?: string }).code;
    return String(code);
  }
}

const cmid = (): string => `remote-servers-${randomUUID()}`;

function add(identityId: string, spaceId: string | null, name: string, authKind = 'browser'): Promise<ServerJson> {
  return as(identityId, (q) => q.rpc<ServerJson>('add_server', [spaceId, name, `https://${name}.example`, null, cmid()]), { authKind });
}

async function legacyRows(): Promise<Array<{ id: string; name: string; base_url: string; updated_at: string }>> {
  return database.query(`select id::text, name, base_url, updated_at::text from public.server_connections order by id`);
}

async function seed(): Promise<Fixture> {
  const fx: Fixture = {
    spaceA: randomUUID(), spaceB: randomUUID(),
    identityH: `remote-servers-h-${randomUUID()}`,
    identityH2: `remote-servers-h2-${randomUUID()}`,
    identityH3: `remote-servers-h3-${randomUUID()}`,
    memberHA: randomUUID(), memberH2A: randomUUID(), memberH3B: randomUUID(),
    legacyId: randomUUID(),
  };
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'H2'), ($3, 'H3')`,
      [fx.identityH, fx.identityH2, fx.identityH3]);
    // adopt checks the ACCOUNT (002 require_node_admin), not the claim: H's is a node admin.
    await client.query(
      `insert into public.accounts(id, identity_id, username, is_node_admin)
       values (gen_random_uuid(), $1, 'remote-servers-h', true), (gen_random_uuid(), $2, 'remote-servers-h2', false),
              (gen_random_uuid(), $3, 'remote-servers-h3', false)`,
      [fx.identityH, fx.identityH2, fx.identityH3]);
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Servers A', $3), ($2, 'Servers B', $3)`,
      [fx.spaceA, fx.spaceB, fx.identityH]);
    const members: Array<[string, string, string, string, string]> = [
      [fx.memberHA, fx.spaceA, fx.identityH, 'owner', 'H'],
      [fx.memberH2A, fx.spaceA, fx.identityH2, 'member', 'H2'],
      [fx.memberH3B, fx.spaceB, fx.identityH3, 'owner', 'H3'],
    ];
    for (const [id, space, identity, role, name] of members) {
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`,
        [id, space]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $5)`,
        [id, space, identity, role, name]);
    }
  });
  // A 044 row as it exists on a node today; written as the table owner, since
  // 991 refuses every write through the RPCs.
  await database.query(
    `insert into public.server_connections(id, name, base_url) values ($1, 'legacy-one', 'https://legacy.example')`,
    [fx.legacyId]);
  return fx;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('remote_servers');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  f = await seed();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

describe('a4 — 044 is read-only, and its rows are untouched', () => {
  it('create/delete_server_connection refuse 42501 even for a node admin; the rows do not change', async () => {
    const before = await legacyRows();
    expect(await outcome(() => as(f.identityH, (q) =>
      q.rpc('create_server_connection', ['legacy-two', 'https://two.example', null, cmid()]), { nodeAdmin: true })))
      .toBe('42501');
    expect(await outcome(() => as(f.identityH, (q) =>
      q.rpc('delete_server_connection', ['legacy-one', cmid()]), { nodeAdmin: true })))
      .toBe('42501');
    expect(await legacyRows()).toEqual(before);
    // POSITIVE: the same node admin's read of 044 still answers.
    const read = await as(f.identityH, (q) => q.query<{ name: string }>(
      `select name from public.server_connections where id = $1`, [f.legacyId]), { nodeAdmin: true });
    expect(read.map((r) => r.name)).toEqual(['legacy-one']);
  });

  it('adopt refuses a non-admin account (42501, even with the claim) and an agent; POSITIVE: a node admin adopts, and the 044 row is untouched', async () => {
    const before = await legacyRows();
    expect(await outcome(() => as(f.identityH2, (q) =>
      q.rpc('adopt_server_connection', [f.spaceA, 'legacy-one', cmid()]), { nodeAdmin: true })))
      .toBe('42501');
    expect(await outcome(() => as(f.identityH, (q) =>
      q.rpc('adopt_server_connection', [f.spaceA, 'legacy-one', cmid()]), { authKind: 'agent', nodeAdmin: true })))
      .toBe('42501');

    const adopted = await as(f.identityH, (q) =>
      q.rpc<ServerJson>('adopt_server_connection', [f.spaceA, 'legacy-one', cmid()]), { nodeAdmin: true });
    expect(adopted).toMatchObject({ name: 'legacy-one', baseUrl: 'https://legacy.example', homeSpaceId: f.spaceA, legacyConnectionId: f.legacyId });
    // Idempotent per (space, connection): a second adopt returns the same entity.
    const again = await as(f.identityH, (q) =>
      q.rpc<ServerJson>('adopt_server_connection', [f.spaceA, 'legacy-one', cmid()]), { nodeAdmin: true });
    expect(again.id).toBe(adopted.id);
    expect(await legacyRows()).toEqual(before);
  });

  it('server_directory shows the adopted 044 row once, as the entity; a member of A sees it without node admin', async () => {
    const adminView = await as(f.identityH, (q) => q.query<{ id: string; legacy: boolean }>(
      `select id::text, legacy from public.server_directory where name = 'legacy-one'`), { nodeAdmin: true });
    expect(adminView).toHaveLength(1);
    expect(adminView[0]!.legacy).toBe(false);
    const memberView = await as(f.identityH2, (q) => q.query<{ id: string }>(
      `select id::text from public.server_directory where name = 'legacy-one'`));
    expect(memberView.map((r) => r.id)).toEqual([adminView[0]!.id]);
    // H3 is not in A: neither the entity nor (no node admin) the 044 row.
    const outsider = await as(f.identityH3, (q) => q.query(
      `select 1 from public.server_directory where name = 'legacy-one'`));
    expect(outsider).toHaveLength(0);
  });
});

describe('add / get / remove — human-only, space-scoped', () => {
  it('add refuses an agent and an agent_runtime (42501); POSITIVE: browser and cli add', async () => {
    expect(await outcome(() => add(f.identityH, f.spaceA, 'agent-add', 'agent'))).toBe('42501');
    expect(await outcome(() => add(f.identityH, f.spaceA, 'runtime-add', 'agent_runtime'))).toBe('42501');
    expect((await add(f.identityH, f.spaceA, 'browser-add')).homeSpaceId).toBe(f.spaceA);
    expect((await add(f.identityH, f.spaceA, 'cli-add', 'cli')).homeSpaceId).toBe(f.spaceA);
  });

  it('add into a space the caller is not in refuses; POSITIVE: omitted space is the caller\'s own', async () => {
    expect(await outcome(() => add(f.identityH3, f.spaceA, 'not-mine'))).not.toBe('ok');
    expect((await add(f.identityH3, null, 'own-default')).homeSpaceId).toBe(f.spaceB);
  });

  it('get of a server in another space is P0002, the same as a missing one; POSITIVE: a home member gets it', async () => {
    const server = await add(f.identityH, f.spaceA, 'cross-space');
    expect(await outcome(() => as(f.identityH3, (q) => q.rpc('get_server', [server.id])))).toBe('P0002');
    expect(await outcome(() => as(f.identityH3, (q) => q.rpc('get_server', [randomUUID()])))).toBe('P0002');
    expect((await as(f.identityH2, (q) => q.rpc<ServerJson>('get_server', [server.id]))).id).toBe(server.id);
  });

  it('remove: another plain member is refused 42501; POSITIVE: the space owner removes it, and it leaves list and directory', async () => {
    const server = await add(f.identityH, f.spaceA, 'to-remove');
    expect(await outcome(() => as(f.identityH2, (q) => q.rpc('remove_server', [server.id, cmid()])))).toBe('42501');
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('remove_server', [server.id, cmid()]), { authKind: 'agent' }))).toBe('42501');
    await as(f.identityH, (q) => q.rpc('remove_server', [server.id, cmid()]));
    const listed = await as(f.identityH, (q) => q.rpc<ServerJson[]>('list_servers', [f.spaceA]));
    expect(listed.map((s) => s.id)).not.toContain(server.id);
    const dir = await as(f.identityH, (q) => q.query(`select 1 from public.server_directory where id = $1`, [server.id]));
    expect(dir).toHaveLength(0);
  });

  it('POSITIVE: a plain member removes a server they created', async () => {
    const server = await add(f.identityH2, f.spaceA, 'h2-own');
    expect(await outcome(() => as(f.identityH2, (q) => q.rpc('remove_server', [server.id, cmid()])))).toBe('ok');
  });
});

describe('the sealed gate row', () => {
  it('own row only, no ciphertext for tm8_app, AAD bound to the row; open refuses an agent, POSITIVE browser', async () => {
    const server = await add(f.identityH, f.spaceA, 'gate');
    const ctx = await as(f.identityH, (q) => q.rpc<{ homeSpaceId: string; serverId: string; memberId: string }>(
      'server_gate_seal_context', [server.id]));
    expect(ctx).toEqual({ homeSpaceId: f.spaceA, serverId: server.id, memberId: f.memberHA });

    const ciphertext = randomBytes(48);
    const nonce = randomBytes(12);
    await as(f.identityH, (q) => q.rpc('store_server_gate_token', [
      server.id, new Date(Date.now() + 3_600_000).toISOString(), ciphertext, nonce, cmid()]));

    // tm8_app has no column grant on ciphertext / nonce.
    expect(await outcome(() => as(f.identityH, (q) => q.query(
      `select ciphertext from public.server_gate_tokens where server_id = $1`, [server.id])))).toBe('42501');
    // RLS: H sees their row; H2 (same space) sees none of H's.
    const mine = await as(f.identityH, (q) => q.query<{ member_id: string; aad: string; status: string }>(
      `select member_id::text, aad, status from public.server_gate_tokens where server_id = $1`, [server.id]));
    expect(mine).toEqual([{ member_id: f.memberHA, aad: `server-gate|${f.spaceA}|${server.id}|${f.memberHA}`, status: 'signed_in' }]);
    const theirs = await as(f.identityH2, (q) => q.query(
      `select 1 from public.server_gate_tokens where server_id = $1`, [server.id]));
    expect(theirs).toHaveLength(0);

    // The AAD cannot be pointed at another row.
    expect(await outcome(() => database.query(
      `update public.server_gate_tokens set aad = 'server-gate|' || $2 || '|' || server_id || '|' || member_id
        where server_id = $1`, [server.id, f.spaceB]))).toBe('23514');

    // open: agent and agent_runtime refused; the browser gets its own bytes back.
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('open_server_gate_token', [server.id]), { authKind: 'agent' }))).toBe('42501');
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('open_server_gate_token', [server.id]), { authKind: 'agent_runtime' }))).toBe('42501');
    const opened = await as(f.identityH, (q) => q.rpc<{ ciphertext: string; nonce: string; memberId: string }>(
      'open_server_gate_token', [server.id]));
    expect(Buffer.from(opened.ciphertext, 'base64').equals(ciphertext)).toBe(true);
    expect(opened.memberId).toBe(f.memberHA);

    // H2 has no session of their own: signed out (23514), not H's bytes.
    expect(await outcome(() => as(f.identityH2, (q) => q.rpc('open_server_gate_token', [server.id])))).toBe('23514');
    // An outsider: P0002.
    expect(await outcome(() => as(f.identityH3, (q) => q.rpc('open_server_gate_token', [server.id])))).toBe('P0002');

    // sign out forgets the bytes; open then refuses.
    await as(f.identityH, (q) => q.rpc('sign_out_server', [server.id, cmid()]));
    const [row] = await database.query<{ ciphertext: Buffer | null; nonce: Buffer | null; status: string }>(
      `select ciphertext, nonce, status from public.server_gate_tokens where server_id = $1 and member_id = $2`,
      [server.id, f.memberHA]);
    expect(row).toEqual({ ciphertext: null, nonce: null, status: 'signed_out' });
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('open_server_gate_token', [server.id])))).toBe('23514');
  });

  it('no server response carries a sealed field', async () => {
    const server = await add(f.identityH, f.spaceA, 'no-secret');
    const got = await as(f.identityH, (q) => q.rpc<Record<string, unknown>>('get_server', [server.id]));
    const keys = JSON.stringify(got).match(/"[A-Za-z_]+":/g) ?? [];
    expect(keys.filter((k) => /ciphertext|nonce|aad/i.test(k))).toEqual([]);
  });
});

describe('reach status (probe) — any home member on a human or agent session', () => {
  it('link / agent_runtime refused 42501, outsider P0002; POSITIVE: agent and browser mark it', async () => {
    const server = await add(f.identityH, f.spaceA, 'reach');
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('mark_server_reach', [server.id, 'offline']), { authKind: 'link' }))).toBe('42501');
    expect(await outcome(() => as(f.identityH, (q) => q.rpc('mark_server_reach', [server.id, 'offline']), { authKind: 'agent_runtime' }))).toBe('42501');
    expect(await outcome(() => as(f.identityH3, (q) => q.rpc('mark_server_reach', [server.id, 'offline'])))).toBe('P0002');
    const byAgent = await as(f.identityH, (q) => q.rpc<{ reachStatus: string }>('mark_server_reach', [server.id, 'unreachable']), { authKind: 'agent' });
    expect(byAgent.reachStatus).toBe('unreachable');
    const byBrowser = await as(f.identityH2, (q) => q.rpc<{ reachStatus: string }>('mark_server_reach', [server.id, 'offline']));
    expect(byBrowser.reachStatus).toBe('offline');
  });
});

// ---------------------------------------------------------------------------
// A server's lifecycle is command-owned (991 §8b, like 251 §10b for a space
// link). The generic doors refuse it in BOTH layers — the facade
// (RESTRICTED_LIFECYCLE_KINDS, `forbidden`, before SQL) and SQL (the re-created
// guard trigger, 42501, whatever the caller). Paired positive: servers.remove
// still ends it, through the one sanctioned write.
// ---------------------------------------------------------------------------

const NOT_THE_OWNER: LoopbackOwner = {
  identityId: 'remote-servers-not-the-owner',
  accountId: randomUUID(),
  username: 'nobody',
  isNodeAdmin: false,
  isOwner: false,
};

async function accountOf(identityId: string): Promise<string> {
  return (await database.query<{ id: string }>('select id::text from public.accounts where identity_id = $1', [identityId]))[0]!.id;
}

async function mintBrowser(identityId: string): Promise<string> {
  const secret = generateSecret();
  const accountId = await accountOf(identityId);
  const row = await as(identityId, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [
      accountId, hashToken(secret), 'browser',
      new Date(Date.now() + 3_600_000).toISOString(), null, 'remote-servers browser',
    ]));
  return formatToken(row.id, secret);
}

const versionOf = async (id: string): Promise<number> =>
  (await database.query<{ version: number }>('select version from public.entities where id = $1', [id]))[0]!.version;
const deletedAt = async (id: string): Promise<string | null> =>
  (await database.query<{ deleted_at: string | null }>('select deleted_at::text from public.entities where id = $1', [id]))[0]!.deleted_at;

/** Soft-delete or undelete as the superuser, past every trigger: the state the doors must never reach. */
async function forceDeletedAt(id: string, deleted: boolean): Promise<void> {
  await database.query(`set session_replication_role = replica;
    update public.entities set deleted_at = ${deleted ? 'now()' : 'null'} where id = '${id}';
    set session_replication_role = origin;`);
}

describe('W8 (c)1 — the generic entity doors refuse a server; servers.remove still ends it', () => {
  const facade = () => new W2EntitiesCommandsTrackingService({
    db, config: {} as ServerConfig, owner: async () => NOT_THE_OWNER,
  });
  async function facadeCtx(params: Record<string, string>, body: unknown): Promise<RequestContext> {
    const resolve = createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER, spaceSessions: 'agents' });
    const token = await mintBrowser(f.identityH);
    const identity = await resolve({ authorization: `Bearer ${token}` }, { remoteAddress: '203.0.113.9', disableAutoOwner: true });
    return {
      identity, requestId: `remote-servers-${randomUUID()}`, params, query: new URLSearchParams(), body,
      headers: {}, method: 'POST', path: '/test',
    } as unknown as RequestContext;
  }
  const hRpc = <T>(fn: string, args: unknown[]): Promise<T> => as(f.identityH, (q) => q.rpc<T>(fn, args));

  let serverId: string;
  beforeAll(async () => {
    // H owns A and created this server, so every refusal below is the kind gate, not authority.
    serverId = (await add(f.identityH, f.spaceA, 'lifecycle-srv')).id;
  });

  it('the TS gate names server beside the other shared-object kinds', () => {
    expect(['credential', 'space_link', 'server'].map((k) => RESTRICTED_LIFECYCLE_KINDS.has(k))).toEqual([true, true, true]);
  });

  it('facade: entities.delete / move / restore / patch / create of a server are forbidden before SQL', async () => {
    const s = facade();
    expect({
      delete: await outcome(async () => s.deleteEntity(await facadeCtx({ id: serverId }, {}))),
      move: await outcome(async () => s.moveEntity(await facadeCtx({ id: serverId },
        { parentId: null, position: 424242.5, expectedVersion: await versionOf(serverId) }))),
      restore: await outcome(async () => s.restoreEntity(await facadeCtx({ id: serverId }, {}))),
      patch: await outcome(async () => s.patchEntity(await facadeCtx({ id: serverId },
        { title: 'renamed', expectedVersion: await versionOf(serverId) }))),
      create: await outcome(async () => s.createEntity(await facadeCtx({},
        { spaceId: f.spaceA, kind: 'server', title: 'forged', clientMutationId: randomUUID() }))),
    }).toEqual({ delete: 'forbidden', move: 'forbidden', restore: 'forbidden', patch: 'forbidden', create: 'forbidden' });
    expect(await deletedAt(serverId)).toBeNull();
  });

  it('RPC: delete_entity / move_entity = 42501 from the guard trigger; the patch and create doors refuse the kind', async () => {
    expect({
      delete: await outcome(() => hRpc('delete_entity', [serverId, null, null])),
      // A real move (a new position); a no-op move changes no lifecycle column.
      move: await outcome(async () => hRpc('move_entity', [serverId, null, 424242.5, await versionOf(serverId), null, null])),
      patch: await outcome(async () => hRpc('update_custom_entity', [serverId, await versionOf(serverId), 'renamed', null, null, null])),
      create: await outcome(() => hRpc('create_custom_entity', [f.spaceA, 'server', 'forged', null, '{}', null, null, null])),
    }).toEqual({ delete: '42501', move: '42501', patch: '22023', create: '22023' });
    // The refusal is the re-created trigger's, not an authority check.
    const raw = await as(f.identityH, (q) => q.rpc('delete_entity', [serverId, null, null]))
      .then(() => 'ok', (err: unknown) => (err as Error).message);
    expect(raw).toContain('command-owned for kind server');
    expect(await deletedAt(serverId)).toBeNull();
  });

  it('RPC: restore_entity of a (forced) deleted server = 42501 — delete means gone', async () => {
    await forceDeletedAt(serverId, true);
    try {
      expect(await outcome(() => hRpc('restore_entity', [serverId, null, null]))).toBe('42501');
      expect(await deletedAt(serverId)).not.toBeNull();
    } finally {
      await forceDeletedAt(serverId, false);
    }
  });

  it('positive — servers.remove still ends it (the sanctioned write), and the setting does not outlive the call', async () => {
    const removed = await as(f.identityH, (q) => q.rpc<ServerJson>('remove_server', [serverId, cmid()]));
    expect(removed.id).toBe(serverId);
    expect(await deletedAt(serverId)).not.toBeNull();
    // A fresh server in the same transaction as a remove still refuses the generic door afterwards.
    const other = (await add(f.identityH, f.spaceA, 'lifecycle-srv-2')).id;
    const after = await as(f.identityH, async (q) => {
      await q.rpc('remove_server', [other, cmid()]);
      const again = (await q.rpc<ServerJson>('add_server', [f.spaceA, 'lifecycle-srv-3', 'https://lifecycle-srv-3.example', null, cmid()])).id;
      return outcome(() => q.rpc('delete_entity', [again, null, null]));
    });
    expect(after).toBe('42501');
  });
});

// R864 1d/M2: the §8b exemption is scoped to kind 'server'. Even with
// tm8.server_lifecycle bound 'on' in the caller's own transaction, a space
// link's generic doors still refuse; a server's refuse with it 'off'.
describe('W8 (c)1 — the tm8.server_lifecycle exemption is server-only', () => {
  const spaceC = randomUUID();
  const memberH3C = randomUUID();
  let linkId: string;

  beforeAll(async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Servers C', $2)`, [spaceC, f.identityH3]);
      await client.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`, [memberH3C, spaceC]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', 'H3')`,
        [memberH3C, spaceC, f.identityH3]);
    });
    linkId = (await as(f.identityH3, (q) => q.rpc<{ id: string }>('add_space_link', [f.spaceB, spaceC, 'c-link', cmid()]))).id;
  });

  const withLifecycle = <T>(identityId: string, value: 'on' | 'off', fn: (q: Querier) => Promise<T>): Promise<T> =>
    as(identityId, async (q) => {
      await q.query(`select set_config('tm8.server_lifecycle', $1, true)`, [value]);
      return fn(q);
    });

  it("a SPACE LINK's delete and move refuse (42501) with the setting 'on' in the same transaction", async () => {
    expect({
      delete: await outcome(() => withLifecycle(f.identityH3, 'on', (q) => q.rpc('delete_entity', [linkId, null, null]))),
      move: await outcome(async () => {
        const version = await versionOf(linkId);
        return withLifecycle(f.identityH3, 'on', (q) => q.rpc('move_entity', [linkId, null, 424242.5, version, null, null]));
      }),
    }).toEqual({ delete: '42501', move: '42501' });
    expect(await deletedAt(linkId)).toBeNull();
  });

  it("a server's delete refuses (42501) with the setting 'off'", async () => {
    const id = (await add(f.identityH, f.spaceA, 'lifecycle-off')).id;
    expect(await outcome(() => withLifecycle(f.identityH, 'off', (q) => q.rpc('delete_entity', [id, null, null])))).toBe('42501');
    expect(await deletedAt(id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The two 044 write ops are still mounted (serverConnections.create/delete,
// contract-removal follow-up) but refuse over HTTP: 403, rows unchanged.
// ---------------------------------------------------------------------------

describe('W8 — serverConnections.create/delete over HTTP: 403, and the 044 rows are unchanged', () => {
  let server: BootstrappedServer;
  let ownerBefore: boolean;

  beforeAll(async () => {
    // `bootstrap` needs an owner: H is made one for this block and restored after.
    const accountH = await accountOf(f.identityH);
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const before = await client.query<{ is_owner: boolean }>('select is_owner from public.accounts where id = $1::uuid', [accountH]);
      ownerBefore = before.rows[0]!.is_owner;
      await client.query('update public.accounts set is_owner = true where id = $1::uuid', [accountH]);
    });
    const configured = loadConfig({
      ...process.env,
      TM8_BIND: '127.0.0.1',
      TM8_PORT: '4610',
      TM8_NODE_MODE: 'single',
      TM8_DATABASE_URL: database.url,
      TM8_DATA_DIR: await mkdtemp(join(tmpdir(), 'tm8-w8-')),
      TM8_DISABLE_AUTO_OWNER: '1',
    });
    server = await bootstrap({ config: { ...configured, port: 0 } });
  }, 180_000);

  afterAll(async () => {
    await server?.server.close();
    await server?.db?.end();
    const accountH = await accountOf(f.identityH);
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('update public.accounts set is_owner = $2 where id = $1::uuid', [accountH, ownerBefore]);
    });
  }, 180_000);

  async function call(method: string, path: string, token: string, body?: unknown): Promise<number> {
    const response = await fetch(new URL(path, server.url), {
      method,
      headers: {
        [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    await response.text();
    return response.status;
  }

  it('a node admin gets 403 from both writes; POSITIVE: the same session lists (200)', async () => {
    const before = await legacyRows();
    const token = await mintBrowser(f.identityH); // H's account is a node admin
    expect({
      create: await call('POST', '/v2/server-connections', token,
        { name: 'http-forged', baseUrl: 'https://http-forged.example', clientMutationId: cmid() }),
      delete: await call('DELETE', '/v2/server-connections/legacy-one', token, { clientMutationId: cmid() }),
      list: await call('GET', '/v2/server-connections', token),
    }).toEqual({ create: 403, delete: 403, list: 200 });
    expect(await legacyRows()).toEqual(before);
  });
});
