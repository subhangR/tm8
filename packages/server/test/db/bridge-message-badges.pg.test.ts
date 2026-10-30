/**
 * Bridges B2-ticks (migration 406): the bridged-message read every message
 * view carries (BRIDGE-ENTITY-DESIGN §4.5, D4, D64, D65).
 *
 * An inbound message reads as the bridge's participant with a trust word
 * (guest / linked / asserted), on the log copy and on the routed chat copy
 * alike (batch twins). An outbound one carries 398's delivery badge: pending,
 * then sent on settle; a refused post carries the refusal. A message no bridge
 * touched has no entry, and a reader outside the space sees nothing.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MessageBridgeView } from '@tm8/contract';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { bridgeMessageBadges } from '../../src/db/bridge-badges.js';

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
