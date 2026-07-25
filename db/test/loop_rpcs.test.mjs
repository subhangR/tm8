// =============================================================================
// The G1A loop, end to end, through the RPC catalog only.
//
// This is the sequence the user hand-tests:
//   create a space + project + task -> spawn an agent session -> prompt it ->
//   see progress land in the task thread -> complete it
//
// Every step asserts the CONTENT of what came back, not just that the call
// returned. That is deliberate: internal.entity_content falls through to '{}' for a
// kind it does not know, which is a valid jsonb object and therefore invisible to
// any assertion that only checks for success. Migration 011 exists because
// messages.post and execution.spawn were both returning contentless envelopes and
// nothing was looking. If a new core kind is added, assert its content here.
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
  rows,
  scalar,
  uuid,
} from './helpers.mjs';

const w = buildWorld('loop');

/**
 * Re-read an entity in the exact shape a command result carries it (envelope +
 * content + counters). internal.command_entity is an internal helper and is NOT
 * granted to tm8_app — deliberately, it is reached only from inside the definer
 * RPCs — so this one read goes through the owner connection. RLS on the read path
 * is what db/test/rls_negatives.test.mjs is for.
 */
const commandEntity = (id) => json(`select internal.command_entity(${uuid(id)})`, { url: OWNER_URL });

// Threaded through the steps below, in order.
const state = {};

test('step 1 — the space exists with its owner member, general channel and default axis', () => {
  const identity = json(`select public.current_identity()`, { claims: w.claimsA });
  assert.equal(identity.identityId, w.identityA);
  assert.equal(identity.isNodeAdmin, true);
  assert.ok(
    identity.memberships.some((m) => m.spaceId === w.spaceA && m.role === 'owner'),
    'the creator must be the space owner',
  );

  const spaceIdentity = json(`select public.current_space_identity(${uuid(w.spaceA)})`, {
    claims: w.claimsA,
  });
  assert.equal(spaceIdentity.memberId, w.memberA);
  assert.equal(spaceIdentity.role, 'owner');
  assert.ok(
    spaceIdentity.teamMemberIds.includes(w.personaA),
    'the persona the identity owns must be listed as actable-as',
  );

  // create_space builds the general channel and the default `type` axis in the
  // same transaction, so a fresh space is immediately usable.
  const channel = commandEntity(w.channelA);
  assert.equal(channel.kind, 'channel');
  assert.equal(channel.content.name, 'general', 'channel content must resolve (011)');
  assert.deepEqual(
    rows(`select name, kind from public.task_axes where space_id = ${uuid(w.spaceA)}`, {
      claims: w.claimsA,
    }),
    [{ name: 'type', kind: 'default' }],
  );

  // The member entity's content resolves too — this was one of the 011 gaps.
  const member = commandEntity(w.memberA);
  assert.equal(member.content.role, 'owner', 'member content must resolve (011)');
  assert.equal(member.content.identity_id, w.identityA);
});

test('step 2 — the project is registered and linked, and is spawnable from the space', () => {
  const project = json(
    `select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from public.projects p
      where p.id = ${uuid(w.projectId)}`,
    { claims: w.claimsA },
  );
  assert.equal(project.length, 1);
  assert.equal(project[0].trust, 'trusted');
  assert.match(project[0].working_dir, /^\//, 'working_dir is an absolute path (S11)');

  assert.equal(
    scalar(
      `select count(*) from public.space_projects
        where space_id = ${uuid(w.spaceA)} and project_id = ${uuid(w.projectId)}`,
      { claims: w.claimsA },
    ),
    '1',
  );
});

test('step 3 — create a task, and it lands in ready_to_work', () => {
  const created = json(
    `select public.create_task(${uuid(w.spaceA)}, 'Ship the loop', null,
       'The one flow the user hand-tests', '{"type":"code"}'::jsonb, null, null, 'high',
       '[{"text":"loop runs end to end","done":false}]'::jsonb, 5, null, null, 'attached_to',
       ${literal(cmid('loop-task'))})`,
    { claims: w.claimsA },
  );
  state.task = created.entity;

  assert.equal(state.task.kind, 'task');
  assert.equal(state.task.version, 1);
  assert.equal(state.task.content.title, 'Ship the loop');
  assert.equal(state.task.content.work_status, 'open');
  assert.equal(state.task.content.priority, 'high');
  assert.equal(state.task.content.points_estimate, 5);
  assert.deepEqual(state.task.content.axes, { type: 'code' });
  assert.equal(state.task.counters.messages, 0, 'counters travel with the command result');

  const ready = rows(`select entity_id, title, priority from public.ready_to_work(${uuid(w.spaceA)})`, {
    claims: w.claimsA,
  });
  assert.ok(
    ready.some((r) => r.entity_id === state.task.id),
    'an open task with no unresolved dependency must be ready to work',
  );
});

test('step 4 — spawn a session against that task, with a manifest', () => {
  const spawned = json(
    `select public.execution_spawn(${uuid(w.spaceA)}, ${uuid(w.personaA)},
       array[${uuid(state.task.id)}]::uuid[], ${uuid(w.projectId)}, 'project', null, null,
       'coordinated-worker', 'claude-opus-5', 'claude', 'Loop session', 'node-local',
       true, 64, null, ${literal(cmid('loop-spawn'))})`,
    { claims: w.claimsA },
  );
  state.session = spawned.entity;

  assert.equal(state.session.kind, 'work_session');
  // The whole reason 011 exists: SpawnService reads these off the spawn result.
  assert.equal(state.session.content.status, 'spawning', 'work_session content must resolve (011)');
  assert.equal(state.session.content.project_id, w.projectId);
  assert.equal(state.session.content.workdir_mode, 'project');
  assert.equal(state.session.content.mode, 'coordinated-worker');
  assert.equal(state.session.content.model, 'claude-opus-5');
  assert.equal(state.session.content.agent_tool, 'claude');
  assert.equal(state.session.content.node_id, 'node-local');

  // The session is bound to the task it was spawned for, and to its persona.
  const edges = rows(
    `select type, dst_id from public.edges where src_id = ${uuid(state.session.id)} order by type`,
    { claims: w.claimsA },
  );
  assert.deepEqual(
    edges,
    [
      { type: 'relates_to', dst_id: w.personaA },
      { type: 'working_on', dst_id: state.task.id },
    ],
    'spawn must attach the session to its task (working_on) and its persona (relates_to)',
  );

  ok(
    `select public.record_session_manifest(${uuid(state.session.id)},
       ${literal(JSON.stringify({ prompt: 'Do the thing', skills: ['maestro-worker'], mode: 'coordinated-worker' }))}::jsonb,
       array['ANTHROPIC_API_KEY','TM8_SESSION_TOKEN'])`,
    { claims: w.claimsA },
  );
  const manifest = json(
    `select manifest from public.session_manifests where work_session_id = ${uuid(state.session.id)}`,
    { claims: w.claimsA },
  );
  assert.equal(manifest.prompt, 'Do the thing');
  assert.deepEqual(manifest.skills, ['maestro-worker']);
});

test('step 5 — the session comes up, and the prompt is audited', () => {
  ok(
    `select public.work_session_transition(${uuid(state.session.id)}, 'running', null, null, null,
       ${literal(cmid('loop-running'))})`,
    { claims: w.claimsA },
  );
  assert.equal(
    scalar(`select status from public.work_sessions where entity_id = ${uuid(state.session.id)}`, {
      claims: w.claimsA,
    }),
    'running',
  );

  // execution.prompt delivers into a live PTY: its effect is not graph state, so
  // what the graph owes it is an audit row.
  const audited = json(
    `select public.record_execution_command(${uuid(state.session.id)}, 'execution.prompt',
       '{"text":"start on the task"}'::jsonb, null, ${literal(cmid('loop-prompt'))})`,
    { claims: w.claimsA },
  );
  assert.ok(audited, 'record_execution_command must return the session');
  assert.equal(
    scalar(`select count(*) from public.work_sessions where entity_id = ${uuid(state.session.id)}`, {
      claims: w.claimsA,
    }),
    '1',
  );
});

test('step 6 — the agent reports progress into the task thread, as itself', () => {
  // Authored by the PERSONA, not by the human: this is the attribution the whole
  // can_act_as machinery exists to make safe.
  const progress = json(
    `select public.post_message(${uuid(state.task.id)}, 'Working on it — 2 of 3 criteria done',
       ${uuid(w.personaA)}, null, '[]'::jsonb, '[]'::jsonb, ${literal(cmid('loop-progress'))})`,
    { claims: w.claimsA },
  );
  state.message = progress.entity;

  assert.equal(state.message.kind, 'message');
  // The other half of 011: without a message content branch the thread renders blank.
  assert.equal(
    state.message.content.body,
    'Working on it — 2 of 3 criteria done',
    'message content must resolve (011)',
  );
  assert.equal(state.message.content.anchor_id, state.task.id);
  assert.equal(state.message.content.author_id, w.personaA, 'the agent authored it, not its owner');

  // The task's message counter is derived, and the patch carries the new value.
  const anchorPatch = progress.patches.find((p) => p.id === state.task.id);
  assert.ok(anchorPatch, 'the anchor must come back as a patch so the client can update its badge');
  assert.equal(anchorPatch.counters.messages, 1, 'the messages counter must have been maintained');

  // A reply threads under it.
  const reply = json(
    `select public.post_message(${uuid(state.task.id)}, 'Nice', null, ${uuid(state.message.id)},
       '[]'::jsonb, '[]'::jsonb, ${literal(cmid('loop-reply'))})`,
    { claims: w.claimsA },
  );
  assert.equal(reply.entity.content.root_message_id, state.message.id, 'a reply carries its thread root');
});

test('step 7 — work state moves, and the working_on edge follows the actor', () => {
  const working = json(
    `select public.set_work_state(${uuid(state.task.id)}, 'working', ${uuid(w.personaA)}, null,
       'agent picked it up', ${literal(cmid('loop-working'))})`,
    { claims: w.claimsA },
  );
  assert.equal(working.entity.content.work_status, 'working');
  assert.equal(working.edge.type, 'working_on');
  assert.equal(working.edge.src_id, w.personaA);
  assert.equal(working.edge.dst_id, state.task.id);
  assert.equal(JSON.parse(JSON.stringify(working.edge.props)).status, 'working');

  // `done` is refused here on purpose: completion has a gate, and set_work_state is
  // not it.
  denied(
    'set_work_state: "done" must go through complete_task',
    `select public.set_work_state(${uuid(state.task.id)}, 'done')`,
    { claims: w.claimsA, expect: '23514' },
  );
  denied(
    'set_work_state: an unknown work status',
    `select public.set_work_state(${uuid(state.task.id)}, 'vibing')`,
    { claims: w.claimsA, expect: '22023' },
  );

  // Moving back to open retracts the edge rather than leaving a stale one.
  ok(
    `select public.set_work_state(${uuid(state.task.id)}, 'open', ${uuid(w.personaA)}, null, null,
       ${literal(cmid('loop-reopen'))})`,
    { claims: w.claimsA },
  );
  assert.equal(
    scalar(
      `select count(*) from public.edges
        where src_id = ${uuid(w.personaA)} and dst_id = ${uuid(state.task.id)} and type = 'working_on'`,
      { claims: w.claimsA },
    ),
    '0',
    'returning a task to open must drop the working_on edge',
  );
});

test('step 8 — completion is gated on the acceptance criteria', () => {
  const current = commandEntity(state.task.id);

  // The criterion is still unfinished, so the gate holds — with the CORRECT
  // expected version, so this is the criteria gate and not a version conflict.
  denied(
    'complete_task: acceptance criteria are not all done',
    `select public.complete_task(${uuid(state.task.id)}, ${current.version},
       array[${uuid(w.personaA)}]::uuid[], null, ${literal(cmid('loop-premature'))})`,
    { claims: w.claimsA, expect: '23514' },
  );
  assert.equal(
    scalar(`select work_status from public.tasks where entity_id = ${uuid(state.task.id)}`, {
      claims: w.claimsA,
    }),
    'open',
    'a refused completion must not have moved the task',
  );

  // Satisfy the criteria, then complete.
  ok(
    `select public.update_task_content(${uuid(state.task.id)}, ${current.version}, null, null, null,
       null, null, null, '[{"text":"loop runs end to end","done":true}]'::jsonb, null, null, false,
       ${literal(cmid('loop-criteria'))})`,
    { claims: w.claimsA },
  );

  const ready = commandEntity(state.task.id);
  const completed = json(
    `select public.complete_task(${uuid(state.task.id)}, ${ready.version},
       array[${uuid(w.personaA)}]::uuid[], null, ${literal(cmid('loop-complete'))})`,
    { claims: w.claimsA },
  );

  assert.equal(completed.entity.content.work_status, 'done');
  assert.equal(
    scalar(
      `select count(*) from public.edges
        where src_id = ${uuid(state.task.id)} and dst_id = ${uuid(w.personaA)} and type = 'completed_by'`,
      { claims: w.claimsA },
    ),
    '1',
    'completion records who completed it',
  );
  assert.equal(
    scalar(
      `select amount from public.point_events
        where ref_id = ${uuid(state.task.id)} and entity_id = ${uuid(w.personaA)}`,
      { claims: w.claimsA },
    ),
    '5',
    'the points estimate is paid to the completer',
  );

  // The leaderboard reads the ledger, not the counter cache.
  const board = rows(`select actor_id, score from public.leaderboard(${uuid(w.spaceA)}, 10)`, {
    claims: w.claimsA,
  });
  const persona = board.find((r) => r.actor_id === w.personaA);
  assert.ok(persona, 'the completer must appear on the leaderboard');
  assert.ok(Number(persona.score) >= 5);

  // ...and it leaves ready_to_work.
  const readyNow = rows(`select entity_id from public.ready_to_work(${uuid(w.spaceA)})`, {
    claims: w.claimsA,
  });
  assert.ok(
    !readyNow.some((r) => r.entity_id === state.task.id),
    'a completed task is no longer ready to work',
  );
});

test('step 9 — the session exits with a transcript, and the graph records it', () => {
  const transcript = json(
    `select public.create_document(${uuid(w.spaceA)}, 'Loop session transcript', null,
       'the terminal output', 'markdown', null, null, ${uuid(state.session.id)}, 'attached_to',
       ${literal(cmid('loop-transcript'))})`,
    { claims: w.claimsA },
  );
  assert.equal(transcript.entity.content.title, 'Loop session transcript');

  ok(
    `select public.work_session_transition(${uuid(state.session.id)}, 'exited', 0, null,
       ${uuid(transcript.entity.id)}, ${literal(cmid('loop-exit'))})`,
    { claims: w.claimsA },
  );
  const session = commandEntity(state.session.id);
  assert.equal(session.content.status, 'exited');
  assert.equal(session.content.exit_code, 0);
  assert.equal(session.content.transcript_doc_id, transcript.entity.id);
  assert.ok(session.content.exited_at, 'exiting must stamp exited_at');
});

test('the whole loop produced one ordered, gapless event stream for the space', () => {
  // What Sirius polls. Asserted here as an integration property rather than in
  // isolation: the loop's events, in order, with the verbs the client dispatches on.
  const events = rows(
    `select seq, event_type from public.workspace_events
      where space_id = ${uuid(w.spaceA)} order by seq`,
    { claims: w.claimsA },
  );
  const seqs = events.map((e) => Number(e.seq));
  assert.deepEqual(
    seqs,
    Array.from({ length: seqs.length }, (_, i) => i + 1),
    'the space feed must be a contiguous run from 1',
  );

  const verbs = new Set(events.map((e) => e.event_type));
  for (const expected of ['entity.upsert', 'message.created', 'activity.created', 'counter.changed']) {
    assert.ok(verbs.has(expected), `the loop should have emitted ${expected}; saw ${[...verbs].join(', ')}`);
  }
});

test('entity_tree walks the task hierarchy the composer renders', () => {
  const root = json(`select public.create_task(${uuid(w.spaceA)}, 'epic')`, { claims: w.claimsA }).entity;
  const child = json(
    `select public.create_task(${uuid(w.spaceA)}, 'subtask', null, '', '{}'::jsonb, ${uuid(root.id)})`,
    { claims: w.claimsA },
  ).entity;
  const grandchild = json(
    `select public.create_task(${uuid(w.spaceA)}, 'sub-subtask', null, '', '{}'::jsonb, ${uuid(child.id)})`,
    { claims: w.claimsA },
  ).entity;

  const tree = rows(`select id, depth from public.entity_tree(${uuid(root.id)})`, { claims: w.claimsA });
  assert.deepEqual(
    tree.map((r) => [r.id, Number(r.depth)]),
    [
      [root.id, 0],
      [child.id, 1],
      [grandchild.id, 2],
    ],
  );

  // entity_tree is SECURITY INVOKER, so RLS applies to it — a non-member walking
  // the same tree gets nothing rather than a leak through a definer read.
  assert.deepEqual(
    rows(`select id from public.entity_tree(${uuid(root.id)})`, { claims: w.claimsB }),
    [],
    'entity_tree must be RLS-filtered for a non-member',
  );
});
