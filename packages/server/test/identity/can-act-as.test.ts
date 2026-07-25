/**
 * T-L7 — agents act as themselves; authorization resolves through their owner.
 *
 * The escalation this guards against: an agent token that can act as a persona
 * someone else owns, or that quietly widens into the owner's full authority.
 */

import { describe, expect, it } from 'vitest';
import { makeHarness, expectCode, SPACE_A, SPACE_B } from './harness.js';

describe('can_act_as resolution (T-L7/S8)', () => {
  it('resolves exactly the personas owned by this identity', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const member = h.join(owner.identityId, SPACE_A);
    const mine = h.persona(member.id, SPACE_A);
    const alsoMine = h.persona(member.id, SPACE_A);

    const theirMember = h.join('id_someone-else', SPACE_A);
    const theirs = h.persona(theirMember.id, SPACE_A);

    const canActAs = await h.service.listCanActAs(owner.identityId);
    expect(canActAs.sort()).toEqual([mine.id, alsoMine.id].sort());
    expect(canActAs).not.toContain(theirs.id);
  });

  it('spans every space the identity is a member of', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const inA = h.join(owner.identityId, SPACE_A);
    const inB = h.join(owner.identityId, SPACE_B);
    const personaA = h.persona(inA.id, SPACE_A);
    const personaB = h.persona(inB.id, SPACE_B);

    const canActAs = await h.service.listCanActAs(owner.identityId);
    expect(canActAs.sort()).toEqual([personaA.id, personaB.id].sort());
  });

  it('node-admin does NOT widen can_act_as', async () => {
    const h = makeHarness();
    const admin = await h.service.bootstrapOwner();
    expect(admin.isNodeAdmin).toBe(true);
    h.join(admin.identityId, SPACE_A);

    const strangerMember = h.join('id_stranger', SPACE_A);
    const strangersPersona = h.persona(strangerMember.id, SPACE_A);

    // Node-level roles (accounts, invites, limits) and space-level roles are
    // never mixed — being node admin buys no authorship rights over someone
    // else's agent.
    expect(await h.service.canActAs(admin.identityId, strangersPersona.id)).toBe(false);
    await expectCode(
      h.service.buildClaims({ accountId: admin.id, actingAsTeamMemberId: strangersPersona.id }),
      'forbidden',
    );
  });

  it('an orphaned persona (owner left the space) is no longer actable', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const member = h.join(owner.identityId, SPACE_A);
    const persona = h.persona(member.id, SPACE_A);
    expect(await h.service.canActAs(owner.identityId, persona.id)).toBe(true);

    h.repo.removeMember(member.id);
    // Authorization resolves through the owner's member row; remove the row and
    // the persona is not reachable by anyone.
    expect(await h.service.canActAs(owner.identityId, persona.id)).toBe(false);
  });

  it('agent sessions must name a persona', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    h.join(owner.identityId, SPACE_A);

    // An unscoped agent token would carry the owner's full authority into a
    // spawned shell — the exact escalation S13 forbids.
    await expectCode(
      h.service.issueSession({ accountId: owner.id, kind: 'agent' }),
      'invalid_input',
    );
  });

  it('refuses an agent session scoped to a persona the account does not own', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    h.join(owner.identityId, SPACE_A);
    const strangerMember = h.join('id_stranger', SPACE_A);
    const strangersPersona = h.persona(strangerMember.id, SPACE_A);

    await expectCode(
      h.service.issueSession({
        accountId: owner.id,
        kind: 'agent',
        actingAsTeamMemberId: strangersPersona.id,
      }),
      'forbidden',
    );
  });

  it('distinguishes a missing persona from an unauthorized one at issue time', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    h.join(owner.identityId, SPACE_A);

    await expectCode(
      h.service.issueSession({
        accountId: owner.id,
        kind: 'agent',
        actingAsTeamMemberId: 'tm-does-not-exist',
      }),
      'not_found',
    );
  });

  it('an agent token authors as the persona while authorizing through the owner', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const member = h.join(owner.identityId, SPACE_A);
    const persona = h.persona(member.id, SPACE_A);

    const { token } = await h.service.issueSession({
      accountId: owner.id,
      kind: 'agent',
      actingAsTeamMemberId: persona.id,
    });
    const ctx = await h.service.verifyToken(token);

    // Authorship is the agent...
    expect(ctx.claims.actorId).toBe(persona.id);
    expect(ctx.claims.actingAsTeamMemberId).toBe(persona.id);
    // ...authorization is still the owner's identity and the owner's memberships.
    expect(ctx.claims.identityId).toBe(owner.identityId);
    expect(ctx.claims.memberIds).toEqual([member.id]);
  });

  it('an agent token stops working the moment its owner is disabled', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const member = h.join(owner.identityId, SPACE_A);
    const persona = h.persona(member.id, SPACE_A);
    const { token } = await h.service.issueSession({
      accountId: owner.id,
      kind: 'agent',
      actingAsTeamMemberId: persona.id,
    });

    await h.service.disableAccount(owner.id);
    await expectCode(h.service.verifyToken(token), 'unauthenticated');
  });
});
