/**
 * 088 + the spawn-time memory read (Dreamer/Dispatcher P1, design §4.1–4.2).
 *
 * Two facts under test, each against the REAL chain and the REAL reader:
 *  1. Migration 088 converts every `team_members.memories` jsonb entry into a
 *     056 memory entity + `remembers` edge and EMPTIES the column — so the
 *     suite applies the chain up to 083's position first, seeds jsonb the way
 *     a pre-088 node would have, and only then applies 088.
 *  2. `DbGraphPort.loadSpawnContext` composes the injected set from the graph:
 *     the `remembers` working set (superseded entries dropped, disputed ones
 *     marked), requested `memoryIds` appended in caller order, refused loudly
 *     when absent, and any legacy jsonb remainder still riding along.
 *  3. Since migration 185 the automatic set is chosen by the graph —
 *     `internal.select_agent_memories`, design §7.2–§7.4: four routes,
 *     superseded entries REPLACED by their chain head rather than dropped, a
 *     total rank order, and a byte budget that stops before it is exceeded.
 *     The suites at the end pin those rules against the function directly,
 *     each with its own teammate so the candidate set is exactly what it seeds.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../src/db/types.js';
import { DbGraphPort } from '../../src/facade/execution-handlers.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

// Resolved by SUFFIX, not number: the ordinal is the one part of a migration
// filename that is not stable (this wave renumbers at integration because
// main took 085–087), and a literal pin fails at beforeAll, SKIPPING the
// whole suite. Exactly-one-match keeps an accidental duplicate loud.
function migrationBySuffix(files: readonly string[], suffix: string): string {
  const matches = files.filter((f) => f.endsWith(suffix));
  expect(matches, `exactly one migration ending ${suffix}`).toHaveLength(1);
  return matches[0]!;
}

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teamMemberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seedPre088(db: W1ScratchDatabase): Promise<Fixture> {
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
    // The pre-088 world: a persona carrying jsonb memories, exactly what the
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

/**
 * A memory entity + detail row + optional `remembers` edge, as the graph owner.
 * Authored by the fixture teammate unless `createdBy` says otherwise — and
 * authorship is a route (090 D10), so a memory that must reach the teammate
 * ONLY through an edge is minted with `createdBy: stranger`. `measuredAt`
 * fixes the order inside one rank tier (newest first).
 */
async function mintMemory(
  statement: string,
  remembered: boolean,
  opts: { createdBy?: string; measuredAt?: string } = {},
): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'memory',null,0,$3)`,
      [id, fixture.spaceId, opts.createdBy ?? fixture.teamMemberId],
    );
    await client.query(
      `insert into public.memories(entity_id,statement,mechanism,subject_scope,does_not_establish,measured_at)
       values($1,$2,'direct seed','this scratch database','runtime behavior',$3)`,
      [id, statement, opts.measuredAt ?? null],
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


/**
 * Entries now carry a trailing ` (mem:<entity-id>)` so an injected memory can be
 * cited, disputed or superseded by the agent that was shown it. Assertions here
 * match on the statement (plus any marks), which is the part under test.
 */
const MEM_SUFFIX = / \(mem:[0-9a-f-]{36}\)$/;
function statements(memories: readonly unknown[]): string[] {
  return memories
    .filter((m): m is string => typeof m === 'string')
    .map((m) => m.replace(MEM_SUFFIX, ''));
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

/**
 * A bare task entity + detail row — a `remembers` HOLDER under D9 (089), and
 * with `parentId` a node in the task tree the 185 subject route walks up.
 */
async function mintTask(title: string, parentId: string | null = null): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'task',$4,0,$3)`,
      [id, fixture.spaceId, fixture.teamMemberId, parentId],
    );
    await client.query(`insert into public.tasks(entity_id,title) values($1,$2)`, [id, title]);
    return id;
  });
}

/** A finalized file metadata row. Bytes are immaterial to the spawn manifest. */
async function mintFile(name: string, mime: string): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'file',null,0,$3)`,
      [id, fixture.spaceId, fixture.teamMemberId],
    );
    await client.query(
      `insert into public.files(entity_id,name,mime_type,size_bytes,storage_path,checksum_sha256)
       values($1,$2,$3,0,$4,repeat('0',64))`,
      [id, name, mime, `spaces/${fixture.spaceId}/${id}.bin`],
    );
    return id;
  });
}

/** A work_session `actorId` participates in — the D10 author. */
async function mintSession(actorId: string = fixture.teamMemberId): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'work_session',null,0,$3)`,
      [id, fixture.spaceId, actorId],
    );
    await client.query(`insert into public.work_sessions(entity_id) values($1)`, [id]);
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
       values($1,$2,$3,'participates_in','{}'::jsonb,$2)`,
      [fixture.spaceId, actorId, id],
    );
    return id;
  });
}

/** `create_memory` through the door, as tm8_app with the fixture identity. */
async function createViaDoor(
  statement: string,
  sessionId: string | null,
  actorId: string = fixture.teamMemberId,
): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true), set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true), set_config('tm8.request_id','mem-089-pg',true)`,
      [fixture.identityId],
    );
    const rows = (await client.query(
      `select public.create_memory($1,$2,'measured in this test','the 089 suite',
              'anything beyond this scratch db',null,$3,null,$4,null) as result`,
      [fixture.spaceId, statement, actorId, sessionId],
    )).rows as Array<{ result: { entity: { id: string } } }>;
    return rows[0]!.result.entity.id;
  });
}

/**
 * Another teammate — a FOREIGN author. Owned by `owner` (the fixture member
 * unless a test needs its own), so the create door can act as it.
 */
async function mintTeammate(name: string, owner: string = fixture.memberId): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'team_member',null,0,$3)`,
      [id, fixture.spaceId, owner],
    );
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values($1,$2,$3,'','')`,
      [id, owner, name],
    );
    return id;
  });
}

/** A second human member of the space, with an identity of its own. */
async function mintMember(label: string): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,$2)`,
      [`mem-185-${id}`, label],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [id, fixture.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'member',$4)`,
      [id, fixture.spaceId, `mem-185-${id}`, label],
    );
    return id;
  });
}

/** A project linked to the space, with its entity projection — the project route's subject. */
async function mintProject(name: string): Promise<{ projectId: string; projectEntityId: string }> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const mk = async (): Promise<string> =>
      (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    const projectId = await mk();
    const projectEntityId = await mk();
    await client.query(
      `insert into public.projects(id,name,working_dir) values($1,$2,$3)`,
      [projectId, name, `/tmp/lane-select/${projectId}`],
    );
    await client.query(
      `insert into public.space_projects(space_id,project_id,linked_by) values($1,$2,$3)`,
      [fixture.spaceId, projectId, fixture.memberId],
    );
    // A `project` envelope is materializer-owned (015:867): the lifecycle
    // guard refuses an ordinary insert, so the seed claims that writer for
    // the two statements that need it, exactly as the materializer does.
    await client.query(`select internal.w1_set_writer('project_materializer')`);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'project',null,0,$3)`,
      [projectEntityId, fixture.spaceId, fixture.memberId],
    );
    await client.query(
      `insert into public.project_projection_details(entity_id,project_id,name) values($1,$2,$3)`,
      [projectEntityId, projectId, name],
    );
    await client.query(`select internal.w1_set_writer(null)`);
    return { projectId, projectEntityId };
  });
}

/** A worktree entity of `projectId` — the worktree route's subject. */
async function mintWorktree(projectId: string, branch: string): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'worktree',null,0,$3)`,
      [id, fixture.spaceId, fixture.memberId],
    );
    await client.query(
      `insert into public.worktrees(entity_id,project_id,path,branch,base_ref,base_commit_oid)
       values($1,$2,$3,$4,'main',repeat('a',40))`,
      [id, projectId, `/tmp/lane-select/${projectId}/${branch}`, branch],
    );
    return id;
  });
}

async function ownerSql(sql: string, params: readonly unknown[] = []): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(sql, [...params]);
  });
}

/** One row of `internal.select_agent_memories`, the columns these suites read. */
interface SelectedRow {
  entity_id: string;
  statement: string;
  route: string;
  marks: string[];
  replaces: string[];
  statement_truncated: boolean;
  entry: string;
  entry_bytes: number;
  omitted: number;
  omitted_ids: string[];
}

/** The selector itself, with the arguments the injector passes. */
async function selectFor(
  actorId: string,
  budget: number,
  opts: { taskIds?: string[]; projectEntityId?: string | null; worktreeEntityId?: string | null } = {},
): Promise<SelectedRow[]> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return (await client.query(
      `select * from internal.select_agent_memories($1,$2,$3::uuid[],$4,$5,$6)`,
      [fixture.spaceId, actorId, opts.taskIds ?? [], opts.projectEntityId ?? null,
       opts.worktreeEntityId ?? null, budget],
    )).rows as SelectedRow[];
  });
}

/** A foreign author (see mintMemory). Minted once the chain is applied. */
let stranger: string;

beforeAll(async () => {
  database = await createW1ScratchDatabase('memory_working_set');
  const files = migrationFiles();
  const workingSetMigration = migrationBySuffix(files, '_memory_working_set.sql');
  const anyHolderMigration = migrationBySuffix(files, '_memory_any_holder.sql');
  // Pre-memory world: everything BEFORE the two memory migrations, in order —
  // then seed the jsonb the way a live node would have it, then apply both
  // exactly as an upgrade would (working-set first: any-holder replaces its
  // create_memory and widens its edge type).
  database.apply(files.filter((f) => f !== workingSetMigration && f !== anyHolderMigration));
  fixture = await seedPre088(database);
  database.apply([workingSetMigration, anyHolderMigration]);
  stranger = await mintTeammate('Stranger');
});

afterAll(async () => {
  await database?.destroy();
});

describe('088 jsonb → entity conversion', () => {
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
    expect(statements(memories)).toContain('prefers scoped tsc over full builds');
    expect(statements(memories)).toContain('{"freeform": "object entry"}');
  });

  it('replaces a superseded memory with its successor and marks disputed ones', async () => {
    const doomed = await mintMemory('stale claim about the build', true);
    // The successor is a stranger's: it reaches the spawn ONLY as the head of
    // the chain, which is what 185 §7.2 promises — the correction comes back
    // in the rot's place rather than the rot being quietly dropped.
    const successor = await mintMemory('current claim about the build', false, { createdBy: stranger });
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
    expect(statements(memories)).not.toContain('stale claim about the build');
    expect(statements(memories)).toContain('current claim about the build');
    expect(statements(memories)).toContain('contested claim [disputed]');
  });

  it('appends requested memoryIds after the working set, in caller order', async () => {
    const a = await mintMemory('requested only: alpha', false);
    const b = await mintMemory('requested only: beta', false);
    const memories = await injectedMemories([b, a]);
    const tail = statements(memories).slice(-2);
    expect(tail).toEqual(['requested only: beta', 'requested only: alpha']);
  });

  it('injects a requested-but-superseded memory WITH its marker rather than dropping it', async () => {
    const doomed = await mintMemory('explicitly wanted stale note', false);
    const successor = await mintMemory('its successor', false);
    await drawEdge(successor, doomed, 'supersedes', { reason: 'superseded for the test' });
    const memories = await injectedMemories([doomed]);
    expect(statements(memories)).toContain('explicitly wanted stale note [superseded]');
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
    expect(statements(memories)).toContain('fresh jsonb entry');
    // Graph set first, legacy remainder after.
    expect(statements(memories).indexOf('fresh jsonb entry'))
      .toBeGreaterThan(statements(memories).indexOf('prefers scoped tsc over full builds'));
  });
});

describe('089 D9 — any holder, task working sets at spawn', () => {
  it('widens remembers src_kinds to the any-kind wildcard', async () => {
    const rows = await database.query<{ src_kinds: string[] }>(
      `select src_kinds from public.edge_types where type = 'remembers'`,
    );
    expect(rows[0]!.src_kinds).toEqual(['*']);
  });

  it('accepts remembers(task → memory) — refused before 089', async () => {
    const task = await mintTask('holder task');
    const memory = await mintMemory('what the task knows', false);
    // Would raise via internal.validate_edge pre-089 (src task not in
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
    // A stranger's memory: it reaches the spawn through the task alone and so
    // ranks as subject, after every persona entry. A memory the teammate
    // itself authored is a persona memory whichever holder also carries it —
    // 185 ranks routes, not holders.
    const taskMemory = await mintMemory('task context: deploy quirk', false, { createdBy: stranger });
    await drawEdge(task, taskMemory, 'remembers', {});
    const requested = await mintMemory('explicitly requested extra', false);

    const memories = await injectedMemories([requested], [task]);
    const shown = statements(memories);
    const persona = shown.indexOf('prefers scoped tsc over full builds');
    const fromTask = shown.indexOf('task context: deploy quirk');
    const extra = shown.indexOf('explicitly requested extra');
    expect(persona).toBeGreaterThanOrEqual(0);
    expect(fromTask).toBeGreaterThan(persona);
    expect(extra).toBeGreaterThan(fromTask);
  });

  it('replaces a superseded task memory with its head, like any working-set entry', async () => {
    const task = await mintTask('stale-context task');
    const doomed = await mintMemory('task memory now stale', false, { createdBy: stranger });
    await drawEdge(task, doomed, 'remembers', {});
    const successor = await mintMemory('task memory, corrected', false, { createdBy: stranger });
    await drawEdge(successor, doomed, 'supersedes', { reason: 'remeasured' });

    const shown = statements(await injectedMemories(undefined, [task]));
    expect(shown).not.toContain('task memory now stale');
    expect(shown).toContain('task memory, corrected');
  });

  it('a spawn with no taskIds injects no task sets (persona set unchanged)', async () => {
    const memories = await injectedMemories();
    expect(statements(memories)).not.toContain('task context: deploy quirk');
  });
});

describe('task file identities at spawn', () => {
  it('carries file→attached_to→task metadata into the matching TaskContext', async () => {
    const task = await mintTask('task with a file');
    const file = await mintFile('evidence.pdf', 'application/pdf');
    await drawEdge(file, task, 'attached_to', {});

    const context = await graphPort().loadSpawnContext({} as never, {
      spaceId: fixture.spaceId,
      teamMemberId: fixture.teamMemberId,
      taskIds: [task],
    });

    expect(context.tasks[0]?.attachments).toEqual([{
      fileEntityId: file,
      name: 'evidence.pdf',
      mime: 'application/pdf',
    }]);
  });
});

describe('089 D10 — the authoring session remembers', () => {
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

/**
 * D10 CARRY — the half that was missing.
 *
 * `create_memory` has always written `remembers(work_session → memory)` for an
 * authored memory (090 §2, proved by the suite above). Nothing ever READ it:
 * the spawn injector bound holders to the team_member alone, so a fact an agent
 * established died with the session that established it. These tests pin the
 * read arm — memories authored by THIS teammate's past sessions reach the next
 * one, and memories authored by somebody else's sessions do not.
 */
describe('D10 carry — a past session of this teammate reaches the next one', () => {
  /** A session linked to the fixture teammate the way spawn links it (048:99). */
  async function mintLinkedSession(): Promise<string> {
    const session = await mintSession();           // draws participates_in(tm → ws)
    await drawEdge(session, fixture.teamMemberId, 'relates_to', {});
    return session;
  }

  it('injects a memory a past session of this teammate authored', async () => {
    const session = await mintLinkedSession();
    const memory = await mintMemory('the deploy needs the pg_hba reload, not a restart', false);
    await drawEdge(session, memory, 'remembers', {});

    const memories = await injectedMemories();
    expect(statements(memories))
      .toContain('the deploy needs the pg_hba reload, not a restart');
  });

  it('carries the memory id so the next session can supersede what it disagrees with', async () => {
    const session = await mintLinkedSession();
    const memory = await mintMemory('a claim a later session may want to correct', false);
    await drawEdge(session, memory, 'remembers', {});

    const memories = await injectedMemories();
    const entry = memories.find(
      (m): m is string => typeof m === 'string' && m.startsWith('a claim a later session'),
    );
    expect(entry).toBeDefined();
    expect(entry).toContain(`(mem:${memory})`);
  });

  it('injects a memory this teammate AUTHORED, with no remembers edge at all', async () => {
    // The authorship route. 090 D10 ruled that authoring implies working-set
    // membership; create_envelope stamps created_by with the acting actor, so
    // this is true of memories that already exist rather than only of ones a
    // future writer remembers to link. mintMemory(..., false) draws no edge.
    const memory = await mintMemory('authored, never explicitly remembered', false);
    const rows = await database.query<{ count: string }>(
      `select count(*)::text count from public.edges
        where type = 'remembers' and dst_id = $1`, [memory],
    );
    expect(rows[0]!.count, 'no remembers edge exists for this memory').toBe('0');

    const memories = await injectedMemories();
    expect(statements(memories)).toContain('authored, never explicitly remembered');
  });

  it('does NOT inject a memory belonging to another teammate', async () => {
    // Genuinely foreign on BOTH routes: created_by is a different team_member,
    // and the session that remembers it has no relates_to back to the fixture
    // teammate. mintMemory stamps the fixture teammate as creator, so this one
    // is minted by hand.
    const { other, secret } = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const mk = async (): Promise<string> =>
        (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      const otherId = await mk();
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'team_member',null,0,$3)`,
        [otherId, fixture.spaceId, fixture.memberId],
      );
      await client.query(
        `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
         values($1,$2,'Other','','')`,
        [otherId, fixture.memberId],
      );
      const memId = await mk();
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'memory',null,0,$3)`,
        [memId, fixture.spaceId, otherId],
      );
      await client.query(
        `insert into public.memories(entity_id,statement,mechanism,subject_scope,does_not_establish)
         values($1,'another teammate private finding','theirs','theirs','theirs')`,
        [memId],
      );
      const sessionId = await mk();
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'work_session',null,0,$3)`,
        [sessionId, fixture.spaceId, otherId],
      );
      await client.query(`insert into public.work_sessions(entity_id) values($1)`, [sessionId]);
      await client.query(
        `insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
         values($1,$2,$3,'relates_to','{}'::jsonb,$2)`,
        [fixture.spaceId, sessionId, otherId],
      );
      await client.query(
        `insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
         values($1,$2,$3,'remembers','{}'::jsonb,$2)`,
        [fixture.spaceId, sessionId, memId],
      );
      return { other: otherId, secret: memId };
    });
    expect(other).toBeDefined();
    expect(secret).toBeDefined();

    const memories = await injectedMemories();
    expect(statements(memories)).not.toContain('another teammate private finding');
  });

  it('replaces a superseded carry with its correction, so the fact comes back corrected', async () => {
    const session = await mintLinkedSession();
    const wrong = await mintMemory('the port is 5432', false, { createdBy: stranger });
    await drawEdge(session, wrong, 'remembers', {});
    const right = await mintMemory('the port is 5442', false, { createdBy: stranger });
    await drawEdge(right, wrong, 'supersedes', { reason: 'checked the cluster' });

    const shown = statements(await injectedMemories());
    expect(shown).not.toContain('the port is 5432');
    expect(shown).toContain('the port is 5442');
  });
});

/**
 * 185 — SUPERSEDED MEANS REPLACED, NOT DROPPED (design §7.2).
 *
 * Before 185 a superseded working-set entry was simply left out. That hid the
 * correction along with the rot: the successor reached the agent only if it
 * happened to be remembered too. The selector walks the chain and shows the
 * head in the predecessor's place. Heads here are a stranger's on purpose —
 * reachable ONLY as heads, so their presence proves the substitution.
 */
describe('185 — a superseded memory is replaced by its chain head', () => {
  it('shows the head of a two-step chain in place of the remembered predecessor', async () => {
    const first = await mintMemory('chain: first claim', true);
    const second = await mintMemory('chain: second claim', false, { createdBy: stranger });
    const third = await mintMemory('chain: third claim', false, { createdBy: stranger });
    await drawEdge(second, first, 'supersedes', { reason: 'remeasured' });
    await drawEdge(third, second, 'supersedes', { reason: 'remeasured again' });

    const shown = statements(await injectedMemories());
    expect(shown).toContain('chain: third claim');
    expect(shown).not.toContain('chain: first claim');
    expect(shown).not.toContain('chain: second claim');
  });

  it('drops the predecessor when its head is already in the set, showing the head once', async () => {
    const old = await mintMemory('twice: the old claim', true);
    const head = await mintMemory('twice: the head', true);
    await drawEdge(head, old, 'supersedes', { reason: 'remeasured' });

    const shown = statements(await injectedMemories());
    expect(shown.filter((s) => s === 'twice: the head')).toHaveLength(1);
    expect(shown).not.toContain('twice: the old claim');
  });

  it('a head keeps its own marks and names what it stands in for', async () => {
    const actor = await mintTeammate('Chained');
    const old = await mintMemory('marked: old', false, { createdBy: actor });
    const head = await mintMemory('marked: head', false, { createdBy: stranger });
    await drawEdge(head, old, 'supersedes', { reason: 'remeasured' });
    const evidence = await mintMemory('marked: counter-evidence', false, { createdBy: stranger });
    await drawEdge(evidence, head, 'disputes', { quote: 'q', expected: 'e', observed: 'o', pinnedVersion: 1 });

    const rows = await selectFor(actor, 4096);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_id: head, route: 'persona', marks: ['disputed'], replaces: [old] });
    expect(rows[0]!.entry).toBe(`marked: head [disputed] (mem:${head})`);
  });
});

/**
 * 185 — THE SUBJECT ROUTES (design §7.2, C2 and C3).
 *
 * A memory about an epic concerns every task under it, so the subject route
 * walks up the task tree — bounded at eight ancestors so a pathological tree
 * cannot make the spawn read unbounded. A memory about the launch project
 * reaches the spawn through the project's entity projection, which the
 * injector resolves from the project id in the same statement.
 */
describe('185 — the subject routes reach task ancestors and the launch project', () => {
  it('a memory about the grandparent task reaches a spawn on the leaf, and only then', async () => {
    const grand = await mintTask('grandparent');
    const parent = await mintTask('parent', grand);
    const leaf = await mintTask('leaf', parent);
    const memory = await mintMemory('about the grandparent epic', false, { createdBy: stranger });
    await drawEdge(memory, grand, 'about', {});

    expect(statements(await injectedMemories(undefined, [leaf]))).toContain('about the grandparent epic');
    expect(statements(await injectedMemories())).not.toContain('about the grandparent epic');
  });

  it('stops after eight ancestors', async () => {
    // chain[0] is the root and chain[9] the assigned task, so chain[1] is its
    // eighth ancestor and chain[0] its ninth.
    const chain: string[] = [await mintTask('depth 9')];
    for (let i = 1; i < 10; i += 1) chain.push(await mintTask(`depth ${9 - i}`, chain[i - 1]!));
    const near = await mintMemory('about the eighth ancestor', false, { createdBy: stranger });
    await drawEdge(near, chain[1]!, 'about', {});
    const far = await mintMemory('about the ninth ancestor', false, { createdBy: stranger });
    await drawEdge(far, chain[0]!, 'about', {});

    const shown = statements(await injectedMemories(undefined, [chain[9]!]));
    expect(shown).toContain('about the eighth ancestor');
    expect(shown).not.toContain('about the ninth ancestor');
  });

  it('a memory about the launch project reaches the spawn through the project route', async () => {
    const { projectId, projectEntityId } = await mintProject('Lane project');
    const memory = await mintMemory('about the whole project', false, { createdBy: stranger });
    await drawEdge(memory, projectEntityId, 'about', {});

    const context = await graphPort().loadSpawnContext({} as never, {
      spaceId: fixture.spaceId,
      teamMemberId: fixture.teamMemberId,
      projectId,
    });
    expect(statements(context.teamMember.memories)).toContain('about the whole project');
    expect(statements(await injectedMemories())).not.toContain('about the whole project');
  });
});

/**
 * BUDGET — the injector had no LIMIT and no relevance term, while the combined
 * initial injection throws BudgetExceededError at 32,768 bytes rather than
 * truncating (packages/prompt/src/budgets.ts:27,:71) and the degrade-to-ids
 * fallback covers tasks only. An unbounded working set was a launch outage
 * waiting for a teammate to learn enough things.
 */
describe('memory section budget', () => {
  it('bounds the injected set and says how many it dropped', async () => {
    // 4096-byte section budget; ~600-byte entries overflow it well inside the
    // per-entry 512-byte cap applying to the statement alone.
    const big = 'x'.repeat(600);
    for (let i = 0; i < 12; i += 1) await mintMemory(`${i}-${big}`, true);

    const memories = await injectedMemories();
    const notice = memories.find(
      (m): m is string => typeof m === 'string' && m.includes('not shown'),
    );
    expect(notice, 'a truncated working set must say so').toBeDefined();
    expect(notice).toMatch(/\d+ further memor(y|ies) not shown/);
    // Plain language: the line reaches people as well as agents, so it names
    // no byte counts and no internal vocabulary.
    expect(notice).not.toMatch(/byte/i);

    const graphEntries = memories.filter(
      (m): m is string => typeof m === 'string' && MEM_SUFFIX.test(m),
    );
    const bytes = graphEntries.reduce((n, m) => n + Buffer.byteLength(m), 0);
    expect(bytes).toBeLessThanOrEqual(4096);
  });

  it('never budget-drops an explicitly requested memoryId', async () => {
    // The automatic tiers above have already filled the section budget. A
    // spawn that NAMES a memory is refused outright when it cannot be read
    // (see 'refuses a spawn naming a memory that does not exist'), so quietly
    // dropping a readable one for budget would be the same lie by another
    // route. Requested ids are exempt; the automatic tiers are what is bounded.
    const named = await mintMemory('named explicitly despite a full budget', false);
    const memories = await injectedMemories([named]);
    expect(statements(memories)).toContain('named explicitly despite a full budget');
  });

  it('truncates a single oversized statement rather than emitting it whole', async () => {
    const huge = await mintMemory(`huge-${'y'.repeat(3000)}`, false);
    const memories = await injectedMemories([huge]);
    const entry = memories.find(
      (m): m is string => typeof m === 'string' && m.startsWith('huge-'),
    );
    expect(entry).toBeDefined();
    expect(Buffer.byteLength(entry!)).toBeLessThan(700);
    expect(entry).toContain('…');
  });
});

/**
 * 185 — RANK, DETERMINISM AND THE BUDGET, against the selector directly.
 *
 * Each scenario gets its own teammate so the candidate set is exactly what the
 * test seeds — the fixture teammate has accumulated dozens of memories by now.
 */
describe('185 — select_agent_memories ranks, stops and reports', () => {
  interface RankScenario { actor: string; task: string; expectedOrder: string[] }
  let ranked: RankScenario;

  beforeAll(async () => {
    const actor = await mintTeammate('Ranker');
    const task = await mintTask('ranked task');
    // 5 — disputed: an open dispute from a stranger's evidence.
    const disputed = await mintMemory('rank: disputed', false, { createdBy: actor });
    const evidence = await mintMemory('rank: dispute evidence', false, { createdBy: stranger });
    await drawEdge(evidence, disputed, 'disputes', { quote: 'q', expected: 'e', observed: 'o', pinnedVersion: 1 });
    // 4 — basis changed: pinned to the task at version 1, then the task moved on.
    const moved = await mintMemory('rank: basis changed', false, { createdBy: actor });
    await drawEdge(moved, task, 'based_on', { pinnedVersion: 1, pinnedAt: '2026-07-31T00:00:00Z' });
    await ownerSql(`update public.entities set version = version + 1 where id = $1`, [task]);
    // 3 — unflagged: one the actor authored (persona), one a stranger's that
    //     the task holds (subject).
    const plain = await mintMemory('rank: plain persona', false, { createdBy: actor });
    const subject = await mintMemory('rank: plain subject', false, { createdBy: stranger });
    await drawEdge(task, subject, 'remembers', {});
    // 2 — verified at the current version on ACTOR independence: no session
    //     provenance on either side, so the trigger demands different authors.
    const actorVerified = await mintMemory('rank: verified by another actor', false, { createdBy: actor });
    const actorEvidence = await mintMemory('rank: re-measured by a stranger', false, { createdBy: stranger });
    await drawEdge(actorEvidence, actorVerified, 'verifies', {
      mechanism: 're-measured', answers: [], pinnedVersion: 1, independenceBasis: 'actor',
    });
    // 1 — verified on SESSION independence: both sides carry authored_from to
    //     different sessions, which only the create door can write.
    const actorSession = await mintSession(actor);
    const strangerSession = await mintSession(stranger);
    const sessionVerified = await createViaDoor('rank: verified across sessions', actorSession, actor);
    const sessionEvidence = await createViaDoor('rank: re-measured in another session', strangerSession, stranger);
    await drawEdge(sessionEvidence, sessionVerified, 'verifies', {
      mechanism: 're-measured', answers: [], pinnedVersion: 1, independenceBasis: 'session',
    });
    ranked = { actor, task, expectedOrder: [sessionVerified, actorVerified, plain, subject, moved, disputed] };
  });

  it('ranks verified(session) > verified(actor) > unflagged > basis changed > disputed, persona before subject', async () => {
    const rows = await selectFor(ranked.actor, 4096, { taskIds: [ranked.task] });
    expect(rows.map((r) => r.entity_id)).toEqual(ranked.expectedOrder);
    expect(rows.map((r) => r.marks)).toEqual([['verified'], ['verified'], [], [], ['basis changed'], ['disputed']]);
    expect(rows.map((r) => r.route)).toEqual(['persona', 'persona', 'persona', 'subject', 'persona', 'persona']);
    expect(rows[0]!.omitted).toBe(0);
  });

  it('is deterministic: the same inputs produce the same rows twice', async () => {
    const first = await selectFor(ranked.actor, 4096, { taskIds: [ranked.task] });
    const second = await selectFor(ranked.actor, 4096, { taskIds: [ranked.task] });
    expect(first).toHaveLength(6);
    expect(second).toEqual(first);
  });

  it('stops before the entry that would exceed the budget, and reports what it left out', async () => {
    const actor = await mintTeammate('Budgeted');
    // All unflagged persona, so measured_at alone decides the order: newest first.
    const at = (day: number): string => `2026-09-0${day}T00:00:00Z`;
    const a = await mintMemory('a'.repeat(200), false, { createdBy: actor, measuredAt: at(5) });
    const b = await mintMemory('b'.repeat(200), false, { createdBy: actor, measuredAt: at(4) });
    const c = await mintMemory('c'.repeat(200), false, { createdBy: actor, measuredAt: at(3) });
    const d = await mintMemory('d'.repeat(240), false, { createdBy: actor, measuredAt: at(2) });
    const e = await mintMemory('e', false, { createdBy: actor, measuredAt: at(1) });

    // a, b, c are 243 bytes each (statement + " (mem:<id>)"): 729 in. d is 283,
    // which would reach 1012 — over. e is 44 and WOULD fit after d, but the
    // selector stops rather than skips: nothing after the first overflow.
    const rows = await selectFor(actor, 1000);
    expect(rows.map((r) => r.entity_id)).toEqual([a, b, c]);
    expect(rows.reduce((n, r) => n + r.entry_bytes, 0)).toBeLessThanOrEqual(1000);
    for (const r of rows) expect(Buffer.byteLength(r.entry)).toBe(r.entry_bytes);
    expect(rows[0]!.omitted).toBe(2);
    expect(rows[0]!.omitted_ids).toEqual([d, e]);
  });

  it('caps one entry at 512 bytes, cuts the statement visibly, and still carries the id', async () => {
    const actor = await mintTeammate('Verbose');
    const huge = await mintMemory(`huge-${'y'.repeat(3000)}`, false, { createdBy: actor });
    const rows = await selectFor(actor, 4096);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.entry_bytes).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(row.entry)).toBe(row.entry_bytes);
    expect(row.entry).toContain('…');
    expect(row.entry.endsWith(`(mem:${huge})`)).toBe(true);
    expect(row.statement_truncated).toBe(true);
    expect(row.statement.length).toBeLessThanOrEqual(241);
  });

  it('refuses a budget too small for a single entry rather than showing nothing quietly', async () => {
    await expect(selectFor(ranked.actor, 100)).rejects.toThrow(/at least one 512-byte entry/);
  });

  it('a memory the owning member remembers reaches their teammate (persona route)', async () => {
    const owner = await mintMember('Second owner');
    const actor = await mintTeammate('Owned', owner);
    const memory = await mintMemory('what the owner remembers', false, { createdBy: stranger });
    await drawEdge(owner, memory, 'remembers', {});

    const rows = await selectFor(actor, 4096);
    expect(rows.map((r) => r.entity_id)).toEqual([memory]);
    expect(rows[0]!.route).toBe('persona');
  });

  it("a memory based on the session's worktree reaches the spawn (worktree route)", async () => {
    const actor = await mintTeammate('Checked out');
    const { projectId } = await mintProject('Worktree project');
    const worktree = await mintWorktree(projectId, 'lane/select');
    const memory = await mintMemory('learned in this worktree', false, { createdBy: stranger });
    await drawEdge(memory, worktree, 'based_on', { pinnedVersion: 1, pinnedAt: '2026-09-01T00:00:00Z' });

    const rows = await selectFor(actor, 4096, { worktreeEntityId: worktree });
    expect(rows.map((r) => r.entity_id)).toEqual([memory]);
    expect(rows[0]!.route).toBe('worktree');
    expect(await selectFor(actor, 4096)).toEqual([]);
  });

  it('runs as tm8_app under row-level security, the role the injector uses', async () => {
    const rows = await database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id',$1,true), set_config('tm8.actor_id','',true),
                set_config('tm8.node_admin','false',true), set_config('tm8.request_id','mem-185-pg',true)`,
        [fixture.identityId],
      );
      return (await client.query(
        `select entity_id from internal.select_agent_memories($1,$2,'{}'::uuid[],null,null,4096)`,
        [fixture.spaceId, fixture.teamMemberId],
      )).rows as Array<{ entity_id: string }>;
    });
    expect(rows.length).toBeGreaterThan(0);
  });
});
