/**
 * Bridges P (BRIDGE-ENTITY-DESIGN §2.4, §4.4, D50-D52; migration 404): the
 * People tab's read and write over authenticated HTTP against a scratch
 * database with every migration applied.
 *
 * Pinned here: the roster's trust words come out exactly as the inbound
 * resolver would decide them (an identity link first, a space assertion next, a
 * member who left is a guest again); a member sees masked ids and no alternate
 * ids, an admin sees them in full; no row carries a link id or an identity id.
 * The write is an admin's and a human's: mute, and the one assertion core's
 * four rules (coordinator ruling): link_conflict only over someone else's
 * verified link, the same person a no-op, revoke beside a verified link, no
 * participant row needed; plus the cross-space refusal.
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
const otherSpace = randomUUID(), otherMember = randomUUID();
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
    // Another space, where the plain member's identity is also a member.
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Elsewhere',$2)", [otherSpace, plainIdentity]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [otherMember, otherSpace]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner','Plain')", [otherMember, otherSpace, plainIdentity]);
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

const NEVER_SPOKE = '919999900000@s.whatsapp.net';
const liveLinks = async (externalId: string) => database.transaction(async c => {
  await c.query('set local role tm8_graph_owner');
  return (await c.query(`select method, identity_id, space_id from public.bridge_identity_links
                          where external_id = $1 and revoked_at is null order by method`, [externalId])).rows;
});
const reason = (result: { json: any }) => result.json.error?.details?.reason;

describe('bridges.participants.update (D52; the one core, coordinator ruling)', () => {
  it('an admin mutes and unmutes; the answer carries the row, and a repeat changes nothing', async () => {
    const muted = await patch(ownerBearer.token, GUEST, { muted: true });
    expect(muted.status, JSON.stringify(muted.json)).toBe(200);
    expect(muted.json.data).toMatchObject({ bridgeId, externalId: GUEST, changed: true, participant: { externalId: GUEST, muted: true, trust: 'guest' } });
    expect((await patch(ownerBearer.token, GUEST, { muted: true })).json.data.changed).toBe(false);
    expect((await patch(ownerBearer.token, GUEST, { muted: false })).json.data.participant.muted).toBe(false);
  });

  it('asserts who a guest is, refuses another member over that assertion, then revokes it', async () => {
    const asserted = await patch(ownerBearer.token, GUEST, { memberId: plainMember });
    expect(asserted.status, JSON.stringify(asserted.json)).toBe(200);
    expect(asserted.json.data).toMatchObject({ changed: true, participant: { trust: 'asserted', memberId: plainMember, link: { method: 'admin' } } });
    expect(byName((await roster(plainBearer.token)).items, 'Rahul')).toMatchObject({ trust: 'asserted', you: true });
    expect((await patch(ownerBearer.token, GUEST, { memberId: plainMember })).json.data.changed).toBe(false);
    const other = await patch(ownerBearer.token, GUEST, { memberId: ownerMember });
    expect(other.status, JSON.stringify(other.json)).toBe(409);
    expect(reason(other)).toBe('link_conflict');

    const revoked = await patch(ownerBearer.token, GUEST, { memberId: null });
    expect(revoked.json.data).toMatchObject({ changed: true, participant: { trust: 'guest', memberId: null } });
    expect((await patch(ownerBearer.token, GUEST, { memberId: null })).json.data.changed).toBe(false);
  });

  it('(1) refuses link_conflict when a verified link names someone else', async () => {
    const result = await patch(ownerBearer.token, LINKED_LID, { memberId: ownerMember });
    expect(result.status, JSON.stringify(result.json)).toBe(409);
    expect(reason(result)).toBe('link_conflict');
  });

  it('(2) asserting the same person as their verified link is a no-op', async () => {
    const result = await patch(ownerBearer.token, LINKED_LID, { memberId: plainMember });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(result.json.data.changed).toBe(false);
    expect((await liveLinks(LINKED_LID)).map(l => l.method)).toEqual(['code']);
  });

  it('(3) revoking an admin assertion is allowed beside a verified link, and ends only the assertion', async () => {
    await database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, space_id, verified_at)
                     values ('whatsapp', $1, $2, 'admin', $3, now())`, [LINKED_LID, plainIdentity, space]);
    });
    expect((await liveLinks(LINKED_LID)).map(l => l.method)).toEqual(['admin', 'code']);
    const result = await patch(ownerBearer.token, LINKED_LID, { memberId: null });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(result.json.data.changed).toBe(true);
    expect((await liveLinks(LINKED_LID)).map(l => l.method)).toEqual(['code']);
    expect(byName((await roster(ownerBearer.token)).items, 'Plain')).toMatchObject({ trust: 'linked' });
  });

  it('(4) needs no participant row to assert; mute does', async () => {
    const result = await patch(ownerBearer.token, NEVER_SPOKE, { memberId: plainMember });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(result.json.data).toMatchObject({ externalId: NEVER_SPOKE, changed: true, participant: null });
    expect(await liveLinks(NEVER_SPOKE)).toEqual([{ method: 'admin', identity_id: plainIdentity, space_id: space }]);
    expect((await patch(ownerBearer.token, NEVER_SPOKE, { muted: true })).status).toBe(404);
  });

  it('refuses a member of another space, a member who left, and an address that is not a person', async () => {
    const cross = await patch(ownerBearer.token, GUEST, { memberId: otherMember });
    expect(cross.status, JSON.stringify(cross.json)).toBe(404);
    expect((await patch(ownerBearer.token, GUEST, { memberId: leftMember })).status).toBe(404);
    expect((await patch(ownerBearer.token, '120363@g.us', { memberId: plainMember })).status).toBe(400);
    expect(await liveLinks(GUEST)).toEqual([]);
  });

  it('is an admin\'s and a human\'s: a plain member and an agent are refused', async () => {
    expect((await patch(plainBearer.token, GUEST, { muted: true })).status).toBe(403);
    expect((await patch(agentBearer.token, GUEST, { muted: true })).status).toBe(403);
    expect(byName((await roster(ownerBearer.token)).items, 'Rahul').muted).toBe(false);
  });
});

// Cross-space probes, written by #1439's reviewer (round 1) and folded in here.
describe('cross-space: one space\'s admin and assertions never reach another', () => {
  const spaceB = randomUUID(), personaB = randomUUID(), chatB = randomUUID();
  const ownerInB = randomUUID(), adminB = randomUUID(), memberB = randomUUID();
  const adminBIdentity = `bp-adminb-${randomUUID()}`, memberBIdentity = `bp-memberb-${randomUUID()}`;
  const adminBAccount = randomUUID();
  const adminBBearer = bearer(), ownerBBearer = bearer();
  let bridgeB = '';
  beforeAll(async () => {
    await database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1),($2,$2)', [adminBIdentity, memberBIdentity]);
      await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2)', [adminBAccount, adminBIdentity]);
      await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Other',$2)", [spaceB, ownerIdentity]);
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$4,'member',0,$1),($2,$4,'member',0,$2),($3,$4,'member',0,$3)",
        [ownerInB, adminB, memberB, spaceB]);
      await c.query(`insert into public.members(entity_id,space_id,identity_id,role,display_name) values
        ($1,$4,$5,'owner','OwnerB'),($2,$4,$6,'admin','AdminB'),($3,$4,$7,'member','MemberB')`,
        [ownerInB, adminB, memberB, spaceB, ownerIdentity, adminBIdentity, memberBIdentity]);
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$3)", [personaB, spaceB, ownerInB]);
      await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'InfraB','','persona')", [personaB, ownerInB]);
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'chat',0,$3)", [chatB, spaceB, ownerInB]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,'B main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/bpb', gen_random_uuid(), $4, $5, $6)`,
        [chatB, spaceB, personaB, ownerIdentity, ownerInB, `bpb-${randomUUID()}`]);
      await c.query(`insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at) values
        ($1,$2,'cli',$3,$4,now()+interval '1 hour'),($5,$6,'cli',$3,$7,now()+interval '1 hour')`,
        [adminBBearer.id, adminBAccount, spaceB, hashToken(adminBBearer.secret), ownerBBearer.id, ownerAccount, hashToken(ownerBBearer.secret)]);
    });
    const created = await request(ownerBBearer.token, 'POST', `/v2/spaces/${spaceB}/bridges`, {
      clientMutationId: randomUUID(), connectionId: connection, targetId: chatB,
      conversation: { externalId: '120364@g.us', kind: 'group', title: 'Other' }, teammateId: personaB,
    });
    expect([200, 201], JSON.stringify(created.json)).toContain(created.status);
    bridgeB = created.json.data.id;
    await database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.bridge_participants(bridge_id, external_id, display_name, first_seen_at, last_seen_at, message_count)
        values ($1,$2,'Rahul',now(),now(),1)`, [bridgeB, GUEST]);
    });
  });
  const links = async () => (await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    return (await c.query("select external_id, identity_id, space_id::text, revoked_at from public.bridge_identity_links where method='admin' order by verified_at")).rows;
  }));

  it('an admin of another space cannot touch this bridge', async () => {
    const before = await links();
    const r = await patch(adminBBearer.token, GUEST, { memberId: plainMember });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await links()).toEqual(before);
    const read = await request(adminBBearer.token, 'GET', `/v2/bridges/${bridgeId}/participants`);
    expect(read.status).not.toBe(200);
  });
  it('an admin of both, pinned to A, cannot write B through an A session', async () => {
    const r = await request(ownerBearer.token, 'PATCH', `/v2/bridges/${bridgeB}/participants/${encodeURIComponent(GUEST)}`, { clientMutationId: randomUUID(), patch: { muted: true } });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
  it('asserting a member of another space is refused', async () => {
    const before = await links();
    const r = await patch(ownerBearer.token, GUEST, { memberId: memberB });
    expect(r.status, JSON.stringify(r.json)).toBe(404);
    expect(await links()).toEqual(before);
  });
  it("an assertion in A does not count in B's bridge, on the same number", async () => {
    const a = await patch(ownerBearer.token, GUEST, { memberId: plainMember });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const inB = await request(ownerBBearer.token, 'GET', `/v2/bridges/${bridgeB}/participants`);
    expect(inB.status).toBe(200);
    expect(inB.json.data.items[0]).toMatchObject({ externalId: GUEST, trust: 'guest', memberId: null });
    await patch(ownerBearer.token, GUEST, { memberId: null });
  });
  it('the activity row names the participant masked', async () => {
    const rows = await database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      return (await c.query("select summary::text as p from public.activity where entity_id = $1 order by created_at", [bridgeId])).rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) for (const s of [GUEST, LINKED, ASSERTED]) expect(r.p).not.toContain(s);
  });
  it('a stale assertion can be revoked after the real owner links the number (review F2)', async () => {
    // Admin asserts GUEST as plainMember; later the real owner links the number themselves.
    expect((await patch(ownerBearer.token, GUEST, { memberId: plainMember })).status).toBe(200);
    await database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query("insert into public.bridge_identity_links(provider, external_id, identity_id, method, space_id, verified_at) values ('whatsapp',$1,$2,'code',null,now())", [GUEST, ownerIdentity]);
    });
    const revoke = await patch(ownerBearer.token, GUEST, { memberId: null });
    expect(revoke.status, JSON.stringify(revoke.json)).toBe(200);
    expect(revoke.json.data).toMatchObject({ changed: true, participant: { trust: 'linked' } });
  });
});
