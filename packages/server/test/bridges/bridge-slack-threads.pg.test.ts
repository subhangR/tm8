/**
 * Migration 444: Slack thread mode (one session per thread) and /tm8 slash
 * commands (design doc 01a1ed5f-40af §1.2-1.3, §2.1; lane F).
 *
 * A Slack bridge targets a work session. Frames go through the runtime's own
 * SQL door under a minted bridge_runtime session; the keeper (with its thread
 * keeper), the delivery, the notice outbox and the command executor run the
 * server's real code, with fakes only for the PTY host (spawn and resume write
 * the session row, stop ends it).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createBridgeSessionDelivery } from '../../src/bridges/runtime/deliver.js';
import { createBridgeSessionKeeper } from '../../src/bridges/runtime/keeper.js';
import { createBridgeThreadKeeper, threadTitle } from '../../src/bridges/runtime/threads.js';
import { createBridgeCommandExecutor } from '../../src/bridges/commands/executor.js';
import { createBridgeCommands, createBridgeKeeper } from '../../src/bridges/commands/index.js';
import type { SpawnService } from '@tm8/execution';
import type { BridgeCommandPorts, SpawnWorkerRequest } from '../../src/bridges/commands/ports.js';
import { bridgesWorkerClaims, postBridgeNotice } from '../../src/bridges/outbox.js';
import type { MessageDeliveryPort } from '../../src/facade/services/w2/message-dispatch.js';
import { issueBridgeRuntimeSession } from '../../src/identity/pg-auth.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID(), ownerMember = randomUUID(), teammate = randomUUID(), target = randomUUID();
const ownerIdentity = `slack-${randomUUID()}`, ownerAccount = randomUUID(), connection = randomUUID(), waConnection = randomUUID();
const CHANNEL = 'C0ENGSUPPORT';
const BOT = 'U0TM8BOT', OWNER_SLACK = 'U0PRIYA', GUEST_SLACK = 'U0GUEST';
let bridge = '';
let runtimeSession = '';
let seq = 0;

const runtime = (): DbClaims => ({ identityId: ownerIdentity, authKind: 'bridge_runtime', authSessionId: runtimeSession, requestId: randomUUID() });
const human = (): DbClaims => ({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() });
const owner = <T>(sql: string, params: unknown[] = []) => scratch.transaction(async (c) => {
  await c.query('set local role tm8_graph_owner');
  return (await c.query(sql, params)).rows as T[];
});

type Inbound = {
  status: string; messageId: string; routed: boolean; bridgeId: string; command?: boolean;
  targetSession?: { sessionId: string; live: boolean };
  thread?: { rootExternalId: string; sessionId?: string; started?: boolean };
};
const ts = () => `1790300${String(++seq).padStart(3, '0')}.000100`;
function frame(o: { body: string; ext?: string; sender?: string; mentions?: string[]; root?: string | null; slash?: { command: string; text: string } }) {
  return {
    connectionId: connection, conversationId: CHANNEL, externalMessageId: o.ext ?? ts(),
    sender: { externalId: o.sender ?? OWNER_SLACK, altId: null, name: o.sender === GUEST_SLACK ? 'Guest' : 'Priya', fromMe: false },
    body: o.body, kind: 'text', media: [],
    replyTo: o.root ? { externalMessageId: o.root, senderExternalId: null, media: null } : null,
    mentions: o.mentions ?? [], ts: 1_790_300_000 + seq,
    ...(o.root ? { thread: { rootExternalMessageId: o.root } } : {}),
    ...(o.slash ? { slashCommand: o.slash } : {}),
  };
}
const inbound = (o: Parameters<typeof frame>[0], command = false) =>
  db.rpc<Inbound>(runtime(), 'bridge_runtime_inbound', [JSON.stringify(frame(o)), command]);

const setStatus = (id: string, status: string) => scratch.transaction(async (c) => {
  await c.query('set local role tm8_graph_owner');
  await c.query("select set_config('tm8.work_session_transition', 'on', true)");
  await c.query('update public.work_sessions set status = $2, status_changed_at = now() where entity_id = $1', [id, status]);
});
const policy = async () => (await owner<{ policy: Record<string, unknown> }>('select policy from public.bridges where entity_id = $1', [bridge]))[0]!.policy;
const setPolicy = (patch: Record<string, unknown>) =>
  owner(`update public.bridges set policy = policy || $2::jsonb where entity_id = $1`, [bridge, JSON.stringify(patch)]);
const threadRow = async (root: string) => (await owner<{ session_id: string | null; idle_stopped_at: string | null; root_message_id: string }>(
  'select session_id::text, idle_stopped_at, root_message_id::text from public.bridge_threads where bridge_id = $1 and root_external_id = $2', [bridge, root]))[0];

function capturingPort(): { port: MessageDeliveryPort; sent: { session: string; content: string }[] } {
  const sent: { session: string; content: string }[] = [];
  return {
    sent,
    port: {
      async reserve(intent) { sent.push({ session: intent.targetWorkSessionId, content: intent.content }); return { deliveryId: randomUUID() }; },
      adapter: { dispatch: async () => undefined, reject: async () => undefined },
      principalFor: () => ({}),
    },
  };
}

/** The PTY host, faked: spawn writes a running session (replayed per mutation id), resume flips it to running, stop ends it. */
const spawns: SpawnWorkerRequest[] = [];
const spawned = new Map<string, string>();
const resumes: string[] = [];
const stops: string[] = [];
const notices: string[] = [];
const workers: Pick<BridgeCommandPorts, 'spawnWorker' | 'resumeWorker' | 'stopWorker'> = {
  async spawnWorker(_claims, request) {
    const prior = spawned.get(request.clientMutationId);
    if (prior) return { sessionId: prior };
    spawns.push(request);
    const id = randomUUID();
    await owner(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`, [id, spaceId, teammate]);
    await owner(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,$2,'running','none',now())`, [id, request.title]);
    await scratch.transaction((c) => c.query('select public.record_bridge_provenance($1, $2::jsonb)', [id, JSON.stringify(request.origins)]));
    spawned.set(request.clientMutationId, id);
    return { sessionId: id };
  },
  async resumeWorker(_claims, sessionId) {
    resumes.push(sessionId);
    await setStatus(sessionId, 'running');
    return { sessionId };
  },
  async stopWorker(_claims, sessionId) {
    stops.push(sessionId);
    await setStatus(sessionId, 'exited');
  },
};
const threads = () => createBridgeThreadKeeper({
  db, ...workers, async postNotice(_db, input) { notices.push(input.text); return {}; },
});
const keeper = () => createBridgeSessionKeeper({
  db, spawnWorker: workers.spawnWorker, resumeWorker: workers.resumeWorker,
  async postNotice(_db, input) { notices.push(input.text); return {}; },
  threads: threads(),
});

describe('444: Slack thread mode', () => {
  beforeAll(async () => {
    scratch = await createW1ScratchDatabase('bridges_slack_threads');
    scratch.apply(migrationFiles());
    db = createDb(scratch.url, { max: 4 });
    await scratch.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Priya')`, [ownerIdentity]);
      await c.query(`insert into public.accounts(id, identity_id, username, is_node_admin) values ($1,$2,'priya',true)`, [ownerAccount, ownerIdentity]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Acme',$2)`, [spaceId, ownerIdentity]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [ownerMember, spaceId]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Priya')`,
        [ownerMember, spaceId, ownerIdentity]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
      await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1,$2,'Support Bot','worker','persona')`,
        [teammate, ownerMember]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`,
        [target, spaceId, teammate]);
      await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Support desk','running','none',now())`, [target]);
      // 443 keeps the bot's user id (state.account.botUserId) in self_ids.
      await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status, self_ids) values ($1,'slack',$2,'Acme','linked',$3)`,
        [connection, ownerAccount, [BOT]]);
      await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status) values ($1,'whatsapp',$2,'+91 …9494','linked')`,
        [waConnection, ownerAccount]);
      await c.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, verified_at) values ('slack',$1,$2,'code',now())`,
        [OWNER_SLACK, ownerIdentity]);
    });
    for (const conn of [connection, waConnection]) {
      await db.tx(human(), (q) => q.rpc('offer_bridge_connection', [conn, spaceId, 'public', null, randomUUID()]));
    }
    const created = await db.tx(human(), (q) =>
      q.rpc<{ entity: { id: string } }>('create_bridge', [spaceId, connection, CHANNEL,
        JSON.stringify({ kind: 'channel', title: 'eng-support', memberCount: 40 }), target, JSON.stringify({}),
        teammate, null, null, true, null, null, randomUUID()]));
    bridge = created.entity.id;
    runtimeSession = (await issueBridgeRuntimeSession(db, { identityId: ownerIdentity, nodeAdmin: true, requestId: 'mint' }, 'slack-threads')).sessionId;
  });

  afterAll(async () => { await db?.end(); await scratch?.destroy(); });

  it('a new Slack bridge defaults to threadMode mention; the policy patch changes it; other providers may not set it', async () => {
    expect(await policy()).toMatchObject({ trigger: 'mention', whoMayTrigger: 'linked', threadMode: 'mention' });
    const version = async () => Number((await owner<{ version: number }>('select version from public.entities where id = $1', [bridge]))[0]!.version);
    await db.tx(human(), async (q) => q.rpc('update_bridge', [bridge, await version(), JSON.stringify({ policy: { threadMode: 'every' } }), null, randomUUID()]));
    expect((await policy())['threadMode']).toBe('every');
    await expect(db.tx(human(), async (q) => q.rpc('update_bridge', [bridge, await version(), JSON.stringify({ policy: { threadMode: 'always' } }), null, randomUUID()])))
      .rejects.toMatchObject({ message: expect.stringMatching(/threadMode must be off, mention or every/) });
    await db.tx(human(), async (q) => q.rpc('update_bridge', [bridge, await version(), JSON.stringify({ policy: { threadMode: 'mention' } }), null, randomUUID()]));
    const otherTarget = randomUUID();
    await owner(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`, [otherTarget, spaceId, teammate]);
    await owner(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Family','running','none',now())`, [otherTarget]);
    await expect(db.tx(human(), (q) => q.rpc('create_bridge', [spaceId, waConnection, '120363999@g.us',
      JSON.stringify({ kind: 'group', title: 'Family', memberCount: 4 }), otherTarget, JSON.stringify({ threadMode: 'mention' }),
      teammate, null, null, true, null, null, randomUUID()])))
      .rejects.toMatchObject({ message: expect.stringMatching(/threadMode is for Slack bridges only/) });
  });

  let root = '';
  let threadSession = '';

  it('mention: a top-level @mention starts its own session, a child of the target, anchored on the root ts', async () => {
    root = ts();
    const stored = await inbound({ ext: root, body: `<@${BOT}> the login page 500s on Safari since this morning`, mentions: [BOT] });
    expect(stored).toMatchObject({ status: 'stored', routed: false, thread: { rootExternalId: root, started: true },
      targetSession: { sessionId: target, live: false } });
    expect(await threadRow(root)).toMatchObject({ session_id: null, root_message_id: stored.messageId });
    const reacts = async () => (await owner<{ reaction: string; emoji: string }>(
      `select reaction, payload ->> 'emoji' as emoji from public.bridge_outbox where message_id = $1 and kind = 'react' order by created_at`,
      [stored.messageId]));
    // No session yet, so nothing at the inbound commit.
    expect(await reacts()).toEqual([]);

    expect(await keeper().ensure(bridge, stored.messageId)).toBe('started');
    // 📨 once its session holds it (427 progress), before any reply.
    expect(await reacts()).toEqual([{ reaction: 'tm8:delivered', emoji: '📨' }]);
    const spawn = spawns.at(-1)!;
    expect(spawn).toMatchObject({
      teamMemberId: teammate, taskId: null, parentSessionId: target,
      title: 'The login page 500s on Safari since this morning',
      origins: [{ bridgeId: bridge, messageId: stored.messageId, providerMessageId: root, command: '/thread' }],
    });
    expect(spawn.promptExtra).toMatch(/Slack channel #eng-support/);
    threadSession = (await threadRow(root))!.session_id!;
    expect(threadSession).toBe(spawned.get(spawn.clientMutationId));
    // The bridge still targets its own session.
    expect((await owner<{ target_id: string }>('select target_id::text from public.bridges where entity_id = $1', [bridge]))[0]!.target_id).toBe(target);

    const { port, sent } = capturingPort();
    await createBridgeSessionDelivery({ db, delivery: port })(stored.messageId);
    expect(sent.map((s) => s.session)).toEqual([threadSession]);
    expect(sent[0]!.content).toMatch(/directed="true"/);
    const answerer = await owner<{ answerer_id: string }>('select answerer_id::text from public.bridge_message_answerers where message_id = $1', [stored.messageId]);
    expect(answerer.map((a) => a.answerer_id)).toEqual([threadSession]);

    // A rebind (as on a resume) adds no second 📨.
    await db.rpc(bridgesWorkerClaims(), 'bridge_thread_bind', [bridge, root, threadSession]);
    expect(await reacts()).toHaveLength(1);

    // The same root again (app_mention and message events): no second thread, no second session.
    expect(await inbound({ ext: root, body: `<@${BOT}> the login page 500s`, mentions: [BOT] })).toMatchObject({ status: 'duplicate' });
    expect((await owner<{ n: number }>('select count(*)::int n from public.bridge_threads where bridge_id = $1', [bridge]))[0]!.n).toBe(1);
  });

  it('mention: an unmentioned top-level message, or a guest\'s mention, starts nothing', async () => {
    const quiet = await inbound({ body: 'anyone seen the deploy?' });
    expect(quiet).toMatchObject({ status: 'stored', routed: false });
    expect(quiet.thread).toBeUndefined();
    const guest = await inbound({ body: `<@${BOT}> help`, mentions: [BOT], sender: GUEST_SLACK });
    expect(guest.thread).toBeUndefined();
    expect(guest.routed).toBe(false);
    expect((await owner<{ n: number }>('select count(*)::int n from public.bridge_threads where bridge_id = $1', [bridge]))[0]!.n).toBe(1);
  });

  it('a thread reply goes to the thread session alone, never the target, even when it mentions the bot', async () => {
    const { port, sent } = capturingPort();
    const reply = await inbound({ body: `<@${BOT}> can you also add a regression test?`, mentions: [BOT], root });
    expect(reply).toMatchObject({ status: 'stored', routed: false, thread: { rootExternalId: root, sessionId: threadSession } });
    expect(reply.targetSession).toBeUndefined();
    await createBridgeSessionDelivery({ db, delivery: port })(reply.messageId);
    expect(sent.map((s) => s.session)).toEqual([threadSession]);
    expect(sent[0]!.content).toContain('regression test');
    const logged = await owner<{ root_message_id: string }>('select root_message_id::text from public.messages where entity_id = $1', [reply.messageId]);
    expect(logged[0]!.root_message_id).toBe((await threadRow(root))!.root_message_id);
  });

  it('a thread start honours the policy: none on trigger "none" or direction "in"', async () => {
    const threads0 = async () => (await owner<{ n: number }>('select count(*)::int n from public.bridge_threads where bridge_id = $1', [bridge]))[0]!.n;
    const before = await threads0();
    await setPolicy({ trigger: 'none' });
    expect((await inbound({ body: `<@${BOT}> log only here`, mentions: [BOT] })).thread).toBeUndefined();
    await setPolicy({ trigger: 'mention', direction: 'in' });
    expect((await inbound({ body: `<@${BOT}> tm8 may not post here`, mentions: [BOT] })).thread).toBeUndefined();
    await setPolicy({ threadMode: 'every' });
    expect((await inbound({ body: 'every, but direction in' })).thread).toBeUndefined();
    await setPolicy({ direction: 'both', threadMode: 'mention' });
    expect(await threads0()).toBe(before);
  });

  it('a guest\'s thread reply reaches the thread session only where anyone may trigger', async () => {
    const { port, sent } = capturingPort();
    const guest = await inbound({ body: 'I am not linked', root, sender: GUEST_SLACK });
    expect(guest).toMatchObject({ status: 'stored', routed: false });
    expect(guest.targetSession).toBeUndefined();
    await createBridgeSessionDelivery({ db, delivery: port })(guest.messageId);
    expect(sent).toEqual([]);
    await setPolicy({ whoMayTrigger: 'anyone' });
    const allowed = await inbound({ body: 'now anyone may', root, sender: GUEST_SLACK });
    await createBridgeSessionDelivery({ db, delivery: port })(allowed.messageId);
    expect(sent.map((x) => x.session)).toEqual([threadSession]);
    await setPolicy({ whoMayTrigger: 'linked' });
  });

  it('outbox: replies go into the thread; a thread session\'s own post goes into its thread; a slash command answer does not', async () => {
    const reply = await inbound({ body: 'and on iOS?', root });
    const notice = await postBridgeNotice(db, { bridgeId: bridge, text: 'looking', replyToMessageId: reply.messageId, idempotencyKey: `t:${randomUUID()}` });
    const row = async (messageId: string) => (await owner<{ thread_ts: string | null; external_reply_to: string | null }>(
      'select thread_ts, external_reply_to from public.bridge_outbox where message_id = $1 and kind = $2', [messageId, 'send']))[0];
    expect((await row(notice.messageId))!.thread_ts).toBe(root);

    // A top-level message answered in 'off'-style routing still gets a thread under it.
    const top = await inbound({ body: 'plain chatter' });
    const topNotice = await postBridgeNotice(db, { bridgeId: bridge, text: 'noted', replyToMessageId: top.messageId, idempotencyKey: `t:${randomUUID()}` });
    const topExt = (await owner<{ e: string }>('select external_message_id e from public.message_origins where message_id = $1', [top.messageId]))[0]!.e;
    expect((await row(topNotice.messageId))!.thread_ts).toBe(topExt);

    // The thread session posts unprompted (no reply-to): its thread.
    const own = randomUUID();
    await owner(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [own, spaceId, teammate]);
    await owner(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,'CI is green')`, [own, threadSession, teammate]);
    await owner(`insert into public.bridge_outbox(bridge_id, message_id, payload, kind, connection_id, external_conversation_id, poster, session_id)
      values ($1,$2,'{"text":"CI is green"}','send',$3,$4,'worker',$5)`, [bridge, own, connection, CHANNEL, threadSession]);
    expect((await row(own))!.thread_ts).toBe(root);

    // A reply to one of tm8's own posts goes into the thread that post is in.
    await owner(`update public.bridge_outbox set external_message_id = $2 where message_id = $1`, [notice.messageId, 'OUT-TS-1']);
    const after = randomUUID();
    await owner(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [after, spaceId, teammate]);
    await owner(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,'follow-up')`, [after, target, teammate]);
    await owner(`insert into public.bridge_outbox(bridge_id, message_id, external_reply_to, payload, kind, connection_id, external_conversation_id, poster)
      values ($1,$2,'OUT-TS-1','{"text":"follow-up"}','send',$3,$4,'worker')`, [bridge, after, connection, CHANNEL]);
    expect((await row(after))!.thread_ts).toBe(root);

    // A slash command's answer goes to the channel.
    const cmd = await inbound({ ext: `cmd:${randomUUID()}`, body: '/status', slash: { command: '/tm8', text: 'status' } }, true);
    const answer = await postBridgeNotice(db, { bridgeId: bridge, text: 'nothing running', replyToMessageId: cmd.messageId, idempotencyKey: `t:${randomUUID()}` });
    expect((await row(answer.messageId))!.thread_ts).toBeNull();
  });

  it('a reply to a stopped thread session resumes it before delivery', async () => {
    await setStatus(threadSession, 'exited');
    const reply = await inbound({ body: "it's back on iOS", root });
    expect(reply.targetSession).toEqual({ sessionId: threadSession, live: false });
    expect(await keeper().ensure(bridge, reply.messageId)).toBe('resumed');
    expect(resumes).toEqual([threadSession]);
    const { port, sent } = capturingPort();
    await createBridgeSessionDelivery({ db, delivery: port })(reply.messageId);
    expect(sent.map((s) => s.session)).toEqual([threadSession]);
    // The bridge's own target was never touched.
    expect(spawns).toHaveLength(1);
  });

  it('idle: a thread session waiting 2h with nothing in its thread is stopped; the next reply resumes it', async () => {
    await setStatus(threadSession, 'idle');
    expect(await threads().sweepThreads()).toBe(0); // recent activity
    await owner(`update public.bridge_threads set last_activity_at = now() - interval '3 hours' where bridge_id = $1 and root_external_id = $2`, [bridge, root]);
    await setStatus(threadSession, 'running');
    expect(await threads().sweepThreads()).toBe(0); // mid-turn: left alone
    await setStatus(threadSession, 'idle');
    expect(await threads().sweepThreads()).toBe(1);
    expect(stops).toEqual([threadSession]);
    expect((await threadRow(root))!.idle_stopped_at).not.toBeNull();
    expect(await threads().sweepThreads()).toBe(0); // once

    const reply = await inbound({ body: 'one more thing', root });
    expect(reply.targetSession).toEqual({ sessionId: threadSession, live: false });
    expect(await keeper().ensure(bridge, reply.messageId)).toBe('resumed');
    expect((await threadRow(root))!.idle_stopped_at).toBeNull();
  });

  /** A thread row with its own session and root message, written as the database owner. */
  async function rawThread(o: { bridgeId?: string; status: string; idleFor: string; deletedSession?: boolean }) {
    const session = randomUUID(), message = randomUUID(), ext = ts();
    await owner(`insert into public.entities(id, space_id, kind, created_by, visibility, deleted_at)
      values ($1,$2,'work_session',$3,'space',$4)`, [session, spaceId, teammate, o.deletedSession ? new Date() : null]);
    await owner(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'raw',$2,'none',now())`, [session, o.status]);
    await owner(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [message, spaceId, ownerMember]);
    await owner(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,'raw root')`, [message, o.bridgeId ?? bridge, ownerMember]);
    await owner(`insert into public.bridge_threads(bridge_id, root_external_id, root_message_id, session_id, last_activity_at)
      values ($1,$2,$3,$4, now() - $5::interval)`, [o.bridgeId ?? bridge, ext, message, session, o.idleFor]);
    return { session, ext };
  }

  it('idle sweep: threads it cannot stop never starve the rest; deleted sessions are skipped; a manual resume un-marks', async () => {
    // The good thread: idle 3h, its session waiting for input.
    await owner(`update public.bridge_threads set last_activity_at = now() - interval '3 hours', idle_stopped_at = null, stop_attempted_at = null
      where bridge_id = $1 and root_external_id = $2`, [bridge, root]);
    await setStatus(threadSession, 'idle');
    // 25 older threads whose stop always fails, and one whose session was deleted.
    const poison = new Set<string>();
    for (let i = 0; i < 25; i += 1) poison.add((await rawThread({ status: 'idle', idleFor: '5 hours' })).session);
    const deleted = await rawThread({ status: 'idle', idleFor: '6 hours', deletedSession: true });
    const calls: string[] = [];
    const sweeper = createBridgeThreadKeeper({
      db, ...workers,
      async stopWorker(_claims, sessionId) {
        calls.push(sessionId);
        if (poison.has(sessionId)) throw new Error('not_found');
        await setStatus(sessionId, 'exited');
      },
      async postNotice() { return {}; },
    });
    expect(await sweeper.sweepThreads()).toBe(0);
    expect(await sweeper.sweepThreads()).toBe(0);
    expect(await sweeper.sweepThreads()).toBe(1);
    expect(calls.filter((c) => poison.has(c))).toHaveLength(25);
    expect(new Set(calls).size).toBe(calls.length); // each tried once, none handed out again
    expect(calls).toContain(threadSession);
    expect(calls).not.toContain(deleted.session);
    expect((await threadRow(root))!.idle_stopped_at).not.toBeNull();
    expect(await sweeper.sweepThreads()).toBe(0);

    // Resumed by hand (not through the thread keeper): the mark goes, and it can idle out again.
    await setStatus(threadSession, 'running');
    await sweeper.sweepThreads();
    expect((await threadRow(root))!.idle_stopped_at).toBeNull();

    await owner('delete from public.bridge_threads where session_id = any($1::uuid[])', [[...poison, deleted.session]]);
  });

  it('idle sweep: bounded by its time budget; threads of a removed bridge are pruned once their session stops', async () => {
    const a = await rawThread({ status: 'idle', idleFor: '4 hours' });
    const b = await rawThread({ status: 'idle', idleFor: '4 hours' });
    let clock = 0;
    const calls: string[] = [];
    const sweeper = createBridgeThreadKeeper({
      db, ...workers, sweepBudgetMs: 1_500, now: () => (clock += 1_000),
      async stopWorker(_claims, sessionId) { calls.push(sessionId); await setStatus(sessionId, 'exited'); },
      async postNotice() { return {}; },
    });
    expect(await sweeper.sweepThreads()).toBe(1);
    expect(calls).toHaveLength(1);
    await owner('delete from public.bridge_threads where session_id = any($1::uuid[])', [[a.session, b.session]]);

    // A second Slack bridge, removed: its threads go once their session no longer runs.
    const other = randomUUID();
    await owner(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`, [other, spaceId, teammate]);
    await owner(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Other desk','running','none',now())`, [other]);
    const created = await db.tx(human(), (q) => q.rpc<{ entity: { id: string } }>('create_bridge', [spaceId, connection, 'C0OTHER',
      JSON.stringify({ kind: 'channel', title: 'other', memberCount: 3 }), other, JSON.stringify({}), teammate, null, null, true, null, null, randomUUID()]));
    const gone = await rawThread({ bridgeId: created.entity.id, status: 'running', idleFor: '1 minute' });
    const version = Number((await owner<{ version: number }>('select version from public.entities where id = $1', [created.entity.id]))[0]!.version);
    await db.tx(human(), (q) => q.rpc('remove_bridge', [created.entity.id, version, null, randomUUID()]));
    const left = async () => (await owner<{ n: number }>('select count(*)::int n from public.bridge_threads where root_external_id = $1', [gone.ext]))[0]!.n;
    await threads().sweepThreads();
    expect(await left()).toBe(1); // its session still runs
    await setStatus(gone.session, 'exited');
    await threads().sweepThreads();
    expect(await left()).toBe(0);
  });

  it('every: any top-level message starts a session; a start the server missed is made by the sweep with the root in its brief', async () => {
    await setPolicy({ threadMode: 'every' });
    const missedRoot = ts();
    const missed = await inbound({ ext: missedRoot, body: "what's our p95 on /search this week?" });
    expect(missed.thread).toMatchObject({ rootExternalId: missedRoot, started: true });
    await owner(`update public.bridge_threads set created_at = now() - interval '2 minutes' where bridge_id = $1 and root_external_id = $2`, [bridge, missedRoot]);
    expect(await threads().sweepThreads()).toBe(1);
    expect(spawns.at(-1)!.promptExtra).toContain("what's our p95 on /search this week?");
    expect(spawns.at(-1)!.title).toBe("What's our p95 on /search this week?");
    expect((await threadRow(missedRoot))!.session_id).not.toBeNull();
    expect(await threads().sweepThreads()).toBe(0);
  });

  it('off: the channel behaves like a WhatsApp group; a mention reaches the target, and no thread starts', async () => {
    await setPolicy({ threadMode: 'off' });
    const stored = await inbound({ body: `<@${BOT}> deploy status?`, mentions: [BOT] });
    expect(stored).toMatchObject({ routed: true, targetSession: { sessionId: target, live: true } });
    expect(stored.thread).toBeUndefined();
    // Threads that started a session keep routing to it.
    const reply = await inbound({ body: 'still there?', root });
    expect(reply.thread).toMatchObject({ rootExternalId: root });
    await setPolicy({ threadMode: 'mention' });
  });

  it('only the bridges worker may read or bind a thread', async () => {
    const callers: DbClaims[] = [human(), { identityId: ownerIdentity, authKind: 'agent', sessionSpaceId: spaceId, requestId: randomUUID() }];
    const rootMessage = (await threadRow(root))!.root_message_id;
    for (const claims of callers) {
      await expect(db.rpc(claims, 'bridge_thread_context', [bridge, rootMessage])).rejects.toMatchObject({ code: 'forbidden' });
      await expect(db.rpc(claims, 'bridge_thread_bind', [bridge, root, threadSession])).rejects.toMatchObject({ code: 'forbidden' });
      await expect(db.rpc(claims, 'bridge_threads_due', [60, 5])).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(await db.rpc(bridgesWorkerClaims(), 'bridge_thread_context', [bridge, rootMessage])).toMatchObject({ rootExternalId: root, sessionId: threadSession });
  });

  it('a session that replaces one whose resume failed is told the root and the thread so far', async () => {
    await setStatus(threadSession, 'exited');
    const replacing = createBridgeSessionKeeper({
      db, spawnWorker: workers.spawnWorker, resumeWorker: workers.resumeWorker, async postNotice() { return {}; },
      threads: createBridgeThreadKeeper({
        db, ...workers, async resumeWorker() { throw new Error('nothing to resume'); }, async postNotice() { return {}; },
      }),
    });
    const reply = await inbound({ body: 'so is it fixed?', root });
    expect(await replacing.ensure(bridge, reply.messageId)).toBe('replaced');
    const brief = spawns.at(-1)!.promptExtra!;
    expect(brief).toContain('the login page 500s on Safari since this morning');
    expect(brief).toContain('can you also add a regression test?');
    expect(brief).not.toContain('so is it fixed?'); // delivered next, not repeated
    const replacement = (await threadRow(root))!.session_id!;
    expect(replacement).not.toBe(threadSession);
    const { port, sent } = capturingPort();
    await createBridgeSessionDelivery({ db, delivery: port })(reply.messageId);
    expect(sent.map((x) => x.session)).toEqual([replacement]);
    threadSession = replacement;
  });

  it('a bridge whose target is not a session starts top-level thread sessions', async () => {
    const channel = randomUUID();
    await owner(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'channel',$3)`, [channel, spaceId, ownerMember]);
    await owner(`insert into public.channels(entity_id, space_id, name) values ($1,$2,'support-log')`, [channel, spaceId]);
    const created = await db.tx(human(), (q) => q.rpc<{ entity: { id: string } }>('create_bridge', [spaceId, connection, 'C0CHANTARGET',
      JSON.stringify({ kind: 'channel', title: 'support-log', memberCount: 5 }), channel,
      JSON.stringify({ trigger: 'mention' }), teammate, null, null, true, null, null, randomUUID()]));
    const channelBridge = created.entity.id;
    const ext = ts();
    const stored = await db.rpc<Inbound>(runtime(), 'bridge_runtime_inbound', [JSON.stringify({
      ...frame({ ext, body: `<@${BOT}> summarise yesterday`, mentions: [BOT] }), conversationId: 'C0CHANTARGET' }), false]);
    expect(stored).toMatchObject({ status: 'stored', routed: false, thread: { rootExternalId: ext, started: true } });
    expect(await keeper().ensure(channelBridge, stored.messageId)).toBe('started');
    expect(spawns.at(-1)).toMatchObject({ parentSessionId: null, teamMemberId: teammate, origins: [{ command: '/thread', providerMessageId: ext }] });
    const own = (await owner<{ session_id: string }>('select session_id::text from public.bridge_threads where bridge_id = $1', [channelBridge]))[0]!.session_id;
    const { port, sent } = capturingPort();
    await createBridgeSessionDelivery({ db, delivery: port })(stored.messageId);
    expect(sent.map((x) => x.session)).toEqual([own]);
  });

  it('wiring: the command executor\'s sweep runs the thread sweep, and the keeper starts threads, through the real worker port', async () => {
    const seen: { request: Record<string, unknown>; origins: Array<{ command: string | null }> }[] = [];
    const spawnService = {
      async spawn(_auth: unknown, request: Record<string, unknown>, server?: { bridgeOrigins?: Array<{ command: string | null }> }) {
        seen.push({ request, origins: server?.bridgeOrigins ?? [] });
        const id = randomUUID();
        await owner(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`, [id, spaceId, teammate]);
        await owner(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,$2,'running','none',now())`, [id, String(request['title'])]);
        await scratch.transaction((c) => c.query('select public.record_bridge_provenance($1, $2::jsonb)', [id, JSON.stringify(server?.bridgeOrigins ?? [])]));
        return { sessionId: id };
      },
      async resume() { throw new Error('not used'); },
    } as unknown as SpawnService;

    await setPolicy({ threadMode: 'every' });
    const missedRoot = ts();
    await inbound({ ext: missedRoot, body: 'nobody started me' });
    await owner(`update public.bridge_threads set created_at = now() - interval '2 minutes' where bridge_id = $1 and root_external_id = $2`, [bridge, missedRoot]);
    const commands = createBridgeCommands({ db, spawnService });
    expect(await commands.sweep()).toBeGreaterThanOrEqual(1);
    expect(seen.at(-1)!.request).toMatchObject({ parentSessionId: target, inheritPosture: null, mode: 'worker', title: 'Nobody started me' });
    expect(seen.at(-1)!.origins[0]!.command).toBe('/thread');
    expect((await threadRow(missedRoot))!.session_id).not.toBeNull();

    const fresh = await inbound({ body: 'a fresh top-level question' });
    expect(await createBridgeKeeper({ db, spawnService }).ensure(bridge, fresh.messageId)).toBe('started');
    expect(seen.at(-1)!.request).toMatchObject({ parentSessionId: target, inheritPosture: null, mode: 'worker' });
    await setPolicy({ threadMode: 'mention' });
  });

  it('titles drop Slack mention markup', () => {
    expect(threadTitle('<@U0TM8BOT|tm8> fix the CSP header', 'eng')).toBe('Fix the CSP header');
    expect(threadTitle('<@U0TM8BOT>', 'eng')).toBe('Thread in #eng');
  });

describe('444: /tm8 slash commands', () => {
  const answers: { text: string; replyTo: string | null; messageId: string }[] = [];
  const reacts: string[] = [];
  const executor = () => createBridgeCommandExecutor({
    db,
    executorClaims: async () => bridgesWorkerClaims(),
    async postNotice(d, input) {
      const posted = await postBridgeNotice(d, input);
      answers.push({ text: input.text, replyTo: input.replyToMessageId ?? null, messageId: posted.messageId });
      return posted;
    },
    async react(_d, input) { reacts.push(input.emoji); return { status: 'pending', outboxId: 'x' }; },
    claim: async (id) => (await db.rpc<boolean>(bridgesWorkerClaims(), 'internal.bridge_command_claim', [id])) === true,
    settle: async (id, outcome) => { await db.rpc(bridgesWorkerClaims(), 'internal.bridge_command_settle', [id, outcome]); },
    recordOrigin: async (q, entityId, origin) => { await q.rpc('record_bridge_provenance', [entityId, JSON.stringify([origin])]); },
    ...workers,
    workerHandle: async (claims, b, sessionId) => db.rpc<{ handle: string; title: string | null }>(claims, 'bridge_poster_handle', [b, sessionId]),
  });

  /** What routes.ts does: detect inside the inbound transaction, store, then run after commit. */
  async function slash(text: string, sender = OWNER_SLACK) {
    // This file posts faster than a channel ever does: keep the outbox's per-minute buckets (406) out of it.
    await owner(`update public.bridge_outbox set created_at = now() - interval '2 minutes' where bridge_id = $1`, [bridge]);
    const [verb, ...rest] = text.split(' ');
    const body = `/${verb} ${rest.join(' ')}`.trim();
    const ex = executor();
    const f = frame({ ext: `cmd:${randomUUID()}`, body, sender, slash: { command: '/tm8', text } });
    const stored = await db.tx(runtime(), async (q) => {
      const command = await ex.detect(body, { q, bridgeId: bridge, senderExternalId: sender, replyToExternalMessageId: null });
      return q.rpc<Inbound>('bridge_runtime_inbound', [JSON.stringify(f), command]);
    });
    expect(stored).toMatchObject({ status: 'stored', command: true, routed: false });
    await ex.run(stored.messageId);
    const answer = answers.at(-1)!;
    expect(answer.replyTo).toBe(stored.messageId);
    const out = (await owner<{ thread_ts: string | null; payload: { text: string } }>(
      `select thread_ts, payload from public.bridge_outbox where message_id = $1 and kind = 'send'`, [answer.messageId]))[0];
    return { stored, answer: answer.text, outbox: out };
  }

  it('/tm8 work starts a worker and answers in the channel', async () => {
    const before = spawns.length;
    const { answer, outbox } = await slash('work fix the flaky login test');
    expect(answer).toMatch(/^1 worker on it/);
    expect(spawns.length).toBe(before + 1);
    expect(spawns.at(-1)!.origins[0]!.command).toBe('/work');
    expect(outbox!.thread_ts).toBeNull();
    // No ⏳ on a slash command: there is no message to react to.
    expect(reacts).toEqual([]);
  });

  it('/tm8 status answers', async () => {
    const { answer } = await slash('status');
    expect(answer.length).toBeGreaterThan(0);
    expect(answer).not.toMatch(/problem on our side/);
  });

  it('/tm8 link with a wrong code is answered, from a guest', async () => {
    const { answer } = await slash('link TM8-ABC123', GUEST_SLACK);
    expect(answer).toMatch(/code/i);
  });

  it('/tm8 whoami names a Slack email match as such, not as an admin\'s assertion', async () => {
    const EMAIL_USER = 'U0EMAILMATCH';
    await owner(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, space_id, verified_at)
      values ('slack',$1,$2,'email',$3,now())`, [EMAIL_USER, ownerIdentity, spaceId]);
    const { answer } = await slash('whoami', EMAIL_USER);
    expect(answer).toMatch(/linked by matching Slack email/);
    expect(answer).not.toMatch(/asserted by an admin/);
  });

  it('a top-level slash command never starts a thread, even in every mode', async () => {
    await setPolicy({ threadMode: 'every' });
    const before = (await owner<{ n: number }>('select count(*)::int n from public.bridge_threads where bridge_id = $1', [bridge]))[0]!.n;
    const unknown = await inbound({ ext: `cmd:${randomUUID()}`, body: '/frobnicate', slash: { command: '/tm8', text: 'frobnicate' } });
    expect(unknown.thread).toBeUndefined();
    expect((await owner<{ n: number }>('select count(*)::int n from public.bridge_threads where bridge_id = $1', [bridge]))[0]!.n).toBe(before);
    await setPolicy({ threadMode: 'mention' });
  });
});
});
