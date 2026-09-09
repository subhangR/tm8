import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Directory } from '../src/directory.mjs';
import { migrate, bootstrapAdmin } from '../src/migrate.mjs';
import { createControlServer } from '../src/server.mjs';
import { SupabaseAuth } from '../src/auth.mjs';
import { importDirectory } from '../src/import.mjs';

// Each invocation owns a separate database. Never truncate a configured service DB.
const base = process.env.TM8_TEST_DATABASE_URL;
const name = `tm8_directory_test_${randomUUID().replaceAll('-', '')}`;
let adminPool, pool, directory, adminToken;
const verified = email => {
  const subject = BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 12)).toString();
  return { id: randomUUID(), email, email_confirmed_at: new Date().toISOString(), tm8Method: 'github', tm8GithubSubject: subject,
    identities: [{ provider: 'github', identity_data: { sub: subject } }] };
};
before(async () => {
  if (!base) return;
  adminPool = new pg.Pool({ connectionString: base });
  await adminPool.query(`create database ${name}`);
  const url = new URL(base); url.pathname = `/${name}`;
  pool = new pg.Pool({ connectionString: url.href, max: 30 });
  await migrate(pool); await migrate(pool);
  directory = new Directory(pool);
  const code = await bootstrapAdmin(pool, 'admin@example.test');
  adminToken = (await directory.login(verified('admin@example.test'), code)).token;
});
after(async () => {
  await pool?.end();
  if (adminPool) { await adminPool.query(`drop database ${name}`); await adminPool.end(); }
});
const integration = (name, fn) => test(name, { skip: !base && 'Set TM8_TEST_DATABASE_URL to a PostgreSQL admin connection' }, fn);

integration('invite-only identity linking, no email-based implicit merge', async () => {
  await assert.rejects(directory.login(verified('stranger@example.test')), /invitation_required/);
  const invite = await directory.invite(adminToken, 'alice@example.test');
  await assert.rejects(directory.login(verified('mallory@example.test'), invite.code), /invalid_invitation/);
  const alice = verified('alice@example.test');
  const first = await directory.login(alice, invite.code);
  const second = await directory.login(alice);
  assert.equal(first.accountId, second.accountId);
  await assert.rejects(directory.login(verified('alice@example.test'), invite.code), /invalid_invitation/);
  await assert.rejects(bootstrapAdmin(pool, 'another@example.test'), /already exists/);
});
integration('concurrent reservations never exceed capacity, repeats stay assigned', async () => {
  const machine = await directory.registerMachine(adminToken, { name: 'capacity', publicOrigin: 'https://capacity.example.test', provider: 'aws', capacity: 2 });
  await directory.heartbeat(machine.id, machine.enrollmentCredential);
  const tokens = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const email = `capacity-${i}@example.test`; const invite = await directory.invite(adminToken, email);
    return (await directory.login(verified(email), invite.code)).token;
  }));
  const settled = await Promise.allSettled(tokens.map(token => directory.allocate(token)));
  const success = settled.filter(result => result.status === 'fulfilled');
  // SKIP LOCKED can report temporarily unavailable under contention; retry.
  for (let i = 0; i < tokens.length; i++) if (settled[i].status === 'rejected') {
    try { settled[i] = { status: 'fulfilled', value: await directory.allocate(tokens[i]) }; } catch (error) { assert.equal(error.code, 'waiting_for_capacity'); }
  }
  assert.ok(success.length <= 2);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 2);
  const index = settled.findIndex(result => result.status === 'fulfilled');
  const retry = await Promise.all(Array.from({ length: 12 }, () => directory.allocate(tokens[index])));
  assert.ok(retry.every(item => item.workspace_id === settled[index].value.workspace_id));
  assert.equal((await directory.listMachines(adminToken)).find(item => item.id === machine.id).allocated, 2);
  await assert.rejects(directory.configureMachine(adminToken, machine.id, 1, false), /capacity_below/);
});
integration('handoffs are single-use, machine-bound, expiring and revoked with central sessions', async () => {
  const machine = await directory.registerMachine(adminToken, { name: 'handoff', publicOrigin: 'https://handoff.example.test', provider: 'azure', capacity: 3 });
  await directory.heartbeat(machine.id, machine.enrollmentCredential);
  const invite = await directory.invite(adminToken, 'handoff@example.test', machine.id);
  const token = (await directory.login(verified('handoff@example.test'), invite.code)).token;
  const assignment = await directory.allocate(token);
  const other = await directory.registerMachine(adminToken, { name: 'other', publicOrigin: 'https://other.example.test', provider: 'local', capacity: 1 });
  const { redirectUrl } = await directory.issueHandoff(token);
  const code = new URLSearchParams(new URL(redirectUrl).hash.slice(1)).get('code');
  await assert.rejects(directory.redeemHandoff(other.id, other.enrollmentCredential, code), /invalid_handoff/);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => directory.redeemHandoff(machine.id, machine.enrollmentCredential, code)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const session = results.find(result => result.status === 'fulfilled').value;
  assert.equal(session.workspace_id, assignment.workspace_id);
  assert.equal((await directory.lease(machine.id, machine.enrollmentCredential, session.session_id)).leaseSeconds, 30);
  await assert.rejects(directory.invite(adminToken, 'handoff@example.test', other.id), /cross_machine/);
  const next = await directory.issueHandoff(token);
  await pool.query("update tm8_directory.handoffs set expires_at=now()-interval '1 second' where redeemed_at is null");
  await assert.rejects(directory.redeemHandoff(machine.id, machine.enrollmentCredential, new URLSearchParams(new URL(next.redirectUrl).hash.slice(1)).get('code')), /invalid_handoff/);
  await directory.logout(token);
  await assert.rejects(directory.lease(machine.id, machine.enrollmentCredential, session.session_id), /authorization_revoked/);
});
integration('HTTP login CSRF is rejected and browser cookies are HttpOnly', async () => {
  const invite = await directory.invite(adminToken, 'http@example.test');
  const server = createControlServer({ directory, auth: { finishGithub: async (state, code) => { assert.equal(state, 'test-flow'); assert.equal(code, 'test-code'); return { user: verified('http@example.test'), invitationCode: invite.code }; } }, publicOrigin: 'http://127.0.0.1:4620' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const blocked = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(blocked.status, 403);
    const machines = await fetch(`${url}/api/machines`);
    assert.equal(machines.status, 401);
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
    for (const path of ['/auth/login','/auth/signup','/auth/reset','/auth/password','/auth/exchange']) {
      const blocked = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4620' }, body: '{}' });
      assert.equal(blocked.status, 403); assert.equal((await blocked.json()).error.code, 'github_authentication_required');
    }
    const login = await fetch(url + '/auth/callback?code=test-code', { headers: { cookie: 'tm8_flow=test-flow' }, redirect: 'manual' });
    assert.equal(login.status, 303); assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.doesNotMatch(await login.text(), /token/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

integration('Supabase automatic email linking does not authorize an unlinked GitHub identity', async () => {
  const user = verified('explicit-link@example.test');
  const password = await directory.login(user, (await directory.invite(adminToken, user.email)).code);
  await pool.query('update tm8_directory.accounts set github_subject=null where id=$1', [password.accountId]);
  const github = { ...user, tm8Method: 'github', tm8GithubSubject: '345678' };
  await assert.rejects(directory.login(github), /github_account_link_required/);
  const parent = await directory.session(password.token);
  const linked = await directory.login(github, null, parent.session_id);
  assert.equal(linked.accountId, password.accountId);
  assert.equal((await directory.login(github)).accountId, password.accountId);
  await directory.logout(password.token);
  await assert.rejects(directory.login(github, null, parent.session_id), /explicit_link_session_required/);
});

integration('GitHub PKCE is single-use and other sign-in methods are refused', async () => {
  const user = verified('github-pkce@example.test');
  const invitation = await directory.invite(adminToken, user.email);
  const auth = new SupabaseAuth({ url: 'https://project.supabase.co', key: 'test-public-key', publicOrigin: 'https://login.example.test', pool,
    fetchImpl: async url => url.includes('/token?') ? Response.json({ access_token: 'provider-private-token' }) : Response.json(user) });
  const flow = await auth.startGithub(invitation.code);
  const query = new URL(flow.url).searchParams;
  assert.equal(query.get('provider'), 'github'); assert.equal(query.get('code_challenge_method'), 's256');
  const completed = await auth.finishGithub(flow.state, 'code');
  assert.equal(completed.user.tm8Method, 'github');
  assert.ok((await directory.login(completed.user, completed.invitationCode)).token);
  await assert.rejects(auth.finishGithub(flow.state, 'code'), /invalid_auth_flow/);
  await assert.rejects(directory.login({ ...user, tm8Method: 'password' }), /github_authentication_required/);
  await assert.rejects(directory.login({ ...user, tm8Method: 'email' }), /github_authentication_required/);
  assert.throws(() => auth.githubIdentity({ ...user, identities: [{ provider: 'google' }] }), /github_identity_required/);
});

integration('directory migration preserves existing IDs and never merges on email or duplicates reservations', async () => {
  const machineId = randomUUID();
  const machine = await directory.registerMachine(adminToken, { machineId, name: 'Imported node', publicOrigin: 'https://imported.example.test', provider: 'local', capacity: 2 });
  assert.equal(machine.id, machineId);
  const account = { id: randomUUID(), identityId: 'legacy-identity-kept', email: 'legacy@example.test', workspaceId: randomUUID(), operationId: randomUUID() };
  const manifest = { version: 1, machineId, accounts: [account] };
  await importDirectory(pool, manifest); await importDirectory(pool, manifest);
  const row = (await pool.query('select * from tm8_directory.accounts where id=$1', [account.id])).rows[0];
  assert.equal(row.identity_id, account.identityId); assert.equal(row.auth_subject, null); assert.equal(row.status, 'invited');
  assert.equal((await directory.listMachines(adminToken)).find(value => value.id === machineId).allocated, 1);
  await assert.rejects(importDirectory(pool, { ...manifest, accounts: [{ ...account, identityId: 'different-identity' }] }), /conflicts/);
  await assert.rejects(importDirectory(pool, { ...manifest, accounts: [{ ...account, id: randomUUID(), identityId: 'different-identity' }] }));
  assert.equal((await directory.listMachines(adminToken)).find(value => value.id === machineId).allocated, 1);
});
