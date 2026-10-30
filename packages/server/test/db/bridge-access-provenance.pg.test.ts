/**
 * Bridges B1b-3 (migration 399) against a real PostgreSQL with every migration
 * applied: §7.3 items 4, 10 and 11 at the SQL level.
 *
 * - provenance (D22, D30, D31): launch origins, inheritance at any depth, the
 *   recorder on every create path, the cross-group rule, redelivery adding
 *   none, edges surviving a move, the edge guard and recorder ownership;
 * - access (D21, D23): handles on first post (one per space, every group),
 *   the audience a message wakes, unread counts, one answerer per message.
 *
 * A "session's create" is an entity insert inside a transaction whose claims
 * name that session, exactly what every server path runs under; a few real
 * create RPCs run through the db layer as well.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID();
const ownerMember = randomUUID();
const ownerIdentity = `b1b3-owner-${randomUUID()}`;
const ownerAccount = randomUUID();
const teammate = randomUUID();
const chatInfra = randomUUID(), chatOps = randomUUID();
const connection = randomUUID();
const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), bystander = randomUUID();
let infra = '', ops = '';

interface Edge { dst_id: string; props: { bridgeId?: string; origins?: Array<Record<string, any>>; origin?: string } }

/** A transaction as tm8_graph_owner with the claims of `session` (or none: a person / the runtime). */
function inTx<T>(session: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    if (session) await c.query(`select set_config('tm8.work_session_id', $1, true)`, [session]);
    return fn(c);
  });
}

async function newEntity(c: PoolClient, kind: string, opts: { id?: string; parent?: string | null } = {}): Promise<string> {
  const id = opts.id ?? randomUUID();
  await c.query(`insert into public.entities(id, space_id, kind, created_by, parent_id, visibility) values ($1,$2,$3,$4,$5,'space')`,
    [id, spaceId, kind, teammate, opts.parent ?? null]);
  return id;
}

async function newSession(c: PoolClient, id: string, title = 'Worker'): Promise<string> {
  await newEntity(c, 'work_session', { id });
  await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
    values ($1,$2,'running','none',now())`, [id, title]);
  return id;
}

/** A message on an anchor; a session's post also gets message_recorder's message -> session origin. */
async function post(c: PoolClient, anchor: string, body: string, opts: { parent?: string; session?: string; author?: string } = {}): Promise<string> {
  const id = await newEntity(c, 'message', { parent: opts.parent ?? null });
  let root: string | null = null;
  if (opts.parent) {
    const { rows } = await c.query<{ r: string }>('select coalesce(root_message_id, entity_id) r from public.messages where entity_id = $1', [opts.parent]);
    root = rows[0]!.r;
  }
  await c.query(`insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body) values ($1,$2,$3,$4,$5)`,
    [id, anchor, root, opts.author ?? teammate, body]);
  if (opts.session) {
    await c.query(`select internal.w1_set_writer('message_recorder')`);
    await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1,$2,$3,'authored_from',$4)`,
      [spaceId, id, opts.session, teammate]);
    await c.query(`select internal.w1_set_writer(null)`);
  }
  return id;
}

/** An inbound provider message on a bridge's log (the bridge is the anchor for a chat target). */
async function inbound(bridge: string, body: string, externalId: string, parent?: string): Promise<string> {
  return inTx(null, async c => {
    const id = await post(c, bridge, body, { author: ownerMember, ...(parent ? { parent } : {}) });
    await c.query(`insert into public.message_origins(message_id, bridge_id, connection_id, direction, external_message_id,
        external_conversation_id, external_sender_id) values ($1,$2,$3,'in',$4,'conv','+919999')`,
      [id, bridge, connection, externalId]);
    return id;
  });
}

const edgesOf = (src: string) => scratch.query<Edge>(
  `select dst_id::text, props from public.edges where src_id = $1 and type = 'authored_from' and props ? 'bridgeId' order by dst_id`, [src]);
const toBridge = async (src: string, bridge: string) => (await edgesOf(src)).find(e => e.dst_id === bridge);
const origin = (bridge: string, messageId: string, providerMessageId: string, command: string | null = null) =>
  ({ bridgeId: bridge, messageId, providerMessageId, sender: { participant: 'Rahul' }, command });

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message?: string; detail?: string; details?: Record<string, unknown> }> {
  try { await p; } catch (err) { return err as never; }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('bridges_b1b3');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  await inTx(null, async c => {
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner')`, [ownerIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username) values ($1,$2,'b1b3-owner')`, [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'B1b-3',$2)`, [spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [ownerMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Owner')`,
      [ownerMember, spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
      values ($1,$2,'Infra teammate','worker','persona')`, [teammate, ownerMember]);
    for (const [id, title] of [[chatInfra, 'Infra main'], [chatOps, 'Ops main']] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [id, spaceId, ownerMember]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,$3,$4,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b1b3', gen_random_uuid(), $5, $6, $7)`,
        [id, spaceId, title, teammate, ownerIdentity, ownerMember, `b1b3-${randomUUID()}`]);
    }
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …9494','linked')`, [connection, ownerAccount]);
    await newSession(c, s1, 'Infra fixer');
    await newSession(c, bystander, 'Bystander');
  });
  const create = (externalId: string, title: string, target: string) => db.tx(
    { identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() },
    q => q.rpc<{ entity: { id: string } }>('create_bridge', [
      spaceId, connection, externalId, JSON.stringify({ kind: 'group', title, memberCount: 7 }), target, '{}', teammate,
      null, null, true, null, null, randomUUID()]));
  infra = (await create('120363-infra@g.us', 'Infra', chatInfra)).entity.id;
  ops = (await create('120363-ops@g.us', 'Ops', chatOps)).entity.id;
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

describe('the edge guard (D22, closing B1b-1\'s gap)', () => {
  it('refuses a bridgeId-marked authored_from to a session or chat, a fake bridgeId, and origins that are not an array', async () => {
    await inTx(null, async c => {
      const doc = await newEntity(c, 'doc');
      await c.query(`select internal.w1_set_writer('entity_recorder')`);
      for (const [dst, props] of [
        [s1, { bridgeId: infra, origins: [] }],
        [chatInfra, { bridgeId: infra, origins: [] }],
      ] as const) {
        await c.query('savepoint g');
        const e = await refusal(c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by, props)
          values ($1,$2,$3,'authored_from',$4,$5::jsonb)`, [spaceId, doc, dst, teammate, JSON.stringify(props)]));
        expect(e.message).toMatch(/points at a bridge or a message/);
        await c.query('rollback to savepoint g');
      }
      await c.query('savepoint g');
      const fake = await refusal(c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by, props)
        values ($1,$2,$3,'authored_from',$4,$5::jsonb)`, [spaceId, doc, infra, teammate, JSON.stringify({ bridgeId: infra, origins: {} })]));
      expect(fake.message).toMatch(/origins\[\]/);
      await c.query('rollback to savepoint g');
    });
  });

  it('keeps the edge recorder-owned: a client create or delete of authored_from -> bridge is refused', async () => {
    const doc = await inTx(null, c => newEntity(c, 'doc'));
    await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, q =>
      q.rpc('record_bridge_provenance', [doc, JSON.stringify([origin(infra, randomUUID(), 'wamid.guard')].map(o => ({ ...o, messageId: null })))]));
    expect(await toBridge(doc, infra)).toBeDefined();
    const created = await refusal(inTx(null, async c => c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by, props)
      values ($1,$2,$3,'authored_from',$4,$5::jsonb)`, [spaceId, await newEntity(c, 'doc'), infra, teammate,
      JSON.stringify({ bridgeId: infra, origins: [] })])));
    expect(created.code).toBe('42501');
    const deleted = await refusal(inTx(s1, c => c.query(
      `delete from public.edges where src_id = $1 and dst_id = $2 and type = 'authored_from'`, [doc, infra])));
    expect(deleted.code).toBe('42501');
    expect(await toBridge(doc, infra)).toBeDefined();
  });
});

describe('provenance (§2.8, D22, D30, D31; §7.3 item 11)', () => {
  let m1 = '', doc1 = '';

  it('launches a /work session with its origins: launch context plus -> bridge and -> message edges', async () => {
    m1 = await inbound(infra, '/work fix the deploy', 'wamid.m1');
    const n = await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, q =>
      q.rpc<number>('bridge_launch_origins', [s1, JSON.stringify([origin(infra, m1, 'wamid.m1', '/work')])]));
    expect(n).toBe(2);
    const [toB, toM] = [await toBridge(s1, infra), (await edgesOf(s1)).find(e => e.dst_id === m1)];
    expect(toB!.props).toMatchObject({ bridgeId: infra, origin: 'entity_recorder',
      origins: [{ messageId: m1, providerMessageId: 'wamid.m1', command: '/work', inherited: false, viaSessionId: null, depth: 0 }] });
    expect(toM!.props).toMatchObject({ bridgeId: infra, origins: [{ providerMessageId: 'wamid.m1' }] });
  });

  it('stamps every create path under a session with bridgeOrigins, in the create\'s transaction', async () => {
    const [trigger] = await scratch.query<{ def: string }>(
      `select pg_get_triggerdef(oid) def from pg_trigger where tgname = 'entities_bridge_provenance'`);
    expect(trigger!.def).toMatch(/AFTER INSERT ON public\.entities FOR EACH ROW/);
    const kinds = ['task', 'doc', 'artifact', 'memory', 'drawing', 'form', 'loop', 'story', 'message', 'file', 'collection'];
    const made = await inTx(s1, async c => {
      const out: Array<readonly [string, string]> = [];
      for (const k of kinds) out.push([k, await newEntity(c, k)] as const);
      return out;
    });
    for (const [kind, id] of made) {
      const e = await toBridge(id, infra);
      expect(e, `${kind} has its -> bridge edge`).toBeDefined();
      expect(e!.props.origins).toEqual([expect.objectContaining({ inherited: true, viaSessionId: s1, depth: 0, providerMessageId: 'wamid.m1' })]);
      expect((await edgesOf(id)).some(x => x.dst_id === m1), `${kind} has its -> message edge`).toBe(true);
    }
    // And through the real create doors, as the session's caller.
    const claims = { identityId: ownerIdentity, authKind: 'browser' as const, requestId: randomUUID(), workSessionId: s1 };
    const task = await db.tx(claims, q => q.rpc<{ entity: { id: string } }>('create_task', [spaceId, 'From the group', null, '', {},
      null, null, 'medium', '[]', null, null, null, null, 'attached_to', randomUUID()]));
    doc1 = (await db.tx(claims, q => q.rpc<{ entity: { id: string } }>('create_document', [spaceId, 'Runbook', null, 'body',
      'markdown', null, null, null, 'attached_to', randomUUID()]))).entity.id;
    expect(await toBridge(task.entity.id, infra)).toBeDefined();
    expect(await toBridge(doc1, infra)).toBeDefined();
    // A person (no session) creating the same gets nothing.
    const plain = await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, q =>
      q.rpc<{ entity: { id: string } }>('create_document', [spaceId, 'By hand', null, 'x', 'markdown', null, null, null, 'attached_to', randomUUID()]));
    expect(await edgesOf(plain.entity.id)).toEqual([]);
  });

  it('inherits at any depth: child and grandchild sessions carry depth and inherited, and stamp what they make', async () => {
    await inTx(s1, c => newSession(c, s2, 'Child'));
    await inTx(s2, c => newSession(c, s3, 'Grandchild'));
    const ctx = await scratch.query<{ holder_id: string; depth: number; inherited: boolean; via_session_id: string }>(
      `select holder_id::text, depth, inherited, via_session_id::text from public.session_bridge_origins
        where holder_id in ($1,$2) order by depth`, [s2, s3]);
    expect(ctx).toEqual([
      { holder_id: s2, depth: 1, inherited: true, via_session_id: s1 },
      { holder_id: s3, depth: 2, inherited: true, via_session_id: s2 },
    ]);
    expect((await toBridge(s3, infra))!.props.origins).toEqual([expect.objectContaining({ depth: 2, inherited: true, viaSessionId: s2 })]);
    const deep = await inTx(s3, c => newEntity(c, 'doc'));
    expect((await toBridge(deep, infra))!.props.origins).toEqual([
      expect.objectContaining({ depth: 2, inherited: true, viaSessionId: s3, messageId: m1, command: '/work' })]);
  });

  it('D30: a post in another group adds nothing; a routed message from it adds an origin, once, for later work only', async () => {
    const before = await inTx(s1, c => post(c, ops, 'Infra here, FYI', { session: s1 }));
    expect(await toBridge(before, ops)).toBeUndefined();
    expect(await toBridge(before, infra)).toBeDefined();

    const opsMsg = await inbound(ops, '@someone can you check ops?', 'wamid.ops1');
    const add = () => db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, q =>
      q.rpc<boolean>('add_bridge_origin', [s1, JSON.stringify(origin(ops, opsMsg, 'wamid.ops1'))]));
    expect(await add()).toBe(true);
    expect(await add()).toBe(false);   // redelivery adds none

    const after = await inTx(s1, c => newEntity(c, 'task'));
    expect((await toBridge(after, ops))!.props.origins).toHaveLength(1);
    expect((await toBridge(after, infra))!.props.origins).toHaveLength(1);
    expect(await toBridge(doc1, ops)).toBeUndefined();   // never rewritten

    // Two messages from one bridge are two origins on ONE edge (D31).
    const m3 = await inbound(infra, 'also the cert', 'wamid.m3');
    await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, q =>
      q.rpc('add_bridge_origin', [s1, JSON.stringify(origin(infra, m3, 'wamid.m3'))]));
    const two = await inTx(s1, c => newEntity(c, 'doc'));
    expect((await toBridge(two, infra))!.props.origins.map(o => o['providerMessageId'])).toEqual(['wamid.m1', 'wamid.m3']);
    expect((await edgesOf(two)).filter(e => e.dst_id === m1 || e.dst_id === m3)).toHaveLength(2);
    // record_bridge_provenance appends a new origin to the existing edge and skips a known one.
    await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, q =>
      q.rpc('record_bridge_provenance', [two, JSON.stringify([origin(infra, m1, 'wamid.m1'), origin(infra, m1, 'wamid.m9', '/task')])]));
    expect((await toBridge(two, infra))!.props.origins.map(o => o['providerMessageId'])).toEqual(['wamid.m1', 'wamid.m3', 'wamid.m9']);
  });

  it('edges stay put when the entity moves', async () => {
    const parent = await inTx(null, c => newEntity(c, 'doc'));
    const before = await edgesOf(doc1);
    await inTx(null, c => c.query('update public.entities set parent_id = $2 where id = $1', [doc1, parent]));
    expect(await edgesOf(doc1)).toEqual(before);
  });

  it('a chat\'s origins are turn-scoped: cleared when the turn settles', async () => {
    const m = await inbound(infra, 'what is the status?', 'wamid.chat1');
    await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, async q => {
      expect(await q.rpc('add_bridge_origin', [chatInfra, JSON.stringify(origin(infra, m, 'wamid.chat1'))])).toBe(true);
      expect(await q.rpc('clear_bridge_origins', [chatInfra])).toBe(1);
    });
  });
});

describe('handles on first post (D23; §7.3 item 4)', () => {
  it('mints one space handle on the first post and keeps it in every group', async () => {
    const [none] = await scratch.query<{ n: number }>('select count(*)::int n from public.bridge_handles where entity_id = $1', [bystander]);
    expect(none!.n).toBe(0);
    const outbox = (bridge: string) => inTx(bystander, async c => {
      const msg = await post(c, bridge, 'Looking into it', { session: bystander });
      await c.query(`insert into public.bridge_outbox(bridge_id, message_id, payload) values ($1,$2,'{}')`, [bridge, msg]);
    });
    await outbox(infra);
    await outbox(ops);
    const handles = await scratch.query<{ handle: string }>('select handle from public.bridge_handles where entity_id = $1', [bystander]);
    expect(handles).toHaveLength(1);
    const appearances = await scratch.query<{ bridge_id: string }>(
      'select bridge_id::text from public.bridge_handle_appearances where handle = $1 order by bridge_id', [handles[0]!.handle]);
    expect(appearances.map(a => a.bridge_id).sort()).toEqual([infra, ops].sort());
    const again = await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, q =>
      q.rpc<{ handle: string }>('bridge_poster_handle', [infra, bystander]));
    expect(again.handle).toBe(handles[0]!.handle);
    const assigned = await inTx(null, async c =>
      (await c.query<{ h: string }>('select internal.bridge_assign_handle($1,$2,null) h', [spaceId, bystander])).rows[0]!.h);
    expect(assigned).toBe(handles[0]!.handle);
  });
});

describe('who hears a message, and unread (§2.7; §7.3 item 10)', () => {
  let handle = '';
  const audience = (bridge: string, message: string) => scratch.query<{ session_id: string; reason: string }>(
    'select session_id::text, reason from public.bridge_message_audience($1,$2)', [bridge, message]);

  beforeAll(async () => {
    handle = await inTx(null, async c =>
      (await c.query<{ h: string }>('select internal.bridge_assign_handle($1,$2,null) h', [spaceId, s1])).rows[0]!.h);
  });

  it('wakes on @handle, a reply to the session\'s post and its /work thread; not on un-directed chatter', async () => {
    const chatter = await inbound(infra, 'lunch anyone?', 'wamid.chatter');
    expect(await audience(infra, chatter)).toEqual([]);
    const at = await inbound(infra, `@${handle} is the deploy done?`, 'wamid.at');
    expect(await audience(infra, at)).toEqual([{ session_id: s1, reason: 'directed' }]);
    const mine = await inTx(s1, c => post(c, infra, 'Deploy is green', { session: s1 }));
    const reply = await inbound(infra, 'thanks!', 'wamid.reply', mine);
    expect(await audience(infra, reply)).toEqual([{ session_id: s1, reason: 'directed' }]);
    const thread = await inbound(infra, 'and the staging box?', 'wamid.thread', (await scratch.query<{ id: string }>(
      `select o.message_id::text id from public.session_bridge_origins o where o.holder_id = $1 and o.command = '/work'`, [s1]))[0]!.id);
    expect((await audience(infra, thread)).find(a => a.session_id === s1)?.reason).toBe('directed');
  });

  it('wakes a session that listens at all, within the bridge ceiling', async () => {
    await inTx(null, c => c.query(`update public.bridges set worker_wake = 'all' where entity_id = $1`, [infra]));
    await inTx(null, c => c.query(`insert into public.bridge_read_cursors(bridge_id, session_id, wake) values ($1,$2,'all')
      on conflict (bridge_id, session_id) do update set wake = 'all'`, [infra, bystander]));
    const chatter = await inbound(infra, 'weather is nice', 'wamid.chatter2');
    expect(await audience(infra, chatter)).toEqual([{ session_id: bystander, reason: 'all' }]);
  });

  it('counts unread since the cursor, and --unread advances it', async () => {
    const claims = { identityId: ownerIdentity, authKind: 'browser' as const, requestId: randomUUID(), workSessionId: s2 };
    const unread = () => scratch.query<{ n: number }>('select public.bridge_unread_count($1,$2) n', [infra, s2]).then(r => r[0]!.n);
    const before = await unread();
    expect(before).toBeGreaterThan(0);
    const [last] = await scratch.query<{ id: string }>(
      `select entity_id::text id from public.messages where anchor_id = $1 order by created_at desc, entity_id desc limit 1`, [infra]);
    await db.tx(claims, q => q.rpc('advance_bridge_read_cursor', [infra, last!.id]));
    expect(await unread()).toBe(0);
    await inbound(infra, 'one more', 'wamid.more');
    expect(await unread()).toBe(1);
    const facts = await scratch.query<{ f: Record<string, unknown> }>('select public.bridge_origin_facts($1,$2,false) f', [last!.id, s2]);
    expect(facts[0]!.f).toMatchObject({ bridgeId: infra, provider: 'whatsapp', conversation: 'Infra', directed: false, unread: 1 });
  });
});

describe('one answerer per message (§2.7)', () => {
  it('refuses another session\'s reply with not_answerer, lets people and the answerer through, and settles', async () => {
    const asked = await inbound(infra, 'who restarts the box?', 'wamid.ask');
    await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, q =>
      q.rpc('set_bridge_answerer', [asked, s2]));
    const refused = await refusal(inTx(s1, c => post(c, infra, 'I will', { parent: asked, session: s1 })));
    expect(refused.code).toBe('TBC01');
    expect(JSON.parse(refused.detail!)).toMatchObject({ reason: 'not_answerer', answererId: s2 });
    await inTx(null, c => post(c, infra, 'a person may always reply', { parent: asked, author: ownerMember }));
    const answer = await inTx(s2, c => post(c, infra, 'Restarting now', { parent: asked, session: s2 }));
    const [directed] = await scratch.query<{ d: boolean }>('select public.bridge_post_is_directed($1) d', [answer]);
    expect(directed!.d).toBe(true);
    await inTx(s1, c => post(c, infra, 'after the answer, anyone', { parent: asked, session: s1 }));
    const [status] = await scratch.query<{ status: string }>('select status from public.bridge_message_answerers where message_id = $1', [asked]);
    expect(status!.status).toBe('settled');
  });
});
