// =============================================================================
// RLS NEGATIVES — what the policies REFUSE.
//
// A suite that only proves the happy path proves nothing about RLS: a policy of
// `using (true)` passes every positive test ever written. So every assertion here
// names a caller who must be refused, and the two shapes refusal takes are kept
// distinct on purpose:
//
//   invisible(...)  a SELECT policy does not raise — it returns nothing.
//   denied(...)     a write RPC's guard raises 42501/28000.
//
// The cast:
//   A  owner of PRIVATE space A, node admin
//   B  owner of PUBLIC space B, NOT a node admin, shares no space with A
//   C  a plain (non-admin) MEMBER of space A — the caller who is inside the space
//      but must still be refused everything personal or administrative
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_URL,
  buildWorld,
  claimsFor,
  cmid,
  denied,
  invisible,
  json,
  literal,
  ok,
  rootClaims,
  scalar,
  uuid,
  visible,
} from './helpers.mjs';

const w = buildWorld('rls');

// --- C: inside space A, but plain ------------------------------------------
const identityC = 'identity-rls-c';
json(`select public.ensure_account(${literal(identityC)}, 'rls-c', 'Plain C', null, false, false)`, {
  claims: rootClaims(),
});
const invite = json(
  `select public.create_invite(${uuid(w.spaceA)}, 5)`,
  { claims: w.claimsA },
).invite;
const joined = json(`select public.redeem_invite(${literal(invite.code)})`, {
  claims: claimsFor(identityC),
});
const memberC = joined.memberId;
const claimsC = claimsFor(identityC, memberC);

// A message and a read mark in space A, so the personal-scope policies have
// something real to hide.
const messageA = json(
  `select public.post_message(${uuid(w.channelA)}, 'private to space A')`,
  { claims: w.claimsA },
).entity.id;
ok(`select public.mark_read(${uuid(w.channelA)})`, { claims: w.claimsA });

// -----------------------------------------------------------------------------
// 1. Cross-tenant: B shares no space with A and must see none of it.
// -----------------------------------------------------------------------------
test('entities_select: a non-member sees none of a private space\'s entities', () => {
  invisible(
    'entities_select: identity B (not a member of space A) reading space A entities',
    `select count(*) from public.entities where space_id = ${uuid(w.spaceA)}`,
    { claims: w.claimsB },
  );
  invisible(
    'entities_select: identity B reading space A\'s task by id',
    `select count(*) from public.entities where id = ${uuid(w.taskA)}`,
    { claims: w.claimsB },
  );
  // ...and the control: A does see them, so the zeros above are RLS and not an
  // empty table.
  assert.ok(
    Number(
      scalar(`select count(*) from public.entities where space_id = ${uuid(w.spaceA)}`, {
        claims: w.claimsA,
      }),
    ) >= 4,
    'control: A must see its own space, otherwise the negatives above are vacuous',
  );
});

test('detail tables inherit the envelope: a non-member sees no task, channel, persona or message row', () => {
  const asB = { claims: w.claimsB };
  invisible('tasks_select: identity B reading space A\'s task detail', `select count(*) from public.tasks where entity_id = ${uuid(w.taskA)}`, asB);
  invisible('channels_select: identity B reading space A\'s channel', `select count(*) from public.channels where entity_id = ${uuid(w.channelA)}`, asB);
  invisible('team_members_select: identity B reading space A\'s persona', `select count(*) from public.team_members where entity_id = ${uuid(w.personaA)}`, asB);
  invisible('messages_select: identity B reading a message in space A', `select count(*) from public.messages where entity_id = ${uuid(messageA)}`, asB);
  invisible('members_select: identity B reading space A\'s member list', `select count(*) from public.members where space_id = ${uuid(w.spaceA)}`, asB);
  invisible('edges_select: identity B reading space A\'s edges', `select count(*) from public.edges where space_id = ${uuid(w.spaceA)}`, asB);
  invisible('activity_select: identity B reading space A\'s activity feed', `select count(*) from public.activity where space_id = ${uuid(w.spaceA)}`, asB);
  invisible('task_axes_select: identity B reading space A\'s task axes', `select count(*) from public.task_axes where space_id = ${uuid(w.spaceA)}`, asB);
  invisible('point_events_select: identity B reading space A\'s points ledger', `select count(*) from public.point_events where space_id = ${uuid(w.spaceA)}`, asB);
  invisible('entity_counters_select: identity B reading space A\'s counters', `select count(*) from public.entity_counters where entity_id = ${uuid(w.taskA)}`, asB);
  invisible('entity_versions_select: identity B reading space A\'s version history', `select count(*) from public.entity_versions where entity_id = ${uuid(w.taskA)}`, asB);
});

test('spaces_select: a private space is invisible to non-members; a public one is discoverable', () => {
  invisible(
    'spaces_select: identity B reading PRIVATE space A',
    `select count(*) from public.spaces where id = ${uuid(w.spaceA)}`,
    { claims: w.claimsB },
  );
  // Public spaces are deliberately discoverable by any authenticated identity —
  // that is the policy doing the honest thing rather than an RPC working around it.
  visible(
    'spaces_select: identity A discovering PUBLIC space B without being a member',
    `select count(*) from public.spaces where id = ${uuid(w.spaceB)}`,
    1,
    { claims: w.claimsA },
  );
  // Discoverable is not joined: A is not a member, so the CONTENTS stay hidden.
  invisible(
    'entities_select: identity A reading entities of the public space B it has not joined',
    `select count(*) from public.entities where space_id = ${uuid(w.spaceB)}`,
    { claims: w.claimsA },
  );
});

test('user_profiles_select: profiles are visible only to people you share a space with', () => {
  invisible(
    'user_profiles_select: identity B reading A\'s profile (no shared space)',
    `select count(*) from public.user_profiles where identity_id = ${literal(w.identityA)}`,
    { claims: w.claimsB },
  );
  visible(
    'user_profiles_select: identity C reading A\'s profile (shares space A)',
    `select count(*) from public.user_profiles where identity_id = ${literal(w.identityA)}`,
    1,
    { claims: claimsC },
  );
  visible(
    'user_profiles_select: every identity can read its own profile',
    `select count(*) from public.user_profiles where identity_id = ${literal(w.identityB)}`,
    1,
    { claims: w.claimsB },
  );
});

test('projects_select: a project is visible only through a linked space, or to a node admin', () => {
  invisible(
    'projects_select: identity B — not a node admin, not in any space the project is linked to',
    `select count(*) from public.projects where id = ${uuid(w.projectId)}`,
    { claims: w.claimsB },
  );
  visible(
    'projects_select: identity C sees it because space A (which C is in) links it',
    `select count(*) from public.projects where id = ${uuid(w.projectId)}`,
    1,
    { claims: claimsC },
  );
  invisible(
    'space_projects_select: identity B reading space A\'s project links',
    `select count(*) from public.space_projects where space_id = ${uuid(w.spaceA)}`,
    { claims: w.claimsB },
  );
});

// -----------------------------------------------------------------------------
// 2. Inside the space, but not entitled: C is a member of A and still refused.
// -----------------------------------------------------------------------------
test('space_invites_select: invite CODES are credentials — admins only, not every member', () => {
  invisible(
    'space_invites_select: identity C is a MEMBER of space A but not an admin',
    `select count(*) from public.space_invites where space_id = ${uuid(w.spaceA)}`,
    { claims: claimsC },
  );
  visible(
    'space_invites_select: identity A is the space owner',
    `select count(*) from public.space_invites where space_id = ${uuid(w.spaceA)}`,
    1,
    { claims: w.claimsA },
  );
});

test('read_marks_select / notifications_select: personal rows are not space rows', () => {
  invisible(
    'read_marks_select: identity C reading A\'s read marks',
    `select count(*) from public.read_marks where member_id = ${uuid(w.memberA)}`,
    { claims: claimsC },
  );
  visible(
    'read_marks_select: A reading its own read marks',
    `select count(*) from public.read_marks where member_id = ${uuid(w.memberA)}`,
    1,
    { claims: w.claimsA },
  );

  // C's own join produced a notification addressed to A (the invite's creator).
  assert.ok(
    Number(
      scalar(`select count(*) from public.notifications where recipient_member_id = ${uuid(w.memberA)}`, {
        claims: w.claimsA,
      }),
    ) >= 1,
    'control: A should have been notified about the join',
  );
  invisible(
    'notifications_select: identity C reading A\'s inbox',
    `select count(*) from public.notifications where recipient_member_id = ${uuid(w.memberA)}`,
    { claims: claimsC },
  );
});

test('workspace_events_select: the space feed is shared, the targeted feed is not', () => {
  const targetedAsA = Number(
    scalar(
      `select count(*) from public.workspace_events
        where space_id = ${uuid(w.spaceA)} and recipient_member_id = ${uuid(w.memberA)}`,
      { claims: w.claimsA },
    ),
  );
  assert.ok(targetedAsA >= 1, 'control: A must have at least one targeted event');

  invisible(
    'workspace_events_select: identity C reading events TARGETED at A (this is Sirius\'s poll surface)',
    `select count(*) from public.workspace_events
      where space_id = ${uuid(w.spaceA)} and recipient_member_id = ${uuid(w.memberA)}`,
    { claims: claimsC },
  );
  // The shared half still works, or the split would be useless.
  assert.ok(
    Number(
      scalar(
        `select count(*) from public.workspace_events
          where space_id = ${uuid(w.spaceA)} and recipient_member_id is null`,
        { claims: claimsC },
      ),
    ) >= 1,
    'control: C must see the space feed it is entitled to',
  );
  invisible(
    'workspace_events_select: identity B reading space A\'s event log at all',
    `select count(*) from public.workspace_events where space_id = ${uuid(w.spaceA)}`,
    { claims: w.claimsB },
  );
});

test('entity_kinds_select: core kinds are global reference data, custom kinds are not', () => {
  assert.ok(
    Number(scalar(`select count(*) from public.entity_kinds where space_id is null`, { claims: w.claimsB })) >= 13,
    'control: core kinds are readable by any authenticated identity',
  );
  // There is no custom-kind RPC yet (post-loop scope), so the row goes in through
  // the OWNER connection. The POLICY is what is under test here, not the writer.
  ok(
    `insert into public.entity_kinds(kind, origin, space_id) values ('c:rls_probe', 'custom', ${uuid(w.spaceA)})`,
    { url: OWNER_URL },
  );
  invisible(
    'entity_kinds_select: identity B reading space A\'s custom kind',
    `select count(*) from public.entity_kinds where kind = 'c:rls_probe'`,
    { claims: w.claimsB },
  );
  visible(
    'entity_kinds_select: identity C reading space A\'s custom kind (member of that space)',
    `select count(*) from public.entity_kinds where kind = 'c:rls_probe'`,
    1,
    { claims: claimsC },
  );
});

// -----------------------------------------------------------------------------
// 3. Write guards: require_space_member / require_space_admin / require_node_admin.
// -----------------------------------------------------------------------------
test('require_space_member: a non-member cannot write into a space by any RPC on the loop', () => {
  const asB = { claims: w.claimsB, expect: '42501' };
  denied('create_task/require_space_member: identity B into space A', `select public.create_task(${uuid(w.spaceA)}, 'intruder task')`, asB);
  denied('create_document/require_space_member: identity B into space A', `select public.create_document(${uuid(w.spaceA)}, 'intruder doc')`, asB);
  denied('post_message/require_space_member: identity B into space A\'s channel', `select public.post_message(${uuid(w.channelA)}, 'intruder')`, asB);
  denied('set_work_state/require_space_member: identity B on space A\'s task', `select public.set_work_state(${uuid(w.taskA)}, 'working')`, asB);
  denied('complete_task/require_space_member: identity B on space A\'s task', `select public.complete_task(${uuid(w.taskA)}, 1)`, asB);
  denied('mark_read/require_space_member: identity B on space A\'s channel', `select public.mark_read(${uuid(w.channelA)})`, asB);
  denied('create_team_member/require_space_member: identity B into space A', `select public.create_team_member(${uuid(w.spaceA)}, 'intruder-bot')`, asB);
  denied(
    'execution_spawn/require_space_member: identity B spawning into space A',
    `select public.execution_spawn(${uuid(w.spaceA)}, ${uuid(w.personaA)})`,
    asB,
  );
  denied(
    'current_space_identity/require_space_member: identity B asking about space A',
    `select public.current_space_identity(${uuid(w.spaceA)})`,
    asB,
  );

  // Nothing landed.
  assert.equal(
    scalar(`select count(*) from public.tasks where title = 'intruder task'`, { claims: w.claimsA }),
    '0',
    'a refused create_task must not have written a row',
  );
});

test('require_space_admin: a plain member cannot administer the space it belongs to', () => {
  const asC = { claims: claimsC, expect: '42501' };
  denied('update_space/require_space_admin: identity C (plain member)', `select public.update_space(${uuid(w.spaceA)}, 'Renamed by C')`, asC);
  denied('create_invite/require_space_admin: identity C (plain member)', `select public.create_invite(${uuid(w.spaceA)})`, asC);
  denied(
    'link_project/require_space_admin: identity C (plain member)',
    `select public.link_project(${uuid(w.spaceA)}, ${uuid(w.projectId)})`,
    asC,
  );
  denied('create_task_axis/require_space_admin: identity C (plain member)', `select public.create_task_axis(${uuid(w.spaceA)}, 'sneaky')`, asC);
  assert.equal(
    scalar(`select name from public.spaces where id = ${uuid(w.spaceA)}`, { claims: w.claimsA }),
    'Space A',
    'a refused update_space must not have renamed the space',
  );
});

test('require_node_admin: the project registry is node-level, and a space owner is not a node admin', () => {
  // B owns space B outright and is still refused — space authority and node
  // authority are different axes on purpose.
  denied(
    'create_project/require_node_admin: identity B (owns its own space, not a node admin)',
    `select public.create_project('b-project', '/tmp/tm8-rls-b')`,
    { claims: w.claimsB, expect: '42501' },
  );
  denied(
    'update_project/require_node_admin: identity C',
    `select public.update_project(${uuid(w.projectId)}, 'renamed')`,
    { claims: claimsC, expect: '42501' },
  );
  denied(
    'prune_auth_sessions/require_node_admin: identity C',
    `select public.prune_auth_sessions()`,
    { claims: claimsC, expect: '42501' },
  );
});

// -----------------------------------------------------------------------------
// 4. can_act_as — the authorship boundary. This is the one an attacker wants:
//    not "read someone's data" but "write in someone's name".
// -----------------------------------------------------------------------------
test('can_act_as: an identity cannot author as another actor, even inside its own space', () => {
  denied(
    'resolve_actor/can_act_as: identity C posting AS member A in space A',
    `select public.post_message(${uuid(w.channelA)}, 'forged', ${uuid(w.memberA)})`,
    { claims: claimsC, expect: '42501' },
  );
  denied(
    'resolve_actor/can_act_as: identity C creating a task attributed to member A',
    `select public.create_task(${uuid(w.spaceA)}, 'forged task', ${uuid(w.memberA)})`,
    { claims: claimsC, expect: '42501' },
  );
  denied(
    'resolve_actor/can_act_as: identity A authoring as member B (a member of a different space)',
    `select public.create_task(${uuid(w.spaceA)}, 'cross-space actor', ${uuid(w.memberB)})`,
    { claims: w.claimsA, expect: '42501' },
  );
});

test('can_act_as: the tm8.actor_id CLAIM is not authority — a forged one is refused', () => {
  // The whole point of the ratified claims contract: RLS and the write guards
  // resolve can_act_as from the TABLES, so a caller that lies in its claim gains
  // nothing. Identity C, asserting it is member A:
  denied(
    'resolve_actor/can_act_as: identity C with a FORGED tm8.actor_id = member A',
    `select public.post_message(${uuid(w.channelA)}, 'forged via claim')`,
    { claims: claimsFor(identityC, w.memberA), expect: '42501' },
  );
  denied(
    'resolve_actor/can_act_as: identity B with a FORGED tm8.actor_id = member A',
    `select public.create_task(${uuid(w.spaceA)}, 'forged via claim')`,
    { claims: claimsFor(w.identityB, w.memberA), expect: '42501' },
  );
  assert.equal(
    scalar(`select count(*) from public.messages where body like 'forged%'`, { claims: w.claimsA }),
    '0',
    'no forged message may exist',
  );
});

test('can_act_as: a persona may only be driven by the member who owns it', () => {
  denied(
    'execution_spawn/can_act_as: identity C spawning A\'s persona (C is a member of the space)',
    `select public.execution_spawn(${uuid(w.spaceA)}, ${uuid(w.personaA)}, '{}'::uuid[], null,
       'project', null, null, null, null, null, 'nope', null, true, 32)`,
    { claims: claimsC, expect: '42501' },
  );
  denied(
    'resolve_actor/can_act_as: identity C posting AS A\'s persona',
    `select public.post_message(${uuid(w.channelA)}, 'speaking as another agent', ${uuid(w.personaA)})`,
    { claims: claimsC, expect: '42501' },
  );
  // The positive that gives the negatives meaning: A may author as its OWN persona.
  const asPersona = json(
    `select public.post_message(${uuid(w.channelA)}, 'agent speaking', ${uuid(w.personaA)},
       null, '[]'::jsonb, '[]'::jsonb, ${literal(cmid('rls-persona'))})`,
    { claims: w.claimsA },
  );
  assert.equal(
    scalar(`select author_id from public.messages where entity_id = ${uuid(asPersona.entity.id)}`, {
      claims: w.claimsA,
    }),
    w.personaA,
    'A must be able to author as the persona it owns',
  );
});

test('message authorship: only the author may edit, and a space admin may redact but never rewrite', () => {
  denied(
    'edit_message: identity C editing A\'s message',
    `select public.edit_message(${uuid(messageA)}, 'rewritten by C')`,
    { claims: claimsC, expect: '42501' },
  );
  assert.equal(
    scalar(`select body from public.messages where entity_id = ${uuid(messageA)}`, { claims: w.claimsA }),
    'private to space A',
    'a refused edit must not have changed the body',
  );

  // C's own message: C may redact it, and A (space owner) may too — but neither
  // gets to rewrite somebody else's words.
  const cMessage = json(`select public.post_message(${uuid(w.channelA)}, 'C was here')`, {
    claims: claimsC,
  }).entity.id;
  ok(`select public.redact_message(${uuid(cMessage)})`, { claims: w.claimsA });
  assert.equal(
    scalar(`select body from public.messages where entity_id = ${uuid(cMessage)}`, { claims: w.claimsA }),
    '[redacted]',
    'a space admin may redact',
  );
});
