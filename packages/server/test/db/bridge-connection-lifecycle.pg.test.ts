/**
 * Bridges B1b-7 (migration 401, BRIDGE-ENTITY-DESIGN §2.5, §3.4, D28): the
 * owner leaving a space pauses their bridges there (DB-driven, so the 398
 * allowlist push follows) and keeps them paused; removing a connection ends
 * every bridge on it and revokes its offers; the runtime a connection is on is
 * told to its owner only.
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
const ownerMember = randomUUID(), ownerOtherMember = randomUUID(), adminMember = randomUUID();
const ownerIdentity = `life-owner-${randomUUID()}`, adminIdentity = `life-admin-${randomUUID()}`;
const ownerAccount = randomUUID(), adminAccount = randomUUID();
const teammate = randomUUID(), otherTeammate = randomUUID();
const chatA = randomUUID(), chatB = randomUUID(), chatOther = randomUUID();
const connection = randomUUID();
let infra = '', gaming = '', elsewhere = '';

type Kind = 'browser' | 'cli' | 'agent';
const as = <T>(identityId: string, fn: (q: Querier) => Promise<T>, authKind: Kind = 'browser') =>
  db.tx({ identityId, authKind, requestId: randomUUID() }, fn);
interface Refusal { code?: string; details?: Record<string, unknown> }
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (err) { return err as Refusal; }
  throw new Error('expected a refusal');
}
const reasonOf = (e: Refusal) => e.details?.['reason'];
const createBridge = (space: string, externalId: string, target: string) =>
  as(ownerIdentity, q => q.rpc<{ entity: { id: string } }>('create_bridge', [
    space, connection, externalId, JSON.stringify({ kind: 'group', title: externalId, memberCount: 3 }), target,
    '{}', null, null, null, true, null, null, randomUUID(),
  ]));
const row = async (id: string) => (await scratch.query<{ paused_at: Date | null; ended_at: Date | null }>(
  'select paused_at, ended_at from public.bridges where entity_id = $1', [id]))[0]!;
const version = async (id: string) => Number((await scratch.query<{ v: number }>('select version as v from public.entities where id = $1', [id]))[0]!.v);
const asOwner = (sql: string, params: unknown[]) => scratch.transaction(async c => {
  await c.query('set local role tm8_graph_owner');
  await c.query(sql, params);
});

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('bridge_lifecycle');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner'),($2,'Admin')`, [ownerIdentity, adminIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username, is_node_admin) values ($1,$2,'life-owner',false),($3,$4,'life-admin',true)`,
      [ownerAccount, ownerIdentity, adminAccount, adminIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Life',$3),($2,'Other',$3)`, [spaceId, otherSpace, adminIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$4,'member',$1),($2,$4,'member',$2),($3,$5,'member',$3)`,
      [ownerMember, adminMember, ownerOtherMember, spaceId, otherSpace]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values
      ($1,$4,$5,'admin','Owner'),($2,$4,$6,'owner','Admin'),($3,$7,$5,'owner','Owner')`,
      [ownerMember, adminMember, ownerOtherMember, spaceId, ownerIdentity, adminIdentity, otherSpace]);
    for (const [id, space, by] of [[teammate, spaceId, ownerMember], [otherTeammate, otherSpace, ownerOtherMember]] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [id, space, by]);
      await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1,$2,'T','worker','persona')`, [id, by]);
    }
    for (const [id, space, by, tm] of [[chatA, spaceId, ownerMember, teammate], [chatB, spaceId, ownerMember, teammate],
      [chatOther, otherSpace, ownerOtherMember, otherTeammate]] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [id, space, by]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,'Chat',$6,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b1b7', gen_random_uuid(), $3, $4, $5)`,
        [id, space, ownerIdentity, by, `b1b7-${randomUUID()}`, tm]);
    }
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status, runtime_id)
      values ($1,'whatsapp',$2,'+91 …9494','linked','wa-life')`, [connection, ownerAccount]);
  });
  for (const space of [spaceId, otherSpace]) {
    await as(ownerIdentity, q => q.rpc('offer_bridge_connection', [connection, space, 'public', null, randomUUID()]));
  }
  infra = (await createBridge(spaceId, 'infra@g.us', chatA)).entity.id;
  gaming = (await createBridge(spaceId, 'gaming@g.us', chatB)).entity.id;
  elsewhere = (await createBridge(otherSpace, 'other@g.us', chatOther)).entity.id;
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

describe('the owner leaves the space (§2.5, ac1)', () => {
  it('leave_space revokes their offer and pauses every bridge on their number in that space, and only there', async () => {
    await as(ownerIdentity, q => q.rpc('leave_space', [spaceId, randomUUID()]));
    expect((await row(infra)).paused_at).not.toBeNull();
    expect((await row(gaming)).paused_at).not.toBeNull();
    expect((await row(elsewhere)).paused_at).toBeNull();
    const offers = await scratch.query<{ space_id: string; status: string }>(
      'select space_id, status from public.space_credentials where bridge_connection_id = $1 order by status', [connection]);
    expect(offers).toEqual(expect.arrayContaining([{ space_id: spaceId, status: 'revoked' }, { space_id: otherSpace, status: 'active' }]));
  });

  it('a bridge stays paused while its owner is not a member; once back and offered again, it resumes', async () => {
    const blocked = await refusal(as(adminIdentity, async q => q.rpc('resume_bridge', [infra, await version(infra), null, randomUUID()])));
    expect(blocked.code).toBe('conflict');
    expect(reasonOf(blocked)).toBe('owner_not_member');
    await asOwner(`update public.members set status = 'active', left_at = null where entity_id = $1`, [ownerMember]);
    const withdrawn = await refusal(as(adminIdentity, async q => q.rpc('resume_bridge', [infra, await version(infra), null, randomUUID()])));
    expect(reasonOf(withdrawn)).toBe('connection_withdrawn');
    await as(ownerIdentity, q => q.rpc('offer_bridge_connection', [connection, spaceId, 'public', null, randomUUID()]));
    await as(adminIdentity, async q => q.rpc('resume_bridge', [infra, await version(infra), null, randomUUID()]));
    expect((await row(infra)).paused_at).toBeNull();
  });

  it('being removed by an admin (remove_space_member) pauses them too', async () => {
    await as(adminIdentity, q => q.rpc('remove_space_member', [spaceId, ownerMember, randomUUID()]));
    expect((await row(infra)).paused_at).not.toBeNull();
    const blocked = await refusal(as(adminIdentity, async q => q.rpc('resume_bridge', [infra, await version(infra), null, randomUUID()])));
    expect(blocked.code).toBe('conflict');
    expect(reasonOf(blocked)).toBe('owner_not_member');
    await asOwner(`update public.members set status = 'active', left_at = null where entity_id = $1`, [ownerMember]);
    await as(ownerIdentity, q => q.rpc('offer_bridge_connection', [connection, spaceId, 'public', null, randomUUID()]));
  });
});

describe('where the group list comes from (D28, ac3)', () => {
  it('the owner learns the runtime; a node admin who is not the owner, and an agent, are refused', async () => {
    const mine = await as(ownerIdentity, q => q.rpc<{ runtimeId: string }>('bridge_connection_for_owner', [connection]));
    expect(mine).toMatchObject({ id: connection, runtimeId: 'wa-life', status: 'linked' });
    const admin = await refusal(as(adminIdentity, q => q.rpc('bridge_connection_for_owner', [connection])));
    expect(reasonOf(admin)).toBe('not_connection_owner');
    expect((await refusal(as(ownerIdentity, q => q.rpc('bridge_connection_for_owner', [connection]), 'agent'))).code).toBe('forbidden');
  });
});

describe('bridges.connections.remove (§2.5, ac2)', () => {
  it('is the owner\'s and human-only', async () => {
    expect(reasonOf(await refusal(as(adminIdentity, q => q.rpc('remove_bridge_connection', [connection, randomUUID()]))))).toBe('not_connection_owner');
    expect((await refusal(as(ownerIdentity, q => q.rpc('remove_bridge_connection', [connection, randomUUID()]), 'agent'))).code).toBe('forbidden');
  });

  it('ends every bridge on the connection, in every space, revokes every offer, and marks it removed', async () => {
    const r = await as(ownerIdentity, q => q.rpc<{ endedBridgeIds: string[]; revokedCredentialIds: string[]; connection: { status: string } }>(
      'remove_bridge_connection', [connection, randomUUID()]));
    expect([...r.endedBridgeIds].sort()).toEqual([infra, gaming, elsewhere].sort());
    expect(r.revokedCredentialIds).toHaveLength(2);
    expect(r.connection.status).toBe('removed');
    for (const id of [infra, gaming, elsewhere]) expect((await row(id)).ended_at).not.toBeNull();
    const [live] = await scratch.query<{ n: number }>(
      `select count(*)::int as n from public.space_credentials where bridge_connection_id = $1 and status <> 'revoked'`, [connection]);
    expect(live!.n).toBe(0);
  });

  it('a removed connection cannot be removed, relinked, offered or listed', async () => {
    expect((await refusal(as(ownerIdentity, q => q.rpc('remove_bridge_connection', [connection, randomUUID()])))).code).toBe('invalid_input');
    expect((await refusal(as(ownerIdentity, q => q.rpc('begin_bridge_connection', ['whatsapp', null, connection, randomUUID()])))).code).toBe('invalid_input');
    expect((await refusal(as(ownerIdentity, q => q.rpc('offer_bridge_connection', [connection, spaceId, 'public', null, randomUUID()])))).code)
      .toBe('invalid_input');
    expect((await refusal(as(ownerIdentity, q => q.rpc('bridge_connection_for_owner', [connection])))).code).toBe('not_found');
    const mine = await as(ownerIdentity, q => q.rpc<{ id: string }[]>('list_bridge_connections', [null]));
    expect(mine.map(c => c.id)).not.toContain(connection);
  });
});
