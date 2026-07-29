// =============================================================================
// command_ledger — clientMutationId idempotency (DEV-9 / AM-2 §3).
//
// The promise the facade makes to every client: retry a mutation with the same
// clientMutationId and you get the ORIGINAL result back, with nothing applied a
// second time. On the G1A loop this is load-bearing in one place in particular —
// a retried execution.spawn must not boot a second PTY.
//
// The protocol in 007 is: ledger_replay(cmid, op) at the TOP (a hit returns and
// nothing re-runs), ledger_record(cmid, op, result) just before returning.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_URL,
  buildWorld,
  cmid,
  denied,
  json,
  literal,
  ok,
  runAsync,
  scalar,
  uuid,
} from './helpers.mjs';

const w = buildWorld('ledger');

test('entities.create: a replayed cmid returns the original entity and creates nothing new', () => {
  const id = cmid('create-task');
  const first = json(
    `select public.create_task(${uuid(w.spaceA)}, 'idempotent task', null, '', '{}'::jsonb, null,
       null, 'medium', '[]'::jsonb, null, null, null, 'attached_to', ${literal(id)})`,
    { claims: w.claimsA },
  );
  const replay = json(
    `select public.create_task(${uuid(w.spaceA)}, 'idempotent task', null, '', '{}'::jsonb, null,
       null, 'medium', '[]'::jsonb, null, null, null, 'attached_to', ${literal(id)})`,
    { claims: w.claimsA },
  );

  assert.equal(replay.entity.id, first.entity.id, 'a replay must return the ORIGINAL entity id');
  assert.equal(
    scalar(`select count(*) from public.tasks where title = 'idempotent task'`, { claims: w.claimsA }),
    '1',
    'a replay must not create a second task',
  );
});

test('a replay does not re-run the body: no second activity row, no second event', () => {
  const id = cmid('no-side-effects');
  const created = json(
    `select public.create_task(${uuid(w.spaceA)}, 'once only', null, '', '{}'::jsonb, null,
       null, 'medium', '[]'::jsonb, null, null, null, 'attached_to', ${literal(id)})`,
    { claims: w.claimsA },
  ).entity.id;

  const activityBefore = scalar(
    `select count(*) from public.activity where entity_id = ${uuid(created)}`,
    { claims: w.claimsA },
  );
  const eventsBefore = scalar(
    `select count(*) from public.workspace_events
      where space_id = ${uuid(w.spaceA)} and client_mutation_id = ${literal(id)}`,
    { claims: w.claimsA },
  );
  assert.ok(Number(eventsBefore) > 0, 'control: the original mutation stamped its cmid onto its events');

  ok(
    `select public.create_task(${uuid(w.spaceA)}, 'once only', null, '', '{}'::jsonb, null,
       null, 'medium', '[]'::jsonb, null, null, null, 'attached_to', ${literal(id)})`,
    { claims: w.claimsA },
  );

  assert.equal(
    scalar(`select count(*) from public.activity where entity_id = ${uuid(created)}`, { claims: w.claimsA }),
    activityBefore,
    'a replay must not append another activity row',
  );
  assert.equal(
    scalar(
      `select count(*) from public.workspace_events
        where space_id = ${uuid(w.spaceA)} and client_mutation_id = ${literal(id)}`,
      { claims: w.claimsA },
    ),
    eventsBefore,
    'a replay must not emit more events',
  );
});

test('messages.post: replay returns the same message, and domain idempotency agrees', () => {
  const id = cmid('post');
  const first = json(
    `select public.post_message(${uuid(w.channelA)}, 'hello once', null, null,
       '[]'::jsonb, '[]'::jsonb, ${literal(id)})`,
    { claims: w.claimsA },
  );
  const replay = json(
    `select public.post_message(${uuid(w.channelA)}, 'hello once', null, null,
       '[]'::jsonb, '[]'::jsonb, ${literal(id)})`,
    { claims: w.claimsA },
  );
  assert.equal(replay.entity.id, first.entity.id);
  assert.equal(
    scalar(`select count(*) from public.messages where body = 'hello once'`, { claims: w.claimsA }),
    '1',
    'exactly one message may exist',
  );
  // post_message ALSO keeps its pre-ledger domain idempotency on
  // (author_id, client_msg_id) — belt and braces, and the unique index proves it.
  assert.equal(
    scalar(
      `select count(*) from public.messages where author_id = ${uuid(w.memberA)} and client_msg_id = ${literal(id)}`,
      { claims: w.claimsA },
    ),
    '1',
  );
});

test('one cmid belongs to one operation: reusing it for a different one is refused', () => {
  const id = cmid('cross-op');
  ok(
    `select public.create_task(${uuid(w.spaceA)}, 'owns the cmid', null, '', '{}'::jsonb, null,
       null, 'medium', '[]'::jsonb, null, null, null, 'attached_to', ${literal(id)})`,
    { claims: w.claimsA },
  );
  denied(
    'ledger_replay: a cmid already used for entities.create, reused for messages.post',
    `select public.post_message(${uuid(w.channelA)}, 'stealing a cmid', null, null,
       '[]'::jsonb, '[]'::jsonb, ${literal(id)})`,
    { claims: w.claimsA, expect: '23514' },
  );
  denied(
    'ledger_replay: the same cmid reused for entities.commands.work',
    `select public.set_work_state(${uuid(w.taskA)}, 'working', null, null, null, ${literal(id)})`,
    { claims: w.claimsA, expect: '23514' },
  );
});

test('execution.spawn: a retried spawn returns the original session, not a second one', () => {
  const id = cmid('spawn');
  const spawnSql = `select public.execution_spawn(${uuid(w.spaceA)}, ${uuid(w.personaA)},
      array[${uuid(w.taskA)}]::uuid[], ${uuid(w.projectId)}, 'project', null, null,
      'worker', 'claude-opus-5', 'claude', 'retry probe', 'node-1', true, 64,
      null, ${literal(id)})`;

  const first = json(spawnSql, { claims: w.claimsA });
  const replay = json(spawnSql, { claims: w.claimsA });

  assert.equal(first.__tm8_replayed, false, 'the fresh call must be distinguishable in-process');
  assert.equal(replay.__tm8_replayed, true, 'the retry must be marked so SpawnService never boots twice');
  const stored = json(
    `select result from public.command_ledger where client_mutation_id = ${literal(id)}`,
    { claims: w.claimsA },
  );
  assert.equal(
    Object.hasOwn(stored, '__tm8_replayed'),
    false,
    'the internal replay marker must not become part of the durable public CommandResult',
  );

  assert.equal(
    replay.entity.id,
    first.entity.id,
    'a retried spawn MUST return the original work_session — a second one would boot a second PTY',
  );
  assert.equal(
    scalar(`select count(*) from public.work_sessions where title = 'retry probe'`, { claims: w.claimsA }),
    '1',
    'exactly one work_session may exist for one spawn cmid',
  );
  assert.equal(first.entity.kind, 'work_session');
  assert.equal(JSON.parse(JSON.stringify(first.entity)).content.status, 'spawning');
});

test('entities.commands.complete: replay returns the original result and pays the award once', () => {
  // A task worth points, with its criteria already satisfied.
  const task = json(
    `select public.create_task(${uuid(w.spaceA)}, 'payable', null, '', '{}'::jsonb, null,
       null, 'medium', '[{"text":"done thing","done":true}]'::jsonb, 7)`,
    { claims: w.claimsA },
  ).entity;

  const id = cmid('complete');
  const completeSql = `select public.complete_task(${uuid(task.id)}, ${task.version},
      array[${uuid(w.memberA)}]::uuid[], null, ${literal(id)})`;
  const first = json(completeSql, { claims: w.claimsA });
  const replay = json(completeSql, { claims: w.claimsA });

  assert.equal(replay.entity.id, first.entity.id);
  assert.equal(
    scalar(
      `select count(*) from public.point_events
        where ref_id = ${uuid(task.id)} and entity_id = ${uuid(w.memberA)} and reason = 'award'`,
      { claims: w.claimsA },
    ),
    '1',
    'a replayed completion must not pay the award twice',
  );
  assert.equal(
    scalar(`select sum(amount) from public.point_events where ref_id = ${uuid(task.id)}`, {
      claims: w.claimsA,
    }),
    '7',
  );

  // And a SECOND completion with a fresh cmid is refused by the domain guard, not
  // by the ledger — completion is a one-way door.
  denied(
    'complete_task: a task that is already done, under a NEW cmid',
    `select public.complete_task(${uuid(task.id)}, ${task.version + 1},
       array[${uuid(w.memberA)}]::uuid[], null, ${literal(cmid('complete-again'))})`,
    { claims: w.claimsA, expect: '23514' },
  );
});

test('a mutation with NO cmid is not ledgered, and repeating it applies twice', () => {
  // The complement of the guarantee: idempotency is opt-in per mutation. If this
  // ever starts collapsing un-ledgered repeats, the ledger has grown an implicit
  // key and the contract has changed underneath the client.
  ok(`select public.create_task(${uuid(w.spaceA)}, 'unledgered')`, { claims: w.claimsA });
  ok(`select public.create_task(${uuid(w.spaceA)}, 'unledgered')`, { claims: w.claimsA });
  assert.equal(
    scalar(`select count(*) from public.tasks where title = 'unledgered'`, { claims: w.claimsA }),
    '2',
    'without a cmid there is nothing to deduplicate on',
  );
});

test('CONCURRENT double-submit of one cmid: both callers agree on one result', async () => {
  // The retry-storm case: a client (or a flaky network) fires the same mutation
  // twice at once, so both transactions pass ledger_replay before either has
  // recorded anything. ledger_record's ON CONFLICT is what has to settle it.
  const id = cmid('concurrent');
  const sql = `select public.create_task(${uuid(w.spaceA)}, 'concurrent submit', null, '', '{}'::jsonb,
      null, null, 'medium', '[]'::jsonb, null, null, null, 'attached_to', ${literal(id)})`;

  const [a, b] = await Promise.all([
    runAsync(sql, { claims: w.claimsA }),
    runAsync(sql, { claims: w.claimsA }),
  ]);
  assert.ok(a.ok, `first submit failed:\n${a.stderr}`);
  assert.ok(b.ok, `second submit failed:\n${b.stderr}`);

  const payloadOf = (res) => JSON.parse(res.stdout.split('\n').filter((l) => l.trim()).pop());
  const idA = payloadOf(a).entity.id;
  const idB = payloadOf(b).entity.id;

  assert.equal(
    idA,
    idB,
    'both concurrent callers must be told about the SAME entity — ledger_record hands the ' +
      'loser the winner\'s stored result',
  );

  const ledgered = Number(
    // command_ledger has no policy and no grant for tm8_app (by design), so this
    // one read goes through the owner connection.
    scalar(`select count(*) from public.command_ledger where client_mutation_id = ${literal(id)}`, {
      url: OWNER_URL,
    }),
  );
  assert.equal(ledgered, 1, 'exactly one ledger row per cmid');

  // The sharp question, asserted rather than assumed: did the LOSER's own inserts
  // commit anyway? If this is 2, the ledger reconciles the RESULT but not the
  // side effects, and a concurrent retry double-applies.
  const tasks = Number(
    scalar(`select count(*) from public.tasks where title = 'concurrent submit'`, { claims: w.claimsA }),
  );
  assert.equal(
    tasks,
    1,
    `a concurrent double-submit of one cmid created ${tasks} tasks. ledger_record returns the ` +
      `winner's result to the loser, but if the loser's own writes still commit then the ` +
      `mutation was APPLIED TWICE while both callers were told it happened once — the ledger ` +
      `hides the duplicate instead of preventing it. This is the retry-storm bug.`,
  );
});
