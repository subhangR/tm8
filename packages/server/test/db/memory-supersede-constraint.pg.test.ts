/**
 * ONE CORRECTION PER MEMORY (migration 190), against a real Postgres.
 *
 * A memory is never edited; a better one replaces it and points a `supersedes`
 * edge at what it replaces. Until 190 nothing stopped two people doing that to
 * the SAME memory at the same time, and the result was a fork: one claim, two
 * rival successors, each author believing theirs was now the current version.
 * The readers were taught to agree on a winner, which made the system
 * consistent without making it correct — the loser was never told.
 *
 * WHY THE CENTRAL TEST IS A RACE AND NOT A RULE. A rule test ("insert twice,
 * the second fails") passes just as happily against a pre-flight `select`
 * inside one transaction, which is exactly the mechanism that does NOT survive
 * two writers. So the first block below drives two live connections into the
 * window between check and write, and proves with `pg_stat_activity` that the
 * second one was actually BLOCKED on the index rather than merely arriving
 * after the first had finished. A refusal that only happens when you are slow
 * is not a constraint.
 *
 * What must stay legal is asserted with equal weight, because a constraint
 * that also forbids the right thing is worse than no constraint:
 *   · ONE correction replacing SEVERAL claims (consolidation — the Dreamer's
 *     standing brief tells it to do exactly this, many edges out of one new
 *     memory), and
 *   · correcting a correction, to any depth.
 *
 * And the readers' fork resolution must SURVIVE. The index means no new fork
 * can be created; it does not mean none can exist, since a restore from before
 * this migration or a bulk load with the index dropped can still present one.
 * The last block builds that fork on purpose — with the index dropped inside a
 * transaction that is then rolled back — and proves the reader still resolves
 * a head rather than throwing or picking nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { translateDbError } from '../../src/db/errors.js';
import { loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import type { Querier } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

const IDENTITY = 'mem-supersede-owner';

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (await client.query<Fixture>(
      `select $1::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId"`,
      [IDENTITY],
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Supersede owner')`,
      [f.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Supersede',$2)`,
      [f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [f.memberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Supersede owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    return f;
  });
}

/** A memory entity + detail row, seeded directly as the graph owner. */
async function mintMemory(statement: string): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'memory',null,0,$3)`,
      [id, fixture.spaceId, fixture.memberId],
    );
    await client.query(
      `insert into public.memories(entity_id,statement,mechanism,subject_scope,does_not_establish)
       values($1,$2,'measured in this suite','this scratch database','anything beyond it')`,
      [id, statement],
    );
    return id;
  });
}

/** The claims every caller of `write_edge` arrives with, on an open client. */
async function bindApp(client: PoolClient): Promise<void> {
  await client.query('set local role tm8_app');
  await client.query(
    `select set_config('tm8.identity_id',$1,true), set_config('tm8.actor_id','',true),
            set_config('tm8.node_admin','false',true), set_config('tm8.request_id','mem-190-pg',true)`,
    [fixture.identityId],
  );
}

const SUPERSEDE_SQL =
  `select public.write_edge($1::uuid, $2::uuid, 'supersedes', $3::jsonb, null, null) as result`;

/** The real door, through the app role, in its own transaction. */
async function supersede(successor: string, predecessor: string, reason: string): Promise<void> {
  await database.transaction(async (client) => {
    await bindApp(client);
    await client.query(SUPERSEDE_SQL, [successor, predecessor, JSON.stringify({ reason })]);
  });
}

interface PgErrorish { code?: string; message?: string; detail?: string }

async function refusalOf(fn: () => Promise<unknown>): Promise<PgErrorish> {
  try {
    await fn();
  } catch (error) {
    return error as PgErrorish;
  }
  throw new Error('expected the write to be refused, and it was not');
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('mem_supersede');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
});

describe('the constraint itself', () => {
  it('is a unique index on the TARGET of the edge, so a chain is linear by construction', async () => {
    const rows = await database.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname='public' and indexname='edges_supersedes_target_idx'`,
    );
    expect(rows).toHaveLength(1);
    // dst_id, never src_id: one claim is corrected once, but one correction
    // may replace many claims.
    expect(rows[0]!.indexdef).toMatch(/UNIQUE INDEX .* ON public\.edges USING btree \(dst_id\)/);
    expect(rows[0]!.indexdef).toMatch(/WHERE \(type = 'supersedes'::text\)/);
  });
});

describe('two people correcting the same memory at once', () => {
  it('one commits and the other is refused — and the loser really did BLOCK on the write', async () => {
    const claim = await mintMemory('the sweep runs at 02:00 UTC');
    const first = await mintMemory('the sweep runs at 04:00 UTC — read off the timer unit');
    const second = await mintMemory('the sweep runs at 05:00 UTC — read off the log');

    const a = await database.pool.connect();
    const b = await database.pool.connect();
    const watcher = await database.pool.connect();
    try {
      await a.query('begin');
      await bindApp(a);
      await b.query('begin');
      await bindApp(b);
      const bPid = (await b.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;

      // A writes its correction and holds the transaction open. The row is
      // uncommitted, so B cannot see it by reading — only by colliding.
      await a.query(SUPERSEDE_SQL, [first, claim, JSON.stringify({ reason: 'remeasured' })]);

      let settled = false;
      const bWrite = b
        .query(SUPERSEDE_SQL, [second, claim, JSON.stringify({ reason: 'remeasured too' })])
        .then(() => { settled = true; }, (error: unknown) => { settled = true; throw error; });
      // Swallow the eventual rejection here so the pending promise cannot trip
      // an unhandled-rejection guard while we are waiting on the lock.
      const outcome = bWrite.then(() => null, (error: unknown) => error as PgErrorish);

      // THE PROOF THIS IS A RACE: B is parked on a lock held by A's
      // uncommitted row, not merely running after it.
      const deadline = Date.now() + 20_000;
      let waiting = false;
      while (Date.now() < deadline && !waiting) {
        const rows = await watcher.query<{ wait_event_type: string | null }>(
          `select wait_event_type from pg_stat_activity where pid = $1`,
          [bPid],
        );
        waiting = rows.rows[0]?.wait_event_type === 'Lock';
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting, 'the second writer never blocked — this was a sequence, not a race').toBe(true);
      expect(settled, 'the second writer finished before the first committed').toBe(false);

      await a.query('commit');
      const error = await outcome;
      expect(error, 'the second correction was accepted; the fork is still possible').not.toBeNull();
      expect(error!.code).toBe('23505');
      await b.query('rollback');

      // Exactly one correction survived, and it is the one that committed.
      const edges = await database.query<{ src_id: string }>(
        `select src_id from public.edges where type='supersedes' and dst_id=$1`,
        [claim],
      );
      expect(edges.map((e) => e.src_id)).toEqual([first]);
    } finally {
      // Both transactions are closed before the clients go back to the pool,
      // whatever happened above. `release()` does not end an open transaction,
      // so a failed assertion part-way through would hand the next test a
      // connection still holding this one's locks — and the failure it caused
      // would look like a flake somewhere else entirely.
      await a.query('rollback').catch(() => undefined);
      await b.query('rollback').catch(() => undefined);
      a.release();
      b.release();
      watcher.release();
    }
  });

  it('the calm case takes the same path: a later second correction is refused identically', async () => {
    const claim = await mintMemory('the cache is flushed on deploy');
    const first = await mintMemory('the cache is flushed on deploy AND on config reload');
    const second = await mintMemory('the cache is never flushed automatically at all');
    await supersede(first, claim, 'found the reload path');

    const error = await refusalOf(() => supersede(second, claim, 'found nothing of the sort'));
    expect(error.code).toBe('23505');
  });
});

describe('what the person is told', () => {
  it('quotes the other correction, names no identifier, and says nothing about indexes', async () => {
    const claim = await mintMemory('deploys need a manual restart');
    const winner = await mintMemory('deploys restart the service themselves since the systemd unit landed');
    const loser = await mintMemory('deploys still need a manual restart on the private lane');
    await supersede(winner, claim, 'read the unit file');

    const error = await refusalOf(() => supersede(loser, claim, 'saw it hang once'));

    expect(error.message).toContain('Someone else corrected this memory first');
    expect(error.message).toContain('deploys restart the service themselves');
    expect(error.message).toContain('correct their version instead');
    // The failures this work exists to prevent.
    expect(error.message).not.toContain('duplicate key');
    expect(error.message).not.toContain('edges_supersedes_target_idx');
    expect(error.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(error.message).not.toContain('supersedes');
  });

  it('carries the other correction in full, as data the doors render themselves', async () => {
    const long = `A long correction. ${'It keeps going. '.repeat(30)}And it ends here.`;
    const claim = await mintMemory('the long one is short');
    const winner = await mintMemory(long);
    const loser = await mintMemory('a rival reading of the long one');
    await supersede(winner, claim, 'measured it');

    const error = await refusalOf(() => supersede(loser, claim, 'measured it differently'));
    const detail = JSON.parse(error.detail ?? '{}') as { reason?: string; correction?: string };
    expect(detail.reason).toBe('memory_already_corrected');
    expect(detail.correction).toBe(long);
    // The one-line message quotes only as far as a line allows and says so.
    expect(error.message).toContain('…');
    expect(error.message.length).toBeLessThan(long.length + 400);
  });

  it('reaches the graph edge-create door as a refusal that is not retryable', async () => {
    const claim = await mintMemory('the queue drains in a minute');
    const winner = await mintMemory('the queue drains in about nine minutes under load');
    const loser = await mintMemory('the queue never drains under load');
    await supersede(winner, claim, 'timed it');

    const raw = await refusalOf(() => supersede(loser, claim, 'timed it differently'));
    // The same translation every HTTP edge write goes through.
    const wire = translateDbError(raw) as {
      code: string; message: string; retryable: boolean;
      details?: { reason?: string; correction?: string };
    };
    expect(wire.code).toBe('invariant_violation');
    expect(wire.retryable).toBe(false);
    expect(wire.details?.reason).toBe('memory_already_corrected');
    expect(wire.details?.correction).toContain('nine minutes');
    expect(wire.message).toContain('Someone else corrected this memory first');
  });

  it('leaves every other unique violation on this table exactly as it was', async () => {
    // `created_in` is one-birth-session-per-entity (066). Two of them from one
    // source is a different unique index, and it must still answer in
    // Postgres's own words — the supersedes handler narrates ONE situation and
    // narrates nothing it cannot see.
    const memory = await mintMemory('a memory with two claimed birth sessions');
    const [one, two] = [await mintSession(), await mintSession()];
    await database.transaction(async (client) => {
      await bindApp(client);
      await client.query(
        `select public.write_edge($1::uuid,$2::uuid,'created_in','{}'::jsonb,null,null)`,
        [memory, one],
      );
    });

    const error = await refusalOf(() => database.transaction(async (client) => {
      await bindApp(client);
      await client.query(
        `select public.write_edge($1::uuid,$2::uuid,'created_in','{}'::jsonb,null,null)`,
        [memory, two],
      );
    }));
    expect(error.code).toBe('23505');
    expect(error.message).toContain('edges_created_in_source_idx');
    expect(error.message).not.toContain('Someone else corrected');
    // DETAIL survives the re-raise too. Postgres writes the offending key
    // there, and a handler that swallowed it would make every other unique
    // violation on this table harder to diagnose than it was before 190.
    expect(error.detail).toContain('already exists');
  });
});

/** A work session to hang a `created_in` claim on. */
async function mintSession(): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'work_session',null,0,$3)`,
      [id, fixture.spaceId, fixture.memberId],
    );
    await client.query(`insert into public.work_sessions(entity_id) values($1)`, [id]);
    return id;
  });
}

describe('what stays legal', () => {
  it('ONE correction may replace SEVERAL claims — the consolidation the Dreamer is told to do', async () => {
    const overlapping = await Promise.all([
      mintMemory('the sweep skips empty spaces'),
      mintMemory('the sweep skips spaces with no memories'),
      mintMemory('empty spaces are skipped by the nightly sweep'),
    ]);
    const merged = await mintMemory(
      'the nightly sweep skips any space holding no memories — one claim, three overlapping originals',
    );
    for (const claim of overlapping) await supersede(merged, claim, 'merged three overlaps into one');

    const rows = await database.query<{ dst_id: string }>(
      `select dst_id from public.edges where type='supersedes' and src_id=$1 order by dst_id`,
      [merged],
    );
    expect(rows.map((r) => r.dst_id).sort()).toEqual([...overlapping].sort());
  });

  it('a correction may itself be corrected, and the chain keeps going', async () => {
    const v1 = await mintMemory('the box has two lanes');
    const v2 = await mintMemory('the box has three lanes');
    const v3 = await mintMemory('the box has three lanes and a fourth that is enabled but down');
    await supersede(v2, v1, 'counted again');
    await supersede(v3, v2, 'counted the disabled one too');

    const rows = await database.query<{ src_id: string; dst_id: string }>(
      `select src_id, dst_id from public.edges where type='supersedes' and dst_id = any($1::uuid[])`,
      [[v1, v2]],
    );
    expect(rows).toHaveLength(2);
    // Depth three: v3 → v2 → v1, one line, no branch anywhere on it.
    expect(rows.find((r) => r.dst_id === v1)!.src_id).toBe(v2);
    expect(rows.find((r) => r.dst_id === v2)!.src_id).toBe(v3);
  });
});

describe('the readers keep their fork resolution, and here is the fork', () => {
  it('newest-wins still answers when a fork exists that this index could not have stopped', async () => {
    const claim = await mintMemory('a claim from before the index existed');
    const older = await mintMemory('the older of two rival corrections');
    const newer = await mintMemory('the newer of two rival corrections');

    // A fork can no longer be WRITTEN, so building one means standing the
    // index down — inside a transaction that is rolled back, so the drop and
    // the fork both vanish and no later test inherits either. DDL is
    // transactional in Postgres, which is what makes this safe.
    class Rollback extends Error {}
    const resolved = await database
      .transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query('drop index public.edges_supersedes_target_idx');
        await client.query(
          `insert into public.edges(space_id,src_id,dst_id,type,props,created_by,created_at)
           values($1,$2,$4,'supersedes',$5,$6,now() - interval '1 hour'),
                  ($1,$3,$4,'supersedes',$5,$6,now())`,
          [fixture.spaceId, older, newer, claim, JSON.stringify({ reason: 'legacy fork' }), fixture.memberId],
        );
        const q: Querier = {
          query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
            (await client.query(sql, [...params])).rows as R[],
          rpc: async () => { throw new Error('reads only'); },
        };
        const [summary] = await loadEntitySummariesByIds(q, [claim], fixture.identityId);
        const marks = summary?.badges.staleness?.superseded;
        throw Object.assign(new Rollback('done'), { marks });
      })
      .catch((error: unknown) => {
        if (error instanceof Rollback) return (error as Rollback & { marks?: unknown }).marks;
        throw error;
      });

    // The two halves of the readers' answer, and both must survive:
    //   `byId` is decided by NEWEST WINS — the tie-break the readers share,
    //   and the one this migration must not quietly make dead code;
    //   `headId` is decided by the chain walk, which still resolves a head
    //   rather than returning nothing, so a fork in historical data degrades
    //   to a choice and never to an outage.
    expect(resolved).toMatchObject({ byId: newer, depthTruncated: false });
    expect([older, newer]).toContain((resolved as { headId: string | null }).headId);

    // And the index is back, untouched, because the transaction rolled back.
    const still = await database.query(
      `select 1 from pg_indexes where indexname='edges_supersedes_target_idx'`,
    );
    expect(still).toHaveLength(1);
  });
});
