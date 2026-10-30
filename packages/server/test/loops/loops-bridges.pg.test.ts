/**
 * Bridges L (migration 406; BRIDGE-ENTITY-DESIGN §7.3 "L (D26)", D30, D67–D69)
 * against a real PostgreSQL with every migration applied. Two test bridges,
 * Infra and Gaming, on one connection; no provider runtime: the runtime's
 * inbound door is called with a bridge_runtime session, as B1b-2's suite does.
 *
 *   1. a loop armed with targets Infra and Gaming, a different text each,
 *      posts in both, signed with the teammate (post) or its handle (agent);
 *   2. Gaming paused: the run records `paused` for Gaming and posts in Infra;
 *   3. interactive: a reply to the loop session's Infra post reaches the live
 *      session; once it has closed (30 idle minutes), a reply goes to the chat;
 *   4. concurrency replace: a new run ends the previous live one;
 *   5. quiet hours: two posts held, only the newer sent when the hours end; a
 *      reply goes at once; an exempt loop is never held;
 *   6. owner leaves: suspended, admins get a request; an admin's takeover
 *      re-arms it in their name;
 *   7. authority: the loop's worker creates a task and a doc (authored_from ->
 *      loop on each); its merge raises an approval to the owner in tm8 and
 *      nothing is posted in a group.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { replacePreviousRuns, type LoopExecutorPort } from '../../src/scheduler/jobs/loops.js';
import { loopLaunchContext } from '../../src/facade/execution-handlers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID();
const ownerMember = randomUUID(), adminMember = randomUUID(), priyaMember = randomUUID();
const ownerIdentity = `l-owner-${randomUUID()}`, adminIdentity = `l-admin-${randomUUID()}`, priyaIdentity = `l-priya-${randomUUID()}`;
const ownerAccount = randomUUID();
const teammate = randomUUID();
const chatInfra = randomUUID(), chatGaming = randomUUID();
const connection = randomUUID();
const INFRA = '120363-infra@g.us', GAMING = '120363-gaming@g.us', RAHUL = '919876543210@s.whatsapp.net';
let infra = '', gaming = '', runtimeSession = '';

const as = (identityId: string): DbClaims => ({ identityId, authKind: 'browser', requestId: randomUUID() });
const human = <T>(identityId: string, fn: (q: Querier) => Promise<T>) => db.tx(as(identityId), fn);
const loopsWorker = (): DbClaims => ({ identityId: ownerIdentity, nodeAdmin: true, requestId: 'loops-test', backgroundJob: 'loops.execute-due' });
const runtime = (): DbClaims => ({ identityId: ownerIdentity, authKind: 'bridge_runtime', authSessionId: runtimeSession, requestId: randomUUID() });
const owner = <T>(sql: string, params: unknown[] = []) => scratch.transaction(async c => {
  await c.query('set local role tm8_graph_owner');
  return (await c.query(sql, params)).rows as T[];
});
async function refusal(p: Promise<unknown>): Promise<{ code?: string; message?: string; details?: Record<string, unknown> }> {
  try { await p; } catch (err) { return err as never; }
  throw new Error('expected a refusal');
}

/** A transaction as tm8_graph_owner with the claims of `session` (or none). */
function inTx<T>(session: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    if (session) await c.query(`select set_config('tm8.work_session_id', $1, true)`, [session]);
    return fn(c);
  });
}
async function newEntity(c: PoolClient, kind: string, id = randomUUID()): Promise<string> {
  await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,$3,$4,'space')`,
    [id, spaceId, kind, teammate]);
  return id;
}

interface LoopOpts {
  title?: string; action?: 'spawn' | 'post'; prompt?: string; targets: Array<{ bridgeId: string; text: string | null }>;
  mode?: 'one-shot' | 'interactive'; concurrency?: 'skip' | 'queue' | 'replace'; by?: string;
}
/** loops.create's two doors, as the handler runs them: create_loop, then set_loop_bridge_fields. */
async function createLoop(o: LoopOpts): Promise<string> {
  return human(o.by ?? ownerIdentity, async q => {
    const r = await q.rpc<{ entity: { id: string } }>('create_loop', [
      spaceId, o.title ?? 'Daily update', null, 'every 1d', teammate, null, o.prompt ?? '', '{}',
      true, new Date(Date.now() + 86_400_000).toISOString(), null, null, randomUUID(),
      o.action ?? 'spawn', null, '{}', 'UTC', o.concurrency ?? 'skip', null, 0, 300, null,
    ]);
    await q.rpc('set_loop_bridge_fields', [r.entity.id, JSON.stringify(o.targets), o.mode ?? null, null]);
    return r.entity.id;
  });
}
/** A manual run claimed by the owner (Run now's door). */
async function claimRun(loopId: string, by = ownerIdentity): Promise<string> {
  const r = await db.rpc<{ claimed: boolean; runId: string }>(as(by), 'loop_run_claim',
    [loopId, new Date().toISOString(), 'manual', [], null, null, null, null, true, randomUUID()]);
  expect(r.claimed).toBe(true);
  return r.runId;
}
/** A spawn firing's session: the work_session plus 348's triggered_by edge, and the run's launch record. */
async function fireSession(loopId: string, runId: string, title = 'Daily update'): Promise<string> {
  const sid = randomUUID();
  await inTx(null, async c => {
    await newEntity(c, 'work_session', sid);
    await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,$2,'running','none',now())`, [sid, title]);
    await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1,$2,$3,'triggered_by',$4)`,
      [spaceId, sid, loopId, teammate]);
  });
  await db.rpc(loopsWorker(), 'loop_run_launched', [runId, null, sid]);
  return sid;
}
/** A session's post on a bridge (`tm8 message send --to <bridge>`): message_recorder's origin edge, committed. */
async function sessionPost(sid: string, bridge: string, body: string, parent: string | null = null): Promise<string> {
  return inTx(sid, async c => {
    const id = randomUUID();
    await c.query(`insert into public.entities(id, space_id, kind, created_by, parent_id, visibility) values ($1,$2,'message',$3,$4,'space')`,
      [id, spaceId, teammate, parent]);
    const root = parent ? (await c.query<{ r: string }>('select coalesce(root_message_id, entity_id) r from public.messages where entity_id = $1', [parent])).rows[0]!.r : null;
    await c.query(`insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body) values ($1,$2,$3,$4,$5)`,
      [id, bridge, root, teammate, body]);
    await c.query(`select internal.w1_set_writer('message_recorder')`);
    await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1,$2,$3,'authored_from',$4)`,
      [spaceId, id, sid, teammate]);
    await c.query(`select internal.w1_set_writer(null)`);
    return id;
  });
}
const outboxOf = (message: string) => owner<{ bridge_id: string; payload: { text: string }; poster: string; directed: boolean }>(
  'select bridge_id::text, payload, poster, directed from public.bridge_outbox where message_id = $1', [message]);
const targetsOf = (runId: string) => owner<{ bridge_id: string; result: string; reason: string | null; message_id: string | null }>(
  'select bridge_id::text, result, reason, message_id::text from public.loop_run_targets where run_id = $1 order by bridge_id', [runId]);
const resultFor = async (runId: string, bridge: string) => (await targetsOf(runId)).find(t => t.bridge_id === bridge);

let seq = 0;
function frame(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    connectionId: connection, conversationId: INFRA, externalMessageId: `3EBL${seq.toString().padStart(6, '0')}`,
    sender: { externalId: RAHUL, altId: null, name: 'Rahul', fromMe: false },
    body: 'thanks', kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_000_000 + seq, ...over,
  };
}
interface Inbound { status: string; messageId: string; routed: boolean; copyId: string | null; wakeSession?: { sessionId: string } | null; wakeChat?: unknown }
const inbound = (f: Record<string, unknown>) => db.rpc<Inbound>(runtime(), 'bridge_runtime_inbound', [JSON.stringify(f), false]);
/** The runtime acknowledges a send: the outbox row settles and the message gets its `out` origin (provider id). */
async function sent(messageId: string, externalMessageId: string): Promise<void> {
  const [row] = await owner<{ id: string }>(`select id::text from public.bridge_outbox where message_id = $1 and kind = 'send'`, [messageId]);
  await db.rpc(runtime(), 'bridge_runtime_sent', [JSON.stringify({ outboxId: row!.id, connectionId: connection, ok: true,
    externalMessageId, message: { conversation: 'x' } })]);
}

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('loops_bridges_l');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  await inTx(null, async c => {
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner'),($2,'Admin'),($3,'Priya')`,
      [ownerIdentity, adminIdentity, priyaIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username, is_node_admin) values ($1,$2,'l-owner', true)`, [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Bridges L',$2)`, [spaceId, ownerIdentity]);
    for (const [id, identity, role, name] of [[ownerMember, ownerIdentity, 'owner', 'Owner'], [adminMember, adminIdentity, 'admin', 'Admin'],
      [priyaMember, priyaIdentity, 'member', 'Priya']] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [id, spaceId]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,$4,$5)`,
        [id, spaceId, identity, role, name]);
    }
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1,$2,'Ops Bot','worker','persona')`,
      [teammate, ownerMember]);
    for (const [id, title] of [[chatInfra, 'Infra main'], [chatGaming, 'Gaming main']] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [id, spaceId, ownerMember]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,$3,$4,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/l', gen_random_uuid(), $5, $6, $7)`,
        [id, spaceId, title, teammate, ownerIdentity, ownerMember, `l-${randomUUID()}`]);
    }
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …9494','linked')`, [connection, ownerAccount]);
    // Rahul's number is linked to the admin, so his replies may start a turn (whoMayTrigger: members).
    await c.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, verified_at)
      values ('whatsapp',$1,$2,'code',now())`, [RAHUL, adminIdentity]);
  });
  // D32 (#1427): the bridges ride the connection's offer to this space.
  await human(ownerIdentity, q => q.rpc('offer_bridge_connection', [connection, spaceId, 'public', null, randomUUID()]));
  const create = (conv: string, title: string, target: string) => human(ownerIdentity, q => q.rpc<{ entity: { id: string } }>('create_bridge', [
    spaceId, connection, conv, JSON.stringify({ kind: 'group', title, memberCount: 7 }), target, '{}', teammate,
    null, null, true, null, null, randomUUID()]));
  infra = (await create(INFRA, 'Infra', chatInfra)).entity.id;
  gaming = (await create(GAMING, 'Gaming', chatGaming)).entity.id;
  const hash = createHash('sha256').update(randomUUID()).digest('hex');
  runtimeSession = (await db.rpc<{ id: string }>({ identityId: ownerIdentity, nodeAdmin: true, requestId: randomUUID() },
    'issue_bridge_runtime_session', [hash, new Date(Date.now() + 86_400_000).toISOString(), 'whatsapp-runtime'])).id;
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

const setPaused = (bridge: string, paused: boolean) =>
  owner(`update public.bridges set paused_at = ${paused ? 'now()' : 'null'} where entity_id = $1`, [bridge]);
/** Quiet hours that contain (or exclude) this instant, in UTC (the test loops' timezone). */
function quietWindow(containsNow: boolean): { start: string; end: string } {
  const now = new Date();
  const hm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return containsNow
    ? { start: hm(new Date(now.getTime() - 60 * 60_000)), end: hm(new Date(now.getTime() + 60 * 60_000)) }
    : { start: hm(new Date(now.getTime() + 2 * 60 * 60_000)), end: hm(new Date(now.getTime() + 3 * 60 * 60_000)) };
}
const setQuiet = (bridge: string, q: { start: string; end: string } | null) =>
  owner('update public.bridges set quiet_hours = $2 where entity_id = $1', [bridge, q === null ? null : JSON.stringify(q)]);

describe('L1. a loop armed with targets posts in each group, with its own text', () => {
  it('a post loop posts both texts, signed with the teammate, starting no session', async () => {
    const loopId = await createLoop({ action: 'post', title: 'Reminders', targets: [
      { bridgeId: infra, text: 'Infra: deploy freeze at 18:00' }, { bridgeId: gaming, text: 'Gaming: scrim tonight at 21:00' }] });
    const runId = await claimRun(loopId);
    const out = await db.rpc<Array<{ bridgeId: string; result: string; messageId: string }>>(as(ownerIdentity), 'loop_post_targets', [loopId, runId]);
    expect(out.map(o => o.result)).toEqual(['posted', 'posted']);
    const texts = await Promise.all(out.map(async o => (await outboxOf(o.messageId))[0]!.payload.text));
    expect(texts).toEqual(['Ops Bot: Infra: deploy freeze at 18:00', 'Ops Bot: Gaming: scrim tonight at 21:00']);
    expect((await targetsOf(runId)).map(t => t.result)).toEqual(['posted', 'posted']);
    // Idempotent per (run, target): a retried firing posts nothing new.
    const again = await db.rpc<Array<{ replayed?: boolean }>>(as(ownerIdentity), 'loop_post_targets', [loopId, runId]);
    expect(again.every(o => o.replayed)).toBe(true);
    // The post carries authored_from -> loop (D30).
    const edges = await owner<{ props: Record<string, unknown> }>(
      `select props from public.edges where src_id = $1 and dst_id = $2 and type = 'authored_from'`, [out[0]!.messageId, loopId]);
    expect(edges[0]?.props).toMatchObject({ bridgeId: null, loopId });
  });

  it('an agent loop\'s worker gets each group\'s instruction and recent log, and its posts are signed with its handle', async () => {
    const loopId = await createLoop({ title: 'Standup', prompt: 'Summarise the day.', targets: [
      { bridgeId: infra, text: 'post yesterday\'s merged PRs' }, { bridgeId: gaming, text: 'post the open bugs' }] });
    const runId = await claimRun(loopId);
    const targets = await db.rpc<Array<{ bridgeId: string; instruction: string; state: string; name: string }>>(
      as(ownerIdentity), 'loop_fire_targets', [loopId, runId, 15]);
    expect(targets.map(t => [t.name, t.instruction, t.state])).toEqual([
      ['Infra', 'post yesterday\'s merged PRs', 'live'], ['Gaming', 'post the open bugs', 'live']]);
    const context = loopLaunchContext('Summarise the day.', targets as never);
    expect(context).toContain('Instruction for this group: post yesterday\'s merged PRs');
    expect(context).toContain(`tm8 message send --to <bridge-id>`);
    const sid = await fireSession(loopId, runId, 'Standup');
    const a = await sessionPost(sid, infra, '3 PRs merged yesterday');
    const b = await sessionPost(sid, gaming, '2 open bugs');
    const [oa] = await outboxOf(a), [ob] = await outboxOf(b);
    expect(oa!.poster).toBe('worker');
    expect(oa!.payload.text).toMatch(/^Standup \([a-z]+-[a-z]+(-\d+)?\): 3 PRs merged yesterday$/);
    expect(ob!.payload.text.replace(/^.*?: /, '')).toBe('2 open bugs');
    expect((await targetsOf(runId)).map(t => t.result)).toEqual(['posted', 'posted']);
  });
});

describe('L2. a paused group is skipped with `paused`; the run goes on', () => {
  it('with Gaming paused, the run records paused for Gaming and still posts in Infra (post and agent)', async () => {
    await setPaused(gaming, true);
    try {
      const post = await createLoop({ action: 'post', targets: [{ bridgeId: infra, text: 'hello infra' }, { bridgeId: gaming, text: 'hello gaming' }] });
      const runId = await claimRun(post);
      await db.rpc(as(ownerIdentity), 'loop_post_targets', [post, runId]);
      expect(await resultFor(runId, infra)).toMatchObject({ result: 'posted' });
      expect(await resultFor(runId, gaming)).toMatchObject({ result: 'paused', reason: 'bridge_paused' });

      const agent = await createLoop({ targets: [{ bridgeId: infra, text: null }, { bridgeId: gaming, text: null }] });
      const agentRun = await claimRun(agent);
      const ctx = await db.rpc<Array<{ bridgeId: string; state: string }>>(as(ownerIdentity), 'loop_fire_targets', [agent, agentRun, 5]);
      expect(ctx.find(t => t.bridgeId === gaming)?.state).toBe('paused');
      expect(await resultFor(agentRun, gaming)).toMatchObject({ result: 'paused' });
      const sid = await fireSession(agent, agentRun);
      await sessionPost(sid, infra, 'still here');
      expect(await resultFor(agentRun, infra)).toMatchObject({ result: 'posted' });
      // The loop is not suspended.
      const [l] = await owner<{ enabled: boolean; last_error: string | null }>('select enabled, last_error from public.loops where entity_id = $1', [agent]);
      expect(l).toMatchObject({ enabled: true, last_error: null });
    } finally {
      await setPaused(gaming, false);
    }
  });
});

describe('L3. reply routing to the live interactive loop session (D26, D69)', () => {
  it('a reply to the Infra post reaches the live session; after it closes on 30 idle minutes, a reply goes to Infra\'s chat', async () => {
    const loopId = await createLoop({ title: 'Poll', mode: 'interactive', targets: [{ bridgeId: infra, text: 'ask who is on call' }] });
    const runId = await claimRun(loopId);
    const sid = await fireSession(loopId, runId, 'Poll');
    const post = await sessionPost(sid, infra, 'Who is on call this weekend?');
    await sent(post, 'OUT-POLL-1');

    const turnsBefore = (await owner<{ n: string }>('select count(*) n from public.chat_turns where chat_id = $1', [chatInfra]))[0]!.n;
    const r1 = await inbound(frame({ body: 'me', replyTo: { externalMessageId: 'OUT-POLL-1' } }));
    expect(r1).toMatchObject({ status: 'stored', routed: true, wakeSession: { sessionId: sid } });
    const [copy] = await owner<{ anchor_id: string; body: string }>('select anchor_id::text, body from public.messages where entity_id = $1', [r1.copyId]);
    expect(copy).toEqual({ anchor_id: sid, body: 'me' });
    const [answerer] = await owner<{ answerer_id: string }>('select answerer_id::text from public.bridge_message_answerers where message_id = $1', [r1.messageId]);
    expect(answerer!.answerer_id).toBe(sid);
    expect((await owner<{ n: string }>('select count(*) n from public.chat_turns where chat_id = $1', [chatInfra]))[0]!.n).toBe(turnsBefore);
    // D30: the group's message is now an origin of the session.
    const origins = await owner<{ bridge_id: string }>('select bridge_id::text from public.session_bridge_origins where holder_id = $1', [sid]);
    expect(origins.map(o => o.bridge_id)).toContain(infra);

    // The session's reply to it is directed: it settles its answer and is never held.
    const reply = await sessionPost(sid, sid, 'Thanks, noted.', r1.copyId);
    expect((await outboxOf(reply))[0]).toMatchObject({ directed: true });

    // Not idle yet; 31 minutes after the last thing addressed to it, it is.
    const idleNow = await db.query<{ run_id: string }>(loopsWorker(),
      'select run_id::text from public.loop_runs_idle_interactive($1, interval \'30 minutes\')', [new Date().toISOString()]);
    expect(idleNow.map(r => r.run_id)).not.toContain(runId);
    const idle = await db.query<{ run_id: string }>(loopsWorker(),
      'select run_id::text from public.loop_runs_idle_interactive($1, interval \'30 minutes\')', [new Date(Date.now() + 31 * 60_000).toISOString()]);
    expect(idle.map(r => r.run_id)).toContain(runId);
    // The executor closes it (stop + settle); then a reply goes to the chat.
    await db.rpc(loopsWorker(), 'loop_run_settle', [runId, 'completed', null]);
    const r2 = await inbound(frame({ body: 'me too', replyTo: { externalMessageId: 'OUT-POLL-1' } }));
    expect(r2.wakeSession ?? null).toBeNull();
    expect(r2).toMatchObject({ routed: true, wakeChat: { chatId: chatInfra } });
  });

  it('a one-shot loop\'s post is answered by the group\'s chat', async () => {
    const loopId = await createLoop({ title: 'Once', targets: [{ bridgeId: infra, text: null }] });
    const runId = await claimRun(loopId);
    const sid = await fireSession(loopId, runId, 'Once');
    const post = await sessionPost(sid, infra, 'Release notes are up');
    await sent(post, 'OUT-ONCE-1');
    const r = await inbound(frame({ body: 'great', replyTo: { externalMessageId: 'OUT-ONCE-1' } }));
    expect(r).toMatchObject({ routed: true, wakeChat: { chatId: chatInfra } });
  });
});

describe('L4. concurrency replace: a new run ends the previous live one', () => {
  it('stops the live session through the port and settles its run stopped; the next claim fires', async () => {
    const loopId = await createLoop({ title: 'Replace me', concurrency: 'replace', targets: [{ bridgeId: infra, text: null }] });
    const first = await claimRun(loopId);
    const sid = await fireSession(loopId, first);
    const stopped: string[] = [];
    const port = {
      claimsForLoop: () => as(ownerIdentity),
      stopSession: async (_c: DbClaims, sessionId: string) => { stopped.push(sessionId); },
    } as unknown as LoopExecutorPort;
    const n = await replacePreviousRuns({ db, port, worker: loopsWorker(), loop: { entityId: loopId, spaceId }, actAsIdentity: ownerIdentity });
    expect(n).toBe(1);
    expect(stopped).toEqual([sid]);
    const [run] = await owner<{ outcome: string; error: string }>('select outcome, error from public.loop_runs where id = $1', [first]);
    expect(run).toMatchObject({ outcome: 'stopped', error: 'replaced by a newer run' });
    const second = await db.rpc<{ claimed: boolean; launch: string }>(as(ownerIdentity), 'loop_run_claim',
      [loopId, new Date().toISOString(), 'manual', [sid], null, null, null, null, false, randomUUID()]);
    expect(second).toMatchObject({ claimed: true, launch: 'fired' });
  });
});

describe('L5. quiet hours hold unprompted posts; newest only on release (D67)', () => {
  it('holds two scheduled posts and sends only the newer when the hours end; replies go at once; exempt loops are never held', async () => {
    // Isolation: the earlier tests' posts would fill the (teammate, bridge) un-directed bucket (6 per 10 min).
    await owner(`update public.bridge_outbox set created_at = now() - interval '1 hour'`);
    await setQuiet(infra, quietWindow(true));
    try {
      const loopId = await createLoop({ action: 'post', title: 'Nightly', targets: [{ bridgeId: infra, text: 'nightly digest' }] });
      const run1 = await claimRun(loopId);
      const [p1] = await db.rpc<Array<{ result: string; messageId: string }>>(as(ownerIdentity), 'loop_post_targets', [loopId, run1]);
      expect(p1!.result).toBe('held');
      await db.rpc(loopsWorker(), 'loop_run_settle', [run1, 'completed', null]);
      const run2 = await claimRun(loopId);
      const [p2] = await db.rpc<Array<{ result: string; messageId: string }>>(as(ownerIdentity), 'loop_post_targets', [loopId, run2]);
      expect(p2!.result).toBe('held');
      expect(await outboxOf(p1!.messageId)).toEqual([]);
      expect(await outboxOf(p2!.messageId)).toEqual([]);
      const badges = await owner<{ message_id: string; reason: string }>(
        'select message_id::text, reason from public.bridge_delivery_refusals where message_id = any($1::uuid[]) order by reason',
        [[p1!.messageId, p2!.messageId]]);
      expect(badges).toEqual([{ message_id: p2!.messageId, reason: 'quiet_hours' }, { message_id: p1!.messageId, reason: 'superseded' }]);
      expect(await resultFor(run1, infra)).toMatchObject({ result: 'superseded' });

      // Still quiet: nothing is released.
      expect(await db.rpc<number>(loopsWorker(), 'loop_release_held', [new Date().toISOString()])).toBe(0);
      // A loop session's reply to a member goes out at once.
      const replyLoop = await createLoop({ title: 'Replier', mode: 'interactive', targets: [{ bridgeId: infra, text: null }] });
      const rr = await claimRun(replyLoop);
      const sid = await fireSession(replyLoop, rr, 'Replier');
      const q = await inbound(frame({ body: '@tm8 status?' }));
      await owner('select public.set_bridge_answerer($1, $2)', [q.messageId, sid]);
      const reply = await sessionPost(sid, infra, 'All green.', q.messageId);
      expect(await outboxOf(reply)).toHaveLength(1);
      // Its unprompted post is held.
      const unprompted = await sessionPost(sid, infra, 'FYI: maintenance at 2am');
      expect(await outboxOf(unprompted)).toEqual([]);
      const [heldBadge] = await owner<{ reason: string }>('select reason from public.bridge_delivery_refusals where message_id = $1', [unprompted]);
      expect(heldBadge!.reason).toBe('quiet_hours');
      // The group was already posted to in this run (the reply): it stays `posted`.
      expect(await resultFor(rr, infra)).toMatchObject({ result: 'posted' });

      // The hours end: only the newer of the two nightly posts is sent.
      await setQuiet(infra, quietWindow(false));
      expect(await db.rpc<number>(loopsWorker(), 'loop_release_held', [new Date().toISOString()])).toBe(2);
      expect(await outboxOf(p2!.messageId)).toHaveLength(1);
      expect(await outboxOf(p1!.messageId)).toEqual([]);
      expect(await resultFor(run2, infra)).toMatchObject({ result: 'posted' });

      // An exempt loop is never held; only an admin may exempt.
      await setQuiet(infra, quietWindow(true));
      const exempt = await createLoop({ action: 'post', title: 'Pager', targets: [{ bridgeId: infra, text: 'page' }] });
      const denied = await refusal(human(priyaIdentity, q2 => q2.rpc('set_loop_bridge_fields', [exempt, null, null, true])));
      expect(denied.details?.['reason'] ?? denied.message).toMatch(/admin/);
      await human(adminIdentity, q2 => q2.rpc('set_loop_bridge_fields', [exempt, null, null, true]));
      const re = await claimRun(exempt, adminIdentity);
      const [pe] = await db.rpc<Array<{ result: string }>>(as(adminIdentity), 'loop_post_targets', [exempt, re]);
      expect(pe!.result).toBe('posted');
    } finally {
      await setQuiet(infra, null);
    }
  });
});

describe('L6. owner leaves: suspended, admins notified, an admin takes it over', () => {
  it('a bridge loop whose armer leaves is not claimable and raises a request per admin; a member cannot take over; an admin re-arms it', async () => {
    const loopId = await createLoop({ by: priyaIdentity, title: 'Priya\'s digest', targets: [{ bridgeId: infra, text: null }] });
    const plain = await human(priyaIdentity, async q => (await q.rpc<{ entity: { id: string } }>('create_loop', [
      spaceId, 'No targets', null, 'every 1d', teammate, null, '', '{}', true, new Date(Date.now() + 86_400_000).toISOString(),
      null, null, randomUUID(), 'spawn', null, '{}', 'UTC', 'skip', null, 0, 300, null])).entity.id);
    await owner(`update public.loops set next_run_at = now() - interval '1 minute' where entity_id = any($1::uuid[])`, [[loopId, plain]]);
    await owner(`update public.members set status = 'left', left_at = now() where entity_id = $1`, [priyaMember]);

    const [l] = await owner<{ last_error: string }>('select last_error from public.loops where entity_id = $1', [loopId]);
    expect(l!.last_error).toMatch(/^suspended: /);
    const requests = await owner<{ assignee_id: string; status: string }>(
      `select assignee_id::text, status from public.attention_requests where entity_id = $1 and signal_key like 'loop.owner_left:%' order by assignee_id`, [loopId]);
    expect(requests.map(r => r.assignee_id).sort()).toEqual([adminMember, ownerMember].sort());
    const due = await db.query<{ entity_id: string; act_as_identity: string | null }>(loopsWorker(),
      'select entity_id::text, act_as_identity from public.loops_claimable(100, now(), $1)', [[]]);
    expect(due.map(d => d.entity_id)).not.toContain(loopId);
    // A loop without bridge targets keeps main's fallback to the owner.
    expect(due.find(d => d.entity_id === plain)?.act_as_identity).toBe(ownerIdentity);

    const [{ version }] = await owner<{ version: number }>('select version from public.entities where id = $1', [loopId]) as [{ version: number }];
    const updateArgs = (v: number) => [loopId, v, null, null, null, null, false, null, false, null, null, true,
      null, false, null, null, false, randomUUID(), null, null, false, null, null, null, false, null, null, false, null, null, null];
    // The owner role counts as admin; a plain member does not.
    const member2 = `l-m2-${randomUUID()}`, member2Id = randomUUID();
    await owner(`insert into public.user_profiles(identity_id, display_name) values ($1,'M2')`, [member2]);
    await owner(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [member2Id, spaceId]);
    await owner(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'member','M2')`, [member2Id, spaceId, member2]);
    const notAdmin = await refusal(human(member2, q => q.rpc('update_loop', updateArgs(version))));
    expect(notAdmin.message ?? '').toMatch(/only a space admin can take it over/);
    // Nor by editing it while disabled (then enabling it as its new armer), nor by clearing its targets.
    const disabledEdit = updateArgs(version);
    disabledEdit[3] = 'Renamed while disabled'; disabledEdit[11] = false;
    expect((await refusal(human(member2, q => q.rpc('update_loop', disabledEdit)))).message ?? '')
      .toMatch(/only a space admin can take it over/);
    expect((await refusal(human(member2, q => q.rpc('set_loop_bridge_fields', [loopId, '[]', null, null])))).message ?? '')
      .toMatch(/only a space admin can take it over/);

    await human(adminIdentity, q => q.rpc('update_loop', updateArgs(version)));
    const [after] = await owner<{ armed_by_member_id: string; last_error: string | null }>(
      'select armed_by_member_id::text, last_error from public.loops where entity_id = $1', [loopId]);
    expect(after).toEqual({ armed_by_member_id: adminMember, last_error: null });
    const open = await owner<{ n: string }>(`select count(*) n from public.attention_requests where entity_id = $1
      and signal_key like 'loop.owner_left:%' and status in ('open','acknowledged')`, [loopId]);
    expect(open[0]!.n).toBe('0');
    const dueAfter = await db.query<{ entity_id: string; act_as_identity: string }>(loopsWorker(),
      'select entity_id::text, act_as_identity from public.loops_claimable(100, now(), $1)', [[]]);
    expect(dueAfter.find(d => d.entity_id === loopId)?.act_as_identity).toBe(adminIdentity);
  });
});

describe('L6b. an admin removing the armer suspends the loop; the removal is no takeover', () => {
  it('remove_space_member under the admin\'s claims leaves the loop suspended, armed by the member who left', async () => {
    const m3 = `l-m3-${randomUUID()}`, m3Id = randomUUID();
    await owner(`insert into public.user_profiles(identity_id, display_name) values ($1,'M3')`, [m3]);
    await owner(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [m3Id, spaceId]);
    await owner(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'member','M3')`, [m3Id, spaceId, m3]);
    const loopId = await createLoop({ by: m3, title: 'M3 digest', targets: [{ bridgeId: infra, text: null }] });
    await human(adminIdentity, q => q.rpc('remove_space_member', [spaceId, m3Id, null]));
    const [l] = await owner<{ armed_by_member_id: string; last_error: string }>(
      'select armed_by_member_id::text, last_error from public.loops where entity_id = $1', [loopId]);
    expect(l).toMatchObject({ armed_by_member_id: m3Id });
    expect(l!.last_error).toMatch(/^suspended: /);
    const open = await owner<{ n: string }>(`select count(*) n from public.attention_requests where entity_id = $1
      and signal_key like 'loop.owner_left:%' and status in ('open','acknowledged')`, [loopId]);
    expect(Number(open[0]!.n)).toBeGreaterThan(0);
  });
});

describe('L7. authority: granted at arming vs approval-gated, and provenance -> loop (D26, D30)', () => {
  it('the worker creates a task and a doc (each authored_from -> loop, inherited by its child); its PR merge raises an approval to the owner and posts nothing', async () => {
    const loopId = await createLoop({ title: 'Release train', targets: [{ bridgeId: infra, text: null }] });
    const runId = await claimRun(loopId);
    const sid = await fireSession(loopId, runId, 'Release train');
    const [sessionEdge] = await owner<{ props: Record<string, unknown> }>(
      `select props from public.edges where src_id = $1 and dst_id = $2 and type = 'authored_from'`, [sid, loopId]);
    expect(sessionEdge?.props).toMatchObject({ bridgeId: null, loopId, depth: 0, inherited: false });

    const { task, doc, child, grand } = await inTx(sid, async c => {
      const task = await newEntity(c, 'task'), doc = await newEntity(c, 'doc'), child = await newEntity(c, 'work_session');
      await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Child','running','none',now())`, [child]);
      return { task, doc, child, grand: '' };
    }).then(async r => ({ ...r, grand: await inTx(r.child, c => newEntity(c, 'doc')) }));
    for (const id of [task, doc, child, grand]) {
      const edges = await owner<{ props: { loopId: string; depth: number } }>(
        `select props from public.edges where src_id = $1 and dst_id = $2 and type = 'authored_from'`, [id, loopId]);
      expect(edges).toHaveLength(1);
    }
    const [g] = await owner<{ props: { depth: number; viaSessionId: string } }>(
      `select props from public.edges where src_id = $1 and dst_id = $2 and type = 'authored_from'`, [grand, loopId]);
    expect(g!.props).toMatchObject({ depth: 1, viaSessionId: child });
    // The loop edge does not take the one session/chat origin slot (396).
    const origin = await owner<{ n: string }>(`select count(*) n from public.edges where src_id = $1 and type = 'authored_from' and not (props ? 'bridgeId')`, [task]);
    expect(origin[0]!.n).toBe('0');
    // A forged loop edge is refused by the guard.
    const forged = await refusal(inTx(null, async c => {
      await c.query(`select internal.w1_set_writer('entity_recorder')`);
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by, props) values ($1,$2,$3,'authored_from',$4,$5)`,
        [spaceId, task, infra, teammate, JSON.stringify({ bridgeId: null, loopId })]);
    }));
    expect(forged.message ?? '').toMatch(/authored_from -> loop/);

    const outboxBefore = (await owner<{ n: string }>('select count(*) n from public.bridge_outbox'))[0]!.n;
    const approval = await db.rpc<{ requestId: string; created: boolean; ownerMemberId: string }>(
      { identityId: ownerIdentity, authKind: 'agent', workSessionId: sid, requestId: randomUUID() },
      'loop_request_approval', [sid, 'tracking.pr.merge', 'tracking.pr.merge 01a1-pr']);
    expect(approval).toMatchObject({ created: true, ownerMemberId: ownerMember });
    const [req] = await owner<{ assignee_id: string; action_type: string; source_session_id: string; reason: string }>(
      'select assignee_id::text, action_type, source_session_id::text, reason from public.attention_requests where id = $1', [approval.requestId]);
    expect(req).toMatchObject({ assignee_id: ownerMember, action_type: 'decide', source_session_id: sid });
    expect(req!.reason).toContain('tracking.pr.merge');
    expect((await owner<{ n: string }>('select count(*) n from public.bridge_outbox'))[0]!.n).toBe(outboxBefore);
    // Another session cannot raise one in its name.
    const other = await refusal(db.rpc({ identityId: ownerIdentity, authKind: 'agent', requestId: randomUUID() },
      'loop_request_approval', [sid, 'entities.delete', 'x']));
    expect(other.code).toBe('forbidden');
    // The authority read behind it is not an app door: it would hand any
    // session's loop title and owner to a caller in another space.
    const leak = await refusal(db.rpc({ identityId: ownerIdentity, authKind: 'agent', workSessionId: sid, requestId: randomUUID() },
      'loop_session_authority', [sid]));
    expect(leak.code).toBe('forbidden');
  });
});

describe('L8. a removed bridge disables its loops and keeps them (v2 §2.3)', () => {
  it('remove_bridge disables every loop targeting the bridge (or about it) with "bridge removed", keeping its targets and armer; others are untouched', async () => {
    const chatOps = randomUUID();
    await inTx(null, async c => {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [chatOps, spaceId, ownerMember]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,'Ops main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/l', gen_random_uuid(), $4, $5, $6)`,
        [chatOps, spaceId, teammate, ownerIdentity, ownerMember, `l-${randomUUID()}`]);
    });
    const ops = (await human(ownerIdentity, q => q.rpc<{ entity: { id: string } }>('create_bridge', [
      spaceId, connection, '120363-ops@g.us', JSON.stringify({ kind: 'group', title: 'Ops', memberCount: 3 }), chatOps, '{}', teammate,
      null, null, true, null, null, randomUUID()]))).entity.id;
    const both = await createLoop({ title: 'Ops and Infra', targets: [{ bridgeId: ops, text: 'ops text' }, { bridgeId: infra, text: null }] });
    const post = await createLoop({ action: 'post', title: 'Ops reminder', targets: [{ bridgeId: ops, text: 'standup' }] });
    const other = await createLoop({ title: 'Infra only', targets: [{ bridgeId: infra, text: null }] });
    const before = await owner<{ entity_id: string; armed_by_member_id: string }>(
      'select entity_id::text, armed_by_member_id::text from public.loops where entity_id = any($1::uuid[])', [[both, post]]);

    const [{ version }] = await owner<{ version: number }>('select version from public.entities where id = $1', [ops]) as [{ version: number }];
    await human(ownerIdentity, q => q.rpc('remove_bridge', [ops, version, null, randomUUID()]));

    const rows = await owner<{ entity_id: string; enabled: boolean; last_error: string | null; targets: unknown; armed_by_member_id: string }>(
      'select entity_id::text, enabled, last_error, targets, armed_by_member_id::text from public.loops where entity_id = any($1::uuid[])',
      [[both, post, other]]);
    const by = (id: string) => rows.find(r => r.entity_id === id)!;
    for (const id of [both, post]) {
      expect(by(id)).toMatchObject({ enabled: false, last_error: 'bridge removed' });
      expect(by(id).armed_by_member_id).toBe(before.find(b => b.entity_id === id)!.armed_by_member_id);
    }
    expect(by(both).targets).toEqual([{ bridgeId: ops, text: 'ops text' }, { bridgeId: infra, text: null }]);
    expect(by(other)).toMatchObject({ enabled: true, last_error: null });

    // A human re-points it: the removed group cannot be a target again, the others can.
    const refused = await refusal(human(ownerIdentity, q => q.rpc('set_loop_bridge_fields', [both, JSON.stringify([{ bridgeId: ops, text: null }]), null, null])));
    expect(refused.message ?? '').toMatch(/not a live bridge/);
    await human(ownerIdentity, q => q.rpc('set_loop_bridge_fields', [both, JSON.stringify([{ bridgeId: infra, text: null }]), null, null]));
    expect((await owner<{ targets: unknown }>('select targets from public.loops where entity_id = $1', [both]))[0]!.targets)
      .toEqual([{ bridgeId: infra, text: null }]);
  });
});
