/**
 * Bridges B1b-2 (migration 398): the runtime doors, inbound, the outbox's hard
 * checks and buckets, delivery badges and the watchdog, at the SQL level.
 *
 * §7.3 item 3 (server side): inbound stored on the log as the bridge with the
 * participant's name; @tm8 starts a turn; the answer is queued signed with the
 * teammate and badged sent. Item 5: the doors admit only a live
 * bridge_runtime session. Item 7: one message for a redelivery. Item 12:
 * allowlists on hello and on change, pause takes a group off, a forged
 * outbox row for an unconnected JID is refused. Item 10's outbox parts.
 * Item 6 / D19: the watchdog. D35: versions only grow.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { bridgesWorkerClaims } from '../../src/bridges/outbox.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID();
const ownerMember = randomUUID(), linkedMember = randomUUID();
const ownerIdentity = `b1b2-owner-${randomUUID()}`, linkedIdentity = `b1b2-linked-${randomUUID()}`;
const ownerAccount = randomUUID();
const teammate = randomUUID();
const chatA = randomUUID(), chatB = randomUUID(), session = randomUUID();
const connection = randomUUID(), otherConnection = randomUUID();
const GROUP = '120363001@g.us', GROUP_B = '120363002@g.us', STRANGER = '999999@g.us';
const RAHUL = '919876543210@s.whatsapp.net', LINKED_JID = '15550001111@s.whatsapp.net';

let infra = '';   // bridge on chatA (GROUP)
let gaming = '';  // bridge on chatB (GROUP_B)
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

interface Refusal { code?: string; details?: Record<string, unknown> }
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (err) { return err as Refusal; }
  throw new Error('expected a refusal');
}

let seq = 0;
function frame(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    connectionId: connection, conversationId: GROUP, externalMessageId: `3EB0${seq.toString().padStart(6, '0')}`,
    sender: { externalId: RAHUL, altId: null, name: 'Rahul', fromMe: false },
    body: 'hello group', kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_000_000 + seq, ...over,
  };
}
interface Inbound { status: string; messageId?: string; routed?: boolean; command?: boolean; reason?: string; copyId?: string | null;
  wakeChat?: { chatId: string; identityId: string } | null }
const inbound = (f: Record<string, unknown>, command = false) => door<Inbound>('bridge_runtime_inbound', JSON.stringify(f), command);

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('bridges_b1b2');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner'),($2,'Linked')`, [ownerIdentity, linkedIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username, is_node_admin) values ($1,$2,'b1b2-owner', true)`, [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Bridges B1b',$2)`, [spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$3,'member',$1),($2,$3,'member',$2)`,
      [ownerMember, linkedMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values
      ($1,$5,$3,'owner','Owner'),($2,$5,$4,'member','Priya')`, [ownerMember, linkedMember, ownerIdentity, linkedIdentity, spaceId]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
      values ($1,$2,'Infra Bot','worker','persona')`, [teammate, ownerMember]);
    for (const [id, title] of [[chatA, 'Infra main'], [chatB, 'Gaming main']] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [id, spaceId, ownerMember]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,$3,$4,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b1b2', gen_random_uuid(), $5, $6, $7)`,
        [id, spaceId, title, teammate, ownerIdentity, ownerMember, `b1b2-${randomUUID()}`]);
    }
    await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`,
      [session, spaceId, ownerMember]);
    await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Deploy fixer','running','none',now())`, [session]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$3,'+91 …9494','linked'),($2,'whatsapp',$3,'+91 …1999','linked')`, [connection, otherConnection, ownerAccount]);
    // Priya's number is linked to her identity (a code link, §2.4).
    await c.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, verified_at)
      values ('whatsapp',$1,$2,'code',now())`, [LINKED_JID, linkedIdentity]);
  });
  const create = (conv: string, target: string) => human(q => q.rpc<{ entity: { id: string } }>('create_bridge', [
    spaceId, connection, conv, JSON.stringify({ kind: 'group', title: conv === GROUP ? 'Infra' : 'Gaming', memberCount: 5 }),
    target, '{}', teammate, null, null, true, null, null, randomUUID(),
  ]));
  infra = (await create(GROUP, chatA)).entity.id;
  gaming = (await create(GROUP_B, chatB)).entity.id;
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

describe('the bridge_runtime session (§2.5, ac8)', () => {
  it('the node mints one: no persona, no work session, no space pin; an agent credential cannot', async () => {
    const hash = createHash('sha256').update(randomUUID()).digest('hex');
    const row = await db.rpc<{ id: string; kind: string; space_id: string | null; acting_as_team_member_id: string | null }>(
      { identityId: ownerIdentity, nodeAdmin: true, requestId: randomUUID() },
      'issue_bridge_runtime_session', [hash, new Date(Date.now() + 86_400_000).toISOString(), 'whatsapp-runtime']);
    expect(row).toMatchObject({ kind: 'bridge_runtime', space_id: null, acting_as_team_member_id: null });
    runtimeSession = row.id;
    const agent = await refusal(db.rpc({ identityId: ownerIdentity, nodeAdmin: true, authKind: 'agent', requestId: randomUUID() },
      'issue_bridge_runtime_session', [createHash('sha256').update('x').digest('hex'), new Date(Date.now() + 60_000).toISOString(), 'x']));
    expect(agent.code).toBe('forbidden');
    const plain = await refusal(db.rpc({ identityId: linkedIdentity, requestId: randomUUID() },
      'issue_bridge_runtime_session', [createHash('sha256').update('y').digest('hex'), new Date(Date.now() + 60_000).toISOString(), 'x']));
    expect(plain.code).toBe('forbidden');
  });

  it('every door refuses every other auth kind, and a bridge_runtime claim without a live row (ac2)', async () => {
    for (const authKind of ['browser', 'cli', 'agent', 'agent_runtime'] as const) {
      const e = await refusal(db.rpc({ identityId: ownerIdentity, authKind, requestId: randomUUID() },
        'bridge_runtime_inbound', [JSON.stringify(frame()), false]));
      expect(e.code).toBe('forbidden');
      expect(e.details?.['reason']).toBe('bridge_runtime_only');
    }
    const forged = await refusal(db.rpc({ identityId: ownerIdentity, authKind: 'bridge_runtime', authSessionId: randomUUID(),
      requestId: randomUUID() }, 'bridge_runtime_hello', [JSON.stringify({ provider: 'whatsapp', runtimeId: 'r', version: 1 })]));
    expect(forged.details?.['reason']).toBe('bridge_runtime_only');
    // The worker doors are not the runtime's either.
    const notWorker = await refusal(db.rpc(runtime(), 'internal.bridge_outbox_take', [['r'], 10]));
    expect(notWorker.details?.['reason']).toBe('bridges_worker_only');
  });
});

describe('shared functions keep their existing arms (398 replaces validate_message)', () => {
  const insertMessage = (author: string, anchor = infra) => scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    const id = randomUUID();
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [id, spaceId, ownerMember]);
    await c.query(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,'x')`, [id, anchor, author]);
    return id;
  });
  it('members and teammates still author; a bridge of the space now may; any other kind is still refused', async () => {
    expect(await insertMessage(ownerMember)).toBeTruthy();
    expect(await insertMessage(teammate)).toBeTruthy();
    expect(await insertMessage(infra)).toBeTruthy();
    await expect(insertMessage(chatA)).rejects.toMatchObject({ code: '23514' });
    await expect(insertMessage(session)).rejects.toMatchObject({ code: '23514' });
  });
});

describe('internal.bridge_signed is VOLATILE: a worker signature writes through bridge_poster_handle', () => {
  it('is marked volatile, and every row of one statement gets its own handle write', async () => {
    const [p] = await owner<{ v: string }>(`select provolatile as v from pg_proc where oid = 'internal.bridge_signed(public.bridges,uuid,uuid,text,text)'::regprocedure`);
    expect(p!.v).toBe('v');
    // A stand-in for B1b-3's door where it is absent: it writes, as the real one does.
    await owner(`create table if not exists public.b1b2_handle_writes(n serial primary key, session uuid)`);
    const real = (await owner<{ r: string | null }>(`select to_regprocedure('public.bridge_poster_handle(uuid,uuid)')::text as r`))[0]!.r;
    if (!real) {
      await owner(`create function public.bridge_poster_handle(p_bridge uuid, p_session uuid) returns jsonb language plpgsql volatile as $f$
        begin insert into public.b1b2_handle_writes(session) values (p_session);
              return jsonb_build_object('handle', 'keen-otter', 'title', 'Deploy fixer'); end $f$`);
    }
    const rows = await owner<{ s: string }>(`select internal.bridge_signed(b, $2, $3, 'worker', 'hi ' || g) as s
      from public.bridges b, generate_series(1, 3) g where b.entity_id = $1 order by g`, [infra, teammate, session]);
    expect(rows.map(r => r.s)).toEqual(['hi 1', 'hi 2', 'hi 3'].map(t => expect.stringMatching(new RegExp(`\\): ${t}$`))));
    if (!real) {
      expect(rows[0]!.s).toBe('Deploy fixer (keen-otter): hi 1');
      const [n] = await owner<{ n: number }>(`select count(*)::int as n from public.b1b2_handle_writes`);
      expect(n!.n).toBe(3);
      await owner(`drop function public.bridge_poster_handle(uuid, uuid)`);
    }
  });
});

describe('402 (B1b-8): review fixes N1 and N3 on 398', () => {
  it('N1: a routed message hands add_bridge_origin the participant display STRING (D22)', async () => {
    const real = (await owner<{ r: string | null }>(`select to_regprocedure('public.add_bridge_origin(uuid,jsonb)')::text as r`))[0]!.r;
    if (real) return;   // B1b-3's real door is covered by its own suite
    await owner(`create table if not exists public.b1b8_origins(holder uuid, origin jsonb)`);
    await owner(`create function public.add_bridge_origin(p_holder uuid, p_origin jsonb) returns jsonb language plpgsql volatile as $f$
      begin insert into public.b1b8_origins values (p_holder, p_origin); return p_origin; end $f$`);
    try {
      const r = await inbound(frame({ body: '@tm8 origin please', sender: { externalId: LINKED_JID, altId: null, name: 'Priya', fromMe: false } }));
      expect(r.routed).toBe(true);
      const [row] = await owner<{ holder: string; origin: { sender: { participant: unknown }; providerMessageId: string } }>(
        `select holder, origin from public.b1b8_origins order by ctid desc limit 1`);
      expect(row!.holder).toBe(chatA);
      expect(row!.origin.sender.participant).toBe('Priya');
    } finally {
      await owner(`drop function public.add_bridge_origin(uuid, jsonb)`);
    }
  });

  it('N3: an admins-only fallback to direction in bumps the bridge entity version', async () => {
    const before = (await owner<{ version: number }>('select version from public.entities where id = $1', [gaming]))[0]!.version;
    await door('bridge_runtime_conversation_state', JSON.stringify({ connectionId: connection, conversationId: GROUP_B, canSend: false, reason: 'admins_only' }));
    const [after] = await owner<{ version: number; dir: string }>(`select e.version, b.policy ->> 'direction' as dir
      from public.entities e join public.bridges b on b.entity_id = e.id where e.id = $1`, [gaming]);
    expect(after).toMatchObject({ dir: 'in' });
    expect(after!.version).toBeGreaterThan(before);
    await owner(`update public.bridges set policy = policy || '{"direction":"both"}' where entity_id = $1`, [gaming]);
  });
});

describe('402 (B1b-8): reactions and poll votes are stored (D39)', () => {
  it('a reaction is one per (message, sender): stored, replaced by a later one, removed by an empty emoji', async () => {
    const m = await inbound(frame({ body: 'react to me' }));
    // The reaction names the provider id of the message it is about.
    const [o] = await owner<{ ext: string }>('select external_message_id as ext from public.message_origins where message_id = $1', [m.messageId]);
    const send = (emoji: string, ts: number) => inbound(frame({ body: '', kind: 'other', ts, reaction: { externalMessageId: o!.ext, emoji } }));
    expect(await send('👍', 1_790_100_000)).toMatchObject({ status: 'stored', kind: 'reaction', messageId: m.messageId });
    expect(await send('❤️', 1_790_100_010)).toMatchObject({ status: 'stored' });
    await send('😂', 1_790_100_005);   // older than the stored one: ignored
    const rows = await owner<{ emoji: string; author_id: string }>('select emoji, author_id from public.bridge_reactions where message_id = $1', [m.messageId]);
    expect(rows).toEqual([{ emoji: '❤️', author_id: infra }]);
    // No message was stored for any of them.
    const [n] = await owner<{ n: number }>(`select count(*)::int as n from public.messages where body = '' or body = '[message]'`);
    expect(n!.n).toBe(0);
    expect(await send('', 1_790_100_020)).toMatchObject({ removed: true });
    expect(await owner('select 1 from public.bridge_reactions where message_id = $1', [m.messageId])).toEqual([]);
    expect(await inbound(frame({ body: '', kind: 'other', reaction: { externalMessageId: 'NOPE', emoji: '👍' } })))
      .toMatchObject({ status: 'ignored', reason: 'reaction_target_unknown' });
  });

  it('a vote on our poll is stored per voter, opened or sealed; the sealed payload never reaches the app role', async () => {
    const poll = randomUUID();
    await scratch.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [poll, spaceId, infra]);
      await c.query(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$2,'Lunch? Yes/No')`, [poll, infra]);
      await c.query(`insert into public.message_origins(message_id, bridge_id, connection_id, direction, external_message_id, external_conversation_id)
        values ($1,$2,$3,'out','POLL0001',$4)`, [poll, infra, connection, GROUP]);
    });
    const opened = await inbound(frame({ body: '', kind: 'poll', pollVote: { pollMessageId: 'POLL0001', voterIds: [RAHUL], selectedHashes: ['aGFzaA'] } }));
    expect(opened).toMatchObject({ status: 'stored', kind: 'poll_vote', messageId: poll, votes: 1 });
    const sealed = await inbound(frame({ body: '', kind: 'poll', sender: { externalId: LINKED_JID, altId: null, name: 'Priya', fromMe: false },
      pollVote: { pollMessageId: 'POLL0001', voterIds: [LINKED_JID], sealed: { encPayload: 'cGF5', encIv: 'aXY' } } }));
    expect(sealed).toMatchObject({ status: 'stored', votes: 1 });
    const votes = await owner<{ voter_external_id: string; author_id: string; selected_hashes: string[] | null; sealed: unknown }>(
      'select voter_external_id, author_id, selected_hashes, sealed from public.bridge_poll_votes where poll_message_id = $1 order by voter_external_id', [poll]);
    expect(votes).toEqual([
      { voter_external_id: LINKED_JID, author_id: linkedMember, selected_hashes: null, sealed: { encPayload: 'cGF5', encIv: 'aXY' } },
      { voter_external_id: RAHUL, author_id: infra, selected_hashes: ['aGFzaA'], sealed: null },
    ]);
    const leak = await refusal(human(q => q.query('select sealed from public.bridge_poll_votes limit 1')));
    expect(leak.code).toBeDefined();
    expect(await inbound(frame({ body: '', kind: 'poll', pollVote: { pollMessageId: 'NOPOLL', voterIds: [RAHUL], selectedHashes: ['x'] } })))
      .toMatchObject({ status: 'ignored', reason: 'poll_unknown' });
  });
});

describe('allowlists (§2.3, D28, D35, ac4, ac7)', () => {
  let lastVersion = 0;
  it('hello answers each connection with its live, unpaused conversations and a fresh version', async () => {
    const reply = await door<{ connections: { connectionId: string; allowlist: { version: number; conversationIds: string[] } }[] }>(
      'bridge_runtime_hello', JSON.stringify({ provider: 'whatsapp', version: 1, runtimeId: 'wa-test', capabilities: {} }));
    const mine = reply.connections.find(c => c.connectionId === connection)!;
    expect(mine.allowlist.conversationIds).toEqual([GROUP, GROUP_B].sort());
    expect(mine.allowlist).toMatchObject({ type: 'allowlist', connectionId: connection });
    lastVersion = mine.allowlist.version;
    const again = await door<{ connections: { connectionId: string; allowlist: { version: number } }[] }>(
      'bridge_runtime_hello', JSON.stringify({ provider: 'whatsapp', version: 1, runtimeId: 'wa-test', capabilities: {} }));
    const v2 = again.connections.find(c => c.connectionId === connection)!.allowlist.version;
    expect(v2).toBeGreaterThan(lastVersion);
    lastVersion = v2;
  });

  it('pausing a bridge marks its connection; the push drops the group with a higher version; resume brings it back', async () => {
    expect(await worker<unknown[]>('internal.bridge_allowlists_due', [['wa-test']])).toEqual([]);
    const [v] = await owner<{ version: number }>('select version from public.entities where id = $1', [gaming]);
    await human(q => q.rpc('pause_bridge', [gaming, v!.version, null, randomUUID()]));
    const due = await worker<{ runtimeId: string; frame: { version: number; conversationIds: string[] } }[]>(
      'internal.bridge_allowlists_due', [['wa-test']]);
    expect(due).toHaveLength(1);
    expect(due[0]!.runtimeId).toBe('wa-test');
    expect(due[0]!.frame.conversationIds).toEqual([GROUP]);
    expect(due[0]!.frame.version).toBeGreaterThan(lastVersion);
    lastVersion = due[0]!.frame.version;
    // A paused group's message is a runtime fault, refused and re-pushed.
    const off = await inbound(frame({ conversationId: GROUP_B }));
    expect(off).toMatchObject({ status: 'refused', reason: 'not_on_allowlist' });
    const [w] = await owner<{ version: number }>('select version from public.entities where id = $1', [gaming]);
    await human(q => q.rpc('resume_bridge', [gaming, w!.version, null, randomUUID()]));
    const back = await worker<{ frame: { version: number; conversationIds: string[] } }[]>('internal.bridge_allowlists_due', [['wa-test']]);
    expect(back[0]!.frame.conversationIds).toEqual([GROUP, GROUP_B].sort());
    expect(back[0]!.frame.version).toBeGreaterThan(lastVersion);
  });

  it('a message from a conversation no bridge connects is refused, never stored', async () => {
    const before = await owner<{ n: number }>('select count(*)::int as n from public.message_origins');
    expect(await inbound(frame({ conversationId: STRANGER }))).toMatchObject({ status: 'refused', reason: 'not_on_allowlist' });
    const after = await owner<{ n: number }>('select count(*)::int as n from public.message_origins');
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('a heartbeat reporting an older version marks the connection for a re-push', async () => {
    await owner('update public.bridge_connections set allowlist_dirty = false where id = $1', [connection]);
    await door('bridge_runtime_heartbeat', JSON.stringify({ runtimeId: 'wa-test', at: new Date().toISOString(),
      connections: [{ connectionId: connection, status: 'linked', dropped: { stanzas: 3, messages: 1, outboundRefused: 0 }, allowlistVersion: 1 }] }));
    const [c] = await owner<{ allowlist_dirty: boolean; runtime_counters: unknown }>(
      'select allowlist_dirty, runtime_counters from public.bridge_connections where id = $1', [connection]);
    expect(c).toMatchObject({ allowlist_dirty: true, runtime_counters: { stanzas: 3, messages: 1, outboundRefused: 0 } });
    await worker('internal.bridge_allowlists_due', [['wa-test']]);
  });
});

describe('inbound (§2.3, D14, D20, ac1, ac3)', () => {
  it('stores every message on the log anchor as the bridge with the participant name, un-routed without @tm8', async () => {
    const r = await inbound(frame({ body: 'just chatting' }));
    expect(r).toMatchObject({ status: 'stored', routed: false, command: false });
    const [m] = await owner<{ anchor_id: string; author_id: string; body: string }>(
      'select anchor_id, author_id, body from public.messages where entity_id = $1', [r.messageId]);
    expect(m).toEqual({ anchor_id: infra, author_id: infra, body: 'just chatting' });
    const [o] = await owner<{ direction: string; sender_display: string; external_sender_id: string; external_ts: Date }>(
      'select direction, sender_display, external_sender_id, external_ts from public.message_origins where message_id = $1', [r.messageId]);
    expect(o).toMatchObject({ direction: 'in', sender_display: 'Rahul', external_sender_id: RAHUL });
    expect(o!.external_ts.getUTCFullYear()).toBe(2026);   // ts is epoch seconds
    const [p] = await owner<{ display_name: string; message_count: number }>(
      'select display_name, message_count from public.bridge_participants where bridge_id = $1 and external_id = $2', [infra, RAHUL]);
    expect(p!.display_name).toBe('Rahul');
  });

  it('the same message delivered twice stores one message (ac3)', async () => {
    const f = frame({ body: 'twice' });
    const first = await inbound(f);
    const second = await inbound(f);
    expect(second).toMatchObject({ status: 'duplicate', messageId: first.messageId });
    const rows = await owner<{ n: number }>(`select count(*)::int as n from public.message_origins
      where bridge_id = $1 and external_message_id = $2`, [infra, f.externalMessageId]);
    expect(rows[0]!.n).toBe(1);
    const copies = await owner<{ n: number }>(`select count(*)::int as n from public.messages where message_batch_id = $1`,
      [`bridge-in:${infra}:${f.externalMessageId}`]);
    expect(copies[0]!.n).toBe(1);
  });

  it('dedupe is per bridge, from any number: another connection carrying the same id stores once on its own bridge', async () => {
    // A second member's number connects the Gaming group in this space? D20 refuses that; so the second
    // connection here carries a different bridge, and each bridge holds the message exactly once.
    const other = await human(q => q.rpc<{ entity: { id: string } }>('create_bridge', [
      spaceId, otherConnection, '120363003@g.us', JSON.stringify({ kind: 'group', title: 'Ops', memberCount: 3 }),
      session, '{}', teammate, null, null, true, null, null, randomUUID()]));
    const f = frame({ connectionId: otherConnection, conversationId: '120363003@g.us', body: 'via number two' });
    expect((await inbound(f)).status).toBe('stored');
    expect((await inbound(f)).status).toBe('duplicate');
    const n = await owner<{ n: number }>(`select count(*)::int as n from public.message_origins where external_message_id = $1`,
      [f.externalMessageId]);
    expect(n[0]!.n).toBe(1);
    expect(other.entity.id).toBeTruthy();
  });

  it('@tm8 from a guest does not start a turn while whoMayTrigger is linked; a linked member does', async () => {
    const guest = await inbound(frame({ body: '@tm8 is the deploy done?' }));
    expect(guest.routed).toBe(false);
    const linked = await inbound(frame({ body: '@tm8 is the deploy done?', sender: { externalId: LINKED_JID, altId: null, name: 'Priya', fromMe: false } }));
    expect(linked).toMatchObject({ status: 'stored', routed: true, wakeChat: { chatId: chatA, identityId: ownerIdentity } });
    const [m] = await owner<{ author_id: string }>('select author_id from public.messages where entity_id = $1', [linked.messageId]);
    expect(m!.author_id).toBe(linkedMember);
    const [turn] = await owner<{ chat_id: string; state: string; requested_by_member_id: string }>(
      'select chat_id, state, requested_by_member_id from public.chat_turns where user_message_id = $1', [linked.copyId]);
    expect(turn).toEqual({ chat_id: chatA, state: 'queued', requested_by_member_id: linkedMember });
  });

  it('with whoMayTrigger anyone, a guest @tm8 starts a turn on the chat (ac1)', async () => {
    await owner(`update public.bridges set policy = policy || '{"whoMayTrigger":"anyone"}' where entity_id = $1`, [infra]);
    const r = await inbound(frame({ body: '@tm8 status?' }));
    expect(r).toMatchObject({ routed: true });
    const [copy] = await owner<{ anchor_id: string; author_id: string; message_batch_id: string }>(
      'select anchor_id, author_id, message_batch_id from public.messages where entity_id = $1', [r.copyId]);
    expect(copy).toMatchObject({ anchor_id: chatA, author_id: infra });
    const mention = await inbound(frame({ body: 'ping', mentions: [] }));
    expect(mention.routed).toBe(false);
  });

  it('a command is stored pending and never routed', async () => {
    const r = await inbound(frame({ body: '@tm8 /work fix it' }), true);
    expect(r).toMatchObject({ status: 'stored', command: true, routed: false });
    const [o] = await owner<{ command_state: string }>('select command_state from public.message_origins where message_id = $1', [r.messageId]);
    expect(o!.command_state).toBe('pending');
    const turns = await owner<{ n: number }>(`select count(*)::int as n from public.messages where message_batch_id =
      (select message_batch_id from public.messages where entity_id = $1)`, [r.messageId]);
    expect(turns[0]!.n).toBe(1);
    // The executor's state machine (B1b-4 claims and settles under the worker claim).
    expect(await worker<boolean>('internal.bridge_command_claim', [r.messageId])).toBe(true);
    expect(await worker<boolean>('internal.bridge_command_claim', [r.messageId])).toBe(false);
    await worker('internal.bridge_command_settle', [r.messageId, 'done']);
    expect(await worker<boolean>('internal.bridge_command_claim', [r.messageId])).toBe(false);
    const notWorker = await refusal(db.rpc({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() },
      'internal.bridge_command_claim', [r.messageId]));
    expect(notWorker.details?.['reason']).toBe('bridges_worker_only');
  });
});

describe('402 (B1b-8): delivery to sessions (§2.2, D30)', () => {
  it('a session target gets the routed copy, routed once, with the reply route recorded', async () => {
    // The 'Ops' bridge on the second number targets a work session (created above).
    const r = await inbound(frame({ connectionId: otherConnection, conversationId: '120363003@g.us', body: '@tm8 restart the job',
      sender: { externalId: LINKED_JID, altId: null, name: 'Priya', fromMe: false } }));
    expect(r).toMatchObject({ status: 'stored', routed: true });
    const [copy] = await owner<{ entity_id: string }>(`select entity_id from public.messages
      where message_batch_id = (select message_batch_id from public.messages where entity_id = $1) and anchor_id = $2`, [r.messageId, session]);
    expect(copy).toBeDefined();
    const routes = await worker<Record<string, unknown>[]>('internal.bridge_inbound_deliveries', [r.messageId]);
    expect(routes).toEqual([expect.objectContaining({
      targetMessageId: copy!.entity_id, targetWorkSessionId: session, sourceAnchorId: session, sourceAnchorKind: 'work_session',
      body: '@tm8 restart the job', senderActorId: linkedMember, addressingKind: 'anchored_message', sessionInputAllowed: true,
    })]);
    expect(await worker('internal.bridge_inbound_deliveries', [r.messageId])).toEqual([]);
    const reply = await scratch.query(`select 1 from public.session_message_reply_routes where target_message_id = $1 and target_work_session_id = $2`,
      [copy!.entity_id, session]);
    expect(reply).toHaveLength(1);
  });

  it('a command and an un-routed message owe no route', async () => {
    const cmd = await inbound(frame({ connectionId: otherConnection, conversationId: '120363003@g.us', body: '/status' }), true);
    expect(await worker('internal.bridge_inbound_deliveries', [cmd.messageId])).toEqual([]);
    const chatter = await inbound(frame({ connectionId: otherConnection, conversationId: '120363003@g.us', body: 'just chatting' }));
    expect(chatter.routed).toBe(false);
    expect(await worker('internal.bridge_inbound_deliveries', [chatter.messageId])).toEqual([]);
  });
});

describe('the outbox (§2.3, §2.7, ac1, ac4, ac5)', () => {
  let answer = '';
  it("a chat turn's answer is queued signed with the teammate, quoting the routed message, and badged sent on settle (ac1)", async () => {
    const r = await inbound(frame({ body: '@tm8 deploy status?' }));
    const [turn] = await owner<{ turn_id: string }>('select turn_id from public.chat_turns where user_message_id = $1', [r.copyId]);
    answer = randomUUID();
    await scratch.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [answer, spaceId, teammate]);
      await c.query(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,'Deployed at 10:40.')`, [answer, chatA, teammate]);
      await c.query(`update public.chat_turns set state = 'completed', agent_message_id = $2, completed_at = now() where turn_id = $1`,
        [turn!.turn_id, answer]);
    });
    const [ob] = await owner<{ id: string; status: string; poster: string; directed: boolean; payload: { text: string; replyTo: Record<string, unknown> } }>(
      'select id, status, poster, directed, payload from public.bridge_outbox where message_id = $1', [answer]);
    expect(ob).toMatchObject({ status: 'pending', poster: 'chat', directed: true });
    expect(ob!.payload.text).toBe('Infra Bot: Deployed at 10:40.');
    expect(ob!.payload.replyTo).toMatchObject({ fromMe: false, text: '@tm8 deploy status?', senderExternalId: RAHUL });

    const frames = await worker<{ runtimeId: string; frame: Record<string, unknown> }[]>('internal.bridge_outbox_take', [['wa-test'], 10]);
    const mine = frames.find(f => f.frame['outboxId'] === ob!.id)!;
    expect(mine.frame).toMatchObject({ type: 'send', connectionId: connection, conversationId: GROUP, text: 'Infra Bot: Deployed at 10:40.' });
    const updates = async (id: string) => (await owner<{ n: number }>(`select count(*)::int as n from public.workspace_events
      where event_type = 'message.updated' and subject_ids @> array[$1::uuid]`, [id]))[0]!.n;
    const before = await updates(answer);
    await door('bridge_runtime_sent', JSON.stringify({ outboxId: ob!.id, connectionId: connection, externalMessageId: 'BAE5OUT1',
      message: { conversation: 'Infra Bot: Deployed at 10:40.' } }));
    // ac11: the settle reached readers as an event on the message (254 drops a bare entities touch).
    const after = await updates(answer);
    expect(after).toBeGreaterThan(before);
    const badge = await human(q => q.rpc<{ messageId: string; status: string; externalMessageId: string }[]>(
      'internal.bridge_message_delivery', [[answer]]));
    expect(badge).toEqual([expect.objectContaining({ messageId: answer, status: 'sent', externalMessageId: 'BAE5OUT1' })]);
    const [out] = await owner<{ direction: string; provider_payload: unknown }>(
      'select direction, provider_payload from public.message_origins where message_id = $1', [answer]);
    expect(out).toMatchObject({ direction: 'out', provider_payload: { conversation: 'Infra Bot: Deployed at 10:40.' } });
    // provider_payload never reaches the app role.
    const leak = await refusal(human(q => q.query('select provider_payload from public.message_origins limit 1')));
    expect(leak.code).toBeDefined();
  });

  it('a reply to our own message quotes it with the stored payload and triggers @tm8-less (reply to us)', async () => {
    const r = await inbound(frame({ body: 'thanks, and the db?', replyTo: { externalMessageId: 'BAE5OUT1', senderExternalId: null, media: null } }));
    expect(r.routed).toBe(true);
  });

  const enqueue = (bridge: string, poster: string, directed = false, over: Record<string, unknown> = {}) =>
    scratch.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      const msg = randomUUID();
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [msg, spaceId, teammate]);
      await c.query(`insert into public.messages(entity_id, anchor_id, author_id, body, message_batch_id) values ($1,$2,$3,'worker post',$4)`,
        [msg, bridge, teammate, `test:${msg}`]);
      // Decided directly, not by the deferred rule: these tests pin the checks themselves.
      await c.query(`insert into public.bridge_delivery_refusals(message_id, bridge_id, reason) values ($1,$2,'bridge_paused')`, [msg, bridge]);
      await c.query(`delete from public.bridge_delivery_refusals where message_id = $1`, [msg]);
      const { rows } = await c.query(`select internal.bridge_outbox_enqueue($1,$2,'send','{"text":"x"}'::jsonb,$3::jsonb) as r`,
        [bridge, msg, JSON.stringify({ poster, teammateId: teammate, sessionId: session, directed, ...over })]);
      return rows[0].r as { status: string; reason?: string; retryAfterMs?: number };
    });

  it('the 7th un-directed post from one teammate in 10 minutes is refused rate_limited with retryAfterMs (ac5)', async () => {
    await owner(`delete from public.bridge_outbox where bridge_id = $1`, [gaming]);
    for (let i = 0; i < 6; i++) expect((await enqueue(gaming, 'worker')).status).toBe('pending');
    const seventh = await enqueue(gaming, 'worker');
    expect(seventh).toMatchObject({ status: 'refused', reason: 'rate_limited' });
    expect(seventh.retryAfterMs).toBeGreaterThan(9 * 60_000);
    // A directed reply still has room under the 20/min (teammate, bridge) bucket.
    expect((await enqueue(gaming, 'worker', true)).status).toBe('pending');
  });

  it('the per-conversation cap (30/min) and the per-number cap (60/min) refuse rate_limited', async () => {
    await owner(`delete from public.bridge_outbox where bridge_id in ($1, $2)`, [gaming, infra]);
    for (let i = 0; i < 30; i++) expect((await enqueue(gaming, 'member')).status).toBe('pending');
    expect(await enqueue(gaming, 'member')).toMatchObject({ status: 'refused', reason: 'rate_limited' });
    for (let i = 0; i < 30; i++) expect((await enqueue(infra, 'member')).status).toBe('pending');
    const perNumber = await enqueue(infra, 'member');
    expect(perNumber).toMatchObject({ status: 'refused', reason: 'rate_limited' });
    const [n] = await owner<{ n: number }>(`select count(*)::int as n from public.bridge_outbox where connection_id = $1
      and created_at > now() - interval '1 minute'`, [connection]);
    expect(n!.n).toBe(60);
    await owner(`delete from public.bridge_outbox where bridge_id in ($1, $2)`, [gaming, infra]);
  });

  it('refuses bridge_paused, direction_in, worker_posting_off, and a muted bridge as paused (ac5)', async () => {
    await owner(`update public.bridges set worker_posting = false where entity_id = $1`, [gaming]);
    expect(await enqueue(gaming, 'worker')).toMatchObject({ status: 'refused', reason: 'worker_posting_off' });
    expect((await enqueue(gaming, 'member')).status).toBe('pending');
    await owner(`update public.bridges set worker_posting = true, policy = policy || '{"direction":"in"}' where entity_id = $1`, [gaming]);
    expect(await enqueue(gaming, 'member')).toMatchObject({ status: 'refused', reason: 'direction_in' });
    await owner(`update public.bridges set policy = policy || '{"direction":"both"}', muted_until = now() + interval '1 hour' where entity_id = $1`, [gaming]);
    expect(await enqueue(gaming, 'member')).toMatchObject({ status: 'refused', reason: 'bridge_paused' });
    await owner(`update public.bridges set muted_until = null, paused_at = now() where entity_id = $1`, [gaming]);
    const paused = await enqueue(gaming, 'worker');
    expect(paused).toMatchObject({ status: 'refused', reason: 'bridge_paused' });
    await owner(`update public.bridges set paused_at = null where entity_id = $1`, [gaming]);
  });

  it('a row forged for a conversation off the allowlist is refused at dispatch (ac4)', async () => {
    await owner(`delete from public.bridge_outbox where bridge_id = $1`, [gaming]);
    const ok = await enqueue(gaming, 'member');
    expect(ok.status).toBe('pending');
    await owner(`update public.bridge_outbox set external_conversation_id = $2 where bridge_id = $1`, [gaming, STRANGER]);
    await owner(`update public.bridges set paused_at = now() where entity_id = $1`, [gaming]);
    const frames = await worker<{ frame: Record<string, unknown> }[]>('internal.bridge_outbox_take', [['wa-test'], 50]);
    expect(frames.filter(f => f.frame['conversationId'] === STRANGER || f.frame['conversationId'] === GROUP_B)).toEqual([]);
    const [row] = await owner<{ status: string; last_error: string }>('select status, last_error from public.bridge_outbox where bridge_id = $1', [gaming]);
    expect(row).toEqual({ status: 'failed_permanent', last_error: 'bridge_paused' });
    await owner(`update public.bridges set paused_at = null where entity_id = $1`, [gaming]);
    // And the frame names the bridge's own conversation, never the row's: a forged JID cannot be addressed.
    const again = await enqueue(gaming, 'member');
    await owner(`update public.bridge_outbox set external_conversation_id = $2 where id = $1`, [(again as { outboxId?: string }).outboxId, STRANGER]);
    const f2 = await worker<{ frame: Record<string, unknown> }[]>('internal.bridge_outbox_take', [['wa-test'], 50]);
    expect(f2.map(f => f.frame['conversationId'])).not.toContain(STRANGER);
  });

  it('a notice is authored by the bridge, signed tm8:, idempotent on its key', async () => {
    const r = await inbound(frame({ body: '/help' }), true);
    const first = await worker<{ messageId: string; delivery: { status: string } }>('internal.bridge_post_notice',
      [infra, 'Commands: /work, /task', r.messageId, `cmd:${infra}:x`]);
    const second = await worker<{ messageId: string; replayed: boolean }>('internal.bridge_post_notice',
      [infra, 'Commands: /work, /task', r.messageId, `cmd:${infra}:x`]);
    expect(second).toMatchObject({ messageId: first.messageId, replayed: true });
    expect(first.delivery.status).toBe('pending');
    const [m] = await owner<{ author_id: string; anchor_id: string }>('select author_id, anchor_id from public.messages where entity_id = $1', [first.messageId]);
    expect(m).toEqual({ author_id: infra, anchor_id: infra });
    const [ob] = await owner<{ payload: { text: string; replyTo: { text: string } } }>('select payload from public.bridge_outbox where message_id = $1', [first.messageId]);
    expect(ob!.payload.text).toBe('tm8: Commands: /work, /task');
    expect(ob!.payload.replyTo.text).toBe('/help');
  });
});

describe('the watchdog (D19, §7.3 item 6, ac6)', () => {
  it('a silent runtime marks its bridges degraded and raises one fyi; a heartbeat clears it', async () => {
    await owner(`update public.bridge_connections set heartbeat_at = now() - interval '5 minutes', down_since = null where id = $1`, [connection]);
    const tick = await worker<{ runtimeDown: number }>('internal.bridge_watchdog_tick');
    expect(tick.runtimeDown).toBeGreaterThanOrEqual(1);
    const [view] = await human(q => q.query<{ v: { status: string } }>('select internal.bridge_view($1) as v', [infra]));
    expect(view!.v.status).toBe('degraded');
    await worker('internal.bridge_watchdog_tick');
    const open = await owner<{ n: number; level: string }>(`select count(*)::int as n, max(level) as level from public.attention_requests
      where signal_key = $1 and status = 'open'`, [`bridge.runtime_down:${connection}`]);
    expect(open[0]).toEqual({ n: 1, level: 'fyi' });
    await door('bridge_runtime_heartbeat', JSON.stringify({ runtimeId: 'wa-test', at: new Date().toISOString(),
      connections: [{ connectionId: connection, status: 'linked', dropped: { stanzas: 0, messages: 0, outboundRefused: 0 }, allowlistVersion: 999 }] }));
    const back = await worker<{ runtimeBack: number }>('internal.bridge_watchdog_tick');
    expect(back.runtimeBack).toBe(1);
    const still = await owner<{ n: number }>(`select count(*)::int as n from public.attention_requests
      where signal_key = $1 and status = 'open'`, [`bridge.runtime_down:${connection}`]);
    expect(still[0]!.n).toBe(0);
    const [again] = await human(q => q.query<{ v: { status: string } }>('select internal.bridge_view($1) as v', [infra]));
    expect(again!.v.status).toBe('live');
  });

  it('a routed message whose turn failed gets ⚠️ through the outbox and one fyi on its bridge', async () => {
    const r = await inbound(frame({ body: '@tm8 will fail' }));
    await owner(`update public.chat_turns set state = 'error' where user_message_id = $1`, [r.copyId]);
    await worker('internal.bridge_watchdog_tick');
    await worker('internal.bridge_watchdog_tick');
    const reacts = await owner<{ kind: string; payload: { emoji: string } }>(
      `select kind, payload from public.bridge_outbox where message_id = $1 and kind = 'react'`, [r.messageId]);
    expect(reacts).toHaveLength(1);
    expect(reacts[0]!.payload.emoji).toBe('⚠️');
    const open = await owner<{ n: number }>(`select count(*)::int as n from public.attention_requests
      where signal_key = $1 and status = 'open' and level = 'fyi'`, [`bridge.turn_failed:${infra}`]);
    expect(open[0]!.n).toBe(1);
  });
});
