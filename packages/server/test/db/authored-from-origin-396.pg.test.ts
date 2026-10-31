/**
 * 396 (D31) — `edges_authored_from_source_idx` holds ONE session/chat origin per
 * source and lets bridge provenance edges (`props.bridgeId`, D22) sit beside it.
 * Proved against a REAL PostgreSQL with every migration applied to a fresh
 * database, then each reader that used to take "the" authored_from of a source
 * is given a source with TWO edges — the provenance edge written FIRST, so a
 * reader without the predicate would pick it up — and must still read the
 * origin.
 *
 * B0a has not registered the `bridge` kind yet, so the provenance edges here
 * point at an existing destination kind (a second work session or a chat)
 * with the marker set. The marker, not the destination, is what 396 keys on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';

import { sessionChatOrigins } from '../../src/db/authored-origins.js';
import type { Querier } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  space: string;
  member: string;
  other: string;
  sessionA: string;
  sessionB: string;
  chat: string;
  doc: string;
  doc2: string;
  task: string;
  story: string;
  form: string;
  message: string;
  claim: string;
  evidence: string;
}

const IDENTITY = 'origin396-member';
let database: W1ScratchDatabase;
let fixture: Fixture;

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/**
 * One server-written authored_from, as the entity recorder writes it. 399
 * (B1b-3) now refuses a bridgeId-marked edge whose destination is not a bridge
 * or a message; these fixtures keep pointing the marker at a session or chat on
 * purpose (a reader that forgot the predicate would then pick it up), so that
 * one guard is lifted for the insert, inside its own transaction.
 */
async function authored(src: string, dst: string, props: Record<string, unknown> = {}): Promise<string> {
  return asOwner(async (client) => {
    const marked = 'bridgeId' in props;
    if (marked) await client.query('alter table public.edges disable trigger edges_authored_from_bridge');
    await client.query(`select internal.w1_set_writer('entity_recorder')`);
    const { rows } = await client.query<{ id: string }>(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by, props)
       values ($1, $2, $3, 'authored_from', $4, $5::jsonb) returning id::text`,
      [fixture.space, src, dst, fixture.member, JSON.stringify(props)],
    );
    // Fire any deferred constraint triggers on edges first (F's bridge-fix trigger
    // watches bridge-marked edges): ALTER TABLE refuses a table with pending trigger events.
    if (marked) await client.query('set constraints all immediate');
    if (marked) await client.query('alter table public.edges enable trigger edges_authored_from_bridge');
    return rows[0]!.id;
  });
}

const provenance = (bridgeId: string) => ({ bridgeId, origins: [{ providerMessageId: 'wamid.1' }] });

beforeAll(async () => {
  database = await createW1ScratchDatabase('origin_396');
  database.apply(migrationFiles());

  fixture = await asOwner(async (client) => {
    const ids = (
      await client.query<Fixture>(
        `select internal.new_id()::text "space", internal.new_id()::text "member",
                internal.new_id()::text "other", internal.new_id()::text "sessionA",
                internal.new_id()::text "sessionB", internal.new_id()::text "chat",
                internal.new_id()::text "doc", internal.new_id()::text "doc2",
                internal.new_id()::text "task", internal.new_id()::text "story",
                internal.new_id()::text "form", internal.new_id()::text "message",
                internal.new_id()::text "claim", internal.new_id()::text "evidence"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'Member')`,
      [IDENTITY],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Origin 396', $2)`,
      [ids.space, IDENTITY],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
         ($2, $1, 'member', 0, $2), ($3, $1, 'member', 1, $3),
         ($4, $1, 'work_session', 2, $2), ($5, $1, 'work_session', 3, $2),
         ($6, $1, 'chat', 4, $2), ($7, $1, 'doc', 5, $2), ($8, $1, 'doc', 6, $2),
         ($9, $1, 'task', 7, $2), ($10, $1, 'story', 8, $2), ($11, $1, 'form', 9, $2),
         ($12, $1, 'message', 10, $2), ($13, $1, 'memory', 11, $2), ($14, $1, 'memory', 12, $3)`,
      [ids.space, ids.member, ids.other, ids.sessionA, ids.sessionB, ids.chat, ids.doc, ids.doc2,
        ids.task, ids.story, ids.form, ids.message, ids.claim, ids.evidence],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', 'Member')`,
      [ids.member, ids.space, IDENTITY],
    );
    await client.query(
      `insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body)
       values ($1, $2, null, $3, 'on it')`,
      [ids.message, ids.task, ids.member],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'contains', $4)`,
      [ids.space, ids.story, ids.task, ids.member],
    );
    return ids;
  });
}, 300_000);

afterAll(async () => {
  await database?.destroy();
});

describe('396 edges_authored_from_source_idx', () => {
  it('is narrowed to the session/chat origin', async () => {
    const [row] = await database.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where indexname = 'edges_authored_from_source_idx'`,
    );
    expect(row!.indexdef).toContain(`(type = 'authored_from'::text) AND (NOT (props ? 'bridgeId'::text))`);
  });

  it('accepts provenance edges beside the origin and still refuses a second origin', async () => {
    await authored(fixture.doc, fixture.sessionA);
    await authored(fixture.doc, fixture.chat, provenance(fixture.chat));
    await authored(fixture.doc, fixture.sessionB, provenance(fixture.sessionB));
    const rows = await database.query<{ n: string }>(
      `select count(*)::text n from public.edges where src_id = $1 and type = 'authored_from'`,
      [fixture.doc],
    );
    expect(rows[0]!.n).toBe('3');

    // A second session/chat origin on the same source is still refused.
    await expect(authored(fixture.doc2, fixture.sessionA).then(() => authored(fixture.doc2, fixture.chat)))
      .rejects.toThrow(/edges_authored_from_source_idx/);
  });

  it('refuses a marker that is not a string (props schema)', async () => {
    await expect(authored(fixture.claim, fixture.chat, { bridgeId: 7 })).rejects.toThrow(/bridgeId has the wrong type/);
  });
});

describe('396 readers take the session/chat origin, never bridge provenance', () => {
  beforeAll(async () => {
    // Provenance FIRST on every source, then the origin.
    await authored(fixture.task, fixture.sessionB, provenance(fixture.sessionB));
    await authored(fixture.task, fixture.sessionA);
    await authored(fixture.form, fixture.sessionB, provenance(fixture.sessionB));
    await authored(fixture.form, fixture.sessionA);
    await authored(fixture.message, fixture.sessionB, provenance(fixture.sessionB));
    await authored(fixture.message, fixture.sessionA);
    await authored(fixture.claim, fixture.sessionA);
    await authored(fixture.evidence, fixture.sessionA, provenance(fixture.sessionA));
    await authored(fixture.evidence, fixture.sessionB);
  });

  it('record_authored_from returns the existing origin edge', async () => {
    const [origin] = await database.query<{ id: string }>(
      `select id::text from public.edges
        where src_id = $1 and type = 'authored_from' and not (props ? 'bridgeId')`,
      [fixture.task],
    );
    const [row] = await database.query<{ id: string }>(
      `select public.record_authored_from($1, $2)::text id`, [fixture.task, fixture.chat],
    );
    expect(row!.id).toBe(origin!.id);
  });

  it('form_requesting_session names the origin session', async () => {
    const [row] = await database.query<{ id: string }>(
      `select internal.form_requesting_session($1)::text id`, [fixture.form],
    );
    expect(row!.id).toBe(fixture.sessionA);
  });

  it('w2_task_conversation_sessions: OPENED and SPOKEN arms read only the origin', async () => {
    const rows = await database.query<{ id: string }>(
      `select work_session_id::text id from internal.w2_task_conversation_sessions($1, '{}'::uuid[])`,
      [fixture.task],
    );
    expect(rows.map((r) => r.id)).toEqual([fixture.sessionA]);
  });

  it('verification independence compares origins, not provenance', async () => {
    // evidence's provenance points at the claim's own session; its origin does not.
    await asOwner(async (client) => {
      const [{ version }] = (await client.query<{ version: number }>(
        `select version from public.entities where id = $1`, [fixture.claim],
      )).rows as [{ version: number }];
      await client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by, props)
         values ($1, $2, $3, 'verifies', $4, $5::jsonb)`,
        [fixture.space, fixture.evidence, fixture.claim, fixture.other, JSON.stringify({
          mechanism: 'reran it', answers: [], pinnedVersion: version, independenceBasis: 'session',
        })],
      );
    });
  });

  it('the story walk does not follow bridge provenance', async () => {
    const rows = await database.query<{ id: string }>(
      `select entity_id::text id from internal.story_trail($1)`, [fixture.story],
    );
    const reached = rows.map((r) => r.id);
    expect(reached).toContain(fixture.task);
    expect(reached).toContain(fixture.sessionA);
    expect(reached).not.toContain(fixture.sessionB);

    const containing = await database.query<{ id: string }>(
      `select s::text id from public.stories_containing($1) s`, [fixture.sessionB],
    );
    expect(containing).toEqual([]);
  });

  it('sessionChatOrigins (messages, feed, event mapper) maps a source to its origin', async () => {
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
        (await database.pool.query(sql, [...params])).rows as R[],
      rpc: async () => {
        throw new Error('no rpc in this read');
      },
    };
    const origins = await sessionChatOrigins(q, [fixture.message, fixture.doc]);
    expect(Object.fromEntries(origins)).toEqual({
      [fixture.message]: fixture.sessionA,
      [fixture.doc]: fixture.sessionA,
    });
  });
});
