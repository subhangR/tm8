/**
 * T-L7 — auth is always on; local is the degenerate case.
 *
 * The property under test is not "local mode works". It is that local mode is
 * the SAME machinery with one row in it: a real account, a real identity, real
 * claims, no second code path and no bypass flag.
 */

import { describe, expect, it } from 'vitest';
import { makeHarness, expectCode, SPACE_A } from './harness.js';
import { toClaimBindings, CLAIM_NAMES } from '../../src/identity/index.js';

describe('auto-owner (T-L7)', () => {
  it('first run creates exactly one owner account', async () => {
    const h = makeHarness();
    expect(await h.repo.countAccounts()).toBe(0);

    const owner = await h.service.bootstrapOwner();

    expect(owner.isOwner).toBe(true);
    expect(owner.isNodeAdmin).toBe(true);
    expect(owner.status).toBe('active');
    expect(owner.identityId).toMatch(/^id_/);
    expect(await h.repo.countAccounts()).toBe(1);
  });

  it('is idempotent — repeat bootstrap returns the same row, never a second owner', async () => {
    const h = makeHarness();
    const first = await h.service.bootstrapOwner();
    const second = await h.service.bootstrapOwner();
    const third = await h.service.bootstrapOwner({ username: 'someone-else' });

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(second.identityId).toBe(first.identityId);
    expect(await h.repo.countAccounts()).toBe(1);
  });

  it('concurrent first runs collapse to one owner', async () => {
    const h = makeHarness();
    // The real guard is `UNIQUE(is_owner) WHERE is_owner` in 002; the in-memory
    // store mirrors it so this test asserts the invariant, not the storage.
    const results = await Promise.all([
      h.service.bootstrapOwner(),
      h.service.bootstrapOwner(),
      h.service.bootstrapOwner(),
      h.service.bootstrapOwner(),
    ]);

    const ids = new Set(results.map((a) => a.id));
    expect(ids.size).toBe(1);
    expect(await h.repo.countAccounts()).toBe(1);
  });

  it('resolveLoopbackOwner bootstraps and returns claims through the normal path', async () => {
    const h = makeHarness();
    const ctx = await h.service.resolveLoopbackOwner();

    expect(ctx.account.isOwner).toBe(true);
    expect(ctx.claims.identityId).toBe(ctx.account.identityId);
    expect(ctx.claims.isNodeAdmin).toBe(true);
    // Auto-auth is identity resolution, not credential issuance: no session row,
    // so an unauthenticated browser request cannot spam auth_sessions.
    expect(ctx.session).toBeNull();
    expect(await h.service.listSessions(ctx.account.id, true)).toEqual([]);
  });

  it('produces the same claim shape as a token-authenticated request', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner({ password: 'correct-horse' });
    const member = h.join(owner.identityId, SPACE_A);

    const loopback = await h.service.resolveLoopbackOwner();
    const viaPassword = await h.service.authenticate({
      username: 'owner',
      password: 'correct-horse',
    });
    const viaToken = await h.service.verifyToken(viaPassword.token);

    // One code path: whichever door you come through, the claims are identical.
    expect(loopback.claims).toEqual(viaToken.claims);
    expect(loopback.claims.actorId).toBe(member.id);
  });

  it('a disabled owner is not silently resurrected by auto-auth', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    await h.service.disableAccount(owner.id);

    await expectCode(h.service.resolveLoopbackOwner(), 'unauthenticated');
  });

  it('binds identity_id as a required claim on the loopback path', async () => {
    const h = makeHarness();
    const ctx = await h.service.resolveLoopbackOwner();
    const bindings = toClaimBindings(ctx.claims);

    const identity = bindings.find((b) => b.name === CLAIM_NAMES.identityId);
    expect(identity?.value).toBe(ctx.account.identityId);
    // No bypass claim exists to find.
    expect(bindings.some((b) => /bypass|service_role|superuser/.test(b.name))).toBe(false);
  });
});
