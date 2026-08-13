// =============================================================================
// 111 — a spawn on a task assigns that task.
//
// The regression these tests exist for was invisible for the usual reason: the
// spawn returned 201, the session ran, and `working_on` was there, so every
// assertion anyone had written passed. What was missing was the edge that
// OUTLIVES the session — five dispatcher-routed tasks in prod, five
// `working_on` edges, zero `assigned_to` edges — and nothing was looking at the
// task side of the graph at all.
//
// So these assert on the TASK, never on the session.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, cmid, expectFailure, json, literal, ok, rows, scalar, uuid } from './helpers.mjs';

const w = buildWorld('spawnassign');

const taskList = (ids) =>
  ids.length ? `array[${ids.map((id) => uuid(id)).join(',')}]::uuid[]` : `'{}'::uuid[]`;

function spawnSql(taskIds, title, tag) {
  return `select public.execution_spawn(${uuid(w.spaceA)}, ${uuid(w.personaA)},
     ${taskList(taskIds)}, ${uuid(w.projectId)}, 'project', null, null, 'worker',
     'claude-opus-5', 'claude', ${literal(title)}, 'node-1', true, 64, null,
     ${literal(cmid(tag))})`;
}

const spawnOn = (taskIds, title) =>
  json(spawnSql(taskIds, title, 'assign-spawn'), { claims: w.claimsA }).entity.id;

const newTask = (title) =>
  json(`select public.create_task(${uuid(w.spaceA)}, ${literal(title)})`, {
    claims: w.claimsA,
  }).entity.id;

/**
 * Seed an assignment the way a human's UI does — through `write_edge`.
 * `tm8_app` holds no INSERT on public.edges (018), and leaning on the schema
 * owner to plant the row would test a state the product cannot reach.
 */
const assignByHand = (taskId, assigneeId, props, tag) =>
  ok(
    `select public.write_edge(${uuid(taskId)}, ${uuid(assigneeId)}, 'assigned_to',
       ${literal(JSON.stringify(props))}::jsonb, ${uuid(w.memberA)}, ${literal(cmid(tag))})`,
    { claims: w.claimsA },
  );

const assignees = (taskId) =>
  rows(
    `select dst_id::text as assignee, props->>'via' as via from public.edges
      where src_id = ${uuid(taskId)} and type = 'assigned_to' order by dst_id`,
    { claims: w.claimsA },
  );

test('spawning a teammate on a task writes assigned_to, not only working_on', () => {
  const task = newTask('gets an assignee');
  const session = spawnOn([task], 'assigns');

  assert.deepEqual(
    assignees(task),
    [{ assignee: w.personaA, via: 'spawn' }],
    'the task must name the spawned teammate as its assignee',
  );
  assert.equal(
    scalar(
      `select count(*) from public.edges
        where src_id = ${uuid(session)} and dst_id = ${uuid(task)} and type = 'working_on'`,
      { claims: w.claimsA },
    ),
    '1',
    '048 working_on must survive 111 unchanged',
  );
});

test('every task in one spawn is assigned, not just the first', () => {
  const one = newTask('multi one');
  const two = newTask('multi two');
  spawnOn([one, two], 'assigns both');

  assert.deepEqual(assignees(one), [{ assignee: w.personaA, via: 'spawn' }]);
  assert.deepEqual(assignees(two), [{ assignee: w.personaA, via: 'spawn' }]);
});

test('a spawn with no task assigns nothing', () => {
  const before = scalar(`select count(*) from public.edges where type = 'assigned_to'`, {
    claims: w.claimsA,
  });
  spawnOn([], 'no anchor');
  assert.equal(
    scalar(`select count(*) from public.edges where type = 'assigned_to'`, { claims: w.claimsA }),
    before,
    'a taskless spawn has nobody to assign and must add no edge',
  );
});

/**
 * The `on conflict do nothing` clause, stated as a test because the failure it
 * prevents is silent: a re-spawn rewriting a human's deliberate assignment into
 * one tagged `via: spawn` would look identical in the UI and be wrong.
 */
test('a re-spawn on the same task does not rewrite an existing assignment', () => {
  const task = newTask('already assigned by a human');
  assignByHand(task, w.personaA, { note: 'drawn by hand' }, 'by-hand');

  spawnOn([task], 're-spawn');

  assert.deepEqual(
    rows(
      `select props->>'note' as note, props->>'via' as via from public.edges
        where src_id = ${uuid(task)} and dst_id = ${uuid(w.personaA)} and type = 'assigned_to'`,
      { claims: w.claimsA },
    ),
    [{ note: 'drawn by hand', via: null }],
    'the hand-drawn assignment must be left exactly as it was',
  );
});

/**
 * Assignment is additive because `assigned_to` admits several assignees. A task
 * a human put on a member, then launched a teammate for, is honestly on both.
 */
test('a spawn adds its teammate alongside an existing different assignee', () => {
  const task = newTask('two assignees');
  assignByHand(task, w.memberA, {}, 'member-assign');

  spawnOn([task], 'joins the member');

  assert.deepEqual(
    assignees(task).map((r) => r.assignee).sort(),
    [w.memberA, w.personaA].sort(),
    'both assignees must be present',
  );
});

/**
 * The whole reason this lives in the RPC and not in the spawn handler, where
 * `dispatched_by` lives.
 *
 * A spawn naming two tasks writes the first task's edges, then reaches the
 * second and finds it is not a live task in this space. `internal.live_entity`
 * raises, and the FIRST task's assignment must go with it — a task claiming an
 * assignee for a session that was never created is exactly the half-landed
 * state a best-effort write after the fact would leave behind.
 */
test('a spawn that fails partway assigns none of its tasks', () => {
  const good = newTask('first of a doomed pair');
  const foreign = json(`select public.create_task(${uuid(w.spaceB)}, 'Task in B')`, {
    claims: w.claimsB,
  }).entity.id;

  expectFailure(spawnSql([good, foreign], 'doomed', 'cross-space'), { claims: w.claimsA });

  assert.deepEqual(
    assignees(good),
    [],
    'the rolled-back spawn must have left no assignment on the task it did reach',
  );
  assert.equal(
    scalar(
      `select count(*) from public.edges where dst_id = ${uuid(good)} and type = 'working_on'`,
      { claims: w.claimsA },
    ),
    '0',
    'and no working_on either — the two edges roll back together',
  );
});
