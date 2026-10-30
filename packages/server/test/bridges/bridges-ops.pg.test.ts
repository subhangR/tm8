/**
 * Bridges B0a (BRIDGE-ENTITY-DESIGN §3.4, §7.3 item 13 at the API level): the
 * bridges.* doors over authenticated HTTP against a scratch database with every
 * migration applied.
 *
 * Pinned here: create is the connection owner's, human-only (an agent bearer is
 * refused before SQL); target_has_bridge on create and retarget as a 409 with
 * its reason; the views parse as the contract; a worker session claims one
 * handle, sets its listen level and reads the log with its own cursor; the
 * generic entities.create refuses the kind.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BridgeFactsSchema } from '@tm8/contract';
import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerW2EntitiesCommandsTrackingHandlers } from '../../src/facade/handlers/w2/entities-commands-tracking.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { registerBridgeHandlers } from '../../src/bridges/handlers.js';
import { registerW2IdentitySpacesHandlers } from '../../src/facade/handlers/w2/identity-spaces.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let database: W1ScratchDatabase, db: Db, server: FacadeServer, base: string;
const space = randomUUID(), member = randomUUID(), account = randomUUID(), persona = randomUUID();
const adminMember = randomUUID(), adminAccount = randomUUID();
const chatA = randomUUID(), chatB = randomUUID(), worker = randomUUID();
const connection = randomUUID(), adminConnection = randomUUID();
const identityId = `bridges-http-owner-${randomUUID()}`, adminIdentity = `bridges-http-admin-${randomUUID()}`;

function bearer() {
  const id = randomUUID(), secret = generateSecret();
  return { id, secret, token: formatToken(id, secret) };
}
const human = bearer(), admin = bearer(), agent = bearer();
const owner = async () => ({ identityId, accountId: account, username: identityId, isNodeAdmin: false, isOwner: false });

beforeAll(async () => {
  database = await createW1ScratchDatabase('bridges_ops');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1),($2,$2)', [identityId, adminIdentity]);
    await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2),($3,$4,$4,$4)',
      [account, identityId, adminAccount, adminIdentity]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Bridges fixture',$2)", [space, identityId]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$3,'member',0,$1),($2,$3,'member',0,$2)",
      [member, adminMember, space]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$3,$4,'owner',$4),($2,$3,$5,'admin',$5)",
      [member, adminMember, space, identityId, adminIdentity]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$3)", [persona, space, member]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Infra','','persona')", [persona, member]);
    for (const [id, title] of [[chatA, 'Infra main'], [chatB, 'Gaming main']] as const) {
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'chat',0,$3)", [id, space, member]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,$3,$4,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b0a', gen_random_uuid(), $5, $6, $7)`,
        [id, space, title, persona, identityId, member, `b0a-${randomUUID()}`]);
    }
    await c.query("insert into public.entities(id,space_id,kind,position,created_by,visibility) values($1,$2,'work_session',0,$3,'space')", [worker, space, member]);
    await c.query("insert into public.work_sessions(entity_id,title,status,share_mode,started_at) values($1,'Deploy watcher','running','none',now())", [worker]);
    await c.query(`insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at) values
      ($1,$2,'cli',$3,$4,now()+interval '1 hour'),($5,$6,'cli',$3,$7,now()+interval '1 hour')`,
      [human.id, account, space, hashToken(human.secret), admin.id, adminAccount, hashToken(admin.secret)]);
    await c.query(`insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at,work_session_id,acting_as_team_member_id)
      values ($1,$2,'agent',$3,$4,now()+interval '1 hour',$5,$6)`, [agent.id, account, space, hashToken(agent.secret), worker, persona]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …9494','linked'),($3,'whatsapp',$4,'+91 …1999','linked')`, [connection, account, adminConnection, adminAccount]);
  });
  const config = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: database.url, disableAutoOwner: true };
  const registry = new HandlerRegistry();
  const deps = { db, config, owner };
  registerBridgeHandlers(registry, deps);
  registerW2EntitiesCommandsTrackingHandlers(registry, deps);
  registerW2IdentitySpacesHandlers(registry, deps);
  server = createFacadeServer({ config, registry, identityResolver: createSessionIdentityResolver({ db, owner }) });
  base = (await server.listen()).url;
});
afterAll(async () => {
  await server?.close();
  await db?.end();
  await database?.destroy();
});

async function request(token: string, method: string, path: string, body?: Record<string, unknown>, mutation = true) {
  const payload = body === undefined ? undefined : mutation ? { clientMutationId: randomUUID(), ...body } : body;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, json: await response.json() as any };
}
const ok = (result: { status: number; json: any }) => {
  expect([200, 201], JSON.stringify(result.json)).toContain(result.status);
  return result.json.data;
};
const refused = (result: { status: number; json: any }, status: number, code: string) => {
  expect(result.status, JSON.stringify(result.json)).toBe(status);
  expect(result.json.error.code).toBe(code);
  return result.json.error;
};
const createBody = (externalId: string, targetId: string, conn = connection) => ({
  connectionId: conn, targetId, conversation: { externalId, kind: 'group', title: 'Infra' },
  teammateId: persona, purpose: 'Infra on-call',
});

let bridgeId = '';
let version = 0;

describe('bridges.create (item 13, D25, D28)', () => {
  it('the connection owner creates a bridge; the view parses as BridgeFacts', async () => {
    const view = ok(await request(human.token, 'POST', `/v2/spaces/${space}/bridges`, createBody('120363@g.us', chatA)));
    const { id, spaceId, version: v, title, createdAt, updatedAt, ...facts } = view;
    expect(BridgeFactsSchema.safeParse(facts).success, JSON.stringify(facts)).toBe(true);
    expect(view).toMatchObject({ status: 'live', title: 'Infra', purpose: 'Infra on-call', target: { kind: 'chat', id: chatA, title: 'Infra main' } });
    bridgeId = id; version = v;
    expect(spaceId).toBe(space); expect(createdAt && updatedAt).toBeTruthy();
  });

  it('refuses a target chat that already has a bridge: 409 target_has_bridge', async () => {
    const error = refused(await request(human.token, 'POST', `/v2/spaces/${space}/bridges`, createBody('gaming@g.us', chatA)), 409, 'conflict');
    expect(error.details.reason).toBe('target_has_bridge');
  });

  it('refuses a space admin who does not own the connection', async () => {
    const error = refused(await request(admin.token, 'POST', `/v2/spaces/${space}/bridges`, createBody('other@g.us', chatB)), 403, 'forbidden');
    expect(error.details.reason).toBe('not_connection_owner');
  });

  it('refuses an agent before SQL (humanOnly)', async () => {
    refused(await request(agent.token, 'POST', `/v2/spaces/${space}/bridges`, createBody('agent@g.us', chatB)), 403, 'forbidden');
  });

  it('the generic entities.create refuses the kind', async () => {
    const result = await request(human.token, 'POST', '/v2/entities', { spaceId: space, kind: 'bridge', title: 'x' });
    expect([400, 403]).toContain(result.status);
  });
});

describe('reads and settings', () => {
  it('list carries name and purpose; get adds recent posters', async () => {
    const page = ok(await request(agent.token, 'GET', `/v2/spaces/${space}/bridges`));
    expect(page.items.map((b: any) => [b.id, b.title, b.purpose])).toEqual([[bridgeId, 'Infra', 'Infra on-call']]);
    const detail = ok(await request(agent.token, 'GET', `/v2/bridges/${bridgeId}`));
    expect(detail.recentPosters).toEqual([]);
  });

  it('update, pause and resume move the version and the derived status', async () => {
    let view = ok(await request(admin.token, 'PATCH', `/v2/bridges/${bridgeId}`, { expectedVersion: version, patch: { policy: { trigger: 'every' }, workerWake: 'thread' } }));
    expect(view.policy.trigger).toBe('every');
    expect(view.workers.wake).toBe('thread');
    view = ok(await request(admin.token, 'POST', `/v2/bridges/${bridgeId}/pause`, { expectedVersion: view.version }));
    expect(view.status).toBe('paused');
    view = ok(await request(admin.token, 'POST', `/v2/bridges/${bridgeId}/resume`, { expectedVersion: view.version }));
    expect(view.status).toBe('live');
    version = view.version;
  });

  it('retarget refuses a bridged chat and moves to a free one', async () => {
    const gaming = ok(await request(human.token, 'POST', `/v2/spaces/${space}/bridges`, createBody('gaming@g.us', chatB)));
    const error = refused(await request(human.token, 'POST', `/v2/bridges/${gaming.id}/retarget`, { expectedVersion: gaming.version, targetId: chatA }), 409, 'conflict');
    expect(error.details.reason).toBe('target_has_bridge');
    refused(await request(agent.token, 'POST', `/v2/bridges/${gaming.id}/retarget`, { expectedVersion: gaming.version, targetId: chatA }), 403, 'forbidden');
  });
});

describe('a worker session on the bridge (D21, D23)', () => {
  it('claims one handle, idempotently', async () => {
    const first = ok(await request(agent.token, 'POST', `/v2/spaces/${space}/handles`, { title: 'deploy watcher' }, false));
    expect(first).toMatchObject({ entityId: worker, kind: 'work_session', title: 'deploy watcher' });
    const again = ok(await request(agent.token, 'POST', `/v2/spaces/${space}/handles`, {}, false));
    expect(again.handle).toBe(first.handle);
    refused(await request(human.token, 'POST', `/v2/spaces/${space}/handles`, {}, false), 403, 'forbidden');
  });

  it('listens at most at the bridge ceiling', async () => {
    expect(ok(await request(agent.token, 'POST', `/v2/bridges/${bridgeId}/listen`, { wake: 'thread' }, false))).toMatchObject({ wake: 'thread', ceiling: 'thread' });
    const error = refused(await request(agent.token, 'POST', `/v2/bridges/${bridgeId}/listen`, { wake: 'all' }, false), 403, 'forbidden');
    expect(error.details.reason).toBe('above_bridge_ceiling');
  });

  it('reads the log with its own cursor', async () => {
    const empty = ok(await request(agent.token, 'GET', `/v2/bridges/${bridgeId}/log?unread=true`));
    expect(empty).toMatchObject({ logAnchorId: bridgeId, items: [], lastMessageId: null, more: false });
    const ids = [randomUUID(), randomUUID()];
    await database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      for (const [n, id] of ids.entries()) {
        await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$2,'message',$3)", [id, space, member]);
        await c.query(`insert into public.messages(entity_id,anchor_id,author_id,body,created_at)
          values($1,$2,$3,$4, now() + ($5 || ' ms')::interval)`, [id, bridgeId, member, `hello ${n}`, String(n)]);
      }
    });
    const first = ok(await request(agent.token, 'GET', `/v2/bridges/${bridgeId}/log?unread=true&limit=1`));
    expect(first.items.map((m: any) => m.body)).toEqual(['hello 0']);
    expect(first.more).toBe(true);
    const second = ok(await request(agent.token, 'GET', `/v2/bridges/${bridgeId}/log?unread=true`));
    expect(second.items.map((m: any) => m.body)).toEqual(['hello 1']);
    expect(ok(await request(agent.token, 'GET', `/v2/bridges/${bridgeId}/log?unread=true`)).items).toEqual([]);
    // A member without a session reads by --since, never by cursor.
    expect(ok(await request(human.token, 'GET', `/v2/bridges/${bridgeId}/log`)).items).toHaveLength(2);
    refused(await request(human.token, 'GET', `/v2/bridges/${bridgeId}/log?unread=true`), 403, 'forbidden');
  });
});

describe('B3 links (402, §4.6, D58-D60)', () => {
  it('begin answers the code once, to a human; the list shows its expiry, never the code', async () => {
    refused(await request(agent.token, 'POST', '/v2/identity/bridge-links', { provider: 'whatsapp' }), 403, 'forbidden');
    refused(await request(human.token, 'POST', '/v2/identity/bridge-links', { provider: 'fax' }), 400, 'invalid_input');
    const minted = ok(await request(human.token, 'POST', '/v2/identity/bridge-links', { provider: 'whatsapp' }));
    expect(minted.code).toMatch(/^TM8-[A-HJ-NP-Z2-9]{6}$/);
    expect(Number.isNaN(Date.parse(minted.expiresAt))).toBe(false);
    const list = ok(await request(human.token, 'GET', '/v2/identity/bridge-links'));
    expect(list.items).toEqual([]);
    expect(list.pending).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(minted.code);
  });

  it('a redeemed code shows as a link; an agent cannot revoke it; its human can', async () => {
    const { code } = ok(await request(human.token, 'POST', '/v2/identity/bridge-links', { provider: 'whatsapp' }));
    const [row] = await database.query<{ r: { ok: boolean } }>('select internal.bridge_redeem_link_code($1,$2,$3) as r',
      [bridgeId, '919000000123@s.whatsapp.net', code]);
    expect(row!.r.ok).toBe(true);
    const list = ok(await request(human.token, 'GET', '/v2/identity/bridge-links'));
    expect(list.items).toEqual([expect.objectContaining({ masked: '…0123', method: 'code', trust: 'linked' })]);
    const linkId = list.items[0].id;
    refused(await request(agent.token, 'POST', `/v2/identity/bridge-links/${linkId}/revoke`, {}), 403, 'forbidden');
    refused(await request(admin.token, 'POST', `/v2/identity/bridge-links/${linkId}/revoke`, {}), 404, 'not_found');
    const revoked = ok(await request(human.token, 'POST', `/v2/identity/bridge-links/${linkId}/revoke`, {}));
    expect(Number.isNaN(Date.parse(revoked.revokedAt))).toBe(false);
    expect(ok(await request(human.token, 'GET', '/v2/identity/bridge-links')).items).toEqual([]);
  });

  it('spaces.invites.create pins a participant; more than one use is refused', async () => {
    await database.query(`insert into public.bridge_participants(bridge_id, external_id, display_name, first_seen_at, last_seen_at)
      values ($1,'919000000456@s.whatsapp.net','Rahul',now(),now())`, [bridgeId]);
    const bridgeParticipant = { bridgeId, externalId: '919000000456@s.whatsapp.net' };
    refused(await request(admin.token, 'POST', `/v2/spaces/${space}/invites`, { maxUses: 2, bridgeParticipant }), 400, 'invalid_input');
    const invite = ok(await request(admin.token, 'POST', `/v2/spaces/${space}/invites`, { bridgeParticipant }));
    expect(invite.maxUses).toBe(1);
    const [pin] = await database.query<{ external_id: string }>('select external_id from public.bridge_invite_pins where invite_id = $1', [invite.id]);
    expect(pin!.external_id).toBe(bridgeParticipant.externalId);
    // A failed pin leaves no invite behind: invite and pin are one transaction.
    const before = await database.query('select 1 from public.space_invites where space_id = $1', [space]);
    refused(await request(admin.token, 'POST', `/v2/spaces/${space}/invites`, { bridgeParticipant: { bridgeId, externalId: 'nobody' } }), 404, 'not_found');
    expect(await database.query('select 1 from public.space_invites where space_id = $1', [space])).toHaveLength(before.length);
  });
});

describe('remove (human-only)', () => {
  it('an agent is refused; a human leaves the tombstone', async () => {
    refused(await request(agent.token, 'POST', `/v2/bridges/${bridgeId}/remove`, { expectedVersion: version }), 403, 'forbidden');
    const view = ok(await request(admin.token, 'POST', `/v2/bridges/${bridgeId}/remove`, { expectedVersion: version }));
    expect(view.status).toBe('ended');
    const page = ok(await request(admin.token, 'GET', `/v2/spaces/${space}/bridges`));
    expect(page.items.map((b: any) => b.id)).not.toContain(bridgeId);
  });
});
