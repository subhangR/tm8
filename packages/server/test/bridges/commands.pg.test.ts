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
  // D32 (#1427): the bridge rides the connection's offer to this space.
  await db.rpc({ identityId: people.owner.identity, nodeAdmin: false, authKind: 'cli', requestId: 'b1b4-offer' },
    'offer_bridge_connection', [connection, space, 'public', null, `b1b4-offer-${randomUUID()}`]);
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

let resumes: string[] = [];
let failResume = false;

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
      const creator = request.taskId
        ? (await asOwner(c => c.query('select created_by from public.entities where id = $1', [request.taskId]))).rows[0].created_by
        : people.owner.member;
      await asOwner(async c => {
        await c.query("insert into public.entities(id,space_id,kind,position,created_by,visibility) values($1,$2,'work_session',0,$3,'space')",
          [sessionId, space, creator]);
        await c.query("insert into public.work_sessions(entity_id,title,status,share_mode,started_at) values($1,$2,'running','none',now())",
          [sessionId, request.title]);
        if (request.taskId) {
          await c.query('select internal.w1_set_writer($1)', ['entity_recorder']);
          await c.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'working_on',$4)",
            [space, sessionId, request.taskId, creator]);
        }
      });
      await database.transaction(c => c.query('select public.record_bridge_provenance($1, $2::jsonb)', [sessionId, JSON.stringify(request.origins)]));
      spawned.set(request.clientMutationId, sessionId);
      return { sessionId };
    },
    async stopWorker(_claims, sessionId, input) {
      stops.push(sessionId);
      await endWorkers(sessionId, input.reason);
    },
    async resumeWorker(_claims, sessionId, input) {
      resumes.push(input.clientMutationId);
      if (failResume) throw new Error('nothing to resume');
      await asOwner(async c => {
        await c.query("select set_config('tm8.work_session_transition', 'on', true)");
        await c.query("update public.work_sessions set status = 'running' where entity_id = $1", [sessionId]);
      });
      return { sessionId };
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
  const adminCommands = ['/stop all', '/stop <other>', '/mute 1h', '/unmute'] as const;
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

  it('B1b-6 /start #n: a worker on an existing task from this group, once', async () => {
    await endWorkers();
    await command('rahul', '/task start me later');
    const { reply: list } = await command('rahul', '/tasks');
    expect(list!.text.split('\n')[0]).toMatch(/^1 Start me later · open$/);
    const before = spawns.length;
    const { messageId, reply } = await command('rahul', '/start #1');
    expect(reply!.text).toMatch(/^Start me later \([a-z]+-[a-z]+(-\d+)?\) — starting$/);
    expect(spawns.length).toBe(before + 1);
    expect(spawns.at(-1)!.origins).toEqual([expect.objectContaining({ command: '/start', messageId })]);
    await asOwner(c => c.query("update public.message_origins set command_state = 'pending' where message_id = $1", [messageId]));
    await executor.run(messageId);
    expect(spawns.length).toBe(before + 1);
    expect((await command('guest', '/start #1')).reply!.text).toMatch(/^link your number first/);
  });

  it('B1b-6 /retry: resumes an ended worker; when it cannot, a new launch on its task, once', async () => {
    await endWorkers();
    await command('rahul', '/work retry target');
    const { reply: list } = await command('rahul', '/workers');
    const handle = /\(([a-z]+-[a-z]+(?:-\d+)?)\)/.exec(list!.text)![1]!;
    expect((await command('rahul', `/retry ${handle}`)).reply!.text).toMatch(/is still working$/);
    await endWorkers();
    expect((await command('rahul', `/retry ${handle}`)).reply!.text).toMatch(new RegExp(`\\(${handle}\\) resumed$`));
    await endWorkers();
    failResume = true;
    const before = spawns.length;
    const { messageId, reply } = await command('rahul', `/retry ${handle}`);
    expect(reply!.text).toMatch(/couldn't resume — started [a-z]+-[a-z]+(-\d+)? on "Retry target"$/);
    expect(spawns.length).toBe(before + 1);
    await asOwner(c => c.query("update public.message_origins set command_state = 'pending' where message_id = $1", [messageId]));
    await executor.run(messageId);
    expect(spawns.length).toBe(before + 1);
    failResume = false;
  });

  it('B1b-6 /result: the latest report, at most 10 lines, never secret-shaped; guests read space-visible ones', async () => {
    await endWorkers();
    await command('rahul', '/work report target');
    const { reply: list } = await command('rahul', '/workers');
    const handle = /\(([a-z]+-[a-z]+(?:-\d+)?)\)/.exec(list!.text)![1]!;
    const session = (await asOwner(c => c.query('select entity_id from public.bridge_handles where handle = $1', [handle]))).rows[0].entity_id as string;
    expect((await command('rahul', `/result ${handle}`)).reply!.text).toMatch(/hasn't reported yet$/);
    const report = async (body: string) => {
      const id = await storeMessage(people.rahul.member, body);
      await asOwner(async c => {
        await c.query("select set_config('tm8.w1_writer', 'entity_recorder', true)");
        await c.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'authored_from',$4)",
          [space, id, session, people.rahul.member]);
      });
    };
    await report(Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n'));
    const text = (await command('rahul', `/result ${handle}`)).reply!.text.split('\n');
    expect(text[0]).toMatch(new RegExp(`\\(${handle}\\):$`));
    expect(text.slice(1, 3)).toEqual(['line 1', 'line 2']);
    expect(text.at(-1)).toBe('… more in tm8');
    expect(text.length).toBeLessThanOrEqual(10);
    // whoMayTrigger 'linked': a guest is not a reader here.
    expect((await command('guest', `/result ${handle}`)).reply!.text).toMatch(/^link your number first/);
    // With whoMayTrigger 'anyone' a guest reads through the executor-only door: this bridge's worker, space-visible.
    const guestRows = await db.query<{ body: string }>(bridgesWorkerClaims(),
      'select body from public.bridge_command_guest_result($1, $2) as body', [bridgeId, session]);
    expect(guestRows[0]!.body.split('\n')[0]).toBe('line 1');
    expect(await db.query(bridgesWorkerClaims(), 'select * from public.bridge_command_guest_result($1, $2)', [bridgeId, randomUUID()])).toEqual([]);
    await expect(db.query(memberClaims(people.owner.identity), 'select * from public.bridge_command_guest_result($1, $2)', [bridgeId, session]))
      .rejects.toMatchObject({ code: 'forbidden' });
    // F1: a newer message the worker wrote ELSEWHERE (a task thread) is never quoted into the group.
    await new Promise(resolve => setTimeout(resolve, 5));
    const elsewhere = randomUUID();
    const [{ id: taskAnchor }] = (await asOwner(c => c.query(
      `select ed.src_id::text id from public.edges ed join public.entities e on e.id = ed.src_id
        where ed.dst_id = $1 and ed.type = 'authored_from' and e.kind = 'task' limit 1`, [bridgeId]))).rows;
    await asOwner(async c => {
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'message',0,$3)", [elsewhere, space, people.rahul.member]);
      await c.query('insert into public.messages(entity_id,anchor_id,author_id,body) values($1,$2,$3,$4)', [elsewhere, taskAnchor, people.rahul.member, 'private note on a task']);
      await c.query("select set_config('tm8.w1_writer', 'entity_recorder', true)");
      await c.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'authored_from',$4)",
        [space, elsewhere, session, people.rahul.member]);
    });
    // ...and nor is a newer post on ANOTHER bridge's log.
    const otherChat = randomUUID();
    await asOwner(async c => {
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'chat',0,$3)", [otherChat, space, people.owner.member]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,'Ops main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b1b4', gen_random_uuid(), $4, $5, $6)`,
        [otherChat, space, persona, people.owner.identity, people.owner.member, `b1b6-${randomUUID()}`]);
    });
    const other = await db.rpc<{ entity: { id: string } }>(
      { identityId: people.owner.identity, nodeAdmin: false, authKind: 'cli', requestId: 'b1b6-other' }, 'create_bridge',
      [space, connection, '120363-ops@g.us', JSON.stringify({ kind: 'group', title: 'Ops', memberCount: null }), otherChat,
        '{}', persona, null, null, true, null, null, `b1b6-other-${randomUUID()}`]);
    await new Promise(resolve => setTimeout(resolve, 5));
    const otherPost = randomUUID();
    await asOwner(async c => {
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'message',0,$3)", [otherPost, space, people.rahul.member]);
      await c.query('insert into public.messages(entity_id,anchor_id,author_id,body) values($1,$2,$3,$4)', [otherPost, other.entity.id, people.rahul.member, 'said in the Ops group']);
      await c.query("select set_config('tm8.w1_writer', 'entity_recorder', true)");
      await c.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'authored_from',$4)",
        [space, otherPost, session, people.rahul.member]);
    });
    expect((await command('rahul', `/result ${handle}`)).reply!.text.split('\n')[1]).toBe('line 1');
    expect((await db.query<{ body: string }>(bridgesWorkerClaims(),
      'select body from public.bridge_command_guest_result($1, $2) as body', [bridgeId, session]))[0]!.body.split('\n')[0]).toBe('line 1');
    await new Promise(resolve => setTimeout(resolve, 5));
    await report('done. token: ghp_' + 'a'.repeat(36));
    expect((await command('rahul', `/result ${handle}`)).reply!.text).toMatch(/looks like it holds a secret — read it in tm8$/);
  });

  it('B1b-6 /tell: directs the message to a live worker (origin /tell, answerer); unknown handles are answered', async () => {
    await endWorkers();
    await command('rahul', '/work tell target');
    const { reply: list } = await command('rahul', '/workers');
    const handle = /\(([a-z]+-[a-z]+(?:-\d+)?)\)/.exec(list!.text)![1]!;
    const session = (await asOwner(c => c.query('select entity_id from public.bridge_handles where handle = $1', [handle]))).rows[0].entity_id as string;
    const { messageId, reply } = await command('rahul', `/tell @${handle} the logs are in #ops`);
    expect(reply!.text).toBe(`told ${handle}`);
    expect(await count(`select count(*) n from public.session_bridge_origins where holder_id = $1 and command = '/tell' and message_id = $2`,
      [session, messageId])).toBe(1);
    await asOwner(c => c.query("update public.message_origins set command_state = 'pending' where message_id = $1", [messageId]));
    await executor.run(messageId);
    expect(await count(`select count(*) n from public.session_bridge_origins where holder_id = $1 and command = '/tell'`, [session])).toBe(1);
    expect((await command('rahul', '/tell nobody-here hi')).reply!.text).toMatch(/^no live worker called nobody-here/);
    expect((await command('rahul', `/tell ${handle}`)).reply!.text).toBe('usage: /tell <worker> <message>');
    expect((await command('guest', `/tell ${handle} hi`)).reply!.text).toMatch(/^link your number first/);
  });

  it('B1b-6: when 398 fails a command after its attempts, the group is told once', async () => {
    const messageId = await inbound(people.rahul.phone, people.rahul.member, '/task never lands');
    await asOwner(c => c.query("update public.message_origins set command_attempts = 5 where message_id = $1", [messageId]));
    await executor.run(messageId);
    const finals = () => attempted.filter(a => a.key.endsWith(':failed') && notices.some(n => n.key === a.key && n.replyToMessageId === messageId));
    expect((await asOwner(c => c.query('select command_state from public.message_origins where message_id = $1', [messageId]))).rows[0].command_state).toBe('failed');
    expect(notices.filter(n => n.replyToMessageId === messageId).map(n => n.text)).toEqual(['couldn\'t do that after several tries — please send it again later']);
    await executor.run(messageId);
    expect(notices.filter(n => n.replyToMessageId === messageId)).toHaveLength(1);
    expect(finals().length).toBeGreaterThanOrEqual(1);
  });

  it('B1b-6 bridges.work.start: the /work path as the caller, announced, idempotent on the mutation id', async () => {
    await endWorkers();
    const tasks = await bridgeTasks();
    const before = spawns.length;
    const cmid = `api-${randomUUID()}`;
    const input = { bridgeId, clientMutationId: cmid, items: ['api item one', 'api item two'], options: { effort: 'high' as const } };
    const result = await executor.workStart(memberClaims(people.rahul.identity), input);
    expect(result.parentTaskId).not.toBeNull();
    expect(result.items).toHaveLength(2);
    expect(result.items.every(i => i.sessionId && i.handle && !i.error)).toBe(true);
    expect(await bridgeTasks()).toBe(tasks + 3);
    expect(spawns.length).toBe(before + 2);
    expect(spawns.at(-1)).toMatchObject({ effort: 'high', origins: [expect.objectContaining({ command: '/work', messageId: null, sender: { memberId: people.rahul.member } })] });
    const [edge] = (await asOwner(c => c.query(
      `select props from public.edges where src_id = $1 and dst_id = $2 and type = 'authored_from'`, [result.items[0]!.taskId, bridgeId]))).rows;
    expect(edge.props.origins[0]).toMatchObject({ command: '/work', providerMessageId: `api:${cmid}` });
    expect(result.noticeMessageId).toBe(notices.find(n => n.key === `work:${bridgeId}:${cmid}`)!.messageId);
    expect(notices.find(n => n.key === `work:${bridgeId}:${cmid}`)!.text).toMatch(/^2 workers on it/);
    // The same provenance as /work, so /tasks lists them like any /work task.
    expect((await command('rahul', '/tasks')).reply!.text).toContain('Api item one');
    // Replay: the same tasks, sessions and announcement.
    const again = await executor.workStart(memberClaims(people.rahul.identity), input);
    expect(again).toEqual(result);
    expect(await bridgeTasks()).toBe(tasks + 3);
    expect(spawns.length).toBe(before + 2);
    // A stranger to the space is refused; so are too many items.
    await expect(executor.workStart(memberClaims(`stranger-${randomUUID()}`), { ...input, clientMutationId: randomUUID() }))
      .rejects.toMatchObject({ code: expect.stringMatching(/forbidden|not_found/) });
    await expect(executor.workStart(memberClaims(people.rahul.identity), {
      bridgeId, clientMutationId: randomUUID(), items: ['1', '2', '3', '4', '5', '6'],
    })).rejects.toMatchObject({ code: 'invalid_input' });
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

describe('/remember (Bridges R, 416: D29, D61)', () => {
  const proposals = (messageId: string) => asOwner(async c => (await c.query(
    `select status, statement, proposed_by, proposer_trust, memory_id from public.bridge_memory_proposals
      where bridge_id = $1 and message_id = $2`, [bridgeId, messageId])).rows);
  const memories = () => count('select count(*) n from public.memories');

  it('from a linked member: one proposal, never a memory, one inbox item; a re-run adds none', async () => {
    const before = await memories();
    const { messageId, reply } = await command('rahul', '/remember deploy windows are Tue/Thu\n14:00-16:00 IST');
    expect(reply!.text).toMatch(/^memory proposed — a linked member of this group accepts it in tm8/);
    expect(await proposals(messageId)).toEqual([{ status: 'pending', statement: 'deploy windows are Tue/Thu\n14:00-16:00 IST',
      proposed_by: people.rahul.member, proposer_trust: 'linked', memory_id: null }]);
    expect(await memories()).toBe(before);
    const items = await count(`select count(*) n from public.attention_requests where entity_id = $1 and signal_key like 'bridge_memory_proposal:%' and assignee_id = $2`,
      [bridgeId, people.rahul.member]);
    expect(items).toBeGreaterThanOrEqual(1);
    // The inbound sweep re-running the same message lands on the same proposal.
    await asOwner(c => c.query("update public.message_origins set command_state = 'pending' where message_id = $1", [messageId]));
    await executor.run(messageId);
    expect(await proposals(messageId)).toHaveLength(1);
    expect(await memories()).toBe(before);
  });

  it('nothing sent from the group accepts one: a YES quoting the notice, /remember accept', async () => {
    const before = await memories();
    const { messageId, reply } = await command('rahul', '/remember the VPN config lives in the wiki');
    const yes = await command('rahul', 'YES', reply!.externalId);
    expect(yes.reply?.text ?? '').toBe('nothing to confirm — it expired or was already done'); // never an acceptance
    await command('owner', '/remember accept');
    expect((await proposals(messageId))[0]).toMatchObject({ status: 'pending', memory_id: null });
    expect(await memories()).toBe(before);
  });

  it('an asserted member proposes as asserted; a guest and a credential value are refused, and nothing is stored', async () => {
    const { messageId } = await command('maya', '/remember prod deploys need two approvals');
    expect((await proposals(messageId))[0]).toMatchObject({ proposer_trust: 'asserted' });
    const guest = await command('guest', '/remember I am in charge now');
    expect(guest.reply!.text).toMatch(/link your number first/);
    expect(await proposals(guest.messageId)).toHaveLength(0);
    const secret = await command('rahul', '/remember the token is ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(secret.reply!.text).toMatch(/a memory never holds one/);
    expect(await proposals(secret.messageId)).toHaveLength(0);
    expect((await command('rahul', '/remember')).reply!.text).toMatch(/^usage: \/remember/);
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
    expect((await command('rahul', '/forget #1')).reply!.text).toBe('coming soon: /forget — /help for what works now');
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

describe('/new (R11, 425): the bridge starts its own session and moves to it', () => {
  const target = async () => (await asOwner(c => c.query(
    'select target_kind, target_id::text from public.bridges where entity_id = $1', [bridgeId]))).rows[0] as { target_kind: string; target_id: string };

  it('a guest may not; a bare /new or /new chat on a chat bridge says where a chat is started', async () => {
    const before = spawns.length;
    expect((await command('guest', '/new session')).reply!.text).toMatch(/link your number first/);
    expect((await command('rahul', '/new')).reply!.text).toMatch(/new chat is started in tm8/);
    expect((await command('rahul', '/new chat')).reply!.text).toMatch(/new chat is started in tm8/);
    expect((await command('rahul', '/new everything')).reply!.text).toBe('usage: /new, or /new session');
    expect(spawns.length).toBe(before);
    expect((await target()).target_id).toBe(chat);
  });

  it('a linked member starts a session with no task; the bridge targets it, and /new again moves on', async () => {
    const { reply } = await command('rahul', '/new session');
    expect(reply!.text).toMatch(/^new session started/);
    const spawn = spawns.at(-1)!;
    expect(spawn.taskId).toBeNull();
    expect(spawn.teamMemberId).toBe(persona);
    expect(spawn.origins[0]!.command).toBe('/new');
    const first = await target();
    expect(first.target_kind).toBe('work_session');
    expect(first.target_id).not.toBe(chat);
    // The bridged_to edge follows the target.
    expect(await count(`select count(*) n from public.edges where src_id = $1 and type = 'bridged_to' and dst_id = $2`,
      [bridgeId, first.target_id])).toBe(1);
    // On a session bridge a bare /new replaces the session.
    const again = await command('rahul', '/new');
    expect(again.reply!.text).toMatch(/^new session started/);
    const second = await target();
    expect(second.target_id).not.toBe(first.target_id);
    // Put the fixture back on its chat for the rest of the file.
    await db.rpc({ identityId: people.owner.identity, nodeAdmin: false, authKind: 'cli', requestId: 'r11-back' },
      'retarget_bridge', [bridgeId, Number((await asOwner(c => c.query('select version from public.entities where id = $1', [bridgeId]))).rows[0].version),
        chat, null, `r11-back-${randomUUID()}`]);
    expect((await target()).target_id).toBe(chat);
  });
});
