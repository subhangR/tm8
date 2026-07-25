// =============================================================================
// Triggers — the invariants that hold no matter which path writes.
//
// Most of these are unreachable from tm8_app (it has no INSERT/UPDATE/DELETE on
// anything), so they are exercised through the OWNER connection. That is the point
// of a trigger rather than an RPC guard: it holds even for a writer that bypassed
// the catalog, which is exactly what a future migration or a maintenance script is.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_URL,
  buildWorld,
  claimsFor,
  cmid,
  denied,
  json,
  literal,
  ok,
  rows,
  runRaw,
  scalar,
  uuid,
} from './helpers.mjs';

const w = buildWorld('trig');
const owner = { url: OWNER_URL };

// -----------------------------------------------------------------------------
// Identity
// -----------------------------------------------------------------------------
test('accounts.identity_id is immutable (R6): rewriting it would re-attribute history', () => {
  const account = scalar(`select id from public.accounts where identity_id = ${literal(w.identityA)}`, owner);
  denied(
    'accounts_identity_immutable: update accounts set identity_id',
    `update public.accounts set identity_id = 'identity-stolen' where id = ${literal(account)}::uuid`,
    { ...owner, expect: '23514' },
  );
  // A no-op assignment of the SAME value must not trip the guard — the trigger
  // compares values, not the presence of the column in the SET list.
  ok(
    `update public.accounts set identity_id = ${literal(w.identityA)} where id = ${literal(account)}::uuid`,
    owner,
  );
  assert.equal(
    scalar(`select count(*) from public.accounts where identity_id = 'identity-stolen'`, owner),
    '0',
  );
});

test('there is exactly ONE owner account per node (T-L7), enforced by index not convention', () => {
  denied(
    'accounts_single_owner_idx: a direct insert of a second is_owner account',
    `insert into public.accounts(identity_id, username, is_owner)
       values ('identity-second-owner', 'secondowner', true)`,
    { ...owner, expect: '23505' },
  );
});

test('a team_member persona cannot be owned by a member of another space', () => {
  // can_act_as is founded on persona ownership, so a cross-space owner would be a
  // privilege escalation dressed as a data-entry mistake.
  denied(
    'validate_team_member_owner: persona in space A owned by member B (space B)',
    `update public.team_members set owner_member_id = ${uuid(w.memberB)}
      where entity_id = ${uuid(w.personaA)}`,
    { ...owner, expect: '23514' },
  );
});

// -----------------------------------------------------------------------------
// Envelope
// -----------------------------------------------------------------------------
test('a detail row may only decorate an envelope of its own kind', () => {
  const doc = json(`select public.create_document(${uuid(w.spaceA)}, 'a doc')`, {
    claims: w.claimsA,
  }).entity.id;
  denied(
    'validate_detail_envelope(task): a tasks row hung off a doc envelope',
    `insert into public.tasks(entity_id, title) values (${uuid(doc)}, 'wrong kind')`,
    { ...owner, expect: '23514' },
  );
  denied(
    'validate_detail_envelope(channel): a channels row whose space_id disagrees with its envelope',
    `insert into public.entities(id, space_id, kind, created_by)
       values ('019f0000-0000-7000-8000-00000000c001', ${uuid(w.spaceA)}, 'channel', ${uuid(w.memberA)});
     insert into public.channels(entity_id, space_id, name)
       values ('019f0000-0000-7000-8000-00000000c001', ${uuid(w.spaceB)}, 'mismatched')`,
    { ...owner, expect: '23514', singleTransaction: true },
  );
});

test('an entity kind must be registered', () => {
  denied(
    'validate_entity_kind: an entity of an unregistered kind',
    `insert into public.entities(space_id, kind, created_by)
       values (${uuid(w.spaceA)}, 'unicorn', ${uuid(w.memberA)})`,
    { ...owner, expect: '23514' },
  );
  denied(
    'validate_entity_kind: a c:* kind not registered in THIS space',
    `insert into public.entities(space_id, kind, created_by)
       values (${uuid(w.spaceA)}, 'c:not_registered', ${uuid(w.memberA)})`,
    { ...owner, expect: '23514' },
  );
});

test('the hierarchy is homogeneous and acyclic', () => {
  const parent = json(`select public.create_task(${uuid(w.spaceA)}, 'parent task')`, {
    claims: w.claimsA,
  }).entity.id;
  const child = json(
    `select public.create_task(${uuid(w.spaceA)}, 'child task', null, '', '{}'::jsonb, ${uuid(parent)})`,
    { claims: w.claimsA },
  ).entity.id;
  assert.equal(
    scalar(`select parent_id from public.entities where id = ${uuid(child)}`, { claims: w.claimsA }),
    parent,
    'control: the child should be parented',
  );

  denied(
    'validate_entity_parent: an entity as its own parent',
    `update public.entities set parent_id = ${uuid(parent)} where id = ${uuid(parent)}`,
    { ...owner, expect: '23514' },
  );
  denied(
    'validate_entity_parent: a CYCLE (parent reparented under its own child)',
    `update public.entities set parent_id = ${uuid(child)} where id = ${uuid(parent)}`,
    { ...owner, expect: '23514' },
  );
  denied(
    'validate_entity_parent: a parent of a DIFFERENT kind',
    `update public.entities set parent_id = ${uuid(w.channelA)} where id = ${uuid(child)}`,
    { ...owner, expect: '23514' },
  );
  const taskInB = json(`select public.create_task(${uuid(w.spaceB)}, 'task in B')`, {
    claims: w.claimsB,
  }).entity.id;
  denied(
    'validate_entity_parent: a parent in a DIFFERENT space',
    `update public.entities set parent_id = ${uuid(taskInB)} where id = ${uuid(child)}`,
    { ...owner, expect: '23514' },
  );
});

test('every entity gets its counter row from exactly one place', () => {
  const task = json(`select public.create_task(${uuid(w.spaceA)}, 'counted')`, { claims: w.claimsA })
    .entity.id;
  assert.equal(
    scalar(`select count(*) from public.entity_counters where entity_id = ${uuid(task)}`, {
      claims: w.claimsA,
    }),
    '1',
    'the entities_ensure_counter trigger must have created it',
  );
});

test('a NULL position appends after the last sibling; an explicit 0 is honoured', () => {
  const first = json(`select public.create_task(${uuid(w.spaceA)}, 'pos first')`, { claims: w.claimsA })
    .entity;
  const second = json(`select public.create_task(${uuid(w.spaceA)}, 'pos second')`, { claims: w.claimsA })
    .entity;
  assert.ok(
    Number(second.position) > Number(first.position),
    `append semantics: ${second.position} should be after ${first.position}`,
  );
  const zeroed = json(
    `select public.create_task(${uuid(w.spaceA)}, 'pos zero', null, '', '{}'::jsonb, null, 0)`,
    { claims: w.claimsA },
  ).entity;
  assert.equal(Number(zeroed.position), 0, 'an explicit 0 must not be treated as "unset"');
});

// -----------------------------------------------------------------------------
// Versioning
// -----------------------------------------------------------------------------
test('a content change bumps version, and the debounce window folds a same-actor edit', () => {
  const snapshots = (id) =>
    rows(
      `select version, snapshot -> 'content' ->> 'title' as title, changed_by
         from public.entity_versions where entity_id = ${uuid(id)} order by version`,
      { claims: w.claimsA },
    );

  const created = json(
    `select public.create_task(${uuid(w.spaceA)}, 'v1 title', null, 'v1 body')`,
    { claims: w.claimsA },
  ).entity;
  assert.equal(created.version, 1);
  assert.deepEqual(
    snapshots(created.id).map((v) => [Number(v.version), v.title]),
    [[1, 'v1 title']],
    'record_initial_version must lay down version 1 (an INSERT does not fire the snapshot trigger)',
  );

  // Same actor, inside the 5-minute debounce window (D6): version advances on the
  // envelope so optimistic concurrency stays honest, but the snapshot is folded in
  // place rather than appended.
  ok(`select public.update_task_content(${uuid(created.id)}, 1, null, 'v2 title')`, {
    claims: w.claimsA,
  });
  const after = json(`select internal.command_entity(${uuid(created.id)})`, owner);
  assert.equal(after.version, 2, 'the snapshot trigger must advance version');
  assert.equal(after.content.title, 'v2 title');
  assert.deepEqual(
    snapshots(created.id).map((v) => [Number(v.version), v.title]),
    [[2, 'v2 title']],
    'a debounced edit must UPDATE the open snapshot in place, not append a second one',
  );

  // A DIFFERENT actor is never debounced: attribution boundaries end the window.
  ok(
    `select public.update_task_content(${uuid(created.id)}, 2, ${uuid(w.personaA)}, 'v3 by persona')`,
    { claims: w.claimsA },
  );
  const history = snapshots(created.id);
  assert.deepEqual(
    history.map((v) => [Number(v.version), v.title]),
    [
      [2, 'v2 title'],
      [3, 'v3 by persona'],
    ],
    'an edit by another actor must APPEND, so the previous author\'s state survives',
  );
  assert.equal(history[0].changed_by, w.memberA);
  assert.equal(history[1].changed_by, w.personaA, 'the new snapshot is attributed to the persona');
});

test('optimistic concurrency: a stale expectedVersion is a 40001 carrying the current one', () => {
  const created = json(`select public.create_task(${uuid(w.spaceA)}, 'occ')`, { claims: w.claimsA })
    .entity;
  const res = denied(
    'assert_version: update_task_content with a stale expected version',
    `select public.update_task_content(${uuid(created.id)}, 99, null, 'nope')`,
    { claims: w.claimsA, expect: '40001' },
  );
  assert.equal(res, '40001');
  assert.equal(
    scalar(`select title from public.tasks where entity_id = ${uuid(created.id)}`, { claims: w.claimsA }),
    'occ',
    'a version conflict must not have written',
  );
});

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------
test('a message\'s identity, anchor, author and thread root are immutable', () => {
  const message = json(`select public.post_message(${uuid(w.channelA)}, 'original')`, {
    claims: w.claimsA,
  }).entity.id;
  denied(
    'validate_message: update messages set anchor_id',
    `update public.messages set anchor_id = ${uuid(w.taskA)} where entity_id = ${uuid(message)}`,
    { ...owner, expect: '23514' },
  );
  denied(
    'validate_message: update messages set author_id',
    `update public.messages set author_id = ${uuid(w.personaA)} where entity_id = ${uuid(message)}`,
    { ...owner, expect: '23514' },
  );
  denied(
    'validate_message: update messages set client_msg_id',
    `update public.messages set client_msg_id = 'rewritten' where entity_id = ${uuid(message)}`,
    { ...owner, expect: '23514' },
  );
  // The body IS mutable — that is what edit_message is for.
  ok(`update public.messages set body = 'edited by owner' where entity_id = ${uuid(message)}`, owner);
});

test('a message author must be a member or persona of the message\'s own space', () => {
  denied(
    'validate_message: an author from another space',
    `insert into public.entities(id, space_id, kind, created_by)
       values ('019f0000-0000-7000-8000-00000000d001', ${uuid(w.spaceA)}, 'message', ${uuid(w.memberA)});
     insert into public.messages(entity_id, anchor_id, author_id, body)
       values ('019f0000-0000-7000-8000-00000000d001', ${uuid(w.channelA)}, ${uuid(w.memberB)}, 'cross-space author')`,
    { ...owner, expect: '23514', singleTransaction: true },
  );
});

// -----------------------------------------------------------------------------
// Execution
// -----------------------------------------------------------------------------
function spawnSession(title) {
  return json(
    `select public.execution_spawn(${uuid(w.spaceA)}, ${uuid(w.personaA)}, '{}'::uuid[],
       ${uuid(w.projectId)}, 'project', null, null, 'worker', 'claude-opus-5', 'claude',
       ${literal(title)}, 'node-1', true, 64, null, ${literal(cmid('trig-spawn'))})`,
    { claims: w.claimsA },
  ).entity.id;
}

test('work_session.status has a SINGLE writer (R29): any other path is refused', () => {
  const session = spawnSession('single writer probe');
  denied(
    'guard_work_session_status: a direct UPDATE of status, even as the schema owner',
    `update public.work_sessions set status = 'running' where entity_id = ${uuid(session)}`,
    { ...owner, expect: '23514' },
  );
  assert.equal(
    scalar(`select status from public.work_sessions where entity_id = ${uuid(session)}`, {
      claims: w.claimsA,
    }),
    'spawning',
    'the refused update must not have moved the session',
  );

  // The sanctioned path works, and stamps status_changed_at.
  ok(`select public.work_session_transition(${uuid(session)}, 'running')`, { claims: w.claimsA });
  assert.equal(
    scalar(`select status from public.work_sessions where entity_id = ${uuid(session)}`, {
      claims: w.claimsA,
    }),
    'running',
  );
  assert.equal(
    scalar(`select started_at is not null from public.work_sessions where entity_id = ${uuid(session)}`, {
      claims: w.claimsA,
    }),
    't',
    'the transition to running must set started_at',
  );

  // Writing a NON-status column still works — the guard is about status only.
  ok(`update public.work_sessions set title = 'renamed' where entity_id = ${uuid(session)}`, owner);
});

test('terminal work_session states are terminal: a late frame cannot resurrect a session', () => {
  const session = spawnSession('terminal probe');
  ok(`select public.work_session_transition(${uuid(session)}, 'running')`, { claims: w.claimsA });
  ok(`select public.work_session_transition(${uuid(session)}, 'exited', 0)`, { claims: w.claimsA });

  denied(
    'work_session_transition: exited -> running',
    `select public.work_session_transition(${uuid(session)}, 'running')`,
    { claims: w.claimsA, expect: '23514' },
  );
  denied(
    'work_session_transition: exited -> idle',
    `select public.work_session_transition(${uuid(session)}, 'idle')`,
    { claims: w.claimsA, expect: '23514' },
  );
  denied(
    'work_session_transition: back to spawning is never legal',
    `select public.work_session_transition(${uuid(session)}, 'spawning')`,
    { claims: w.claimsA, expect: '23514' },
  );
  denied(
    'work_session_transition: an unknown status',
    `select public.work_session_transition(${uuid(session)}, 'zombie')`,
    { claims: w.claimsA, expect: '22023' },
  );
  // Re-asserting the state you are already in is idempotent, not an error: a
  // retried transition must not fail.
  ok(`select public.work_session_transition(${uuid(session)}, 'exited', 0)`, { claims: w.claimsA });
  assert.equal(
    scalar(`select exit_code from public.work_sessions where entity_id = ${uuid(session)}`, {
      claims: w.claimsA,
    }),
    '0',
  );
});

test('session_manifests store env var NAMES, never values (S15)', () => {
  const session = spawnSession('manifest probe');
  ok(
    `select public.record_session_manifest(${uuid(session)},
       '{"prompt":"hello","skills":[]}'::jsonb, array['ANTHROPIC_API_KEY','TM8_SESSION_TOKEN'])`,
    { claims: w.claimsA },
  );
  assert.equal(
    scalar(
      `select manifest ->> 'prompt' from public.session_manifests where work_session_id = ${uuid(session)}`,
      { claims: w.claimsA },
    ),
    'hello',
  );

  denied(
    'guard_manifest_secrets: a manifest containing an sk- credential value',
    `select public.record_session_manifest(${uuid(session)},
       '{"env":{"ANTHROPIC_API_KEY":"sk-ant-abcdefghijklmnop0123456789"}}'::jsonb)`,
    { claims: w.claimsA, expect: '23514' },
  );
  denied(
    'guard_manifest_secrets: a manifest containing a ghp_ token',
    `select public.record_session_manifest(${uuid(session)},
       '{"env":{"GITHUB_TOKEN":"ghp_abcdefghijklmnopqrstuvwxyz0123"}}'::jsonb)`,
    { claims: w.claimsA, expect: '23514' },
  );
  denied(
    'guard_manifest_secrets: env_var_names holding a VALUE rather than a name',
    `select public.record_session_manifest(${uuid(session)}, '{}'::jsonb,
       array['sk-ant-not-a-name'])`,
    { claims: w.claimsA, expect: '22023' },
  );
  // The earlier good manifest survived every refusal.
  assert.equal(
    scalar(
      `select manifest ->> 'prompt' from public.session_manifests where work_session_id = ${uuid(session)}`,
      { claims: w.claimsA },
    ),
    'hello',
  );
});

// -----------------------------------------------------------------------------
// Event capture
// -----------------------------------------------------------------------------
test('the capture trigger fires INSIDE the mutation\'s transaction, and only commits with it', () => {
  // Both halves matter. Same-transaction visibility is what lets an RPC return the
  // events it caused; other-transaction invisibility is what stops a poller reading
  // an event for a mutation that later rolls back.
  const probe = `capture-${process.pid}`;
  const script =
    `begin;\n` +
    `select set_config('tm8.identity_id', ${literal(w.identityA)}, true);\n` +
    `select set_config('tm8.actor_id', ${literal(w.memberA)}, true);\n` +
    `select public.post_message(${uuid(w.channelA)}, ${literal(probe)});\n` +
    `select 'in-txn:' || count(*) from public.workspace_events\n` +
    `  where space_id = ${uuid(w.spaceA)} and payload ->> 'body' = ${literal(probe)};\n` +
    `rollback;\n` +
    `select 'after-rollback:' || count(*) from public.workspace_events\n` +
    `  where space_id = ${uuid(w.spaceA)} and payload ->> 'body' = ${literal(probe)};\n`;
  const res = runRaw(script, { url: OWNER_URL });
  assert.ok(res.ok, `the capture probe failed:\n${res.stderr}`);
  assert.match(
    res.stdout,
    /in-txn:1/,
    'the event must be visible to its own transaction before commit — the trigger is not deferred',
  );
  assert.match(
    res.stdout,
    /after-rollback:0/,
    'a rolled-back mutation must leave no event behind',
  );
});

test('the capture trigger stamps the cmid, so a client can reconcile its own optimistic write', () => {
  const id = cmid('stamp');
  ok(
    `select public.post_message(${uuid(w.channelA)}, 'stamped', null, null, '[]'::jsonb, '[]'::jsonb,
       ${literal(id)})`,
    { claims: w.claimsA },
  );
  const stamped = Number(
    scalar(
      `select count(*) from public.workspace_events
        where space_id = ${uuid(w.spaceA)} and client_mutation_id = ${literal(id)}`,
      { claims: w.claimsA },
    ),
  );
  assert.ok(stamped > 0, 'every event a ledgered mutation produces must carry its cmid (AM-2 §3)');
});
