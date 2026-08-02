// =============================================================================
// 067 — display identity: user_profiles.global_id and update_identity_profile.
//
// The properties under test, in the order they matter:
//   1. the writer writes ONLY the caller's own row — the subject comes from the
//      bound claim and there is no parameter that can name anyone else;
//   2. current_identity keeps every field it returned before 067, plus globalId;
//   3. partial updates leave unspecified fields untouched;
//   4. the global_id shape constraint refuses malformed values;
//   5. the ledger makes a retry safe and a cross-principal replay refused;
//   6. round-trip: what the writer wrote is what identity.get reads back.
//
// global_id is a DISPLAY claim, never an authorization input (Identity v2 I6):
// nothing here grants, and no test may ever assert that it does.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorld,
  claimsFor,
  cmid,
  denied,
  expectFailure,
  json,
  literal,
  ok,
  scalar,
} from './helpers.mjs';

const w = buildWorld('idprof');

const GLOBAL_A = 'example-issuer:idprof-a-12345';

test('the writer upserts the CALLER\'S row and returns the camelCase view', () => {
  const result = json(
    `select public.update_identity_profile('Prof A', 'https://example.invalid/a.png',
       'a@example.invalid', ${literal(GLOBAL_A)}, ${literal(cmid('idprof-set-a'))})`,
    { claims: w.claimsA },
  );
  assert.deepEqual(result, {
    identityId: w.identityA,
    displayName: 'Prof A',
    avatar: 'https://example.invalid/a.png',
    email: 'a@example.invalid',
    globalId: GLOBAL_A,
  });

  const row = json(
    `select to_jsonb(p) from public.user_profiles p where identity_id = ${literal(w.identityA)}`,
    { claims: w.claimsA },
  );
  assert.equal(row.display_name, 'Prof A');
  assert.equal(row.global_id, GLOBAL_A);
});

test('current_identity keeps every pre-067 field and gains globalId', () => {
  const identity = json('select public.current_identity()', { claims: w.claimsA });
  // The exact pre-067 key set, plus globalId. A missing key here means a
  // shared function body lost an arm — the failure 067's header warns about.
  assert.deepEqual(Object.keys(identity).sort(), [
    'accountId', 'actingAs', 'avatar', 'displayName', 'email', 'globalId',
    'identityId', 'isNodeAdmin', 'isOwner', 'memberships', 'status', 'username',
  ]);
  assert.equal(identity.globalId, GLOBAL_A);
  assert.equal(identity.identityId, w.identityA);
  assert.ok(Array.isArray(identity.memberships) && identity.memberships.length >= 1);
});

test('a partial update writes only the provided fields', () => {
  json(
    `select public.update_identity_profile('Prof A renamed', null, null, null,
       ${literal(cmid('idprof-partial'))})`,
    { claims: w.claimsA },
  );
  const row = json(
    `select to_jsonb(p) from public.user_profiles p where identity_id = ${literal(w.identityA)}`,
    { claims: w.claimsA },
  );
  assert.equal(row.display_name, 'Prof A renamed');
  assert.equal(row.avatar, 'https://example.invalid/a.png', 'avatar must survive a partial update');
  assert.equal(row.email, 'a@example.invalid', 'email must survive a partial update');
  assert.equal(row.global_id, GLOBAL_A, 'global_id must survive a partial update');
});

test('SECURITY: a caller cannot write another identity\'s profile', () => {
  // The function's own signature is the boundary: there is no identity
  // parameter, so the only thing B can write is B's row. Prove it end to end —
  // B writes, A's row is bit-for-bit unchanged.
  const before = json(
    `select to_jsonb(p) from public.user_profiles p where identity_id = ${literal(w.identityA)}`,
    { claims: w.claimsA },
  );

  const asB = json(
    `select public.update_identity_profile('Written by B', null, null,
       'example-issuer:idprof-b-67890', ${literal(cmid('idprof-set-b'))})`,
    { claims: w.claimsB },
  );
  assert.equal(asB.identityId, w.identityB, 'B\'s write must land on B\'s own row');

  const after = json(
    `select to_jsonb(p) from public.user_profiles p where identity_id = ${literal(w.identityA)}`,
    { claims: w.claimsA },
  );
  assert.deepEqual(after, before, 'B\'s write must not touch A\'s row in any way');

  // And the signature really has no way to name a victim: exactly the five
  // declared text parameters, none of them an identity.
  const arity = scalar(
    `select pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'update_identity_profile'`,
    { claims: w.claimsA },
  );
  assert.equal(Number(arity), 5);
});

test('no bound identity is refused with 28000, before any write', () => {
  denied(
    'update_identity_profile: caller with no identity claim',
    `select public.update_identity_profile('Nobody', null, null, null, ${literal(cmid('idprof-nobody'))})`,
    { expect: '28000' },
  );
});

test('the global_id shape constraint refuses malformed values', () => {
  for (const bad of ['no-colon', ':no-issuer', 'no-subject:', 'has space:sub ject', 'x:']) {
    const { sqlstate } = expectFailure(
      `select public.update_identity_profile(null, null, null, ${literal(bad)},
         ${literal(cmid('idprof-bad'))})`,
      { claims: w.claimsA },
    );
    assert.equal(sqlstate, '23514', `${JSON.stringify(bad)} must violate user_profiles_global_id_shape`);
  }
  // The seam splits on the FIRST colon; the subject may itself contain colons.
  const colons = json(
    `select public.update_identity_profile(null, null, null, 'iss:sub:with:colons',
       ${literal(cmid('idprof-colons'))})`,
    { claims: w.claimsB },
  );
  assert.equal(colons.globalId, 'iss:sub:with:colons');
});

test('a retry replays the stored result; a second principal is refused', () => {
  const id = cmid('idprof-replay');
  const first = json(
    `select public.update_identity_profile('Replay Name', null, null, null, ${literal(id)})`,
    { claims: w.claimsA },
  );
  const retry = json(
    `select public.update_identity_profile('Replay Name', null, null, null, ${literal(id)})`,
    { claims: w.claimsA },
  );
  assert.deepEqual(retry, first, 'a retry must replay the stored result, not re-apply');

  // 23514, not 42501: require_replay_principal (031, W2.SEC-1) raises
  // invariant-violation for a cross-principal id — a client REUSING another
  // principal's id is a protocol violation, not merely a permission miss.
  denied(
    'update_identity_profile: replay of A\'s mutation id by B',
    `select public.update_identity_profile('Stolen', null, null, null, ${literal(id)})`,
    { claims: w.claimsB, expect: '23514' },
  );
});

test('round-trip: the profile the writer wrote is the one identity.get reads', () => {
  const written = json(
    `select public.update_identity_profile('Round Trip', null, null, null,
       ${literal(cmid('idprof-roundtrip'))})`,
    { claims: w.claimsA },
  );
  const identity = json('select public.current_identity()', { claims: w.claimsA });
  assert.equal(identity.displayName, written.displayName);
  assert.equal(identity.globalId, written.globalId);
  assert.equal(identity.avatar, written.avatar);
});

test('display identity is not an authorization input: a global_id grants nothing', () => {
  // I6's negative, stated as a test: B carries a global_id and remains unable
  // to read A's private space. If this ever passes for the wrong reason the
  // suite still holds — the row count is what RLS answers, not the claim.
  ok(`select count(*) from public.user_profiles where identity_id = ${literal(w.identityB)}
        and global_id is not null`, { claims: w.claimsB });
  const visibleToB = Number(scalar(
    `select count(*) from public.entities where space_id = ${literal(w.spaceA)}::uuid`,
    { claims: w.claimsB },
  ));
  assert.equal(visibleToB, 0, 'a populated global_id must not widen RLS visibility');
});
