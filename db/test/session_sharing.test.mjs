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
// edit to the gate cannot drop it silently — for a session nobody has
// configured. Once a human sets its dials (202's `sharing_set_at`), they hold.
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
  OWNER_URL,
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

test('an UNLISTED session_kind does NOT inherit the space default — the trigger fails closed', () => {
  // The review case. The trigger used to skip only 'credential', which made it a
  // deny-list: every other kind inherited, including `container_exec`, whose
  // insert (177:1649) names no share_mode and whose PTY nobody decided to
  // publish. It is now an allow-list of ('agent','shell'), so this asserts the
  // property that matters for the NEXT kind as much as for this one — a kind
  // the product decision never considered keeps the column defaults.
  //
  // Driven at the table rather than through `start_container_exec_session`,
  // which needs a live container; the trigger sits on the INSERT, so this is the
  // same seam it fires on.
  // The trigger fires on INSERT, so this needs a genuinely new detail row. It
  // builds the envelope by hand rather than deleting a spawned session's row:
  // `work_session_interaction_pins` cascades off `work_sessions` and its
  // `guard_pin_snapshot()` refuses the delete ("pins are immutable; append a
  // revision"), so re-making a spawned row is not available. The insert names
  // no `share_mode`, exactly as `start_container_exec_session` (177:1649) does.
  const exec = scalar(
    `insert into public.entities (space_id, kind, position, created_by)
       values (${uuid(w.spaceA)}, 'work_session', 1, ${uuid(w.personaA)})
     returning id`,
    { url: OWNER_URL },
  );
  ok(
    `insert into public.work_sessions (entity_id, session_kind, status, node_id)
       values (${uuid(exec)}, 'container_exec', 'running', 'node-1')`,
    { url: OWNER_URL },
  );
  assert.equal(
    modesOf(exec), 'none/owner',
    'a container_exec session must keep the column defaults, not the space default',
  );

  // CONTROL, so the assertion above is not vacuous: the same hand-built insert
  // at a LISTED kind does inherit. Without this the test would still pass if the
  // trigger had simply stopped firing.
  const shell = scalar(
    `insert into public.entities (space_id, kind, position, created_by)
       values (${uuid(w.spaceA)}, 'work_session', 2, ${uuid(w.personaA)})
     returning id`,
    { url: OWNER_URL },
  );
  ok(
    `insert into public.work_sessions (entity_id, session_kind, status, node_id)
       values (${uuid(shell)}, 'shell', 'running', 'node-1')`,
    { url: OWNER_URL },
  );
  assert.equal(
    modesOf(shell), 'space/owner',
    'a shell session IS on the allow-list and must still inherit',
  );
});

test('turning a dial BUMPS the entity version, so other devices learn about it', () => {
  // The review case, and the one none of the other tests would have caught.
  // `entity.upsert` has exactly one source — `entities_capture_event` on
  // `public.entities` (003:385) — so a write that touched only `work_sessions`
  // emitted nothing any other device could act on, and every viewer but the
  // clicking one kept a stale badge. That is precisely the "streams on one
  // device, not on another" complaint this whole task was opened for.
  const s = spawn('version-bump');
  const versionOf = () =>
    Number(scalar(`select version from public.entities where id = ${uuid(s)}`,
      { claims: w.claimsA }));
  const before = versionOf();
  ok(shareSql(s, { share: 'none' }, 'bump-1'), { claims: w.claimsA });
  const after = versionOf();
  assert.ok(after > before, `version must advance, got ${before} -> ${after}`);

  // And because it advances, the optimistic guard is no longer vacuous: a stale
  // expectation must now be REFUSED. Before the fix this passed every time,
  // since a version that cannot move always matches whatever you remember.
  denied(
    'set_work_session_sharing at a stale expected_version',
    `select public.set_work_session_sharing(${uuid(s)}, ${before},
       'space', null, null, ${literal(cmid('bump-stale'))})`,
    { claims: w.claimsA },
  );
});

test("'explicit' is refused by the RPC, though the column still admits it", () => {
  // It round-tripped before: the RPC stored it, the gate reads `= 'none'` so it
  // behaved as 'space', and the badge rendered "shared: explicit" for a session
  // open to the whole space. Nothing in this schema consults a per-person list,
  // so the value is inert and must not become settable through the first door
  // that could ever set it. The CHECK constraint keeps admitting it so any row
  // already carrying it stays legal.
  const s = spawn('explicit-refused');
  denied(
    'set_work_session_sharing with share_mode=explicit',
    `select public.set_work_session_sharing(${uuid(s)}, null, 'explicit', null,
       null, ${literal(cmid('explicit'))})`,
    { claims: w.claimsA, expect: '22023' },
  );
  assert.equal(modesOf(s), 'space/owner', 'and the row is untouched');
  ok(
    `update public.work_sessions set share_mode = 'explicit' where entity_id = ${uuid(s)}`,
    { url: OWNER_URL },
  );
  assert.equal(modesOf(s), 'explicit/owner', 'the CHECK still admits a stored explicit');
});

// -----------------------------------------------------------------------------
// 3. The teammate path — 075's arm is DEFAULT visibility, and 202 keeps it only
//    while nobody has configured the session.
//
// Until 202 this section was one test named `KNOWN LIMIT: on a teammate-created
// session BOTH dials are inert, because 075 outranks them`. It pinned the hole:
// the owner asked for the most private posture both dials express and member C
// still got view AND drive, because both gates opened on `may_act_as_creator`.
// `work_sessions.sharing_set_at` is what separates "never configured" (keep
// 075's arm) from "deliberately narrowed" (enforce the dial), and the tests
// below pin both halves — the second is the one the old test asserted against.
// -----------------------------------------------------------------------------
const setAtOf = (sessionId) =>
  scalar(
    `select coalesce(sharing_set_at::text, 'null') from public.work_sessions
      where entity_id = ${uuid(sessionId)}`,
    { claims: w.claimsA },
  );

test('a pre-187-shaped teammate row (never configured, share none) still attaches for another member', () => {
  // THE NO-REGRESSION CASE: how a human watches an agent's terminal today. The
  // row is put in exactly the shape 986 live rows were in before 187 — 'none'
  // because nothing had ever written the column — without going through the
  // one writer, so `sharing_set_at` stays null. The UPDATE names only the two
  // dials, so the single-writer guard on `sharing_set_at` does not fire.
  const s = spawn('legacy-agent', { actorId: w.personaA });
  ok(
    `update public.work_sessions set share_mode = 'none', drive_mode = 'owner'
      where entity_id = ${uuid(s)}`,
    { url: OWNER_URL },
  );
  assert.equal(modesOf(s), 'none/owner');
  assert.equal(setAtOf(s), 'null', 'control: this row has never been configured');

  assert.equal(attaches(s, 'view', claimsC, 'legacy-c-view').mode, 'view');
  assert.equal(attaches(s, 'drive', claimsC, 'legacy-c-drive').mode, 'drive');
});

test('a deliberate narrowing NARROWS on a teammate-created session', () => {
  const s = spawn('agent-narrowed', { actorId: w.personaA });
  assert.equal(setAtOf(s), 'null', 'a spawn does not stamp provenance; only the one writer does');
  attaches(s, 'view', claimsC, 'narrowed-c-view-before');

  ok(shareSql(s, { share: 'none', drive: 'owner' }, 'agent-narrow'), { claims: w.claimsA });
  assert.notEqual(setAtOf(s), 'null', 'the writer stamped it');

  // The old KNOWN LIMIT test asserted the opposite of these two lines.
  refused('grant_stream_attach: C watching a teammate session narrowed to none',
    s, 'view', claimsC, 'narrowed-c-view');
  refused('grant_stream_attach: C driving a teammate session narrowed to none',
    s, 'drive', claimsC, 'narrowed-c-drive');

  // WHAT "OWNER" MEANS WHEN THE OWNER IS A PERSONA. `created_by` is the
  // teammate, and no column records which human pressed launch — so the member
  // who narrowed it is outside too. Pinned so nobody reads 'none' on an agent
  // session as "only me" and is surprised.
  refused('grant_stream_attach: A, who launched and narrowed it, watching it',
    s, 'view', w.claimsA, 'narrowed-a-view');
});

test('re-opening a narrowed teammate session restores watching AND typing', () => {
  // The trap the first-write rule exists for. Post-187 agent sessions are
  // stamped space/owner, and under 075 'owner' means every member. If the first
  // write only stamped provenance, "Make private" then "Share with space" would
  // leave drive_mode at 'owner', now enforced — and nobody could type into the
  // agent's terminal again. Instead the first write materialises the dial it
  // does not name at the value that was already in force.
  const s = spawn('agent-reopen', { actorId: w.personaA });
  assert.equal(modesOf(s), 'space/owner', 'control: the space default');

  ok(shareSql(s, { share: 'none' }, 'agent-reopen-close'), { claims: w.claimsA });
  assert.equal(modesOf(s), 'none/space', 'drive was everyone before; the first write says so');
  refused('grant_stream_attach: C driving while it is closed — drive needs the view gate',
    s, 'drive', claimsC, 'reopen-c-drive-closed');

  ok(shareSql(s, { share: 'space' }, 'agent-reopen-open'), { claims: w.claimsA });
  assert.equal(modesOf(s), 'space/space');
  assert.equal(attaches(s, 'view', claimsC, 'reopen-c-view').mode, 'view');
  assert.equal(attaches(s, 'drive', claimsC, 'reopen-c-drive').mode, 'drive');
});

test('narrowing only DRIVE on a teammate session keeps watching open', () => {
  // The mirror of the case above: naming drive alone must not close watching,
  // though the stored share_mode on a legacy row is 'none'.
  const s = spawn('agent-drive-only', { actorId: w.personaA });
  ok(
    `update public.work_sessions set share_mode = 'none' where entity_id = ${uuid(s)}`,
    { url: OWNER_URL },
  );
  ok(shareSql(s, { drive: 'owner' }, 'agent-drive-only'), { claims: w.claimsA });
  assert.equal(modesOf(s), 'space/owner', 'watching was everyone before; the first write says so');
  assert.equal(attaches(s, 'view', claimsC, 'drive-only-c-view').mode, 'view');
  refused('grant_stream_attach: C driving after drive alone was narrowed',
    s, 'drive', claimsC, 'drive-only-c-drive');
});

test('the first-write rule is a member-created session no-op', () => {
  // 075's arm never reached C on A's own session, so there is nothing in force
  // to write down: naming one dial leaves the other exactly as stored.
  const s = spawn('member-first-write');
  ok(
    `update public.work_sessions set share_mode = 'none' where entity_id = ${uuid(s)}`,
    { url: OWNER_URL },
  );
  ok(shareSql(s, { drive: 'space' }, 'member-first-write'), { claims: w.claimsA });
  assert.equal(modesOf(s), 'none/space');
});

test('sharing_set_at has a single writer', () => {
  const s = spawn('single-writer');
  denied(
    'a direct UPDATE of sharing_set_at, even as the table owner',
    `update public.work_sessions set sharing_set_at = now() where entity_id = ${uuid(s)}`,
    { url: OWNER_URL, expect: '23514' },
  );
  ok(shareSql(s, { share: 'space' }, 'single-writer-set'), { claims: w.claimsA });
  denied(
    'a direct UPDATE that NULLS it — the one that would silently re-open a narrowed session',
    `update public.work_sessions set sharing_set_at = null where entity_id = ${uuid(s)}`,
    { url: OWNER_URL, expect: '23514' },
  );
  assert.notEqual(setAtOf(s), 'null');
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
