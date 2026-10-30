/**
 * Bridges P (BRIDGE-ENTITY-DESIGN §2.4, §4.4, D50-D52; migration 404): the
 * People tab's read and write over authenticated HTTP against a scratch
 * database with every migration applied.
 *
 * Pinned here: the roster's trust words come out exactly as the inbound
 * resolver would decide them (an identity link first, a space assertion next, a
 * member who left is a guest again); a member sees masked ids and no alternate
 * ids, an admin sees them in full; no row carries a link id or an identity id.
 * The write is an admin's and a human's: mute, assert, revoke, and
 * `already_linked` over a person's own link.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { registerBridgeHandlers } from '../../src/bridges/handlers.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let database: W1ScratchDatabase, db: Db, server: FacadeServer, base: string;
const space = randomUUID(), persona = randomUUID(), chat = randomUUID(), worker = randomUUID(), connection = randomUUID();
const ownerMember = randomUUID(), plainMember = randomUUID(), leftMember = randomUUID();
const ownerAccount = randomUUID(), plainAccount = randomUUID();
const ownerIdentity = `bp-owner-${randomUUID()}`, plainIdentity = `bp-plain-${randomUUID()}`, leftIdentity = `bp-left-${randomUUID()}`;
// Phone-shaped ids; the plain member's own number also has a LID alternate.
const LINKED = '919876500001@s.whatsapp.net', LINKED_LID = '207761234567890@lid';
const ASSERTED = '447700900123@s.whatsapp.net', GUEST = '919811109494@s.whatsapp.net', LEFT = '14155550142@s.whatsapp.net';

function bearer() {
  const id = randomUUID(), secret = generateSecret();
  return { id, secret, token: formatToken(id, secret) };
}
const ownerBearer = bearer(), plainBearer = bearer(), agentBearer = bearer();
const owner = async () => ({ identityId: ownerIdentity, accountId: ownerAccount, username: ownerIdentity, isNodeAdmin: false, isOwner: false });
let bridgeId = '';

beforeAll(async () => {
  database = await createW1ScratchDatabase('bridge_participants');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1),($2,$2),($3,$3)', [ownerIdentity, plainIdentity, leftIdentity]);
    await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2),($3,$4,$4,$4)',
      [ownerAccount, ownerIdentity, plainAccount, plainIdentity]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'People fixture',$2)", [space, ownerIdentity]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$4,'member',0,$1),($2,$4,'member',0,$2),($3,$4,'member',0,$3)",
      [ownerMember, plainMember, leftMember, space]);
    await c.query(`insert into public.members(entity_id,space_id,identity_id,role,display_name) values
      ($1,$4,$5,'owner','Owner'),($2,$4,$6,'member','Plain'),($3,$4,$7,'member','Leaver')`,
      [ownerMember, plainMember, leftMember, space, ownerIdentity, plainIdentity, leftIdentity]);
    await c.query("update public.members set status = 'left', left_at = now() where entity_id = $1", [leftMember]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$3)", [persona, space, ownerMember]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Infra','','persona')", [persona, ownerMember]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'chat',0,$3)", [chat, space, ownerMember]);
    await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
        chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
      values ($1,$2,'Infra main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/bp', gen_random_uuid(), $4, $5, $6)`,
      [chat, space, persona, ownerIdentity, ownerMember, `bp-${randomUUID()}`]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by,visibility) values($1,$2,'work_session',0,$3,'space')", [worker, space, ownerMember]);
    await c.query("insert into public.work_sessions(entity_id,title,status,share_mode,started_at) values($1,'Roster bot','running','none',now())", [worker]);
    await c.query(`insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at) values
      ($1,$2,'cli',$3,$4,now()+interval '1 hour'),($5,$6,'cli',$3,$7,now()+interval '1 hour')`,
      [ownerBearer.id, ownerAccount, space, hashToken(ownerBearer.secret), plainBearer.id, plainAccount, hashToken(plainBearer.secret)]);
    await c.query(`insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at,work_session_id,acting_as_team_member_id)
      values ($1,$2,'agent',$3,$4,now()+interval '1 hour',$5,$6)`, [agentBearer.id, ownerAccount, space, hashToken(agentBearer.secret), worker, persona]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …9494','linked')`, [connection, ownerAccount]);
  });
  const config = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: database.url, disableAutoOwner: true };
  const registry = new HandlerRegistry();
  registerBridgeHandlers(registry, { db, config, owner });
  server = createFacadeServer({ config, registry, identityResolver: createSessionIdentityResolver({ db, owner }) });
  base = (await server.listen()).url;

  const created = await request(ownerBearer.token, 'POST', `/v2/spaces/${space}/bridges`, {
    clientMutationId: randomUUID(), connectionId: connection, targetId: chat,
    conversation: { externalId: '120363@g.us', kind: 'group', title: 'Infra' }, teammateId: persona,
  });
  expect([200, 201], JSON.stringify(created.json)).toContain(created.status);
  bridgeId = created.json.data.id;

  // B1b's inbound fills these; until then the fixture writes them as the graph owner.
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.bridge_participants(bridge_id, external_id, alt_external_ids, display_name, first_seen_at, last_seen_at, message_count) values
      ($1,$2,$3,'Plain',now()-interval '9 days',now()-interval '1 minute',214),
      ($1,$4,'{}','Owner',now()-interval '9 days',now()-interval '1 hour',58),
      ($1,$5,'{}','Rahul',now()-interval '2 days',now()-interval '20 minutes',37),
      ($1,$6,'{}','Leaver',now()-interval '30 days',now()-interval '3 days',4)`,
      [bridgeId, LINKED, [LINKED_LID], ASSERTED, GUEST, LEFT]);
    // The plain member linked their own number (by its LID: the resolver reads alternates too).
    await c.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, space_id, verified_at) values
      ('whatsapp',$1,$2,'code',null,now()-interval '2 days'),
      ('whatsapp',$3,$4,'admin',$5,now()-interval '1 day'),
      ('whatsapp',$6,$7,'code',null,now()-interval '20 days')`,
      [LINKED_LID, plainIdentity, ASSERTED, ownerIdentity, space, LEFT, leftIdentity]);
  });
});
afterAll(async () => {
  await server?.close();
  await db?.end();
  await database?.destroy();
});

async function request(token: string, method: string, path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as any };
}
const roster = async (token: string) => {
  const result = await request(token, 'GET', `/v2/bridges/${bridgeId}/participants`);
  expect(result.status, JSON.stringify(result.json)).toBe(200);
  return result.json.data as { bridgeId: string; spaceId: string; admin: boolean; items: any[] };
};
const byName = (items: any[], name: string) => items.find(p => p.displayName === name);
const patch = (token: string, externalId: string, body: Record<string, unknown>) =>
  request(token, 'PATCH', `/v2/bridges/${bridgeId}/participants/${encodeURIComponent(externalId)}`, { clientMutationId: randomUUID(), patch: body });

describe('bridges.participants.list (D50)', () => {
  it('a member sees the resolver\'s trust words over masked ids, and no link internals', async () => {
    const page = await roster(plainBearer.token);
    expect(page).toMatchObject({ bridgeId, spaceId: space, admin: false });
    expect(page.items.map(p => p.displayName)).toEqual(['Plain', 'Rahul', 'Owner', 'Leaver']);
    expect(byName(page.items, 'Plain')).toMatchObject({
      externalId: '…0001', altExternalIds: [], masked: true, trust: 'linked', memberId: plainMember, you: true,
      member: { id: plainMember, kind: 'member' }, link: { method: 'code' }, messageCount: 214,
    });
    expect(byName(page.items, 'Owner')).toMatchObject({ externalId: '…0123', trust: 'asserted', memberId: ownerMember, you: false, link: { method: 'admin' } });
    expect(byName(page.items, 'Rahul')).toMatchObject({ externalId: '…9494', trust: 'guest', memberId: null, member: null, link: null });
    // A member who left is a guest again, as on inbound.
    expect(byName(page.items, 'Leaver')).toMatchObject({ trust: 'guest', memberId: null });
    const raw = JSON.stringify(page);
    for (const secret of [LINKED, LINKED_LID, ASSERTED, GUEST, LEFT, plainIdentity, ownerIdentity, leftIdentity]) {
      expect(raw).not.toContain(secret);
    }
    for (const p of page.items) expect(Object.keys(p.link ?? {}).sort()).toEqual(p.link ? ['method', 'verifiedAt'] : []);
  });

  it('an admin sees ids in full, alternates included', async () => {
    const page = await roster(ownerBearer.token);
    expect(page.admin).toBe(true);
    expect(byName(page.items, 'Plain')).toMatchObject({ externalId: LINKED, altExternalIds: [LINKED_LID], masked: false, you: false });
    expect(byName(page.items, 'Owner')).toMatchObject({ externalId: ASSERTED, you: true });
  });

  it('an agent session in the space may read the roster', async () => {
    const result = await request(agentBearer.token, 'GET', `/v2/bridges/${bridgeId}/participants`);
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(result.json.data.items).toHaveLength(4);
  });
});

describe('bridges.participants.update (D52)', () => {
  it('an admin mutes and unmutes; the answer is the row', async () => {
    const muted = await patch(ownerBearer.token, GUEST, { muted: true });
    expect(muted.status, JSON.stringify(muted.json)).toBe(200);
    expect(muted.json.data).toMatchObject({ externalId: GUEST, muted: true, trust: 'guest' });
    expect((await patch(ownerBearer.token, GUEST, { muted: false })).json.data.muted).toBe(false);
  });

  it('an admin asserts who a guest is, then revokes it', async () => {
    const asserted = await patch(ownerBearer.token, GUEST, { memberId: plainMember });
    expect(asserted.status, JSON.stringify(asserted.json)).toBe(200);
    expect(asserted.json.data).toMatchObject({ trust: 'asserted', memberId: plainMember, link: { method: 'admin' } });
    expect(byName((await roster(plainBearer.token)).items, 'Rahul')).toMatchObject({ trust: 'asserted', you: true });

    const revoked = await patch(ownerBearer.token, GUEST, { memberId: null });
    expect(revoked.json.data).toMatchObject({ trust: 'guest', memberId: null });
  });

  it('refuses an assertion over a person\'s own link, and one naming a member who left', async () => {
    const linked = await patch(ownerBearer.token, LINKED, { memberId: ownerMember });
    expect(linked.status, JSON.stringify(linked.json)).toBe(409);
    expect(linked.json.error.details?.reason).toBe('already_linked');
    expect((await patch(ownerBearer.token, GUEST, { memberId: leftMember })).status).toBe(400);
    expect((await patch(ownerBearer.token, 'nobody@s.whatsapp.net', { muted: true })).status).toBe(404);
  });

  it('is an admin\'s and a human\'s: a plain member and an agent are refused', async () => {
    expect((await patch(plainBearer.token, GUEST, { muted: true })).status).toBe(403);
    expect((await patch(agentBearer.token, GUEST, { muted: true })).status).toBe(403);
    expect(byName((await roster(ownerBearer.token)).items, 'Rahul').muted).toBe(false);
  });
});
