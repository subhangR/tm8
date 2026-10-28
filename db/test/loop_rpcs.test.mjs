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
  LEGACY_LAUNCH,
  OWNER_URL,
  buildWorld,
  cmid,
  denied,
  json,
  literal,
  ok,
  postMessageSql,
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
    // 234: a project row is readable only by a node (gate) admin.
    { claims: w.adminA },
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
       '[{"text":"loop runs end to end","done":false}]'::jsonb, 5,
       p_client_mutation_id => ${literal(cmid('loop-task'))})`,
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

  // The session is bound to the task it was spawned for, to the project's graph
  // projection (in_project, 021), and to its persona (participates_in, persona ->
  // session; 309 dropped the relates_to duplicate).
  const edges = rows(
    `select type, dst_id from public.edges where src_id = ${uuid(state.session.id)} order by type`,
    { claims: w.claimsA },
  );
  assert.deepEqual(
    edges.map((e) => e.type),
    ['in_project', 'working_on'],
    'spawn must attach the session to its project and its task',
  );
  assert.equal(
    edges.find((e) => e.type === 'working_on').dst_id,
    state.task.id,
    'spawn must attach the session to its task (working_on)',
  );
  assert.deepEqual(
    rows(
      `select type, src_id from public.edges where dst_id = ${uuid(state.session.id)} and type = 'participates_in'`,
      { claims: w.claimsA },
    ),
    [{ type: 'participates_in', src_id: w.personaA }],
    'spawn must attach the session to its persona (participates_in)',
  );

  ok(
    `select public.record_session_manifest(${uuid(state.session.id)},
       ${literal(JSON.stringify({ prompt: 'Do the thing', skills: ['maestro-worker'], mode: 'coordinated-worker', launch: LEGACY_LAUNCH }))}::jsonb,
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
  const beforeTransitionSeq = Number(
    scalar(
      `select coalesce(max(seq), 0) from public.workspace_events where space_id = ${uuid(w.spaceA)}`,
      { claims: w.claimsA },
    ),
  );
  // cmid() mints a fresh id per call, so the one asserted below is held here.
  const runningCmid = cmid('loop-running');
  ok(
    `select public.work_session_transition(${uuid(state.session.id)}, 'running', null, null, null,
       ${literal(runningCmid)})`,
    { claims: w.claimsA },
  );
  assert.equal(
    scalar(`select status from public.work_sessions where entity_id = ${uuid(state.session.id)}`, {
      claims: w.claimsA,
    }),
    'running',
  );

  const statusEvents = rows(
    `select event_type, payload->>'id' entity_id, client_mutation_id
       from public.workspace_events
      where space_id = ${uuid(w.spaceA)} and seq > ${beforeTransitionSeq}
      order by seq`,
    { claims: w.claimsA },
  );
  assert.ok(
    statusEvents.some((event) =>
      event.event_type === 'entity.upsert' &&
      event.entity_id === state.session.id &&
      event.client_mutation_id === runningCmid),
    'a work_session status transition must emit a durable entity.upsert carrying its mutation id',
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
  // w2_post_message_batch (the server's write surface since 019) returns ids,
  // not envelopes, so the message is re-read in command shape.
  const progress = json(
    postMessageSql(state.task.id, 'Working on it — 2 of 3 criteria done', {
      actor: w.personaA,
      clientMutationId: cmid('loop-progress'),
    }),
    { claims: w.claimsA },
  );
  state.message = commandEntity(progress.messageIds[0]);

  assert.equal(state.message.kind, 'message');
  // The other half of 011: without a message content branch the thread renders blank.
  assert.equal(
    state.message.content.body,
    'Working on it — 2 of 3 criteria done',
    'message content must resolve (011)',
  );
  assert.equal(state.message.content.anchor_id, state.task.id);
  assert.equal(state.message.content.author_id, w.personaA, 'the agent authored it, not its owner');

  // The task's message counter is derived.
  assert.equal(
    commandEntity(state.task.id).counters.messages,
    1,
    'the messages counter must have been maintained',
  );

  // A reply threads under it.
  const reply = json(
    postMessageSql(state.task.id, 'Nice', { parent: state.message.id, clientMutationId: cmid('loop-reply') }),
    { claims: w.claimsA },
  );
  assert.equal(
    commandEntity(reply.messageIds[0]).content.root_message_id,
    state.message.id,
    'a reply carries its thread root',
  );
});

test('step 7 — work state moves, and the working_on edge follows the actor', () => {
  const working = json(
    `select public.set_work_state(${uuid(state.task.id)}, 'working', ${uuid(w.personaA)}, null,
       'agent picked it up', ${literal(cmid('loop-working'))}, p_claim => true)`,
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

  // Moving back to open ENDS the claim rather than leaving a live one (302 keeps
  // ended claims as history: endedAt + endReason on the edge, never a delete).
  ok(
    `select public.set_work_state(${uuid(state.task.id)}, 'open', ${uuid(w.personaA)}, null, null,
       ${literal(cmid('loop-reopen'))})`,
    { claims: w.claimsA },
  );
  assert.equal(
    scalar(
      `select count(*) from public.edges
        where src_id = ${uuid(w.personaA)} and dst_id = ${uuid(state.task.id)} and type = 'working_on'
          and not (props ? 'endedAt')`,
      { claims: w.claimsA },
    ),
    '0',
    'returning a task to open must end every live working_on claim',
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
    `select public.update_task_content(${uuid(state.task.id)}, ${current.version},
       p_acceptance_criteria => '[{"text":"loop runs end to end","done":true}]'::jsonb,
       p_client_mutation_id => ${literal(cmid('loop-criteria'))})`,
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

test('a loop entity resolves its content — the standing rule at the top of this file', () => {
  // "If a new core kind is added, assert its content here." `loop` (086) is
  // that kind. This is not a formality: internal.entity_content falls through
  // to '{}'::jsonb for a kind it does not know, which is a valid jsonb object
  // and therefore invisible to any assertion that only checks for success —
  // the exact hole migration 011 exists to close.
  const created = json(
    `select public.create_loop(${uuid(w.spaceA)}, 'Nightly dreamer', ${uuid(w.personaA)},
       'every 1d', null, null, 'sweep the memory graph', '{"model":"claude-opus-5"}'::jsonb,
       true, null, null, null, ${literal(cmid('loop-kind'))})`,
    { claims: w.claimsA },
  );
  const loop = created.entity;

  assert.equal(loop.kind, 'loop');
  assert.equal(loop.content.title, 'Nightly dreamer', 'loop content must resolve (011)');
  assert.equal(loop.content.schedule, 'every 1d');
  assert.equal(loop.content.enabled, true);
  assert.equal(loop.content.prompt, 'sweep the memory graph');
  assert.deepEqual(JSON.parse(JSON.stringify(loop.content.config)), { model: 'claude-opus-5' });
  // MEASURED, and it contradicts the obvious expectation, so it is pinned:
  // `internal.command_result` (007:53) runs `jsonb_strip_nulls`, which is
  // RECURSIVE — so every null column is ABSENT from this envelope, not null.
  // `team_member_id` is the one that matters: null means "route through the
  // dispatcher" (§4.4), and here that value is indistinguishable from "no such
  // field". This is exactly why `loop` needs hand projections in the two HTTP
  // read arms (facade/entity-read.ts and events/projector.ts) instead of
  // riding this jsonb — those select the column explicitly and DO emit null.
  assert.equal('team_member_id' in loop.content, false,
    'command_result strip-nulls drops null columns; the HTTP arms are what preserve them');
  assert.equal(loop.content.subject_id, undefined);

  // The doors refuse a cross-space runner: a loop is a standing grant of its
  // creator's authority on a timer, and one that could name an entity in
  // another space would be a scheduled confused deputy.
  denied(
    'create_loop: a subject from another space',
    `select public.create_loop(${uuid(w.spaceA)}, 'Cross-space', null, 'every 1d',
       null, ${uuid(w.channelB)})`,
    { claims: w.claimsA, expect: '23503' },
  );
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

test('378 — runner invariants, the action backfill rule, loop_runs and loop headers', () => {
  const dispatch = json(
    `select public.create_loop(${uuid(w.spaceA)}, 'Routed', null, 'every 1h',
       p_client_mutation_id => ${literal(cmid('loop-378-dispatch'))})`,
    { claims: w.claimsA },
  ).entity;
  // A caller written against 091 names no action: no runner still means dispatch.
  assert.equal(dispatch.content.action, 'dispatch');
  assert.equal(dispatch.content.timezone, 'UTC');
  assert.equal(dispatch.content.concurrency, 'skip');
  assert.equal(dispatch.content.retry_attempts, 0);
  assert.equal(dispatch.content.retry_delay_seconds, 300);

  const spawn = json(
    `select public.create_loop(${uuid(w.spaceA)}, 'Spawned', null, '0 9 * * 1-5',
       ${uuid(w.personaA)}, p_timezone => 'Europe/London', p_concurrency => 'queue',
       p_max_runtime_seconds => 600, p_retry_attempts => 2, p_retry_delay_seconds => 60,
       p_client_mutation_id => ${literal(cmid('loop-378-spawn'))})`,
    { claims: w.claimsA },
  ).entity;
  assert.equal(spawn.content.action, 'spawn');
  assert.equal(spawn.content.timezone, 'Europe/London');
  assert.equal(spawn.content.concurrency, 'queue');
  assert.equal(spawn.content.max_runtime_seconds, 600);

  denied('create_loop: spawn without a runner',
    `select public.create_loop(${uuid(w.spaceA)}, 'No runner', null, 'every 1d', p_action => 'spawn')`,
    { claims: w.claimsA, expect: '22023' });
  denied('create_loop: tool without a tool',
    `select public.create_loop(${uuid(w.spaceA)}, 'No tool', null, 'every 1d', p_action => 'tool')`,
    { claims: w.claimsA, expect: '22023' });
  denied('create_loop: a tool id that is not a tool',
    `select public.create_loop(${uuid(w.spaceA)}, 'Not a tool', null, 'every 1d',
       p_action => 'tool', p_tool_id => ${uuid(spawn.id)})`,
    { claims: w.claimsA, expect: '23503' });
  denied('create_loop: retry attempts out of range',
    `select public.create_loop(${uuid(w.spaceA)}, 'Retry', null, 'every 1d', p_retry_attempts => 9)`,
    { claims: w.claimsA, expect: '23514' });
  // The invariant is judged on the row a patch leaves: clearing the runner of a
  // spawn loop is refused, not stored.
  denied('update_loop: clearing the runner of a spawn loop',
    `select public.update_loop(${uuid(spawn.id)}, 1, null, p_clear_team_member => true)`,
    { claims: w.claimsA, expect: '22023' });

  // Pause and resume are bookkeeping: they write paused_until and nothing else.
  const until = '2030-01-01T09:00:00Z';
  const paused = json(
    `select public.update_loop(${uuid(spawn.id)}, 1, null, p_paused_until => ${literal(until)},
       p_client_mutation_id => ${literal(cmid('loop-378-pause'))})`,
    { claims: w.claimsA },
  ).entity;
  assert.equal(new Date(paused.content.paused_until).toISOString(), new Date(until).toISOString());

  // loop_runs: recorded by a member, settled once, invisible outside the space.
  const run = json(
    `select public.loop_run_record(${uuid(spawn.id)}, now(), 'manual', 'fired',
       p_client_mutation_id => ${literal(cmid('loop-378-run'))})`,
    { claims: w.claimsA },
  );
  assert.ok(run.runId);
  const first = json(`select public.loop_run_settle(${uuid(run.runId)}, 'stopped')`, { claims: w.claimsA });
  const second = json(`select public.loop_run_settle(${uuid(run.runId)}, 'completed')`, { claims: w.claimsA });
  assert.equal(first.outcome, 'stopped');
  assert.equal(second.outcome, 'stopped', 'a run settles once');
  assert.equal(
    scalar(`select action from public.loop_runs where id = ${uuid(run.runId)}`, { claims: w.claimsA }),
    'spawn', 'the run snapshots the loop action');
  assert.deepEqual(
    rows(`select id from public.loop_runs where id = ${uuid(run.runId)}`, { claims: w.claimsB }),
    [], 'loop_runs is RLS-filtered for a non-member');
  denied('loop_run_record: a non-member',
    `select public.loop_run_record(${uuid(spawn.id)}, now(), 'manual', 'fired')`,
    { claims: w.claimsB, expect: '42501' });

  assert.equal(scalar(`select internal.header_kind_allowed('loop')`, { url: OWNER_URL }), 't');
  assert.equal(scalar(`select internal.header_kind_allowed('tool')`, { url: OWNER_URL }), 't');
});

test('382 — claim-then-fire: due read, claim, overlap skip/queue/409, launch bookkeeping, retry, sweep read', () => {
  const human = { ...w.claimsA, 'tm8.auth_kind': 'browser' };
  const worker = { 'tm8.identity_id': w.identityA, 'tm8.node_admin': 'true', 'tm8.background_job': 'loops.execute-due' };
  const past = `now() - interval '1 minute'`;
  const loop = json(
    `select public.create_loop(${uuid(w.spaceA)}, 'Claimed', null, 'every 1h', ${uuid(w.personaA)},
       p_next_run_at => ${past}, p_retry_attempts => 1, p_retry_delay_seconds => 60,
       p_client_mutation_id => ${literal(cmid('loop-382-create'))})`,
    { claims: human },
  ).entity;

  // Who the firing runs as: the human armer, by the armer rule.
  const acting = json(`select public.loop_acting_as(${uuid(loop.id)})`, { claims: w.claimsA });
  assert.equal(acting.identityId, w.identityA);
  assert.equal(acting.via, 'armer');
  denied('loop_acting_as: a non-member', `select public.loop_acting_as(${uuid(loop.id)})`, { claims: w.claimsB, expect: '42501' });

  // The due read is the worker's; a member sees nothing through it.
  assert.deepEqual(rows(`select entity_id from public.loops_claimable(25, now())`, { claims: w.claimsA }), []);
  const due = rows(`select entity_id, act_as_identity, concurrency, retry_attempt from public.loops_claimable(25, now())`, { claims: worker });
  assert.ok(due.some((row) => row.entity_id === loop.id && row.act_as_identity === w.identityA && row.concurrency === 'skip'));

  // A scheduled claim is the executor's alone.
  denied('loop_run_claim: a member may not make a scheduled claim',
    `select public.loop_run_claim(${uuid(loop.id)}, now(), 'schedule', '{}'::uuid[], now() + interval '1 hour')`,
    { claims: w.claimsA, expect: '42501' });

  // The claim: one 'fired' row, next_run_at advanced to the instant handed in, last_run_at set.
  const claim1 = json(
    `select public.loop_run_claim(${uuid(loop.id)}, now(), 'schedule', '{}'::uuid[], now() + interval '1 hour', null, ${literal(w.identityA)})`,
    { claims: worker },
  );
  assert.equal(claim1.claimed, true);
  assert.equal(claim1.launch, 'fired');
  assert.equal(claim1.attempt, 1);
  assert.equal(claim1.actedAsIdentityId, w.identityA);
  const afterClaim = rows(`select (next_run_at > now()) advanced, last_run_at is not null ran from public.loops where entity_id = ${uuid(loop.id)}`, { claims: w.claimsA })[0];
  assert.deepEqual(afterClaim, { advanced: true, ran: true });
  assert.equal(scalar(`select launch from public.loop_runs where id = ${uuid(claim1.runId)}`, { claims: w.claimsA }), 'fired');
  // Claimed, so no longer due: a second scheduled claim is refused as not_due.
  const again = json(`select public.loop_run_claim(${uuid(loop.id)}, now(), 'schedule', '{}'::uuid[], now() + interval '1 hour')`, { claims: worker });
  assert.deepEqual(again, { claimed: false, reason: 'not_due' });

  // The launch record: task and session land on the run; retry counter and last_error clear.
  const launched = json(`select public.loop_run_launched(${uuid(claim1.runId)}, ${uuid(w.taskA)}, null)`, { claims: worker });
  assert.equal(launched.taskId, w.taskA);

  // OVERLAP (concurrency skip): run1 is open and its launch is in flight (no session yet, fresh).
  ok(`update public.loops set next_run_at = ${past} where entity_id = ${uuid(loop.id)}`, { url: OWNER_URL });
  const skipped = json(
    `select public.loop_run_claim(${uuid(loop.id)}, now(), 'schedule', '{}'::uuid[], now() + interval '1 hour')`,
    { claims: worker },
  );
  assert.equal(skipped.claimed, true);
  assert.equal(skipped.launch, 'skipped');
  assert.equal(skipped.skipReason, 'overlap');
  assert.equal(skipped.waitingOnRunId, claim1.runId);
  assert.equal(scalar(`select (next_run_at > now())::text from public.loops where entity_id = ${uuid(loop.id)}`, { claims: w.claimsA }), 'true', 'a skipped deadline still advances');

  // OVERLAP (concurrency queue): no row, next_run_at untouched, the open run named.
  ok(`update public.loops set concurrency = 'queue', next_run_at = ${past} where entity_id = ${uuid(loop.id)}`, { url: OWNER_URL });
  const before = scalar(`select count(*)::text from public.loop_runs where loop_id = ${uuid(loop.id)}`, { claims: w.claimsA });
  const queued = json(`select public.loop_run_claim(${uuid(loop.id)}, now(), 'schedule', '{}'::uuid[], now() + interval '1 hour')`, { claims: worker });
  assert.deepEqual(queued, { claimed: false, reason: 'queued', waitingOnRunId: claim1.runId });
  assert.equal(scalar(`select count(*)::text from public.loop_runs where loop_id = ${uuid(loop.id)}`, { claims: w.claimsA }), before, 'queue writes no row per tick');
  assert.equal(scalar(`select (next_run_at <= now())::text from public.loops where entity_id = ${uuid(loop.id)}`, { claims: w.claimsA }), 'true', 'a queued loop stays due');

  // Run now while run1 is live: 409 material unless forced; forced fires and records the presser.
  const refused = json(`select public.loop_run_claim(${uuid(loop.id)}, now(), 'manual', '{}'::uuid[], p_client_mutation_id => ${literal(cmid('loop-382-manual-refused'))})`, { claims: w.claimsA });
  assert.deepEqual(refused, { claimed: false, reason: 'overlap', waitingOnRunId: claim1.runId });
  const forced = json(`select public.loop_run_claim(${uuid(loop.id)}, now(), 'manual', '{}'::uuid[], p_force => true, p_client_mutation_id => ${literal(cmid('loop-382-manual-forced'))})`, { claims: w.claimsA });
  assert.equal(forced.claimed, true);
  assert.equal(forced.launch, 'fired');
  assert.equal(forced.requestedBy, w.memberA);
  assert.equal(scalar(`select trigger from public.loop_runs where id = ${uuid(forced.runId)}`, { claims: w.claimsA }), 'manual');
  // The same mutation id replays the same claim instead of minting a second run.
  const replayed = json(`select public.loop_run_claim(${uuid(loop.id)}, now(), 'manual', '{}'::uuid[], p_force => true, p_client_mutation_id => ${literal(cmid('loop-382-manual-forced'))})`, { claims: w.claimsA });
  assert.equal(replayed.runId, forced.runId);
  denied('loop_run_claim: a non-member may not Run now',
    `select public.loop_run_claim(${uuid(loop.id)}, now(), 'manual', '{}'::uuid[])`, { claims: w.claimsB, expect: '42501' });

  // Settle run1 and the forced run; the queued loop then fires on the next claim.
  json(`select public.loop_run_settle(${uuid(claim1.runId)}, 'completed')`, { claims: worker });
  json(`select public.loop_run_settle(${uuid(forced.runId)}, 'stopped')`, { claims: w.claimsA });
  const claim3 = json(`select public.loop_run_claim(${uuid(loop.id)}, now(), 'schedule', '{}'::uuid[], now() + interval '1 hour')`, { claims: worker });
  assert.equal(claim3.launch, 'fired');

  // LAUNCH FAILURE with one retry left: launch='failed', error on the run and the loop, re-armed in 60s, attempt 2 next.
  const failed = json(`select public.loop_run_launch_failed(${uuid(claim3.runId)}, 'spawn refused: capacity', now())`, { claims: worker });
  assert.ok(failed.retryAt, 'a retry is scheduled');
  const afterFail = rows(`select retry_attempt, last_error, (next_run_at between now() + interval '50 seconds' and now() + interval '70 seconds') backoff from public.loops where entity_id = ${uuid(loop.id)}`, { claims: w.claimsA })[0];
  assert.deepEqual(afterFail, { retry_attempt: 1, last_error: 'spawn refused: capacity', backoff: true });
  assert.deepEqual(rows(`select launch, error from public.loop_runs where id = ${uuid(claim3.runId)}`, { claims: w.claimsA }), [{ launch: 'failed', error: 'spawn refused: capacity' }]);
  ok(`update public.loops set next_run_at = ${past} where entity_id = ${uuid(loop.id)}`, { url: OWNER_URL });
  const claim4 = json(`select public.loop_run_claim(${uuid(loop.id)}, now(), 'schedule', '{}'::uuid[], now() + interval '1 hour')`, { claims: worker });
  assert.equal(claim4.attempt, 2, 'the retry is attempt 2 of the same deadline');
  // Retries exhausted: the counter resets for the next deadline; no re-arm.
  const exhausted = json(`select public.loop_run_launch_failed(${uuid(claim4.runId)}, 'spawn refused again', now())`, { claims: worker });
  assert.equal(exhausted.retryAt, null);
  assert.equal(scalar(`select retry_attempt::text from public.loops where entity_id = ${uuid(loop.id)}`, { claims: w.claimsA }), '0');
  // A successful launch clears last_error.
  ok(`update public.loops set next_run_at = ${past} where entity_id = ${uuid(loop.id)}`, { url: OWNER_URL });
  const claim5 = json(`select public.loop_run_claim(${uuid(loop.id)}, now(), 'schedule', '{}'::uuid[], now() + interval '1 hour')`, { claims: worker });
  json(`select public.loop_run_launched(${uuid(claim5.runId)}, ${uuid(w.taskA)}, null)`, { claims: worker });
  assert.equal(scalar(`select coalesce(last_error, '<null>') from public.loops where entity_id = ${uuid(loop.id)}`, { claims: w.claimsA }), '<null>');

  // SCHEDULE INVALID: a 'skipped'/'schedule_invalid' row, the loop parked with the reason, still enabled.
  ok(`update public.loops set next_run_at = ${past} where entity_id = ${uuid(loop.id)}`, { url: OWNER_URL });
  json(`select public.loop_run_settle(${uuid(claim5.runId)}, 'completed')`, { claims: worker });
  const parked = json(`select public.loop_run_claim(${uuid(loop.id)}, now(), 'schedule', '{}'::uuid[], null, 'schedule "0 0 30 2 *" never matches')`, { claims: worker });
  assert.equal(parked.skipReason, 'schedule_invalid');
  assert.deepEqual(
    rows(`select enabled, next_run_at is null parked, last_error from public.loops where entity_id = ${uuid(loop.id)}`, { claims: w.claimsA }),
    [{ enabled: true, parked: true, last_error: 'schedule "0 0 30 2 *" never matches' }]);

  // The sweep read is the worker's and lists only open firings.
  assert.deepEqual(rows(`select run_id from public.loop_runs_open_for_executor(now())`, { claims: w.claimsA }), []);
  const open = rows(`select run_id, act_as_identity from public.loop_runs_open_for_executor(now())`, { claims: worker });
  assert.ok(!open.some((row) => row.run_id === claim1.runId), 'a settled run is not open');
  assert.ok(open.every((row) => row.act_as_identity), 'every open run names who can stop it');

  // Orphan parking: a space whose only member has left is parked with a reason, once, and is no longer claimable.
  const orphanHuman = { ...w.claimsB, 'tm8.auth_kind': 'browser' };
  const orphan = json(
    `select public.create_loop(${uuid(w.spaceB)}, 'Orphan', null, 'every 1h', null, p_next_run_at => ${past},
       p_client_mutation_id => ${literal(cmid('loop-382-orphan'))})`,
    { claims: orphanHuman },
  ).entity;
  ok(`update public.members set status = 'removed', left_at = now() where space_id = ${uuid(w.spaceB)}`, { url: OWNER_URL });
  assert.ok(!rows(`select entity_id from public.loops_claimable(25, now())`, { claims: worker }).some((row) => row.entity_id === orphan.id));
  const parkedOrphans = rows(`select entity_id from public.loops_park_orphans(now())`, { claims: worker });
  assert.deepEqual(parkedOrphans, [{ entity_id: orphan.id }]);
  assert.deepEqual(rows(`select entity_id from public.loops_park_orphans(now())`, { claims: worker }), [], 'parking is idempotent');
  assert.match(scalar(`select last_error from public.loops where entity_id = ${uuid(orphan.id)}`, { url: OWNER_URL }), /needs arming/);
  ok(`update public.members set status = 'active', left_at = null where space_id = ${uuid(w.spaceB)}`, { url: OWNER_URL });
});
