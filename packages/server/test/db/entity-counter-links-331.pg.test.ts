/**
 * 331 — `authored_from` ("created by") counted on the session or chat that
 * created the peer, DISTINCT per peer, proved against a REAL PostgreSQL the
 * same two-step way as 108's and 329's tests: everything before 331, then the
 * seed, then 331 — so the BACKFILL runs on rows that genuinely predate it.
 * Then the trigger is proved by moving edges.
 *
 * The distinct rule is the point: a doc a session both created and attached
 * counts once, and so does a memory it created and remembers. The negatives:
 * a message authored_from a chat and a session authored_from its launcher
 * count nothing, and a task's counts do not move.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  space: string;
  member: string;
  task: string;
  session: string;
  session2: string;
  chat: string;
  doc: string;
  pr: string;
  artifact: string;
  drawing: string;
  memory: string;
  message: string;
}

interface Counts {
  docs: number;
  memories: number;
  prs: number;
  artifacts: number;
  drawings: number;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function counters(entity: string): Promise<Counts> {
  const [row] = await database.query<Counts>(
    `select docs, memories, prs, artifacts, drawings from public.entity_counters where entity_id = $1`,
    [entity],
  );
  return {
    docs: Number(row!.docs),
    memories: Number(row!.memories),
    prs: Number(row!.prs),
    artifacts: Number(row!.artifacts),
    drawings: Number(row!.drawings),
  };
}

const zero: Counts = { docs: 0, memories: 0, prs: 0, artifacts: 0, drawings: 0 };

async function asOwner<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

// `authored_from` is recorder-owned (308), so the fixture writes as that
// recorder, exactly as public.record_authored_from does.
async function edge(src: string, dst: string, type: string): Promise<void> {
  await asOwner(async (client) => {
    if (type === 'authored_from') await client.query(`select internal.w1_set_writer('entity_recorder')`);
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, $4, $5)`,
      [fixture.space, src, dst, type, fixture.member],
    );
  });
}

async function unedge(src: string, dst: string, type: string): Promise<void> {
  await asOwner(async (client) => {
    if (type === 'authored_from') await client.query(`select internal.w1_set_writer('entity_recorder')`);
    await client.query(`delete from public.edges where src_id = $1 and dst_id = $2 and type = $3`, [src, dst, type]);
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('links_331');
  const files = migrationFiles();
  const cut = files.findIndex((f) => f.startsWith('331_'));
  if (cut === -1) throw new Error('331 migration not found');

  database.apply(files.slice(0, cut));

  fixture = await asOwner(async (client) => {
    const ids = (
      await client.query<Fixture>(
        `select internal.new_id()::text "space", internal.new_id()::text "member",
                internal.new_id()::text "task", internal.new_id()::text "session",
                internal.new_id()::text "session2", internal.new_id()::text "chat",
                internal.new_id()::text "doc", internal.new_id()::text "pr",
                internal.new_id()::text "artifact", internal.new_id()::text "drawing",
                internal.new_id()::text "memory", internal.new_id()::text "message"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ('links331-member', 'Member')`,
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Links 331', 'links331-member')`,
      [ids.space],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
         ($2, $1, 'member', 0, $2), ($3, $1, 'task', 1, $2), ($4, $1, 'work_session', 2, $2),
         ($5, $1, 'work_session', 3, $2), ($6, $1, 'chat', 4, $2), ($7, $1, 'doc', 5, $2),
         ($8, $1, 'pull_request', 6, $2), ($9, $1, 'artifact', 7, $2), ($10, $1, 'drawing', 8, $2),
         ($11, $1, 'memory', 9, $2), ($12, $1, 'message', 10, $2)`,
      [ids.space, ids.member, ids.task, ids.session, ids.session2, ids.chat, ids.doc, ids.pr,
        ids.artifact, ids.drawing, ids.memory, ids.message],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, 'links331-member', 'owner', 'Member')`,
      [ids.member, ids.space],
    );
    // Pre-331 edges. The session CREATED a doc, a PR, an artifact and a
    // memory, and ALSO attached the doc and remembers the memory (the
    // distinct rule). The task tracks the same PR and has the doc attached
    // (its counts must not move). The chat created a drawing and holds a
    // message's authored_from; session2 was launched from the session.
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by) values
         ($1, $4, $2, 'attached_to', $7), ($1, $2, $6, 'remembers', $7),
         ($1, $3, $5, 'tracks', $7), ($1, $4, $3, 'attached_to', $7)`,
      [ids.space, ids.session, ids.task, ids.doc, ids.pr, ids.memory, ids.member],
    );
    await client.query(`select internal.w1_set_writer('entity_recorder')`);
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by) values
         ($1, $3, $2, 'authored_from', $9), ($1, $4, $2, 'authored_from', $9),
         ($1, $5, $2, 'authored_from', $9), ($1, $6, $2, 'authored_from', $9),
         ($1, $7, $8, 'authored_from', $9), ($1, $10, $8, 'authored_from', $9),
         ($1, $11, $2, 'authored_from', $9)`,
      [ids.space, ids.session, ids.doc, ids.pr, ids.artifact, ids.memory, ids.drawing, ids.chat,
        ids.member, ids.message, ids.session2],
    );
    await client.query(`select internal.w1_set_writer(null)`);
    return ids;
  });

  database.apply(files.slice(cut));
}, 300_000);

afterAll(async () => {
  await database?.destroy();
});

describe('331 — the backfill', () => {
  it('counts what a session created, once per peer even when it also attached or remembers it', async () => {
    expect(await counters(fixture.session)).toEqual({ docs: 1, memories: 1, prs: 1, artifacts: 1, drawings: 0 });
  });

  it('counts what a chat created, and not its messages', async () => {
    expect(await counters(fixture.chat)).toEqual({ ...zero, drawings: 1 });
  });

  it("leaves a task's counts as they were", async () => {
    expect(await counters(fixture.task)).toEqual({ ...zero, docs: 1, prs: 1 });
  });
});

describe('331 — the trigger', () => {
  it('created + attached is one doc: removing either link alone keeps it, removing both drops it', async () => {
    await unedge(fixture.doc, fixture.session, 'attached_to');
    expect((await counters(fixture.session)).docs).toBe(1);
    await unedge(fixture.doc, fixture.session, 'authored_from');
    expect((await counters(fixture.session)).docs).toBe(0);
    await edge(fixture.doc, fixture.session, 'authored_from');
    expect((await counters(fixture.session)).docs).toBe(1);
    await edge(fixture.doc, fixture.session, 'attached_to');
    expect((await counters(fixture.session)).docs).toBe(1);
  });

  it('created + remembered is one memory', async () => {
    await unedge(fixture.session, fixture.memory, 'remembers');
    expect((await counters(fixture.session)).memories).toBe(1);
    await edge(fixture.session, fixture.memory, 'remembers');
    expect((await counters(fixture.session)).memories).toBe(1);
  });

  it('a created PR counts on its session and uncounts on delete; the task that tracks it is untouched', async () => {
    await unedge(fixture.pr, fixture.session, 'authored_from');
    expect((await counters(fixture.session)).prs).toBe(0);
    expect((await counters(fixture.task)).prs).toBe(1);
    await edge(fixture.pr, fixture.session, 'authored_from');
    expect((await counters(fixture.session)).prs).toBe(1);
    expect((await counters(fixture.task)).prs).toBe(1);
  });

  it('a message or a launched session authored_from moves nothing', async () => {
    const chat = await counters(fixture.chat);
    const session = await counters(fixture.session);
    await unedge(fixture.message, fixture.chat, 'authored_from');
    await unedge(fixture.session2, fixture.session, 'authored_from');
    expect(await counters(fixture.chat)).toEqual(chat);
    expect(await counters(fixture.session)).toEqual(session);
  });

  it('re-pointing authored_from nets out on both ends, and keeps the distinct rule', async () => {
    // The artifact moves from the session to the chat: session loses it.
    await asOwner(async (client) => {
      await client.query(`select internal.w1_set_writer('entity_recorder')`);
      await client.query(
        `update public.edges set dst_id = $3 where src_id = $1 and dst_id = $2 and type = 'authored_from'`,
        [fixture.artifact, fixture.session, fixture.chat],
      );
    });
    expect((await counters(fixture.session)).artifacts).toBe(0);
    expect((await counters(fixture.chat)).artifacts).toBe(1);

    // The doc is attached to the chat too; re-pointing its authored_from
    // there leaves the chat at one doc and the session still holding the
    // attachment.
    await edge(fixture.doc, fixture.chat, 'attached_to');
    expect((await counters(fixture.chat)).docs).toBe(1);
    await asOwner(async (client) => {
      await client.query(`select internal.w1_set_writer('entity_recorder')`);
      await client.query(
        `update public.edges set dst_id = $3 where src_id = $1 and dst_id = $2 and type = 'authored_from'`,
        [fixture.doc, fixture.session, fixture.chat],
      );
    });
    expect((await counters(fixture.chat)).docs).toBe(1);
    expect((await counters(fixture.session)).docs).toBe(1);
  });

  it('retyping the only link to the same peer nets out', async () => {
    // session -> doc is now attached_to only; retype it to authored_from.
    await unedge(fixture.doc, fixture.chat, 'authored_from');
    await asOwner(async (client) => {
      await client.query(`select internal.w1_set_writer('entity_recorder')`);
      await client.query(
        `update public.edges set type = 'authored_from' where src_id = $1 and dst_id = $2 and type = 'attached_to'`,
        [fixture.doc, fixture.session],
      );
    });
    expect((await counters(fixture.session)).docs).toBe(1);
  });
});
