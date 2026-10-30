/**
 * Bridges B1b-5 (migration 400, BRIDGE-ENTITY-DESIGN §2.5, §3.4, D28, D32): a
 * connection is offered to a space as a server-only `credential` (provider
 * whatsapp, shape connection). Pinned here: the owner, a member, offers it;
 * anyone else is refused; the spawn reader refuses it; withdraw pauses every
 * bridge on it in that space and only there; bridges.create fills
 * credential_id from the offer; B0a's rows are backfilled and the column is
 * NOT NULL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, Querier } from '../../src/db/types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID(), otherSpace = randomUUID();
const ownerMember = randomUUID(), ownerOtherMember = randomUUID(), plainMember = randomUUID();
const ownerIdentity = `conn-owner-${randomUUID()}`, plainIdentity = `conn-plain-${randomUUID()}`;
const strangerIdentity = `conn-stranger-${randomUUID()}`;
const ownerAccount = randomUUID(), plainAccount = randomUUID(), strangerAccount = randomUUID();
const chatA = randomUUID(), chatB = randomUUID(), chatC = randomUUID(), chatOther = randomUUID();
const connection = randomUUID(), strangerConnection = randomUUID();
const teammate = randomUUID(), otherTeammate = randomUUID();
let legacyBridge = '', removedBridge = '';
let removedBefore = { updatedAt: '', version: 0 };
const chatRemoved = randomUUID();

type Kind = 'browser' | 'cli' | 'agent';
const as = <T>(identityId: string, fn: (q: Querier) => Promise<T>, authKind: Kind = 'browser') =>
  db.tx({ identityId, authKind, requestId: randomUUID() }, fn);

interface Result { entity: { id: string; version: number; space_id: string }; patches: { id: string }[] }
interface Refusal { code?: string; message?: string; details?: Record<string, unknown> }
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (err) { return err as Refusal; }
  throw new Error('expected a refusal');
}
const reasonOf = (e: Refusal) => e.details?.['reason'];

const createBridge = (identity: string, space: string, conn: string, externalId: string, target: string) =>
  as(identity, q => q.rpc<Result>('create_bridge', [
    space, conn, externalId, JSON.stringify({ kind: 'group', title: externalId, memberCount: 3 }), target,
    '{}', null, null, null, true, null, null, randomUUID(),
  ]));
const offer = (identity: string, conn: string, space: string, authKind: Kind = 'browser', visibility = 'public') =>
  as(identity, q => q.rpc<Result>('offer_bridge_connection', [conn, space, visibility, null, randomUUID()]), authKind);
const withdraw = (identity: string, conn: string, space: string, authKind: Kind = 'browser') =>
  as(identity, q => q.rpc<Result>('withdraw_bridge_connection', [conn, space, randomUUID()]), authKind);
const bridgeRow = async (id: string) => (await scratch.query<{ credential_id: string | null; paused_at: Date | null }>(
  'select credential_id, paused_at from public.bridges where entity_id = $1', [id]))[0]!;

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('bridge_conns');
  const files = migrationFiles();
  const cut = files.findIndex(f => f.startsWith('405_bridge_connection_credentials'));
  expect(cut).toBeGreaterThan(0);
  // Up to B0a first, so a bridge created the B0a way (no credential) is there for 400's backfill.
  scratch.apply(files.slice(0, cut));
  db = createDb(scratch.url, { max: 4 });
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner'),($2,'Plain'),($3,'Stranger')`,
      [ownerIdentity, plainIdentity, strangerIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username) values ($1,$2,'conn-owner'),($3,$4,'conn-plain'),($5,$6,'conn-stranger')`,
      [ownerAccount, ownerIdentity, plainAccount, plainIdentity, strangerAccount, strangerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Bridges',$3),($2,'Other',$3)`,
      [spaceId, otherSpace, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values
      ($1,$4,'member',$1),($2,$4,'member',$2),($3,$5,'member',$3)`, [ownerMember, plainMember, ownerOtherMember, spaceId, otherSpace]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values
      ($1,$5,$3,'owner','Owner'),($2,$5,$4,'member','Plain'),($6,$7,$3,'owner','Owner')`,
      [ownerMember, plainMember, ownerIdentity, plainIdentity, spaceId, ownerOtherMember, otherSpace]);
    for (const [id, space, by] of [[teammate, spaceId, ownerMember], [otherTeammate, otherSpace, ownerOtherMember]] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [id, space, by]);
      await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
        values ($1,$2,'Teammate','worker','persona')`, [id, by]);
    }
    for (const [id, space, by, tm] of [[chatA, spaceId, ownerMember, teammate], [chatB, spaceId, ownerMember, teammate],
      [chatC, spaceId, ownerMember, teammate], [chatRemoved, spaceId, ownerMember, teammate],
      [chatOther, otherSpace, ownerOtherMember, otherTeammate]] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [id, space, by]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,'Chat',$6,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b1b5', gen_random_uuid(), $3, $4, $5)`,
        [id, space, ownerIdentity, by, `b1b5-${randomUUID()}`, tm]);
    }
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, external_account_id, status)
      values ($1,'whatsapp',$2,'+91 …9494','919494@s.whatsapp.net','linked'),($3,'whatsapp',$4,'+44 …0000',null,'linked')`,
      [connection, ownerAccount, strangerConnection, strangerAccount]);
  });
  legacyBridge = (await createBridge(ownerIdentity, spaceId, connection, 'legacy@g.us', chatA)).entity.id;
  expect((await bridgeRow(legacyBridge)).credential_id).toBeNull();
  // A REMOVED B0a bridge too: 395's guard refuses any update of a tombstone, and 400 must still fill it.
  const removed = await createBridge(ownerIdentity, spaceId, connection, 'removed@g.us', chatRemoved);
  removedBridge = removed.entity.id;
  await as(ownerIdentity, q => q.rpc('remove_bridge', [removedBridge, removed.entity.version, null, randomUUID()]));
  const [before] = await scratch.query<{ ended_at: Date | null; updated_at: Date; version: number }>(
    'select b.ended_at, b.updated_at, e.version from public.bridges b join public.entities e on e.id = b.entity_id where b.entity_id = $1', [removedBridge]);
  expect(before!.ended_at).not.toBeNull();
  removedBefore = { updatedAt: before!.updated_at.toISOString(), version: Number(before!.version) };
  scratch.apply(files.slice(cut));
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

describe('400 over B0a rows (D32)', () => {
  it('backfills a B0a bridge with an offered credential for its (connection, space), and the column is NOT NULL', async () => {
    const { credential_id } = await bridgeRow(legacyBridge);
    expect(credential_id).not.toBeNull();
    const [cred] = await scratch.query<Record<string, unknown>>(
      `select sc.provider, sc.shape, sc.bridge_connection_id, sc.space_id, sc.status, sc.owner_account_id, sc.is_default,
              sc.secret_ciphertext, sc.secret_nonce, sc.key_hint, e.kind
         from public.space_credentials sc join public.entities e on e.id = sc.id where sc.id = $1`, [credential_id]);
    expect(cred).toMatchObject({
      provider: 'whatsapp', shape: 'connection', bridge_connection_id: connection, space_id: spaceId, status: 'active',
      owner_account_id: ownerAccount, is_default: false, secret_ciphertext: null, secret_nonce: null, key_hint: null, kind: 'credential',
    });
    const [col] = await scratch.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'bridges' and column_name = 'credential_id'`);
    expect(col!.is_nullable).toBe('NO');
  });

  it('fills a removed B0a bridge as well, as a repair: no new version, updated_at unchanged, guards back on', async () => {
    const [row] = await scratch.query<{ credential_id: string | null; ended_at: Date | null; updated_at: Date; version: number }>(
      `select b.credential_id, b.ended_at, b.updated_at, e.version from public.bridges b join public.entities e on e.id = b.entity_id
        where b.entity_id = $1`, [removedBridge]);
    expect(row!.ended_at).not.toBeNull();
    expect(row!.credential_id).toBe((await bridgeRow(legacyBridge)).credential_id);
    expect({ updatedAt: row!.updated_at.toISOString(), version: Number(row!.version) }).toEqual(removedBefore);
    const triggers = await scratch.query<{ tgname: string; tgenabled: string }>(
      `select tgname, tgenabled from pg_trigger where tgrelid = 'public.bridges'::regclass and not tgisinternal order by tgname`);
    expect(triggers.filter(t => t.tgenabled !== 'O')).toEqual([]);
    expect(triggers.map(t => t.tgname)).toEqual(expect.arrayContaining(['bridges_guard', 'bridges_snapshot', 'bridges_touch', 'bridges_credential']));
    // The guard is live again: the tombstone still refuses an update.
    await expect(scratch.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`update public.bridges set purpose = 'x' where entity_id = $1`, [removedBridge]);
    })).rejects.toThrow(/removed/);
  });
});

describe('bridges.connections.offer (§2.5)', () => {
  it('refuses a second live offer of the same connection to the same space', async () => {
    const e = await refusal(offer(ownerIdentity, connection, spaceId));
    expect(e.code).toBe('conflict');
    expect(reasonOf(e)).toBe('already_offered');
  });

  it('the owner, a member, offers it to another space: a credential entity, provider whatsapp, shape connection, no bytes', async () => {
    const r = await offer(ownerIdentity, connection, otherSpace, 'browser', 'private');
    expect(r.entity.space_id).toBe(otherSpace);
    const [card] = await scratch.query<Record<string, unknown>>(
      'select title, provider, shape, visibility, status, "ownerAccountId" from public.credential_cards where entity_id = $1', [r.entity.id]);
    expect(card).toEqual({ title: '+91 …9494', provider: 'whatsapp', shape: 'connection', visibility: 'private', status: 'active', ownerAccountId: ownerAccount });
    const [row] = await scratch.query<{ bridge_connection_id: string; display_login: string | null }>(
      'select bridge_connection_id, display_login from public.space_credentials where id = $1', [r.entity.id]);
    expect(row).toEqual({ bridge_connection_id: connection, display_login: '919494@s.whatsapp.net' });
  });

  it('refuses a member who does not own the connection', async () => {
    const e = await refusal(offer(plainIdentity, connection, spaceId));
    expect(e.code).toBe('forbidden');
    expect(reasonOf(e)).toBe('not_connection_owner');
  });

  it('refuses the owner of a connection who is not a member of the space', async () => {
    const e = await refusal(offer(strangerIdentity, strangerConnection, spaceId));
    expect(e.code).toBe('forbidden');
    expect(reasonOf(e)).toBe('not_space_member');
  });

  it('is human-only', async () => {
    expect((await refusal(offer(ownerIdentity, connection, spaceId, 'agent'))).code).toBe('forbidden');
    expect((await refusal(withdraw(ownerIdentity, connection, spaceId, 'agent'))).code).toBe('forbidden');
  });

  it('a connection credential can never carry bytes, be a default, or lack its connection', async () => {
    const cred = (await bridgeRow(legacyBridge)).credential_id!;
    for (const sql of [
      `update public.space_credentials set secret_ciphertext = decode(repeat('ab', 20), 'hex'), secret_nonce = decode(repeat('ab', 12), 'hex'), key_hint = 'abcd' where id = $1`,
      'update public.space_credentials set is_default = true where id = $1',
      'update public.space_credentials set bridge_connection_id = null where id = $1',
    ]) {
      await expect(scratch.transaction(async c => { await c.query('set local role tm8_graph_owner'); await c.query(sql, [cred]); }))
        .rejects.toThrow(/check constraint/);
    }
  });
});

describe('the spawn reader refuses it (§2.5, ADR 0297)', () => {
  it('read_space_credential_for_spawn refuses whatsapp, by id or by default, as server_only', async () => {
    const cred = (await bridgeRow(legacyBridge)).credential_id!;
    for (const id of [cred, null]) {
      const e = await refusal(as(ownerIdentity, q => q.rpc('read_space_credential_for_spawn', [spaceId, 'whatsapp', id])));
      expect(e.code).toBe('forbidden');
      expect(reasonOf(e)).toBe('server_only');
    }
  });

  it('400 keeps every earlier server-only provider (318: typesafe, mcp, tool) refused by the spawn reader', async () => {
    const [def] = await scratch.query<{ all: boolean; vendor: boolean }>(
      `select bool_and(internal.is_server_only_credential_provider(p)) as all,
              bool_or(internal.is_server_only_credential_provider(v)) as vendor
         from unnest(array['typesafe','mcp','tool','whatsapp']) p, unnest(array['anthropic','openai','github']) v`);
    expect(def).toEqual({ all: true, vendor: false });
    for (const provider of ['typesafe', 'mcp', 'tool']) {
      const e = await refusal(as(ownerIdentity, q => q.rpc('read_space_credential_for_spawn', [spaceId, provider, null])));
      expect([provider, e.code, reasonOf(e)]).toEqual([provider, 'forbidden', 'server_only']);
    }
    const [checks] = await scratch.query<{ provider: string; shape: string }>(
      `select pg_get_constraintdef(p.oid) as provider, pg_get_constraintdef(s.oid) as shape
         from pg_constraint p, pg_constraint s
        where p.conname = 'space_credentials_provider_check' and s.conname = 'space_credentials_provider_shape_check'`);
    for (const p of ['anthropic', 'openai', 'github', 'typesafe', 'mcp', 'tool', 'whatsapp']) expect(checks!.provider).toContain(`'${p}'`);
    for (const pair of [`'tool'`, `'mcp'`, `'typesafe'`, `'connection'`]) expect(checks!.shape).toContain(pair);
  });

  it('a session can never record one, and there is no service key to read', async () => {
    const [def] = await scratch.query<{ server_only: boolean }>(
      `select internal.is_server_only_credential_provider('whatsapp') as server_only`);
    expect(def!.server_only).toBe(true);
    const [key] = await as(ownerIdentity, q => q.query<{ k: unknown }>(`select public.read_space_service_key($1, 'whatsapp') as k`, [spaceId]));
    expect(key!.k).toBeNull();
  });
});

describe('bridges.create fills credential_id from the offer (D32)', () => {
  it('rides the space\'s offered credential', async () => {
    const r = await createBridge(ownerIdentity, spaceId, connection, 'gaming@g.us', chatB);
    const [offered] = await scratch.query<{ id: string }>(
      `select id from public.space_credentials where bridge_connection_id = $1 and space_id = $2 and status <> 'revoked'`, [connection, spaceId]);
    expect((await bridgeRow(r.entity.id)).credential_id).toBe(offered!.id);
    const [view] = await as(ownerIdentity, q => q.query<{ v: { connectionCredentialId: string } }>('select internal.bridge_view($1) as v', [r.entity.id]));
    expect(view!.v.connectionCredentialId).toBe(offered!.id);
  });

  it('refuses a connection that is not offered to the space', async () => {
    await withdraw(ownerIdentity, connection, otherSpace);
    const e = await refusal(createBridge(ownerIdentity, otherSpace, connection, 'other@g.us', chatOther));
    expect(e.code).toBe('conflict');
    expect(reasonOf(e)).toBe('connection_not_offered');
    await offer(ownerIdentity, connection, otherSpace);
  });

  it('the credential is fixed once the bridge exists', async () => {
    const [other] = await scratch.query<{ id: string }>(
      `select id from public.space_credentials where bridge_connection_id = $1 and space_id = $2`, [connection, otherSpace]);
    await expect(scratch.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query('update public.bridges set credential_id = $2 where entity_id = $1', [legacyBridge, other!.id]);
    })).rejects.toThrow(/fixed/);
  });
});

describe('bridges.connections.withdraw (§2.5)', () => {
  let elsewhere = '';

  it('refuses anyone but the owner, and a space it is not offered to', async () => {
    elsewhere = (await createBridge(ownerIdentity, otherSpace, connection, 'elsewhere@g.us', chatOther)).entity.id;
    const e = await refusal(withdraw(plainIdentity, connection, spaceId));
    expect(reasonOf(e)).toBe('not_connection_owner');
    const none = await refusal(withdraw(strangerIdentity, strangerConnection, spaceId));
    expect(reasonOf(none)).toBe('not_offered');
  });

  it('revokes the credential and pauses every live bridge on it in that space, and only there', async () => {
    const live = (await scratch.query<{ entity_id: string }>(
      'select entity_id from public.bridges where space_id = $1 and connection_id = $2 and ended_at is null order by entity_id', [spaceId, connection]))
      .map(r => r.entity_id);
    expect(live.length).toBe(2);
    const r = await withdraw(ownerIdentity, connection, spaceId);
    expect(r.patches.map(p => p.id).sort()).toEqual([r.entity.id, ...live].sort());
    for (const id of live) expect((await bridgeRow(id)).paused_at).not.toBeNull();
    expect((await bridgeRow(elsewhere)).paused_at).toBeNull();
    const [cred] = await scratch.query<{ status: string }>('select status from public.space_credentials where id = $1', [r.entity.id]);
    expect(cred!.status).toBe('revoked');
  });

  it('a bridge on a withdrawn credential cannot resume until the owner offers it again', async () => {
    const [{ version }] = await scratch.query<{ version: number }>('select version from public.entities where id = $1', [legacyBridge]);
    const e = await refusal(as(ownerIdentity, q => q.rpc('resume_bridge', [legacyBridge, version, null, randomUUID()])));
    expect(e.code).toBe('conflict');
    expect(reasonOf(e)).toBe('connection_withdrawn');
    const before = (await bridgeRow(legacyBridge)).credential_id;
    const again = await offer(ownerIdentity, connection, spaceId);
    expect(again.entity.id).toBe(before);
    await as(ownerIdentity, q => q.rpc('resume_bridge', [legacyBridge, version, null, randomUUID()]));
    expect((await bridgeRow(legacyBridge)).paused_at).toBeNull();
  });

  it('revoking the credential by any other path pauses its bridges too', async () => {
    const cred = (await bridgeRow(elsewhere)).credential_id!;
    await scratch.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`update public.space_credentials set status = 'revoked' where id = $1`, [cred]);
    });
    expect((await bridgeRow(elsewhere)).paused_at).not.toBeNull();
  });
});

describe('bridges.connections.begin and list (§3.4)', () => {
  it('begin is human-only and makes a connecting connection owned by the caller', async () => {
    expect((await refusal(as(ownerIdentity, q => q.rpc('begin_bridge_connection', ['whatsapp', null, null, randomUUID()]), 'agent'))).code)
      .toBe('forbidden');
    const c = await as(plainIdentity, q => q.rpc<{ id: string; status: string; ownerAccountId: string; label: string; offers: unknown[] }>(
      'begin_bridge_connection', ['whatsapp', 'My phone', null, randomUUID()]));
    expect(c).toMatchObject({ status: 'connecting', ownerAccountId: plainAccount, label: 'My phone', offers: [] });
    expect(c).not.toHaveProperty('stateRef');
  });

  it('begin relinks only the caller\'s own connection, and only for a provider with a runtime', async () => {
    const e = await refusal(as(plainIdentity, q => q.rpc('begin_bridge_connection', ['whatsapp', null, connection, randomUUID()])));
    expect(reasonOf(e)).toBe('not_connection_owner');
    expect((await refusal(as(plainIdentity, q => q.rpc('begin_bridge_connection', ['slack', null, null, randomUUID()])))).code)
      .toBe('invalid_input');
    const c = await as(ownerIdentity, q => q.rpc<{ id: string; status: string }>('begin_bridge_connection', ['whatsapp', null, connection, randomUUID()]));
    expect(c).toMatchObject({ id: connection, status: 'connecting' });
  });

  it('list answers the caller\'s own connections with the spaces each is offered to', async () => {
    const mine = await as(ownerIdentity, q => q.rpc<{ id: string; offers: { spaceId: string; bridges: number }[] }[]>('list_bridge_connections', [null]));
    expect(mine.map(c => c.id)).toEqual([connection]);
    expect(mine[0]!.offers.map(o => o.spaceId)).toEqual([spaceId]);
    expect(mine[0]!.offers[0]!.bridges).toBe(2);
    const theirs = await as(strangerIdentity, q => q.rpc<{ id: string }[]>('list_bridge_connections', [null]));
    expect(theirs.map(c => c.id)).toEqual([strangerConnection]);
  });
});
