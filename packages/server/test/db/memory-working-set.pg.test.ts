/**
 * 084 + the spawn-time memory read (Dreamer/Dispatcher P1, design §4.1–4.2).
 *
 * Two facts under test, each against the REAL chain and the REAL reader:
 *  1. Migration 084 converts every `team_members.memories` jsonb entry into a
 *     056 memory entity + `remembers` edge and EMPTIES the column — so the
 *     suite applies the chain up to 083's position first, seeds jsonb the way
 *     a pre-084 node would have, and only then applies 084.
 *  2. `DbGraphPort.loadSpawnContext` composes the injected set from the graph:
 *     the `remembers` working set (superseded entries dropped, disputed ones
 *     marked), requested `memoryIds` appended in caller order, refused loudly
 *     when absent, and any legacy jsonb remainder still riding along.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../src/db/types.js';
import { DbGraphPort } from '../../src/facade/execution-handlers.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const MIGRATION_084 = '084_memory_working_set.sql';
const MIGRATION_085 = '085_memory_any_holder.sql';

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teamMemberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seedPre084(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (await client.query<Fixture>(
      `select 'mem-working-set-owner'::text "identityId",
              internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId",
              internal.new_id()::text "teamMemberId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Working set owner')`,
      [f.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Working set',$2)`,
      [f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'team_member',null,1,$1)`,
      [f.memberId, f.teamMemberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Working set owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    // The pre-084 world: a persona carrying jsonb memories, exactly what the
    // teammate editor wrote. One non-string entry proves the conversion does
    // not choke on shapes the column's array check never forbade.
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity,memories)
       values($1,$2,'Carrier','','persona text',
              '["prefers scoped tsc over full builds","  ",{"freeform":"object entry"}]'::jsonb)`,
      [f.teamMemberId, f.memberId],
    );
    return f;
  });
}

/** A memory entity + detail row + optional `remembers` edge, as the graph owner. */
async function mintMemory(statement: string, remembered: boolean): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'memory',null,0,$3)`,
      [id, fixture.spaceId, fixture.teamMemberId],
    );
    await client.query(
      `insert into public.memories(entity_id,statement,mechanism,subject_scope,does_not_establish)
       values($1,$2,'direct seed','this scratch database','runtime behavior')`,
      [id, statement],
    );
    if (remembered) {
      await client.query(
        `insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
         values($1,$2,$3,'remembers','{}'::jsonb,$2)`,
        [fixture.spaceId, fixture.teamMemberId, id],
      );
    }
    return id;
  });
}

async function drawEdge(
  src: string, dst: string, type: string, props: Record<string, unknown>,
): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
       values($1,$2,$3,$4,$5,$6)`,
      [fixture.spaceId, src, dst, type, JSON.stringify(props), fixture.teamMemberId],
    );
  });
}

/**
 * The REAL reader over the scratch pool. loadSpawnContext only uses tx+query;
 * the owner role stands in for RLS because row visibility is not under test.
 */
function graphPort(): DbGraphPort {
  const db = {
    tx: async <T>(_claims: unknown, fn: (q: unknown) => Promise<T>): Promise<T> =>
      database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        return fn({
          query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
            (await client.query(sql, [...params])).rows as R[],
          rpc: async () => { throw new Error('loadSpawnContext must not rpc'); },
        });
      }),
  } as unknown as Db;
  return new DbGraphPort(db);
}

async function injectedMemories(
  memoryIds?: string[],
  taskIds?: string[],
): Promise<unknown[]> {
  const context = await graphPort().loadSpawnContext({} as never, {
    spaceId: fixture.spaceId,
    teamMemberId: fixture.teamMemberId,
    ...(memoryIds ? { memoryIds } : {}),
    ...(taskIds ? { taskIds } : {}),
  });
  return context.teamMember.memories;
}

/** A bare task entity + detail row — a `remembers` HOLDER under D9 (085). */
async function mintTask(title: string): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'task',null,0,$3)`,
      [id, fixture.spaceId, fixture.teamMemberId],
    );
    await client.query(`insert into public.tasks(entity_id,title) values($1,$2)`, [id, title]);
    return id;
  });
}

/** A work_session the fixture teammate participates in — the D10 author. */
async function mintSession(): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'work_session',null,0,$3)`,
      [id, fixture.spaceId, fixture.teamMemberId],
    );
    await client.query(`insert into public.work_sessions(entity_id) values($1)`, [id]);
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
       values($1,$2,$3,'participates_in','{}'::jsonb,$2)`,
      [fixture.spaceId, fixture.teamMemberId, id],
    );
    return id;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('memory_working_set');
  const files = migrationFiles();
  expect(files).toContain(MIGRATION_084);
  expect(files).toContain(MIGRATION_085);
  // Pre-084 world: everything BEFORE the two memory migrations, in order —
  // then seed the jsonb the way a live node would have it, then apply 084
  // and 085 exactly as an upgrade would.
  database.apply(files.filter((f) => f !== MIGRATION_084 && f !== MIGRATION_085));
  fixture = await seedPre084(database);
  database.apply([MIGRATION_084, MIGRATION_085]);
});

afterAll(async () => {
  await database?.destroy();
});

describe('084 jsonb → entity conversion', () => {
  it('converts each non-blank jsonb entry into a memory entity with a remembers edge', async () => {
    const rows = await database.query<{ statement: string }>(
      `select m.statement
         from public.edges r
         join public.memories m on m.entity_id = r.dst_id
        where r.type = 'remembers' and r.src_id = $1
        order by m.statement`,
      [fixture.teamMemberId],
    );
    // The blank entry ("  ") was skipped; the object entry became its text.
    // Set comparison: text collation order over punctuation is locale noise.
    expect(rows.map((r) => r.statement).sort()).toEqual(
      ['{"freeform": "object entry"}', 'prefers scoped tsc over full builds'].sort(),
    );
  });

  it('empties the jsonb column but keeps it (two-step retirement)', async () => {
    const rows = await database.query<{ memories: unknown }>(
      `select memories from public.team_members where entity_id = $1`,
      [fixture.teamMemberId],
    );
    expect(rows[0]!.memories).toEqual([]);
  });

  it('records an initial entity version for each converted memory', async () => {
    const rows = await database.query<{ count: string }>(
      `select count(*)::text count
         from public.entity_versions v
         join public.edges r on r.dst_id = v.entity_id and r.type = 'remembers'
        where r.src_id = $1`,
      [fixture.teamMemberId],
    );
    expect(rows[0]!.count).toBe('2');
  });
});

describe('loadSpawnContext memory composition', () => {
  it('injects the remembers working set as statement strings', async () => {
    const memories = await injectedMemories();
    expect(memories).toContain('prefers scoped tsc over full builds');
    expect(memories).toContain('{"freeform": "object entry"}');
  });

  it('drops superseded memories from the working set and marks disputed ones', async () => {
    const doomed = await mintMemory('stale claim about the build', true);
    const successor = await mintMemory('current claim about the build', false);
    await drawEdge(successor, doomed, 'supersedes', { reason: 'measured again' });

    const disputed = await mintMemory('contested claim', true);
    const evidence = await mintMemory('the counter-measurement', false);
    await drawEdge(evidence, disputed, 'disputes', {
      quote: 'contested claim',
      expected: 'x',
      observed: 'y',
      pinnedVersion: 1,
    });

    const memories = await injectedMemories();
    expect(memories).not.toContain('stale claim about the build');
    expect(memories).toContain('contested claim [disputed]');
  });

  it('appends requested memoryIds after the working set, in caller order', async () => {
    const a = await mintMemory('requested only: alpha', false);
    const b = await mintMemory('requested only: beta', false);
    const memories = await injectedMemories([b, a]);
    const tail = memories.slice(-2);
    expect(tail).toEqual(['requested only: beta', 'requested only: alpha']);
  });

  it('injects a requested-but-superseded memory WITH its marker rather than dropping it', async () => {
    const doomed = await mintMemory('explicitly wanted stale note', false);
    const successor = await mintMemory('its successor', false);
    await drawEdge(successor, doomed, 'supersedes', { reason: 'superseded for the test' });
    const memories = await injectedMemories([doomed]);
    expect(memories).toContain('explicitly wanted stale note [superseded]');
  });

  it('refuses a spawn naming a memory that does not exist in this space', async () => {
    await expect(
      injectedMemories(['00000000-0000-7000-8000-000000000000']),
    ).rejects.toThrow(/memoryIds not found/);
  });

  it('still injects any legacy jsonb remainder written by a pre-cutover editor', async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.team_members set memories = '["fresh jsonb entry"]'::jsonb
          where entity_id = $1`,
        [fixture.teamMemberId],
      );
    });
    const memories = await injectedMemories();
    expect(memories).toContain('fresh jsonb entry');
    // Graph set first, legacy remainder after.
    expect(memories.indexOf('fresh jsonb entry'))
      .toBeGreaterThan(memories.indexOf('prefers scoped tsc over full builds'));
  });
});

describe('085 D9 — any holder, task working sets at spawn', () => {
  it('widens remembers src_kinds to the any-kind wildcard', async () => {
    const rows = await database.query<{ src_kinds: string[] }>(
      `select src_kinds from public.edge_types where type = 'remembers'`,
    );
    expect(rows[0]!.src_kinds).toEqual(['*']);
  });

  it('accepts remembers(task → memory) — refused before 085', async () => {
    const task = await mintTask('holder task');
    const memory = await mintMemory('what the task knows', false);
    // Would raise via internal.validate_edge pre-085 (src task not in
    // {member,team_member,work_session}); passing IS the widening proof.
    await drawEdge(task, memory, 'remembers', {});
    const rows = await database.query<{ count: string }>(
      `select count(*)::text count from public.edges
        where type = 'remembers' and src_id = $1 and dst_id = $2`,
      [task, memory],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('injects task-remembered memories after the persona set, before requested ids', async () => {
    const task = await mintTask('spawn task');
    const taskMemory = await mintMemory('task context: deploy quirk', false);
    await drawEdge(task, taskMemory, 'remembers', {});
    const requested = await mintMemory('explicitly requested extra', false);

    const memories = await injectedMemories([requested], [task]);
    const persona = memories.indexOf('prefers scoped tsc over full builds');
    const fromTask = memories.indexOf('task context: deploy quirk');
    const extra = memories.indexOf('explicitly requested extra');
    expect(persona).toBeGreaterThanOrEqual(0);
    expect(fromTask).toBeGreaterThan(persona);
    expect(extra).toBeGreaterThan(fromTask);
  });

  it('drops a superseded task-remembered memory like any working-set entry', async () => {
    const task = await mintTask('stale-context task');
    const doomed = await mintMemory('task memory now stale', false);
    await drawEdge(task, doomed, 'remembers', {});
    const successor = await mintMemory('task memory, corrected', false);
    await drawEdge(successor, doomed, 'supersedes', { reason: 'remeasured' });

    const memories = await injectedMemories(undefined, [task]);
    expect(memories).not.toContain('task memory now stale');
  });

  it('a spawn with no taskIds injects no task sets (persona set unchanged)', async () => {
    const memories = await injectedMemories();
    expect(memories).not.toContain('task context: deploy quirk');
  });
});

describe('085 D10 — the authoring session remembers', () => {
  async function createViaDoor(statement: string, sessionId: string | null): Promise<string> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id',$1,true), set_config('tm8.actor_id','',true),
                set_config('tm8.node_admin','false',true), set_config('tm8.request_id','mem-085-pg',true)`,
        [fixture.identityId],
      );
      const rows = (await client.query(
        `select public.create_memory($1,$2,'measured in this test','the 085 suite',
                'anything beyond this scratch db',null,$3,null,$4,null) as result`,
        [fixture.spaceId, statement, fixture.teamMemberId, sessionId],
      )).rows as Array<{ result: { entity: { id: string } } }>;
      return rows[0]!.result.entity.id;
    });
  }

  it('create_memory with a session writes remembers(session → memory) beside authored_from', async () => {
    const session = await mintSession();
    const memoryId = await createViaDoor('authored inside a session', session);
    const rows = await database.query<{ type: string; src_id: string; dst_id: string }>(
      `select type, src_id, dst_id from public.edges
        where (type = 'remembers' and src_id = $1 and dst_id = $2)
           or (type = 'authored_from' and src_id = $2 and dst_id = $1)
        order by type`,
      [session, memoryId],
    );
    expect(rows.map((r) => r.type)).toEqual(['authored_from', 'remembers']);
  });

  it('create_memory without a session writes no remembers edge (nothing to author from)', async () => {
    const memoryId = await createViaDoor('authored by nobody in particular', null);
    const rows = await database.query<{ count: string }>(
      `select count(*)::text count from public.edges
        where type = 'remembers' and dst_id = $1`,
      [memoryId],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('still refuses a session the actor does not participate in (056 guard intact)', async () => {
    // A session with NO participates_in edge for the acting teammate.
    const orphanSession = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'work_session',null,0,$3)`,
        [id, fixture.spaceId, fixture.teamMemberId],
      );
      await client.query(`insert into public.work_sessions(entity_id) values($1)`, [id]);
      return id;
    });
    await expect(createViaDoor('forged provenance attempt', orphanSession))
      .rejects.toThrow(/authored_from provenance does not match/);
  });
});
