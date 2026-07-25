/**
 * R6 — account lifecycle minimums: recovery, revocation, re-key compatibility.
 *
 * The load-bearing one is revocation: disabling an account must kill its
 * sessions while leaving the member entity and every authored row alone. The
 * graph is a historical record of who acted; deleting history to deactivate a
 * login would rewrite it.
 */

import { describe, expect, it } from 'vitest';
import { makeHarness, expectCode, SPACE_A } from './harness.js';

describe('account lifecycle (R6)', () => {
  it('revocation kills every live session in one act', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const member = h.join(owner.identityId, SPACE_A);
    const persona = h.persona(member.id, SPACE_A);

    const browser = await h.service.issueSession({ accountId: owner.id, kind: 'browser' });
    const cli = await h.service.issueSession({ accountId: owner.id, kind: 'cli' });
    const agent = await h.service.issueSession({
      accountId: owner.id,
      kind: 'agent',
      actingAsTeamMemberId: persona.id,
    });

    await h.service.disableAccount(owner.id);

    for (const token of [browser.token, cli.token, agent.token]) {
      await expectCode(h.service.verifyToken(token), 'unauthenticated');
    }
    expect(await h.service.listSessions(owner.id)).toEqual([]);
  });

  it('revocation leaves the member entity and personas intact', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const member = h.join(owner.identityId, SPACE_A);
    const persona = h.persona(member.id, SPACE_A);

    await h.service.disableAccount(owner.id);

    // Authored history is attributed to these rows; deactivating a login must
    // not erase who did the work.
    expect(await h.repo.getMember(member.id)).not.toBeNull();
    expect(await h.repo.getTeamMember(persona.id)).not.toBeNull();
    const scope = await h.repo.getActorScope(owner.identityId);
    expect(scope.members).toHaveLength(1);
    expect(scope.teamMembers).toHaveLength(1);
  });

  it('a disabled account cannot authenticate or build claims', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner({ password: 'hunter2hunter2' });
    await h.service.disableAccount(owner.id);

    await expectCode(
      h.service.authenticate({ username: 'owner', password: 'hunter2hunter2' }),
      'unauthenticated',
    );
    await expectCode(h.service.buildClaims({ accountId: owner.id }), 'unauthenticated');
  });

  it('re-enabling restores login without minting a new identity', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner({ password: 'hunter2hunter2' });
    await h.service.disableAccount(owner.id);
    const restored = await h.service.enableAccount(owner.id);

    expect(restored.status).toBe('active');
    expect(restored.disabledAt).toBeNull();
    // The opaque id is immutable: authored history stays attributed.
    expect(restored.identityId).toBe(owner.identityId);
    await expect(
      h.service.authenticate({ username: 'owner', password: 'hunter2hunter2' }),
    ).resolves.toBeDefined();
  });

  it('a node admin resets another account credentials', async () => {
    const h = makeHarness();
    const admin = await h.service.bootstrapOwner();
    const user = await h.repo.ensureAccount({
      id: 'acct-user',
      identityId: 'id_user',
      username: 'dana',
      displayName: 'Dana',
      isNodeAdmin: false,
      isOwner: false,
      passwordHash: null,
      passwordAlgorithm: null,
      createdAt: h.clock.now(),
    });

    await h.service.resetCredentials({
      actingAccountId: admin.id,
      targetAccountId: user.id,
      newPassword: 'a-new-password',
    });

    const ctx = await h.service.authenticate({ username: 'dana', password: 'a-new-password' });
    expect(ctx.account.id).toBe(user.id);
  });

  it('a reset invalidates the outstanding sessions it exists to respond to', async () => {
    const h = makeHarness();
    const admin = await h.service.bootstrapOwner();
    const stolen = await h.service.issueSession({ accountId: admin.id, kind: 'cli' });

    await h.service.resetCredentials({
      actingAccountId: admin.id,
      targetAccountId: admin.id,
      newPassword: 'brand-new-password',
    });

    await expectCode(h.service.verifyToken(stolen.token), 'unauthenticated');
  });

  it('a non-admin cannot reset someone else credentials', async () => {
    const h = makeHarness();
    await h.service.bootstrapOwner();
    const dana = await h.repo.ensureAccount({
      id: 'acct-dana', identityId: 'id_dana', username: 'dana', displayName: 'Dana',
      isNodeAdmin: false, isOwner: false, passwordHash: null, passwordAlgorithm: null,
      createdAt: h.clock.now(),
    });
    const eli = await h.repo.ensureAccount({
      id: 'acct-eli', identityId: 'id_eli', username: 'eli', displayName: 'Eli',
      isNodeAdmin: false, isOwner: false, passwordHash: null, passwordAlgorithm: null,
      createdAt: h.clock.now(),
    });

    await expectCode(
      h.service.resetCredentials({
        actingAccountId: dana.id,
        targetAccountId: eli.id,
        newPassword: 'not-your-account',
      }),
      'forbidden',
    );
  });

  it('a disabled admin cannot reset anything', async () => {
    const h = makeHarness();
    const admin = await h.service.bootstrapOwner();
    await h.service.disableAccount(admin.id);

    await expectCode(
      h.service.resetCredentials({
        actingAccountId: admin.id,
        targetAccountId: admin.id,
        newPassword: 'still-no',
      }),
      'forbidden',
    );
  });

  it('rejects a too-short password', async () => {
    const h = makeHarness();
    const admin = await h.service.bootstrapOwner();
    await expectCode(
      h.service.resetCredentials({
        actingAccountId: admin.id,
        targetAccountId: admin.id,
        newPassword: 'short',
      }),
      'invalid_input',
    );
  });

  it('identity_id is opaque and carries no name (R6 re-key compatibility)', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner({
      username: 'ada',
      displayName: 'Ada Lovelace',
    });

    // `user@server` must be able to layer on later without rekeying
    // user_profiles, so the id may not encode the login or the display name.
    expect(owner.identityId).not.toContain('ada');
    expect(owner.identityId.toLowerCase()).not.toContain('lovelace');
    expect(owner.identityId).toMatch(/^id_/);
  });
});
