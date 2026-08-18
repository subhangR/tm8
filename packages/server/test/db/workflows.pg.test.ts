/**
 * 148 against a real Postgres: the tables, the seeds, the copy out of
 * `task_workflows`, and — the part worth the most — the TRANSITION MATRIX of a
 * twelve-state workflow that has ZERO rows in `workflow_transitions`.
 *
 * ## Why the matrix is the interesting assertion
 *
 * The design's whole claim against Jira is that transition rules default at the
 * CATEGORY level, so a twelve-state workflow works with no configuration. That
 * claim is not checkable by reading `internal.category_transition_allowed` — it
 * is a claim about what the trigger does across every ORDERED PAIR of states,
 * and the two ways it can be false are both invisible in the function:
 *
 *   * a pair that should be allowed is refused (the twelve-state promise is a
 *     lie, and it fails on the first workflow anyone authors);
 *   * a category PAIR resolves differently depending on which named states are
 *     at its ends — which would mean something is branching on a status NAME,
 *     the one thing the design forbids.
 *
 * So `walks every ordered pair` builds the full 12x12 and asserts on the
 * category pair, and `never splits a verdict` asserts the second directly: no
 * category pair may appear as both ALLOW and REFUSE.
 *
 * ## Why this runs as the schema owner
 *
 * Same posture and same reason as `status-category.pg.test.ts`: these are
 * SCHEMA invariants — constraints, triggers, seeds — not RPC behaviour, so the
 * suite writes the tables directly rather than dragging in the identity
 * bootstrap the RPC doors require. The invariant must hold for a writer that
 * bypassed the catalog, which is exactly the writer phase 5's backfills will be.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * vitest's defaults are 5s per TEST and 10s per HOOK, and a generous third
 * argument on `beforeAll` covers NEITHER of the tests. The matrix below drives
 * 132 ordered pairs at two round trips each, and the override cases 11 apiece —
 * comfortably under 5s on an idle machine and NOT on CI's two-core box, where
 * the failure arrives as NAMED test failures that read exactly like real
 * regressions. Set at file top, per the in-tree precedent.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const MIGRATION = '148_workflows.sql';
const SPACE = '00000000-0000-4000-8000-000000000001';
const IDENTITY = '00000000-0000-4000-8000-00000000000f';
const ANCHOR = '00000000-0000-4000-8000-0000000000aa';
/** The built-in default workflow's fixed id, as seeded by 148. */
const BUILTIN = '00000000-0000-4000-8000-00000000f100';
/** The entity the transition matrix moves around. */
const SUBJECT = '00000000-0000-4000-8000-0000000000b1';

type Category = 'to_do' | 'in_progress' | 'done' | 'cancelled';

/**
 * A twelve-state workflow — three `to_do`, four `in_progress`, two `done`,
 * three `cancelled` — seeded with NO transition rows. Deliberately more than
 * one state per category everywhere, so that an implementation which happened
 * to work only for the four-state default fails here.
 */
const TWELVE: ReadonlyArray<readonly [string, Category]> = [
  ['Backlog', 'to_do'],
  ['Triaged', 'to_do'],
  ['Ready', 'to_do'],
  ['Building', 'in_progress'],
  ['In Review', 'in_progress'],
  ['Blocked', 'in_progress'],
  ['Staging', 'in_progress'],
  ['Shipped', 'done'],
  ['Verified', 'done'],
  ['Dropped', 'cancelled'],
  ['Duplicate', 'cancelled'],
  ['Wontfix', 'cancelled'],
];

/**
 * THE RULED SET, restated here as data rather than derived from the function
 * under test — a test that computes its expectation the same way the subject
 * does cannot fail. `true` where the ruled set (2026-08-18 addendum, sub-doc 1)
 * allows the category move with no configuration.
 *
 * The `same -> same` diagonal is the AXIOM argued in 148's header: a move that
 * does not change the category is invisible to everything that reads one.
 */
const RULED: Readonly<Record<string, boolean>> = {
  'to_do -> to_do': true,
  'to_do -> in_progress': true,
  'to_do -> done': true,
  'to_do -> cancelled': true,
  'in_progress -> to_do': false,
  'in_progress -> in_progress': true,
  'in_progress -> done': true,
  'in_progress -> cancelled': true,
  'done -> to_do': true,
  'done -> in_progress': false,
  'done -> done': true,
  'done -> cancelled': true,
  'cancelled -> to_do': true,
  'cancelled -> in_progress': false,
  'cancelled -> done': false,
  'cancelled -> cancelled': true,
};

/** The seven work statuses, in the product's own lifecycle order. */
const LIFECYCLE = ['open', 'pulled', 'working', 'in_review', 'blocked', 'done', 'cancelled'] as const;

interface StateRow {
  readonly id: string;
  readonly name: string;
  readonly category: Category;
  readonly position: number;
  readonly is_initial: boolean;
  readonly is_default: boolean;
}

let database: W1ScratchDatabase;
let twelveWorkflowId = '';
let twelveStates: StateRow[] = [];

function stateNamed(name: string): StateRow {
  const found = twelveStates.find((s) => s.name === name);
  if (!found) throw new Error(`no such state in the twelve-state workflow: ${name}`);
  return found;
}

/** Parks the subject on `from`, then attempts `to`. Reports what the trigger decided. */
async function attempt(from: string, to: string): Promise<'ALLOW' | 'REFUSE'> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    // Clearing first makes the park itself a from-NULL adoption, which the
    // trigger allows unconditionally — so the parking step can never be the
    // thing that refuses, and a REFUSE below is always about the move under test.
    await client.query(`update public.entities set status_id = null where id = $1`, [SUBJECT]);
    await client.query(`update public.entities set status_id = $2 where id = $1`, [SUBJECT, from]);
  });
  try {
    await database.query(`update public.entities set status_id = $2 where id = $1`, [SUBJECT, to]);
    return 'ALLOW';
  } catch {
    return 'REFUSE';
  }
}

async function statesOf(workflowId: string): Promise<StateRow[]> {
  return database.query<StateRow>(
    `select id, name, category, position, is_initial, is_default
       from public.workflow_states where workflow_id = $1 order by position`,
    [workflowId],
  );
}

describe.sequential('148 — workflows, states, transitions', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('workflows');
    const files = migrationFiles();
    const index = files.indexOf(MIGRATION);
    expect(index, `${MIGRATION} is not in the chain`).toBeGreaterThan(-1);

    // Everything BEFORE 148 — including 132, which is the table this migration
    // has to COPY. Seeding task_workflows here rather than afterwards is the
    // whole point: a rule that predates the workflow tables is the only thing
    // the copy can be tested against.
    database.apply(files.slice(0, index));

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.user_profiles(identity_id, display_name) values ($1, 'probe')`,
        [IDENTITY],
      );
      await client.query(
        `insert into public.spaces(id, name, created_by_identity) values ($1, 'probe', $2)`,
        [SPACE, IDENTITY],
      );
      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by)
         values ($1, $2, 'task', 0, $1)`,
        [ANCHOR, SPACE],
      );
      await client.query(`insert into public.tasks(entity_id, title) values ($1, 'anchor')`, [ANCHOR]);

      // Two pre-148 vocabularies. `bug` is NARROWED — it omits pulled, blocked
      // and cancelled — which is what proves the copy takes the row's own
      // statuses rather than the canonical seven. `feature` keeps all seven.
      // Both are passed in a DELIBERATELY SCRAMBLED order, because `statuses`
      // is a set the UI sent in form order and `position` must not inherit it.
      await client.query(
        `insert into public.task_workflows(space_id, type_value, statuses) values
           ($1, 'bug', $2), ($1, 'feature', $3)`,
        [
          SPACE,
          ['done', 'open', 'in_review', 'working'],
          ['cancelled', 'done', 'blocked', 'in_review', 'working', 'pulled', 'open'],
        ],
      );

      // The subject of the transition matrix. A `doc`, deliberately: 147's
      // `tasks_category` trigger has no opinion about it, so any category the
      // assertions see came from 148's own derivation and nothing else.
      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by)
         values ($1, $2, 'doc', 1, $3)`,
        [SUBJECT, SPACE, ANCHOR],
      );
    });

    database.apply([MIGRATION]);

    // The twelve-state workflow is authored AFTER 148, through the tables,
    // exactly as a space would author one — and with no transition rows at all.
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const created = await client.query<{ id: string }>(
        `insert into public.workflows(space_id, name, kind) values ($1, 'Epic flow', 'c:epic') returning id`,
        [SPACE],
      );
      twelveWorkflowId = created.rows[0]!.id;
      for (const [position, [name, category]] of TWELVE.entries()) {
        await client.query(
          `insert into public.workflow_states(workflow_id, name, category, position, is_initial)
           values ($1, $2, $3, $4, $5)`,
          [twelveWorkflowId, name, category, position + 1, position === 0],
        );
      }
    });
    twelveStates = await statesOf(twelveWorkflowId);
    expect(twelveStates).toHaveLength(12);
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  // ---------------------------------------------------------------------------
  // The built-in default
  // ---------------------------------------------------------------------------
  describe('the built-in default workflow', () => {
    it('is ONE global row — no space, no kind', async () => {
      const rows = await database.query<{ id: string; name: string; kind: string | null }>(
        `select id, name, kind from public.workflows where space_id is null`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(BUILTIN);
      expect(rows[0]!.kind).toBeNull();
    });

    it('has exactly four states, one per category, To Do initial', async () => {
      const states = await statesOf(BUILTIN);
      expect(states.map((s) => [s.name, s.category, s.position])).toEqual([
        ['To Do', 'to_do', 1],
        ['In Progress', 'in_progress', 2],
        ['Done', 'done', 3],
        ['Cancelled', 'cancelled', 4],
      ]);
      expect(states.filter((s) => s.is_initial).map((s) => s.name)).toEqual(['To Do']);
    });

    it('refuses a SECOND spaceless workflow — "the default" is not a thing that can drift', async () => {
      await expect(
        database.query(`insert into public.workflows(space_id, name, kind) values (null, 'Other', null)`),
      ).rejects.toThrow();
    });

    it('refuses a spaceless workflow that names a kind', async () => {
      // workflows_builtin_is_kindless. Distinct from the singleton index above:
      // this one would still be refused if the singleton were dropped.
      const rows = await database.query<{ n: string }>(
        `select count(*) n from pg_constraint
          where conrelid = 'public.workflows'::regclass and conname = 'workflows_builtin_is_kindless'`,
      );
      expect(Number(rows[0]!.n)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // The copy out of task_workflows
  // ---------------------------------------------------------------------------
  describe('the task_workflows copy', () => {
    it('leaves task_workflows completely alone — it is COPIED, not moved', async () => {
      const rows = await database.query<{ type_value: string; statuses: string[] }>(
        `select type_value, statuses from public.task_workflows order by type_value`,
      );
      expect(rows.map((r) => r.type_value)).toEqual(['bug', 'feature']);
      // Including the original scrambled order: nothing rewrote the source.
      expect(rows[0]!.statuses).toEqual(['done', 'open', 'in_review', 'working']);
    });

    it('names each workflow EXACTLY the type_value — phase 6 joins on this', async () => {
      const rows = await database.query<{ name: string; kind: string }>(
        `select name, kind from public.workflows
          where space_id = $1 and kind = 'task' order by name`,
        [SPACE],
      );
      expect(rows.map((r) => r.name)).toEqual(['bug', 'feature']);
      expect(rows.every((r) => r.kind === 'task')).toBe(true);
    });

    it('copies the NARROWED vocabulary, not the canonical seven', async () => {
      const rows = await database.query<StateRow>(
        `select s.name, s.category, s.position, s.is_initial from public.workflow_states s
           join public.workflows w on w.id = s.workflow_id
          where w.space_id = $1 and w.name = 'bug' order by s.position`,
        [SPACE],
      );
      // Four in, four out — and in LIFECYCLE order, not the scrambled order the
      // row was written in. `position` decides which state phase 3's resolver
      // picks for a category, so inheriting form order would make "the default
      // in_progress state" depend on the order of checkboxes in a form.
      expect(rows.map((r) => r.name)).toEqual(['open', 'working', 'in_review', 'done']);
      expect(rows.map((r) => r.position)).toEqual([1, 3, 4, 6]);
    });

    it('carries 147’s RULED categories onto the copied states', async () => {
      const rows = await database.query<{ name: string; category: string }>(
        `select s.name, s.category from public.workflow_states s
           join public.workflows w on w.id = s.workflow_id
          where w.space_id = $1 and w.name = 'feature' order by s.position`,
        [SPACE],
      );
      expect(rows.map((r) => [r.name, r.category])).toEqual([
        ['open', 'to_do'],
        ['pulled', 'to_do'],
        ['working', 'in_progress'],
        ['in_review', 'in_progress'],
        ['blocked', 'in_progress'],
        ['done', 'done'],
        ['cancelled', 'cancelled'],
      ]);
      expect(rows.map((r) => r.name)).toEqual([...LIFECYCLE]);
    });

    it('makes `open` the initial state of every copied workflow', async () => {
      const rows = await database.query<{ name: string; state: string }>(
        `select w.name, s.name state from public.workflows w
           join public.workflow_states s on s.workflow_id = w.id and s.is_initial
          where w.space_id = $1 and w.kind = 'task' order by w.name`,
        [SPACE],
      );
      expect(rows.map((r) => [r.name, r.state])).toEqual([
        ['bug', 'open'],
        ['feature', 'open'],
      ]);
    });

    it('flags no is_default — lowest position is already the right answer', async () => {
      const rows = await database.query<{ n: string }>(
        `select count(*) n from public.workflow_states s
           join public.workflows w on w.id = s.workflow_id
          where w.space_id is not null and s.is_default`,
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // THE MATRIX — the twelve-state, zero-configuration promise
  // ---------------------------------------------------------------------------
  describe('a twelve-state workflow with ZERO transition rows', () => {
    const verdicts: Array<{ from: StateRow; to: StateRow; verdict: 'ALLOW' | 'REFUSE' }> = [];

    beforeAll(async () => {
      const rows = await database.query<{ n: string }>(
        `select count(*) n from public.workflow_transitions where workflow_id = $1`,
        [twelveWorkflowId],
      );
      // The control. Every assertion below is meaningless if a row snuck in.
      expect(Number(rows[0]!.n)).toBe(0);

      for (const from of twelveStates) {
        for (const to of twelveStates) {
          if (from.id === to.id) continue;
          verdicts.push({ from, to, verdict: await attempt(from.id, to.id) });
        }
      }
    }, 180_000);

    it('walks every ordered pair — 12 states is 132 of them', () => {
      expect(verdicts).toHaveLength(132);
    });

    it('answers every pair by its CATEGORIES, exactly as ruled', () => {
      const wrong = verdicts.filter(({ from, to, verdict }) => {
        const expected = RULED[`${from.category} -> ${to.category}`];
        return (verdict === 'ALLOW') !== expected;
      });
      expect(
        wrong.map((w) => `${w.from.name}(${w.from.category}) -> ${w.to.name}(${w.to.category}) = ${w.verdict}`),
      ).toEqual([]);
    });

    it('never SPLITS a verdict for one category pair — nothing branches on a name', () => {
      // The sharper half of the assertion above. If any implementation ever
      // consulted a state NAME, a category pair would come back ALLOW at one
      // pair of endpoints and REFUSE at another, and this is the only test that
      // would say so.
      const byPair = new Map<string, Set<string>>();
      for (const { from, to, verdict } of verdicts) {
        const key = `${from.category} -> ${to.category}`;
        byPair.set(key, (byPair.get(key) ?? new Set()).add(verdict));
      }
      const split = [...byPair.entries()].filter(([, v]) => v.size > 1).map(([k]) => k);
      expect(split).toEqual([]);
      expect(byPair.size).toBe(16);
    });

    it('allows every move WITHIN a category — the axiom the ruled list omits', () => {
      const sameCategory = verdicts.filter(({ from, to }) => from.category === to.category);
      // 3+4+2+3 states => 6+12+2+6 ordered pairs.
      expect(sameCategory).toHaveLength(26);
      expect(sameCategory.every((v) => v.verdict === 'ALLOW')).toBe(true);
    });

    it('allows every move into cancelled, from anywhere', () => {
      const toCancelled = verdicts.filter(({ to }) => to.category === 'cancelled');
      expect(toCancelled.length).toBeGreaterThan(0);
      expect(toCancelled.every((v) => v.verdict === 'ALLOW')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Overrides
  // ---------------------------------------------------------------------------
  describe('a workflow_transitions row overrides the defaults PER TARGET STATE', () => {
    beforeAll(async () => {
      // The design doc's own example: "Blocked may only be entered from In
      // Review". ONE row.
      await database.query(
        `insert into public.workflow_transitions(workflow_id, from_state_id, to_state_id)
         values ($1, $2, $3)`,
        [twelveWorkflowId, stateNamed('In Review').id, stateNamed('Blocked').id],
      );
    });

    it('lets ONLY the named source enter the overridden state', async () => {
      const blocked = stateNamed('Blocked');
      const results: Array<[string, string]> = [];
      for (const from of twelveStates) {
        if (from.id === blocked.id) continue;
        results.push([from.name, await attempt(from.id, blocked.id)]);
      }
      expect(results.filter(([, v]) => v === 'ALLOW').map(([n]) => n)).toEqual(['In Review']);
    });

    it('leaves every OTHER state on the defaults — including its category twin', async () => {
      // Staging is `in_progress`, exactly like Blocked. If overriding one state
      // put the whole workflow into whitelist mode — the reading this design
      // rejects — Staging would now be unreachable, and the eleven states
      // nobody configured would have been silently un-configured.
      const staging = stateNamed('Staging');
      const results: Array<[string, string]> = [];
      for (const from of twelveStates) {
        if (from.id === staging.id) continue;
        results.push([from.category, await attempt(from.id, staging.id)]);
      }
      const wrong = results.filter(([category, verdict]) => {
        return (verdict === 'ALLOW') !== RULED[`${category} -> in_progress`];
      });
      expect(wrong).toEqual([]);
    });

    it('widens as easily as it narrows — a NULL from_state means ANY', async () => {
      const verified = stateNamed('Verified');
      // Default: cancelled -> done is REFUSED.
      expect(await attempt(stateNamed('Dropped').id, verified.id)).toBe('REFUSE');
      await database.query(
        `insert into public.workflow_transitions(workflow_id, from_state_id, to_state_id)
         values ($1, null, $2)`,
        [twelveWorkflowId, verified.id],
      );
      expect(await attempt(stateNamed('Dropped').id, verified.id)).toBe('ALLOW');
      // And it is scoped: Shipped, the other `done` state, is untouched.
      expect(await attempt(stateNamed('Dropped').id, stateNamed('Shipped').id)).toBe('REFUSE');
      await database.query(
        `delete from public.workflow_transitions where workflow_id = $1 and from_state_id is null`,
        [twelveWorkflowId],
      );
    });

    it('refuses a duplicate ANY row — the same rule twice is not two rules', async () => {
      const verified = stateNamed('Verified');
      await database.query(
        `insert into public.workflow_transitions(workflow_id, from_state_id, to_state_id) values ($1, null, $2)`,
        [twelveWorkflowId, verified.id],
      );
      await expect(
        database.query(
          `insert into public.workflow_transitions(workflow_id, from_state_id, to_state_id) values ($1, null, $2)`,
          [twelveWorkflowId, verified.id],
        ),
      ).rejects.toThrow();
      await database.query(
        `delete from public.workflow_transitions where workflow_id = $1 and from_state_id is null`,
        [twelveWorkflowId],
      );
    });

    it('cannot reference a state from another workflow — unrepresentable, not merely refused', async () => {
      await expect(
        database.query(
          `insert into public.workflow_transitions(workflow_id, from_state_id, to_state_id) values ($1, null, $2)`,
          [twelveWorkflowId, (await statesOf(BUILTIN))[0]!.id],
        ),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // The invariants
  // ---------------------------------------------------------------------------
  describe('invariants', () => {
    it('refuses a workflow with NO initial state, at COMMIT', async () => {
      await expect(
        database.transaction(async (client) => {
          await client.query('set local role tm8_graph_owner');
          const created = await client.query<{ id: string }>(
            `insert into public.workflows(space_id, name, kind) values ($1, 'headless', 'task') returning id`,
            [SPACE],
          );
          await client.query(
            `insert into public.workflow_states(workflow_id, name, category, position)
             values ($1, 'Only', 'to_do', 1)`,
            [created.rows[0]!.id],
          );
        }),
      ).rejects.toThrow(/exactly one initial state/);
    });

    it('refuses TWO initial states', async () => {
      await expect(
        database.query(
          `insert into public.workflow_states(workflow_id, name, category, position, is_initial)
           values ($1, 'Second Start', 'to_do', 99, true)`,
          [twelveWorkflowId],
        ),
      ).rejects.toThrow();
    });

    it('refuses an initial state that is not to_do', async () => {
      await expect(
        database.transaction(async (client) => {
          await client.query('set local role tm8_graph_owner');
          const created = await client.query<{ id: string }>(
            `insert into public.workflows(space_id, name, kind) values ($1, 'wrongstart', 'task') returning id`,
            [SPACE],
          );
          await client.query(
            `insert into public.workflow_states(workflow_id, name, category, position, is_initial)
             values ($1, 'Doing', 'in_progress', 1, true)`,
            [created.rows[0]!.id],
          );
        }),
      ).rejects.toThrow();
    });

    it('refuses a fifth category', async () => {
      await expect(
        database.query(
          `insert into public.workflow_states(workflow_id, name, category, position)
           values ($1, 'Triaging', 'triaging', 98)`,
          [twelveWorkflowId],
        ),
      ).rejects.toThrow();
    });

    it('refuses at most one is_default per (workflow, category)', async () => {
      await database.query(`update public.workflow_states set is_default = true where id = $1`, [
        stateNamed('Building').id,
      ]);
      await expect(
        database.query(`update public.workflow_states set is_default = true where id = $1`, [
          stateNamed('Staging').id,
        ]),
      ).rejects.toThrow();
      await database.query(`update public.workflow_states set is_default = false where id = $1`, [
        stateNamed('Building').id,
      ]);
    });

    it('refuses a move between two DIFFERENT workflows', async () => {
      const builtin = await statesOf(BUILTIN);
      await attempt(stateNamed('Backlog').id, stateNamed('Triaged').id);
      await expect(
        database.query(`update public.entities set status_id = $2 where id = $1`, [
          SUBJECT,
          builtin.find((s) => s.category === 'in_progress')!.id,
        ]),
      ).rejects.toThrow(/between workflows/);
    });
  });

  // ---------------------------------------------------------------------------
  // The envelope
  // ---------------------------------------------------------------------------
  describe('entities.status_id', () => {
    it('now HAS the foreign key 147 could not add', async () => {
      const rows = await database.query<{ conname: string; confdeltype: string }>(
        `select conname, confdeltype from pg_constraint
          where conrelid = 'public.entities'::regclass and contype = 'f'
            and conkey = array[(select attnum from pg_attribute
                                 where attrelid = 'public.entities'::regclass and attname = 'status_id')]`,
      );
      expect(rows).toHaveLength(1);
      // 'r' = RESTRICT. Not 'n' (set null): stripping the status off live work
      // to let an admin tidy a list is not a thing this schema does quietly.
      expect(rows[0]!.confdeltype).toBe('r');
    });

    it('refuses to delete a state that entities are sitting in', async () => {
      await attempt(stateNamed('Backlog').id, stateNamed('Triaged').id);
      await expect(
        database.query(`delete from public.workflow_states where id = $1`, [stateNamed('Triaged').id]),
      ).rejects.toThrow();
    });

    it('DERIVES status_category from the state — the column cannot go stale', async () => {
      for (const name of ['Backlog', 'Building', 'Shipped', 'Dropped']) {
        const state = stateNamed(name);
        await attempt(stateNamed('Backlog').id, state.id);
        const rows = await database.query<{ status_category: string }>(
          `select status_category from public.entities where id = $1`,
          [SUBJECT],
        );
        expect([name, rows[0]!.status_category]).toEqual([name, state.category]);
      }
    });

    it('leaves every PRODUCTION row untouched — nothing in phase 2 writes a status', async () => {
      // The claim 148's header makes, checked rather than asserted: the
      // validator is live and unexercised. Only this suite's own subject has a
      // status_id, and 147's task rows still get their category from 147's
      // trigger.
      const rows = await database.query<{ id: string }>(
        `select id from public.entities where status_id is not null and id <> $1`,
        [SUBJECT],
      );
      expect(rows.map((r) => r.id)).toEqual([]);
    });
  });
});
