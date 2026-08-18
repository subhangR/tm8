/**
 * 152 against a real Postgres: EVERY kind has a workflow, EVERY entity has a
 * status, and `internal.is_resolved` answers with the category.
 *
 * ## What is actually new here, and why the earlier phases' suites cannot say it
 *
 * 147-151 are all about tasks. `doors-resolve-categories.pg.test.ts` proves the
 * three task doors resolve a state; `completion-gate-on-the-transition.pg.test.ts`
 * proves the gate rides the transition. Both would pass unchanged against a
 * database in which nineteen of the twenty non-task kinds still carried
 * `status_id is null`, because neither ever creates one.
 *
 * So this file's load-bearing cases are about the OTHER kinds:
 *
 *   * a `doc`, a `commit`, a `work_session` are born with a status, through the
 *     same BEFORE INSERT trigger and still in exactly ONE event;
 *   * the facts-about-the-past kinds are born `done`, not `to_do`, and the same
 *     table governs birth and backfill;
 *   * a non-task in the done category RESOLVES a `depends_on` (owner decision
 *     #3 — the first time anything but a task or a merged PR ever has), and its
 *     mirror image, a `doc` in `to_do` now BLOCKS one where its mere existence
 *     used to unblock.
 *
 * ## Why so many cases write `entities` directly
 *
 * Nineteen of the twenty kinds have no RPC that a test can cheaply call, and the
 * trigger under test is on `public.entities` itself — it fires for every one of
 * them regardless of which door was used. Writing the envelope as
 * `tm8_graph_owner` is therefore the WIDEST exercise of the change, not a
 * shortcut around it; the task path through `create_task` is covered by 150's
 * suite and re-checked here only where 152 could have broken it.
 *
 * ## The backfill is asserted as an INVARIANT, not replayed
 *
 * The migration has already run by the time any test connects, so there is no
 * "before" to move. What can be checked — and is the actual claim of the phase —
 * is that the database it produced has no entity without a status, and that the
 * seeding table holds for every row it applies to. The migration's own `$verify$`
 * block makes the same assertions at apply time against whatever data is there;
 * these make them against the seeded fixture, where the rows are known.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/** Several round trips per case, and CI's runner is far slower than a dev box. */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  otherSpaceId: string;
  memberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

let unique = 0;
function cmid(label: string): string {
  unique += 1;
  return `universal-152-${label}-${unique}`;
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
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-152',true)`,
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
        `select 'universal-152-owner'::text "identityId",
                internal.new_id()::text "spaceId",
                internal.new_id()::text "otherSpaceId",
                internal.new_id()::text "memberId"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Universal owner')`,
      [f.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Universal',$2),($3,'Elsewhere',$2)`,
      [f.spaceId, f.identityId, f.otherSpaceId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [f.memberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Universal owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    return f;
  });
}

/** An envelope of any kind, born through the trigger under test. */
async function createEntity(kind: string, spaceId?: string): Promise<string> {
  const rows = await asOwner((q) =>
    q(
      `insert into public.entities(space_id,kind,parent_id,position,created_by)
       values($1,$2,null,0,$3) returning id`,
      [spaceId ?? fixture.spaceId, kind, fixture.memberId],
    ),
  );
  return rows[0]!.id as string;
}

interface StatusRow {
  status_id: string | null;
  status_category: string | null;
  state_name: string | null;
  workflow_id: string | null;
}

async function statusOf(entityId: string): Promise<StatusRow> {
  const rows = await database.query<StatusRow>(
    `select e.status_id, e.status_category, s.name state_name, s.workflow_id
       from public.entities e
       left join public.workflow_states s on s.id = e.status_id
      where e.id = $1`,
    [entityId],
  );
  return rows[0]!;
}

async function defaultState(category: string): Promise<string> {
  const rows = await database.query<{ id: string }>(
    `select s.id from public.workflow_states s
       join public.workflows w on w.id = s.workflow_id
      where w.space_id is null and s.category = $1
      order by s.is_default desc, s.position asc limit 1`,
    [category],
  );
  return rows[0]!.id;
}

async function moveTo(entityId: string, stateId: string): Promise<void> {
  await asOwner((q) => q(`update public.entities set status_id = $2 where id = $1`, [entityId, stateId]));
}

async function isResolved(entityId: string): Promise<boolean | null> {
  const rows = await database.query<{ r: boolean | null }>(
    `select internal.is_resolved($1) r`,
    [entityId],
  );
  return rows[0]!.r;
}

async function dependsOn(src: string, dst: string): Promise<void> {
  await asOwner((q) =>
    q(
      `insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
       values($1,$2,$3,'depends_on','{}'::jsonb,$4)`,
      [fixture.spaceId, src, dst, fixture.memberId],
    ),
  );
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('universal-status-152');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
}, 30_000);

// ---------------------------------------------------------------------------
// 1. entity_kinds.workflow_id, and arm 0 of the resolver
// ---------------------------------------------------------------------------

describe('152 — entity_kinds.workflow_id is the first arm of workflow resolution', () => {
  it('unset means THE built-in default workflow, for a core kind', async () => {
    const docId = await createEntity('doc');
    const status = await statusOf(docId);

    const builtin = await database.query<{ id: string }>(
      `select id from public.workflows where space_id is null`,
    );
    expect(builtin.length, 'there is exactly one built-in default workflow (149)').toBe(1);
    expect(status.workflow_id).toBe(builtin[0]!.id);
    expect(status.state_name).toBe('To Do');
    expect(status.status_category).toBe('to_do');
  });

  it('a custom kind pointing at a space workflow is born in THAT workflow', async () => {
    // The realistic shape of arm 0, and the shape phase 6 ships: a `c:` kind
    // with its own vocabulary. A CORE kind cannot have a per-space row at all
    // (`entity_kinds_origin_shape` restricts custom rows to `c:` names), so a
    // core kind's only override is a global one — see the scope case below.
    await asApp((q) =>
      q(`select public.upsert_workflow($1,'Epic flow','c:epic',$2::jsonb,'[]'::jsonb,$3)`, [
        fixture.spaceId,
        JSON.stringify([
          { name: 'Draft', category: 'to_do', position: 1, isInitial: true },
          { name: 'Committed', category: 'in_progress', position: 2 },
          { name: 'Shipped', category: 'done', position: 3 },
          { name: 'Dropped', category: 'cancelled', position: 4 },
        ]),
        cmid('epic-flow'),
      ]),
    );
    await asOwner((q) =>
      q(
        `insert into public.entity_kinds(kind,origin,space_id,workflow_id)
         values('c:epic','custom',$1,(select id from public.workflows
                                       where space_id = $1 and name = 'Epic flow'))`,
        [fixture.spaceId],
      ),
    );

    const epicId = await createEntity('c:epic');
    const status = await statusOf(epicId);

    // `is_initial`, not "the to_do state" — 150's birth resolver reads the flag,
    // and the flag is the stronger claim (exactly one per workflow).
    expect(status.state_name).toBe('Draft');
    expect(status.status_category).toBe('to_do');
  });

  it('a kind may not borrow another space’s workflow', async () => {
    await asApp((q) =>
      q(`select public.upsert_workflow($1,'Elsewhere flow','c:secret',$2::jsonb,'[]'::jsonb,$3)`, [
        fixture.spaceId,
        JSON.stringify([
          { name: 'A', category: 'to_do', position: 1, isInitial: true },
          { name: 'B', category: 'in_progress', position: 2 },
          { name: 'C', category: 'done', position: 3 },
          { name: 'D', category: 'cancelled', position: 4 },
        ]),
        cmid('secret-flow'),
      ]),
    );

    await expect(
      asOwner((q) =>
        q(
          `insert into public.entity_kinds(kind,origin,space_id,workflow_id)
           values('c:secret','custom',$1,(select id from public.workflows
                                           where space_id = $2 and name = 'Elsewhere flow'))`,
          [fixture.otherSpaceId, fixture.spaceId],
        ),
      ),
    ).rejects.toThrow(/another space/);
  });
});

// ---------------------------------------------------------------------------
// 2. Birth: every kind, one event, and the seeding table
// ---------------------------------------------------------------------------

describe('152 — every entity is born with a status', () => {
  // Not an exhaustive list on purpose: the trigger does not branch on kind
  // except through `internal.kind_seeds_done`, so the cases that matter are one
  // of each SIDE of that branch plus the kinds the ruling names.
  // `project` is absent deliberately: its envelope is materializer-owned and
  // refuses a direct insert, so it cannot be created this way. Its birth path
  // runs the same trigger as every other kind here.
  const TO_DO_KINDS = ['doc', 'channel', 'work_session', 'spell', 'skill', 'loop', 'graph'];
  const DONE_KINDS = ['commit', 'message', 'file', 'memory', 'artifact'];

  it.each(TO_DO_KINDS)('%s is born in the default workflow’s to_do state', async (kind) => {
    const id = await createEntity(kind);
    const status = await statusOf(id);
    expect(status.status_id, `${kind} was born with no status`).not.toBeNull();
    expect(status.status_category).toBe('to_do');
  });

  it.each(DONE_KINDS)('%s is a fact about the past and is born done', async (kind) => {
    const id = await createEntity(kind);
    const status = await statusOf(id);
    expect(status.status_id, `${kind} was born with no status`).not.toBeNull();
    expect(status.status_category).toBe('done');
  });

  it('THE ONE-EVENT LAW: creating a non-task kind is still exactly one event', async () => {
    // The tripwire 147's header names, applied to the twenty kinds 152 brings
    // into the trigger's scope for the first time. A status written AFTER
    // INSERT — from a detail table, say — would show as two `entity.upsert`
    // rows here, which is the exact failure the BEFORE INSERT placement exists
    // to prevent.
    const docId = await createEntity('doc');
    const commitId = await createEntity('commit');

    const rows = await database.query<{ id: string; n: string }>(
      `select payload->>'id' id, count(*)::text n
         from public.workspace_events
        where event_type = 'entity.upsert' and payload->>'id' = any($1::text[])
        group by 1`,
      [[docId, commitId]],
    );
    expect(rows.map((r) => [r.id, Number(r.n)]).sort()).toEqual(
      [[commitId, 1], [docId, 1]].sort(),
    );
  });

  it('birth is UNGATED: a done seed does not run the →done conditions', async () => {
    // 151 attached `acceptanceCriteria` and `completionGate` to any move into
    // the done category. A commit has neither column and no `tasks` row, and it
    // is born straight into `done` — which is legal only because 149's trigger
    // returns early for `tg_op = 'INSERT'`. If that arm is ever narrowed, this
    // is the case that says so.
    const commitId = await createEntity('commit');
    expect((await statusOf(commitId)).status_category).toBe('done');
  });

  it('the backfill left NOTHING without a status', async () => {
    const rows = await database.query<{ n: string }>(
      `select count(*)::text n from public.entities
        where status_id is null or status_category is null`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('the same seeding table governs birth and backfill', async () => {
    // Stated as a DISAGREEMENT count rather than a match count: "every
    // done-seeded row is done" is vacuously true of an empty set, and the
    // fixture above has deliberately created rows on both sides.
    const rows = await database.query<{ n: string }>(
      `select count(*)::text n from public.entities e
        where internal.kind_seeds_done(e.kind) and e.status_category is distinct from 'done'`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. internal.is_resolved — the category, and the one override
// ---------------------------------------------------------------------------

describe('152 — is_resolved answers with the category', () => {
  it('a non-task in the done category RESOLVES (owner decision #3)', async () => {
    const sessionId = await createEntity('work_session');
    expect(await isResolved(sessionId), 'a to_do session must not resolve').toBe(false);

    await moveTo(sessionId, await defaultState('done'));
    expect(await isResolved(sessionId)).toBe(true);
  });

  it('THE MIRROR IMAGE: a doc in to_do now BLOCKS, where existing used to unblock', async () => {
    // Before 152, `internal.is_resolved`'s `else` arm returned TRUE for a doc
    // unconditionally — "existing and not deleted IS resolved" (003:206). This
    // is the reversal, and it is the ruling read backwards rather than a
    // separate decision: "this task depends on that doc" means the doc has to
    // be finished, not filed.
    const docId = await createEntity('doc');
    expect(await isResolved(docId)).toBe(false);

    await moveTo(docId, await defaultState('done'));
    expect(await isResolved(docId)).toBe(true);
  });

  it('a cancelled entity does NOT resolve', async () => {
    const docId = await createEntity('doc');
    await moveTo(docId, await defaultState('cancelled'));
    expect(await isResolved(docId)).toBe(false);
  });

  it('a commit resolves out of the box — 003’s answer for facts, preserved', async () => {
    const commitId = await createEntity('commit');
    expect(await isResolved(commitId)).toBe(true);
  });

  it('pull_request keeps its KIND-BEHAVIOUR OVERRIDE in both directions', async () => {
    const prId = await createEntity('pull_request');
    await asOwner((q) =>
      q(
        `insert into public.pull_requests(entity_id,space_id,provider,repo,number,title,state,url)
         values($1,$2,'github','acme/tm8',1,'A PR','open','https://example.invalid/pr/1')`,
        [prId, fixture.spaceId],
      ),
    );

    // The category says done. The forge says open. The forge wins — the state
    // is synced by 103's observer with no transition, so the category would go
    // stale the moment a PR merged outside the product.
    await moveTo(prId, await defaultState('done'));
    expect((await statusOf(prId)).status_category).toBe('done');
    expect(await isResolved(prId), 'an unmerged PR must not resolve, whatever its category').toBe(false);

    // …and the other direction: merged resolves even sitting in to_do.
    await asOwner((q) => q(`update public.pull_requests set state = 'merged' where entity_id = $1`, [prId]));
    await moveTo(prId, await defaultState('to_do'));
    expect(await isResolved(prId), 'a merged PR resolves whatever its category').toBe(true);
  });

  it('a soft-deleted entity never resolves, done or not', async () => {
    const docId = await createEntity('doc');
    await moveTo(docId, await defaultState('done'));
    await asOwner((q) => q(`update public.entities set deleted_at = now() where id = $1`, [docId]));
    expect(await isResolved(docId)).toBe(false);
  });

  it('never returns NULL — every caller phrases the test as `not is_resolved`', async () => {
    // A NULL would not be FALSE, so a row with no category would silently STOP
    // blocking instead of blocking. Asked of a row forced into that state, which
    // the backfill has made unreachable through any door.
    const docId = await createEntity('doc');
    await asOwner((q) =>
      q(`update public.entities set status_id = null, status_category = null where id = $1`, [docId]),
    );
    expect(await isResolved(docId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. The unblock ripple, for a non-task
// ---------------------------------------------------------------------------

describe('152 — the depends_on ripple now runs for non-tasks', () => {
  it('a task blocked on a to_do doc is blocked; finishing the doc unblocks it', async () => {
    const taskId = await createEntity('task');
    const docId = await createEntity('doc');
    await dependsOn(taskId, docId);

    const blocked = async (): Promise<boolean> => {
      const rows = await database.query<{ blocked: boolean }>(
        `select exists(
           select 1 from public.edges dep
            where dep.src_id = $1 and dep.type = 'depends_on'
              and coalesce((dep.props ->> 'hard')::boolean, true)
              and not internal.is_resolved(dep.dst_id)) blocked`,
        [taskId],
      );
      return rows[0]!.blocked;
    };

    expect(await blocked(), 'a to_do doc must block its dependent').toBe(true);
    await moveTo(docId, await defaultState('done'));
    expect(await blocked(), 'a done doc must unblock its dependent').toBe(false);
  });

  it('announce_unblocked fires when a non-task resolves', async () => {
    const taskId = await createEntity('task');
    const sessionId = await createEntity('work_session');
    await dependsOn(taskId, sessionId);

    const announced = await asOwner((q) =>
      q(`select internal.announce_unblocked($1) n`, [sessionId]),
    );
    expect(Number(announced[0]!.n), 'a to_do session resolves nothing').toBe(0);

    await moveTo(sessionId, await defaultState('done'));
    const after = await asOwner((q) => q(`select internal.announce_unblocked($1) n`, [sessionId]));
    expect(Number(after[0]!.n), 'a done session unblocks its waiter').toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. ready_to_work
// ---------------------------------------------------------------------------

describe('152 — ready_to_work reads the category', () => {
  async function ready(): Promise<string[]> {
    const rows = await database.query<{ entity_id: string }>(
      `select entity_id from public.ready_to_work($1)`,
      [fixture.spaceId],
    );
    return rows.map((r) => r.entity_id);
  }

  async function createTaskRow(title: string): Promise<string> {
    const id = await createEntity('task');
    await asOwner((q) =>
      q(`insert into public.tasks(entity_id,title) values($1,$2)`, [id, title]),
    );
    return id;
  }

  it('a to_do task is ready; a done one is not', async () => {
    const taskId = await createTaskRow('Ready one');
    expect(await ready()).toContain(taskId);

    await moveTo(taskId, await defaultState('done'));
    expect(await ready()).not.toContain(taskId);
  });

  it('a task blocked on a to_do doc is NOT ready', async () => {
    const taskId = await createTaskRow('Blocked one');
    const docId = await createEntity('doc');
    await dependsOn(taskId, docId);
    expect(await ready()).not.toContain(taskId);

    await moveTo(docId, await defaultState('done'));
    expect(await ready()).toContain(taskId);
  });

  it('it stays TASK-SHAPED: a to_do doc is not "ready to work"', async () => {
    // The regression this guards: every kind now carries `to_do`, so re-keying
    // the predicate from `work_status in ('open','pulled')` to the category
    // WITHOUT saying "and it is a task" would have put every doc, channel and
    // project in the space into "what can I pull".
    const docId = await createEntity('doc');
    expect(await ready()).not.toContain(docId);
  });
});
