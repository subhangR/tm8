/**
 * `bridges.conversations.create` over authenticated HTTP: a new WhatsApp group
 * made on the caller's own number and always bridged in the same call, to the
 * target named or to a new session started for a teammate.
 *
 * Pinned here: only a human who owns the number may make a group (never an
 * agent, never another member); every refusal the bridge could meet is met
 * before the runtime is asked, so a refusal leaves no group on WhatsApp (and a
 * session started for it is stopped); the preflight leaves nothing behind; a
 * retry with the same mutation id answers the first call's bridge and makes no
 * second group or session.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GroupMemberResult } from '@tm8/contract';
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
const space = randomUUID(), member = randomUUID(), otherMember = randomUUID(), account = randomUUID(), otherAccount = randomUUID();
const persona = randomUUID(), worker = randomUUID(), chat = randomUUID(), connection = randomUUID();
const identityId = `group-create-owner-${randomUUID()}`, otherIdentity = `group-create-other-${randomUUID()}`;
const RUNTIME = 'rt-group';

function bearer() {
  const id = randomUUID(), secret = generateSecret();
  return { id, secret, token: formatToken(id, secret) };
}
const human = bearer(), other = bearer(), agent = bearer();
const owner = async () => ({ identityId, accountId: account, username: identityId, isNodeAdmin: false, isOwner: false });

const creates: { runtimeId: string; connectionId: string; subject: string; participants: string[] }[] = [];
let groups = 0;
const runtime = {
  async connect() { return null; },
  async disconnect() { return false; },
  async listConversations() { return null; },
  async createGroup(runtimeId, { requestId, connectionId, subject, participants }) {
    creates.push({ runtimeId, connectionId, subject, participants });
    // The second person asked refuses adds by privacy: they get the invite link.
    const results: GroupMemberResult[] = participants.map((id, i) => ({ id, status: i === 1 ? 'invite_needed' : 'added' }));
    return {
      requestId, connectionId, conversationId: `1203630000${++groups}@g.us`, subject, results,
      inviteLink: results.some(r => r.status === 'invite_needed') ? 'https://chat.whatsapp.com/INVITE' : null,
    };
  },
} satisfies BridgeRuntimeLink;

/** The executor's session doors (task 01a195da): a start inserts the session row; a stop is recorded. */
const started: Array<{ teamMemberId: string; title: string; clientMutationId: string; sessionId: string }> = [];
const stopped: string[] = [];
const sessions = {
  async workStart() { throw new Error('not used'); },
  async startSession(_claims: unknown, input: { spaceId: string; teamMemberId: string; title: string; clientMutationId: string }) {
    const prior = started.find(s => s.clientMutationId === input.clientMutationId);
    if (prior) return { sessionId: prior.sessionId };
    const sessionId = randomUUID();
    await database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query("insert into public.entities(id,space_id,kind,position,created_by,visibility) values($1,$2,'work_session',0,$3,'space')", [sessionId, input.spaceId, member]);
      await c.query("insert into public.work_sessions(entity_id,title,status,share_mode,started_at) values($1,$2,'running','none',now())", [sessionId, input.title]);
    });
    started.push({ ...input, sessionId });
    return { sessionId };
  },
  async stopSession(_claims: unknown, sessionId: string) { stopped.push(sessionId); },
};

beforeAll(async () => {
  database = await createW1ScratchDatabase('bridge_group_create');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1),($2,$2)', [identityId, otherIdentity]);
    await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2),($3,$4,$4,$4)',
      [account, identityId, otherAccount, otherIdentity]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Group create fixture',$2)", [space, identityId]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$3,'member',0,$1),($2,$3,'member',0,$2)",
      [member, otherMember, space]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$3,$4,'owner',$4),($2,$3,$5,'member',$5)",
      [member, otherMember, space, identityId, otherIdentity]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$3)", [persona, space, member]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'agile-cheetah','','persona')", [persona, member]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by,visibility) values($1,$2,'work_session',0,$3,'space')", [worker, space, member]);
    await c.query("insert into public.work_sessions(entity_id,title,status,share_mode,started_at) values($1,'Worker','running','none',now())", [worker]);
    await c.query("insert into public.entities(id,space_id,kind,created_by) values ($1,$2,'chat',$3)", [chat, space, member]);
    await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
        chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
      values ($1,$2,'agile cheetah',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/group-create', gen_random_uuid(), $4, $5, $6)`,
      [chat, space, persona, identityId, member, `group-create-${randomUUID()}`]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status, runtime_id)
      values ($1,'whatsapp',$2,'+91 …9494','linked',$3)`, [connection, account, RUNTIME]);
    await c.query(`insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at) values
      ($1,$2,'cli',$3,$4,now()+interval '1 hour'),($5,$6,'cli',$3,$7,now()+interval '1 hour')`,
      [human.id, account, space, hashToken(human.secret), other.id, otherAccount, hashToken(other.secret)]);
    await c.query(`insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at,work_session_id,acting_as_team_member_id)
      values ($1,$2,'agent',$3,$4,now()+interval '1 hour',$5,$6)`, [agent.id, account, space, hashToken(agent.secret), worker, persona]);
  });
  await db.tx({ identityId, authKind: 'browser', requestId: randomUUID() }, q =>
    q.rpc('offer_bridge_connection', [connection, space, 'public', null, randomUUID()]));
  const config = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: database.url, disableAutoOwner: true };
  const registry = new HandlerRegistry();
  registerBridgeHandlers(registry, { db, config, owner, bridgeCommands: sessions as never }, { runtime });
  server = createFacadeServer({ config, registry, identityResolver: createSessionIdentityResolver({ db, owner }) });
  base = (await server.listen()).url;
});
afterAll(async () => {
  await server?.close();
  await db?.end();
  await database?.destroy();
});

const path = `/v2/me/bridge-connections/${connection}/conversations`;
async function create(token: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientMutationId: randomUUID(), ...body }),
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

describe('who may make a group (D28)', () => {
  it('refuses an agent, even one acting for the number\'s owner, and asks the runtime nothing', async () => {
    refused(await create(agent.token, { title: 'agile cheetah', participants: [], bridge: { spaceId: space, teammateId: persona } }), 403, 'forbidden');
    expect(creates).toEqual([]);
  });

  // The CLI's mutation envelope carries the caller's actor as `actorId` (an agent
  // run always has one): the body passes the strict input schema, and the agent
  // meets the human-only refusal, not invalid_input.
  it('refuses an agent whose body names its actor, as the CLI sends it, as forbidden', async () => {
    refused(await create(agent.token, { actorId: persona, title: 'bridges-test', participants: [], bridge: { spaceId: space, teammateId: persona } }), 403, 'forbidden');
    expect(creates).toEqual([]);
  });

  it('refuses another member: only the number\'s owner makes groups on it', async () => {
    const error = refused(await create(other.token, { title: 'agile cheetah', participants: [], bridge: { spaceId: space, targetId: chat } }), 403, 'forbidden');
    expect(error.details.reason).toBe('not_connection_owner');
    expect(creates).toEqual([]);
  });

  it('refuses a participant that is not a phone number, before asking the runtime', async () => {
    const error = refused(await create(human.token, { title: 'x', participants: ['+91 98765 43210', 'agile-cheetah'], bridge: { spaceId: space, targetId: chat } }), 400, 'invalid_input');
    expect(error.details.path).toBe('participants.1');
    expect(creates).toEqual([]);
  });

  it('meets a bridge refusal before the group is made, and the preflight leaves no bridge behind', async () => {
    refused(await create(human.token, { title: 'nowhere', participants: [], bridge: { spaceId: space, targetId: randomUUID() } }), 404, 'not_found');
    expect(creates).toEqual([]);
    const [left] = await database.query<{ n: string }>(
      "select count(*) as n from public.bridges where external_conversation_id like 'tm8-preflight-%'");
    expect(Number(left!.n)).toBe(0);
  });
});

describe('bridges.conversations.create', () => {
  it('always bridges: refuses a call with no bridge, or with neither a target nor a teammate', async () => {
    refused(await create(human.token, { title: 'Scratch', participants: [] }), 400, 'invalid_input');
    refused(await create(human.token, { title: 'Scratch', participants: [], bridge: { spaceId: space } }), 400, 'invalid_input');
    expect(creates).toEqual([]);
    expect(started).toEqual([]);
  });

  it('with no target, starts a session for the teammate and bridges the group to it; a retry starts nothing new', async () => {
    const mutationId = randomUUID();
    const body = { clientMutationId: mutationId, title: 'bridge-bugs', participants: ['+91 98765-43210', '922222222222@s.whatsapp.net'],
      bridge: { spaceId: space, teammateId: persona } };
    const made = ok(await create(human.token, body));
    expect(creates.at(-1)).toEqual({
      runtimeId: RUNTIME, connectionId: connection, subject: 'bridge-bugs',
      participants: ['919876543210@s.whatsapp.net', '922222222222@s.whatsapp.net'],
    });
    expect(started).toEqual([expect.objectContaining({ teamMemberId: persona, title: 'bridge-bugs (WhatsApp)', sessionId: made.sessionId })]);
    expect(made.group).toEqual({
      conversationId: expect.stringMatching(/@g\.us$/), subject: 'bridge-bugs', inviteLink: 'https://chat.whatsapp.com/INVITE',
      community: null,
      results: [{ id: '919876543210@s.whatsapp.net', status: 'added' }, { id: '922222222222@s.whatsapp.net', status: 'invite_needed' }],
    });
    expect(made.bridge).toMatchObject({ teammateId: persona, target: { kind: 'work_session', id: made.sessionId },
      conversation: { externalId: made.group.conversationId, title: 'bridge-bugs' } });
    const asked = creates.length;
    const again = ok(await create(human.token, body));
    expect(creates.length).toBe(asked);
    expect(started).toHaveLength(1);
    expect(again.bridge.id).toBe(made.bridge.id);
    expect(again.group.community).toBeNull();
    expect(stopped).toEqual([]);
  });

  it('with no target, a refusal makes no group and stops the session it started', async () => {
    const asked = creates.length;
    const result = await create(other.token, { title: 'nobody\'s', participants: [], bridge: { spaceId: space, teammateId: persona } });
    refused(result, 403, 'forbidden');
    expect(creates.length).toBe(asked);
    // The owner check runs before any session is started.
    expect(started).toHaveLength(1);
    // A refusal the preflight meets after the session started: the session is stopped, no group is made.
    const result2 = await create(human.token, { title: 'no such teammate', participants: [], bridge: { spaceId: space, teammateId: randomUUID() } });
    expect(result2.status, JSON.stringify(result2.json)).toBeGreaterThanOrEqual(400);
    expect(creates.length).toBe(asked);
    expect(started).toHaveLength(2);
    expect(stopped).toEqual([started[1]!.sessionId]);
    const [left] = await database.query<{ n: string }>(
      "select count(*) as n from public.bridges where external_conversation_id like 'tm8-preflight-%'");
    expect(Number(left!.n)).toBe(0);
  });

  it('makes the group and bridges it to a chat with a teammate in one call; a retry makes no second group', async () => {
    const mutationId = randomUUID();
    const body = { clientMutationId: mutationId, title: 'agile cheetah', participants: ['+919876543210'],
      bridge: { spaceId: space, targetId: chat, teammateId: persona, purpose: 'agile cheetah on WhatsApp' } };
    const made = ok(await create(human.token, body));
    const asked = creates.length;
    expect(made.group.subject).toBe('agile cheetah');
    expect(made.bridge).toMatchObject({
      spaceId: space, connectionId: connection, teammateId: persona, purpose: 'agile cheetah on WhatsApp',
      target: { kind: 'chat', id: chat },
      conversation: { externalId: made.group.conversationId, kind: 'group', title: 'agile cheetah', memberCount: 2 },
    });
    const again = ok(await create(human.token, body));
    expect(creates.length).toBe(asked);
    expect(again.bridge.id).toBe(made.bridge.id);
    expect(again.group.conversationId).toBe(made.group.conversationId);
  });
});
