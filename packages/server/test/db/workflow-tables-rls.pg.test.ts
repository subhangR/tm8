/**
 * 365 against a real Postgres: the four workflow tables are fenced by RLS.
 *
 * Before 365 they were granted to tm8_app with no RLS, so any caller read every
 * space's workflows. The first test pins that leak on the pre-365 schema, so a
 * green run here proves 365 is what closed it rather than some earlier grant.
 * The rest run as tm8_app with claims bound, the way the server reads.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const MIGRATION = '365_workflow_tables_rls.sql';
/** The built-in default workflow's fixed id, as seeded by 149. */
const BUILTIN = '00000000-0000-4000-8000-00000000f100';

const A = 'wf-rls-a';
const B = 'wf-rls-b';
const BOTH = 'wf-rls-both';
const STRANGER = 'wf-rls-stranger';
const spaceA = randomUUID();
const spaceB = randomUUID();
const workflowA = randomUUID();
const workflowB = randomUUID();

const TABLES = ['workflows', 'workflow_states', 'workflow_transitions', 'task_workflows'] as const;

describe.sequential('workflow tables row-level security (Postgres)', () => {
  let db: W1ScratchDatabase;

  const as = <T>(identity: string | null, sql: string, pin = '') =>
    db.transaction(async (q) => {
      await q.query('set local role tm8_app');
      await q.query(`select set_config('tm8.identity_id', $1, true), set_config('tm8.auth_kind', 'browser', true),
        set_config('tm8.session_space_id', $2, true)`, [identity ?? '', pin]);
      return (await q.query(sql)).rows as T[];
    });

  /** Which workflows each table exposes to the caller, keyed by table. */
  const visible = async (identity: string | null, pin = '') => {
    const ids = async (sql: string) =>
      (await as<{ id: string }>(identity, sql, pin)).map((r) => r.id).sort();
    return {
      workflows: await ids('select id from public.workflows'),
      workflow_states: await ids('select distinct workflow_id id from public.workflow_states'),
      workflow_transitions: await ids('select distinct workflow_id id from public.workflow_transitions'),
      task_workflows: await ids('select space_id id from public.task_workflows'),
    };
  };

  const seedWorkflow = async (workflow: string, space: string, kind: string) => {
    await db.transaction(async (q) => {
      await q.query('set local role tm8_graph_owner');
      await q.query('insert into public.workflows(id, space_id, name, kind) values ($1, $2, $3, $3)', [workflow, space, kind]);
      const states = await q.query<{ id: string }>(`insert into public.workflow_states(workflow_id, name, category, position, is_initial)
        values ($1, 'Open', 'to_do', 0, true), ($1, 'Doing', 'in_progress', 1, false),
               ($1, 'Shipped', 'done', 2, false), ($1, 'Dropped', 'cancelled', 3, false)
        returning id`, [workflow]);
      await q.query('insert into public.workflow_transitions(workflow_id, from_state_id, to_state_id) values ($1, $2, $3)',
        [workflow, states.rows[0]!.id, states.rows[2]!.id]);
      await q.query(`insert into public.task_workflows(space_id, type_value, statuses)
        values ($1, $2, array['open','working','done'])`, [space, kind]);
    });
  };

  beforeAll(async () => {
    db = await createW1ScratchDatabase('workflow_rls');
    const files = migrationFiles();
    db.apply(files.slice(0, files.indexOf(MIGRATION)));
    await db.transaction(async (q) => {
      await q.query('set local role tm8_graph_owner');
      await q.query(`insert into public.user_profiles(identity_id, display_name)
        values ($1, 'A'), ($2, 'B'), ($3, 'Both'), ($4, 'Stranger')`, [A, B, BOTH, STRANGER]);
      await q.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Space A', $3), ($2, 'Space B', $4)`,
        [spaceA, spaceB, A, B]);
      const memberships: Array<[string, string, string]> = [[A, spaceA, 'A'], [B, spaceB, 'B'], [BOTH, spaceA, 'Both'], [BOTH, spaceB, 'Both']];
      for (const [identity, space, name] of memberships) {
        const member = randomUUID();
        await q.query("insert into public.entities(id, space_id, kind, created_by) values ($1, $2, 'member', $1)", [member, space]);
        await q.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
          values ($1, $2, $3, 'owner', $4)`, [member, space, identity, name]);
      }
    });
    await seedWorkflow(workflowA, spaceA, 'c:bug');
    await seedWorkflow(workflowB, spaceB, 'c:incident');
  }, 180_000);
  afterAll(async () => { await db?.destroy(); }, 30_000);

  it('leaks every space\'s workflows to any tm8_app caller before 365', async () => {
    const seen = await visible(STRANGER);
    expect(seen.workflows).toEqual([BUILTIN, workflowA, workflowB].sort());
    expect(seen.task_workflows).toEqual([spaceA, spaceB].sort());
    db.apply([MIGRATION]);
  });

  it('enables RLS with a select policy on all four tables', async () => {
    const rows = await db.query<{ relname: string; rls: boolean; policies: number }>(`
      select c.relname, c.relrowsecurity rls,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) policies
        from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relname = any($1)
       order by c.relname`, [TABLES]);
    expect(rows).toEqual([...TABLES].sort().map((relname) => ({ relname, rls: true, policies: 1 })));
  });

  it('shows a member their own space plus the built-in default, never another space', async () => {
    expect(await visible(A)).toEqual({
      workflows: [BUILTIN, workflowA].sort(),
      workflow_states: [BUILTIN, workflowA].sort(),
      workflow_transitions: [workflowA],
      task_workflows: [spaceA],
    });
    expect(await visible(B)).toEqual({
      workflows: [BUILTIN, workflowB].sort(),
      workflow_states: [BUILTIN, workflowB].sort(),
      workflow_transitions: [workflowB],
      task_workflows: [spaceB],
    });
  });

  it('honours the session space pin for a member of both spaces', async () => {
    expect((await visible(BOTH)).workflows).toEqual([BUILTIN, workflowA, workflowB].sort());
    expect(await visible(BOTH, spaceA)).toEqual({
      workflows: [BUILTIN, workflowA].sort(),
      workflow_states: [BUILTIN, workflowA].sort(),
      workflow_transitions: [workflowA],
      task_workflows: [spaceA],
    });
  });

  it('gives a stranger only the built-in default, and an unbound claim nothing', async () => {
    expect(await visible(STRANGER)).toEqual({
      workflows: [BUILTIN],
      workflow_states: [BUILTIN],
      workflow_transitions: [],
      task_workflows: [],
    });
    expect(await visible(null)).toEqual({ workflows: [], workflow_states: [], workflow_transitions: [], task_workflows: [] });
  });
});
