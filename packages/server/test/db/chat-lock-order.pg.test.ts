// Chat lock order (337). A running turn's fenced writes and a message posted
// into the same chat used to take the chat row and the space's event-seq row in
// opposite orders, so Postgres killed one of them with 40P01:
//
//   post:    entities(anchor) -> space_event_seq -> chats   (turn enqueue trigger)
//   fenced:  chats (chat_lock_owned) -> space_event_seq      (tool_call audit)
//
// 337 makes every path take   chats -> entities(anchor) -> space_event_seq.
// These tests run the paths against each other on a real Postgres and assert
// the order itself, so a future path that takes the event seq first fails here
// rather than as a "delivery_unknown" turn in prod.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  identity: string;
  spaceId: string;
  member: string;
  teammateId: string;
  channelId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  const values: Fixture = {
    identity: 'lock-order-owner',
    spaceId: randomUUID(),
    member: randomUUID(),
    teammateId: randomUUID(),
    channelId: randomUUID(),
  };
  await db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner')`, [values.identity]);
    await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Lock Order', $2)`,
      [values.spaceId, values.identity]);
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1,$4,'member',0,$1), ($2,$4,'team_member',1,$1), ($3,$4,'channel',2,$1)`,
      [values.member, values.teammateId, values.channelId, values.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1,$2,$3,'owner','Owner')`,
      [values.member, values.spaceId, values.identity],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, model, agent_tool)
       values ($1,$2,'Chat Agent','helper','gpt-5.6-sol','codex')`,
      [values.teammateId, values.member],
    );
    await client.query(`insert into public.channels(entity_id, space_id, name, topic) values ($1,$2,'lock-order','')`,
      [values.channelId, values.spaceId]);
  });
  await db.query('insert into accounts(identity_id,username) values($1,$2)', [values.identity, 'lock-order-owner']);
  return values;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('chat_lock_order');
  database.apply(migrationFiles());
  fixture = await seed(database);
}, 240_000);
afterAll(async () => { await database?.destroy(); });

// --- transactions with explicit lifetimes ----------------------------------

type Claims = { authKind?: string; authSessionId?: string };

async function open(claims: Claims = {}): Promise<PoolClient> {
  const client = await database.pool.connect();
  await client.query('begin');
  await client.query('set local role tm8_app');
  await client.query(
    "select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind',$2,true),set_config('tm8.auth_session_id',$3,true)",
    [fixture.identity, claims.authKind ?? 'browser', claims.authSessionId ?? ''],
  );
  return client;
}
async function finish(client: PoolClient, ok: boolean): Promise<void> {
  try { await client.query(ok ? 'commit' : 'rollback'); } finally { client.release(); }
}
/** One whole transaction: claims, the statement, commit (rollback on error). */
async function txn<T>(fn: (q: PoolClient) => Promise<T>, claims?: Claims, started?: (pid: number) => void): Promise<T> {
  const client = await open(claims);
  started?.((await client.query('select pg_backend_pid() pid')).rows[0].pid);
  try {
    const result = await fn(client);
    await finish(client, true);
    return result;
  } catch (error) {
    await finish(client, false);
    throw error;
  }
}
/** A superuser transaction that holds a row lock until released. */
async function hold(sql: string, params: unknown[]): Promise<{ release(): Promise<void> }> {
  const client = await database.pool.connect();
  await client.query('begin');
  await client.query(sql, params);
  return { release: () => finish(client, true) };
}
async function waitingOnLock(pid: () => number | undefined, settled: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const current = pid();
    if (current !== undefined) {
      const rows = await database.query('select wait_event_type from pg_stat_activity where pid=$1', [current]);
      if (rows[0]?.wait_event_type === 'Lock') return true;
    }
    if (settled()) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('operation neither blocked nor finished');
}
/** Start `fn` as its own transaction and return once it is waiting on a lock (or done). */
async function startBlocked<T>(fn: (q: PoolClient) => Promise<T>, claims?: Claims) {
  let pid: number | undefined; let done = false;
  const result = txn(fn, claims, p => { pid = p; }).finally(() => { done = true; });
  result.catch(() => undefined);
  const blocked = await waitingOnLock(() => pid, () => done);
  return { result, blocked };
}
async function nowait(sql: string, params: unknown[]): Promise<'free' | 'held'> {
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    await client.query(sql, params);
    return 'free';
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') return 'held';
    throw error;
  } finally {
    await client.query('rollback');
    client.release();
  }
}

// --- chat fixtures (the same protocol chat-continuity.pg.test.ts drives) ----

async function chat(): Promise<string> {
  const id = randomUUID();
  await txn(q => q.query(`select public.start_chat($1,$2,$3,'gpt-5.6-sol','openai','codex','explain',
    'scratch',null,$4,$5,null,'original input','{}'::uuid[],null,$6)`,
    [id, fixture.spaceId, fixture.teammateId, randomUUID(), `/tmp/${id}`, randomUUID()]));
  return id;
}
async function running(opts: { mint?: boolean } = {}) {
  const id = await chat();
  const lease = randomUUID(); const hash = createHash('sha256').update(lease).digest('hex');
  const claim = await txn(async q => (await q.query('select public.claim_next_chat_turn($1,2,$2) result',
    [id, { nodeId: 'node-a', bootId: 'boot-a', leaseTokenHash: hash }])).rows[0].result);
  let fence = { turnId: claim.turnId, attemptNo: claim.attemptNo, runtimeEpoch: claim.runtimeEpoch, leaseToken: lease, nativeGeneration: 0 };
  const reserved = await txn(async q => (await q.query('select public.reserve_chat_continuity($1,$2,$3) result',
    [id, { ...fence, nativeGeneration: undefined },
      { targetBinding: { agentTool: 'codex', storageScopeId: 'storage', protocolRevision: 'v1', compatibilityDigest: 'compat' } }])).rows[0].result);
  fence = { ...fence, nativeGeneration: reserved.nativeGeneration };
  const snapshot = randomUUID(); const text = 'history';
  const bootstrap = { schemaVersion: 1, snapshotId: snapshot, coverage: { throughTurnOrdinal: claim.turnOrdinal - 1,
    captureHighWater: claim.captureHighWater, projectionPolicyVersion: 'v1', authorityScopeDigest: 'authority', logicalHistoryDigest: 'logical' },
  renderedContext: text, contentHash: createHash('sha256').update(text).digest('hex'), manifest: [] };
  const sealed = await txn(async q => (await q.query('select public.seal_chat_turn_snapshot($1,$2,$3,$4,$5) result',
    [id, fence, snapshot, { desired: claim.claimedConfiguration, authority: claim.claimedAuthority }, bootstrap])).rows[0].result);
  const generation = { chatId: id, bindingId: reserved.bindingId, generation: reserved.nativeGeneration,
    leaseEpoch: claim.runtimeEpoch, configRevision: claim.configRevision };
  // A runtime grant can only be minted while the attempt is still prepared.
  const grant: { id: string } | null = opts.mint ? await txn(async q => (await q.query(
    "select public.issue_agent_runtime_session($1,$2,$3,now()+interval '1 hour',null,$4) result",
    [id, fixture.teammateId, createHash('sha256').update(randomUUID()).digest('hex'), generation])).rows[0].result) : null;
  const message = await txn(async q => (await q.query(`select public.w2_post_message_batch($1::uuid[],'in progress',null,
    '{}'::uuid[],'{}'::uuid[],null,$2::uuid,$3,null,$4::uuid) result`,
  [[id], fixture.teammateId, randomUUID(), id])).rows[0].result.messageIds[0] as string);
  await txn(q => q.query('select public.bind_chat_agent_message($1,$2)', [claim.turnId, message]));
  await txn(q => q.query('select public.record_chat_open($1,$2,$3,$4)', [id, fence, snapshot,
    { native: { nativeId: randomUUID() }, seed: { snapshotId: snapshot, coverage: bootstrap.coverage, contentHash: bootstrap.contentHash,
      transport: 'instructions', acknowledgement: 'launch_materialized' }, execution: { evidence: 'requested_only' } }]));
  await txn(q => q.query('select public.begin_chat_dispatch($1,$2,$3,$4)', [id, fence, snapshot, sealed.inputDigest]));
  return { id, fence, snapshot, claim, message, grant };
}
type Running = Awaited<ReturnType<typeof running>>;

let partSeq = 0;
const appendToolCall = (r: Running) => (q: PoolClient) => {
  const seq = ++partSeq;
  return q.query("select public.append_chat_message_part($1,$2,'tool_call',$3,$4,$5,$6)",
    [r.message, seq, { id: `call-${seq}`, name: 'tm8_read', state: 'running' }, r.fence, r.snapshot, `adapter:${seq}`]);
};
const humanPost = (chatId: string, body = 'a new message while the agent works') => (q: PoolClient) =>
  q.query(`select public.w2_post_message_batch($1::uuid[],$2,null,'{}'::uuid[],'{}'::uuid[],null,null,$3,null,null)`,
    [[chatId], body, randomUUID()]);
const agentPost = (anchor: string, source: string) => (q: PoolClient) =>
  q.query(`select public.w2_post_message_batch($1::uuid[],'from another chat',null,'{}'::uuid[],'{}'::uuid[],null,$2::uuid,$3,null,$4::uuid)`,
    [[anchor], fixture.teammateId, randomUUID(), source]);
const lockSeq = 'select 1 from public.space_event_seq where space_id=$1 for update';
const lockChat = 'select 1 from public.chats where entity_id=$1 for update';

// --- the reported deadlock, forced deterministically -------------------------

it('a message posted into a chat and the running turn tool_call write never deadlock, in either order', async () => {
  for (const first of ['post', 'append'] as const) {
    const r = await running();
    // Park both behind the space's event seq so they reach their second lock
    // together: exactly the window prod hit "about 3s after another message".
    const gate = await hold(lockSeq, [fixture.spaceId]);
    const post = () => startBlocked(humanPost(r.id));
    const append = () => startBlocked(appendToolCall(r));
    const a = first === 'post' ? await post() : await append();
    const b = first === 'post' ? await append() : await post();
    expect(a.blocked && b.blocked).toBe(true);
    await gate.release();
    const settled = await Promise.allSettled([a.result, b.result]);
    expect(settled.map(s => s.status === 'rejected' ? (s.reason as { code?: string }).code ?? String(s.reason) : 'ok'))
      .toEqual(['ok', 'ok']);
    expect(await database.query("select count(*)::int n from chat_turns where chat_id=$1 and state='queued'", [r.id]))
      .toEqual([{ n: 1 }]);
    expect(await database.query(
      "select count(*)::int n from activity where verb='chat.tool_called' and entity_id=$1", [r.message]))
      .toEqual([{ n: 1 }]);
  }
}, 60_000);

it('completing the turn and a message posted into the chat never deadlock', async () => {
  const r = await running();
  const terminal = { outcome: 'completed', evidence: 'provider_terminal', body: 'done' };
  await txn(q => q.query('select public.record_chat_terminal($1,$2,$3,$4)', [r.id, r.fence, r.snapshot, terminal]));
  const gate = await hold(lockSeq, [fixture.spaceId]);
  const post = await startBlocked(humanPost(r.id));
  const complete = await startBlocked(q => q.query('select public.complete_chat_turn($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [r.claim.turnId, 'completed', 'done', null, null, null, r.fence, r.snapshot, terminal, null]));
  await gate.release();
  const settled = await Promise.allSettled([post.result, complete.result]);
  expect(settled.map(s => s.status === 'rejected' ? (s.reason as { code?: string }).code : 'ok')).toEqual(['ok', 'ok']);
}, 60_000);

it('two chats posting into each other at once never deadlock', async () => {
  const a = await chat(); const b = await chat();
  const gate = await hold(lockSeq, [fixture.spaceId]);
  const ab = await startBlocked(agentPost(b, a));
  const ba = await startBlocked(agentPost(a, b));
  await gate.release();
  const settled = await Promise.allSettled([ab.result, ba.result]);
  expect(settled.map(s => s.status === 'rejected' ? (s.reason as { code?: string }).code : 'ok')).toEqual(['ok', 'ok']);
}, 60_000);

it('survives a burst of tool_call writes racing human posts in the same chat', async () => {
  const r = await running();
  const work: Promise<unknown>[] = [];
  for (let i = 0; i < 15; i++) {
    work.push(txn(appendToolCall(r)));
    work.push(txn(humanPost(r.id, `burst ${i}`)));
  }
  const settled = await Promise.allSettled(work);
  const failures = settled.flatMap(s => s.status === 'rejected' ? [(s.reason as { code?: string }).code ?? String(s.reason)] : []);
  expect(failures).toEqual([]);
}, 60_000);

// --- the order itself: nothing waits for a chat row while holding the seq ---

/**
 * Hold the chat row, start `op`, and if it waits, prove it holds neither the
 * space's event seq nor the chat's entity row while it does. That is the whole
 * invariant (chats -> entities(anchor) -> space_event_seq), checked per path.
 */
async function assertChatRowFirst(chatId: string, op: (q: PoolClient) => Promise<unknown>, claims?: Claims) {
  const gate = await hold(lockChat, [chatId]);
  const started = await startBlocked(op, claims);
  let seq: string = 'free'; let entity: string = 'free';
  if (started.blocked) {
    seq = await nowait(`${lockSeq} nowait`, [fixture.spaceId]);
    entity = await nowait('select 1 from public.entities where id=$1 for update nowait', [chatId]);
  }
  await gate.release();
  await started.result;
  return { blocked: started.blocked, seq, entity };
}

it('every chat path takes the chat row before the anchor entity and the event seq', async () => {
  const r = await running();
  const other = await chat();
  const checks: Record<string, unknown> = {};
  checks['human post'] = await assertChatRowFirst(r.id, humanPost(r.id));
  checks['agent post into another chat'] = await assertChatRowFirst(other, agentPost(other, r.id));
  checks['tool_call append'] = await assertChatRowFirst(r.id, appendToolCall(r));
  checks['heartbeat'] = await assertChatRowFirst(r.id, q => q.query('select public.heartbeat_chat_runtime($1,$2)', [r.id, r.fence]));
  checks['set configuration'] = await assertChatRowFirst(other, q => q.query('select public.set_chat_configuration($1,1,$2,$3)',
    [other, { model: 'claude-opus-4-6', provider: 'anthropic', agentTool: 'claude-code', reasoningEffort: null,
      credentialSelection: { source: 'auto' }, credentialIntent: { defaultChoice: { source: 'auto' }, byProvider: {} } }, randomUUID()]));
  const terminal = { outcome: 'completed', evidence: 'provider_terminal', body: 'done' };
  await txn(q => q.query('select public.record_chat_terminal($1,$2,$3,$4)', [r.id, r.fence, r.snapshot, terminal]));
  checks['complete turn'] = await assertChatRowFirst(r.id, q => q.query('select public.complete_chat_turn($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [r.claim.turnId, 'completed', 'done', null, null, null, r.fence, r.snapshot, terminal, null]));
  await txn(q => q.query('select public.release_chat_runtime($1,$2,$3)', [r.id, r.fence.runtimeEpoch, r.fence.leaseToken]));
  checks['claim next turn'] = await assertChatRowFirst(r.id, q => q.query('select public.claim_next_chat_turn($1,2,$2)',
    [r.id, { nodeId: 'node-a', bootId: 'boot-c', leaseTokenHash: 'c'.repeat(64) }]));
  for (const [name, check] of Object.entries(checks)) {
    expect({ name, ...(check as object) }).toEqual({ name, blocked: true, seq: 'free', entity: 'free' });
  }
}, 120_000);

it("an agent's writes keep the order: own chat share, other chats ascending, then the event seq", async () => {
  const r = await running({ mint: true });
  const runtime = { authKind: 'agent_runtime', authSessionId: r.grant!.id };
  const effect = (anchor: string) => (q: PoolClient) => q.query(`select public.w2_post_message_batch($1::uuid[],'agent effect',null,
    '{}'::uuid[],'{}'::uuid[],null,$2::uuid,$3,null,$4::uuid)`, [[anchor], fixture.teammateId, randomUUID(), r.id]);
  expect(await assertChatRowFirst(r.id, effect(fixture.channelId), runtime))
    .toEqual({ blocked: true, seq: 'free', entity: 'free' });

  // Parallel tool calls: two agent transactions that have each already read
  // something (so identity_id holds their chat FOR SHARE), then post. 176's
  // FOR UPDATE source check made both upgrade that share: 40P01.
  const readThenPost = async (q: PoolClient) => {
    await q.query('select count(*) from public.entities where id=$1', [fixture.channelId]);
    return effect(fixture.channelId)(q);
  };
  const gate = await hold('select 1 from public.entities where id=$1 for update', [fixture.channelId]);
  const one = await startBlocked(readThenPost, runtime);
  const two = await startBlocked(readThenPost, runtime);
  await gate.release();
  const parallel = await Promise.allSettled([one.result, two.result]);
  expect(parallel.map(s => s.status === 'rejected' ? (s.reason as { code?: string }).code : 'ok')).toEqual(['ok', 'ok']);
}, 60_000);

it('two running agents posting into each other\'s chat at once never deadlock', async () => {
  const a = await running({ mint: true });
  const b = await running({ mint: true });
  const post = (from: Running, to: string) => (q: PoolClient) => q.query(`select public.w2_post_message_batch($1::uuid[],
    'cross-chat',null,'{}'::uuid[],'{}'::uuid[],null,$2::uuid,$3,null,$4::uuid)`, [[to], fixture.teammateId, randomUUID(), from.id]);
  const gate = await hold(lockSeq, [fixture.spaceId]);
  const ab = await startBlocked(post(a, b.id), { authKind: 'agent_runtime', authSessionId: a.grant!.id });
  const ba = await startBlocked(post(b, a.id), { authKind: 'agent_runtime', authSessionId: b.grant!.id });
  await gate.release();
  const settled = await Promise.allSettled([ab.result, ba.result]);
  expect(settled.map(s => s.status === 'rejected' ? (s.reason as { code?: string }).code ?? String(s.reason) : 'ok'))
    .toEqual(['ok', 'ok']);
}, 60_000);
