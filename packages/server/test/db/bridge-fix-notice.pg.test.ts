/**
 * Bridges F (migration 403): the fix notice, at the SQL level. §7.3 F:
 *
 * - A bug reported in Infra and again in Gaming is one task labelled `bug`,
 *   with two origin edges (399's authored_from -> bridge, one per group, D71)
 *   and the `pr_merged` gate.
 * - Merging the PR posts a reply under each original report (D70): signed by
 *   the bridge's teammate, through the outbox, once per (task, bridge,
 *   providerMessageId) however many events follow.
 * - Completing a bug that has no PR posts what was done (D72).
 *
 * A chat turn is a transaction whose `tm8.auth_session_id` is the chat's
 * agent_runtime bearer while the chat holds turn-scoped origins (399 §1).
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import { bridgesWorkerClaims } from '../../src/bridges/outbox.js';
import { runBridgeFixSweepTick } from '../../src/scheduler/jobs/bridge-fix-sweep.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID();
const ownerMember = randomUUID(), ownerIdentity = `f-owner-${randomUUID()}`, ownerAccount = randomUUID();
const teammate = randomUUID();
const chatInfra = randomUUID(), chatGaming = randomUUID();
const bearerInfra = randomUUID(), bearerGaming = randomUUID();
const connection = randomUUID();
const worker = randomUUID();
const GROUP = '120363101@g.us', GROUP_B = '120363102@g.us';
let infra = '', gaming = '', bugLabel = '';

const human = () => ({ identityId: ownerIdentity, authKind: 'browser' as const, requestId: randomUUID() });

/** A transaction as tm8_graph_owner, as `bearer`'s chat turn or a work session (or as nobody). */
function inTx<T>(as: { bearer?: string; session?: string } | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    if (as?.bearer) await c.query(`select set_config('tm8.auth_session_id', $1, true)`, [as.bearer]);
    if (as?.session) await c.query(`select set_config('tm8.work_session_id', $1, true)`, [as.session]);
    return fn(c);
  });
}

async function newEntity(c: PoolClient, kind: string, createdBy = teammate, parent: string | null = null): Promise<string> {
  const id = randomUUID();
  await c.query(`insert into public.entities(id, space_id, kind, created_by, parent_id, visibility) values ($1,$2,$3,$4,$5,'space')`,
    [id, spaceId, kind, createdBy, parent]);
  return id;
}

async function newTask(c: PoolClient, title: string, opts: { bug?: boolean } = {}): Promise<string> {
  const id = await newEntity(c, 'task');
  await c.query(`insert into public.tasks(entity_id, title) values ($1,$2)`, [id, title]);
  if (opts.bug) await c.query(`update public.entities set labels = array[$2::uuid] where id = $1`, [id, bugLabel]);
  return id;
}

async function post(c: PoolClient, anchor: string, body: string, author = teammate): Promise<string> {
  const id = await newEntity(c, 'message', author);
  await c.query(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,$4)`, [id, anchor, author, body]);
  return id;
}

/** An inbound report on a bridge's log (the bridge is the log anchor for a chat target). */
async function report(bridge: string, body: string, externalId: string): Promise<string> {
  return inTx(null, async c => {
    const id = await post(c, bridge, body, ownerMember);
    await c.query(`insert into public.message_origins(message_id, bridge_id, connection_id, direction, external_message_id,
        external_conversation_id, external_sender_id) values ($1,$2,$3,'in',$4,$5,'919876543210@s.whatsapp.net')`,
      [id, bridge, connection, externalId, bridge === infra ? GROUP : GROUP_B]);
    return id;
  });
}

/** The router starting a chat's turn on a routed report (399 add_bridge_origin). */
async function startTurn(chat: string, bridge: string, message: string, providerMessageId: string) {
  await db.tx(human(), q => q.rpc('add_bridge_origin', [chat, JSON.stringify({
    bridgeId: bridge, messageId: message, providerMessageId, sender: { participant: 'Rahul' } })]));
}
const endTurn = (chat: string) => db.tx(human(), q => q.rpc('clear_bridge_origins', [chat]));

const bridgeEdges = (task: string) => scratch.query<{ dst_id: string; props: { origins: Array<Record<string, unknown>> } }>(
  `select e.dst_id::text, e.props from public.edges e join public.entities b on b.id = e.dst_id and b.kind = 'bridge'
    where e.src_id = $1 and e.type = 'authored_from' and e.props ? 'bridgeId' order by e.dst_id`, [task]);
const gateOf = async (task: string) =>
  (await scratch.query<{ g: string }>('select completion_gate g from public.tasks where entity_id = $1', [task]))[0]!.g;
const version = async (id: string) =>
  (await scratch.query<{ v: number }>('select version v from public.entities where id = $1', [id]))[0]!.v;

interface Notice { message_id: string; parent_id: string | null; anchor_id: string; author_id: string; body: string;
  bridge_id: string; kind: string; outbox_text: string | null; poster: string | null; reply_to: string | null }
const noticesFor = (task: string) => scratch.query<Notice>(
  `select n.message_id::text, me.parent_id::text, m.anchor_id::text, m.author_id::text, m.body, n.bridge_id::text, n.kind,
          ob.payload ->> 'text' as outbox_text, ob.poster, ob.external_reply_to as reply_to
     from public.bridge_fix_notices n
     join public.messages m on m.entity_id = n.message_id
     join public.entities me on me.id = n.message_id
     left join public.bridge_outbox ob on ob.message_id = n.message_id and ob.kind = 'send'
    where n.task_id = $1 order by n.bridge_id`, [task]);

async function linkPr(task: string, number: number): Promise<string> {
  await db.tx(human(), q => q.rpc('link_pull_request', [
    task, `https://github.com/acme/app/pull/${number}`, 'github', 'acme/app', number, null, null, `f-link-${randomUUID()}`]));
  return (await scratch.query<{ id: string }>(
    'select entity_id::text id from public.pull_requests where space_id = $1 and number = $2', [spaceId, number]))[0]!.id;
}
const prFacts = (pr: string, state: string | null, ci: string | null) =>
  db.tx(human(), q => q.rpc('apply_pull_request_facts', [pr, null, state, null, ci]));

/** The bridges worker's sweep tick (404 §4). */
const sweep = () => db.rpc<{ closeouts: number; retries: number }>(bridgesWorkerClaims(), 'internal.bridge_fix_sweep', []);
/** Moves a report's close-out window into the past. */
const ageCloseout = (task: string) => inTx(null, c =>
  c.query(`update public.bridge_fix_closeouts set done_at = now() - interval '11 minutes' where task_id = $1`, [task]));

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('bridges_fix');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  await inTx(null, async c => {
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner')`, [ownerIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username) values ($1,$2,'f-owner')`, [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Bridges F',$2)`, [spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [ownerMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Owner')`,
      [ownerMember, spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
      values ($1,$2,'Infra Bot','worker','persona')`, [teammate, ownerMember]);
    for (const [id, title, bearer] of [[chatInfra, 'Infra main', bearerInfra], [chatGaming, 'Gaming main', bearerGaming]] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [id, spaceId, ownerMember]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,$3,$4,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/bf', gen_random_uuid(), $5, $6, $7)`,
        [id, spaceId, title, teammate, ownerIdentity, ownerMember, `bf-${randomUUID()}`]);
      await c.query(`insert into public.auth_sessions(id, account_id, kind, acting_as_team_member_id, runtime_member_id,
          runtime_chat_id, token_hash, expires_at, space_id)
        values ($1,$2,'agent_runtime',$3,$4,$5,$6,now()+interval '1 hour',$7)`,
        [bearer, ownerAccount, teammate, ownerMember, id, randomUUID().replaceAll('-', '').repeat(2), spaceId]);
    }
    await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`,
      [worker, spaceId, teammate]);
    await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Fixer','running','none',now())`, [worker]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …9494','linked')`, [connection, ownerAccount]);
  });
  const create = (conv: string, title: string, target: string) => db.tx(human(), q => q.rpc<{ entity: { id: string } }>('create_bridge', [
    spaceId, connection, conv, JSON.stringify({ kind: 'group', title, memberCount: 5 }),
    target, '{}', teammate, null, null, true, null, null, randomUUID(),
  ]));
  infra = (await create(GROUP, 'Infra', chatInfra)).entity.id;
  gaming = (await create(GROUP_B, 'Gaming', chatGaming)).entity.id;
  bugLabel = (await scratch.query<{ id: string }>(
    `select entity_id::text id from public.labels where space_id = $1 and lower(name) = 'bug'`, [spaceId]))[0]!.id;
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

describe('F: one bug, two groups, one merge (§7.3 F, D24, D70, D71)', () => {
  let task = '', reportInfra = '', reportGaming = '';

  it('a bug a chat turn creates from an Infra report is labelled bug, has the Infra origin edge and the pr_merged gate', async () => {
    reportInfra = await report(infra, 'login page 500s since this morning', 'wamid.INFRA1');
    await startTurn(chatInfra, infra, reportInfra, 'wamid.INFRA1');
    task = await inTx({ bearer: bearerInfra }, c => newTask(c, 'Login page returns 500', { bug: true }));
    await endTurn(chatInfra);
    expect(await gateOf(task)).toBe('pr_merged');
    // Gated in the insert: the create's version is the task's version.
    expect(await version(task)).toBe(1);
    const edges = await bridgeEdges(task);
    expect(edges.map(e => e.dst_id)).toEqual([infra]);
    expect(edges[0]!.props.origins).toEqual([expect.objectContaining({ providerMessageId: 'wamid.INFRA1', messageId: reportInfra })]);
    const [label] = await scratch.query<{ labels: string[] }>('select labels::text[] from public.entities where id = $1', [task]);
    expect(label!.labels).toEqual([bugLabel]);
  });

  it('the same bug reported in Gaming: the Gaming turn posts on the task, and the task gains the Gaming edge (one task, two edges)', async () => {
    reportGaming = await report(gaming, 'cannot log in, 500', 'wamid.GAMING1');
    await startTurn(chatGaming, gaming, reportGaming, 'wamid.GAMING1');
    await inTx({ bearer: bearerGaming }, c => post(c, task, 'Also reported in Gaming.'));
    await endTurn(chatGaming);
    const edges = await bridgeEdges(task);
    expect(edges.map(e => e.dst_id).sort()).toEqual([infra, gaming].sort());
    expect(edges.find(e => e.dst_id === gaming)!.props.origins)
      .toEqual([expect.objectContaining({ providerMessageId: 'wamid.GAMING1' })]);
    expect(await gateOf(task)).toBe('pr_merged');
    expect(await noticesFor(task)).toEqual([]);
  });

  it('an open PR posts nothing; merging it posts one reply under each original report, signed by the teammate, through the outbox', async () => {
    const pr = await linkPr(task, 101);
    expect(await noticesFor(task)).toEqual([]);
    await prFacts(pr, 'merged', null);   // a repo with no CI: ci_status stays NULL and the gate passes
    const notices = await noticesFor(task);
    expect(notices).toHaveLength(2);
    for (const [bridge, reportId, ext] of [[infra, reportInfra, 'wamid.INFRA1'], [gaming, reportGaming, 'wamid.GAMING1']] as const) {
      const n = notices.find(x => x.bridge_id === bridge)!;
      expect(n).toMatchObject({ kind: 'merged', anchor_id: bridge, parent_id: reportId, author_id: teammate,
        poster: 'chat', reply_to: ext });
      expect(n.body).toBe('Fixed: Login page returns 500. Merged https://github.com/acme/app/pull/101');
      expect(n.outbox_text).toBe(`Infra Bot: ${n.body}`);
    }
  });

  it('is idempotent per (task, bridge, providerMessageId): CI events, a re-linked PR and a second PR post nothing more', async () => {
    const [pr] = await scratch.query<{ id: string }>('select entity_id::text id from public.pull_requests where number = 101');
    await prFacts(pr!.id, 'merged', 'pending');
    await prFacts(pr!.id, 'merged', 'passing');
    await linkPr(task, 101);
    const pr2 = await linkPr(task, 102);
    await prFacts(pr2, 'merged', 'passing');
    expect(await noticesFor(task)).toHaveLength(2);
    const [n] = await scratch.query<{ n: number }>(
      `select count(*)::int n from public.messages where message_batch_id like 'bridge-fix:' || $1 || ':%'`, [task]);
    expect(n!.n).toBe(2);
  });
});

describe('F: the gate predicate decides (D70)', () => {
  it('merged but CI-red posts nothing until CI is green', async () => {
    const r = await report(infra, 'deploy page blank', 'wamid.INFRA2');
    await startTurn(chatInfra, infra, r, 'wamid.INFRA2');
    const task = await inTx({ bearer: bearerInfra }, c => newTask(c, 'Deploy page blank', { bug: true }));
    await endTurn(chatInfra);
    const pr = await linkPr(task, 201);
    await prFacts(pr, 'merged', 'failing');
    expect(await noticesFor(task)).toEqual([]);
    await prFacts(pr, 'merged', 'passing');
    expect(await noticesFor(task)).toHaveLength(1);
  });

  it('two tracked PRs: nothing until both are merged', async () => {
    const r = await report(gaming, 'scores reset', 'wamid.GAMING2');
    await startTurn(chatGaming, gaming, r, 'wamid.GAMING2');
    const task = await inTx({ bearer: bearerGaming }, c => newTask(c, 'Scores reset', { bug: true }));
    await endTurn(chatGaming);
    const a = await linkPr(task, 301), b = await linkPr(task, 302);
    await prFacts(a, 'merged', null);
    expect(await noticesFor(task)).toEqual([]);
    await prFacts(b, 'merged', null);
    const notices = await noticesFor(task);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe('Fixed: Scores reset. Merged https://github.com/acme/app/pull/301 https://github.com/acme/app/pull/302');
  });

  it('linking a PR that is already merged posts at once', async () => {
    const r = await report(infra, 'avatars missing', 'wamid.INFRA3');
    await startTurn(chatInfra, infra, r, 'wamid.INFRA3');
    const task = await inTx({ bearer: bearerInfra }, c => newTask(c, 'Avatars missing', { bug: true }));
    await endTurn(chatInfra);
    const other = await inTx(null, c => newTask(c, 'Unrelated'));
    const pr = await linkPr(other, 401);
    await prFacts(pr, 'merged', null);
    expect(await noticesFor(task)).toEqual([]);
    await linkPr(task, 401);
    expect(await noticesFor(task)).toHaveLength(1);
  });
});

describe('F: a bug completed without a PR says what was done (D72)', () => {
  it('the gate is lifted by hand; entering done posts the newest person or teammate message', async () => {
    const r = await report(infra, 'disk full on box 3', 'wamid.INFRA4');
    await startTurn(chatInfra, infra, r, 'wamid.INFRA4');
    const task = await inTx({ bearer: bearerInfra }, c => newTask(c, 'Disk full on box 3', { bug: true }));
    await endTurn(chatInfra);
    // Completing a gated task with no PR is refused, as 082 always did.
    await expect(db.tx(human(), async q => q.rpc('complete_task', [task, await version(task), [ownerMember], null, null])))
      .rejects.toThrow(/no tracked pull request/);
    await db.tx(human(), async q => q.rpc('set_task_gate', [task, await version(task), 'none', null, `f-gate-${randomUUID()}`]));
    await inTx(null, c => post(c, task, 'Cleared 40 GB of old logs and added logrotate.'));
    // A bridge's own message on the task is never "what was done".
    await inTx(null, c => post(c, task, 'tm8: noise', infra));
    await db.tx(human(), async q => q.rpc('complete_task', [task, await version(task), [ownerMember], null, `f-done-${randomUUID()}`]));
    // 404 §3: the notice waits for a close-out; with none in the window the
    // sweep posts the newest message from before the done move.
    expect(await noticesFor(task)).toEqual([]);
    await ageCloseout(task);
    await sweep();
    const notices = await noticesFor(task);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'done_without_pr', parent_id: r, author_id: teammate,
      body: 'Done: Disk full on box 3. Cleared 40 GB of old logs and added logrotate.' });
  });

  it('with no message on the task it says it closed without a pull request', async () => {
    const r = await report(gaming, 'typo on the rules page', 'wamid.GAMING3');
    await startTurn(chatGaming, gaming, r, 'wamid.GAMING3');
    const task = await inTx({ bearer: bearerGaming }, c => newTask(c, 'Typo on the rules page', { bug: true }));
    await endTurn(chatGaming);
    await db.tx(human(), async q => q.rpc('set_task_gate', [task, await version(task), 'none', null, `f-gate-${randomUUID()}`]));
    await db.tx(human(), async q => q.rpc('complete_task', [task, await version(task), [ownerMember], null, `f-done-${randomUUID()}`]));
    await ageCloseout(task);
    await sweep();
    expect((await noticesFor(task))[0]?.body).toBe('Done: Typo on the rules page (closed without a pull request).');
  });
});

describe('F: what is not a report', () => {
  it('a task with no bridge origin, or a worker\'s non-bug task, is neither gated nor noticed', async () => {
    const plain = await inTx(null, c => newTask(c, 'Plain task'));
    expect(await gateOf(plain)).toBe('none');
    const m = await report(infra, '/work tidy the README', 'wamid.INFRA5');
    await db.tx(human(), q => q.rpc('bridge_launch_origins', [worker, JSON.stringify([{
      bridgeId: infra, messageId: m, providerMessageId: 'wamid.INFRA5', sender: {}, command: '/work' }])]));
    const chore = await inTx({ session: worker }, c => newTask(c, 'Tidy README'));
    expect((await bridgeEdges(chore)).map(e => e.dst_id)).toEqual([infra]);
    expect(await gateOf(chore)).toBe('none');
    const pr = await linkPr(chore, 501);
    await prFacts(pr, 'merged', null);
    expect(await noticesFor(chore)).toEqual([]);
  });

  it('a worker\'s task labelled bug is a report: its merge posts under the /work message, ungated', async () => {
    const m = await report(infra, '/work fix the flaky cron', 'wamid.INFRA6');
    const w2 = await inTx(null, async c => {
      const id = await newEntity(c, 'work_session');
      await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Cron','running','none',now())`, [id]);
      return id;
    });
    await db.tx(human(), q => q.rpc('bridge_launch_origins', [w2, JSON.stringify([{
      bridgeId: infra, messageId: m, providerMessageId: 'wamid.INFRA6', sender: {}, command: '/work' }])]));
    const bug = await inTx({ session: w2 }, c => newTask(c, 'Flaky cron', { bug: true }));
    expect(await gateOf(bug)).toBe('none');
    const pr = await linkPr(bug, 601);
    await prFacts(pr, 'merged', null);
    const notices = await noticesFor(bug);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ parent_id: m, kind: 'merged' });
  });

  it('a worker posting on a bug does not add its own origins to it (D30)', async () => {
    const r = await report(infra, 'search is slow', 'wamid.INFRA7');
    await startTurn(chatInfra, infra, r, 'wamid.INFRA7');
    const task = await inTx({ bearer: bearerInfra }, c => newTask(c, 'Search is slow', { bug: true }));
    await endTurn(chatInfra);
    await inTx({ session: worker }, c => post(c, task, 'Looking at the index.'));
    const edges = await bridgeEdges(task);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.props.origins.map(o => o['providerMessageId'])).toEqual(['wamid.INFRA7']);
  });
});

describe('F: review regressions', () => {
  it('a loop firing in a chat turn is not a report: the task it creates is not gated', async () => {
    await db.tx(human(), q => q.rpc('add_bridge_origin', [chatInfra, JSON.stringify({ bridgeId: infra, loopId: randomUUID() })]));
    const task = await inTx({ bearer: bearerInfra }, c => newTask(c, 'Weekly digest follow-up'));
    await endTurn(chatInfra);
    expect(await gateOf(task)).toBe('none');
    expect((await scratch.query('select 1 from public.bridge_fix_reports where task_id = $1', [task]))).toEqual([]);
  });

  it('an edge F does not act on queues no deferred event: ALTER TABLE edges in the same transaction succeeds', async () => {
    // follows_up: no deferred trigger on edges watches it.
    await inTx(null, async c => {
      const [a, b] = [await newTask(c, 'Earlier work'), await newTask(c, 'Later work')];
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1,$2,$3,'follows_up',$4)`,
        [spaceId, b, a, teammate]);
      await c.query('alter table public.edges disable trigger edges_bridge_fix');
      await c.query('alter table public.edges enable trigger edges_bridge_fix');
    });
    // A bridge-marked authored_from -> origin message (399's recorder writes one beside
    // every -> bridge edge): its bridgeId is not its dst, so F queues nothing for it.
    const r = await report(infra, 'disk full', 'wamid.INFRA9');
    await inTx(null, async c => {
      const task = await newTask(c, 'Disk full');
      await c.query(`select internal.w1_set_writer('entity_recorder')`);
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by, props) values ($1,$2,$3,'authored_from',$4,$5::jsonb)`,
        [spaceId, task, r, teammate, JSON.stringify({ bridgeId: infra, origins: [] })]);
      await c.query('alter table public.edges disable trigger edges_bridge_fix');
      await c.query('alter table public.edges enable trigger edges_bridge_fix');
    });
  });

  it('a failing notice never fails the triggering write, and the next event retries', async () => {
    const r = await report(infra, 'webhooks dropped', 'wamid.INFRA8');
    await startTurn(chatInfra, infra, r, 'wamid.INFRA8');
    const task = await inTx({ bearer: bearerInfra }, c => newTask(c, 'Webhooks dropped', { bug: true }));
    await endTurn(chatInfra);
    const [{ def }] = await scratch.query<{ def: string }>(
      `select pg_get_functiondef('internal.bridge_fix_check(uuid)'::regprocedure) def`) as [{ def: string }];
    await scratch.query(`create or replace function internal.bridge_fix_check(p_task uuid) returns integer
      language plpgsql security definer set search_path = public, internal, pg_temp as $$
      begin raise exception 'injected notice failure'; end $$`);
    let pr = '';
    try {
      // tracks edge, merge, and a re-report all commit despite the check raising.
      pr = await linkPr(task, 801);
      await prFacts(pr, 'merged', null);
      const rg = await report(gaming, 'webhooks gone here too', 'wamid.GAMING8');
      await startTurn(chatGaming, gaming, rg, 'wamid.GAMING8');
      await inTx({ bearer: bearerGaming }, c => post(c, task, 'Gaming sees it too.'));
      await endTurn(chatGaming);
      expect((await scratch.query<{ state: string }>('select state from public.pull_requests where entity_id = $1', [pr]))[0]!.state)
        .toBe('merged');
      expect(await noticesFor(task)).toEqual([]);
    } finally {
      await scratch.query(def);
    }
    await prFacts(pr, 'merged', 'passing');
    expect(await noticesFor(task)).toHaveLength(2);
  });
});

describe('F follow-ups (404)', () => {
  /** A fresh report from an Infra chat turn, labelled bug. */
  async function freshReport(title: string, ext: string): Promise<{ task: string; report: string }> {
    const r = await report(infra, title.toLowerCase(), ext);
    await startTurn(chatInfra, infra, r, ext);
    const task = await inTx({ bearer: bearerInfra }, c => newTask(c, title, { bug: true }));
    await endTurn(chatInfra);
    return { task, report: r };
  }
  const pendingOf = (task: string) => scratch.query<{ status: string; attempts: number; last_error: string | null }>(
    'select status, attempts, last_error from public.bridge_fix_pending where task_id = $1', [task]);
  /** A PR merge whose commit runs as a work session (399's answerer guard refuses it). */
  const mergeAsWorker = (pr: string, ci: string | null = null) => inTx({ session: worker }, c =>
    c.query('update public.pull_requests set state = $2, ci_status = $3 where entity_id = $1', [pr, 'merged', ci]));

  it('§1 a cancelled report whose PR merges later posts nothing', async () => {
    const { task } = await freshReport('Cancelled bug', 'wamid.F1');
    const pr = await linkPr(task, 901);
    await inTx(null, c => c.query(`update public.tasks set work_status = 'cancelled' where entity_id = $1`, [task]));
    expect((await scratch.query<{ c: string }>('select status_category c from public.entities where id = $1', [task]))[0]!.c)
      .toBe('cancelled');
    await prFacts(pr, 'merged', 'passing');
    await sweep();
    expect(await noticesFor(task)).toEqual([]);
  });

  it('§3 the first close-out after the done move is what was done, not an older message', async () => {
    const { task, report: r } = await freshReport('Cache stale', 'wamid.F3');
    await db.tx(human(), async q => q.rpc('set_task_gate', [task, await version(task), 'none', null, `f-gate-${randomUUID()}`]));
    await inTx(null, c => post(c, task, 'Looking at the TTLs.'));
    await db.tx(human(), async q => q.rpc('complete_task', [task, await version(task), [ownerMember], null, `f-done-${randomUUID()}`]));
    expect(await noticesFor(task)).toEqual([]);
    await inTx({ session: worker }, c => post(c, task, 'Dropped the TTL to 60 s and purged the CDN.'));
    const notices = await noticesFor(task);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'done_without_pr', parent_id: r,
      body: 'Done: Cache stale. Dropped the TTL to 60 s and purged the CDN.' });
    expect(await scratch.query('select 1 from public.bridge_fix_closeouts where task_id = $1', [task])).toEqual([]);
  });

  it('§2 a notice refused by the answerer guard is recorded and posts when the answer settles', async () => {
    const { task, report: r } = await freshReport('Queue stuck', 'wamid.F2');
    await db.tx(human(), q => q.rpc('set_bridge_answerer', [r, chatInfra]));
    const pr = await linkPr(task, 902);
    await mergeAsWorker(pr);
    expect(await noticesFor(task)).toEqual([]);
    expect(await pendingOf(task)).toEqual([expect.objectContaining({ status: 'retrying', attempts: 1 })]);
    expect((await pendingOf(task))[0]!.last_error).toMatch(/answer/);
    await db.tx(human(), q => q.rpc('settle_bridge_answer', [r]));
    const notices = await noticesFor(task);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'merged', parent_id: r });
    expect(await pendingOf(task)).toEqual([]);
  });

  it('§2 the sweep retries a refused notice without waiting for the answer', async () => {
    const { task, report: r } = await freshReport('Emails late', 'wamid.F4');
    await db.tx(human(), q => q.rpc('set_bridge_answerer', [r, chatInfra]));
    const pr = await linkPr(task, 903);
    await mergeAsWorker(pr);
    expect(await noticesFor(task)).toEqual([]);
    // The scheduler job's own tick (sweep.bridge-fix-notices).
    expect(await runBridgeFixSweepTick({ db })).toMatchObject({ affected: expect.any(Number) });
    expect(await noticesFor(task)).toHaveLength(1);
    expect(await pendingOf(task)).toEqual([]);
  });

  it('§2 after 5 failed attempts it gives up with an fyi, and later events post nothing', async () => {
    const { task, report: r } = await freshReport('Search 404s', 'wamid.F5');
    await db.tx(human(), q => q.rpc('set_bridge_answerer', [r, chatInfra]));
    const pr = await linkPr(task, 904);
    for (const ci of [null, 'pending', 'passing', 'pending', 'passing']) await mergeAsWorker(pr, ci);
    expect(await pendingOf(task)).toEqual([expect.objectContaining({ status: 'given_up', attempts: 5 })]);
    const fyi = await scratch.query<{ level: string; status: string; reason: string }>(
      `select level, status, reason from public.attention_requests where entity_id = $1 and signal_key like 'bridge.fix_notice_failed:%'`, [task]);
    expect(fyi).toEqual([expect.objectContaining({ level: 'fyi', status: 'open' })]);
    expect(fyi[0]!.reason).toContain('Search 404s');
    await db.tx(human(), q => q.rpc('settle_bridge_answer', [r]));
    await sweep();
    expect(await noticesFor(task)).toEqual([]);
  });

  it('§2 the age bound: a failure 30 minutes after the first gives up too', async () => {
    const { task, report: r } = await freshReport('Uploads fail', 'wamid.F6');
    await db.tx(human(), q => q.rpc('set_bridge_answerer', [r, chatInfra]));
    const pr = await linkPr(task, 905);
    await mergeAsWorker(pr);
    await inTx(null, c => c.query(`update public.bridge_fix_pending set first_at = now() - interval '31 minutes' where task_id = $1`, [task]));
    await mergeAsWorker(pr, 'passing');
    expect(await pendingOf(task)).toEqual([expect.objectContaining({ status: 'given_up', attempts: 2 })]);
  });

  it('§2 a wait on a report cancelled or deleted afterwards is dropped by the sweep, not swept forever', async () => {
    const { task, report: r } = await freshReport('Login loop', 'wamid.F7');
    await db.tx(human(), q => q.rpc('set_bridge_answerer', [r, chatInfra]));
    const pr = await linkPr(task, 906);
    await mergeAsWorker(pr);
    expect(await pendingOf(task)).toEqual([expect.objectContaining({ status: 'retrying' })]);
    await inTx(null, c => c.query(`update public.tasks set work_status = 'cancelled' where entity_id = $1`, [task]));
    await sweep();
    expect(await pendingOf(task)).toEqual([]);
    expect(await noticesFor(task)).toEqual([]);

    const gone = await freshReport('Avatar blank', 'wamid.F8');
    await db.tx(human(), async q => q.rpc('set_task_gate', [gone.task, await version(gone.task), 'none', null, `f-gate-${randomUUID()}`]));
    await db.tx(human(), async q => q.rpc('complete_task', [gone.task, await version(gone.task), [ownerMember], null, `f-done-${randomUUID()}`]));
    await inTx(null, c => c.query('update public.entities set deleted_at = now() where id = $1', [gone.task]));
    await ageCloseout(gone.task);
    await sweep();
    expect(await scratch.query('select 1 from public.bridge_fix_closeouts where task_id = $1', [gone.task])).toEqual([]);
    expect(await noticesFor(gone.task)).toEqual([]);
  });
});
