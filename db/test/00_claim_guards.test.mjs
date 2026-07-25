// =============================================================================
// F1 / F2 — the two deliberate holes in the claim model, and the walls around them.
//
// STATE.md 'Claims contract':
//   F1  ensure_account raises 28000 unless it is the zero-accounts first run, or
//       the caller is a node admin. Without this, anything holding a tm8_app
//       connection could mint itself an account.
//   F2  public.resolve_account_credential(p_login) is the SOLE claim-free auth
//       read. It has to be — a caller presenting a password has no identity yet.
//
// The F1 first-run branch is only observable on a virgin database, so this suite
// builds its own (helpers.freshDatabase) rather than sharing the run's database.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_URL,
  claimsFor,
  denied,
  freshDatabase,
  invisible,
  json,
  literal,
  ok,
  run,
  scalar,
} from './helpers.mjs';

const fresh = freshDatabase('f1');
const app = { url: fresh.appUrl };

test('F1 branch 1 — zero accounts: ensure_account is claim-free (first-run owner bootstrap)', () => {
  assert.equal(
    scalar('select count(*) from public.accounts', { url: fresh.ownerUrl }),
    '0',
    'the fresh database should start with no accounts',
  );

  const owner = json(
    `select public.ensure_account('identity-f1-owner', 'f1owner', 'F1 Owner', null, true, true)`,
    { ...app, claims: null },
  );
  assert.equal(owner.identity_id, 'identity-f1-owner');
  assert.equal(owner.is_owner, true);
  assert.equal(owner.is_node_admin, true);
  assert.equal(owner.password_hash, undefined, 'ensure_account must never return the verifier');
});

test('F1 branch 2 — accounts exist + NO claim bound: 28000 unauthenticated', () => {
  denied(
    'F1/ensure_account: unauthenticated caller (no tm8.identity_id) on a populated node',
    `select public.ensure_account('identity-f1-intruder', 'f1intruder')`,
    { ...app, claims: null, expect: '28000' },
  );
  assert.equal(
    scalar(`select count(*) from public.accounts where identity_id = 'identity-f1-intruder'`, {
      url: fresh.ownerUrl,
    }),
    '0',
    'the refused call must not have left an account behind',
  );
});

test('F1 branch 3 — accounts exist + non-node-admin caller: 42501 forbidden', () => {
  // A real, active, NON-admin account: the claim cannot be the thing that decides
  // this, so the account has to exist in the table to be a fair test.
  json(
    `select public.ensure_account('identity-f1-plain', 'f1plain', 'Plain', null, false, false)`,
    { ...app, claims: claimsFor('identity-f1-owner', null, true) },
  );

  denied(
    'F1/ensure_account: authenticated non-node-admin caller',
    `select public.ensure_account('identity-f1-sneak', 'f1sneak')`,
    { ...app, claims: claimsFor('identity-f1-plain'), expect: '42501' },
  );

  // ...and the same caller ASSERTING tm8.node_admin='true' is still refused,
  // because require_node_admin resolves the flag from public.accounts, never from
  // the claim. This is the branch that matters.
  denied(
    'F1/ensure_account: non-admin caller FORGING tm8.node_admin=true',
    `select public.ensure_account('identity-f1-forged', 'f1forged')`,
    { ...app, claims: claimsFor('identity-f1-plain', null, true), expect: '42501' },
  );
  assert.equal(
    scalar(
      `select count(*) from public.accounts where identity_id in ('identity-f1-sneak','identity-f1-forged')`,
      { url: fresh.ownerUrl },
    ),
    '0',
    'neither refused call may have created an account',
  );
});

test('F1 branch 4 — accounts exist + node admin: allowed, and idempotent', () => {
  const admin = claimsFor('identity-f1-owner', null, true);
  const first = json(
    `select public.ensure_account('identity-f1-second', 'f1second', 'Second', null, false, true)`,
    { ...app, claims: admin },
  );
  const again = json(
    `select public.ensure_account('identity-f1-second', 'f1second', 'Second', null, false, true)`,
    { ...app, claims: admin },
  );
  assert.equal(again.id, first.id, 'a repeated ensure_account must return the existing account');
});

test('F1 — a second owner is refused by the single-owner index (T-L7)', () => {
  denied(
    'accounts_single_owner_idx: a second is_owner account',
    `select public.ensure_account('identity-f1-usurper', 'f1usurper', 'Usurper', null, true, true)`,
    { ...app, claims: claimsFor('identity-f1-owner', null, true), expect: '23505' },
  );
});

test('F2 — resolve_account_credential is the sole claim-free auth read, and returns a verifier not a verdict', () => {
  // The account id has to come from the OWNER connection: tm8_app cannot read
  // public.accounts at all, which is the reason F2 has to exist in the first place.
  const plainAccount = scalar(`select id from public.accounts where username = 'f1plain'`, {
    url: fresh.ownerUrl,
  });
  ok(`select public.set_account_credential(${literal(plainAccount)}::uuid, 'deadbeef', 'argon2id')`, {
    ...app,
    claims: claimsFor('identity-f1-owner', null, true),
  });

  const credential = json(`select public.resolve_account_credential('f1plain')`, {
    ...app,
    claims: null, // the whole point: NO identity is bound
  });
  assert.equal(credential.identityId, 'identity-f1-plain');
  assert.equal(credential.passwordHash, 'deadbeef');
  assert.equal(credential.passwordAlgorithm, 'argon2id');
  assert.equal(credential.status, 'active');
  assert.ok(!('verdict' in credential), 'the DB must not decide authentication');

  // Case-insensitive, matching the accounts_username_lower_idx the server relies on.
  assert.equal(
    json(`select public.resolve_account_credential('F1PLAIN')`, { ...app, claims: null }).accountId,
    credential.accountId,
  );

  // Unknown login: zero rows, not an error and not a hint.
  assert.equal(
    run(`select public.resolve_account_credential('nobody-at-all')`, { ...app, claims: null }).stdout,
    '',
  );
});

test('F2 — the credential tables themselves are unreadable to tm8_app, claims or not', () => {
  // 008 §2 reasons about these as "RLS enabled with zero policies, which means zero
  // rows". In practice they are one wall further out than that: they are also absent
  // from 008's SELECT grant list, so tm8_app gets a hard 42501 rather than an empty
  // result. Both fail closed; asserting the ACTUAL behaviour means this test breaks
  // loudly if a future migration ever adds the grant and leaves the policy off.
  const admin = { ...app, claims: claimsFor('identity-f1-owner', null, true) };
  for (const table of [
    'accounts', // credential material
    'auth_sessions', // token hashes
    'command_ledger',
    'notification_outbox',
    'space_event_seq',
    'undo_tokens',
  ]) {
    denied(
      `${table}: no policy AND no grant — unreachable by query, even for the node owner`,
      `select count(*) from public.${table}`,
      { ...admin, expect: '42501' },
    );
  }
});

test('F2 — resolve_auth_session is claim-free too (bearer bootstrap) and leaks no token_hash', () => {
  const account = scalar(`select id from public.accounts where username = 'f1plain'`, {
    url: fresh.ownerUrl,
  });
  const hash = 'a'.repeat(64);
  const session = json(
    `select public.issue_auth_session(${literal(account)}::uuid, ${literal(hash)}, 'cli',
              now() + interval '1 hour')`,
    { ...app, claims: claimsFor('identity-f1-plain') },
  );
  assert.equal(session.token_hash, undefined, 'issue_auth_session must not echo the token hash');

  const resolved = json(`select public.resolve_auth_session(${literal(hash)})`, {
    ...app,
    claims: null,
  });
  assert.equal(resolved.identityId, 'identity-f1-plain');
  assert.equal(resolved.sessionId, session.id);
  assert.equal(resolved.kind, 'cli');

  // A wrong hash is simply no row.
  assert.equal(
    run(`select public.resolve_auth_session(${literal('b'.repeat(64))})`, { ...app, claims: null })
      .stdout,
    '',
  );
});

test('F2 — nothing ELSE works claim-free: every other entry point fails closed', () => {
  const noClaims = { ...app, claims: null };
  denied('identity.get/current_identity: no identity bound', 'select public.current_identity()', {
    ...noClaims,
    expect: '28000',
  });
  denied('spaces.create: no identity bound', `select public.create_space('Nope')`, {
    ...noClaims,
    expect: '28000',
  });
  denied('current_actor_scope: no identity bound', 'select public.current_actor_scope()', {
    ...noClaims,
    expect: '28000',
  });
  denied('upsert_user_profile: no identity bound', `select public.upsert_user_profile('Nope')`, {
    ...noClaims,
    expect: '28000',
  });
  denied('projects.create: no identity bound', `select public.create_project('x', '/tmp/x')`, {
    ...noClaims,
    expect: '28000',
  });

  // And the read side does not raise — it returns nothing, which is the same wall
  // with a quieter alarm.
  invisible('spaces_select: unset tm8.identity_id yields zero rows', 'select count(*) from public.spaces', noClaims);
  invisible(
    'entities_select: unset tm8.identity_id yields zero rows',
    'select count(*) from public.entities',
    noClaims,
  );
  invisible(
    'edge_types_select: even global reference data needs an identity',
    'select count(*) from public.edge_types',
    noClaims,
  );
});

// -----------------------------------------------------------------------------
// The tm8.node_admin claim is the literal string 'true'. Deneb hit this from the
// TypeScript side emitting 'on'/'off', and the failure mode is the dangerous kind:
// the claim simply never granted anything, so it read as a permissions bug rather
// than a contract mismatch. Pinned here so it cannot come back silently.
// (001_core_graph.sql:166 — lower(claim_text('tm8.node_admin')) = 'true')
// -----------------------------------------------------------------------------
test("node_admin claim: 'true' grants, 'on' does not, absent does not", () => {
  const asOwner = (nodeAdminValue) => ({
    ...app,
    claims:
      nodeAdminValue === undefined
        ? { 'tm8.identity_id': 'identity-f1-owner' }
        : { 'tm8.identity_id': 'identity-f1-owner', 'tm8.node_admin': nodeAdminValue },
  });

  assert.equal(scalar('select internal.is_node_admin()', asOwner('true')), 't', "'true' must grant");
  assert.equal(scalar('select internal.is_node_admin()', asOwner('TRUE')), 't', 'lower() makes it case-insensitive');
  assert.equal(scalar('select internal.is_node_admin()', asOwner('on')), 'f', "'on' must NOT grant (the TS bug)");
  assert.equal(scalar('select internal.is_node_admin()', asOwner('off')), 'f', "'off' must NOT grant");
  assert.equal(scalar('select internal.is_node_admin()', asOwner('1')), 'f', "'1' must NOT grant");
  assert.equal(scalar('select internal.is_node_admin()', asOwner('yes')), 'f', "'yes' must NOT grant");
  assert.equal(scalar('select internal.is_node_admin()', asOwner(undefined)), 'f', 'absent must NOT grant');

  // ...and the same three values through the ONE policy that consumes the claim:
  // projects_select. `identity-f1-plain` is a member of no space, so the linked-space
  // branch of the policy contributes nothing and the claim is the only thing in play.
  ok(`select public.create_project('f1-claimtest', '/tmp/tm8-f1-claimtest', null, 'trusted')`, {
    ...app,
    claims: claimsFor('identity-f1-owner', null, true),
  });
  const seesProjects = (nodeAdminValue) =>
    Number(
      scalar('select count(*) from public.projects', {
        ...app,
        claims:
          nodeAdminValue === undefined
            ? { 'tm8.identity_id': 'identity-f1-plain' }
            : { 'tm8.identity_id': 'identity-f1-plain', 'tm8.node_admin': nodeAdminValue },
      }),
    );
  assert.ok(seesProjects('true') > 0, "projects_select: tm8.node_admin='true' must admit the node admin");
  assert.equal(seesProjects('on'), 0, "projects_select: 'on' must read as NOT node admin");
  assert.equal(seesProjects(undefined), 0, 'projects_select: an absent claim must read as NOT node admin');
});

test('node-admin has TWO sources by design: the claim for reads, the accounts table for writes', () => {
  // WRITE side — internal.require_node_admin() (002:319) resolves is_node_admin
  // from public.accounts. A caller who is not an admin in the TABLE cannot become
  // one by asserting the claim...
  denied(
    'require_node_admin: non-admin account asserting tm8.node_admin=true',
    `select public.create_project('f1-forged-project', '/tmp/tm8-f1-forged')`,
    { ...app, claims: claimsFor('identity-f1-plain', null, true), expect: '42501' },
  );

  // ...and, symmetrically, an account that IS a node admin in the table stays one
  // with the claim explicitly false. The claim is not consulted on this path at all.
  ok(`select public.create_project('f1-table-backed', '/tmp/tm8-f1-table-backed')`, {
    ...app,
    claims: claimsFor('identity-f1-owner', null, false),
  });

  // Two sources, two purposes: do not "unify" them. Collapsing writes onto the
  // claim would make a forged claim a privilege escalation; collapsing reads onto
  // the table would put an accounts lookup in every projects_select row check.
  assert.equal(
    scalar(`select count(*) from public.projects where name = 'f1-table-backed'`, { url: fresh.ownerUrl }),
    '1',
  );
});

test('F2 — claims are transaction-local: they cannot leak into the next transaction', () => {
  // Three statements, one CONNECTION, three transactions. If set_config(...,true)
  // were leaking, statement 3 would see the identity statement 2 bound.
  const res = run(
    `select 'claimed:' || coalesce(internal.identity_id(), '<none>')`,
    { ...app, claims: claimsFor('identity-f1-owner') },
  );
  assert.match(res.stdout, /claimed:identity-f1-owner/);

  const script =
    `begin;\n` +
    `select set_config('tm8.identity_id', 'identity-f1-owner', true);\n` +
    `select 'inside:' || coalesce(internal.identity_id(), '<none>');\n` +
    `commit;\n` +
    `select 'after-commit:' || coalesce(internal.identity_id(), '<none>');\n` +
    `begin;\n` +
    `select 'next-txn:' || coalesce(internal.identity_id(), '<none>');\n` +
    `select count(*) from public.spaces;\n` +
    `commit;\n`;
  const out = ok(script, { ...app, claims: null, singleTransaction: false });
  assert.match(out, /inside:identity-f1-owner/, 'the claim must be readable inside its transaction');
  assert.match(out, /after-commit:<none>/, 'the claim must be gone after commit');
  assert.match(out, /next-txn:<none>/, 'the next transaction must start with no identity');
});
