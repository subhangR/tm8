/**
 * Bridges B1b-4 end to end (BRIDGES-V2-DESIGN §8 acceptance, §4.6, §4.8;
 * BRIDGE-ENTITY-DESIGN §7.3 item 11) against a scratch database with every
 * migration applied.
 *
 * Real: the parser, the executor, migration 401's doors, create_task and
 * set_work_state as the linked member, RLS on every member read, the bridge
 * and its identity links. Faked: the PTY host (a spawn inserts the session
 * row), and the outbox (a notice is a stored message plus its out origin, as
 * B1b-2's sent-settle writes it). Doors that belong to B1b-2 and B1b-3
 * (claim/settle and the command columns, the bridges-worker gate, the
 * provenance recorder, the poster handle) are stubbed below ONLY when the
 * applied migrations do not already define them, so this file runs against
 * the real ones once they land.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { bridgesWorkerClaims } from '../../src/bridges/outbox.js';
import { createBridgeCommandExecutor, type BridgeCommandExecutor } from '../../src/bridges/commands/executor.js';
import type { BridgeCommandOrigin, SpawnWorkerRequest } from '../../src/bridges/commands/ports.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

let database: W1ScratchDatabase;
let db: Db;
const space = randomUUID();
const persona = randomUUID(), chat = randomUUID(), connection = randomUUID();

/** Four senders, one per tier the tests need. */
const people = {
  owner: { member: randomUUID(), account: randomUUID(), identity: `b1b4-owner-${randomUUID()}`, role: 'owner', phone: '919000000001@s.whatsapp.net' },
  rahul: { member: randomUUID(), account: randomUUID(), identity: `b1b4-rahul-${randomUUID()}`, role: 'member', phone: '919000000002@s.whatsapp.net' },
  maya: { member: randomUUID(), account: randomUUID(), identity: `b1b4-maya-${randomUUID()}`, role: 'admin', phone: '919000000003@s.whatsapp.net' },
} as const;
const guestPhone = '919000000009@s.whatsapp.net';
let bridgeId = '';

const memberClaims = (identityId: string): DbClaims => ({ identityId, nodeAdmin: false, requestId: `t-${randomUUID()}` });

/** Create `fn` only when the applied migrations have not (the sibling lanes' real doors win). */
const STUBS: Array<[string, string]> = [
  ['internal.is_bridges_worker()', `create function internal.is_bridges_worker() returns boolean language sql stable as $$
     select coalesce(internal.claim_text('tm8.background_job') = 'bridges.runtime', false) $$;
     grant execute on function internal.is_bridges_worker() to tm8_app;`],
  ['internal.is_bridge_runtime()', `create function internal.is_bridge_runtime() returns boolean language sql stable as $$ select false $$;
     grant execute on function internal.is_bridge_runtime() to tm8_app;`],
  ['internal.bridge_command_claim(uuid)', `
     alter table public.message_origins add column if not exists command_state text;
     alter table public.message_origins add column if not exists command_claimed_at timestamptz;
     alter table public.message_origins add column if not exists command_settled_at timestamptz;
     create function internal.bridge_command_claim(p uuid) returns boolean language plpgsql security definer
     set search_path = public, internal, pg_temp as $$
     declare n int;
     begin
       if not internal.is_bridges_worker() then raise exception 'not the bridges worker' using errcode = '42501'; end if;
       update public.message_origins set command_state = 'running', command_claimed_at = now()
        where message_id = p and (command_state = 'pending'
          or (command_state = 'running' and command_claimed_at < now() - interval '2 minutes'));
       get diagnostics n = row_count; return n = 1;
     end $$;
     grant execute on function internal.bridge_command_claim(uuid) to tm8_app;`],
  ['internal.bridge_command_settle(uuid,text)', `create function internal.bridge_command_settle(p uuid, o text) returns void language plpgsql security definer
     set search_path = public, internal, pg_temp as $$
     begin
       if not internal.is_bridges_worker() then raise exception 'not the bridges worker' using errcode = '42501'; end if;
       update public.message_origins set command_state = o, command_settled_at = now() where message_id = p;
     end $$;
     grant execute on function internal.bridge_command_settle(uuid, text) to tm8_app;`],
  // D31's shape: one edge per (entity, bridge), origins[] appended, deduped on providerMessageId.
  ['public.record_bridge_provenance(uuid,jsonb)', `create function public.record_bridge_provenance(p_entity uuid, p_origins jsonb) returns void
     language plpgsql security definer set search_path = public, internal, pg_temp as $$
     declare o jsonb; e public.entities; existing public.edges;
     begin
       select * into e from public.entities where id = p_entity;
       perform internal.w1_set_writer('entity_recorder');
       for o in select * from jsonb_array_elements(p_origins) loop
         select * into existing from public.edges where src_id = p_entity and dst_id = (o->>'bridgeId')::uuid and type = 'authored_from';
         if existing.id is null then
           insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
           values (e.space_id, p_entity, (o->>'bridgeId')::uuid, 'authored_from',
                   jsonb_build_object('bridgeId', o->>'bridgeId', 'origins', jsonb_build_array(o || '{"inherited":false,"depth":0}'::jsonb)), e.created_by);
         elsif not exists (select 1 from jsonb_array_elements(existing.props->'origins') x where x->>'providerMessageId' = o->>'providerMessageId') then
           update public.edges set props = jsonb_set(props, '{origins}', (props->'origins') || jsonb_build_array(o)) where id = existing.id;
         end if;
       end loop;
       perform internal.w1_set_writer(null);
     end $$;
     grant execute on function public.record_bridge_provenance(uuid, jsonb) to tm8_app;`],
  ['public.bridge_set_mute(uuid,timestamptz)', `
     alter table public.bridges add column if not exists muted_until timestamptz;
     create function public.bridge_set_mute(p_bridge uuid, p_until timestamptz) returns jsonb
     language plpgsql security definer set search_path = public, internal, pg_temp as $$
     begin
       perform internal.require_space_admin((select space_id from public.bridges where entity_id = p_bridge));
       update public.bridges set muted_until = p_until where entity_id = p_bridge;
       return jsonb_build_object('mutedUntil', p_until);
     end $$;
     grant execute on function public.bridge_set_mute(uuid, timestamptz) to tm8_app;`],
  ['public.bridge_poster_handle(uuid,uuid)', `create function public.bridge_poster_handle(p_bridge uuid, p_session uuid) returns jsonb
     language plpgsql security definer set search_path = public, internal, pg_temp as $$
     declare s uuid; h public.bridge_handles;
     begin
       select space_id into s from public.bridges where entity_id = p_bridge;
       insert into public.bridge_handles(space_id, handle, entity_id, kind, title)
       values (s, internal.bridge_new_handle(s), p_session, 'work_session',
               left(nullif((select title from public.work_sessions where entity_id = p_session), ''), 80))
       on conflict (space_id, entity_id) do nothing;
       select * into h from public.bridge_handles where space_id = s and entity_id = p_session;
       return jsonb_build_object('handle', h.handle, 'title', h.title);
     end $$;
     grant execute on function public.bridge_poster_handle(uuid, uuid) to tm8_app;`],
];

async function asOwner<T>(fn: (c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }) => Promise<T>): Promise<T> {
  return database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    return fn(c as never);
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('bridge_commands');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    for (const [signature, sql] of STUBS) {
      const { rows } = await c.query('select to_regprocedure($1) is not null as present', [signature]);
      if (!rows[0].present) await c.query(sql);
    }
  });
  await asOwner(async c => {
    const all = Object.values(people);
    for (const p of all) {
      await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [p.identity]);
      await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2)', [p.account, p.identity]);
    }
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Commands fixture',$2)", [space, people.owner.identity]);
    for (const p of all) {
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [p.member, space]);
      await c.query('insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,$4,$3)',
        [p.member, space, p.identity, p.role]);
    }
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$3)", [persona, space, people.owner.member]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Infra','','persona')", [persona, people.owner.member]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'chat',0,$3)", [chat, space, people.owner.member]);
    await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
        chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
      values ($1,$2,'Infra main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b1b4', gen_random_uuid(), $4, $5, $6)`,
      [chat, space, persona, people.owner.identity, people.owner.member, `b1b4-${randomUUID()}`]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …0001','linked')`, [connection, people.owner.account]);
    // Linked by code (identity-scoped): owner and Rahul. Maya is an admin whose
    // number is only ASSERTED (space-scoped), which never counts as admin (§4.6).
    await c.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, verified_at)
      values ('whatsapp',$1,$2,'code',now()),('whatsapp',$3,$4,'code',now())`,
      [people.owner.phone, people.owner.identity, people.rahul.phone, people.rahul.identity]);
    await c.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, space_id, asserted_by_member_id, verified_at)
      values ('whatsapp',$1,$2,'admin',$3,$4,now())`, [people.maya.phone, people.maya.identity, space, people.owner.member]);
  });
  const created = await db.rpc<{ entity: { id: string } }>(
    { identityId: people.owner.identity, nodeAdmin: false, authKind: 'cli', requestId: 'b1b4-create' },
    'create_bridge',
    [space, connection, '120363-infra@g.us', JSON.stringify({ kind: 'group', title: 'Infra', memberCount: null }),
      chat, JSON.stringify({}), persona, null, null, true, null, null, `b1b4-bridge-${randomUUID()}`],
  );
  bridgeId = created.entity.id;
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

// ----------------------------------------------------------------- fakes
interface Notice { messageId: string; externalId: string; text: string; replyToMessageId: string | null; key: string }
let notices: Notice[] = [];
/** Every answer the executor tried to post, before the outbox's idempotency. */
const attempted: Array<{ key: string; text: string }> = [];
let reactions: string[] = [];
let spawns: SpawnWorkerRequest[] = [];
let stops: string[] = [];
const spawned = new Map<string, string>();
let outSeq = 0;
let inSeq = 0;

/**
 * 395's message validator does not yet take the bridge as an author (B1b-2's
 * notices and guest inbound rows do that); here a bridge-authored row is
 * stored as the space owner. Author resolution reads the origin's sender id,
 * never this column.
 */
async function storeMessage(author: string, body: string): Promise<string> {
  const authorId = author === bridgeId ? people.owner.member : author;
  const id = randomUUID();
  await asOwner(async c => {
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'message',0,$3)", [id, space, authorId]);
    await c.query('insert into public.messages(entity_id,anchor_id,author_id,body) values($1,$2,$3,$4)', [id, bridgeId, authorId, body]);
  });
  return id;
}

/** What the PTY host's exit would record (the single writer of work_sessions.status). */
async function endWorkers(sessionId: string | null = null, reason: string | null = null): Promise<void> {
  await asOwner(async c => {
    await c.query("select set_config('tm8.work_session_transition', 'on', true)");
    await c.query(`update public.work_sessions set status = 'exited', ended_reason = coalesce($2, ended_reason),
        exited_at = now(), status_changed_at = now()
      where status in ('spawning','running','idle') and ($1::uuid is null or entity_id = $1)`, [sessionId, reason]);
  });
}

/** One injected fault in the provenance write (a crash inside the task transaction). */
let failNextOrigin = false;

let executor: BridgeCommandExecutor;
function makeExecutor(): BridgeCommandExecutor {
  return createBridgeCommandExecutor({
    db,
    executorClaims: async () => bridgesWorkerClaims(),
    async postNotice(_db, input) {
      attempted.push({ key: input.idempotencyKey, text: input.text });
      const existing = notices.find(n => n.key === input.idempotencyKey);
      if (existing) return { messageId: existing.messageId, delivery: { status: 'pending', outboxId: 'x' } };
      const messageId = await storeMessage(bridgeId, `tm8: ${input.text}`);
      const externalId = `OUT-${++outSeq}`;
      await asOwner(c => c.query(`insert into public.message_origins(message_id, bridge_id, connection_id, direction,
          external_message_id, external_conversation_id) values ($1,$2,$3,'out',$4,'120363-infra@g.us')`,
        [messageId, bridgeId, connection, externalId]));
      notices.push({ messageId, externalId, text: input.text, replyToMessageId: input.replyToMessageId ?? null, key: input.idempotencyKey });
      return { messageId, delivery: { status: 'pending', outboxId: 'x' } };
    },
    async react(_db, input) { reactions.push(input.emoji); return { status: 'pending', outboxId: 'x' }; },
    claim: async id => (await db.rpc<boolean>(bridgesWorkerClaims(), 'internal.bridge_command_claim', [id])) === true,
    settle: async (id, outcome) => { await db.rpc(bridgesWorkerClaims(), 'internal.bridge_command_settle', [id, outcome]); },
    recordOrigin: async (q, entityId, origin: BridgeCommandOrigin) => {
      if (failNextOrigin) { failNextOrigin = false; throw new Error('injected crash'); }
      await q.rpc('record_bridge_provenance', [entityId, JSON.stringify([origin])]);
    },
    async spawnWorker(_claims, request) {
      // The spawn ledger replays a mutation id to the same session.
      const prior = spawned.get(request.clientMutationId);
      if (prior) return { sessionId: prior };
      spawns.push(request);
      const sessionId = randomUUID();
      const creator = (await asOwner(c => c.query(
        'select created_by from public.entities where id = $1', [request.taskId]))).rows[0].created_by;
      await asOwner(async c => {
        await c.query("insert into public.entities(id,space_id,kind,position,created_by,visibility) values($1,$2,'work_session',0,$3,'space')",
          [sessionId, space, creator]);
        await c.query("insert into public.work_sessions(entity_id,title,status,share_mode,started_at) values($1,$2,'running','none',now())",
          [sessionId, request.title]);
        await c.query('select internal.w1_set_writer($1)', ['entity_recorder']);
        await c.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'working_on',$4)",
          [space, sessionId, request.taskId, creator]);
      });
      await database.transaction(c => c.query('select public.record_bridge_provenance($1, $2::jsonb)', [sessionId, JSON.stringify(request.origins)]));
      spawned.set(request.clientMutationId, sessionId);
      return { sessionId };
    },
    async stopWorker(_claims, sessionId, input) {
      stops.push(sessionId);
      await endWorkers(sessionId, input.reason);
    },
    workerHandle: async (claims, bridge, sessionId) =>
      db.rpc<{ handle: string; title: string | null }>(claims, 'bridge_poster_handle', [bridge, sessionId]),
  });
}

/** An inbound command as B1b-2 stores it: the message on the log, its origin, command_state pending. */
async function inbound(sender: string, authorId: string, body: string, replyToExternalId: string | null = null): Promise<string> {
  const messageId = await storeMessage(authorId, body);
  await asOwner(c => c.query(`insert into public.message_origins(message_id, bridge_id, connection_id, direction,
      external_message_id, external_conversation_id, external_sender_id, external_reply_to_id, command_state)
      values ($1,$2,$3,'in',$4,'120363-infra@g.us',$5,$6,'pending')`,
    [messageId, bridgeId, connection, `IN-${++inSeq}-${randomUUID().slice(0, 8)}`, sender, replyToExternalId]));
  return messageId;
}

async function command(who: keyof typeof people | 'guest', body: string, replyTo: string | null = null): Promise<{ messageId: string; reply: Notice | undefined }> {
  const sender = who === 'guest' ? guestPhone : people[who].phone;
  const author = who === 'guest' ? bridgeId : people[who].member;
  const messageId = await inbound(sender, author, body, replyTo);
  await executor.run(messageId);
  return { messageId, reply: notices.find(n => n.replyToMessageId === messageId) };
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await asOwner(c => c.query(sql, params))).rows[0].n);
}

const bridgeTasks = () => count(`select count(*) n from public.edges ed join public.entities e on e.id = ed.src_id
  where ed.type = 'authored_from' and ed.dst_id = $1 and e.kind = 'task'`, [bridgeId]);

beforeEach(() => {
  executor = makeExecutor();
});

// ----------------------------------------------------------------- tests
describe('§8: /work from a linked member (ac1)', () => {
  it('three lines → one parent, three children, three workers with handles, one reply within 2 s', async () => {
    const tasksBefore = await bridgeTasks();
    const started = Date.now();
    const { messageId, reply } = await command('rahul', '/work\nfix the login timeout on mobile\nadd retries to the upload client\nwrite release notes for 1.4.3');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await bridgeTasks()).toBe(tasksBefore + 4);
    expect(spawns).toHaveLength(3);
    // Every spawn carries the origin with command '/work' and the message, as a server fact.
    for (const s of spawns) {
      expect(s.origins).toEqual([expect.objectContaining({ bridgeId, messageId, command: '/work', sender: { memberId: people.rahul.member } })]);
    }
    const children = (await asOwner(c => c.query(`select t.title, e.parent_id, ed.props
        from public.edges ed join public.entities e on e.id = ed.src_id join public.tasks t on t.entity_id = e.id
       where ed.dst_id = $1 and ed.type = 'authored_from' and e.parent_id is not null order by t.title`, [bridgeId]))).rows;
    expect(children.map((r: any) => r.title)).toEqual(['Add retries to the upload client', 'Fix the login timeout on mobile', 'Write release notes for 1.4.3']);
    expect(new Set(children.map((r: any) => r.parent_id)).size).toBe(1);
    expect(children[0].props.origins[0]).toMatchObject({ command: '/work', providerMessageId: expect.any(String) });
    const handles = await count('select count(*) n from public.bridge_handles where space_id = $1', [space]);
    expect(handles).toBeGreaterThanOrEqual(3);
    expect(notices.filter(n => n.replyToMessageId === messageId)).toHaveLength(1);
    expect(reply!.text).toMatch(/^3 workers on it\n1 Fix the login timeout on mobile \([a-z]+-[a-z]+(-\d+)?\) — starting/);
    // Created as the member, not the node.
    const creators = await count(`select count(distinct e.created_by) n from public.edges ed join public.entities e on e.id = ed.src_id
       where ed.dst_id = $1 and ed.type = 'authored_from' and e.kind = 'task' and e.created_by <> $2`, [bridgeId, people.rahul.member]);
    expect(creators).toBe(0);
    const state = (await asOwner(c => c.query('select command_state from public.message_origins where message_id = $1', [messageId]))).rows[0];
    expect(state.command_state).toBe('done');
  });
});

describe('§8: redelivery, refusals, did-you-mean, guests, routing (ac2, ac4)', () => {
  it('redelivering the same message creates nothing new: run() again, and execute() after a crash mid-run', async () => {
    const { messageId } = await command('rahul', '/work alpha; beta');
    const tasks = await bridgeTasks();
    const sessionCount = spawns.length;
    const noticeCount = notices.length;
    await executor.run(messageId); // settled: the claim answers false
    // A crash after the work but before settle: the sweep re-claims and re-runs.
    await asOwner(c => c.query("update public.message_origins set command_state = 'running', command_claimed_at = now() - interval '5 minutes' where message_id = $1", [messageId]));
    executor.reset();
    expect(await executor.sweep()).toBeGreaterThanOrEqual(1);
    expect(await bridgeTasks()).toBe(tasks);
    expect(spawns.length).toBe(sessionCount);
    expect(notices.length).toBe(noticeCount);
  });

  it.each([
    ['/task', '/task write the runbook'],
    ['/stop', '/stop mine'],
  ])('%s run twice is one result (ac4)', async (_verb, body) => {
    const { messageId } = await command('owner', body);
    const tasks = await bridgeTasks();
    const stopCount = stops.length;
    const noticeCount = notices.length;
    await asOwner(c => c.query("update public.message_origins set command_state = 'pending' where message_id = $1", [messageId]));
    executor.reset();
    await executor.run(messageId);
    expect(await bridgeTasks()).toBe(tasks);
    expect(notices.length).toBe(noticeCount);
    if (body.startsWith('/stop')) expect(stops.length).toBe(stopCount);
  });

  it('/stop of another member\'s worker by a non-admin is refused with a reason', async () => {
    await command('owner', '/work owner job');
    const { reply: list } = await command('owner', '/workers');
    const handle = /\(([a-z]+-[a-z]+(?:-\d+)?)\)/.exec(list!.text)![1]!;
    const before = stops.length;
    const { reply } = await command('rahul', `/stop ${handle}`);
    expect(reply!.text).toMatch(/isn't yours — only its starter or a space admin can stop it/);
    expect(stops.length).toBe(before);
  });

  it('/stp gets a did-you-mean', async () => {
    const { reply } = await command('rahul', '/stp keen-otter');
    expect(reply!.text).toBe('did you mean /stop keen-otter? (/help for the list)');
  });

  it('a guest\'s /work gets "link your number first", and creates nothing', async () => {
    const tasks = await bridgeTasks();
    const { reply } = await command('guest', '/work do something');
    expect(reply!.text).toMatch(/^link your number first/);
    expect(await bridgeTasks()).toBe(tasks);
  });

  it('no command text reaches the target chat as a message', async () => {
    expect(await count('select count(*) n from public.messages where anchor_id = $1', [chat])).toBe(0);
  });
});

describe('§7.3 item 11: /tasks and /docs read the provenance edges (ac3)', () => {
  it('/tasks lists the child tasks; /docs lists the doc, also after it moves', async () => {
    // Newest first, at most 8 lines and a "more" line (§4.8 output size).
    const { reply: tasks } = await command('rahul', '/tasks');
    expect(tasks!.text).toContain('Fix the login timeout on mobile');
    expect(tasks!.text).toContain('Add retries to the upload client');
    expect(tasks!.text.split('\n')).toHaveLength(9);
    expect(tasks!.text).toMatch(/… and \d+ more in tm8$/);

    // A doc a worker made: it carries the edge (B1b-3's recorder), so it is listed.
    const docId = randomUUID(), folder = randomUUID();
    await asOwner(async c => {
      for (const [id, title] of [[docId, 'Release notes draft'], [folder, 'Docs folder']] as const) {
        await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'doc',0,$3)", [id, space, people.rahul.member]);
        await c.query('insert into public.documents(entity_id,title) values($1,$2)', [id, title]);
      }
    });
    await database.transaction(c => c.query('select public.record_bridge_provenance($1, $2::jsonb)', [docId,
      JSON.stringify([{ bridgeId, messageId: null, providerMessageId: 'IN-doc', sender: { memberId: people.rahul.member }, command: '/work' }])]));
    const { reply: before } = await command('rahul', '/docs');
    expect(before!.text).toBe('1 Release notes draft');
    await asOwner(c => c.query('update public.entities set parent_id = $2 where id = $1', [docId, folder]));
    const { reply: after } = await command('rahul', '/docs');
    expect(after!.text).toBe('1 Release notes draft');
    const { reply: open } = await command('rahul', '/docs #1');
    expect(open!.text).toMatch(/^Release notes draft — open it in tm8/);
  });
});

describe('§4.6 admin tier is structural (ac5)', () => {
  // Each admin-tier command × {linked admin allowed, asserted admin refused, guest refused}.
  const adminCommands = ['/stop all', '/stop <other>', '/mute 1h', '/unmute', '/new'] as const;
  const muted = async () => (await asOwner(c => c.query('select muted_until from public.bridges where entity_id = $1', [bridgeId]))).rows[0].muted_until;
  async function otherWorkerHandle(): Promise<string> {
    await command('rahul', `/work worker for the admin table ${randomUUID().slice(0, 4)}`);
    const { reply } = await command('rahul', '/workers');
    return /\(([a-z]+-[a-z]+(?:-\d+)?)\)/.exec(reply!.text)![1]!;
  }
  it.each(adminCommands)('%s: a linked admin may, an asserted admin and a guest may not', async cmd => {
    for (const [who, allowed] of [['maya', false], ['guest', false], ['owner', true]] as const) {
      const body = cmd === '/stop <other>' ? `/stop ${await otherWorkerHandle()}` : cmd;
      const before = stops.length;
      if (cmd === '/unmute') await asOwner(c => c.query("update public.bridges set muted_until = now() + interval '1 hour' where entity_id = $1", [bridgeId]));
      if (cmd === '/mute 1h') await asOwner(c => c.query('update public.bridges set muted_until = null where entity_id = $1', [bridgeId]));
      const mutedBefore = await muted();
      const { reply } = await command(who, body);
      if (!allowed) {
        expect(reply!.text, `${who} ${body}`).toMatch(/link your number first|space admin|isn't yours/);
        expect(stops.length).toBe(before);
        expect(await muted()).toEqual(mutedBefore); // the door never ran
      } else if (cmd === '/mute 1h') {
        expect(reply!.text).toMatch(/^muted until \d\d:\d\d UTC — commands still work/);
        expect(await muted()).not.toBeNull();
      } else if (cmd === '/unmute') {
        expect(reply!.text).toBe('unmuted');
        expect(await muted()).toBeNull();
      } else if (cmd === '/new') {
        expect(reply!.text).toMatch(/done in tm8/);
      } else if (cmd === '/stop all') {
        expect(reply!.text).toMatch(/^stop \d+ workers?\? reply YES within 2 min$/);
      } else {
        expect(reply!.text).toMatch(/^stopped /);
        expect(stops.length).toBe(before + 1);
        // The stopped worker's task is set blocked, as the stopper (§4.4).
        expect(await count(`select count(*) n from public.edges ed join public.tasks t on t.entity_id = ed.dst_id
          where ed.src_id = $1 and ed.type = 'working_on' and t.work_status = 'blocked'`, [stops.at(-1)])).toBe(1);
        // ... with the reason visible on the task, as a message from the stopper.
        expect(await count(`select count(*) n from public.edges ed join public.messages m on m.anchor_id = ed.dst_id
          where ed.src_id = $1 and ed.type = 'working_on' and m.body like 'stopped from WhatsApp by %' and m.author_id = $2`,
          [stops.at(-1), people.owner.member])).toBe(1);
      }
    }
  });
});

describe('§4.6 confirms: YES quoting the notice, same sender, once', () => {
  it('/work over 3 items asks; detect admits only the sender\'s YES quoting it; YES starts them; a second YES does nothing', async () => {
    await endWorkers(); // earlier tests' workers would hit maxLiveWorkersPerBridge
    const before = spawns.length;
    const { reply: ask } = await command('owner', '/work\none\ntwo\nthree\nfour');
    expect(ask!.text).toMatch(/^start 4 workers\?[\s\S]*reply YES within 2 min$/);
    expect(spawns.length).toBe(before);

    const detect = (sender: string, reply: string | null, text = 'YES') =>
      db.tx(bridgesWorkerClaims(), q => executor.detect(text, { q, bridgeId, senderExternalId: sender, replyToExternalMessageId: reply }));
    expect(await detect(people.owner.phone, ask!.externalId)).toBe(true);
    expect(await detect(people.rahul.phone, ask!.externalId)).toBe(false); // someone else's
    expect(await detect(people.owner.phone, null)).toBe(false); // quotes nothing: routes as text
    expect(await detect(people.owner.phone, ask!.externalId, 'yes, later')).toBe(false);
    expect(await detect(people.owner.phone, null, '/help')).toBe(true);

    const { reply: done } = await command('owner', 'YES', ask!.externalId);
    expect(done!.text).toMatch(/^4 workers on it/);
    expect(spawns.length).toBe(before + 4);
    expect(await detect(people.owner.phone, ask!.externalId)).toBe(false); // used
    const { reply: again } = await command('owner', 'YES', ask!.externalId);
    expect(again!.text).toMatch(/^nothing to confirm/);
    expect(spawns.length).toBe(before + 4);
  });

  it('F1: a YES whose run dies after the take re-runs to the same command; workers start once', async () => {
    await endWorkers();
    const before = spawns.length;
    const { reply: ask } = await command('owner', '/work\nf1 one\nf1 two\nf1 three\nf1 four');
    expect(ask!.text).toMatch(/^start 4 workers\?/);
    failNextOrigin = true; // the take commits, then the task transaction dies
    const { messageId: yesId } = await command('owner', 'YES', ask!.externalId);
    expect(spawns.length).toBe(before);
    // The crash left it for the sweep: re-run the same YES.
    await asOwner(c => c.query("update public.message_origins set command_state = 'pending' where message_id = $1", [yesId]));
    await executor.run(yesId);
    expect(spawns.length).toBe(before + 4);
    expect(notices.some(n => n.replyToMessageId === yesId && n.text.startsWith('4 workers on it'))).toBe(true);
    await asOwner(c => c.query("update public.message_origins set command_state = 'pending' where message_id = $1", [yesId]));
    await executor.run(yesId);
    expect(spawns.length).toBe(before + 4);
    // Another YES quoting the same notice gets nothing; a YES quoting nothing confirms nothing.
    expect((await command('owner', 'YES', ask!.externalId)).reply!.text).toMatch(/^nothing to confirm/);
    expect(await db.rpc(bridgesWorkerClaims(), 'bridge_command_confirm_take', [bridgeId, people.owner.phone, null, randomUUID()])).toBeNull();
  });

  it('F2: a /stop whose run died after the stop re-runs to a blocked task with the note', async () => {
    await endWorkers();
    await command('rahul', '/work f2 worker');
    const { reply: list } = await command('rahul', '/workers');
    const handle = /\(([a-z]+-[a-z]+(?:-\d+)?)\)/.exec(list!.text)![1]!;
    const session = (await asOwner(c => c.query(
      'select entity_id from public.bridge_handles where handle = $1', [handle]))).rows[0].entity_id as string;
    // The state a crash between stopWorker and the block leaves: ended with this command's reason, task untouched.
    const messageId = await inbound(people.rahul.phone, people.rahul.member, `/stop ${handle}`);
    await endWorkers(session, 'stopped from WhatsApp by a member');
    const blocked = () => count(`select count(*) n from public.edges ed join public.tasks t on t.entity_id = ed.dst_id
      where ed.src_id = $1 and ed.type = 'working_on' and t.work_status = 'blocked'`, [session]);
    const notes = () => count(`select count(*) n from public.edges ed join public.messages m on m.anchor_id = ed.dst_id
      where ed.src_id = $1 and ed.type = 'working_on' and m.body = 'stopped from WhatsApp by a member.'`, [session]);
    expect(await blocked()).toBe(0);
    await executor.run(messageId);
    expect(notices.find(n => n.replyToMessageId === messageId)!.text).toBe(`stopped ${handle}`);
    expect(await blocked()).toBe(1);
    expect(await notes()).toBe(1);
    await asOwner(c => c.query("update public.message_origins set command_state = 'pending' where message_id = $1", [messageId]));
    await executor.run(messageId);
    expect(await notes()).toBe(1);
  });

  it('F5: a later /stop does not re-note or re-list a worker an earlier /stop ended', async () => {
    await endWorkers();
    await command('rahul', '/work f5 worker');
    const { reply: list } = await command('rahul', '/workers');
    const handle = /\(([a-z]+-[a-z]+(?:-\d+)?)\)/.exec(list!.text)![1]!;
    const session = (await asOwner(c => c.query(
      'select entity_id from public.bridge_handles where handle = $1', [handle]))).rows[0].entity_id as string;
    expect((await command('rahul', `/stop ${handle}`)).reply!.text).toBe(`stopped ${handle}`);
    const notes = () => count(`select count(*) n from public.edges ed join public.messages m on m.anchor_id = ed.dst_id
      where ed.src_id = $1 and ed.type = 'working_on' and m.body like 'stopped from WhatsApp by %'`, [session]);
    expect(await notes()).toBe(1);
    // Later: the same worker again, and /stop mine confirmed by YES.
    expect((await command('rahul', `/stop ${handle}`)).reply!.text).toMatch(new RegExp(`\\(${handle}\\) already ended$`));
    await command('rahul', '/work f5 other');
    const { reply: ask } = await command('rahul', '/stop mine');
    const { reply: done } = await command('rahul', 'YES', ask!.externalId);
    expect(done!.text).toMatch(/^stopped /);
    expect(done!.text).not.toContain(handle);
    expect(await notes()).toBe(1);
  });

  it('a fault settles back to pending; the retry succeeds with one effect', async () => {
    const tasks = await bridgeTasks();
    failNextOrigin = true; // a transient fault inside the task transaction
    const { messageId } = await command('rahul', '/task fault then retry');
    const state = async () => (await asOwner(c => c.query(
      'select command_state from public.message_origins where message_id = $1', [messageId]))).rows[0].command_state;
    expect(await state()).toBe('pending');
    expect(await bridgeTasks()).toBe(tasks);
    expect(notices.filter(n => n.replyToMessageId === messageId).map(n => n.text)).toEqual(['that hit a problem on our side — retrying']);
    await executor.run(messageId); // what the sweep does
    expect(await state()).toBe('done');
    expect(await bridgeTasks()).toBe(tasks + 1);
    expect(notices.filter(n => n.replyToMessageId === messageId).map(n => n.text)).toEqual(
      ['that hit a problem on our side — retrying', 'task #1 created: Fault then retry']);
    await executor.run(messageId); // settled: nothing more
    expect(await bridgeTasks()).toBe(tasks + 1);
  });

  it('F4: a /work re-run does not count its own workers against the live cap', async () => {
    await endWorkers();
    const body = ['/work', ...Array.from({ length: 3 }, (_, i) => `f4 item ${i}`)].join('\n');
    // Seven other live workers, then three of this command's: 10, at the cap.
    await command('rahul', '/work\nf4 a\nf4 b\nf4 c');
    await command('rahul', '/work\nf4 d\nf4 e\nf4 f');
    await command('rahul', '/work f4 g');
    const { messageId, reply } = await command('rahul', body);
    expect(reply!.text).toMatch(/^3 workers on it/);
    const noticeCount = notices.length;
    const spawnCount = spawns.length;
    await asOwner(c => c.query("update public.message_origins set command_state = 'pending' where message_id = $1", [messageId]));
    executor.reset();
    await executor.run(messageId);
    expect(spawns.length).toBe(spawnCount);
    expect(notices.length).toBe(noticeCount);
    expect(attempted.at(-1)!.text).toMatch(/^3 workers on it/); // the same answer, not "over the limit"
  });

  it('the doors refuse any caller but the bridges worker', async () => {
    await expect(db.rpc(memberClaims(people.owner.identity), 'bridge_command_input', [randomUUID()])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(db.rpc(memberClaims(people.owner.identity), 'bridge_command_confirm_take', [bridgeId, people.owner.phone, 'OUT-1', randomUUID()]))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('the rest of the slice', () => {
  it('/whoami, /help and /link answer per tier', async () => {
    expect((await command('owner', '/whoami')).reply!.text).toMatch(/^you are .* \(linked ✓\) in Infra — you can start and stop any worker$/);
    expect((await command('maya', '/whoami')).reply!.text).toMatch(/\(asserted by an admin\)/);
    expect((await command('guest', '/whoami')).reply!.text).toMatch(/^you're a guest here/);
    expect((await command('guest', '/help')).reply!.text).not.toContain('/work');
    expect((await command('rahul', '/help')).reply!.text).toContain('/work');
  });
  it('/link TM8-… (B3, D58/D59): a guest number links to the code\'s identity; a failed try burns a live code', async () => {
    const from = async (phone: string, body: string) => {
      const messageId = await inbound(phone, bridgeId, body);
      await executor.run(messageId);
      return notices.find(n => n.replyToMessageId === messageId)!.text;
    };
    const mint = async (identity: string) => (await db.rpc<{ code: string }>(
      { ...memberClaims(identity), authKind: 'browser' }, 'begin_bridge_link', ['whatsapp'])).code;
    const newPhone = '919000000071@s.whatsapp.net';
    const rahulCode = await mint(people.rahul.identity);
    expect(await from(newPhone, `/link ${rahulCode.toLowerCase()}`)).toMatch(/^linked ✓ — messages from this number now count as you/);
    expect(await count(`select count(*) n from public.bridge_identity_links where external_id = $1 and identity_id = $2
      and method = 'code' and space_id is null and revoked_at is null`, [newPhone, people.rahul.identity])).toBe(1);
    expect(await from(newPhone, `/link ${rahulCode}`)).toMatch(/already used/);
    expect(await from(newPhone, '/link')).toMatch(/^usage: \/link TM8-/);
    expect(await from('919000000072@s.whatsapp.net', '/link TM8-ZZZZZZ')).toMatch(/not a valid code/);
    // The number is rahul's proof: maya's code does not take it, and is burned
    // because the whole group has now read it.
    const mayaCode = await mint(people.maya.identity);
    expect(await from(newPhone, `/link ${mayaCode}`)).toMatch(/linked to another tm8 account.*used up now/);
    expect(await from('919000000073@s.whatsapp.net', `/link ${mayaCode}`)).toMatch(/already used/);
    await expect(db.rpc(memberClaims(people.owner.identity), 'bridge_command_link_redeem', [bridgeId, newPhone, mayaCode]))
      .rejects.toMatchObject({ code: 'forbidden' });
    // B3 follow-up (D59): a code split and autocorrected on the phone still links;
    // a near miss of a live code burns it.
    const ownerCode = await mint(people.owner.identity);
    const split = `TM8 \u2013 ${ownerCode.slice(4, 7)} ${ownerCode.slice(7)}`;
    expect(await from('919000000074@s.whatsapp.net', `/link ${split} thanks`)).toMatch(/^linked ✓/);
    const mayaAgain = await mint(people.maya.identity);
    const typo = `${mayaAgain.slice(0, 9)}${mayaAgain[9] === 'A' ? 'B' : 'A'}`;
    expect(await from('919000000075@s.whatsapp.net', `/link ${typo}`)).toMatch(/not a valid code.*used up now/);
    expect(await from('919000000076@s.whatsapp.net', `/link ${mayaAgain}`)).toMatch(/already used/);
  });
  it('/status names one worker; unknown and planned verbs are answered', async () => {
    const { reply: list } = await command('rahul', '/workers all');
    const handle = /\(([a-z]+-[a-z]+(?:-\d+)?)\)/.exec(list!.text)![1]!;
    expect((await command('rahul', `/status ${handle}`)).reply!.text).toMatch(new RegExp(`\\(${handle}\\) · working \\d+m · task: `));
    expect((await command('rahul', '/status #1')).reply!.text).toContain(handle);
    expect((await command('rahul', '/remind tomorrow 9am')).reply!.text).toBe('coming soon: /remind — /help for what works now');
    expect((await command('rahul', '/start #1')).reply!.text).toBe('coming soon: /start — /help for what works now');
  });
  it('/who and /bridge describe the group', async () => {
    expect((await command('guest', '/bridge')).reply!.text).toMatch(/^Infra → Infra main \(chat\) · (live|muted until .*)\nanswers: messages that mention tm8, from linked members\ncrosses back: replies to this group$/);
    expect((await command('rahul', '/who')).reply!.text).toMatch(/^chat: Infra main \(tm8\)\n/);
    expect((await command('rahul', '/mute 1h')).reply!.text).toMatch(/needs a space admin/);
  });
  it('/mute twice is one mute (ac4)', async () => {
    const { messageId } = await command('owner', '/mute 2h');
    const first = await count('select extract(epoch from muted_until)::bigint n from public.bridges where entity_id = $1', [bridgeId]);
    const noticeCount = notices.length;
    await asOwner(c => c.query("update public.message_origins set command_state = 'pending' where message_id = $1", [messageId]));
    await executor.run(messageId);
    const second = await count('select extract(epoch from muted_until)::bigint n from public.bridges where entity_id = $1', [bridgeId]);
    expect(Math.abs(second - first)).toBeLessThan(5);
    expect(notices.length).toBe(noticeCount);
  });
  it('the per-sender rate limit answers once, then stays silent', async () => {
    let told = 0;
    for (let i = 0; i < 12; i++) {
      const { reply } = await command('guest', '/help');
      if (reply?.text.startsWith('too many commands')) told += 1;
    }
    expect(told).toBe(1);
  });
});
