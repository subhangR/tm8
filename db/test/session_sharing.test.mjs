// =============================================================================
// CONFIGURABLE TERMINAL SHARING (migration 187).
//
// The question this suite answers is narrow and the whole feature turns on it:
// WHO MAY MINT A STREAM GRANT, and in which mode. A grant is the only thing
// standing between a caller and the PTY's bytes — `pty-ws-server.ts` authorises
// by consuming one BEFORE the WebSocket upgrade — so `grant_stream_attach`
// refusing is exactly and only what "you cannot see this terminal" means.
//
// Two dials, tested as two dials. `share_mode` gates WATCHING, `drive_mode`
// gates TYPING, and the interesting cases are the ones where they disagree:
// shared-but-not-drivable is the posture we expect most teams to pick, and a
// suite that only tested them together would not notice if drive quietly
// followed view.
//
// The cast (all inside space A — this is NOT a tenancy suite; rls_negatives.mjs
// already proves an outsider sees nothing):
//   A  created space A. Owner of the sessions it spawns, and a space admin.
//   C  a plain member of space A. The caller every assertion here is about:
//      inside the space, so `entities_select` shows C the session ROW, and the
//      only thing that can withhold the BYTES is the gate under test.
//
// The distinction that makes the teammate cases matter: a session spawned with
// `p_actor_id = personaA` records the PERSONA in `entities.created_by`, and 075
// ruled that any active member may act as any teammate in their space. So an
// agent-launched terminal reaches C through `can_act_as` — that is pre-existing
// behaviour, not something 187 introduces, and these tests pin it so a later
// edit to the gate cannot drop it silently.
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

const w = buildWorld('share');

// --- C: a plain member of space A -------------------------------------------
const identityC = 'identity-share-c';
json(
  `select public.ensure_account(${literal(identityC)}, 'share-c', 'Plain C', null, false, false)`,
  { claims: rootClaims() },
);
const invite = json(`select public.create_invite(${uuid(w.spaceA)}, 5)`, {
  claims: w.claimsA,
}).invite;
const memberC = json(`select public.redeem_invite(${literal(invite.code)})`, {
  claims: claimsFor(identityC),
}).memberId;
const claimsC = claimsFor(identityC, memberC);

// --- plumbing ---------------------------------------------------------------

/**
 * 64 lowercase hex, the shape 087 requires — and a DIFFERENT one every call.
 * `stream_grants_token_hash_live_idx` is unique across all live grants, which is
 * what makes a grant single-use; reusing one literal would collide on the second
 * mint and fail for a reason that has nothing to do with authorisation.
 */
let hashCounter = 0;
function HASH() {
  hashCounter += 1;
  return literal(hashCounter.toString(16).padStart(64, '0'));
}

/**
 * `p_actor_id = null` resolves to the caller's own member row, so the session is
 * MEMBER-created; naming the persona makes it TEAM_MEMBER-created. That single
 * argument is the difference between the two populations 187 has to serve.
 */
function spawn(tag, { actorId = null } = {}) {
  return spawnAs(w.claimsA, tag, { actorId });
}

/** The same spawn, by a named caller — so a session can have an owner who is NOT A. */
function spawnAs(claims, tag, { actorId = null } = {}) {
  return json(
    `select public.execution_spawn(${uuid(w.spaceA)}, ${uuid(w.personaA)}, '{}'::uuid[],
       null, 'project', null, null, null, null, null, ${literal(tag)}, 'node-1',
       true, 64, ${uuid(actorId)}, ${literal(cmid(tag))})`,
    { claims },
  ).entity.id;
}

const attachSql = (sessionId, mode, tag) =>
  `select public.grant_stream_attach(${uuid(sessionId)}, ${literal(mode)}, ${HASH()},
     interval '30 seconds', ${literal(cmid(tag))})`;

/** Mints a grant, and returns it, so a caller can assert on the row it produced. */
const attaches = (sessionId, mode, claims, tag) =>
  json(attachSql(sessionId, mode, tag), { claims }).grant;

const refused = (label, sessionId, mode, claims, tag) =>
  denied(label, attachSql(sessionId, mode, tag), { claims, expect: '42501' });

const shareSql = (sessionId, patch, tag) =>
  `select public.set_work_session_sharing(${uuid(sessionId)}, null,
     ${patch.share === undefined ? 'null' : literal(patch.share)},
     ${patch.drive === undefined ? 'null' : literal(patch.drive)},
     null, ${literal(cmid(tag))})`;

const modesOf = (sessionId) =>
  scalar(
    `select share_mode || '/' || drive_mode from public.work_sessions
      where entity_id = ${uuid(sessionId)}`,
    { claims: w.claimsA },
  );

// -----------------------------------------------------------------------------
// 1. The space default reaches a spawned session — and a credential one is exempt.
// -----------------------------------------------------------------------------
test('a new session inherits the space default (which ships as share/owner)', () => {
  assert.equal(
    scalar(
      `select session_share_default || '/' || session_drive_default
         from public.spaces where id = ${uuid(w.spaceA)}`,
      { claims: w.claimsA },
    ),
    'space/owner',
    'a fresh space must ship shared-to-watch and owner-only-to-drive',
  );
  assert.equal(modesOf(spawn('inherit')), 'space/owner');
});

test('changing the space default moves NEW sessions and leaves existing ones alone', () => {
  const before = spawn('before-default-change');
  ok(
    `select public.w2_update_space(${uuid(w.spaceA)},
       '{"sessionShareDefault":"none","sessionDriveDefault":"space"}'::jsonb,
       ${literal(cmid('space-default'))})`,
    { claims: w.claimsA },
  );
  assert.equal(modesOf(spawn('after-default-change')), 'none/space');
  // THE RETROACTIVITY GUARANTEE. A default is applied at insert and never swept
  // over what already exists, so nobody's open terminal changes posture because
  // an admin edited a setting.
  assert.equal(modesOf(before), 'space/owner', 'an existing session must not move');

  // put it back, so the ordering of the tests below is not a hidden dependency
  ok(
    `select public.w2_update_space(${uuid(w.spaceA)},
       '{"sessionShareDefault":"space","sessionDriveDefault":"owner"}'::jsonb,
       ${literal(cmid('space-default-restore'))})`,
    { claims: w.claimsA },
  );
});

test('a credential session stays private no matter what the space default says', () => {
  ok(
    `select public.w2_update_space(${uuid(w.spaceA)},
       '{"sessionShareDefault":"space","sessionDriveDefault":"space"}'::jsonb,
       ${literal(cmid('space-default-open'))})`,
    { claims: w.claimsA },
  );
  // `start_credential_session` refuses any caller without a browser/cli
  // `tm8.auth_kind` — an agent bearer may not open someone's login terminal.
  // `claimsFor` does not set that claim, so this is the one call site that adds it.
  const humanA = { ...w.claimsA, 'tm8.auth_kind': 'cli' };
  const credential = json(
    `select public.start_credential_session(${uuid(w.spaceA)}, 'anthropic')`,
    { claims: humanA },
  ).workSessionId;
  // Its terminal streams an OAuth device code. 083 pins share_mode='none' at the
  // insert and 187's trigger steps aside for this kind rather than overwriting
  // it — so the most permissive space default reachable cannot widen a login.
  assert.equal(modesOf(credential), 'none/owner');
  refused(
    'grant_stream_attach: C watching another member\'s credential login',
    credential, 'view', claimsC, 'cred-view',
  );
  ok(`select public.finish_credential_session(${uuid(credential)})`, { claims: humanA });
  ok(
    `select public.w2_update_space(${uuid(w.spaceA)},
       '{"sessionShareDefault":"space","sessionDriveDefault":"owner"}'::jsonb,
       ${literal(cmid('space-default-open-restore'))})`,
    { claims: w.claimsA },
  );
});

// -----------------------------------------------------------------------------
// 2. THE MATRIX, on a member-created session.
// -----------------------------------------------------------------------------
test('share_mode=none: the owner attaches, another member is refused', () => {
  const s = spawn('private');
  ok(shareSql(s, { share: 'none' }, 'make-private'), { claims: w.claimsA });

  assert.ok(attaches(s, 'view', w.claimsA, 'owner-view'), 'the owner always sees their own');
  assert.ok(attaches(s, 'drive', w.claimsA, 'owner-drive'), 'and always drives it');

  refused('grant_stream_attach: C watching an unshared session', s, 'view', claimsC, 'c-view-none');
  refused('grant_stream_attach: C driving an unshared session', s, 'drive', claimsC, 'c-drive-none');
});

test('share_mode=space grants WATCHING and withholds TYPING', () => {
  const s = spawn('watch-only');
  ok(shareSql(s, { share: 'space', drive: 'owner' }, 'watch-only'), { claims: w.claimsA });

  const grant = attaches(s, 'view', claimsC, 'c-view-shared');
  assert.equal(grant.mode, 'view');
  assert.equal(grant.subject_identity, identityC);

  // THE POINT OF SPLITTING THE DIALS. C can read the screen and cannot touch the
  // keyboard. Before 187 there was no way to express this: one flag decided both.
  refused(
    'grant_stream_attach: C driving a session shared for watching only',
    s, 'drive', claimsC, 'c-drive-watchonly',
  );
});

test('drive_mode=space grants TYPING to any member', () => {
  const s = spawn('drivable');
  ok(shareSql(s, { share: 'space', drive: 'space' }, 'drivable'), { claims: w.claimsA });
  assert.equal(attaches(s, 'drive', claimsC, 'c-drive-open').mode, 'drive');
  assert.equal(attaches(s, 'view', claimsC, 'c-view-open').mode, 'view');
});

test('drive requires the VIEW gate too: unshared beats drive_mode=space', () => {
  const s = spawn('drive-without-view');
  // A posture reachable by setting the dials independently, and the one a naive
  // implementation gets wrong: `drive_mode` is not a bypass of `share_mode`.
  ok(shareSql(s, { share: 'none', drive: 'space' }, 'drive-no-view'), { claims: w.claimsA });
  refused('grant_stream_attach: C driving an UNSHARED session that is drive_mode=space',
    s, 'drive', claimsC, 'c-drive-unshared');
  refused('grant_stream_attach: C watching that same session',
    s, 'view', claimsC, 'c-view-unshared');
});

// -----------------------------------------------------------------------------
// 3. The teammate path, which 187 must PRESERVE rather than replace.
// -----------------------------------------------------------------------------
test('a teammate-created session stays reachable through can_act_as, even at share_mode=none', () => {
  const s = spawn('agent-launched', { actorId: w.personaA });
  ok(shareSql(s, { share: 'none', drive: 'owner' }, 'agent-private'), { claims: w.claimsA });

  // C may act as the persona (075), the persona created the session, so both
  // gates open on the `may_act_as_creator` arm without any sharing being set.
  // This is today's behaviour and the reason agent terminals are already
  // visible space-wide; 187 adds a dial beside it and removes nothing.
  assert.equal(attaches(s, 'view', claimsC, 'c-view-agent').mode, 'view');
  assert.equal(attaches(s, 'drive', claimsC, 'c-drive-agent').mode, 'drive');
});

// -----------------------------------------------------------------------------
// 4. Who may turn the dials.
// -----------------------------------------------------------------------------
test('only the owner or a space admin may change a session\'s sharing', () => {
  const s = spawn('authority', { actorId: null });
  denied(
    'set_work_session_sharing: plain member C opening someone else\'s session',
    shareSql(s, { share: 'space' }, 'c-opens'),
    { claims: claimsC, expect: '42501' },
  );
  assert.equal(modesOf(s), 'space/owner', 'the refusal must not have written anything');
});

test('a space admin may shut off a session they did not launch', () => {
  const s = spawn('admin-closes');
  ok(shareSql(s, { share: 'space', drive: 'space' }, 'admin-open'), { claims: w.claimsA });
  // A is the space admin here. The arm matters because without it a terminal
  // left open by someone who has gone home could be closed by nobody.
  ok(shareSql(s, { share: 'none' }, 'admin-shut'), { claims: w.claimsA });
  assert.equal(modesOf(s), 'none/space');
});

test('the RPC validates its vocabulary and refuses an empty patch', () => {
  const s = spawn('validation');
  denied('set_work_session_sharing: unknown share_mode',
    shareSql(s, { share: 'everyone' }, 'bad-share'), { claims: w.claimsA, expect: '22023' });
  denied('set_work_session_sharing: unknown drive_mode',
    shareSql(s, { drive: 'anyone' }, 'bad-drive'), { claims: w.claimsA, expect: '22023' });
  denied('set_work_session_sharing: nothing named',
    shareSql(s, {}, 'bad-empty'), { claims: w.claimsA, expect: '22023' });
  denied('w2_update_space: unknown sessionShareDefault',
    `select public.w2_update_space(${uuid(w.spaceA)},
       '{"sessionShareDefault":"everyone"}'::jsonb, ${literal(cmid('bad-default'))})`,
    { claims: w.claimsA, expect: '22023' });
});

// -----------------------------------------------------------------------------
// 5. Narrowing revokes what is already outstanding.
//
// A grant is a capability that has ALREADY left the server, single-use and good
// for up to 60 seconds. If un-sharing only changed the column, "stop sharing"
// would not stop anything for the lifetime of a grant somebody is holding.
// -----------------------------------------------------------------------------
const liveGrants = (sessionId, identity) =>
  scalar(
    `select count(*) from public.stream_grants
      where work_session_id = ${uuid(sessionId)}
        and subject_identity = ${literal(identity)}
        and revoked_at is null`,
    { claims: w.claimsA },
  );

test('un-sharing revokes another member\'s outstanding grants', () => {
  const s = spawn('revoke-on-close');
  ok(shareSql(s, { share: 'space', drive: 'space' }, 'revoke-open'), { claims: w.claimsA });
  attaches(s, 'view', claimsC, 'revoke-c-view');
  attaches(s, 'drive', claimsC, 'revoke-c-drive');
  assert.equal(liveGrants(s, identityC), '2', 'control: C is holding two live grants');

  ok(shareSql(s, { share: 'none' }, 'revoke-close'), { claims: w.claimsA });
  assert.equal(liveGrants(s, identityC), '0', 'closing the session must revoke both');
  refused('grant_stream_attach: C re-minting after the session was closed',
    s, 'view', claimsC, 'c-view-after-close');
});

test('narrowing drive alone revokes drive grants and keeps view grants', () => {
  const s = spawn('narrow-drive');
  ok(shareSql(s, { share: 'space', drive: 'space' }, 'narrow-open'), { claims: w.claimsA });
  attaches(s, 'view', claimsC, 'narrow-c-view');
  attaches(s, 'drive', claimsC, 'narrow-c-drive');

  ok(shareSql(s, { drive: 'owner' }, 'narrow-shut'), { claims: w.claimsA });
  // Precisely one survives: C may still watch, and the keyboard is gone.
  assert.equal(liveGrants(s, identityC), '1');
  assert.equal(
    scalar(`select mode from public.stream_grants
         where work_session_id = ${uuid(s)} and subject_identity = ${literal(identityC)}
           and revoked_at is null`, { claims: w.claimsA }),
    'view',
  );
  refused('grant_stream_attach: C driving after drive was narrowed to the owner',
    s, 'drive', claimsC, 'c-drive-after-narrow');
});

/**
 * The case that separates "the caller's grants survive" from "the CREATOR'S
 * grants survive". They are the same row whenever an owner closes their own
 * session, which is why the rule can look right while being wrong: it is only
 * distinguishable when somebody ELSE does the closing.
 *
 * A space admin who makes another member's session private has just put it
 * behind a gate they no longer pass — `grant_stream_attach` would refuse to
 * mint them a new one the moment this returns. A grant of theirs left alive
 * would therefore be a capability the gate disowns, live for up to 60 seconds.
 */
test('an admin closing someone else\'s session revokes their OWN grant, not the owner\'s', () => {
  const s = spawnAs(claimsC, 'admin-closes');
  assert.equal(modesOf(s), 'space/owner', 'control: C\'s session inherited the shared default');
  attaches(s, 'view', claimsC, 'admin-closes-c');
  attaches(s, 'view', w.claimsA, 'admin-closes-a');
  assert.equal(liveGrants(s, identityC), '1', 'control: the owner is watching');
  assert.equal(liveGrants(s, w.identityA), '1', 'control: the admin is watching too');

  ok(shareSql(s, { share: 'none' }, 'admin-closes-shut'), { claims: w.claimsA });

  assert.equal(liveGrants(s, identityC), '1', 'C created it and never loses their own terminal');
  assert.equal(liveGrants(s, w.identityA), '0', 'A closed it and is not its owner');
  refused('grant_stream_attach: the admin re-minting on a session they just closed',
    s, 'view', w.claimsA, 'admin-closes-a-again');
});

test('closing a session does NOT revoke the owner\'s own grant', () => {
  const s = spawn('owner-keeps');
  ok(shareSql(s, { share: 'space', drive: 'space' }, 'owner-keeps-open'), { claims: w.claimsA });
  attaches(s, 'view', w.claimsA, 'owner-keeps-view');
  ok(shareSql(s, { share: 'none' }, 'owner-keeps-shut'), { claims: w.claimsA });
  assert.equal(liveGrants(s, w.identityA), '1', 'the owner never loses access to their own terminal');
});

// -----------------------------------------------------------------------------
// 6. Metadata was deliberately NOT narrowed.
//
// 187 gates BYTES. `entities_select` still shows every member every session row
// in their space, and this test exists so that the choice stays a CHOICE — if a
// later change starts hiding rows, this fails and whoever did it has to say so.
// -----------------------------------------------------------------------------
test('an unshared session is still VISIBLE as a row to other members', () => {
  const s = spawn('metadata');
  ok(shareSql(s, { share: 'none' }, 'metadata-private'), { claims: w.claimsA });
  assert.equal(
    scalar(`select count(*) from public.entities where id = ${uuid(s)}`, { claims: claimsC }),
    '1',
    'sharing controls the stream, not the entity: C still sees that the session exists',
  );
  refused('grant_stream_attach: ...but not its bytes', s, 'view', claimsC, 'metadata-bytes');
});
