/**
 * Migration 131 — spawning a session on a task moves that task to `working`.
 *
 * Applied as an UPGRADE, not a fresh install: everything before 131 first, a
 * world seeded through the pre-131 doors, then 131 on top. `execution_spawn` is
 * a `create or replace` on a function five earlier migrations have already
 * rewritten, so the only interesting question is what it does to the database
 * people already have.
 *
 * The assertions that matter are the ones a "did the status change" test would
 * miss:
 *  - the FIVE statuses that must NOT move. Four of them are human statements
 *    (`blocked`, `in_review`) or terminal (`done`, `cancelled`) and the fifth
 *    (`working`) must be a no-op rather than a re-write. A door that promotes
 *    everything passes the happy-path test and destroys information.
 *  - `work.changed` is recorded WHEN AND ONLY WHEN the status actually moved.
 *    `FOUND` after a filtered UPDATE is the gate; get it wrong and every spawn
 *    on a blocked task writes a feed row claiming a change that did not happen.
 *  - the task is in `patches`. Without it the write lands and no client is told
 *    to re-read, which looks exactly like the bug this migration fixes.
 *  - 111's assignment still happens. This file replaces 111's function body
 *    wholesale; a dropped line there would be silent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/**
 * Resolved by SUFFIX, not by number — the number is the one part of a
 * migration's name that is not stable across an integration renumber, and 129
 * and 130 are already taken twice over on unmerged branches.
 */
const MIGRATION_SUFFIX = '_spawn_starts_the_task.sql';

function spawnStartsTheTaskMigration(files: readonly string[]): string {
  const matches = files.filter((file) => file.endsWith(MIGRATION_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one *${MIGRATION_SUFFIX} migration, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
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

async function seedPre131(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<Fixture>(
        `select 'spawn-start-owner'::text "identityId",
                internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId",
                internal.new_id()::text "teamMemberId"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Spawn start owner')`,
      [f.identityId],
    );
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Starts',$2)`, [
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
       values($1,$2,$3,'owner','Spawn start owner')`,
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

/**
 * The door as tm8_app sees it — the role tm8-server actually connects as.
 * Calling it as the graph owner would prove the SQL parses and nothing about
 * whether a real caller may run it.
 */
async function asApp<T>(
  fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-spawn-start',true)`,
      [fixture.identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

/**
 * A task parked in `status`. `done` cannot be reached through `set_work_state`
 * — 060 refuses it with 23514 on purpose — so that one arm is written directly
 * as the owner. Every other status goes through the real door, which also
 * leaves behind the actor-sourced `working_on` edge a hand-written row would
 * not, keeping the fixture honest about what a real task in that state looks
 * like.
 */
async function taskInStatus(status: string): Promise<string> {
  const rows = await asApp((q) =>
    q(
      `select public.create_task($1,$2,null,'',$3::jsonb,null,null,'medium','[]'::jsonb,null,null,null,'attached_to',$4) result`,
      [fixture.spaceId, `task-${status}`, '{}', `spawn-start-${status}-${Math.random()}`],
    ),
  );
  const id = (rows[0]!.result as { entity: { id: string } }).entity.id;
  if (status === 'open') return id;
  if (status === 'done') {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.tasks set work_status = 'done' where entity_id = $1`, [id]);
    });
    return id;
  }
  await asApp((q) =>
    q(`select public.set_work_state($1,$2,null,null,null,$3,false) result`, [
      id,
      status,
      `spawn-start-state-${status}-${Math.random()}`,
    ]),
  );
  return id;
}

/**
 * `internal.command_result` (007:59-63) does NOT return the patch ids it was
 * handed — it expands each through `internal.command_entity`, so a patch is a
 * whole entity with its `content` resolved AT RETURN TIME. That is what makes
 * the patch assertion below worth making: it proves the client is handed the
 * NEW status, not the one it already had.
 */
interface PatchEntity {
  id: string;
  content: { work_status?: string };
}

interface SpawnOutcome {
  sessionId: string;
  patches: PatchEntity[];
}

async function spawnOn(taskId: string): Promise<SpawnOutcome> {
  const rows = await asApp((q) =>
    q(
      `select public.execution_spawn($1,$2,array[$3]::uuid[],null,'scratch',null,null,
         null,'claude-opus-5','claude','Starting','node-local',true,64,null,$4) result`,
      [fixture.spaceId, fixture.teamMemberId, taskId, `spawn-start-run-${Math.random()}`],
    ),
  );
  const result = rows[0]!.result as { entity: { id: string }; patches?: PatchEntity[] };
  return { sessionId: result.entity.id, patches: result.patches ?? [] };
}

async function statusOf(taskId: string): Promise<string> {
  const rows = await database.query<{ work_status: string }>(
    `select work_status from public.tasks where entity_id = $1`,
    [taskId],
  );
  return rows[0]!.work_status;
}

async function workChangedCount(taskId: string): Promise<number> {
  const rows = await database.query<{ n: string }>(
    `select count(*) n from public.activity
      where entity_id = $1 and verb = 'work.changed' and summary->>'via' = 'spawn'`,
    [taskId],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('spawn-starts-the-task');
  const files = migrationFiles();
  const migration = spawnStartsTheTaskMigration(files);
  database.apply(files.filter((f) => f !== migration));
  fixture = await seedPre131(database);
  database.apply([migration]);
});

afterAll(async () => {
  await database?.destroy();
});

describe('131: a spawn starts the task it is spawned on', () => {
  it('moves an `open` task to `working`', async () => {
    const taskId = await taskInStatus('open');
    expect(await statusOf(taskId)).toBe('open');

    await spawnOn(taskId);

    expect(await statusOf(taskId)).toBe('working');
  });

  it('moves a `pulled` task to `working`', async () => {
    const taskId = await taskInStatus('pulled');

    await spawnOn(taskId);

    expect(await statusOf(taskId)).toBe('working');
  });

  it('records `work.changed` naming the spawn as the cause', async () => {
    const taskId = await taskInStatus('open');

    await spawnOn(taskId);

    const rows = await database.query<{ summary: Record<string, unknown> }>(
      `select summary from public.activity
        where entity_id = $1 and verb = 'work.changed'`,
      [taskId],
    );
    // Same verb `set_work_state` uses, so the feed reads identically whether a
    // human pressed Start or a spawn did; `via` is what tells them apart.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toMatchObject({ status: 'working', via: 'spawn' });
  });

  it('patches the task with the NEW status, so clients re-read it', async () => {
    const taskId = await taskInStatus('open');

    const { patches } = await spawnOn(taskId);

    const patched = patches.find((p) => p.id === taskId);
    // What this proves is CLIENT-VISIBLE, not an ordering fact. `patches` is a
    // uuid[] that internal.command_result (007:49) expands through
    // internal.command_entity at the moment it is CALLED — after the loop — so
    // the resolved content reads `working` regardless of whether the UPDATE ran
    // before or after `patches := patches || task_id`. No in-transaction
    // assertion can separate those two, because there is no observation point
    // between them. The property worth having is this: the spawn RESPONSE
    // already carries the new status, so a client applying it does not render
    // `open` and then correct itself on the next read.
    expect(patched?.content.work_status).toBe('working');
  });

  it('still writes 111 assignment alongside the status', async () => {
    const taskId = await taskInStatus('open');

    await spawnOn(taskId);

    const rows = await database.query<{ via: string | null }>(
      `select props->>'via' via from public.edges
        where src_id = $1 and dst_id = $2 and type = 'assigned_to'`,
      [taskId, fixture.teamMemberId],
    );
    expect(rows).toEqual([{ via: 'spawn' }]);
  });

  it('still writes 048 working_on alongside the status', async () => {
    // The cumulative-facts check. `execution_spawn` is redefined by
    // create-or-replace migrations that git cannot show a conflict for, so this
    // file asserts EVERY arm the current body owes — 048's live edge, 111's
    // assignment, 131's status — and not only the arm this migration added.
    // A future replace that silently drops any one of them goes red here.
    const taskId = await taskInStatus('open');

    const { sessionId } = await spawnOn(taskId);

    const rows = await database.query<{ count: string }>(
      `select count(*)::text count from public.edges
        where src_id = $1 and dst_id = $2 and type = 'working_on'`,
      [sessionId, taskId],
    );
    expect(rows).toEqual([{ count: '1' }]);
  });
});

describe('131 leaves every other status alone', () => {
  // `blocked` and `in_review` are statements a person made; `done` and
  // `cancelled` are terminal and entity-read.ts:1417 already suppresses the
  // live badge on them. A door that promoted these would pass the happy-path
  // test above and quietly destroy the reason a task was parked.
  for (const status of ['blocked', 'in_review', 'done', 'cancelled']) {
    it(`does not move a \`${status}\` task`, async () => {
      const taskId = await taskInStatus(status);

      await spawnOn(taskId);

      expect(await statusOf(taskId)).toBe(status);
      expect(await workChangedCount(taskId)).toBe(0);
    });
  }

  it('is a silent no-op on a task that is already `working`', async () => {
    const taskId = await taskInStatus('working');
    const before = await database.query<{ version: number }>(
      `select version from public.entities where id = $1`,
      [taskId],
    );

    await spawnOn(taskId);

    expect(await statusOf(taskId)).toBe('working');
    // The `where` clause, not an `if` around it: no row matched, so
    // `tasks_snapshot_version` never fired and no feed row was written.
    expect(await workChangedCount(taskId)).toBe(0);
    const after = await database.query<{ version: number }>(
      `select version from public.entities where id = $1`,
      [taskId],
    );
    expect(after[0]!.version).toBe(before[0]!.version);
  });

  it('a re-spawn on the same task records the change exactly once', async () => {
    const taskId = await taskInStatus('open');

    await spawnOn(taskId);
    await spawnOn(taskId);

    expect(await statusOf(taskId)).toBe('working');
    expect(await workChangedCount(taskId)).toBe(1);
  });
});
