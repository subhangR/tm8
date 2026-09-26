/**
 * Migration 254 — an attention write keeps the FULL entity.upsert (Attention v2
 * S2, G3), and every other recency touch keeps 165's THIN event.
 *
 * Every attention writer ends in `update entities set activity_at = now(),
 * updated_at = now()`. Before 254 that was an `entity.activity_touched` with no
 * summary, so no open client's tile or graph saw the badge move. The badge is
 * computed by the projector (`attention_badges`, 252), so all the log has to do
 * is hand it a full `entity.upsert` to project.
 *
 * The writes below are the RPCs' own statements, run directly: the mechanism is
 * a trigger on `attention_requests`, so it is the table write that must flag,
 * whichever RPC (or future writer) issued it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  taskId: string;
  otherId: string;
}

/** A statement and the fixture ids bound to its $1..$n, in order. */
type Statement = readonly [string, readonly (keyof Fixture)[]];
type Emitted = Record<string, { type: string; payload: Record<string, unknown> }[]>;

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const fixture = (await client.query<Fixture>(
      `select 'attention-full-upsert'::text "identityId",
              internal.new_id()::text "spaceId", internal.new_id()::text "memberId",
              internal.new_id()::text "taskId",  internal.new_id()::text "otherId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Attention owner')`,
      [fixture.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Attention events',$2)`,
      [fixture.spaceId, fixture.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1), ($3,$2,'task',null,1,$1), ($4,$2,'task',null,2,$1)`,
      [fixture.memberId, fixture.spaceId, fixture.taskId, fixture.otherId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Attention owner')`,
      [fixture.memberId, fixture.spaceId, fixture.identityId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title,work_status) values($1,'Probe','open'),($2,'Other','open')`,
      [fixture.taskId, fixture.otherId],
    );
    return fixture;
  });
}

describe.sequential('attention writes emit the full entity.upsert (migration 254)', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('attention_full_upsert');
    database.apply(migrationFiles());
    fixture = await seed(database);
  }, 180_000);

  afterAll(async () => database?.destroy(), 30_000);

  /**
   * Run `statements` in ONE transaction as the owner and report the entity
   * events each fixture entity got from it, keyed by `taskId` / `otherId`.
   * `now()` is transaction-stable, so each call is its own transaction — a
   * second touch in the same one would move nothing and emit nothing.
   */
  async function emitted(statements: Statement[]): Promise<Emitted> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const mark = (await client.query<{ seq: string | null }>(
        `select max(seq)::text seq from public.workspace_events where space_id = $1`,
        [fixture.spaceId],
      )).rows[0]!.seq ?? '0';
      for (const [sql, keys] of statements) await client.query(sql, keys.map((k) => fixture[k]));
      const rows = (await client.query<{ id: string; event_type: string; payload: Record<string, unknown> }>(
        `select payload->>'id' id, event_type, payload from public.workspace_events
          where space_id = $1 and seq > $2::bigint and event_type like 'entity.%'
            and (payload->>'id')::uuid in ($3, $4)
          order by seq`,
        [fixture.spaceId, mark, fixture.taskId, fixture.otherId],
      )).rows;
      const out: Emitted = { taskId: [], otherId: [] };
      for (const r of rows) {
        out[r.id === fixture.taskId ? 'taskId' : 'otherId']!.push({ type: r.event_type, payload: r.payload });
      }
      return out;
    });
  }

  const TOUCH_SQL = `update public.entities set activity_at = now(), updated_at = now() where id = $1`;
  const TOUCH_TASK: Statement = [TOUCH_SQL, ['taskId']];
  const TOUCH_OTHER: Statement = [TOUCH_SQL, ['otherId']];
  // 050 create_attention_request's request insert (its touch follows it).
  const CREATE: Statement = [
    `insert into public.attention_requests(space_id, entity_id, reason, points, requested_by)
     values ($1, $2, 'Look at this', 40, $3)`,
    ['spaceId', 'taskId', 'memberId'],
  ];
  // 050 resolve_entity_attention's request update (its touch follows it).
  const RESOLVE: Statement = [
    `update public.attention_requests
        set status = 'resolved', resolved_at = now(), version = version + 1
      where entity_id = $1 and status in ('open', 'acknowledged')`,
    ['taskId'],
  ];

  const types = (events: Emitted[string]) => events.map((e) => e.type);

  it('a plain activity_at touch is still the THIN entity.activity_touched (165 kept)', async () => {
    const events = await emitted([TOUCH_TASK]);
    expect(types(events.taskId!)).toEqual(['entity.activity_touched']);
    expect(Object.keys(events.taskId![0]!.payload).sort()).toEqual(['activity_at', 'id', 'kind']);
  });

  it('an attention CREATE keeps the FULL entity.upsert for its entity', async () => {
    const events = await emitted([CREATE, TOUCH_TASK]);
    expect(types(events.taskId!)).toEqual(['entity.upsert']);
    // A full row, which the projector turns into a summary carrying the badge.
    expect(Object.keys(events.taskId![0]!.payload)).toEqual(
      expect.arrayContaining(['space_id', 'created_by', 'version', 'activity_at']),
    );
  });

  it('an attention RESOLVE keeps the FULL entity.upsert for its entity', async () => {
    const events = await emitted([RESOLVE, TOUCH_TASK]);
    expect(types(events.taskId!)).toEqual(['entity.upsert']);
  });

  it('the flag is per entity: another entity touched in the same transaction stays thin', async () => {
    const events = await emitted([CREATE, TOUCH_TASK, TOUCH_OTHER]);
    expect(types(events.taskId!)).toEqual(['entity.upsert']);
    expect(types(events.otherId!)).toEqual(['entity.activity_touched']);
  });

  /**
   * On ONE pooled connection, which is how the server's pool reuses them: a
   * session-level flag would make every later touch of this entity, by any
   * request that drew this connection, a full upsert forever.
   */
  it('the flag dies with its transaction: the next touch on the same connection is thin again', async () => {
    const client = await database.pool.connect();
    try {
      const run = async ([sql, keys]: Statement) => {
        await client.query('begin');
        await client.query('set local role tm8_graph_owner');
        await client.query(sql, keys.map((k) => fixture[k]));
        await client.query(TOUCH_SQL, [fixture.taskId]);
        const flag = (await client.query<{ flag: string | null }>(
          `select current_setting('tm8.attention_changed', true) flag`,
        )).rows[0]!.flag;
        const last = (await client.query<{ event_type: string }>(
          `select event_type from public.workspace_events
            where space_id = $1 and (payload->>'id')::uuid = $2 order by seq desc limit 1`,
          [fixture.spaceId, fixture.taskId],
        )).rows[0]!.event_type;
        await client.query('commit');
        return { flag, last };
      };
      const attention = await run(CREATE);
      expect(attention).toEqual({ flag: fixture.taskId, last: 'entity.upsert' });
      // A statement that writes nothing, so the touch is the whole transaction.
      const plain = await run(['select $1::uuid', ['otherId']]);
      expect(plain).toEqual({ flag: '', last: 'entity.activity_touched' });
    } finally {
      client.release();
    }
  });

  it('an edge write in a flag-free transaction still thins both endpoints', async () => {
    const events = await emitted([[
      `insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'relates_to',$4)`,
      ['spaceId', 'taskId', 'otherId', 'memberId'],
    ]]);
    expect(types(events.taskId!)).toEqual(['entity.activity_touched']);
    expect(types(events.otherId!)).toEqual(['entity.activity_touched']);
  });

  /**
   * THE NEGATIVE CONTROL for the tests above: with the flag trigger disabled,
   * the exact create-then-touch sequence falls back to 165's thin event. If this
   * ever emits a full upsert, the tests above are passing for some other reason.
   */
  it('without the flag trigger the same attention write is thin (the trigger is what does it)', async () => {
    const events = await database.transaction(async (client) => {
      await client.query('alter table public.attention_requests disable trigger attention_requests_flag_changed');
      await client.query('set local role tm8_graph_owner');
      const mark = (await client.query<{ seq: string }>(
        `select coalesce(max(seq), 0)::text seq from public.workspace_events where space_id = $1`,
        [fixture.spaceId],
      )).rows[0]!.seq;
      await client.query(
        `insert into public.attention_requests(space_id, entity_id, reason, points, requested_by)
         values ($1, $2, 'Control', 10, $3)`,
        [fixture.spaceId, fixture.taskId, fixture.memberId],
      );
      await client.query(TOUCH_SQL, [fixture.taskId]);
      const rows = (await client.query<{ event_type: string }>(
        `select event_type from public.workspace_events
          where space_id = $1 and seq > $2::bigint and (payload->>'id')::uuid = $3 order by seq`,
        [fixture.spaceId, mark, fixture.taskId],
      )).rows.map((r) => r.event_type);
      await client.query('reset role');
      await client.query('alter table public.attention_requests enable trigger attention_requests_flag_changed');
      return rows;
    });
    expect(events).toEqual(['entity.activity_touched']);
  });
});
