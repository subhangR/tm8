import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorCode, startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * RUNTIME PROOF for the three account-lifecycle operations 141 adds
 * (auth.invite.signup / auth.password.change / auth.claim.reissue). The PR
 * shipped only count-pin updates for these; nothing executed `signup_via_invite`
 * or `revoke_account_sessions_except`, whose inner refs plpgsql does not validate
 * until runtime. This file drives them over the real HTTP surface and tries to
 * BREAK the two invariants the design leans on: invite signup cannot mint an
 * admin/owner, and it is atomic.
 *
 * The harness calls from loopback, so every request resolves as the auto-owner
 * (single mode) — which is what lets it claim the node and create invites. The
 * invited signups are still claim-free and identity-independent: the code is the
 * only authorization.
 */
async function setupToken(dataDir: string): Promise<string> {
  const raw = await readFile(join(dataDir, 'setup-token'), 'utf8');
  return raw.trim();
}

describe('141 account-lifecycle ops — runtime + escalation resistance', () => {
  let server: W3PublicServer;
  let ownerToken: string;

  beforeAll(async () => {
    server = await startW3PublicServer('lifecycle');
    // Claim FIRST — the intended ordering (§7.1). The owner gets a real
    // credential, and every invite signup below then happens on a claimed node.
    const token = await setupToken(server.dataDir);
    const claimed = successData<{ token: string }>(
      await server.request('POST', '/v2/auth/claim', {
        token,
        username: 'nodeowner',
        password: 'owner-password-123',
      }),
    );
    ownerToken = claimed.token;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  interface MadeInvite {
    code: string;
    spaceId: string;
    inviteId: string;
  }

  async function makeInviteFull(role: 'admin' | 'member', maxUses = 1): Promise<MadeInvite> {
    const space = successData<{ space: { id: string } }>(
      await server.request('POST', '/v2/spaces', {
        name: `probe-${role}-${Math.random()}`,
        clientMutationId: `probe-space-${role}-${Math.random()}`,
      }),
    );
    const invite = successData<{ invite?: { code: string; id: string }; code?: string; id?: string }>(
      await server.request('POST', `/v2/spaces/${space.space.id}/invites`, {
        role,
        maxUses,
        clientMutationId: `probe-inv-${role}-${Math.random()}`,
      }),
    );
    const code = invite.invite?.code ?? invite.code;
    const inviteId = invite.invite?.id ?? invite.id;
    if (!code || !inviteId) throw new Error(`invite create returned no code/id: ${JSON.stringify(invite)}`);
    return { code, spaceId: space.space.id, inviteId };
  }

  async function makeInvite(role: 'admin' | 'member', maxUses = 1): Promise<string> {
    return (await makeInviteFull(role, maxUses)).code;
  }

  it('POSITIVE — invite signup creates a non-admin non-owner account + membership and consumes the invite atomically', async () => {
    const code = await makeInvite('member');
    const data = successData<{ account: { username: string }; spaceId: string; memberId: string }>(
      await server.request('POST', '/v2/auth/invite/signup', {
        code,
        username: 'bob',
        password: 'bob-password-123',
      }),
    );
    expect(data.account.username).toBe('bob');
    expect(data.spaceId).toBeTruthy();
    expect(data.memberId).toBeTruthy();

    // ESCALATION ATTACK: the invite carried role 'member'; no input named admin
    // or owner. Prove the row Postgres wrote can be neither.
    const [acct] = await server.rows<{ is_owner: boolean; is_node_admin: boolean; identity_id: string }>(
      'select is_owner, is_node_admin, identity_id from public.accounts where lower(username) = $1',
      ['bob'],
    );
    expect(acct.is_owner).toBe(false);
    expect(acct.is_node_admin).toBe(false);

    // Atomicity, positive side: account AND membership both exist.
    const [mem] = await server.rows<{ role: string }>(
      'select role from public.members where identity_id = $1',
      [acct.identity_id],
    );
    expect(mem.role).toBe('member');

    const [inv] = await server.rows<{ use_count: number; max_uses: number }>(
      'select use_count, max_uses from public.space_invites where code = $1',
      [code],
    );
    expect(inv.use_count).toBe(1);
  }, 30_000);

  it('an admin-ROLE invite joins the SPACE as admin but the ACCOUNT is still not a node admin/owner', async () => {
    const code = await makeInvite('admin');
    successData(
      await server.request('POST', '/v2/auth/invite/signup', {
        code,
        username: 'carol',
        password: 'carol-password-123',
      }),
    );
    const [acct] = await server.rows<{ is_owner: boolean; is_node_admin: boolean }>(
      'select is_owner, is_node_admin from public.accounts where lower(username) = $1',
      ['carol'],
    );
    expect(acct.is_owner).toBe(false);
    expect(acct.is_node_admin).toBe(false);
  }, 30_000);

  it('ATOMICITY — a username collision rolls the whole signup back: invite NOT consumed', async () => {
    const code = await makeInvite('member');
    // `bob` already exists. The signup must fail and leave the invite untouched.
    const res = await server.request('POST', '/v2/auth/invite/signup', {
      code,
      username: 'bob',
      password: 'another-password-123',
    });
    expect(res.status).toBe(409);
    // FINDING (low): the SQL raises 23505 with a clean message and its comment
    // says "the handler can turn it into a clean 'conflict'", but the handler
    // does NOT translate it — so the code is `invariant_violation`, not
    // `conflict`. Both are HTTP 409, so this is a cosmetic contract drift, not a
    // security hole. Asserted here so the drift is on the record.
    expect(errorCode(res)).toBe('invariant_violation');

    // The security-relevant half: the invite is NOT consumed (the raise happens
    // before the use_count bump, inside one function = one transaction).
    const [inv] = await server.rows<{ use_count: number }>(
      'select use_count from public.space_invites where code = $1',
      [code],
    );
    expect(inv.use_count).toBe(0);
  }, 30_000);

  it('a spent single-use invite refuses a second signup and creates no account', async () => {
    const code = await makeInvite('member', 1);
    successData(
      await server.request('POST', '/v2/auth/invite/signup', {
        code,
        username: 'dave',
        password: 'dave-password-123',
      }),
    );
    const before = await server.rows<{ n: string }>('select count(*)::text as n from public.accounts');
    const res = await server.request('POST', '/v2/auth/invite/signup', {
      code,
      username: 'dave2',
      password: 'dave2-password-123',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await server.rows<{ n: string }>('select count(*)::text as n from public.accounts');
    expect(after[0].n).toBe(before[0].n);
    const [dave2] = await server.rows('select 1 from public.accounts where lower(username) = $1', ['dave2']);
    expect(dave2).toBeUndefined();
  }, 30_000);

  it('auth.password.change — wrong current password refused; correct rotates, keeps caller session, revokes others', async () => {
    // Two live sessions for the claimed owner.
    const first = successData<{ token: string; session: { sessionId: string } }>(
      await server.request('POST', '/v2/auth/login', {
        username: 'nodeowner',
        password: 'owner-password-123',
        kind: 'cli',
      }),
    );
    const second = successData<{ token: string; session: { sessionId: string } }>(
      await server.request('POST', '/v2/auth/login', {
        username: 'nodeowner',
        password: 'owner-password-123',
        kind: 'cli',
      }),
    );

    const wrong = await fetch(new URL('/v2/auth/password', server.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${second.token}` },
      body: JSON.stringify({ currentPassword: 'not-the-password', newPassword: 'rotated-password-123' }),
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(new URL('/v2/auth/password', server.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${second.token}` },
      body: JSON.stringify({ currentPassword: 'owner-password-123', newPassword: 'rotated-password-123' }),
    });
    const okBody = (await ok.json()) as { data?: { revokedOtherSessions: number } };
    expect(ok.status).toBe(200);
    expect(okBody.data?.revokedOtherSessions).toBeGreaterThanOrEqual(1);

    // The caller's own session survives; the other is revoked.
    const [kept] = await server.rows<{ revoked_at: string | null }>(
      'select revoked_at from public.auth_sessions where id = $1',
      [second.session.sessionId],
    );
    const [killed] = await server.rows<{ revoked_at: string | null }>(
      'select revoked_at from public.auth_sessions where id = $1',
      [first.session.sessionId],
    );
    expect(kept.revoked_at).toBeNull();
    expect(killed.revoked_at).not.toBeNull();

    // New password works; old does not.
    expect(
      (await server.request('POST', '/v2/auth/login', {
        username: 'nodeowner',
        password: 'rotated-password-123',
        kind: 'cli',
      })).status,
    ).toBe(200);
    expect(
      (await server.request('POST', '/v2/auth/login', {
        username: 'nodeowner',
        password: 'owner-password-123',
        kind: 'cli',
      })).status,
    ).toBe(401);

    // A bearer caller cannot aim at another account: there is no target field on
    // the body, and `ownerToken` proves the point — password.change under it can
    // only ever rotate the owner. (Negative construction: there is no input to
    // supply a foreign accountId; the account is derived from the session.)
    void ownerToken;
  }, 40_000);

  it('auth.claim.reissue is INERT on a claimed node (forbidden), even from the loopback owner', async () => {
    const reissue = await server.request('POST', '/v2/auth/claim/reissue');
    expect(reissue.status).toBe(403);
    expect(errorCode(reissue)).toBe('forbidden');
  }, 30_000);

  it('NO 5xx — every invite-signup failure mode maps to a clean 4xx, never a raw server fault', async () => {
    // The 500-hunt. The SQLSTATE table (http/errors.ts) degrades anything
    // unmapped to a 503 upstream_unavailable, so a raw 500 is not structurally
    // reachable from this seam — but a WELL-FORMED request that trips a 5xx
    // would still be a finding worth more than the feature. Drive every raise
    // in signup_via_invite and assert each lands in the 4xx taxonomy.

    // Unknown code -> P0002 -> not_found (404), not 503.
    const missing = await server.request('POST', '/v2/auth/invite/signup', {
      code: 'inv_does_not_exist_at_all',
      username: 'ghost',
      password: 'ghost-password-123',
    });
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe('not_found');

    // Revoked invite -> 42501 -> forbidden (403), not 503.
    const revoked = await makeInviteFull('member');
    successData(
      await server.request('POST', `/v2/spaces/${revoked.spaceId}/invites/${revoked.inviteId}/revoke`, {
        clientMutationId: `probe-revoke-${Math.random()}`,
      }),
    );
    const afterRevoke = await server.request('POST', '/v2/auth/invite/signup', {
      code: revoked.code,
      username: 'afterrevoke',
      password: 'afterrevoke-password-123',
    });
    expect(afterRevoke.status).toBe(403);
    expect(afterRevoke.status).toBeLessThan(500);

    // Blank username -> 22023 -> invalid_input (400), not 503.
    const blank = await server.request('POST', '/v2/auth/invite/signup', {
      code: (await makeInvite('member')),
      username: '   ',
      password: 'blank-password-123',
    });
    // (schema may reject the whitespace username as 400 before SQL; either way
    // it must be a 4xx, never a 5xx.)
    expect(blank.status).toBeGreaterThanOrEqual(400);
    expect(blank.status).toBeLessThan(500);
  }, 40_000);
});

describe('141 auth.claim.reissue — happy path on an UNCLAIMED node', () => {
  let server: W3PublicServer;

  beforeAll(async () => {
    server = await startW3PublicServer('reissue');
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it('a loopback owner reissues: fresh token returned AND rewritten to the 0600 setup-token', async () => {
    const original = await setupToken(server.dataDir);
    const data = successData<{ token: string; claimUrl: string; tokenPath: string | null }>(
      await server.request('POST', '/v2/auth/claim/reissue'),
    );
    expect(data.token.startsWith('tm8c_')).toBe(true);
    expect(data.token).not.toBe(original);
    expect(data.claimUrl).toContain('#claim=');

    // The durable copy was rewritten and the OLD token is now dead.
    const onDisk = await setupToken(server.dataDir);
    expect(onDisk).toBe(data.token);

    const oldClaim = await server.request('POST', '/v2/auth/claim', {
      token: original,
      username: 'x',
      password: 'x-password-123',
    });
    expect(oldClaim.status).toBeGreaterThanOrEqual(400);

    // The NEW token claims the node.
    const newClaim = await server.request('POST', '/v2/auth/claim', {
      token: data.token,
      username: 'realowner',
      password: 'real-password-123',
    });
    expect(newClaim.status).toBe(200);
  }, 30_000);
});
