/**
 * 155 against a real Postgres: a `c:` kind that EXTENDS `task` behaves as one,
 * and the `type` axis is gone.
 *
 * ## What only this file can say
 *
 * The migration's own `$verify$` block asserts shapes and counts against
 * whatever data the node happened to hold — that `task_workflows` is gone, that
 * no task still carries `axes.type`, that every entity of a task-based kind has
 * a `public.tasks` row. What it CANNOT do is manufacture rows to test itself
 * against: a migration that created an epic to prove epics work would be
 * asserting against its own fixture. So the division of labour 152 wrote down
 * holds here — the in-file block guards a POPULATED node, this file guards a
 * fresh one, and the two claims are different.
 *
 * The claims here are BEHAVIOURAL, and each is a literal that 155 replaced with
 * `internal.base_kind_of`. Every case below fails against `main`:
 *
 *   * `internal.validate_entity_parent` — the amendment. `c:epic` parents a
 *     `task`. This is the one that was RULED rather than derived.
 *   * `internal.live_entity` — `set_work_state` and `update_task_content` reach
 *     an epic. (`execution_spawn` reaches it through the same helper, which is
 *     why this file does not have to spawn a session to cover it.)
 *   * `internal.validate_detail_envelope` — an epic may HAVE a tasks row.
 *   * `internal.validate_edge` — an epic is assignable and workable-on.
 *   * `internal.entity_content` — an epic's body is its task row, not a
 *     missing custom-entities row.
 *   * `public.complete_task`, `public.place_entity` — the two remaining kind
 *     literals in the doors.
 *
 * ## Why the refusals matter as much as the grants
 *
 * `base_kind` is constrained to `task` and to custom origins, and a kind that
 * extends `task` may not declare a field schema. Those are not omissions; they
 * are the promise that a detail row of the base's shape can be CREATED, and
 * `task` is the only base whose create door exists. A test that only proved the
 * grants would let the constraint be dropped without a single red.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

let unique = 0;
function cmid(label: string): string {
  unique += 1;
  return `kind-155-${label}-${unique}`;
}

async function asOwner<T>(
  fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function asApp<T>(
  fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-155',true)`,
      [fixture.identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<Fixture>(
        `select 'kind-155-owner'::text "identityId",
                internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Kind owner')`,
      [f.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Kinds',$2)`,
      [f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [f.memberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Kind owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    return f;
  });
}

/** Define a custom kind through the real admin door. */
async function defineKind(
  kind: string,
  opts: { baseKind?: string | null; label?: string | null; labelPlural?: string | null; fieldSchema?: unknown } = {},
): Promise<Record<string, unknown>> {
  const rows = await asApp((q) =>
    q(
      `select public.w2_create_entity_kind($1,$2,null,$3::jsonb,'{}'::jsonb,$4,$5,$6,$7,$8) as view`,
      [
        fixture.spaceId,
        kind,
        JSON.stringify(opts.fieldSchema ?? []),
        fixture.memberId,
        cmid(`define-${kind}`),
        opts.baseKind ?? null,
        opts.label ?? null,
        opts.labelPlural ?? null,
      ],
    ),
  );
  return rows[0]!.view as Record<string, unknown>;
}

/** Create a task-shaped entity through the real door, of any task-based kind. */
async function createTask(
  title: string,
  opts: { kind?: string; parentId?: string | null } = {},
): Promise<string> {
  const rows = await asApp((q) =>
    q(
      `select public.create_task($1,$2,$3,'','{}'::jsonb,$4,null,'medium','[]'::jsonb,
                                 null,null,null,'attached_to',$5,$6) as result`,
      [fixture.spaceId, title, fixture.memberId, opts.parentId ?? null, cmid('create'), opts.kind ?? 'task'],
    ),
  );
  return (rows[0]!.result as { entity: { id: string } }).entity.id;
}

async function entityRow(id: string): Promise<{ kind: string; parent_id: string | null; status_category: string | null; position: string }> {
  const rows = await database.query<{ kind: string; parent_id: string | null; status_category: string | null; position: string }>(
    `select kind, parent_id, status_category, position from public.entities where id = $1`,
    [id],
  );
  return rows[0]!;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('kind-absorbs-155');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
}, 30_000);

// ---------------------------------------------------------------------------
// 1. The kind row
// ---------------------------------------------------------------------------

describe('155 — entity_kinds carries the extends link and its labels', () => {
  it('a custom kind may extend task, and the door answers with the new fields', async () => {
    const view = await defineKind('c:epic', { baseKind: 'task', label: 'Epic', labelPlural: 'Epics' });
    expect(view.kind).toBe('c:epic');
    expect(view.baseKind).toBe('task');
    expect(view.label).toBe('Epic');
    expect(view.labelPlural).toBe('Epics');
    // 152's column, now visible through the same view. Unset means the
    // built-in default workflow.
    expect(view).toHaveProperty('workflowId');
  });

  it('a base-less custom kind is still legal and still generic', async () => {
    const view = await defineKind('c:note', { label: 'Note', labelPlural: 'Notes' });
    expect(view.baseKind).toBeNull();
  });

  it('REFUSES a base other than task — the base is a promise the create door can keep', async () => {
    await expect(defineKind('c:page', { baseKind: 'doc' })).rejects.toThrow(/may only extend .?task/);
  });

  it('REFUSES a field schema on a kind that extends task', async () => {
    // The create door writes a `public.tasks` row and no `custom_entities` row,
    // so a declared field would be a schema nothing can populate. Stated as a
    // refusal rather than left as a silent no-op.
    await expect(
      defineKind('c:fielded', {
        baseKind: 'task',
        fieldSchema: [{ name: 'quarter', type: 'text' }],
      }),
    ).rejects.toThrow(/may not declare custom fields/);
  });

  it('REFUSES base_kind on a core row, at the constraint', async () => {
    await expect(
      asOwner((q) => q(`update public.entity_kinds set base_kind = 'task' where kind = 'doc' and space_id is null`)),
    ).rejects.toThrow(/entity_kinds_base_kind_shape/);
  });
});

// ---------------------------------------------------------------------------
// 2. An epic IS a task
// ---------------------------------------------------------------------------

describe('155 — a kind that extends task gets the task machinery', () => {
  it('create_task makes an entity of the custom kind WITH a tasks detail row', async () => {
    const epicId = await createTask('Q3 platform', { kind: 'c:epic' });
    const row = await entityRow(epicId);
    expect(row.kind, 'identity is the custom kind').toBe('c:epic');

    const detail = await database.query<{ title: string; work_status: string }>(
      `select title, work_status from public.tasks where entity_id = $1`,
      [epicId],
    );
    expect(detail.length, 'the detail envelope validator accepted it (internal.validate_detail_envelope)').toBe(1);
    expect(detail[0]!.title).toBe('Q3 platform');
    // 152's birth trigger, reached through the kind's workflow.
    expect(row.status_category).toBe('to_do');
  });

  it('create_task REFUSES a kind that extends nothing', async () => {
    await expect(createTask('Not a task', { kind: 'c:note' })).rejects.toThrow(/does not extend task/);
  });

  it('create_task REFUSES a kind that is not registered in this space', async () => {
    await expect(createTask('Nowhere', { kind: 'c:absent' })).rejects.toThrow(/does not extend task/);
  });

  it('THE AMENDMENT: an epic parents a task', async () => {
    // Ruled 2026-08-18. Before 155 `internal.validate_entity_parent` compared
    // kind literals, so this was refused — which made the IS-A claim a lie at
    // exactly the layer where epics matter.
    const epicId = await createTask('Parent epic', { kind: 'c:epic' });
    const storyId = await createTask('A story', { parentId: epicId });
    expect((await entityRow(storyId)).parent_id).toBe(epicId);
  });

  it('and a task parents an epic — the rule is symmetric, because bases are', async () => {
    const taskId = await createTask('Parent task');
    const epicId = await createTask('Child epic', { kind: 'c:epic', parentId: taskId });
    expect((await entityRow(epicId)).parent_id).toBe(taskId);
  });

  it('but a DIFFERENT base is still refused — the constraint moved, it did not vanish', async () => {
    const taskId = await createTask('Task parent');
    await expect(
      asOwner((q) =>
        q(
          `insert into public.entities(space_id,kind,parent_id,position,created_by)
           values($1,'doc',$2,0,$3)`,
          [fixture.spaceId, taskId, fixture.memberId],
        ),
      ),
    ).rejects.toThrow(/base kind/);
  });

  it('siblings of different kinds under one parent get DISTINCT positions', async () => {
    // The direct consequence of the amendment, and the one that fails silently:
    // `internal.assign_entity_position` scoped `max(position)` by the literal
    // kind, so an epic and a task under one parent would both be given the
    // same slot with no error anywhere.
    const parentId = await createTask('Mixed parent', { kind: 'c:epic' });
    const a = await createTask('Story A', { parentId });
    const b = await createTask('Sub-epic B', { kind: 'c:epic', parentId });
    const positions = [(await entityRow(a)).position, (await entityRow(b)).position];
    expect(new Set(positions).size, `both children took position ${positions.join(' / ')}`).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. The doors
// ---------------------------------------------------------------------------

describe('155 — every task door reaches an epic', () => {
  it('set_work_state moves it, and the category follows (internal.live_entity)', async () => {
    const epicId = await createTask('Workable', { kind: 'c:epic' });
    await asApp((q) =>
      q(`select public.set_work_state($1,'working',$2,null,null,$3)`, [epicId, fixture.memberId, cmid('work')]),
    );
    expect((await entityRow(epicId)).status_category).toBe('in_progress');
  });

  it('update_task_content renames it (internal.live_entity again)', async () => {
    const epicId = await createTask('Before', { kind: 'c:epic' });
    const version = (await database.query<{ version: number }>(
      `select version from public.entities where id = $1`,
      [epicId],
    ))[0]!.version;
    await asApp((q) =>
      q(`select public.update_task_content($1,$2,$3,'After',null,null,null,null,null,null,null,false,$4)`,
        [epicId, version, fixture.memberId, cmid('patch')]),
    );
    const title = (await database.query<{ title: string }>(
      `select title from public.tasks where entity_id = $1`, [epicId]))[0]!.title;
    expect(title).toBe('After');
  });

  it('complete_task completes it and the gate still fires', async () => {
    const epicId = await createTask('Completable', { kind: 'c:epic' });
    const version = (await database.query<{ version: number }>(
      `select version from public.entities where id = $1`, [epicId]))[0]!.version;
    await asApp((q) =>
      q(`select public.complete_task($1,$2,'{}'::uuid[],$3,$4)`,
        [epicId, version, fixture.memberId, cmid('complete')]),
    );
    expect((await entityRow(epicId)).status_category).toBe('done');
  });

  it('complete_task REFUSES an epic whose acceptance criteria are open — the gate is inherited too', async () => {
    const epicId = await createTask('Gated', { kind: 'c:epic' });
    await asOwner((q) =>
      q(`update public.tasks set acceptance_criteria = '[{"text":"do it","done":false}]'::jsonb
          where entity_id = $1`, [epicId]),
    );
    const version = (await database.query<{ version: number }>(
      `select version from public.entities where id = $1`, [epicId]))[0]!.version;
    await expect(
      asApp((q) =>
        q(`select public.complete_task($1,$2,'{}'::uuid[],$3,$4)`,
          [epicId, version, fixture.memberId, cmid('gated')]),
      ),
    ).rejects.toThrow(/acceptance criteria/);
  });

  it('place_entity assigns it (internal.validate_edge, and the assign verb)', async () => {
    const epicId = await createTask('Assignable', { kind: 'c:epic' });
    await asApp((q) =>
      q(`select public.place_entity($1,$2,'assign',null,null,$3,$4)`,
        [epicId, fixture.memberId, fixture.memberId, cmid('assign')]),
    );
    const edges = await database.query(
      `select 1 from public.edges where src_id = $1 and dst_id = $2 and type = 'assigned_to'`,
      [epicId, fixture.memberId],
    );
    expect(edges.length).toBe(1);
  });

  it('place_entity reparents a story onto an epic — the same rule as the trigger', async () => {
    // Two answers to one question is the failure this case exists to prevent:
    // if only the trigger had moved, dragging a story onto an epic would be
    // refused HERE while the same move through entities.patch succeeded.
    const epicId = await createTask('Drop target', { kind: 'c:epic' });
    const storyId = await createTask('Dragged');
    await asApp((q) =>
      q(`select public.place_entity($1,$2,'reparent',null,null,$3,$4)`,
        [storyId, epicId, fixture.memberId, cmid('reparent')]),
    );
    expect((await entityRow(storyId)).parent_id).toBe(epicId);
  });

  it('derive_task_for_entity treats an epic as its own anchor', async () => {
    const epicId = await createTask('Anchor', { kind: 'c:epic' });
    const result = (
      await asApp((q) => q(`select public.derive_task_for_entity($1,$2,$3) as r`,
        [fixture.spaceId, epicId, fixture.memberId]))
    )[0]!.r as { taskId: string; created: boolean; sourceKind: string };
    expect(result.created, 'no second task is manufactured beside it').toBe(false);
    expect(result.taskId).toBe(epicId);
    expect(result.sourceKind, 'and it reports what it actually is').toBe('c:epic');
  });

  it('internal.entity_content assembles the task body, not a missing custom row', async () => {
    const epicId = await createTask('Bodied', { kind: 'c:epic' });
    const content = (
      await asOwner((q) => q(`select internal.entity_content($1) as c`, [epicId]))
    )[0]!.c as Record<string, unknown>;
    expect(content.title).toBe('Bodied');
    // The overlay: a kind that extends task AND declares fields would get both.
    // Nothing can create such a row yet, so the honest answer is an empty bag.
    expect(content.fields).toEqual({});
  });

  it('a BASE-LESS custom kind still goes the custom route', async () => {
    const noteId = (
      await asApp((q) =>
        q(`select public.create_custom_entity($1,'c:note','A note',$2,'{}'::jsonb,null,null,$3) as r`,
          [fixture.spaceId, fixture.memberId, cmid('note')]))
    )[0]!.r as { entity: { id: string } };
    const content = (
      await asOwner((q) => q(`select internal.entity_content($1) as c`, [noteId.entity.id]))
    )[0]!.c as Record<string, unknown>;
    expect(content.title).toBe('A note');
    // ...and it may NOT parent a task: it extends nothing.
    await expect(createTask('Under a note', { parentId: noteId.entity.id })).rejects.toThrow(/base kind/);
  });
});

// ---------------------------------------------------------------------------
// 4. The type axis is gone, and cannot come back
// ---------------------------------------------------------------------------

describe('155 — the type axis and task_workflows are retired', () => {
  it('a new space is born without a type axis', async () => {
    const rows = await database.query(
      `select 1 from public.task_axes where lower(btrim(name)) = 'type'`,
    );
    expect(rows.length).toBe(0);
  });

  it('and a type axis cannot be created', async () => {
    await expect(
      asOwner((q) =>
        q(`insert into public.task_axes(space_id,name,axis_values,kind,position)
           values($1,'type',array['epic'],'manual',0)`, [fixture.spaceId]),
      ),
    ).rejects.toThrow(/task_axes_type_is_a_kind/);
  });

  it('but an HONEST axis still works — only `type` died', async () => {
    // The scope ruling, tested. `task_axes` survives for tags (team, quarter);
    // it was the taxonomy smuggled through the tag door that had to go.
    await asApp((q) =>
      q(`select public.w2_create_task_axis($1,'quarter',array['Q3','Q4'],'manual',0,$2,$3)`,
        [fixture.spaceId, fixture.memberId, cmid('axis')]),
    );
    const rows = await database.query(`select 1 from public.task_axes where name = 'quarter'`);
    expect(rows.length).toBe(1);
  });

  it('task_workflows, its trigger and both RPCs no longer exist', async () => {
    const table = await database.query<{ r: string | null }>(
      `select to_regclass('public.task_workflows')::text as r`,
    );
    expect(table[0]!.r).toBeNull();

    const trigger = await database.query(
      `select 1 from pg_trigger where tgname = 'tasks_validate_workflow' and not tgisinternal`,
    );
    expect(trigger.length).toBe(0);

    const procs = await database.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname in ('upsert_task_workflow','delete_task_workflow','validate_task_workflow')`,
    );
    expect(procs.map((r) => r.proname)).toEqual([]);
  });

  it('workflow resolution no longer takes a type value at all', async () => {
    // The signature change is the point: a defaulted-away parameter every
    // caller passes NULL to is a slot the next reader has to prove is dead.
    const three = await database.query(
      `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'internal' and p.proname = 'workflow_for_entity'
          and p.pronargs = 3`,
    );
    expect(three.length).toBe(0);
  });
});
