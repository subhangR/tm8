/** Shared teammates — agents act as themselves; space membership authorizes use. */

import { describe, expect, it } from 'vitest';
import { makeHarness, expectCode, SPACE_A, SPACE_B } from './harness.js';

describe('can_act_as resolution (shared teammates/S8)', () => {
  it('resolves every persona in a space this identity has joined', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const member = h.join(owner.identityId, SPACE_A);
    const mine = h.persona(member.id, SPACE_A);
    const alsoMine = h.persona(member.id, SPACE_A);

    const theirMember = h.join('id_someone-else', SPACE_A);
    const theirs = h.persona(theirMember.id, SPACE_A);

    const canActAs = await h.service.listCanActAs(owner.identityId);
    expect(canActAs.sort()).toEqual([mine.id, alsoMine.id, theirs.id].sort());
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

  it('node-admin does NOT grant teammate authority outside joined spaces', async () => {
    const h = makeHarness();
    const admin = await h.service.bootstrapOwner();
    expect(admin.isNodeAdmin).toBe(true);
    h.join(admin.identityId, SPACE_A);

    const strangerMember = h.join('id_stranger', SPACE_B);
    const strangersPersona = h.persona(strangerMember.id, SPACE_B);

    // Node-level roles (accounts, invites, limits) and space-level roles are
    // never mixed — being node admin buys no authorship rights in another
    // space. Shared authority comes from membership, not the node role.
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
    // Persona ownership still has lifecycle meaning: removing the owning member
    // cascades the persona, so there is no shared actor left to resolve.
    expect(await h.service.canActAs(owner.identityId, persona.id)).toBe(false);
  });

  it('agent sessions must name a persona', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    h.join(owner.identityId, SPACE_A);

    // An unscoped token would carry the launching human's authority into the
    // shell instead of staying pinned to one shared teammate.
    await expectCode(
      h.service.issueSession({ accountId: owner.id, kind: 'agent' }),
      'invalid_input',
    );
  });

  it('refuses agent_runtime issuance through the legacy un-attributed session path', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const member = h.join(owner.identityId, SPACE_A);
    const persona = h.persona(member.id, SPACE_A);

    await expectCode(
      h.service.issueSession({
        accountId: owner.id,
        kind: 'agent_runtime',
        actingAsTeamMemberId: persona.id,
      }),
      'invalid_input',
    );
  });

  it('allows an agent session scoped to another member\'s persona in the same space', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    h.join(owner.identityId, SPACE_A);
    const strangerMember = h.join('id_stranger', SPACE_A);
    const strangersPersona = h.persona(strangerMember.id, SPACE_A);

    const issued = await h.service.issueSession({
      accountId: owner.id,
      kind: 'agent',
      actingAsTeamMemberId: strangersPersona.id,
    });
    expect(issued.session.actingAsTeamMemberId).toBe(strangersPersona.id);
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

  it('an agent token authors as the persona while authorizing through the launcher\'s membership', async () => {
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
    // ...authorization remains the launching human's identity and memberships.
    expect(ctx.claims.identityId).toBe(owner.identityId);
    expect(ctx.claims.memberIds).toEqual([member.id]);
  });

  it('an agent token stops working the moment its launching account is disabled', async () => {
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
