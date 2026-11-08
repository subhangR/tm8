/**
 * Bridges (migration 427): one progress reaction on an inbound WhatsApp
 * message, advancing 📨 delivered -> 👀 seen -> ✅ replied, at the SQL level.
 *
 * WhatsApp keeps one reaction per sender per message and a new one replaces
 * the old, so the stages are one reaction that only moves forward: a stage at
 * or below what the message already has is never enqueued, a stage not yet
 * dispatched is rewritten in place, and dispatch drops a reaction a higher one
 * has overtaken. Delivered is the inbound commit; seen is the chat turn being
 * claimed, the session prompt delivered, or (channel) the log post itself;
 * replied is a quoting send settled `sent`. The gates: only messages tm8 acts
 * on, never commands, *Reply here only* never crosses, paused and ended
 * bridges refuse.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { bridgesWorkerClaims } from '../../src/bridges/outbox.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID();
const ownerMember = randomUUID(), linkedMember = randomUUID();
const ownerIdentity = `progress-owner-${randomUUID()}`, linkedIdentity = `progress-linked-${randomUUID()}`;
const ownerAccount = randomUUID();
const teammate = randomUUID();
const chat = randomUUID(), session = randomUUID(), channel = randomUUID(), quietChannel = randomUUID();
const connection = randomUUID();
const INFRA = '120363101@g.us', OPS = '120363102@g.us', DEPLOYS = '120363103@g.us', QUIET = '120363104@g.us';
const RAHUL = '919876543210@s.whatsapp.net', PRIYA = '15550001111@s.whatsapp.net';

let infra = '', ops = '', deploys = '', quiet = '';
let runtimeSession = '';

const human = <T>(fn: (q: Querier) => Promise<T>) =>
  db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, fn);
const runtime = (): DbClaims => ({
  identityId: ownerIdentity, authKind: 'bridge_runtime', authSessionId: runtimeSession, requestId: randomUUID(),
});
const door = <T>(fn: string, ...args: unknown[]) => db.rpc<T>(runtime(), fn, args);
const worker = <T>(fn: string, args: unknown[] = []) => db.rpc<T>(bridgesWorkerClaims(), fn, args);
const owner = <T>(sql: string, params: unknown[] = []) => scratch.transaction(async c => {
  await c.query('set local role tm8_graph_owner');
  return (await c.query(sql, params)).rows as T[];
});

let seq = 0;
const priya = { externalId: PRIYA, altId: null, name: 'Priya', fromMe: false };
const rahul = { externalId: RAHUL, altId: null, name: 'Rahul', fromMe: false };
function frame(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    connectionId: connection, conversationId: INFRA, externalMessageId: `3EB1${seq.toString().padStart(6, '0')}`,
    sender: priya, body: '@tm8 status?', kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_000_000 + seq, ...over,
  };
}
interface Inbound { status: string; messageId: string; routed: boolean; copyId: string | null }
const inbound = (f: Record<string, unknown>, command = false) =>
  door<Inbound>('bridge_runtime_inbound', JSON.stringify(f), command);

interface React { id: string; reaction: string; status: string; emoji: string; last_error: string | null }
const reacts = (msg: string) => owner<React>(`select id, reaction, status, payload ->> 'emoji' as emoji, last_error
  from public.bridge_outbox where message_id = $1 and kind = 'react' order by created_at, reaction`, [msg]);
interface Frame { frame: { type: string; outboxId: string; emoji?: string; target?: { externalMessageId?: string } } }
const take = () => worker<Frame[]>('internal.bridge_outbox_take', [['wa-progress'], 100]);
const sent = (outboxId: string, externalMessageId = `BAE5${randomUUID().slice(0, 8)}`) =>
  door('bridge_runtime_sent', JSON.stringify({ outboxId, connectionId: connection, externalMessageId }));
const advance = (msg: string, stage: string) =>
  owner<{ r: { status: string; reason?: string } }>('select internal.bridge_progress_advance($1, $2) as r', [msg, stage]).then(x => x[0]!.r);
/** Take everything due and settle it sent, as the runtime would. */
async function flush(): Promise<Frame[]> {
  const frames = await take();
  for (const f of frames) await sent(f.frame.outboxId);
  return frames;
}
const turnClaimed = (copyId: string) =>
  owner(`update public.chat_turns set state = 'running', started_at = now() where user_message_id = $1`, [copyId]);
async function turnAnswered(copyId: string, text: string): Promise<string> {
  const answer = randomUUID();
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [answer, spaceId, teammate]);
    await c.query(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,$4)`, [answer, chat, teammate, text]);
    await c.query(`update public.chat_turns set state = 'completed', agent_message_id = $2, completed_at = now() where user_message_id = $1`,
      [copyId, answer]);
  });
  return answer;
}
/** A member's reply in tm8 to the log message, optionally marked *Reply here only* in the same transaction. */
async function memberReply(logMessage: string, hereOnly: boolean): Promise<string> {
  const id = randomUUID();
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.entities(id, space_id, kind, parent_id, created_by) values ($1,$2,'message',$3,$4)`,
      [id, spaceId, logMessage, ownerMember]);
    await c.query(`insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body) values ($1,$2,$3,$4,'On it.')`,
      [id, infra, logMessage, ownerMember]);
    if (hereOnly) await c.query('insert into public.bridge_here_only(message_id) values ($1)', [id]);
  });
  return id;
}

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('bridges_progress');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner'),($2,'Linked')`, [ownerIdentity, linkedIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username, is_node_admin) values ($1,$2,'progress-owner', true)`, [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Bridges progress',$2)`, [spaceId, ownerIdentity]);
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
      values ($1,$2,'Infra main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/progress', gen_random_uuid(), $4, $5, $6)`,
      [chat, spaceId, teammate, ownerIdentity, ownerMember, `progress-${randomUUID()}`]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`,
      [session, spaceId, ownerMember]);
    await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Deploy fixer','running','none',now())`, [session]);
    for (const [id, name] of [[channel, 'deploys'], [quietChannel, 'mirror']] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'channel',$3)`, [id, spaceId, ownerMember]);
      await c.query(`insert into public.channels(entity_id, space_id, name, topic) values ($1,$2,$3,'')`, [id, spaceId, name]);
    }
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …9494','linked')`, [connection, ownerAccount]);
    // Priya's number is linked to her identity: a member. Rahul is a guest.
    await c.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, verified_at)
      values ('whatsapp',$1,$2,'code',now())`, [PRIYA, linkedIdentity]);
  });
  await human(q => q.rpc('offer_bridge_connection', [connection, spaceId, 'public', null, randomUUID()]));
  const create = async (conv: string, title: string, target: string) => (await human(q => q.rpc<{ entity: { id: string } }>('create_bridge', [
    spaceId, connection, conv, JSON.stringify({ kind: 'group', title, memberCount: 5 }),
    target, '{}', teammate, null, null, true, null, null, randomUUID(),
  ]))).entity.id;
  infra = await create(INFRA, 'Infra', chat);        // group default: trigger mention, whoMayTrigger linked
  ops = await create(OPS, 'Ops', session);
  deploys = await create(DEPLOYS, 'Deploys', channel);
  quiet = await create(QUIET, 'Mirror', quietChannel); // channel default: trigger none, a silent mirror
  await owner(`update public.bridges set policy = policy || '{"trigger":"every"}' where entity_id = $1`, [deploys]);

  const hash = createHash('sha256').update(randomUUID()).digest('hex');
  runtimeSession = (await db.rpc<{ id: string }>({ identityId: ownerIdentity, nodeAdmin: true, requestId: randomUUID() },
    'issue_bridge_runtime_session', [hash, new Date(Date.now() + 86_400_000).toISOString(), 'whatsapp-runtime'])).id;
  await door('bridge_runtime_hello', JSON.stringify({ provider: 'whatsapp', version: 1, runtimeId: 'wa-progress', capabilities: {} }));
  await owner(`update public.bridge_connections set runtime_id = 'wa-progress', status = 'linked' where id = $1`, [connection]);
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

// The §2.7 buckets count every row of the last minute; each case starts with
// the earlier ones out of the window, and nothing left due from them.
beforeEach(async () => {
  await owner(`update public.bridge_outbox set created_at = created_at - interval '5 minutes'`);
  await flush();
});

describe('one reaction that advances (WhatsApp keeps one per sender)', () => {
  it('a routed chat message: 📨 at inbound, 👀 when its turn is claimed, ✅ when the answer is on WhatsApp', async () => {
    const r = await inbound(frame({ body: '@tm8 deploy status?' }));
    expect(r).toMatchObject({ status: 'stored', routed: true });
    expect(await reacts(r.messageId)).toEqual([expect.objectContaining({ reaction: 'tm8:delivered', status: 'pending', emoji: '📨' })]);

    const first = await flush();
    const ext = (await owner<{ e: string }>('select external_message_id as e from public.message_origins where message_id = $1', [r.messageId]))[0]!.e;
    expect(first.find(f => f.frame.type === 'react')!.frame).toMatchObject({ emoji: '📨', target: { externalMessageId: ext } });

    await turnClaimed(r.copyId!);
    expect((await reacts(r.messageId)).map(x => [x.reaction, x.status, x.emoji])).toEqual([
      ['tm8:delivered', 'sent', '📨'], ['tm8:seen', 'pending', '👀']]);
    expect((await flush()).map(f => f.frame.emoji)).toEqual(['👀']);

    const answer = await turnAnswered(r.copyId!, 'Deployed at 10:40.');
    // Queued is not replied: the answer has to reach WhatsApp first.
    expect(await reacts(r.messageId)).toHaveLength(2);
    const [send] = await owner<{ id: string }>(`select id from public.bridge_outbox where message_id = $1 and kind = 'send'`, [answer]);
    const frames = await take();
    expect(frames.map(f => f.frame.outboxId)).toEqual([send!.id]);
    await sent(send!.id);
    expect((await reacts(r.messageId)).map(x => [x.reaction, x.status, x.emoji])).toEqual([
      ['tm8:delivered', 'sent', '📨'], ['tm8:seen', 'sent', '👀'], ['tm8:replied', 'pending', '✅']]);
    expect((await flush()).map(f => f.frame.emoji)).toEqual(['✅']);
  });

  it('a stage not yet dispatched is rewritten to the next one: one row, not two', async () => {
    const r = await inbound(frame());
    await turnClaimed(r.copyId!);
    expect((await reacts(r.messageId)).map(x => [x.reaction, x.status, x.emoji])).toEqual([['tm8:seen', 'pending', '👀']]);
    expect((await flush()).map(f => f.frame.emoji)).toEqual(['👀']);
  });

  it('a channel target starts at 👀: the log copy is the channel post', async () => {
    const r = await inbound(frame({ conversationId: DEPLOYS, body: 'release cut' }));
    expect((await reacts(r.messageId)).map(x => [x.reaction, x.emoji])).toEqual([['tm8:seen', '👀']]);
  });

  it('a session target: 📨, then 👀 when the prompt is delivered to the session', async () => {
    const r = await inbound(frame({ conversationId: OPS, body: '@tm8 restart the job' }));
    expect((await reacts(r.messageId)).map(x => x.reaction)).toEqual(['tm8:delivered']);
    const routes = await worker<{ targetMessageId: string }[]>('internal.bridge_inbound_deliveries', [r.messageId]);
    expect(routes).toHaveLength(1);
    const delivery = randomUUID();
    await scratch.query(`insert into public.session_message_deliveries(delivery_id, message_id, target_work_session_id, status)
      values ($1,$2,$3,'pending')`, [delivery, routes[0]!.targetMessageId, session]);
    expect((await reacts(r.messageId)).map(x => x.reaction)).toEqual(['tm8:delivered']);
    await scratch.query(`update public.session_message_deliveries set status = 'dispatching', claimed_at = now() where delivery_id = $1`, [delivery]);
    await scratch.query(`update public.session_message_deliveries set status = 'delivered', settled_at = now() where delivery_id = $1`, [delivery]);
    expect((await reacts(r.messageId)).map(x => [x.reaction, x.emoji])).toEqual([['tm8:seen', '👀']]);
  });
});

describe('never a step back', () => {
  it('a stage at or below the current one is not enqueued', async () => {
    const r = await inbound(frame());
    await turnClaimed(r.copyId!);
    await flush();
    await turnAnswered(r.copyId!, 'Done.');
    await flush();
    expect((await reacts(r.messageId)).map(x => x.reaction)).toEqual(['tm8:seen', 'tm8:replied']);
    expect(await advance(r.messageId, 'seen')).toMatchObject({ status: 'ignored', reason: 'behind' });
    expect(await advance(r.messageId, 'delivered')).toMatchObject({ status: 'ignored', reason: 'behind' });
    expect(await advance(r.messageId, 'replied')).toMatchObject({ status: 'ignored', reason: 'behind' });
    expect((await reacts(r.messageId)).map(x => x.reaction)).toEqual(['tm8:seen', 'tm8:replied']);
  });

  it('a 📨 retried after 👀 went out is dropped at dispatch, never sent', async () => {
    const r = await inbound(frame());
    const [inFlight] = await take();
    expect(inFlight!.frame.emoji).toBe('📨');
    await turnClaimed(r.copyId!);
    // The runtime reports the 📨 failed, retryably, after 👀 was queued.
    await door('bridge_runtime_sent', JSON.stringify({ outboxId: inFlight!.frame.outboxId, connectionId: connection,
      failed: { retryable: true, reason: 'socket closed' } }));
    await owner(`update public.bridge_outbox set next_attempt_at = now() where id = $1`, [inFlight!.frame.outboxId]);
    expect((await flush()).map(f => f.frame.emoji)).toEqual(['👀']);
    expect((await reacts(r.messageId)).map(x => [x.reaction, x.status, x.last_error])).toEqual([
      ['tm8:delivered', 'failed_permanent', 'superseded'], ['tm8:seen', 'sent', null]]);
  });

  it("the watchdog's ⚠️ outranks 👀; a reply that goes out still lands ✅ over it", async () => {
    const r = await inbound(frame({ body: '@tm8 will stall' }));
    await flush();
    await owner(`update public.chat_turns set state = 'error' where user_message_id = $1`, [r.copyId]);
    await worker('internal.bridge_watchdog_tick');
    expect((await flush()).map(f => f.frame.emoji)).toEqual(['⚠️']);
    expect(await advance(r.messageId, 'seen')).toMatchObject({ status: 'ignored', reason: 'behind' });
    const reply = await memberReply(r.messageId, false);
    const [send] = await owner<{ id: string }>(`select id from public.bridge_outbox where message_id = $1 and kind = 'send'`, [reply]);
    await sent(send!.id);
    expect((await flush()).map(f => f.frame.emoji)).toEqual(['✅']);
    expect((await reacts(r.messageId)).map(x => x.reaction)).toEqual(['tm8:delivered', 'watchdog', 'tm8:replied']);
  });

  it("an explicit reaction is someone's answer: progress stops there", async () => {
    const r = await inbound(frame());
    await worker('internal.bridge_react_message', [infra, r.messageId, '👍', null]);
    await turnClaimed(r.copyId!);
    expect(await advance(r.messageId, 'replied')).toMatchObject({ status: 'ignored', reason: 'explicit_reaction' });
    // The 📨 still waiting is overtaken by the 👍 and never sent.
    expect((await flush()).map(f => f.frame.emoji)).toEqual(['👍']);
    expect((await reacts(r.messageId)).map(x => [x.reaction, x.status])).toEqual([
      ['tm8:delivered', 'failed_permanent'], ['👍', 'sent']]);
  });
});

describe('the gates', () => {
  it('only messages tm8 acts on: chatter, a guest where only linked may trigger, a command and a mirror get none', async () => {
    const chatter = await inbound(frame({ body: 'lunch?' }));
    expect(chatter.routed).toBe(false);
    const guest = await inbound(frame({ sender: rahul, body: '@tm8 do it' }));
    expect(guest.routed).toBe(false);
    const command = await inbound(frame({ body: '/status' }), true);
    const mirrored = await inbound(frame({ conversationId: QUIET, body: 'mirror me' }));
    const guestInChannel = await inbound(frame({ conversationId: DEPLOYS, sender: rahul, body: 'hi' }));
    for (const m of [chatter, guest, command, mirrored, guestInChannel]) {
      expect(m.status).toBe('stored');
      expect(await reacts(m.messageId)).toEqual([]);
    }
    expect(await advance(chatter.messageId, 'replied')).toMatchObject({ status: 'ignored', reason: 'not_addressed' });
    expect(await advance(command.messageId, 'seen')).toMatchObject({ status: 'ignored', reason: 'not_inbound' });
  });

  it('*Reply here only* never crosses, so it never reaches ✅; a reply that crosses does', async () => {
    const r = await inbound(frame());
    await turnClaimed(r.copyId!);
    await flush();
    const local = await memberReply(r.messageId, true);
    expect(await owner(`select 1 from public.bridge_outbox where message_id = $1`, [local])).toEqual([]);
    expect(await flush()).toEqual([]);
    expect((await reacts(r.messageId)).map(x => x.reaction)).toEqual(['tm8:seen']);

    const crossing = await memberReply(r.messageId, false);
    const [send] = await owner<{ id: string }>(`select id from public.bridge_outbox where message_id = $1 and kind = 'send'`, [crossing]);
    expect((await take()).map(f => f.frame.outboxId)).toEqual([send!.id]);
    await sent(send!.id);
    expect((await reacts(r.messageId)).map(x => [x.reaction, x.emoji])).toEqual([['tm8:seen', '👀'], ['tm8:replied', '✅']]);
  });

  it('a paused bridge refuses the next stage and drops the one waiting; resumed, progress goes on', async () => {
    const r = await inbound(frame());
    await owner(`update public.bridges set paused_at = now() where entity_id = $1`, [infra]);
    await turnClaimed(r.copyId!);
    expect(await advance(r.messageId, 'seen')).toMatchObject({ status: 'ignored', reason: 'behind' });
    expect(await flush()).toEqual([]);
    expect((await reacts(r.messageId)).map(x => [x.reaction, x.status, x.last_error])).toEqual([
      ['tm8:seen', 'failed_permanent', 'bridge_paused']]);
    await owner(`update public.bridges set paused_at = null where entity_id = $1`, [infra]);
    // While paused nothing reaches tm8 at all (398 refuses the inbound).
    const r2 = await inbound(frame());
    await owner(`update public.bridges set muted_until = now() + interval '1 hour' where entity_id = $1`, [infra]);
    await turnClaimed(r2.copyId!);
    expect(await flush()).toEqual([]);
    expect((await reacts(r2.messageId)).map(x => [x.reaction, x.status, x.last_error])).toEqual([
      ['tm8:seen', 'failed_permanent', 'bridge_paused']]);
    await owner(`update public.bridges set muted_until = null where entity_id = $1`, [infra]);
    const answer = await turnAnswered(r2.copyId!, 'Back.');
    const [send] = await owner<{ id: string }>(`select id from public.bridge_outbox where message_id = $1 and kind = 'send'`, [answer]);
    await take();
    await sent(send!.id);
    expect((await reacts(r2.messageId)).map(x => [x.reaction, x.status])).toEqual([
      ['tm8:seen', 'failed_permanent'], ['tm8:replied', 'pending']]);
  });

  it('after the bridge ended: the next stage is refused, a waiting one is never sent, and nothing new arrives', async () => {
    const r = await inbound(frame({ conversationId: OPS, body: '@tm8 one more' }));
    const routes = await worker<{ targetMessageId: string }[]>('internal.bridge_inbound_deliveries', [r.messageId]);
    await flush();
    expect((await reacts(r.messageId)).map(x => [x.reaction, x.status])).toEqual([['tm8:delivered', 'sent']]);
    const waiting = await inbound(frame({ conversationId: OPS, body: '@tm8 and this' }));
    await owner(`update public.bridges set ended_at = now() where entity_id = $1`, [ops]);
    // The session still takes the prompt in; WhatsApp hears nothing more.
    await scratch.query(`insert into public.session_message_deliveries(delivery_id, message_id, target_work_session_id, status, claimed_at, settled_at)
      values ($1,$2,$3,'delivered',now(),now())`, [randomUUID(), routes[0]!.targetMessageId, session]);
    expect(await advance(r.messageId, 'seen')).toMatchObject({ status: 'refused', reason: 'bridge_ended' });
    expect((await reacts(r.messageId)).map(x => [x.reaction, x.status])).toEqual([['tm8:delivered', 'sent']]);
    expect(await flush()).toEqual([]);
    expect((await reacts(waiting.messageId)).map(x => [x.status, x.last_error])).toEqual([['failed_permanent', 'bridge_ended']]);
    expect((await inbound(frame({ conversationId: OPS }))).status).toBe('refused');
  });
});
