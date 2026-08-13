// =============================================================================
// 114 — member roles, invite roles, and the claim-free invite preview.
//
// These run AS tm8_app with claims bound the way tm8-server binds them, which
// is the only way any of this proves anything: `set_member_role` is SECURITY
// DEFINER, so its `require_space_admin` guard IS the protection, and a suite
// that called it as the superuser would pass while the guard was commented out.
//
// The four rules from the migration header, one describe block each:
//   R1  only a space admin may change any role
//   R2  only an owner may grant or revoke the owner role
//   R3  the last owner cannot be demoted
//   R4  an invite cannot mint an owner
// plus the two properties that are easy to write and easy to get wrong:
// idempotency on an already-set role, and what `preview_invite` refuses to say.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorld,
  claimsFor,
  cmid,
  denied,
  json,
  literal,
  ok,
  rootClaims,
  scalar,
  uuid,
} from './helpers.mjs';

const w = buildWorld('roles');

/** Seat a fresh human in space A at a chosen role, via an invite that says so. */
function seat(tag, role) {
  const identity = `identity-roles-${tag}`;
  json(
    `select public.ensure_account(${literal(identity)}, ${literal(`roles-${tag}`)}, ` +
      `${literal(`Seat ${tag}`)}, null, false, false)`,
    { claims: rootClaims() },
  );
  const invite = json(
    `select public.create_invite(${uuid(w.spaceA)}, 1, null, null, ${literal(cmid(tag))}, ${literal(role)})`,
    { claims: w.claimsA },
  ).invite;
  const memberId = json(`select public.redeem_invite(${literal(invite.code)})`, {
    claims: claimsFor(identity),
  }).memberId;
  return { identity, memberId, claims: claimsFor(identity, memberId), code: invite.code };
}

function roleOf(memberId) {
  return scalar(`select role from public.members where entity_id = ${uuid(memberId)}`, {
    claims: w.claimsA,
  });
}

// ---------------------------------------------------------------------------
// R4 first, because the other blocks seat their people with it.
// ---------------------------------------------------------------------------
test('R4: an invite confers the role it names — and never owner', () => {
  const asAdmin = seat('r4-admin', 'admin');
  assert.equal(roleOf(asAdmin.memberId), 'admin',
    'redeem_invite must attach with the invite\'s role, not the old hardcoded member');

  const asMember = seat('r4-member', 'member');
  assert.equal(roleOf(asMember.memberId), 'member');

  denied(
    'create_invite: an invite may not confer ownership (R4)',
    `select public.create_invite(${uuid(w.spaceA)}, 1, null, null, ${literal(cmid('r4-owner'))}, 'owner')`,
    { claims: w.claimsA, expect: '22023' },
  );

  // The refusal is a refusal, not a silent downgrade to member: nothing was
  // written. A downgrade would leave the caller believing they had issued an
  // owner invite, which is the exact misunderstanding the raise exists to end.
  assert.equal(
    Number(scalar(`select count(*) from public.space_invites where space_id = ${uuid(w.spaceA)} and role = 'owner'`,
      { claims: w.claimsA })),
    0,
  );
});

test('a pre-114 invite still means member: the column default is the value those rows already had', () => {
  // Simulated by writing the row the old code wrote — no role argument at all.
  const invite = json(
    `select public.create_invite(${uuid(w.spaceA)}, 1, null, null, ${literal(cmid('legacy'))})`,
    { claims: w.claimsA },
  ).invite;
  assert.equal(invite.role, 'member');
});

// ---------------------------------------------------------------------------
// R1 — only a space admin may change any role.
// ---------------------------------------------------------------------------
test('R1: a plain member cannot change anybody\'s role, including their own', () => {
  const plain = seat('r1-plain', 'member');
  const other = seat('r1-other', 'member');

  denied(
    'set_member_role: a member promoting themselves',
    `select public.set_member_role(${uuid(w.spaceA)}, ${uuid(plain.memberId)}, 'admin', null, ${literal(cmid('r1a'))})`,
    { claims: plain.claims, expect: '42501' },
  );
  denied(
    'set_member_role: a member demoting somebody else',
    `select public.set_member_role(${uuid(w.spaceA)}, ${uuid(other.memberId)}, 'member', null, ${literal(cmid('r1b'))})`,
    { claims: plain.claims, expect: '42501' },
  );
  assert.equal(roleOf(plain.memberId), 'member');
});

test('R1: a non-member of the space is refused, and is not told the member exists', () => {
  const target = seat('r1-target', 'member');
  // identityB owns space B and has never been in space A.
  denied(
    'set_member_role: a stranger to this space',
    `select public.set_member_role(${uuid(w.spaceA)}, ${uuid(target.memberId)}, 'admin', null, ${literal(cmid('r1c'))})`,
    { claims: claimsFor(w.identityB), expect: '42501' },
  );
});

test('R1: an admin can promote and demote below the owner line', () => {
  const admin = seat('r1-admin', 'admin');
  const target = seat('r1-movable', 'member');

  ok(`select public.set_member_role(${uuid(w.spaceA)}, ${uuid(target.memberId)}, 'admin', null, ${literal(cmid('r1d'))})`,
    { claims: admin.claims });
  assert.equal(roleOf(target.memberId), 'admin');

  ok(`select public.set_member_role(${uuid(w.spaceA)}, ${uuid(target.memberId)}, 'member', null, ${literal(cmid('r1e'))})`,
    { claims: admin.claims });
  assert.equal(roleOf(target.memberId), 'member');
});

test('a member id from another space is "not found here", never found-and-updated', () => {
  // memberB is a real member row — of space B. Naming space A must not reach it.
  denied(
    'set_member_role: cross-space member id',
    `select public.set_member_role(${uuid(w.spaceA)}, ${uuid(w.memberB)}, 'admin', null, ${literal(cmid('cross'))})`,
    { claims: w.claimsA, expect: 'P0002' },
  );
  // Read back as B: A is not a member of space B, so under A's claims the row
  // is invisible and a read would prove nothing either way.
  assert.equal(
    scalar(`select role from public.members where entity_id = ${uuid(w.memberB)}`, { claims: w.claimsB }),
    'owner',
    'the space-B owner must be untouched',
  );
});

test('an unknown role word is refused before anything is written', () => {
  const target = seat('bad-role', 'member');
  denied(
    'set_member_role: a role the schema does not have',
    `select public.set_member_role(${uuid(w.spaceA)}, ${uuid(target.memberId)}, 'viewer', null, ${literal(cmid('viewer'))})`,
    { claims: w.claimsA, expect: '22023' },
  );
  assert.equal(roleOf(target.memberId), 'member');
});

// ---------------------------------------------------------------------------
// R2 — only an owner may grant or revoke the owner role.
// ---------------------------------------------------------------------------
test('R2: an admin cannot mint an owner', () => {
  const admin = seat('r2-admin', 'admin');
  const target = seat('r2-target', 'member');

  denied(
    'set_member_role: admin granting ownership',
    `select public.set_member_role(${uuid(w.spaceA)}, ${uuid(target.memberId)}, 'owner', null, ${literal(cmid('r2a'))})`,
    { claims: admin.claims, expect: '42501' },
  );
  assert.equal(roleOf(target.memberId), 'member');
});

test('R2: an admin cannot demote an owner — not even to admin', () => {
  const admin = seat('r2-admin2', 'admin');
  denied(
    'set_member_role: admin revoking ownership',
    `select public.set_member_role(${uuid(w.spaceA)}, ${uuid(w.memberA)}, 'admin', null, ${literal(cmid('r2b'))})`,
    { claims: admin.claims, expect: '42501' },
  );
  assert.equal(roleOf(w.memberA), 'owner');
});

test('R2/R3: ownership transfers in two deliberate steps, and both are legal', () => {
  const successor = seat('r2-successor', 'admin');

  // Step 1 — the owner promotes. Now there are two owners.
  ok(`select public.set_member_role(${uuid(w.spaceA)}, ${uuid(successor.memberId)}, 'owner', null, ${literal(cmid('r2c'))})`,
    { claims: w.claimsA });
  assert.equal(roleOf(successor.memberId), 'owner');

  // Step 2 — the original owner steps down. Legal only because step 1 happened;
  // R3 would have refused this same call one moment earlier.
  ok(`select public.set_member_role(${uuid(w.spaceA)}, ${uuid(w.memberA)}, 'admin', null, ${literal(cmid('r2d'))})`,
    { claims: w.claimsA });
  assert.equal(roleOf(w.memberA), 'admin');

  // Put the world back the way the other tests expect it, using the new owner's
  // authority — which is itself the proof that the transfer really transferred.
  ok(`select public.set_member_role(${uuid(w.spaceA)}, ${uuid(w.memberA)}, 'owner', null, ${literal(cmid('r2e'))})`,
    { claims: successor.claims });
  ok(`select public.set_member_role(${uuid(w.spaceA)}, ${uuid(successor.memberId)}, 'admin', null, ${literal(cmid('r2f'))})`,
    { claims: w.claimsA });
  assert.equal(roleOf(w.memberA), 'owner');
  assert.equal(roleOf(successor.memberId), 'admin');
});

// ---------------------------------------------------------------------------
// R3 — the last owner cannot be demoted.
// ---------------------------------------------------------------------------
test('R3: the sole owner cannot demote themselves, and the space keeps its owner', () => {
  assert.equal(
    Number(scalar(`select count(*) from public.members where space_id = ${uuid(w.spaceA)} and role = 'owner'`,
      { claims: w.claimsA })),
    1,
    'precondition: space A has exactly one owner',
  );

  denied(
    'set_member_role: demoting the last owner',
    `select public.set_member_role(${uuid(w.spaceA)}, ${uuid(w.memberA)}, 'admin', null, ${literal(cmid('r3a'))})`,
    { claims: w.claimsA, expect: '42501' },
  );
  assert.equal(roleOf(w.memberA), 'owner');
});

// ---------------------------------------------------------------------------
// Idempotency.
// ---------------------------------------------------------------------------
test('setting the role a member already has succeeds and returns the member', () => {
  const target = seat('idem', 'admin');
  const result = json(
    `select public.set_member_role(${uuid(w.spaceA)}, ${uuid(target.memberId)}, 'admin', null, ${literal(cmid('idem1'))})`,
    { claims: w.claimsA },
  );
  assert.equal(result.entity.id, target.memberId);
  assert.equal(roleOf(target.memberId), 'admin');
});

test('a replayed clientMutationId returns the recorded result instead of acting twice', () => {
  const target = seat('replay', 'member');
  const id = cmid('replay');
  const first = json(
    `select public.set_member_role(${uuid(w.spaceA)}, ${uuid(target.memberId)}, 'admin', null, ${literal(id)})`,
    { claims: w.claimsA },
  );
  // Demote out of band so a re-execution would be visible in the row.
  ok(`select public.set_member_role(${uuid(w.spaceA)}, ${uuid(target.memberId)}, 'member', null, ${literal(cmid('replay-x'))})`,
    { claims: w.claimsA });

  const replayed = json(
    `select public.set_member_role(${uuid(w.spaceA)}, ${uuid(target.memberId)}, 'admin', null, ${literal(id)})`,
    { claims: w.claimsA },
  );
  assert.equal(replayed.entity.id, first.entity.id);
  assert.equal(roleOf(target.memberId), 'member',
    'the replay must NOT have re-run the promotion');
});

test('a replayed clientMutationId cannot be redeemed by a different principal', () => {
  const admin = seat('replay-admin', 'admin');
  const target = seat('replay-victim', 'member');
  const id = cmid('replay-pin');
  ok(`select public.set_member_role(${uuid(w.spaceA)}, ${uuid(target.memberId)}, 'admin', null, ${literal(id)})`,
    { claims: w.claimsA });

  // 23514, not 42501: `internal.require_replay_principal` (031:190) raises a
  // check_violation for the pin, and this suite asserts the code the sec1
  // program actually standardised on rather than the one a permission failure
  // would use.
  denied(
    'set_member_role: cross-principal replay of a recorded cmid',
    `select public.set_member_role(${uuid(w.spaceA)}, ${uuid(target.memberId)}, 'admin', null, ${literal(id)})`,
    { claims: admin.claims, expect: '23514' },
  );
});

// ---------------------------------------------------------------------------
// preview_invite — the claim-free read.
// ---------------------------------------------------------------------------
test('preview_invite answers a live code without any identity claim at all', () => {
  const invite = json(
    `select public.create_invite(${uuid(w.spaceA)}, 3, null, null, ${literal(cmid('prev'))}, 'admin')`,
    { claims: w.claimsA },
  ).invite;

  // No claims object: this is exactly the state a join page is in.
  const preview = json(`select public.preview_invite(${literal(invite.code)})`);
  assert.equal(preview.status, 'valid');
  assert.equal(preview.spaceId, w.spaceA);
  assert.equal(preview.spaceName, 'Space A');
  assert.equal(preview.role, 'admin');
  assert.equal(preview.invitedBy, 'Owner A');
});

test('preview_invite discloses NOTHING for a code that resolves to nothing', () => {
  const preview = json(`select public.preview_invite('inv_definitely-not-a-real-code')`);
  assert.deepEqual(preview, { status: 'unknown' },
    'an unknown code must not leak a space, an inviter, or a hint that some other code would work');
});

test('preview_invite names the death and the space, but not the inviter', () => {
  const invite = json(
    `select public.create_invite(${uuid(w.spaceA)}, 1, null, null, ${literal(cmid('prev-dead'))})`,
    { claims: w.claimsA },
  ).invite;
  const inviteId = invite.id;
  ok(`select public.w2_revoke_invite(${uuid(w.spaceA)}, ${uuid(inviteId)}, ${literal(cmid('prev-revoke'))})`,
    { claims: w.claimsA });

  const preview = json(`select public.preview_invite(${literal(invite.code)})`);
  assert.equal(preview.status, 'revoked');
  assert.equal(preview.spaceName, 'Space A',
    'the holder was legitimately given this code — naming the space is what makes the refusal actionable');
  assert.equal(preview.invitedBy, undefined, 'a dead link must not name the inviter');
  assert.equal(preview.spaceId, undefined, 'a dead link must not hand out an addressable space id');
});

test('preview_invite reports an exhausted code as exhausted, not as valid', () => {
  const identity = 'identity-roles-exhaust';
  json(`select public.ensure_account(${literal(identity)}, 'roles-exhaust', 'Exhauster', null, false, false)`,
    { claims: rootClaims() });
  const invite = json(
    `select public.create_invite(${uuid(w.spaceA)}, 1, null, null, ${literal(cmid('prev-exh'))})`,
    { claims: w.claimsA },
  ).invite;
  json(`select public.redeem_invite(${literal(invite.code)})`, { claims: claimsFor(identity) });

  const preview = json(`select public.preview_invite(${literal(invite.code)})`);
  assert.equal(preview.status, 'exhausted');
});
