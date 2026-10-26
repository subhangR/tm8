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

import type { CollectionQuery } from '@tm8/contract';
import type { Querier } from '../../src/db/types.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';
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
  session3: string;
}

interface Counts {
  docs: number;
  memories: number;
  prs: number;
  artifacts: number;
  drawings: number;
  sessions: number;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function counters(entity: string): Promise<Counts> {
  const [row] = await database.query<Counts>(
    `select docs, memories, prs, artifacts, drawings, sessions from public.entity_counters where entity_id = $1`,
    [entity],
  );
  return {
    docs: Number(row!.docs),
    memories: Number(row!.memories),
    prs: Number(row!.prs),
    artifacts: Number(row!.artifacts),
    drawings: Number(row!.drawings),
    sessions: Number(row!.sessions),
  };
}

const zero: Counts = { docs: 0, memories: 0, prs: 0, artifacts: 0, drawings: 0, sessions: 0 };

async function asOwner<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const IDENTITY = 'links331-member';

/** `filters.launchedBy` (331): the sessions these launchers started, by fixture name. */
async function launchedBy(...launchers: (keyof Fixture)[]): Promise<string[]> {
  const query: CollectionQuery = {
    spaceId: fixture.space as CollectionQuery['spaceId'],
    filters: { launchedBy: launchers.map((name) => fixture[name]) as never },
    limit: 50,
  };
  const result = await database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true), set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true), set_config('tm8.auth_kind', 'browser', true),
              set_config('tm8.request_id', 'req-links-331', true)`,
      [IDENTITY],
    );
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
        (await client.query(sql, [...params])).rows as R[],
      rpc: async () => {
        throw new Error('no rpc in this read');
      },
    };
    return queryCollection(q, query, IDENTITY);
  });
  const names = new Map(Object.entries(fixture).map(([name, value]) => [value, name]));
  return result.page.items.map((item) => names.get(item.id) ?? item.id).sort();
}

// `authored_from` is recorder-owned (308) and `launched_by` spawn-owned
// (330), so the fixture writes as those writers, exactly as the server does.
const WRITER: Record<string, string> = { authored_from: 'entity_recorder', launched_by: 'spawn' };

async function edge(src: string, dst: string, type: string): Promise<void> {
  await asOwner(async (client) => {
    if (WRITER[type]) await client.query(`select internal.w1_set_writer($1)`, [WRITER[type]]);
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, $4, $5)`,
      [fixture.space, src, dst, type, fixture.member],
    );
  });
}

async function unedge(src: string, dst: string, type: string): Promise<void> {
  await asOwner(async (client) => {
    if (WRITER[type]) await client.query(`select internal.w1_set_writer($1)`, [WRITER[type]]);
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
                internal.new_id()::text "memory", internal.new_id()::text "message",
                internal.new_id()::text "session3"`,
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
         ($11, $1, 'memory', 9, $2), ($12, $1, 'message', 10, $2), ($13, $1, 'work_session', 11, $2)`,
      [ids.space, ids.member, ids.task, ids.session, ids.session2, ids.chat, ids.doc, ids.pr,
        ids.artifact, ids.drawing, ids.memory, ids.message, ids.session3],
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
    // Launches: the chat launched the session, the session launched
    // session2 (which ALSO records authored_from to it, 327) and session3.
    await client.query(`select internal.w1_set_writer('spawn')`);
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by) values
         ($1, $2, $3, 'launched_by', $6), ($1, $4, $2, 'launched_by', $6), ($1, $5, $2, 'launched_by', $6)`,
      [ids.space, ids.session, ids.chat, ids.session2, ids.session3, ids.member],
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
    expect(await counters(fixture.session)).toEqual({
      docs: 1, memories: 1, prs: 1, artifacts: 1, drawings: 0, sessions: 2,
    });
  });

  it('counts what a chat created, and not its messages', async () => {
    expect(await counters(fixture.chat)).toEqual({ ...zero, drawings: 1, sessions: 1 });
  });

  it('filters.launchedBy lists the sessions the given launchers started', async () => {
    expect(await launchedBy('chat')).toEqual(['session']);
    expect(await launchedBy('session')).toEqual(['session2', 'session3']);
    expect(await launchedBy('chat', 'session')).toEqual(['session', 'session2', 'session3']);
    expect(await launchedBy('task')).toEqual([]);
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

  it('a launched session counts once on its launcher, through launched_by alone', async () => {
    // session2 also holds authored_from -> session; dropping launched_by
    // still uncounts it, and the authored_from alone never counted it.
    await unedge(fixture.session2, fixture.session, 'launched_by');
    expect((await counters(fixture.session)).sessions).toBe(1);
    await edge(fixture.session2, fixture.session, 'launched_by');
    expect((await counters(fixture.session)).sessions).toBe(2);
    // A launched_by re-pointed from the chat to session2 nets out.
    await asOwner(async (client) => {
      await client.query(`select internal.w1_set_writer('spawn')`);
      await client.query(
        `update public.edges set dst_id = $3 where src_id = $1 and dst_id = $2 and type = 'launched_by'`,
        [fixture.session3, fixture.session, fixture.session2],
      );
    });
    expect((await counters(fixture.session)).sessions).toBe(1);
    expect((await counters(fixture.session2)).sessions).toBe(1);
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
