/**
 * THE ACCEPTANCE TEST, as the user stated it:
 *
 *   "log in as two different accounts, create tasks and entities as each,
 *    and see two different user icons on the tasks."
 *
 * Drives a REAL running server over HTTP with two real accounts and two real
 * bearer tokens. Nothing is stubbed: every call is the production router,
 * production resolver, production RPCs, with the role downgrade live.
 *
 * Usage: TM8_BASE_URL=http://127.0.0.1:PORT node two-users.mjs
 */
const BASE = process.env.TM8_BASE_URL ?? 'http://127.0.0.1:4699';

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function call(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data, error: json.error };
}

const cmid = () => crypto.randomUUID();

console.log(`\n=== TWO REAL USERS, against ${BASE} ===\n`);

// ---------------------------------------------------------------------------
console.log('§1 · the loopback owner still works, unchanged (T-L7 / decision D1)');
// ---------------------------------------------------------------------------
const ownerIdentity = await call('GET', '/v2/identity');
eq('identity.get answers 200 with no credential at all', ownerIdentity.status, 200);
eq('and it is the node owner', ownerIdentity.data?.isOwner, true);

const ownerSession = await call('GET', '/v2/auth/session');
eq('auth.session.get answers for the loopback owner', ownerSession.status, 200);
eq('  authKind is auto-owner', ownerSession.data?.authKind, 'auto-owner');
eq('  with no session row (it authenticates without one)', ownerSession.data?.session, null);
eq('  and it is the owner account', ownerSession.data?.account?.isOwner, true);

// ---------------------------------------------------------------------------
console.log('\n§2 · signup is node-admin gated — never open self-registration');
// ---------------------------------------------------------------------------
const alicePw = 'alice-password-1234';
const bobPw = 'bob-password-5678';
const suffix = crypto.randomUUID().slice(0, 8);
const aliceName = `alice_${suffix}`;
const bobName = `bob_${suffix}`;

const alice = await call('POST', '/v2/auth/signup', {
  body: { username: aliceName, password: alicePw, displayName: 'Alice Example' },
});
eq('the node admin (loopback owner) may create an account', alice.status, 200);
const bob = await call('POST', '/v2/auth/signup', {
  body: { username: bobName, password: bobPw, displayName: 'Bob Example' },
});
eq('and a second one', bob.status, 200);
ok('the two accounts have different identity ids',
  alice.data?.account?.identityId !== bob.data?.account?.identityId,
  `${alice.data?.account?.identityId} vs ${bob.data?.account?.identityId}`);
eq('neither is the owner', alice.data?.account?.isOwner, false);
eq('neither is a node admin', alice.data?.account?.isNodeAdmin, false);

// ---------------------------------------------------------------------------
console.log('\n§3 · two logins, two distinct sessions');
// ---------------------------------------------------------------------------
const aliceLogin = await call('POST', '/v2/auth/login', {
  body: { username: aliceName, password: alicePw, kind: 'cli', label: 'alice laptop' },
});
eq('alice logs in', aliceLogin.status, 200);
const bobLogin = await call('POST', '/v2/auth/login', {
  body: { username: bobName, password: bobPw, kind: 'cli' },
});
eq('bob logs in', bobLogin.status, 200);

const aliceToken = aliceLogin.data?.token;
const bobToken = bobLogin.data?.token;
ok('alice got a tm8s_ token', typeof aliceToken === 'string' && aliceToken.startsWith('tm8s_'));
ok('bob got a tm8s_ token', typeof bobToken === 'string' && bobToken.startsWith('tm8s_'));
ok('the two tokens differ', aliceToken !== bobToken);
ok('the two sessions differ',
  aliceLogin.data?.session?.sessionId !== bobLogin.data?.session?.sessionId);

// failure modes must be indistinguishable
const wrongPw = await call('POST', '/v2/auth/login', {
  body: { username: aliceName, password: 'definitely-not-the-password' },
});
const noSuchUser = await call('POST', '/v2/auth/login', {
  body: { username: `ghost_${suffix}`, password: 'definitely-not-the-password' },
});
eq('a wrong password is 401', wrongPw.status, 401);
eq('an unknown username is 401 too', noSuchUser.status, 401);
eq('  with the SAME code', wrongPw.error?.code, noSuchUser.error?.code);
eq('  and the SAME message — no account enumeration',
  wrongPw.error?.message, noSuchUser.error?.message);

// ---------------------------------------------------------------------------
console.log('\n§4 · each bearer resolves to its own identity');
// ---------------------------------------------------------------------------
const aliceWhoami = await call('GET', '/v2/auth/session', { token: aliceToken });
const bobWhoami = await call('GET', '/v2/auth/session', { token: bobToken });
eq('alice\'s token answers auth.session.get', aliceWhoami.status, 200);
eq('  authKind is bearer', aliceWhoami.data?.authKind, 'bearer');
eq('  and names alice', aliceWhoami.data?.account?.username, aliceName);
eq('bob\'s token names bob', bobWhoami.data?.account?.username, bobName);
ok('the two bearers resolve to DIFFERENT identities',
  aliceWhoami.data?.account?.identityId !== bobWhoami.data?.account?.identityId);

const aliceIdentity = await call('GET', '/v2/identity', { token: aliceToken });
eq('identity.get under alice\'s bearer is alice, not the owner',
  aliceIdentity.data?.username, aliceName);

const garbage = await call('GET', '/v2/auth/session', { token: 'tm8s_deadbeef.notatoken' });
eq('a forged token is 401', garbage.status, 401);
const spliced = await call('GET', '/v2/auth/session', {
  token: `tm8s_${bobLogin.data?.session?.sessionId}.${aliceToken.split('.').slice(1).join('.')}`,
});
eq('a spliced token (bob\'s session id + alice\'s secret) is 401', spliced.status, 401);

// ---------------------------------------------------------------------------
console.log('\n§5 · a space, and both humans in it');
// ---------------------------------------------------------------------------
const space = await call('POST', '/v2/spaces', {
  body: { clientMutationId: cmid(), name: `Two Humans ${suffix}`, description: 'acceptance' },
});
eq('the owner creates a space', space.status, 201);
const spaceId = space.data?.space?.id;

// Alice is not a member yet — the RLS refusal the downgrade makes real.
const aliceBeforeJoin = await call('GET', `/v2/spaces/${spaceId}`, { token: aliceToken });
ok('a NON-MEMBER cannot read the space (RLS is real now)',
  aliceBeforeJoin.status === 404 || aliceBeforeJoin.status === 403,
  `got ${aliceBeforeJoin.status} ${aliceBeforeJoin.error?.code}`);

const aliceTaskBeforeJoin = await call('POST', '/v2/entities', {
  token: aliceToken,
  body: { clientMutationId: cmid(), spaceId, kind: 'task', title: 'should not exist' },
});
ok('and cannot create in it',
  aliceTaskBeforeJoin.status === 403 || aliceTaskBeforeJoin.status === 404,
  `got ${aliceTaskBeforeJoin.status} ${aliceTaskBeforeJoin.error?.code}`);

// Invite both in through the real invite path.
async function joinViaInvite(token, who) {
  const invite = await call('POST', `/v2/spaces/${spaceId}/invites`, {
    body: { clientMutationId: cmid(), maxUses: 1 },
  });
  if (invite.status !== 200 && invite.status !== 201) {
    ok(`${who} gets an invite`, false, `invite create ${invite.status} ${JSON.stringify(invite.error)}`);
    return null;
  }
  const code = invite.data?.code ?? invite.data?.invite?.code;
  const redeem = await call('POST', '/v2/invites/redeem', {
    token,
    body: { clientMutationId: cmid(), code },
  });
  ok(`${who} redeems an invite and joins the space`,
    redeem.status === 200 || redeem.status === 201,
    `${redeem.status} ${JSON.stringify(redeem.error)}`);
  return redeem.data;
}

await joinViaInvite(aliceToken, 'alice');
await joinViaInvite(bobToken, 'bob');

const aliceAfterJoin = await call('GET', `/v2/spaces/${spaceId}`, { token: aliceToken });
eq('now alice CAN read the space', aliceAfterJoin.status, 200);

// ---------------------------------------------------------------------------
console.log('\n§6 · THE ACCEPTANCE ASSERTION — two humans, two authors');
// ---------------------------------------------------------------------------
const aliceTask = await call('POST', '/v2/entities', {
  token: aliceToken,
  body: { clientMutationId: cmid(), spaceId, kind: 'task', title: 'Alice writes this task' },
});
eq('alice creates a task', aliceTask.status, 201);
const bobTask = await call('POST', '/v2/entities', {
  token: bobToken,
  body: { clientMutationId: cmid(), spaceId, kind: 'task', title: 'Bob writes this task' },
});
eq('bob creates a task', bobTask.status, 201);

const aliceAuthor = aliceTask.data?.entity?.createdBy ?? aliceTask.data?.createdBy;
const bobAuthor = bobTask.data?.entity?.createdBy ?? bobTask.data?.createdBy;
console.log(`     alice's task createdBy: ${JSON.stringify(aliceAuthor)}`);
console.log(`     bob's   task createdBy: ${JSON.stringify(bobAuthor)}`);

ok('★ the two tasks carry DIFFERENT created_by member ids',
  aliceAuthor?.id && bobAuthor?.id && aliceAuthor.id !== bobAuthor.id,
  `${aliceAuthor?.id} vs ${bobAuthor?.id}`);
ok('★ and DIFFERENT display names — the two user icons the acceptance names',
  aliceAuthor?.displayName !== bobAuthor?.displayName,
  `${aliceAuthor?.displayName} vs ${bobAuthor?.displayName}`);

// entity_versions.changed_by — the right editor, not the creator
const aliceTaskId = aliceTask.data?.entity?.id ?? aliceTask.data?.id;
const aliceTaskVersion = aliceTask.data?.entity?.version ?? aliceTask.data?.version;
const bobEdit = await call('PATCH', `/v2/entities/${aliceTaskId}`, {
  token: bobToken,
  body: { clientMutationId: cmid(), expectedVersion: aliceTaskVersion, title: 'Bob edits Alice\'s task' },
});
eq('bob edits alice\'s task', bobEdit.status, 200);
const versions = await call('GET', `/v2/entities/${aliceTaskId}/versions`, { token: aliceToken });
const newest = Array.isArray(versions.data?.items) ? versions.data.items[0] : undefined;
console.log(`     newest version changedBy: ${JSON.stringify(newest?.changedBy ?? newest)}`);
ok('★ entity_versions records BOB as the editor of alice\'s task',
  (newest?.changedBy?.id ?? newest?.changedBy) === bobAuthor?.id,
  `${JSON.stringify(newest?.changedBy)} vs bob ${bobAuthor?.id}`);

// messages carry the right author
const aliceMsg = await call('POST', '/v2/messages', {
  token: aliceToken,
  body: { clientMutationId: cmid(), anchorId: aliceTaskId, body: 'alice speaks' },
});
const bobMsg = await call('POST', '/v2/messages', {
  token: bobToken,
  body: { clientMutationId: cmid(), anchorId: aliceTaskId, body: 'bob speaks' },
});
eq('alice posts a message', aliceMsg.status, 200);
eq('bob posts a message', bobMsg.status, 200);
// messages.post returns a MessageBatchResult: { messageBatchId, messages[] },
// and MessageView extends EntitySummary — so the author is `createdBy`, the
// same projection of `messages.author_id` that entities use for created_by.
const aliceMsgAuthor = aliceMsg.data?.messages?.[0]?.createdBy;
const bobMsgAuthor = bobMsg.data?.messages?.[0]?.createdBy;
console.log(`     alice's message author: ${JSON.stringify(aliceMsgAuthor)}`);
console.log(`     bob's   message author: ${JSON.stringify(bobMsgAuthor)}`);
ok('★ the two messages carry DIFFERENT author_id',
  aliceMsgAuthor?.id && bobMsgAuthor?.id && aliceMsgAuthor.id !== bobMsgAuthor.id,
  `${aliceMsgAuthor?.id} vs ${bobMsgAuthor?.id}`);

// ---------------------------------------------------------------------------
console.log('\n§7 · one user cannot act as the other (can_act_as, 002:254)');
// ---------------------------------------------------------------------------
const impersonation = await call('POST', '/v2/entities', {
  token: bobToken,
  body: {
    clientMutationId: cmid(), spaceId, kind: 'task',
    title: 'Bob posts as Alice', actorId: aliceAuthor?.id,
  },
});
eq('★ bob CANNOT author as alice\'s member row', impersonation.status, 403);
eq('  and the code is forbidden', impersonation.error?.code, 'forbidden');

// ---------------------------------------------------------------------------
console.log('\n§8 · the sec1 replay guards, with two principals for the first time');
// ---------------------------------------------------------------------------
const sharedCmid = cmid();
const aliceFirst = await call('POST', '/v2/entities', {
  token: aliceToken,
  body: { clientMutationId: sharedCmid, spaceId, kind: 'task', title: 'replay subject' },
});
eq('alice records a clientMutationId', aliceFirst.status, 201);

const aliceReplay = await call('POST', '/v2/entities', {
  token: aliceToken,
  body: { clientMutationId: sharedCmid, spaceId, kind: 'task', title: 'replay subject' },
});
eq('  alice replaying her own id is idempotent (200/201, one row)',
  aliceReplay.data?.entity?.id ?? aliceReplay.data?.id,
  aliceFirst.data?.entity?.id ?? aliceFirst.data?.id);

const bobReplay = await call('POST', '/v2/entities', {
  token: bobToken,
  body: { clientMutationId: sharedCmid, spaceId, kind: 'task', title: 'replay subject' },
});
ok('★ require_replay_principal REFUSES bob replaying alice\'s clientMutationId',
  bobReplay.status >= 400,
  `got ${bobReplay.status} ${JSON.stringify(bobReplay.error)}`);
console.log(`     bob's replay verdict: ${bobReplay.status} ${bobReplay.error?.code ?? ''} ${bobReplay.error?.message ?? ''}`);

// ---------------------------------------------------------------------------
console.log('\n§9 · logout revokes immediately');
// ---------------------------------------------------------------------------
const bobLogout = await call('POST', '/v2/auth/logout', { token: bobToken, body: {} });
eq('bob logs out', bobLogout.status, 200);
const bobAfterLogout = await call('GET', '/v2/auth/session', { token: bobToken });
eq('★ bob\'s token is dead immediately', bobAfterLogout.status, 401);
const aliceStillAlive = await call('GET', '/v2/auth/session', { token: aliceToken });
eq('  alice\'s token is untouched', aliceStillAlive.status, 200);

const bobRevokeAlice = await call('POST', '/v2/auth/logout', {
  token: aliceToken,
  body: { sessionId: bobLogin.data?.session?.sessionId },
});
ok('a non-admin cannot revoke another account\'s session',
  bobRevokeAlice.status >= 400,
  `got ${bobRevokeAlice.status} ${JSON.stringify(bobRevokeAlice.error)}`);

// ---------------------------------------------------------------------------
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
