/**
 * 151 against a real Postgres: the completion gate is a property of ENTERING
 * THE DONE CATEGORY, not a property of `complete_task`.
 *
 * ## The scenario this file exists for, by name
 *
 * "Someone will create a status called Shipped on day one" (sub-doc 3). Every
 * check `complete_task` ran before 151 was keyed, directly or by way of the
 * already-complete guard, on the literal `done`. A space whose done state is
 * called `Shipped` therefore had two ways past both gates:
 *
 *   1. through `complete_task` itself, if the guard reading the literal ever
 *      disagreed with the state the resolver picked; and — the one that actually
 *      matters —
 *   2. through ANY OTHER WRITER of `entities.status_id`. Phase 5's universal
 *      status door is that writer, and it does not exist yet, so a test that
 *      only exercised `complete_task` would prove nothing about the change and
 *      would pass identically against the code 151 replaces.
 *
 * So the load-bearing cases here write `status_id` DIRECTLY, as the schema owner,
 * with no RPC in the path at all. That is the shape of the failure this phase is
 * about, and it is the shape phase 5 will arrive in.
 *
 * ## Why the workflows here carry no `task_workflows` row
 *
 * `doors-resolve-categories.pg.test.ts` pairs the two tables because it moves the
 * LEGACY column through 132's vocabulary trigger. This file's states are called
 * `Shipped` and `Released`, which `task_workflows_statuses_valid` cannot hold —
 * it is restricted to the seven literals. Leaving the `task_workflows` row out
 * makes 132's trigger inert for these types (its own "a type with no rule is
 * never touched" arm), which is exactly the configuration a space authoring a
 * real workflow lands in today.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/** Several round trips per case, and CI's runner is far slower than a dev box. */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teamMemberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

let unique = 0;
function cmid(label: string): string {
  unique += 1;
  return `gate-151-${label}-${unique}`;
}

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<Fixture>(
        `select 'gate-151-owner'::text "identityId",
                internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId",
                internal.new_id()::text "teamMemberId"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Gate owner')`,
      [f.identityId],
    );
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Gate',$2)`, [
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
       values($1,$2,$3,'owner','Gate owner')`,
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

/** The doors as `tm8_app` sees them — the role tm8-server actually connects as. */
async function asApp<T>(
  fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-gate',true)`,
      [fixture.identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

/** The writer phase 5 will be: `entities.status_id`, direct, no RPC in the path. */
async function moveStatus(entityId: string, stateId: string): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(`update public.entities set status_id = $2 where id = $1`, [entityId, stateId]);
  });
}

async function asOwner(sql: string, params: unknown[] = []): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(sql, params);
  });
}

interface StatusRow {
  work_status: string;
  status_category: string | null;
  state_name: string | null;
}

async function statusOf(taskId: string): Promise<StatusRow> {
  const rows = await database.query<StatusRow>(
    `select t.work_status, e.status_category, s.name state_name
       from public.tasks t
       join public.entities e on e.id = t.entity_id
       left join public.workflow_states s on s.id = e.status_id
      where t.entity_id = $1`,
    [taskId],
  );
  return rows[0]!;
}

interface StateSpec {
  name: string;
  category: string;
  position: number;
  isInitial?: boolean;
}

/** A space workflow ONLY — see the file header for why there is no vocabulary row. */
async function authorWorkflow(
  typeValue: string,
  states: readonly StateSpec[],
  transitions: readonly Record<string, unknown>[] = [],
): Promise<void> {
  await asApp((q) =>
    q(`select public.upsert_workflow($1,$2,'task',$3::jsonb,$4::jsonb,$5) result`, [
      fixture.spaceId,
      typeValue,
      JSON.stringify(
        states.map((s) => ({
          name: s.name,
          category: s.category,
          position: s.position,
          isInitial: s.isInitial ?? false,
        })),
      ),
      JSON.stringify(transitions),
      cmid(`workflow-${typeValue}`),
    ]),
  );
}

async function stateId(workflowName: string, state: string): Promise<string> {
  const rows = await database.query<{ id: string }>(
    `select s.id from public.workflow_states s
       join public.workflows w on w.id = s.workflow_id
      where w.space_id = $1 and w.name = $2 and s.name = $3`,
    [fixture.spaceId, workflowName, state],
  );
  return rows[0]!.id;
}

async function createTask(
  title: string,
  axes: Record<string, string> = {},
  criteria: readonly Record<string, unknown>[] = [],
): Promise<string> {
  const rows = await asApp((q) =>
    q(
      `select public.create_task($1,$2,null,'',$3::jsonb,null,null,'medium',$4::jsonb,null,null,null,null,'attached_to',$5) result`,
      [
        fixture.spaceId,
        title,
        JSON.stringify(axes),
        JSON.stringify(criteria),
        cmid(`create-${title}`),
      ],
    ),
  );
  return (rows[0]!.result as { entity: { id: string } }).entity.id;
}

async function versionOf(taskId: string): Promise<number> {
  const rows = await database.query<{ version: number }>(`select version from public.entities where id = $1`, [
    taskId,
  ]);
  return Number(rows[0]!.version);
}

async function completeTask(taskId: string): Promise<void> {
  const version = await versionOf(taskId);
  await asApp((q) =>
    q(`select public.complete_task($1,$2,'{}'::uuid[],null,$3) result`, [taskId, version, cmid('complete')]),
  );
}

async function setWorkState(taskId: string, status: string): Promise<void> {
  await asApp((q) =>
    q(`select public.set_work_state($1,$2,null,null,null,$3,false) result`, [
      taskId,
      status,
      cmid(`state-${status}`),
    ]),
  );
}

interface Refusal {
  code: string;
  reason: string | undefined;
  message: string;
}

async function refusal(fn: () => Promise<unknown>): Promise<Refusal> {
  try {
    await fn();
  } catch (error) {
    const pgError = error as { code?: string; detail?: string; message?: string };
    let reason: string | undefined;
    try {
      reason = pgError.detail ? (JSON.parse(pgError.detail) as { reason?: string }).reason : undefined;
    } catch {
      reason = undefined;
    }
    return { code: pgError.code ?? '', reason, message: pgError.message ?? '' };
  }
  throw new Error('expected a refusal, the call succeeded');
}

const UNCHECKED = [{ id: 'c1', text: 'the thing', done: false }];

beforeAll(async () => {
  database = await createW1ScratchDatabase('completion-gate-151');
  database.apply(migrationFiles());
  fixture = await seed(database);
  // `internal.validate_task_axes` (001) refuses an unknown axis outright, and the
  // `type` axis is what resolves a task to its workflow until phase 5.
  await asApp((q) =>
    q(`select public.create_task_axis($1,'type',$2::text[],'manual',0,$3) result`, [
      fixture.spaceId,
      ['shipped', 'twodone', 'donename', 'overridden', 'widened'],
      cmid('type-axis'),
    ]),
  );
  await authorWorkflow('shipped', [
    { name: 'Draft', category: 'to_do', position: 1, isInitial: true },
    { name: 'Building', category: 'in_progress', position: 2 },
    { name: 'Shipped', category: 'done', position: 3 },
  ]);
}, 180_000);

afterAll(async () => {
  await database?.destroy();
}, 30_000);

// -----------------------------------------------------------------------------
describe('151 — a status called `Shipped` cannot walk around the acceptance-criteria gate', () => {
  it('refuses complete_task on a workflow whose done state is not called done', async () => {
    const task = await createTask('ship-me', { type: 'shipped' }, UNCHECKED);
    expect((await statusOf(task)).state_name).toBe('Draft');

    const denied = await refusal(() => completeTask(task));
    expect(denied.code).toBe('23514');
    expect(denied.message).toContain('all acceptance criteria must be complete first');
    // 060's lesson, applied to the one raise that never carried a detail.
    expect(denied.reason).toBe('acceptance_criteria_incomplete');
    // Nothing moved.
    expect((await statusOf(task)).state_name).toBe('Draft');
  });

  /**
   * THE CASE THE WHOLE PHASE IS FOR. No RPC in the path: this is a bare write to
   * `entities.status_id`, which is what phase 5's universal-status door will be.
   * Before 151 the gate lived inside `complete_task` and this write sailed
   * through with an unfinished checklist.
   */
  it('refuses a DIRECT status_id write into the done category — no RPC in the path', async () => {
    const task = await createTask('direct-ship', { type: 'shipped' }, UNCHECKED);
    const shipped = await stateId('shipped', 'Shipped');

    const denied = await refusal(() => moveStatus(task, shipped));
    expect(denied.code).toBe('23514');
    expect(denied.reason).toBe('acceptance_criteria_incomplete');
    expect((await statusOf(task)).state_name).toBe('Draft');
  });

  it('lets the same task through once the checklist is finished, and lands it in Shipped', async () => {
    const task = await createTask('ship-when-ready', { type: 'shipped' }, UNCHECKED);
    await asOwner(
      `update public.tasks set acceptance_criteria = $2::jsonb where entity_id = $1`,
      [task, JSON.stringify([{ id: 'c1', text: 'the thing', done: true }])],
    );

    await completeTask(task);
    const status = await statusOf(task);
    expect(status.state_name).toBe('Shipped');
    expect(status.status_category).toBe('done');
    // The legacy column cannot hold `Shipped`, so 150's projection writes the
    // category's canonical literal. Phase 5 deletes the column and this line.
    expect(status.work_status).toBe('done');
  });

  it('keys the already-complete guard on the CATEGORY — `Shipped` is complete', async () => {
    const task = await createTask('ship-twice', { type: 'shipped' });
    await completeTask(task);
    expect((await statusOf(task)).state_name).toBe('Shipped');

    const denied = await refusal(() => completeTask(task));
    expect(denied.code).toBe('23514');
    expect(denied.message).toContain('task is already complete');
  });
});

// -----------------------------------------------------------------------------
describe('151 — 082`s pr_merged gate rides the same transition', () => {
  it('refuses a direct status_id write when the gate is on and no PR is tracked', async () => {
    const task = await createTask('gated-direct', { type: 'shipped' });
    await asOwner(`update public.tasks set completion_gate = 'pr_merged' where entity_id = $1`, [task]);

    const shipped = await stateId('shipped', 'Shipped');
    const denied = await refusal(() => moveStatus(task, shipped));
    expect(denied.code).toBe('23514');
    expect(denied.reason).toBe('gate_no_tracked_pr');
    expect(denied.message).toContain('completion gate pr_merged: no tracked pull request on this task');
  });

  it('leaves an ungated task alone — the condition reads the task`s own opt-in', async () => {
    const task = await createTask('ungated-direct', { type: 'shipped' });
    await moveStatus(task, await stateId('shipped', 'Shipped'));
    expect((await statusOf(task)).status_category).toBe('done');
  });
});

// -----------------------------------------------------------------------------
describe('151 — the gate fires on ENTERING the category, not on being in it', () => {
  it('does not re-run the gate on a refinement move between two done states', async () => {
    await authorWorkflow('twodone', [
      { name: 'Draft', category: 'to_do', position: 1, isInitial: true },
      { name: 'Building', category: 'in_progress', position: 2 },
      { name: 'Shipped', category: 'done', position: 3 },
      { name: 'Released', category: 'done', position: 4 },
    ]);
    const task = await createTask('refine', { type: 'twodone' });
    await completeTask(task);
    expect((await statusOf(task)).state_name).toBe('Shipped');

    // The entity is already done. An unfinished checklist added afterwards is a
    // fact about a task that has ENTERED the category; refusing to let it move
    // Shipped -> Released would be a gate on a move that enters nothing.
    await asOwner(`update public.tasks set acceptance_criteria = $2::jsonb where entity_id = $1`, [
      task,
      JSON.stringify(UNCHECKED),
    ]);
    await moveStatus(task, await stateId('twodone', 'Released'));
    expect((await statusOf(task)).state_name).toBe('Released');
  });
});

// -----------------------------------------------------------------------------
describe('151 — a workflow_transitions row narrows ALLOWEDNESS, it does not drop the gate', () => {
  it('still gates a move that an override row explicitly allows', async () => {
    await authorWorkflow(
      'overridden',
      [
        { name: 'Draft', category: 'to_do', position: 1, isInitial: true },
        { name: 'Building', category: 'in_progress', position: 2 },
        { name: 'Shipped', category: 'done', position: 3 },
      ],
      // "Shipped may only be entered from Building" — a RESTRICTION, 149's own
      // example. Adding it must not silently take the checklist gate with it.
      [{ from: 'Building', to: 'Shipped' }],
    );
    const task = await createTask('override-gate', { type: 'overridden' }, UNCHECKED);
    await moveStatus(task, await stateId('overridden', 'Building'));

    const shipped = await stateId('overridden', 'Shipped');
    const denied = await refusal(() => moveStatus(task, shipped));
    expect(denied.code).toBe('23514');
    expect(denied.reason).toBe('acceptance_criteria_incomplete');

    // And the row's own rule still bites: Draft may not enter Shipped at all.
    const fromDraft = await createTask('override-arrow', { type: 'overridden' });
    const arrow = await refusal(() => moveStatus(fromDraft, shipped));
    expect(arrow.reason).toBe('transition_not_allowed');
  });

  it('honours an EXPLICIT `{"acceptanceCriteria": false}` — saying it is the only way to say it', async () => {
    await authorWorkflow(
      'widened',
      [
        { name: 'Draft', category: 'to_do', position: 1, isInitial: true },
        { name: 'Building', category: 'in_progress', position: 2 },
        { name: 'Shipped', category: 'done', position: 3 },
      ],
      [{ to: 'Shipped', conditions: { acceptanceCriteria: false } }],
    );
    const task = await createTask('widened-gate', { type: 'widened' }, UNCHECKED);

    await moveStatus(task, await stateId('widened', 'Shipped'));
    expect((await statusOf(task)).status_category).toBe('done');
  });
});

// -----------------------------------------------------------------------------
describe('151 — set_work_state refuses by CATEGORY', () => {
  it('refuses a status whose category is done even though it is not called done', async () => {
    // A space that decided review IS the end of the line. `in_review` is a legal
    // member of the legacy vocabulary, so this is reachable through the door.
    await authorWorkflow('donename', [
      { name: 'open', category: 'to_do', position: 1, isInitial: true },
      { name: 'working', category: 'in_progress', position: 2 },
      { name: 'in_review', category: 'done', position: 3 },
    ]);
    const task = await createTask('review-is-done', { type: 'donename' });

    // The control: a move that is NOT into the done category still works.
    await setWorkState(task, 'working');
    expect((await statusOf(task)).state_name).toBe('working');

    const denied = await refusal(() => setWorkState(task, 'in_review'));
    expect(denied.code).toBe('23514');
    expect(denied.reason).toBe('use_complete_command');
    expect((await statusOf(task)).state_name).toBe('working');
  });

  it('still refuses the literal `done` on a task in the built-in default workflow', async () => {
    const task = await createTask('plain-done');
    const denied = await refusal(() => setWorkState(task, 'done'));
    expect(denied.code).toBe('23514');
    expect(denied.reason).toBe('use_complete_command');
  });

  it('still answers 22023 for a string that is no status at all', async () => {
    const task = await createTask('plain-nonsense');
    const denied = await refusal(() => setWorkState(task, 'Shipped'));
    expect(denied.code).toBe('22023');
    expect(denied.message).toContain('invalid work status');
  });
});

// -----------------------------------------------------------------------------
describe('151 — and only then, the structural constraint', () => {
  it('drops task_workflows_structural_statuses and keeps 150`s coverage triggers', async () => {
    const constraint = await database.query<{ n: string }>(
      `select count(*) n from pg_constraint where conname = 'task_workflows_structural_statuses'`,
    );
    expect(Number(constraint[0]!.n)).toBe(0);

    const triggers = await database.query<{ n: string }>(
      `select count(*) n from pg_trigger
        where tgname in ('workflows_assert_category_coverage',
                         'workflow_states_assert_category_coverage')
          and not tgisinternal`,
    );
    expect(Number(triggers[0]!.n)).toBe(2);
  });

  it('lets a space author a vocabulary without `done`, which was unrepresentable until now', async () => {
    await asApp((q) =>
      q(`select public.upsert_task_workflow($1,'no-done',$2::text[],$3) result`, [
        fixture.spaceId,
        ['open', 'working'],
        cmid('vocab-no-done'),
      ]),
    );
    const rows = await database.query<{ statuses: string[] }>(
      `select statuses from public.task_workflows where space_id = $1 and type_value = 'no-done'`,
      [fixture.spaceId],
    );
    expect(rows[0]!.statuses).toEqual(['open', 'working']);
  });

  /**
   * The replacement, doing the job the constraint used to. A workflow governing
   * a completable kind that has no `done` state is refused — which is what makes
   * `internal.workflow_state_for_category`'s raise unreachable at the complete
   * door now that nothing else guarantees it.
   */
  it('refuses a TASK workflow with no done state — the per-category requirement stands in', async () => {
    // A workflow NO task carries: re-authoring one that has entities sitting in
    // it would be refused by `entities_status_id_fkey` (RESTRICT) first, which
    // is a true refusal about the wrong thing.
    const denied = await refusal(() =>
      authorWorkflow('never-carried', [
        { name: 'Draft', category: 'to_do', position: 1, isInitial: true },
        { name: 'Building', category: 'in_progress', position: 2 },
      ]),
    );
    expect(denied.code).toBe('23514');
    expect(denied.reason).toBe('workflow_missing_required_categories');
  });
});
