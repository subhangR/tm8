/**
 * `bridges.groups.fork` (D83, migration 432): the session a bridge lands on
 * forks its group into a new WhatsApp group on the same number, bridged to a
 * new session, against a scratch database with every migration applied.
 *
 * Real: the executor's forkStart, 432's doors and 426's split doors, the
 * caller's claims (an agent session, by its work_session claim), write_edge,
 * RLS on the roster. Faked: the outbox (a notice is a stored message), the
 * runtime's group.create, and the PTY host (a spawn inserts the session row).
 *
 * Pinned here: nothing is made or posted unless the owner turned agentGroups
 * on, the caller is the bridge's own session, and every person is in the
 * source group; a fork is announced, briefed, bridged and linked back; a retry
 * makes no second group; the rate limit refuses with nothing written.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollabError } from '@tm8/contract';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { bridgesWorkerClaims } from '../../src/bridges/outbox.js';
import { createBridgeCommandExecutor, type BridgeCommandExecutor } from '../../src/bridges/commands/executor.js';
import type { SpawnWorkerRequest } from '../../src/bridges/commands/ports.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

let database: W1ScratchDatabase;
let db: Db;
const space = randomUUID(), member = randomUUID(), account = randomUUID(), persona = randomUUID(), other = randomUUID();
const forker = randomUUID(), stranger = randomUUID(), connection = randomUUID();
const identity = `fork-owner-${randomUUID()}`;
const roster = {
  maya: '919000000003@s.whatsapp.net',
  rahul: '919000000002@s.whatsapp.net',
  quiet: '919000004444@s.whatsapp.net',
};
let bridgeId = '';
let liveMembers: Array<{ ids: string[]; name: string | null }> = [];

const human: DbClaims = { identityId: identity, nodeAdmin: false, authKind: 'cli', requestId: 'fork-human' };
const agentOf = (session: string): DbClaims => ({
  identityId: identity, nodeAdmin: false, authKind: 'agent', actorId: persona, workSessionId: session, requestId: `fork-${randomUUID()}`,
});

async function asOwner<T>(fn: (c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }) => Promise<T>): Promise<T> {
  return database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    return fn(c as never);
  });
}
async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await asOwner(c => c.query(sql, params))).rows[0].n);
}
async function session(id: string, title: string): Promise<void> {
  await asOwner(async c => {
    await c.query("insert into public.entities(id,space_id,kind,position,created_by,visibility) values($1,$2,'work_session',0,$3,'space')", [id, space, member]);
    await c.query("insert into public.work_sessions(entity_id,title,status,share_mode,started_at) values($1,$2,'running','none',now())", [id, title]);
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('bridge_group_fork');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await asOwner(async c => {
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identity]);
    await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2)', [account, identity]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Fork fixture',$2)", [space, identity]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [member, space]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner',$3)", [member, space, identity]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$3,'team_member',0,$4),($2,$3,'team_member',0,$4)",
      [persona, other, space, member]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$3,'Infra','','persona'),($2,$3,'Triage','','persona')",
      [persona, other, member]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …0001','linked')`, [connection, account]);
  });
  await session(forker, 'Infra (WhatsApp)');
  await session(stranger, 'Someone else');
  await db.rpc(human, 'offer_bridge_connection', [connection, space, 'public', null, `fork-offer-${randomUUID()}`]);
  const created = await db.rpc<{ entity: { id: string } }>(human, 'create_bridge',
    [space, connection, '120363-infra@g.us', JSON.stringify({ kind: 'group', title: 'Infra', memberCount: null }),
      forker, JSON.stringify({}), persona, null, null, true, null, null, `fork-bridge-${randomUUID()}`]);
  bridgeId = created.entity.id;
  await asOwner(c => c.query(`insert into public.bridge_participants(bridge_id, external_id, display_name, first_seen_at, last_seen_at)
    values ($1,$2,'Maya',now(),now()),($1,$3,'Rahul',now(),now()),($1,$4,null,now(),now())`,
  [bridgeId, roster.maya, roster.rahul, roster.quiet]));
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

// ----------------------------------------------------------------- fakes
interface Notice { messageId: string; text: string; replyToMessageId: string | null; key: string }
let notices: Notice[] = [];
let spawns: SpawnWorkerRequest[] = [];
let creates: Array<{ subject: string; participants: string[]; sourceConversationId: string }> = [];
let groupCommunity: { id: string; name: string } | null = null;
let groupRefusal: CollabError | null = null;
const spawned = new Map<string, string>();
let groupSeq = 0;

let executor: BridgeCommandExecutor;
function makeExecutor(): BridgeCommandExecutor {
  return createBridgeCommandExecutor({
    db,
    executorClaims: async () => bridgesWorkerClaims(),
    async postNotice(_db, input) {
      const existing = notices.find(n => n.key === input.idempotencyKey);
      if (existing) return { messageId: existing.messageId, delivery: { status: 'pending', outboxId: 'x' } };
      const messageId = randomUUID();
      await asOwner(async c => {
        await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'message',0,$3)", [messageId, space, member]);
        await c.query('insert into public.messages(entity_id,anchor_id,author_id,body) values($1,$2,$3,$4)', [messageId, bridgeId, member, `tm8: ${input.text}`]);
      });
      notices.push({ messageId, text: input.text, replyToMessageId: input.replyToMessageId ?? null, key: input.idempotencyKey });
      return { messageId, delivery: { status: 'pending', outboxId: 'x' } };
    },
    claim: async () => true,
    settle: async () => undefined,
    recordOrigin: async () => undefined,
    async spawnWorker(_claims, request) {
      const prior = spawned.get(request.clientMutationId);
      if (prior) return { sessionId: prior };
      spawns.push(request);
      const sessionId = randomUUID();
      await session(sessionId, request.title);
      spawned.set(request.clientMutationId, sessionId);
      return { sessionId };
    },
    stopWorker: async () => undefined,
    resumeWorker: async (_claims, sessionId) => ({ sessionId }),
    workerHandle: async (_claims, _bridge, sessionId) => ({ handle: sessionId === forker ? 'infra-1' : 'triage-1', title: null }),
    groups: {
      async members() { return { members: liveMembers, self: ['919000000999@s.whatsapp.net'] }; },
      async create(input) {
        if (groupRefusal) throw groupRefusal;
        creates.push({ subject: input.subject, participants: input.participants, sourceConversationId: input.sourceConversationId });
        return {
          conversationId: `120363-fork-${++groupSeq}@g.us`, subject: input.subject,
          community: groupCommunity,
          inviteLink: input.participants.includes(roster.rahul) ? 'https://chat.whatsapp.com/FORK' : null,
          results: input.participants.map(id => ({ id, status: id === roster.rahul ? 'invite_needed' as const : 'added' as const })),
        };
      },
      async add() { throw new Error('not used'); },
    },
  });
}

beforeEach(() => {
  liveMembers = Object.values(roster).map(id => ({ ids: [id], name: null }));
  groupCommunity = null; groupRefusal = null;
  executor = makeExecutor();
  notices = []; spawns = []; creates = [];
});

const fork = (claims: DbClaims, input: Partial<Parameters<NonNullable<BridgeCommandExecutor['forkStart']>>[1]> = {}) =>
  executor.forkStart!(claims, { clientMutationId: randomUUID(), bridgeId, title: 'bridge-bugs', participants: ['Maya'], ...input });

async function refusal(promise: Promise<unknown>): Promise<CollabError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error, 'expected a refusal').toBeTruthy();
  return error as CollabError;
}
const sqlReason = (e: any) => (e?.details?.reason ?? (() => { try { return JSON.parse(e?.detail ?? '{}').reason; } catch { return undefined; } })());
const nothingMade = async () => {
  expect(creates).toEqual([]);
  expect(notices).toEqual([]);
  expect(spawns).toEqual([]);
  expect(await count('select count(*) n from public.bridge_group_forks')).toBe(0);
};

// ----------------------------------------------------------------- tests
describe('who may fork (ac1)', () => {
  it('refuses while the number\'s owner has not turned agentGroups on, and makes nothing', async () => {
    const error = await refusal(fork(agentOf(forker)));
    expect(sqlReason(error)).toBe('agent_groups_off');
    await nothingMade();
  });

  it('only the owner, a human, turns agentGroups on', async () => {
    await expect(db.rpc(agentOf(forker), 'set_bridge_offer_agent_groups', [connection, space, true])).rejects.toThrow();
    const set = await db.rpc<{ agentGroups: boolean }>(human, 'set_bridge_offer_agent_groups', [connection, space, true]);
    expect(set.agentGroups).toBe(true);
    const [conn] = await db.rpc<Array<{ offers: Array<{ agentGroups: boolean }> }>>(human, 'list_bridge_connections', [null]);
    expect(conn!.offers[0]!.agentGroups).toBe(true);
  });

  it('refuses a session the bridge does not land on, and a human with no session', async () => {
    expect(sqlReason(await refusal(fork(agentOf(stranger))))).toBe('not_bridge_session');
    expect(sqlReason(await refusal(fork(human)))).toBe('not_bridge_session');
    await nothingMade();
  });
});

describe('who may be added (ac2)', () => {
  it('refuses anyone not in the source group, before anything is made', async () => {
    const error = await refusal(fork(agentOf(forker), { participants: ['Maya', '+91 98765 43210'] }));
    expect(error.code).toBe('invalid_input');
    expect(error.details).toMatchObject({ reason: 'not_in_group' });
    expect(error.message).toContain('"+91 98765 43210"');
    await nothingMade();
  });

  it('never matches a phone reference against equal LID digits', async () => {
    liveMembers.push({ ids: ['919876543210@lid'], name: 'LID only' });
    const error = await refusal(fork(agentOf(forker), { participants: ['+919876543210'] }));
    expect(error.details).toMatchObject({ reason: 'not_in_group' });
    await nothingMade();
  });

  it('everyone includes unspoken members and excludes own aliases and stale speakers', async () => {
    const unspoken = '188888888888882@lid';
    liveMembers = [{ ids: [roster.maya, '188888888888883@lid'], name: 'Maya' },
      { ids: [unspoken], name: 'Never spoke' }, { ids: ['919000000999@s.whatsapp.net', '188888888888899@lid'], name: 'tm8' }];
    const made = await fork(agentOf(forker), { participants: ['everyone', '188888888888883@lid'] });
    expect(new Set(creates[0]!.participants)).toEqual(new Set([roster.maya, unspoken]));
    await asOwner(c => c.query("update public.bridge_group_forks set created_at=now()-interval '2 days' where id=$1", [made.forkId]));
  });

  it('takes a name, a +number and the masked id the participants list shows', async () => {
    const made = await fork(agentOf(forker), { participants: ['maya', '+91 90000 00002', '…4444'] });
    expect(creates[0]!.participants.sort()).toEqual([roster.maya, roster.rahul, roster.quiet].sort());
    expect(made.group.inviteLink).toBe('https://chat.whatsapp.com/FORK');
  });
});

describe('the fork (ac3, ac4)', () => {
  it('announces, makes the group, briefs and bridges a new session that follows_up the forker; a retry makes nothing new', async () => {
    const clientMutationId = randomUUID();
    const before = await count('select count(*) n from public.bridge_group_forks');
    const made = await fork(agentOf(forker), {
      clientMutationId, participants: ['Rahul'], teammate: 'Triage', brief: 'triage the bridge bugs from today',
    });
    // The group keeps its name exactly as given.
    expect(creates[0]!.subject).toBe('bridge-bugs');
    expect(creates[0]!.sourceConversationId).toBe('120363-infra@g.us');
    expect(made.group.community).toBeNull();
    // Announced first, then the outcome as a reply, with the invite link.
    expect(notices[0]!.text).toBe('infra-1 is starting a new group "bridge-bugs" with Rahul');
    expect(notices[1]).toMatchObject({ replyToMessageId: notices[0]!.messageId });
    expect(notices[1]!.text).toContain('https://chat.whatsapp.com/FORK');
    expect(notices[1]!.text).toContain('triage-1');
    // The new session: the named teammate, briefed with the topic and a link back.
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ teamMemberId: other, taskId: null, title: 'bridge-bugs (WhatsApp)' });
    expect(spawns[0]!.promptExtra).toContain('Topic: triage the bridge bugs from today');
    expect(spawns[0]!.promptExtra).toContain(`tm8 bridge log ${bridgeId}`);
    expect(spawns[0]!.origins).toEqual([expect.objectContaining({ bridgeId, messageId: notices[0]!.messageId, command: '/split' })]);
    // Its bridge: the same number and space, on the new session.
    const [b] = (await asOwner(c => c.query('select * from public.bridges where entity_id = $1', [made.newBridgeId]))).rows;
    expect(b).toMatchObject({ space_id: space, connection_id: connection, external_conversation_id: made.group.conversationId,
      target_kind: 'work_session', target_id: made.sessionId });
    // The link back, and the audit row.
    expect(await count(`select count(*) n from public.edges where type = 'follows_up' and src_id = $1 and dst_id = $2`,
      [made.sessionId, forker])).toBe(1);
    const [row] = (await asOwner(c => c.query('select * from public.bridge_group_forks where id = $1', [made.forkId]))).rows;
    expect(row).toMatchObject({ from_bridge_id: bridgeId, session_id: forker, actor_id: member, participants: 1, teammate_id: other,
      message_id: notices[0]!.messageId, conversation_id: made.group.conversationId, bridge_id: made.newBridgeId, new_session_id: made.sessionId });
    // A retry lands on the same fork.
    const again = await fork(agentOf(forker), { clientMutationId, participants: ['Rahul'], teammate: 'Triage' });
    expect(creates).toHaveLength(1);
    expect(again).toMatchObject({ forkId: made.forkId, newBridgeId: made.newBridgeId, sessionId: made.sessionId });
    expect(await count('select count(*) n from public.bridge_group_forks')).toBe(before + 1);
  });

  it('refuses a fourth fork of one group within the hour, with nothing written', async () => {
    // Two forks so far in this file; one more fills the hour.
    await fork(agentOf(forker));
    const forks = await count('select count(*) n from public.bridge_group_forks');
    notices = []; creates = []; spawns = [];
    const error = await refusal(fork(agentOf(forker)));
    expect(error.code).toBe('rate_limited');
    expect((error.details as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(creates).toEqual([]);
    expect(notices).toEqual([]);
    expect(await count('select count(*) n from public.bridge_group_forks')).toBe(forks);
  });
});

describe('forking a community group', () => {
  let sourceBridge: string;
  const communityForker = randomUUID();
  beforeAll(async () => {
    await session(communityForker, 'Community (WhatsApp)');
    const created = await db.rpc<{ entity: { id: string } }>(human, 'create_bridge',
      [space, connection, '120363-community-source@g.us', JSON.stringify({ kind: 'group', title: 'Community source', memberCount: null }),
        communityForker, JSON.stringify({}), persona, null, null, true, null, null, `community-bridge-${randomUUID()}`]);
    sourceBridge = created.entity.id;
    await asOwner(c => c.query(`insert into public.bridge_participants(bridge_id, external_id, display_name, first_seen_at, last_seen_at)
      values ($1,$2,'Maya',now(),now())`, [sourceBridge, roster.maya]));
  });

  it('follows the source community and reports it on both creation and replay', async () => {
    groupCommunity = { id: 'community@g.us', name: 'Acme Community' };
    const input = { bridgeId: sourceBridge, clientMutationId: randomUUID() };
    const made = await fork(agentOf(communityForker), input);
    expect(creates[0]!.sourceConversationId).toBe('120363-community-source@g.us');
    expect(made.group.community).toEqual(groupCommunity);
    expect(notices.at(-1)!.text).toContain('in *Acme Community*');
    const again = await fork(agentOf(communityForker), input);
    expect(again.group.community).toEqual(groupCommunity);
    expect(again.newBridgeId).toBe(made.newBridgeId);
    expect(creates).toHaveLength(1);
  });

  for (const code of ['not_community_admin', 'community_create_failed'] as const) {
    it(`returns a clear ${code} error, releases the rate reservation, and creates no group/session`, async () => {
      groupRefusal = new CollabError(code === 'not_community_admin' ? code : 'upstream_unavailable',
        "Can't split: this group is in *Acme Community*. Make the linked number a community admin and try again.",
        { retryable: false, details: { reason: code, community: { id: 'community@g.us', name: 'Acme Community' } } });
      const before = await count('select count(*) n from public.bridge_group_forks');
      const error = await refusal(fork(agentOf(communityForker), { bridgeId: sourceBridge }));
      expect(error).toBe(groupRefusal);
      expect(error.retryable).toBe(false);
      expect(error.details!.community).toEqual({ id: 'community@g.us', name: 'Acme Community' });
      expect(notices.at(-1)!.text).toContain('Acme Community');
      expect(creates).toEqual([]);
      expect(spawns).toEqual([]);
      expect(await count('select count(*) n from public.bridge_group_forks')).toBe(before);
    });
  }
});
