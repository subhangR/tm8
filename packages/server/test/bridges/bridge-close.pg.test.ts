/**
 * `bridges.close` (433, D84) over authenticated HTTP: an agent closes a FORKED
 * WhatsApp group — the number posts a closing note, removes everyone, leaves —
 * and the bridge ends with `bridges.remove`'s tombstone.
 *
 * Pinned here: only a fork (a /split's bridge_splits row, or an agent fork's
 * bridge_group_forks row) can be closed, and only by the session it lands on,
 * the session of the group it was forked from, the session that forked it, or
 * a space admin; every refusal asks WhatsApp nothing; WhatsApp goes first, so
 * an error there leaves the bridge as it was; the parent group gets a notice;
 * the fork's session and log are kept; a retry answers the first call.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GroupFrame } from '@tm8/contract';
import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { registerBridgeHandlers } from '../../src/bridges/handlers.js';
import type { BridgeRuntimeLink } from '../../src/bridges/connection-auth.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let database: W1ScratchDatabase, db: Db, server: FacadeServer, base: string;
const space = randomUUID(), member = randomUUID(), account = randomUUID(), persona = randomUUID(), connection = randomUUID();
const identityId = `bridge-close-owner-${randomUUID()}`;
const RUNTIME = 'rt-close';

function bearer() {
  const id = randomUUID(), secret = generateSecret();
  return { id, secret, token: formatToken(id, secret) };
}
const human = bearer();
const owner = async () => ({ identityId, accountId: account, username: identityId, isNodeAdmin: false, isOwner: false });

/** Work sessions, each with its own agent bearer. */
const SESSIONS = ['parent', 'fork', 'agentFork', 'forker', 'third', 'plain', 'stranger'] as const;
type SessionName = (typeof SESSIONS)[number];
/** `id` is the work session; `auth` is its agent auth session, which the bearer names. */
const sessions = Object.fromEntries(SESSIONS.map(n => {
  const { id: auth, secret, token } = bearer();
  return [n, { id: randomUUID(), auth, secret, token }];
})) as Record<SessionName, { id: string; auth: string; secret: string; token: string }>;
const bridges: Record<string, { id: string; conv: string }> = {};

const closes: { runtimeId: string; connectionId: string; conversationId: string; note: string; backTo?: string }[] = [];
let mode: 'ok' | 'error' | 'gone' = 'ok';
const runtime = {
  async connect() { return null; },
  async disconnect() { return false; },
  async listConversations() { return null; },
  async createGroup() { return null; },
  async closeGroup(runtimeId, input): Promise<GroupFrame> {
    closes.push({ runtimeId, connectionId: input.connectionId, conversationId: input.conversationId, note: input.note, ...(input.backTo ? { backTo: input.backTo } : {}) });
    if (mode === 'error') return { requestId: input.requestId, connectionId: input.connectionId, error: 'the number has to be an admin of the group to remove people' };
    if (mode === 'gone') return { requestId: input.requestId, connectionId: input.connectionId, error: 'not_in_group: the number is not in this group' };
    return {
      requestId: input.requestId, connectionId: input.connectionId, conversationId: input.conversationId, subject: 'x', inviteLink: null,
      results: [{ id: '922222222222@s.whatsapp.net', status: 'removed' }, { id: '933333333333@s.whatsapp.net', status: 'failed' }],
    };
  },
} satisfies BridgeRuntimeLink;

async function call(token: string, method: string, path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
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
const versionOf = async (bridgeId: string) =>
  Number((await database.query<{ version: string }>('select version from public.entities where id = $1', [bridgeId]))[0]!.version);
const close = async (token: string, bridgeId: string, extra: Record<string, unknown> = {}) =>
  call(token, 'POST', `/v2/bridges/${bridgeId}/close`, { clientMutationId: randomUUID(), expectedVersion: await versionOf(bridgeId), ...extra });

async function bridgeTo(name: string, target: SessionName) {
  const conv = `120363${Math.floor(Math.random() * 1e9)}@g.us`;
  const made = ok(await call(human.token, 'POST', `/v2/spaces/${space}/bridges`, {
    clientMutationId: randomUUID(), connectionId: connection,
    conversation: { kind: 'group', externalId: conv, title: name }, targetId: sessions[target].id,
  }));
  bridges[name] = { id: made.id, conv };
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('bridge_close');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identityId]);
    await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2)', [account, identityId]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Bridge close fixture',$2)", [space, identityId]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [member, space]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner',$3)", [member, space, identityId]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$3)", [persona, space, member]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'agile-cheetah','','persona')", [persona, member]);
    for (const name of SESSIONS) {
      const s = sessions[name];
      await c.query("insert into public.entities(id,space_id,kind,position,created_by,visibility) values($1,$2,'work_session',0,$3,'space')", [s.id, space, member]);
      await c.query("insert into public.work_sessions(entity_id,title,status,share_mode,started_at) values($1,$2,'running','none',now())", [s.id, name]);
      await c.query(`insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at,work_session_id,acting_as_team_member_id)
        values ($1,$2,'agent',$3,$4,now()+interval '1 hour',$5,$6)`, [s.auth, account, space, hashToken(s.secret), s.id, persona]);
    }
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status, runtime_id)
      values ($1,'whatsapp',$2,'+91 …9494','linked',$3)`, [connection, account, RUNTIME]);
    await c.query(`insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at) values
      ($1,$2,'cli',$3,$4,now()+interval '1 hour')`, [human.id, account, space, hashToken(human.secret)]);
  });
  await db.tx({ identityId, authKind: 'browser', requestId: randomUUID() }, q =>
    q.rpc('offer_bridge_connection', [connection, space, 'public', null, randomUUID()]));
  const config = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: database.url, disableAutoOwner: true };
  const registry = new HandlerRegistry();
  registerBridgeHandlers(registry, { db, config, owner }, { runtime });
  server = createFacadeServer({ config, registry, identityResolver: createSessionIdentityResolver({ db, owner }) });
  base = (await server.listen()).url;

  await bridgeTo('Infra', 'parent');
  await bridgeTo('Release crew', 'fork');
  await bridgeTo('Agent fork', 'agentFork');
  await bridgeTo('Third fork', 'third');
  await bridgeTo('Family', 'plain');
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    // Two /split forks of Infra, keyed by their command messages (426).
    for (const name of ['Release crew', 'Third fork']) {
      const msg = randomUUID();
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'message',0,$3)", [msg, space, member]);
      await c.query('insert into public.messages(entity_id,anchor_id,author_id,body) values($1,$2,$3,$4)', [msg, bridges.Infra!.id, member, `/split ${name}`]);
      await c.query('insert into public.bridge_splits(message_id,from_bridge_id,conversation_id,title,bridge_id) values($1,$2,$3,$4,$5)',
        [msg, bridges.Infra!.id, bridges[name]!.conv, name, bridges[name]!.id]);
    }
    // An agent fork, recorded only in 432's audit table (made here when 432 is not applied), forked by `forker`.
    await c.query(`create table if not exists public.bridge_group_forks (
      id uuid primary key default gen_random_uuid(), from_bridge_id uuid not null, client_mutation_id text not null,
      space_id uuid not null, connection_id uuid not null, session_id uuid not null, title text not null,
      participants integer not null, bridge_id uuid)`);
    await c.query(`insert into public.bridge_group_forks(from_bridge_id,client_mutation_id,space_id,connection_id,session_id,title,participants,bridge_id)
      values ($1,$2,$3,$4,$5,'Agent fork',2,$6)`, [bridges.Infra!.id, randomUUID(), space, connection, sessions.forker.id, bridges['Agent fork']!.id]);
  });
});
afterAll(async () => {
  await server?.close();
  await db?.end();
  await database?.destroy();
});

const ended = async (bridgeId: string) =>
  (await database.query<{ ended_at: Date | null }>('select ended_at from public.bridges where entity_id = $1', [bridgeId]))[0]!.ended_at !== null;

describe('who may close (D84)', () => {
  it('refuses a session that is neither the fork\'s, its parent\'s nor its forker\'s, and asks WhatsApp nothing', async () => {
    refused(await close(sessions.stranger.token, bridges['Release crew']!.id), 403, 'forbidden');
    expect(closes).toEqual([]);
  });

  it('refuses a bridge no fork made, to its own session and to a space admin alike: it stays human-only (bridges.remove)', async () => {
    expect(refused(await close(sessions.plain.token, bridges.Family!.id), 409, 'conflict').details.reason).toBe('not_a_fork');
    expect(refused(await close(human.token, bridges.Family!.id), 409, 'conflict').details.reason).toBe('not_a_fork');
    expect(closes).toEqual([]);
    expect(await ended(bridges.Family!.id)).toBe(false);
  });

  it('refuses a stale expectedVersion before WhatsApp is asked', async () => {
    const result = await call(sessions.fork.token, 'POST', `/v2/bridges/${bridges['Release crew']!.id}/close`,
      { clientMutationId: randomUUID(), expectedVersion: (await versionOf(bridges['Release crew']!.id)) + 5 });
    refused(result, 409, 'conflict');
    expect(closes).toEqual([]);
  });
});

describe('bridges.close', () => {
  it('lets the fork\'s own session close a /split fork: note with a way back, everyone out, the bridge ends, the parent is told', async () => {
    const bridgeId = bridges['Release crew']!.id;
    const body = { clientMutationId: randomUUID(), expectedVersion: await versionOf(bridgeId) };
    const result = ok(await call(sessions.fork.token, 'POST', `/v2/bridges/${bridgeId}/close`, body));
    expect(closes).toEqual([{
      runtimeId: RUNTIME, connectionId: connection, conversationId: bridges['Release crew']!.conv,
      note: 'tm8: this group is closed. The discussion continues in "Infra".', backTo: bridges.Infra!.conv,
    }]);
    expect(result.bridge).toMatchObject({ id: bridgeId, status: 'ended', endedAt: expect.any(String) });
    expect(result.results).toEqual([{ id: '922222222222@s.whatsapp.net', status: 'removed' }, { id: '933333333333@s.whatsapp.net', status: 'failed' }]);
    expect(result.parent).toMatchObject({ bridgeId: bridges.Infra!.id, title: 'Infra', noticeMessageId: expect.any(String) });
    const [notice] = await database.query<{ anchor_id: string; body: string }>(
      'select anchor_id, body from public.messages where entity_id = $1', [result.parent.noticeMessageId]);
    expect(notice!.anchor_id).toBe(bridges.Infra!.id);
    expect(notice!.body).toContain('"Release crew" forked from here was closed');
    // The session and the bridge's record are kept; the activity says what happened.
    const [kept] = await database.query<{ deleted_at: Date | null }>('select deleted_at from public.entities where id = $1', [sessions.fork.id]);
    expect(kept!.deleted_at).toBeNull();
    const [activity] = await database.query<{ summary: any }>(
      `select summary from public.activity where entity_id = $1 and summary ->> 'op' = 'bridges.close'`, [bridgeId]);
    expect(activity!.summary).toMatchObject({ forkOf: bridges.Infra!.id, closedBySession: sessions.fork.id, removed: 1, failed: 1 });

    // A retry with the same mutation id answers the first call and asks WhatsApp nothing more.
    const again = ok(await call(sessions.fork.token, 'POST', `/v2/bridges/${bridgeId}/close`, body));
    expect(again.bridge.id).toBe(bridgeId);
    expect(closes).toHaveLength(1);
    // A new one is refused: it has ended.
    expect(refused(await call(sessions.fork.token, 'POST', `/v2/bridges/${bridgeId}/close`,
      { clientMutationId: randomUUID(), expectedVersion: await versionOf(bridgeId) }), 409, 'conflict').details.reason).toBe('bridge_ended');
  });

  it('lets the session that forked an agent fork close it (bridge_group_forks), with the caller\'s note', async () => {
    const bridgeId = bridges['Agent fork']!.id;
    const result = ok(await close(sessions.forker.token, bridgeId, { note: 'Done here, thanks all' }));
    expect(closes.at(-1)).toMatchObject({ conversationId: bridges['Agent fork']!.conv, note: 'Done here, thanks all', backTo: bridges.Infra!.conv });
    expect(result.bridge.status).toBe('ended');
    expect(result.note).toBe('Done here, thanks all');
  });

  it('keeps the bridge when WhatsApp refuses, and lets the parent\'s session finish a group the number already left', async () => {
    const bridgeId = bridges['Third fork']!.id;
    mode = 'error';
    refused(await close(sessions.parent.token, bridgeId), 503, 'upstream_unavailable');
    expect(await ended(bridgeId)).toBe(false);
    mode = 'gone';
    const result = ok(await close(sessions.parent.token, bridgeId));
    expect(result.bridge.status).toBe('ended');
    expect(result.results).toEqual([]);
    mode = 'ok';
  });
});
