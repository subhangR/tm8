/**
 * Migration 264 (launch v3, lane C) — the task is created IN the spawn /
 * dispatch request, and a dispatcher launched on a task routes it.
 *
 * What a "the task exists" test would miss, and this file asserts:
 *  - a REFUSED spawn leaves no task behind (it is created inside the spawn's
 *    own transaction, after every refusal);
 *  - a retry with the same clientMutationId answers the SAME task and the SAME
 *    session, and creates nothing new;
 *  - the created task is assigned, worked on and `working` — the loop every
 *    `p_task_ids` entry takes, not a parallel copy of it;
 *  - `mode = 'dispatcher'` writes neither `working_on` nor `assigned_to`, and
 *    does not start an existing task on the dispatcher's behalf;
 *  - `execution_dispatch_new_task` creates a `working` task with no assignee,
 *    and replays it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teamMemberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<Fixture>(
        `select 'launch-v3-owner'::text "identityId",
                internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId",
                internal.new_id()::text "teamMemberId"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Launch v3 owner')`,
      [f.identityId],
    );
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Launch v3',$2)`, [
      f.spaceId,
      f.identityId,
    ]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'team_member',null,1,$1)`,
      [f.memberId, f.teamMemberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Launch v3 owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values($1,$2,'Runner','','persona')`,
      [f.teamMemberId, f.memberId],
    );
    return f;
  });
}

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** As tm8_app — the role tm8-server connects as. */
async function asApp<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-launch-v3',true)`,
      [fixture.identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

interface SpawnResult {
  entity: { id: string };
  createdTaskId?: string;
  __tm8_replayed?: boolean;
}

async function spawn(opts: {
  cmid: string;
  title?: string | null;
  mode?: string | null;
  taskIds?: string[];
  teamMemberId?: string;
}): Promise<SpawnResult> {
  const rows = await asApp((q) =>
    q(
      `select public.execution_spawn($1,$2,$3::uuid[],null,'scratch',null,null,
         $4,'claude-opus-5','claude','Launch','node-local',true,64,null,$5,null,$6) result`,
      [
        fixture.spaceId,
        opts.teamMemberId ?? fixture.teamMemberId,
        opts.taskIds ?? [],
        opts.mode ?? null,
        opts.cmid,
        opts.title ?? null,
      ],
    ),
  );
  return rows[0]!.result as SpawnResult;
}

async function tasksTitled(title: string): Promise<Array<{ entity_id: string; work_status: string }>> {
  return database.query<{ entity_id: string; work_status: string }>(
    `select entity_id::text, work_status from public.tasks where title = $1`,
    [title],
  );
}

async function edgeCount(src: string, dst: string, type: string): Promise<number> {
  const rows = await database.query<{ n: string }>(
    `select count(*)::text n from public.edges where src_id = $1 and dst_id = $2 and type = $3`,
    [src, dst, type],
  );
  return Number(rows[0]!.n);
}

async function openTask(title: string): Promise<string> {
  const rows = await asApp((q) =>
    q(
      `select public.create_task($1,$2,null,'',$3::jsonb,null,null,'medium','[]'::jsonb,null,null,null,null,'attached_to',$4) result`,
      [fixture.spaceId, title, '{}', `launch-v3-task-${Math.random()}`],
    ),
  );
  return (rows[0]!.result as { entity: { id: string } }).entity.id;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('launch-v3-new-task');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
});

describe('264: execution_spawn creates newTask in the spawn transaction', () => {
  it('creates the task assigned, worked on and working, and names it createdTaskId', async () => {
    const result = await spawn({ cmid: `spawn-new-${Math.random()}`, title: '  Fix the thing  ' });

    const tasks = await tasksTitled('Fix the thing');
    expect(tasks).toHaveLength(1);
    const taskId = tasks[0]!.entity_id;
    expect(result.createdTaskId).toBe(taskId);
    expect(tasks[0]!.work_status).toBe('working');
    expect(await edgeCount(result.entity.id, taskId, 'working_on')).toBe(1);
    expect(await edgeCount(taskId, fixture.teamMemberId, 'assigned_to')).toBe(1);
  });

  it('replays the same task and session for the same clientMutationId', async () => {
    const cmid = `spawn-replay-${Math.random()}`;
    const first = await spawn({ cmid, title: 'Replayed task' });
    const second = await spawn({ cmid, title: 'Replayed task' });

    expect(second.__tm8_replayed).toBe(true);
    expect(second.entity.id).toBe(first.entity.id);
    expect(second.createdTaskId).toBe(first.createdTaskId);
    expect(await tasksTitled('Replayed task')).toHaveLength(1);
  });

  it('leaves no task behind when the spawn is refused', async () => {
    const stranger = (await database.query<{ id: string }>('select gen_random_uuid()::text id'))[0]!.id;
    await expect(
      spawn({ cmid: `spawn-refused-${Math.random()}`, title: 'Never created', teamMemberId: stranger }),
    ).rejects.toThrow();
    expect(await tasksTitled('Never created')).toHaveLength(0);
  });

  it('refuses a blank title and creates nothing', async () => {
    await expect(spawn({ cmid: `spawn-blank-${Math.random()}`, title: '   ' })).rejects.toThrow(/1\.\.200/);
    const x201 = 'x'.repeat(201);
    await expect(spawn({ cmid: `spawn-long-${Math.random()}`, title: x201 })).rejects.toThrow(/1\.\.200/);
    expect(await tasksTitled(x201)).toHaveLength(0);
  });

  it('omits createdTaskId when no newTask is named', async () => {
    const result = await spawn({ cmid: `spawn-plain-${Math.random()}` });
    expect(result.createdTaskId).toBeUndefined();
  });

  it('still assigns and starts an existing task for a non-dispatcher spawn', async () => {
    const taskId = await openTask('Worker on an existing task');
    const result = await spawn({ cmid: `spawn-worker-${Math.random()}`, taskIds: [taskId], mode: 'worker' });
    expect(await edgeCount(result.entity.id, taskId, 'working_on')).toBe(1);
    expect(await edgeCount(taskId, fixture.teamMemberId, 'assigned_to')).toBe(1);
    expect((await tasksTitled('Worker on an existing task'))[0]!.work_status).toBe('working');
  });
});

describe('264: a dispatcher launched on a task routes it', () => {
  it('writes no working_on / assigned_to and does not start an existing task', async () => {
    const taskId = await openTask('Route me');
    const result = await spawn({ cmid: `spawn-dispatcher-${Math.random()}`, taskIds: [taskId], mode: 'dispatcher' });

    expect(await edgeCount(result.entity.id, taskId, 'working_on')).toBe(0);
    expect(await edgeCount(taskId, fixture.teamMemberId, 'assigned_to')).toBe(0);
    expect((await tasksTitled('Route me'))[0]!.work_status).toBe('open');
  });

  it('creates newTask working but unassigned', async () => {
    const result = await spawn({ cmid: `spawn-dispatcher-new-${Math.random()}`, title: 'Dispatcher new task', mode: 'dispatcher' });
    const tasks = await tasksTitled('Dispatcher new task');
    expect(tasks).toHaveLength(1);
    expect(result.createdTaskId).toBe(tasks[0]!.entity_id);
    expect(tasks[0]!.work_status).toBe('working');
    expect(await edgeCount(result.entity.id, tasks[0]!.entity_id, 'working_on')).toBe(0);
    expect(await edgeCount(tasks[0]!.entity_id, fixture.teamMemberId, 'assigned_to')).toBe(0);
  });
});

describe('264: execution_dispatch_new_task', () => {
  async function dispatchNewTask(title: string, cmid: string): Promise<{ taskId: string }> {
    const rows = await asApp((q) =>
      q(`select public.execution_dispatch_new_task($1,$2,null,null,$3) result`, [fixture.spaceId, title, cmid]),
    );
    return rows[0]!.result as { taskId: string };
  }

  it('creates a working task with no assignee', async () => {
    const { taskId } = await dispatchNewTask('Dispatched work', `dispatch-new-${Math.random()}`);
    const tasks = await tasksTitled('Dispatched work');
    expect(tasks).toEqual([{ entity_id: taskId, work_status: 'working' }]);
    const assigned = await database.query<{ n: string }>(
      `select count(*)::text n from public.edges where src_id = $1 and type = 'assigned_to'`,
      [taskId],
    );
    expect(assigned[0]!.n).toBe('0');
  });

  it('replays the same task for the same clientMutationId', async () => {
    const cmid = `dispatch-replay-${Math.random()}`;
    const first = await dispatchNewTask('Dispatched once', cmid);
    const second = await dispatchNewTask('Dispatched once', cmid);
    expect(second.taskId).toBe(first.taskId);
    expect(await tasksTitled('Dispatched once')).toHaveLength(1);
  });

  it('refuses a blank title', async () => {
    await expect(dispatchNewTask('  ', `dispatch-blank-${Math.random()}`)).rejects.toThrow(/1\.\.200/);
  });

  it('refuses a project that is not linked to the space', async () => {
    await expect(
      asApp((q) =>
        q(`select public.execution_dispatch_new_task($1,'Filed nowhere',gen_random_uuid(),null,$2) result`, [
          fixture.spaceId,
          `dispatch-project-${Math.random()}`,
        ]),
      ),
    ).rejects.toThrow(/not linked/);
    expect(await tasksTitled('Filed nowhere')).toHaveLength(0);
  });
});
