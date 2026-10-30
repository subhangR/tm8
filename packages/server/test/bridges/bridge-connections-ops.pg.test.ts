/**
 * Bridges B1b-5 (§2.5, §3.4, §7.3 item 8; migration 400): bridges.connections.*
 * over authenticated HTTP, with a real event socket on the same server.
 *
 * Pinned here: begin's pairing code reaches the begin caller's own human
 * socket and no other (not a second member's, not an agent bearer of the same
 * person), and is in no stored row a poll or replay reads (workspace_events,
 * command_ledger); begin, offer and withdraw are human-only and the owner's;
 * the views parse as the contract.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BridgeConnectionViewSchema, type AuthFrame } from '@tm8/contract';
import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { createSessionIdentityResolver, createSocketIdentityResolver } from '../../src/http/identity-resolver.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { registerBridgeHandlers } from '../../src/bridges/handlers.js';
import { ConnectionAuthRelay, type BridgeRuntimeLink } from '../../src/bridges/connection-auth.js';
import { SubscriptionRegistry, createWsServer } from '../../src/events/index.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let database: W1ScratchDatabase, db: Db, server: FacadeServer, base: string;
const space = randomUUID(), member = randomUUID(), otherMember = randomUUID(), account = randomUUID(), otherAccount = randomUUID();
const persona = randomUUID(), worker = randomUUID();
const identityId = `conn-http-owner-${randomUUID()}`, otherIdentity = `conn-http-other-${randomUUID()}`;
const PAIRING = `PAIR-${randomUUID().slice(0, 8)}`;

function bearer() {
  const id = randomUUID(), secret = generateSecret();
  return { id, secret, token: formatToken(id, secret) };
}
const human = bearer(), other = bearer(), agent = bearer();
const owner = async () => ({ identityId, accountId: account, username: identityId, isNodeAdmin: false, isOwner: false });

const subscriptions = new SubscriptionRegistry();
const relay = new ConnectionAuthRelay(subscriptions);
const connects: string[] = [];
const runtime: BridgeRuntimeLink = {
  async connect({ connectionId }) {
    connects.push(connectionId);
    // The runtime answers with its auth frame as soon as it is asked.
    const frame: AuthFrame = { connectionId, pairingCode: PAIRING, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    setTimeout(() => relay.relay(frame), 20);
    return { runtimeId: 'rt-test' };
  },
};

beforeAll(async () => {
  database = await createW1ScratchDatabase('bridge_conn_ops');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1),($2,$2)', [identityId, otherIdentity]);
    await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2),($3,$4,$4,$4)',
      [account, identityId, otherAccount, otherIdentity]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Connections fixture',$2)", [space, identityId]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$3,'member',0,$1),($2,$3,'member',0,$2)",
      [member, otherMember, space]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$3,$4,'owner',$4),($2,$3,$5,'member',$5)",
      [member, otherMember, space, identityId, otherIdentity]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$3)", [persona, space, member]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Infra','','persona')", [persona, member]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by,visibility) values($1,$2,'work_session',0,$3,'space')", [worker, space, member]);
    await c.query("insert into public.work_sessions(entity_id,title,status,share_mode,started_at) values($1,'Worker','running','none',now())", [worker]);
    await c.query(`insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at) values
      ($1,$2,'cli',$3,$4,now()+interval '1 hour'),($5,$6,'cli',$3,$7,now()+interval '1 hour')`,
      [human.id, account, space, hashToken(human.secret), other.id, otherAccount, hashToken(other.secret)]);
    await c.query(`insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at,work_session_id,acting_as_team_member_id)
      values ($1,$2,'agent',$3,$4,now()+interval '1 hour',$5,$6)`, [agent.id, account, space, hashToken(agent.secret), worker, persona]);
  });
  const config = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: database.url, disableAutoOwner: true };
  const registry = new HandlerRegistry();
  registerBridgeHandlers(registry, { db, config, owner }, { runtime, connectionAuth: relay });
  const identityResolver = createSessionIdentityResolver({ db, owner });
  const ws = createWsServer({ registry: subscriptions, authorize: createSocketIdentityResolver(identityResolver, true) });
  server = createFacadeServer({ config, registry, identityResolver, upgrades: ws });
  base = (await server.listen()).url;
});
afterAll(async () => {
  await server?.close();
  await db?.end();
  await database?.destroy();
});

async function request(token: string, method: string, path: string, body?: Record<string, unknown>) {
  const payload = body === undefined ? undefined : { clientMutationId: randomUUID(), ...body };
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

/** A real event socket authenticated as `token`, collecting every frame it is sent. */
async function socket(token: string): Promise<{ frames: string[]; close: () => void }> {
  const url = new URL('/v2/ws', base);
  url.protocol = 'ws:';
  const ws = new WebSocket(url.href, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
  const frames: string[] = [];
  ws.addEventListener('message', e => frames.push(String(e.data)));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('socket refused')), { once: true });
  });
  return { frames, close: () => ws.close() };
}
const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 25));
  }
};

let connectionId = '';

describe('bridges.connections.begin (§2.5, §7.3 item 8)', () => {
  it('relays the pairing code to the begin caller\'s own socket only, and stores it nowhere', async () => {
    const mine = await socket(human.token), theirs = await socket(other.token), myAgent = await socket(agent.token);
    await until(() => subscriptions.size() === 3);
    const result = ok(await request(human.token, 'POST', '/v2/me/bridge-connections', { provider: 'whatsapp', label: 'Infra phone' }));
    expect(result.runtime).toBe('connecting');
    expect(BridgeConnectionViewSchema.safeParse(result.connection).success, JSON.stringify(result.connection)).toBe(true);
    expect(result.connection).toMatchObject({ status: 'connecting', label: 'Infra phone', ownerAccountId: account, runtimeId: 'rt-test' });
    expect(JSON.stringify(result)).not.toContain(PAIRING);
    connectionId = result.connection.id;
    expect(connects).toEqual([connectionId]);

    await until(() => mine.frames.some(f => f.includes(PAIRING)));
    expect(JSON.parse(mine.frames.find(f => f.includes(PAIRING))!)).toMatchObject(
      { type: 'bridge.connection.auth', connectionId, pairingCode: PAIRING });
    await new Promise(r => setTimeout(r, 300));
    expect(theirs.frames.filter(f => f.includes(PAIRING))).toEqual([]);
    expect(myAgent.frames.filter(f => f.includes(PAIRING))).toEqual([]);

    // events.poll and replay read workspace_events; a replayed command reads the ledger.
    const [stored] = await database.query<{ events: number; ledger: number }>(
      `select (select count(*) from public.workspace_events where payload::text like $1)::int as events,
              (select count(*) from public.command_ledger where coalesce(result::text, '') like $1)::int as ledger`, [`%${PAIRING}%`]);
    expect(stored).toEqual({ events: 0, ledger: 0 });
    mine.close(); theirs.close(); myAgent.close();
  });

  it('a settled connection takes no more auth frames', () => {
    relay.settle(connectionId);
    expect(relay.relay({ connectionId, pairingCode: 'LATE-0000', expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
  });

  it('is human-only, and relinks only the caller\'s own connection', async () => {
    const error = refused(await request(agent.token, 'POST', '/v2/me/bridge-connections', { provider: 'whatsapp' }), 403, 'forbidden');
    expect(error.details.reason).toBe('credentials_human_only');
    const theirs = refused(await request(other.token, 'POST', '/v2/me/bridge-connections', { provider: 'whatsapp', connectionId }), 403, 'forbidden');
    expect(theirs.details.reason).toBe('not_connection_owner');
  });
});

describe('bridges.connections.offer, withdraw and list (§2.5, §3.4)', () => {
  it('the owner offers the connection to a space they are a member of', async () => {
    const result = ok(await request(human.token, 'POST', `/v2/me/bridge-connections/${connectionId}/offer`, { spaceId: space }));
    expect(result.connection.offers).toEqual([expect.objectContaining({ credentialId: result.credentialId, spaceId: space, visibility: 'public', bridges: 0 })]);
    const listed = ok(await request(human.token, 'GET', '/v2/me/bridge-connections'));
    expect(listed.items.map((c: { id: string }) => c.id)).toEqual([connectionId]);
    expect(ok(await request(other.token, 'GET', '/v2/me/bridge-connections')).items).toEqual([]);
  });

  it('refuses another member, and an agent', async () => {
    const error = refused(await request(other.token, 'POST', `/v2/me/bridge-connections/${connectionId}/offer`, { spaceId: space }), 403, 'forbidden');
    expect(error.details.reason).toBe('not_connection_owner');
    refused(await request(agent.token, 'POST', `/v2/me/bridge-connections/${connectionId}/withdraw`, { spaceId: space }), 403, 'forbidden');
  });

  it('withdraw revokes the space credential', async () => {
    const result = ok(await request(human.token, 'POST', `/v2/me/bridge-connections/${connectionId}/withdraw`, { spaceId: space }));
    expect(result.pausedBridgeIds).toEqual([]);
    expect(result.connection.offers).toEqual([]);
    const again = refused(await request(human.token, 'POST', `/v2/me/bridge-connections/${connectionId}/withdraw`, { spaceId: space }), 409, 'conflict');
    expect(again.details.reason).toBe('not_offered');
  });
});
