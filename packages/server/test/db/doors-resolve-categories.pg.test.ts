/**
 * 150 against a real Postgres: the three doors stop writing literals.
 *
 * ## What is actually worth asserting here
 *
 * "create_task writes a status_id" is the easy half and it is not where this
 * change can go wrong. The four things that can:
 *
 *   1. THE GUARD. `execution_spawn`'s `and work_status in ('open','pulled')`
 *      becomes `and status_category = 'to_do'`, and the design's claim is that
 *      this is MORE correct — a space that put a third status in `to_do` is
 *      skipped by the literal list today. That claim is only provable against a
 *      space that HAS such a status, so this file authors one (`in_review` as
 *      `to_do`, a real configuration a team that reviews before starting would
 *      write) and spawns on it. A test that only used `open` and `pulled` would
 *      pass identically against the literal list it replaced.
 *
 *   2. THE WORKFLOW IDENTITY. There is no kind → workflow link until phase 5, so
 *      resolution runs through the `type` axis. Getting that wrong is invisible
 *      in the happy path — every workflow's initial state is `to_do` — and shows
 *      up later as a `cross_workflow_transition` refusal on a task nobody can
 *      move. So the create-door assertions check WHICH workflow's state, never
 *      just the category.
 *
 *   3. THE EVENT COST. 147's header and `ws-e2e.pg.test.ts` both hold the same
 *      line: an entity is two inserts and `entities_capture_event` is per row, so
 *      an envelope column written from the detail side doubles every creation.
 *      150 moves what is written into NEW at BEFORE INSERT and adds a bridge on
 *      `tasks` that must find its work already done. Asserted as a count, because
 *      the data is correct either way and only the log knows.
 *
 *   4. THE ONE AUTHORITY. `status_category` is denormalized and 147 shipped two
 *      transitional writers of it. After 150 the ONLY writer is 149's trigger,
 *      deriving it from the state — so the interesting assertion is that a
 *      `set_work_state` move, which this phase deliberately does not touch,
 *      still leaves `status_id` and `status_category` agreeing.
 *
 * ## Why this runs through the real doors as `tm8_app`
 *
 * The opposite posture to `workflows.pg.test.ts`, and deliberately: that file
 * proves SCHEMA invariants and therefore writes tables directly. This one proves
 * what three RPCs do, and an RPC exercised as the schema owner proves that the
 * SQL parses. `spawn-starts-the-task.pg.test.ts` is the precedent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * Every case here is several round trips — a create door, a state move, a spawn,
 * then three catalog reads to check the result. Vitest's 5s default is a budget
 * for a pure function, and CI's runner is roughly ten times slower than a dev
 * box; the failure arrives there as NAMED test failures that read exactly like
 * real regressions. Set at file top, per the in-tree precedent.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** The built-in default workflow's fixed id, seeded by 149. */
const BUILTIN = '00000000-0000-4000-8000-00000000f100';

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
  return `doors-150-${label}-${unique}`;
}

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<Fixture>(
        `select 'doors-150-owner'::text "identityId",
                internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId",
                internal.new_id()::text "teamMemberId"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Doors owner')`,
      [f.identityId],
    );
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Doors',$2)`, [
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
       values($1,$2,$3,'owner','Doors owner')`,
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
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-doors',true)`,
      [fixture.identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

interface StatusRow {
  work_status: string;
  status_category: string | null;
  state_name: string | null;
  workflow_id: string | null;
}

/** Everything the change touches, in one read: the legacy column and the new one. */
async function statusOf(taskId: string): Promise<StatusRow> {
  const rows = await database.query<StatusRow>(
    `select t.work_status, e.status_category, s.name state_name, s.workflow_id
       from public.tasks t
       join public.entities e on e.id = t.entity_id
       left join public.workflow_states s on s.id = e.status_id
      where t.entity_id = $1`,
    [taskId],
  );
  return rows[0]!;
}

/** Every `entity.upsert` the log holds, right now. 147's instrument, reused. */
async function upserts(): Promise<number> {
  const rows = await database.query<{ n: string }>(
    `select count(*) n from public.workspace_events where event_type = 'entity.upsert'`,
  );
  return Number(rows[0]!.n);
}

/**
 * PHASE 6: the second argument was an AXES map, and `'reviewfirst'` is
 * how a task reached its workflow. It is a workflow NAME now, resolved to the
 * kind that governs it — `create_task` grew a trailing `kind` argument, and a
 * kind extending `task` goes through this same door with the same detail row.
 */
async function createTask(title: string, workflow: string | null = null): Promise<string> {
  const rows = await asApp((q) =>
    q(
      `select public.create_task($1,$2,null,'','{}'::jsonb,null,null,'medium','[]'::jsonb,null,null,null,'attached_to',$3,$4) result`,
      [
        fixture.spaceId,
        title,
        cmid(`create-${title}`),
        workflow === null ? 'task' : kindFor(workflow),
      ],
    ),
  );
  return (rows[0]!.result as { entity: { id: string } }).entity.id;
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

async function spawnOn(taskId: string): Promise<void> {
  await asApp((q) =>
    q(
      `select public.execution_spawn($1,$2,array[$3]::uuid[],null,'scratch',null,null,
         null,'claude-opus-5','claude','Starting','node-local',true,64,null,$4) result`,
      [fixture.spaceId, fixture.teamMemberId, taskId, cmid('spawn')],
    ),
  );
}

async function versionOf(taskId: string): Promise<number> {
  const rows = await database.query<{ version: number }>(
    `select version from public.entities where id = $1`,
    [taskId],
  );
  return Number(rows[0]!.version);
}

async function completeTask(taskId: string): Promise<void> {
  const version = await versionOf(taskId);
  await asApp((q) =>
    q(`select public.complete_task($1,$2,'{}'::uuid[],null,$3) result`, [taskId, version, cmid('complete')]),
  );
}

interface StateSpec {
  name: string;
  category: string;
  position: number;
  isInitial?: boolean;
}

/**
 * A space-authored workflow, plus the `task_workflows` row that makes its state
 * names a legal vocabulary for `tasks.work_status`.
 *
 * BOTH are needed and the pairing is the transitional reality this phase lives
 * in: 132's trigger polices the legacy column against `task_workflows`, and 149's
 * tables are what 150's doors resolve against. Phase 6 collapses them; until then
 * a test that wrote only one of them would be testing a space that cannot exist.
 */
/**
 * PHASE 6: this authored TWO rows — a `task_workflows` vocabulary keyed on a
 * `type` VALUE, and the real workflow beside it — because 150 resolved a task
 * to its workflow through the type axis. That arm is deleted, `task_workflows`
 * is dropped whole, and the link is `entity_kinds.workflow_id` (152's arm 0).
 * So the vocabulary row is gone and the workflow now names the KIND it governs.
 *
 * The kind row is written FIRST and its `workflow_id` filled in after, and both
 * halves of that order are forced: the per-category requirement can only ask
 * whether a workflow governs a completable kind if the kind already records that
 * it extends `task`, and `entity_kinds_validate_workflow` (152) checks the
 * reference on insert, so the workflow cannot be named before it exists.
 */
async function authorWorkflow(name: string, states: readonly StateSpec[]): Promise<void> {
  const kind = kindFor(name);
  await asOwner(
    `insert into public.entity_kinds(kind,origin,space_id,base_kind)
     values($1,'custom',$2,'task') on conflict do nothing`,
    [kind, fixture.spaceId],
  );
  await asApp((q) =>
    q(`select public.upsert_workflow($1,$2,$3,$4::jsonb,'[]'::jsonb,$5) result`, [
      fixture.spaceId,
      name,
      kind,
      JSON.stringify(
        states.map((s) => ({
          name: s.name,
          category: s.category,
          position: s.position,
          isInitial: s.isInitial ?? false,
        })),
      ),
      cmid(`workflow-${name}`),
    ]),
  );
  await asOwner(
    `update public.entity_kinds set workflow_id = (select id from public.workflows
                                                    where space_id = $2 and name = $3)
      where kind = $1 and space_id = $2`,
    [kind, fixture.spaceId, name],
  );
}

/**
 * The custom kind standing in for what used to be a `type` axis value. Hyphens
 * become underscores: `entity_kinds_origin_shape` (001) pins a custom kind to
 * `^c:[a-z0-9][a-z0-9_]{0,48}$`, and an axis VALUE was under no such rule.
 */
function kindFor(name: string): string {
  return `c:${name.replace(/-/g, '_')}`;
}

async function asOwner(sql: string, params: unknown[] = []): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(sql, params);
  });
}

async function workflowIdFor(name: string): Promise<string> {
  const rows = await database.query<{ id: string }>(
    `select id from public.workflows where space_id = $1 and name = $2`,
    [fixture.spaceId, name],
  );
  return rows[0]!.id;
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

beforeAll(async () => {
  database = await createW1ScratchDatabase('doors-resolve-categories');
  database.apply(migrationFiles());
  fixture = await seed(database);
  // The `type` axis STOOD HERE, declaring `reviewfirst` and `nocancel` so tasks
  // could carry them. Phase 6 turned that axis into `c:` kinds exactly as the
  // note here predicted, and `task_axes_type_is_a_kind` now refuses the name
  // outright. `authorWorkflow` creates each value's kind beside its workflow.
}, 180_000);

afterAll(async () => {
  await database?.destroy();
}, 30_000);

// -----------------------------------------------------------------------------
describe('150 door 1 — create_task resolves the workflow INITIAL state', () => {
  it('births a plain task in the built-in default workflow, not the literal `open`', async () => {
    const task = await createTask('plain');
    const status = await statusOf(task);

    // The state, not merely the category: a wrong workflow with a right category
    // is the failure this whole file is shaped to catch.
    expect(status.workflow_id).toBe(BUILTIN);
    expect(status.state_name).toBe('To Do');
    // DERIVED by 149's trigger from the state — 147's seed no longer writes it.
    expect(status.status_category).toBe('to_do');
    // The legacy column still says `open`, from the column default it has always
    // had. Phase 5 deletes the column; until then the two must agree by category.
    expect(status.work_status).toBe('open');
  });

  it('births into the SPACE workflow named by the task`s type axis', async () => {
    await authorWorkflow('reviewfirst', [
      { name: 'open', category: 'to_do', position: 1, isInitial: true },
      { name: 'in_review', category: 'to_do', position: 2 },
      { name: 'working', category: 'in_progress', position: 3 },
      { name: 'done', category: 'done', position: 4 },
      { name: 'cancelled', category: 'cancelled', position: 5 },
    ]);

    const task = await createTask('typed', 'reviewfirst');
    const status = await statusOf(task);

    expect(status.workflow_id).toBe(await workflowIdFor('reviewfirst'));
    expect(status.state_name).toBe('open');
    expect(status.status_category).toBe('to_do');
  });

  /**
   * THE ONE-EVENT LAW. An entity is two inserts and `entities_capture_event` is
   * AFTER INSERT per row: a `status_id` written from the `tasks` side would make
   * every task creation in the product emit two `entity.upsert`s at one version.
   * 150 writes it into NEW at BEFORE INSERT on `entities` (or, for `create_task`,
   * straight into the envelope insert) precisely so this stays 1.
   */
  it('costs EXACTLY ONE entity.upsert, for both the plain and the typed path', async () => {
    const beforePlain = await upserts();
    await createTask('event-cost-plain');
    expect(await upserts()).toBe(beforePlain + 1);

    const beforeTyped = await upserts();
    await createTask('event-cost-typed', 'reviewfirst');
    expect(await upserts()).toBe(beforeTyped + 1);
  });
});

// -----------------------------------------------------------------------------
describe('150 door 2 — execution_spawn resolves in_progress, and guards by CATEGORY', () => {
  it('moves an untyped task to the built-in default`s in_progress state', async () => {
    const task = await createTask('spawn-plain');
    await spawnOn(task);
    const status = await statusOf(task);

    expect(status.state_name).toBe('In Progress');
    expect(status.status_category).toBe('in_progress');
    // The state's DISPLAY name cannot live in the legacy column, so the door
    // projects it onto the category's canonical literal.
    expect(status.work_status).toBe('working');
  });

  /**
   * THE POINT OF THE REKEY, and the one case the literal list gets wrong.
   *
   * `reviewfirst` maps `in_review` to `to_do` — a team that reviews a spec before
   * anyone starts building. Such a task HAS NOT STARTED, so a spawn must start
   * it; `and work_status in ('open','pulled')` skips it silently and the task sits
   * in review forever with a session attached to it.
   */
  it('starts a task in a THIRD to_do status — which the literal list would skip', async () => {
    const task = await createTask('spawn-review', 'reviewfirst');
    await setWorkState(task, 'in_review');

    const before = await statusOf(task);
    expect(before.work_status).toBe('in_review');
    expect(before.status_category).toBe('to_do');
    expect(before.work_status in { open: 1, pulled: 1 }).toBe(false);

    await spawnOn(task);

    const after = await statusOf(task);
    expect(after.state_name).toBe('working');
    expect(after.status_category).toBe('in_progress');
    expect(after.workflow_id).toBe(await workflowIdFor('reviewfirst'));
  });

  it('is still a no-op on a task that has already started', async () => {
    const task = await createTask('spawn-twice');
    await spawnOn(task);
    const first = await statusOf(task);
    await spawnOn(task);
    const second = await statusOf(task);

    expect(second.state_name).toBe(first.state_name);
    const rows = await database.query<{ n: string }>(
      `select count(*) n from public.activity
        where entity_id = $1 and verb = 'work.changed' and summary->>'via' = 'spawn'`,
      [task],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('leaves a `done` task alone — done is not to_do', async () => {
    const task = await createTask('spawn-done');
    await completeTask(task);
    await spawnOn(task);
    expect((await statusOf(task)).status_category).toBe('done');
  });
});

// -----------------------------------------------------------------------------
describe('150 door 3 — complete_task resolves the DONE state', () => {
  it('completes an untyped task into the built-in default`s done state', async () => {
    const task = await createTask('complete-plain');
    await completeTask(task);
    const status = await statusOf(task);

    expect(status.workflow_id).toBe(BUILTIN);
    expect(status.state_name).toBe('Done');
    expect(status.status_category).toBe('done');
    expect(status.work_status).toBe('done');
  });

  it('completes a typed task into ITS workflow`s done state', async () => {
    const task = await createTask('complete-typed', 'reviewfirst');
    await completeTask(task);
    const status = await statusOf(task);

    expect(status.workflow_id).toBe(await workflowIdFor('reviewfirst'));
    expect(status.state_name).toBe('done');
    expect(status.status_category).toBe('done');
  });

  /**
   * A CONSEQUENCE, recorded so it cannot be discovered as a surprise: the doors
   * are 149's first writer, so its transition validator now fires on real work.
   * `cancelled → done` is not in the ruled category set — the ruled reading is
   * that done comes from to_do or in_progress — so abandoned work can no longer
   * be quietly completed. It refuses with a machine-readable reason, not a bare
   * sqlstate.
   */
  it('refuses to complete a CANCELLED task, naming the transition', async () => {
    const task = await createTask('complete-cancelled');
    await setWorkState(task, 'cancelled');
    expect((await statusOf(task)).status_category).toBe('cancelled');

    const denied = await refusal(() => completeTask(task));
    expect(denied.code).toBe('23514');
    expect(denied.reason).toBe('transition_not_allowed');
    expect((await statusOf(task)).status_category).toBe('cancelled');
  });
});

// -----------------------------------------------------------------------------
describe('150 — the per-category requirement that REPLACES the structural three', () => {
  it('refuses a task workflow with no in_progress or done state', async () => {
    const denied = await refusal(() =>
      asApp((q) =>
        q(`select public.upsert_workflow($1,'todo-only','task',$2::jsonb,'[]'::jsonb,$3) result`, [
          fixture.spaceId,
          JSON.stringify([
            { name: 'Backlog', category: 'to_do', position: 1, isInitial: true },
            { name: 'Ready', category: 'to_do', position: 2 },
          ]),
          cmid('todo-only'),
        ]),
      ),
    );
    expect(denied.code).toBe('23514');
    expect(denied.reason).toBe('workflow_missing_required_categories');
  });

  /**
   * The requirement is derived from what the KIND can do, which is the whole
   * reason it is an improvement on "every vocabulary must contain three literals".
   * Nothing spawns or completes a `doc`, so a doc workflow needs only somewhere
   * to be born.
   */
  it('allows a to_do-only workflow for a kind that cannot spawn or complete', async () => {
    const rows = await asApp((q) =>
      q(`select public.upsert_workflow($1,'doc-flow','doc',$2::jsonb,'[]'::jsonb,$3) result`, [
        fixture.spaceId,
        JSON.stringify([{ name: 'Draft', category: 'to_do', position: 1, isInitial: true }]),
        cmid('doc-flow'),
      ]),
    );
    expect(rows).toHaveLength(1);
  });

  /**
   * PIN FLIPPED BY 151, DELIBERATELY. This read "leaves
   * task_workflows_structural_statuses in place for phase 4 to drop" while 150
   * was the tip: sub-doc 3's ordering is doors, then the gate onto the
   * transition, and only THEN the constraint, and a green suite that had
   * silently dropped it would have hidden the fact that phase 4 still had work.
   *
   * Phase 4 has now done that work, so the pin asserts the far side of the same
   * ordering — the constraint is gone AND the thing that replaced it is
   * attached. Flipping it rather than deleting it keeps the ordering claim under
   * test in both directions: a revert of 151 that left the drop behind, or a
   * future migration that removed 150's coverage triggers, both go red here.
   */
  it('drops task_workflows_structural_statuses in phase 4, leaving 150`s coverage triggers', async () => {
    const constraint = await database.query<{ n: string }>(
      `select count(*) n from pg_constraint
        where conname = 'task_workflows_structural_statuses'`,
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

  it('raises honestly when a workflow has no state in the asked-for category', async () => {
    await authorWorkflow('nocancel', [
      { name: 'open', category: 'to_do', position: 1, isInitial: true },
      { name: 'working', category: 'in_progress', position: 2 },
      { name: 'done', category: 'done', position: 3 },
    ]);
    const task = await createTask('no-cancel', 'nocancel');

    const denied = await refusal(() =>
      database.query(`select internal.workflow_state_for_category($1,'cancelled')`, [task]),
    );
    expect(denied.code).toBe('23514');
    expect(denied.reason).toBe('workflow_missing_category');
  });
});

// -----------------------------------------------------------------------------
describe('150 — ONE authority on entities.status_category', () => {
  /**
   * 147 shipped two transitional writers of the column and said phase 3's doors
   * would replace them. Asserted structurally, because "we deleted the other
   * writer" is exactly the kind of claim a comment makes and a schema forgets.
   */
  it('retires 147`s two transitional writers and installs their replacements', async () => {
    const rows = await database.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'internal'
          and p.proname in ('seed_entity_status_category','sync_entity_status_category',
                            'seed_entity_initial_status','bridge_task_status_to_state')
        order by p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      'bridge_task_status_to_state',
      'seed_entity_initial_status',
    ]);
  });

  /**
   * `set_work_state` is a FOURTH writer of `work_status` and this phase does not
   * touch it (re-keying its `done` refusal by category is phase 4). Without the
   * bridge it would leave `status_id` pointing at a state the task has left,
   * which is the two-authorities failure in its most concrete form.
   */
  it('keeps status_id truthful through a set_work_state move it does not own', async () => {
    const task = await createTask('bridge');
    for (const [status, state, category] of [
      ['pulled', 'To Do', 'to_do'],
      ['working', 'In Progress', 'in_progress'],
      ['blocked', 'In Progress', 'in_progress'],
    ] as const) {
      await setWorkState(task, status);
      const row = await statusOf(task);
      expect(row.work_status, status).toBe(status);
      // The built-in default has one state per category, so three legacy statuses
      // land in two states — and the category, which is the only thing anything
      // outside a workflow may read, is right for all three.
      expect(row.state_name, status).toBe(state);
      expect(row.status_category, status).toBe(category);
    }
  });

  it('backfilled every pre-existing task onto a state, with the categories agreeing', async () => {
    const rows = await database.query<{ n: string }>(
      `select count(*) n
         from public.entities e
         join public.workflow_states s on s.id = e.status_id
        where e.status_category is distinct from s.category`,
    );
    expect(Number(rows[0]!.n)).toBe(0);

    const orphans = await database.query<{ n: string }>(
      `select count(*) n from public.tasks t
         join public.entities e on e.id = t.entity_id
        where e.status_id is null`,
    );
    expect(Number(orphans[0]!.n)).toBe(0);
  });
});
