/**
 * Bridges B2-ticks (migration 406): the bridged-message read every message
 * view carries (BRIDGE-ENTITY-DESIGN §4.5, D4, D64, D65).
 *
 * An inbound message reads as the bridge's participant with a trust word
 * (guest / linked / asserted), on the log copy and on the routed chat copy
 * alike (batch twins). An outbound one carries 398's delivery badge: pending,
 * then sent on settle; a refused post carries the refusal. A message no bridge
 * touched has no entry, and a reader outside the space sees nothing.
 *
 * 409 (the B2-ticks follow-up): `bridges.log.read` rows carry the same trust
 * word; a page no bridge touched is answered by the pre-filter alone (D75);
 * and *Reply here only* (§4.5, D76) never reaches bridge_outbox, held on the
 * server path, `messages.post` itself, not only in the composer.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MessageBridgeView } from '@tm8/contract';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { bridgeMessageBadges } from '../../src/db/bridge-badges.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';
import { registerBridgeHandlers } from '../../src/bridges/handlers.js';
import { registerW2MessagesHandoffsHandlers } from '../../src/facade/handlers/w2/messages-handoffs.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID();
const ownerMember = randomUUID(), linkedMember = randomUUID();
const ownerIdentity = `b2t-owner-${randomUUID()}`, linkedIdentity = `b2t-linked-${randomUUID()}`;
const outsiderIdentity = `b2t-outsider-${randomUUID()}`;
const ownerAccount = randomUUID();
const teammate = randomUUID();
const chat = randomUUID();
const connection = randomUUID();
const GROUP = '120363101@g.us';
const RAHUL = '919876543210@s.whatsapp.net';
const LINKED_JID = '15550001111@s.whatsapp.net';
const ASSERTED_JID = '15550002222@s.whatsapp.net';

let infra = '';
let runtimeSession = '';

const as = (identityId: string) => <T>(fn: (q: Querier) => Promise<T>) =>
  db.tx({ identityId, authKind: 'browser', requestId: randomUUID() }, fn);
const human = as(ownerIdentity);
const runtime = (): DbClaims => ({
  identityId: ownerIdentity, authKind: 'bridge_runtime', authSessionId: runtimeSession, requestId: randomUUID(),
});
const door = <T>(fn: string, ...args: unknown[]) => db.rpc<T>(runtime(), fn, args);
const owner = <T>(sql: string, params: unknown[] = []) => scratch.transaction(async c => {
  await c.query('set local role tm8_graph_owner');
  return (await c.query(sql, params)).rows as T[];
});
const badges = (ids: string[], reader = human) => reader(q => bridgeMessageBadges(q, ids));

let seq = 0;
function frame(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    connectionId: connection, conversationId: GROUP, externalMessageId: `3EB2${seq.toString().padStart(6, '0')}`,
    sender: { externalId: RAHUL, altId: null, name: 'Rahul', fromMe: false },
    body: 'hello group', kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_000_000 + seq, ...over,
  };
}
interface Inbound { status: string; messageId: string; routed: boolean; copyId: string | null }
const inbound = (f: Record<string, unknown>) => door<Inbound>('bridge_runtime_inbound', JSON.stringify(f), false);

async function postAs(author: string, anchor: string, body: string): Promise<string> {
  const id = randomUUID();
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [id, spaceId, author]);
    await c.query(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,$4)`, [id, anchor, author, body]);
  });
  return id;
}

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('bridges_b2_ticks');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner'),($2,'Linked'),($3,'Outsider')`,
      [ownerIdentity, linkedIdentity, outsiderIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username, is_node_admin) values ($1,$2,'b2t-owner', true)`, [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Bridges B2',$2)`, [spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$3,'member',$1),($2,$3,'member',$2)`,
      [ownerMember, linkedMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values
      ($1,$5,$3,'owner','Owner'),($2,$5,$4,'member','Priya')`, [ownerMember, linkedMember, ownerIdentity, linkedIdentity, spaceId]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
      values ($1,$2,'Infra Bot','worker','persona')`, [teammate, ownerMember]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [chat, spaceId, ownerMember]);
    await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
        chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
      values ($1,$2,'Infra main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b2t', gen_random_uuid(), $4, $5, $6)`,
      [chat, spaceId, teammate, ownerIdentity, ownerMember, `b2t-${randomUUID()}`]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …9494','linked')`, [connection, ownerAccount]);
    // Priya's first number is linked from her phone (a code link); her second
    // is an admin's assertion in this space (§2.4).
    await c.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, verified_at)
      values ('whatsapp',$1,$2,'code',now())`, [LINKED_JID, linkedIdentity]);
    await c.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, space_id, asserted_by_member_id, verified_at)
      values ('whatsapp',$1,$2,'admin',$3,$4,now())`, [ASSERTED_JID, linkedIdentity, spaceId, ownerMember]);
  });
  infra = (await human(q => q.rpc<{ entity: { id: string } }>('create_bridge', [
    spaceId, connection, GROUP, JSON.stringify({ kind: 'group', title: 'Infra', memberCount: 5 }),
    chat, '{}', teammate, null, null, true, null, null, randomUUID(),
  ]))).entity.id;
  await owner(`update public.bridges set policy = policy || '{"whoMayTrigger":"anyone"}' where entity_id = $1`, [infra]);
  const hash = createHash('sha256').update(randomUUID()).digest('hex');
  runtimeSession = (await db.rpc<{ id: string }>({ identityId: ownerIdentity, nodeAdmin: true, requestId: randomUUID() },
    'issue_bridge_runtime_session', [hash, new Date(Date.now() + 86_400_000).toISOString(), 'whatsapp-runtime'])).id;
  await door('bridge_runtime_hello', JSON.stringify({ provider: 'whatsapp', version: 1, runtimeId: 'wa-b2t', capabilities: {} }));
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

const inboundView = (over: Partial<MessageBridgeView>): MessageBridgeView => ({
  bridgeId: infra, provider: 'whatsapp', conversation: 'Infra', direction: 'in',
  participant: 'Rahul', trust: 'guest', delivery: null, ...over,
});

describe('an inbound bridged message (§4.5, D4)', () => {
  it('a guest reads as the participant, guest, on the log copy and the routed chat copy alike', async () => {
    const r = await inbound(frame({ body: '@tm8 is the deploy done?' }));
    expect(r.routed).toBe(true);
    const got = await badges([r.messageId, r.copyId!]);
    expect(got.get(r.messageId)).toEqual(inboundView({}));
    expect(got.get(r.copyId!)).toEqual(inboundView({}));
  });

  it('a linked number reads linked, an admin-asserted one asserted', async () => {
    const linked = await inbound(frame({ sender: { externalId: LINKED_JID, altId: null, name: 'Priya', fromMe: false } }));
    const asserted = await inbound(frame({ sender: { externalId: ASSERTED_JID, altId: null, name: 'Priya 2', fromMe: false } }));
    const got = await badges([linked.messageId, asserted.messageId]);
    expect(got.get(linked.messageId)).toEqual(inboundView({ participant: 'Priya', trust: 'linked' }));
    expect(got.get(asserted.messageId)).toEqual(inboundView({ participant: 'Priya 2', trust: 'asserted' }));
  });

  it('a reader outside the space sees no badge; a message no bridge touched has none', async () => {
    const r = await inbound(frame());
    const plain = await postAs(ownerMember, chat, 'just a chat message');
    expect((await badges([r.messageId], as(outsiderIdentity))).size).toBe(0);
    expect((await badges([plain])).has(plain)).toBe(false);
  });
});

describe('the delivery tick (§2.3, D64, D65: 398\'s badge)', () => {
  it("a chat turn's answer is pending, then sent on settle, on the answer itself", async () => {
    const r = await inbound(frame({ body: '@tm8 deploy status?' }));
    const [turn] = await owner<{ turn_id: string }>('select turn_id from public.chat_turns where user_message_id = $1', [r.copyId]);
    const answer = randomUUID();
    await scratch.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [answer, spaceId, teammate]);
      await c.query(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,'Deployed.')`, [answer, chat, teammate]);
      await c.query(`update public.chat_turns set state = 'completed', agent_message_id = $2, completed_at = now() where turn_id = $1`,
        [turn!.turn_id, answer]);
    });
    const pending = (await badges([answer])).get(answer)!;
    expect(pending).toMatchObject({ bridgeId: infra, direction: 'out', participant: null, trust: null,
      delivery: { messageId: answer, bridgeId: infra, status: 'pending' } });

    const [ob] = await owner<{ id: string }>('select id from public.bridge_outbox where message_id = $1', [answer]);
    await db.rpc({ requestId: `bridges:${randomUUID()}`, backgroundJob: 'bridges.runtime' }, 'internal.bridge_outbox_take', [['wa-b2t'], 50]);
    await door('bridge_runtime_sent', JSON.stringify({ outboxId: ob!.id, connectionId: connection, externalMessageId: 'BAE5B2T1',
      message: { conversation: 'Infra Bot: Deployed.' } }));
    const sent = (await badges([answer])).get(answer)!;
    expect(sent.direction).toBe('out');
    expect(sent.delivery).toMatchObject({ status: 'sent', externalMessageId: 'BAE5B2T1' });
    expect(typeof sent.delivery!.at).toBe('string');
  });

  it('a post on the log while the bridge is paused stays in tm8 and reads refused: bridge_paused', async () => {
    await owner(`update public.bridges set paused_at = now() where entity_id = $1`, [infra]);
    try {
      const post = await postAs(ownerMember, infra, 'ship it');
      const got = (await badges([post])).get(post)!;
      expect(got).toMatchObject({ bridgeId: infra, direction: 'out', trust: null,
        delivery: { status: 'refused', reason: 'bridge_paused' } });
    } finally {
      await owner(`update public.bridges set paused_at = null where entity_id = $1`, [infra]);
    }
  });
});

// -----------------------------------------------------------------------------
// 409: the B2-ticks follow-up.
// -----------------------------------------------------------------------------
let registry: HandlerRegistry | null = null;
function call<T>(op: 'bridges.log.read' | 'messages.post', opts: { params?: Record<string, string>; body?: unknown }): Promise<T> {
  if (!registry) {
    registry = new HandlerRegistry();
    const deps = { db, config: {}, owner: async () => ({ identityId: ownerIdentity, accountId: ownerAccount,
      username: 'b2t-owner', isNodeAdmin: false, isOwner: false }) } as unknown as FacadeDeps;
    registerBridgeHandlers(registry, deps);
    registerW2MessagesHandoffsHandlers(registry, deps);
  }
  const ctx = {
    opName: op, params: opts.params ?? {}, body: opts.body ?? {}, query: new URLSearchParams(), headers: {},
    requestId: randomUUID(), method: op === 'messages.post' ? 'POST' : 'GET', path: '/test',
    identity: { kind: 'bearer', identityId: ownerIdentity, authKind: 'browser' },
  } as unknown as RequestContext;
  return registry.get(op)!(ctx) as Promise<T>;
}

describe('bridges.log.read carries trust (409, for the bridge panel)', () => {
  it('each row reads the trust MessageBridgeView reads: guest, linked, asserted, and null outbound', async () => {
    const guest = await inbound(frame({ body: 'from a guest' }));
    const linked = await inbound(frame({ sender: { externalId: LINKED_JID, altId: null, name: 'Priya', fromMe: false } }));
    const asserted = await inbound(frame({ sender: { externalId: ASSERTED_JID, altId: null, name: 'Priya 2', fromMe: false } }));
    const out = await postAs(ownerMember, infra, 'posted on the log');
    const log = await call<{ items: Array<{ id: string; trust: string | null }> }>('bridges.log.read',
      { params: { bridgeId: infra } });
    const trust = new Map(log.items.map(i => [i.id, i.trust]));
    const views = await badges([guest.messageId, linked.messageId, asserted.messageId, out]);
    expect(trust.get(guest.messageId)).toBe('guest');
    expect(trust.get(linked.messageId)).toBe('linked');
    expect(trust.get(asserted.messageId)).toBe('asserted');
    expect(trust.get(out)).toBeNull();
    for (const id of [guest.messageId, linked.messageId, asserted.messageId, out]) {
      expect(trust.get(id)).toBe(views.get(id)!.trust);
    }
  });
});

describe('the badge read\'s pre-filter (409, D75)', () => {
  /**
   * Which ids reach the per-id reads. Inside a savepoint that is always rolled
   * back, 398's bridge_origin_of and bridge_message_delivery are swapped for
   * versions that raise, naming the id; the badge read then either returns
   * (no id got past the pre-filter) or raises with the first id that did.
   * (Postgres's own function-call counters miss calls plpgsql makes through
   * its cached expression state, so they cannot answer this.)
   */
  async function perIdReads(ids: string[]): Promise<string | null> {
    return scratch.transaction(async c => {
      await c.query('savepoint probe');
      try {
        // This connection carries no identity claims; every id reads as readable here.
        await c.query(`create or replace function internal.entity_readable(target uuid) returns boolean
          language sql stable as 'select true'`);
        await c.query(`create or replace function internal.bridge_origin_of(p_message uuid) returns public.message_origins
          language plpgsql as $$ begin raise exception 'per-id read: %', p_message using errcode = 'P0001'; end $$`);
        await c.query(`create or replace function internal.bridge_message_delivery(p_ids uuid[]) returns jsonb
          language plpgsql as $$ begin raise exception 'per-id read: %', p_ids[1] using errcode = 'P0001'; end $$`);
        await c.query('select internal.bridge_message_badges($1::uuid[])', [ids]);
        return null;
      } catch (e) {
        const m = /per-id read: (\S+)/.exec(String((e as Error).message));
        if (!m) throw e;
        return m[1]!;
      } finally {
        await c.query('rollback to savepoint probe');
      }
    });
  }

  it('a page no bridge touched never reaches the per-id reads', async () => {
    const plain = [await postAs(ownerMember, chat, 'plain one'), await postAs(ownerMember, chat, 'plain two'),
      await postAs(ownerMember, chat, 'plain three')];
    expect(await perIdReads(plain)).toBeNull();
  });

  it('a bridged id does reach them, the routed copy (a batch twin) included; the badge is unchanged', async () => {
    const r = await inbound(frame({ body: '@tm8 mixed page' }));
    expect(r.copyId).toBeTruthy();
    const plain = await postAs(ownerMember, chat, 'plain beside a bridged one');
    expect(await perIdReads([r.copyId!])).toBe(r.copyId);
    expect(await perIdReads([plain, r.messageId])).toBe(r.messageId);
    // The probe rolled back: the real reads are in place again.
    const got = await badges([plain, r.copyId!]);
    expect(got.has(plain)).toBe(false);
    expect(got.get(r.copyId!)).toEqual(inboundView({ participant: 'Rahul', trust: 'guest' }));
  });
});

describe('Reply here only never enqueues to bridge_outbox (409, §4.5, D76)', () => {
  const crossed = async (id: string) => ({
    outbox: (await owner<{ n: number }>('select count(*)::int as n from public.bridge_outbox where message_id = $1', [id]))[0]!.n,
    refusals: (await owner<{ n: number }>('select count(*)::int as n from public.bridge_delivery_refusals where message_id = $1', [id]))[0]!.n,
  });
  const reply = async (parent: string, body: string, hereOnly?: boolean) => {
    const result = await call<{ messages: Array<{ id: string }> }>('messages.post', { body: {
      clientMutationId: randomUUID(), anchorIds: [infra], parentMessageId: parent, body,
      ...(hereOnly === undefined ? {} : { hereOnly }) } });
    return result.messages[0]!.id;
  };

  it('a reply to a bridged message crosses by default (the control)', async () => {
    const r = await inbound(frame({ body: 'anyone on call?' }));
    const id = await reply(r.messageId, 'me');
    expect(await crossed(id)).toEqual({ outbox: 1, refusals: 0 });
    expect((await badges([id])).get(id)).toMatchObject({ direction: 'out', delivery: { status: 'pending' } });
    const explicit = await reply(r.messageId, 'me too', false);
    expect(await crossed(explicit)).toEqual({ outbox: 1, refusals: 0 });
  });

  it('the same reply with hereOnly stays in tm8: no outbox row, no refusal, no badge', async () => {
    const r = await inbound(frame({ body: 'anyone on call? (2)' }));
    const id = await reply(r.messageId, 'noting this here only', true);
    expect(await crossed(id)).toEqual({ outbox: 0, refusals: 0 });
    expect((await badges([id])).has(id)).toBe(false);
    const [stored] = await owner<{ parent_id: string }>('select parent_id from public.entities where id = $1', [id]);
    expect(stored!.parent_id).toBe(r.messageId);
  });

  it('hereOnly holds on a log-anchor post too, and while the bridge is paused records no refusal', async () => {
    const top = await call<{ messages: Array<{ id: string }> }>('messages.post', { body: {
      clientMutationId: randomUUID(), anchorIds: [infra], body: 'a note on the log', hereOnly: true } });
    expect(await crossed(top.messages[0]!.id)).toEqual({ outbox: 0, refusals: 0 });
    await owner(`update public.bridges set paused_at = now() where entity_id = $1`, [infra]);
    try {
      const r = await inbound(frame({ body: 'paused?' })).catch(() => null);
      const parent = r?.messageId ?? top.messages[0]!.id;
      const id = await reply(parent, 'kept here', true);
      expect(await crossed(id)).toEqual({ outbox: 0, refusals: 0 });
    } finally {
      await owner(`update public.bridges set paused_at = null where entity_id = $1`, [infra]);
    }
  });

  it('mark_bridge_here_only marks only a message of the calling transaction', async () => {
    const earlier = await postAs(ownerMember, infra, 'already committed');
    expect(await human(q => q.rpc<number>('mark_bridge_here_only', [[earlier]]))).toBe(0);
    expect(await owner('select 1 from public.bridge_here_only where message_id = $1', [earlier])).toEqual([]);
  });
});
