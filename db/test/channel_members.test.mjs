// =============================================================================
// Channel members — the `has_member` edge registered by 080_channel_members.sql.
//
// Task 019fdbfe-214b-727d-89aa-f009f52349bc.
//
// WHY THESE ASSERTIONS AND NOT A UNIT TEST. Every property proven here lives in
// plpgsql — internal.validate_edge's kind check (001:794-805), the
// (src_id, dst_id, type) uniqueness at 001:772, and
// internal.validate_edge_props_schema's per-property type check (018:113).
// A FakeDb cannot see any of them, so a unit test asserting "a double-add is
// idempotent" would be asserting its own fake. The design doc says as much in
// its acceptance criterion 5.
//
// RED-FIRST RECORD — MEASURED, and the first measurement corrected the file.
//
// Run 1, against a database migrated to 077 (everything except 080), with the
// two negative tests written as `denied(..., { expect: '23514' })`:
//     tests 6 | pass 2 | fail 4
// I had predicted 6/6 red. The two negatives PASSED WITHOUT THE MIGRATION,
// because validate_edge raises 23514 for "unregistered edge types must be
// namespaced x:*" (001:804) just as it does for "rejects source kind"
// (001:798). They were asserting a SQLSTATE that the absence of the feature
// produces just as readily as its presence — green for the wrong reason, and
// worth nothing as evidence.
//
// So both negatives now assert on the MESSAGE via expectFailure. Run 2, same
// 077 database: tests 6 | pass 0 | fail 6. With 080 applied: 6 | pass 6.
// The prediction is not the record; the measurement is.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorld,
  cmid,
  expectFailure,
  json,
  literal,
  ok,
  scalar,
  uuid,
} from './helpers.mjs';

const w = buildWorld('chmem');

/** write_edge(src, dst, type, props, actor, cmid) — 018:145. */
function writeEdge(src, dst, type, props = {}) {
  return `select public.write_edge(${uuid(src)}, ${uuid(dst)}, ${literal(type)},
            ${literal(JSON.stringify(props))}::jsonb, ${uuid(w.memberA)},
            ${literal(cmid('chmem'))})`;
}

test('a channel takes a human member — the registered direction', () => {
  const result = json(writeEdge(w.channelA, w.memberA, 'has_member', { role: 'owner' }), {
    claims: w.claimsA,
  });
  assert.equal(result.edge.type, 'has_member');
  assert.equal(result.edge.src_id, w.channelA, 'src is the CHANNEL, not the person');
  assert.equal(result.edge.dst_id, w.memberA);
  assert.equal(result.edge.props.role, 'owner');
});

test('a channel takes a team_member too — an agent belongs like a person does', () => {
  // The channel summary already publishes workingAgentCount (contract.ts:109),
  // so a roster admitting only humans would contradict a badge that ships.
  const result = json(writeEdge(w.channelA, w.personaA, 'has_member', { role: 'member' }), {
    claims: w.claimsA,
  });
  assert.equal(result.edge.dst_id, w.personaA);
  assert.equal(result.edge.props.role, 'member');
});

test('THE DIRECTION IS ENFORCED: person -> channel is refused', () => {
  // This is the departure from CHANNEL-MEMBERS-DESIGN.md made concrete. The
  // design specified this direction; `attachInitialConnections` cannot produce
  // it (it hard-codes src = the created entity), so registering it would have
  // shipped a type the create path could never write.
  //
  // ASSERTED ON THE MESSAGE, NOT ONLY THE SQLSTATE, AND THAT IS THE POINT.
  // validate_edge raises 23514 for BOTH "rejects source kind" (001:798) and
  // "unregistered edge types must be namespaced x:*" (001:804). A bare
  // `expect: '23514'` therefore passes on a database WITHOUT 080 — measured, it
  // did — which makes it no evidence at all for the thing this test names.
  const { sqlstate, stderr } = expectFailure(writeEdge(w.memberA, w.channelA, 'has_member'), {
    claims: w.claimsA,
  });
  assert.equal(sqlstate, '23514');
  assert.match(
    stderr,
    /rejects source kind member/,
    'must fail because the SOURCE KIND is wrong, not because the type is unregistered',
  );
});

test('a channel cannot take a task as a member', () => {
  const { sqlstate, stderr } = expectFailure(writeEdge(w.channelA, w.taskA, 'has_member'), {
    claims: w.claimsA,
  });
  assert.equal(sqlstate, '23514');
  assert.match(stderr, /rejects destination kind task/);
});

test('a double-add is a no-op, not a second row — no new index needed for it', () => {
  // 001:772 already carries unique (src_id, dst_id, type). The design asked for
  // a partial unique index on (src_id, dst_id); it would duplicate this.
  const before = scalar(
    `select count(*) from public.edges
      where src_id = ${uuid(w.channelA)} and dst_id = ${uuid(w.memberA)} and type = 'has_member'`,
    { claims: w.claimsA },
  );
  assert.equal(before, '1', 'the first test already added this member exactly once');

  ok(writeEdge(w.channelA, w.memberA, 'has_member', { role: 'owner' }), { claims: w.claimsA });

  const after = scalar(
    `select count(*) from public.edges
      where src_id = ${uuid(w.channelA)} and dst_id = ${uuid(w.memberA)} and type = 'has_member'`,
    { claims: w.claimsA },
  );
  assert.equal(after, '1', 're-adding the same member must not create a second row');
});

test('props are type-checked, and `role` is a STRING — the registry cannot express an enum', () => {
  // 080 registers role as {"type":"string"} deliberately.
  // internal.validate_edge_props_schema (018:94-137) implements only `type`,
  // `required` and `additionalProperties`; edge_json_type_matches (018:62-88)
  // matches type NAMES. An {"enum": [...]} would be silently ignored, so the
  // owner/member vocabulary is advisory and this test says so out loud: a
  // nonsense STRING role is accepted by the database.
  ok(writeEdge(w.channelA, w.personaA, 'has_member', { role: 'not-a-real-role' }), {
    claims: w.claimsA,
  });

  // What IS enforced is the type. A non-string role is refused with 22023.
  const { sqlstate, stderr } = expectFailure(
    writeEdge(w.channelA, w.personaA, 'has_member', { role: 42 }),
    { claims: w.claimsA },
  );
  assert.equal(sqlstate, '22023');
  assert.match(stderr, /property role has the wrong type/);
});
