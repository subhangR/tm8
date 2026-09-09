import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { LocalGithubAuth } from '../../src/workspaces/github-auth.js';
import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import type { RequestContext, JsonResult } from '../../src/http/types.js';
import { ScryptPasswordHasher } from '../../src/identity/crypto.js';
import { loginWithPassword, resolveBearerIdentity, issueNodeClaimToken, nodeIsClaimed, claimTokenIsLive } from '../../src/identity/pg-auth.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ hookTimeout: 180000, testTimeout: 30000 });
describe('standalone GitHub identity proof', () => {
  let scratch: W1ScratchDatabase, db: Db, auth: LocalGithubAuth;
  let sessionId: string, accountId: string, identityId: string;
  let githubId = 12345;
  const requests: string[] = [];
  const context = (body = {}, headers = {}, query = new URLSearchParams(), authenticated = false) => ({
    body, headers, query, identity: authenticated ? { kind: 'bearer', authKind: 'browser', sessionId } : { kind: 'anonymous' },
  }) as unknown as RequestContext;
  async function flow(intent: 'login' | 'link' = 'login', invitationCode?: string) {
    const result = await auth.start(context({ intent, ...(invitationCode ? { invitationCode } : {}) }, {}, new URLSearchParams(), intent === 'link')) as JsonResult;
    const url = new URL((result.data as { url: string }).url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).not.toContain('repo');
    const cookie = result.headers!['set-cookie']!.split(';')[0]!;
    return context({}, { cookie }, new URLSearchParams({ state: url.searchParams.get('state')!, code: 'github-test-code' }));
  }
  beforeAll(async () => {
    scratch = await createW1ScratchDatabase('github_auth'); scratch.apply(migrationFiles()); db = createDb(scratch.url);
    identityId = randomUUID();
    await db.rpc({}, 'ensure_account', [identityId, 'github-owner', 'Owner', 'same@example.test', true, true, 'scrypt', await new ScryptPasswordHasher().hash('workspace-password-123!')]);
    const login = await loginWithPassword(db, { username: 'github-owner', password: 'workspace-password-123!' });
    sessionId = login.session.sessionId; accountId = login.account.accountId;
    auth = new LocalGithubAuth('client', 'secret', 'https://node.example.test', scratch.url, (async (url: string) => {
      requests.push(url);
      return Response.json(url.endsWith('access_token') ? { access_token: 'provider-token' } : url.endsWith('/emails')
        ? [{ email: 'same@example.test', verified: true, primary: true }] : { id: githubId, login: 'github-user', name: 'GitHub User' });
    }) as typeof fetch);
  });
  afterAll(async () => { await auth?.close(); await db?.end(); await scratch?.destroy(); });
  it('refuses email matching without an explicit linking session', async () => {
    await expect(auth.callback(await flow())).rejects.toThrow('Use an invitation');
  });
  it('requires matching browser state before spending the provider code', async () => {
    const ctx = await flow(); const before = requests.length;
    await expect(auth.callback({ ...ctx, headers: {} })).rejects.toThrow('state');
    expect(requests).toHaveLength(before);
  });
  it('links from a live human session, then logs into the same account without a password', async () => {
    const ctx = await flow('link'); const response = await auth.callback(ctx);
    expect(response.status).toBe(303); expect(response.headers['set-cookie']).toContain('HttpOnly');
    const token = response.headers['set-cookie']!.split(';')[0]!.split('=')[1]!;
    expect((await resolveBearerIdentity(db, token)).accountId).toBe(accountId);
    await expect(auth.callback(ctx)).rejects.toThrow('already used');
    expect((await auth.callback(await flow())).status).toBe(303);
  });
  it('refuses a linking session revoked during the OAuth round trip', async () => {
    const ctx = await flow('link'); githubId = 67890;
    await scratch.query('update public.auth_sessions set revoked_at=now() where id=$1', [sessionId]);
    await expect(auth.callback(ctx)).rejects.toThrow('linking session expired');
  });
  it('keeps provider bindings and flow verifiers inaccessible to the app database role', async () => {
    await expect(db.rpc({}, 'consume_local_github_flow', ['anything'])).rejects.toThrow();
    await expect(db.query({}, 'select * from public.local_github_accounts')).rejects.toThrow();
  });
  it('enrolls an invited GitHub user with its own account and existing space membership', async () => {
    const claims = { identityId, nodeAdmin: true, authKind: 'browser' };
    const space = await db.rpc<{ space: { id: string } }>(claims, 'create_space', ['GitHub invitation', '', 'private', null, randomUUID()]);
    const invite = await db.rpc<{ invite: { code: string } }>(claims, 'create_invite', [space.space.id, 1, null, null, randomUUID(), 'member']);
    githubId = 99999;
    const response = await auth.callback(await flow('login', invite.invite.code));
    const token = response.headers['set-cookie']!.split(';')[0]!.split('=')[1]!;
    const user = await resolveBearerIdentity(db, token);
    expect(user.accountId).not.toBe(accountId);
    expect((await scratch.query('select password_hash from public.accounts where id=$1', [user.accountId]))[0]!.password_hash).toBeNull();
    expect(await db.query({ identityId: user.identityId, authKind: 'browser' }, 'select id from public.spaces where id=$1', [space.space.id])).toHaveLength(1);
    githubId = 99998;
    await expect(auth.callback(await flow('login', invite.invite.code))).rejects.toThrow();
  });
});

it('claims the existing owner through GitHub without creating a password or permitting another claim', async () => {
  const scratch = await createW1ScratchDatabase('github_first_owner');
  const db = createDb(scratch.url);
  let subject = 7654321;
  const auth = new LocalGithubAuth('client', 'secret', 'https://node.example.test', scratch.url, (async (url: string) => Response.json(
    url.endsWith('access_token') ? { access_token: 'test-provider-token' } : url.endsWith('/emails')
      ? [{ email: 'first@example.test', verified: true, primary: true }] : { id: subject, login: 'first-github' }
  )) as typeof fetch);
  try {
    scratch.apply(migrationFiles());
    const identityId = randomUUID();
    await db.rpc({}, 'ensure_account', [identityId, 'unclaimed-owner', 'Owner', null, true, true, null, null]);
    const claimToken = await issueNodeClaimToken(db);
    const callback = async () => {
      const start = await auth.start({ body: { claimToken }, identity: { kind: 'anonymous' } } as RequestContext) as JsonResult;
      const state = new URL((start.data as { url: string }).url).searchParams.get('state')!;
      return auth.callback({ headers: { cookie: start.headers!['set-cookie']!.split(';')[0] }, query: new URLSearchParams({ state, code: 'test-code' }) } as RequestContext);
    };
    const response = await callback();
    const token = response.headers['set-cookie']!.split(';')[0]!.split('=')[1]!;
    expect((await resolveBearerIdentity(db, token)).identityId).toBe(identityId);
    expect(await nodeIsClaimed(db)).toBe(true); expect(await claimTokenIsLive(db, claimToken)).toBe(false);
    expect((await scratch.query('select password_hash from accounts where identity_id=$1', [identityId]))[0]!.password_hash).toBeNull();
    subject++;
    await expect(callback()).rejects.toThrow('already claimed');
    await scratch.query("update accounts set status='disabled',disabled_at=now() where identity_id=$1", [identityId]);
    expect(await nodeIsClaimed(db)).toBe(true);
  } finally { await auth.close(); await db.end(); await scratch.destroy(); }
});
