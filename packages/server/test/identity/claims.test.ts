/**
 * R2/T-L11 — claim production.
 *
 * This block produces the name/value pairs; the db layer binds them with
 * `SET LOCAL`. Two properties matter: the emitted set matches 002's RLS helpers
 * exactly and nothing more (Vega ruling — membership is resolved from rows, not
 * from claims), and "no identity" has exactly one shape.
 */

import { describe, expect, it } from 'vitest';
import { makeHarness, SPACE_A, SPACE_B } from './harness.js';
import {
  CLAIM_NAMES,
  anonymousClaimBindings,
  toClaimBindings,
  type ClaimBinding,
} from '../../src/identity/index.js';

function byName(bindings: ClaimBinding[]): Record<string, string> {
  return Object.fromEntries(bindings.map((b) => [b.name, b.value]));
}

describe('claim set (R2/T-L11)', () => {
  /**
   * SEVEN since 992 (W7p). `tm8.via_link` passes the same test:
   * `auth_sessions.via_link_id` is written once by the issuing RPC and no verb
   * updates it, and it only NARROWS (a link-bound caller is refused credential
   * reads), so a stale value could refuse but never admit.
   *
   * SIX since 227 (plan W0a). `tm8.session_space_id` passes the same test as
   * `auth_kind`: `auth_sessions.space_id` is written once by the issuing RPC
   * and no verb updates it, so there is no window in which the claim and the
   * row disagree. It also only NARROWS membership (every helper intersects
   * with it), so a stale value could refuse but never admit.
   *
   * FIVE since 082 (architect ruling R11), not four.
   *
   * The pin moved ON PURPOSE and the reason is recorded rather than assumed:
   * `tm8.auth_kind` carries the auth session's server-resolved kind, and it
   * passes the test that keeps membership OUT of the claims — an auth session's
   * kind is IMMUTABLE for the life of the session, so the staleness window that
   * disqualifies a membership list does not exist for it.
   *
   * It stays an EXACT SET rather than relaxing to "at least these": the whole
   * job of this pin is to make widening the trusted surface cost a decision. A
   * sixth name must move this line again, and must answer "is it immutable?".
   */
  it('emits exactly the seven settings the RLS helpers, 082, 227 and 992 read', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    h.join(owner.identityId, SPACE_A);
    const claims = await h.service.buildClaims({ accountId: owner.id });

    expect(toClaimBindings(claims, 'req_123').map((b) => b.name).sort()).toEqual(
      [
        CLAIM_NAMES.identityId,
        CLAIM_NAMES.actorId,
        CLAIM_NAMES.nodeAdmin,
        CLAIM_NAMES.requestId,
        CLAIM_NAMES.authKind,
        CLAIM_NAMES.sessionSpaceId,
        CLAIM_NAMES.viaLinkId,
      ].sort(),
    );
  });

  /**
   * The kind is FORWARDED, never invented. An omitted kind binds the REFUSING
   * value: `internal.require_human_auth_kind()` fails closed, and a helpful
   * default here would defeat it one layer above where the migration cannot see
   * it.
   */
  it('binds an empty auth_kind when the caller did not state one', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const claims = await h.service.buildClaims({ accountId: owner.id });

    expect(byName(toClaimBindings(claims, 'req_1'))[CLAIM_NAMES.authKind]).toBe('');
    expect(byName(toClaimBindings(claims, 'req_1', 'browser'))[CLAIM_NAMES.authKind]).toBe(
      'browser',
    );
    expect(byName(toClaimBindings(claims, 'req_1', 'agent'))[CLAIM_NAMES.authKind]).toBe('agent');
    expect(
      byName(toClaimBindings(claims, 'req_1', 'agent_runtime'))[CLAIM_NAMES.authKind],
    ).toBe('agent_runtime');
  });

  /** The pin is forwarded, never invented: omitted means unpinned (''). */
  it('binds an empty session_space_id unless the caller supplies the pinned space', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const claims = await h.service.buildClaims({ accountId: owner.id });

    expect(byName(toClaimBindings(claims, 'req_1', 'agent'))[CLAIM_NAMES.sessionSpaceId]).toBe('');
    expect(
      byName(toClaimBindings(claims, 'req_1', 'agent', SPACE_A))[CLAIM_NAMES.sessionSpaceId],
    ).toBe(SPACE_A);
  });

  /** The link is forwarded, never invented: omitted means none (''). */
  it('binds an empty via_link unless the caller supplies the link', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const claims = await h.service.buildClaims({ accountId: owner.id });
    const LINK = '01a0dcdc-0000-7000-8000-000000000992';

    expect(byName(toClaimBindings(claims, 'req_1', 'agent', SPACE_A))[CLAIM_NAMES.viaLinkId]).toBe('');
    expect(
      byName(toClaimBindings(claims, 'req_1', 'agent', SPACE_A, LINK))[CLAIM_NAMES.viaLinkId],
    ).toBe(LINK);
    expect(byName(anonymousClaimBindings('req_1'))[CLAIM_NAMES.viaLinkId]).toBe('');
  });

  it('never binds membership or can_act_as into Postgres', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const member = h.join(owner.identityId, SPACE_A);
    const persona = h.persona(member.id, SPACE_A);
    const claims = await h.service.buildClaims({
      accountId: owner.id,
      actingAsTeamMemberId: persona.id,
    });

    const names = toClaimBindings(claims, 'req_1').map((b) => b.name);
    // Authorization truth lives in rows: a claim-carried membership list goes
    // stale across join/leave/role-change/disable, invisibly.
    expect(names).not.toContain('tm8.member_ids');
    expect(names).not.toContain('tm8.team_member_ids');
    expect(names).not.toContain('tm8.can_act_as');
    expect(names).not.toContain('tm8.acting_as');
    expect(names).not.toContain('tm8.account_id');
    // Five since 082/R11 — see the exact-set pin above. The four `not.toContain`
    // assertions are the load-bearing half of this test and are untouched: what
    // must never appear here is a value that can GO STALE, and `auth_kind`
    // cannot.
    // Six since 227: `session_space_id` is fixed at issue, like `auth_kind`.
    // Seven since 992: `via_link`, the same.
    expect(names).toHaveLength(7);

    // The server-side facts survive — the facade gates capabilities with them.
    expect(claims.memberIds).toEqual([member.id]);
    expect(claims.canActAs).toEqual([persona.id]);
    expect(claims.actingAsTeamMemberId).toBe(persona.id);
  });

  it('carries acting_as through actor_id, not through a separate claim', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const member = h.join(owner.identityId, SPACE_A);
    const persona = h.persona(member.id, SPACE_A);

    const asSelf = byName(toClaimBindings(await h.service.buildClaims({ accountId: owner.id })));
    const asAgent = byName(
      toClaimBindings(
        await h.service.buildClaims({ accountId: owner.id, actingAsTeamMemberId: persona.id }),
      ),
    );

    expect(asSelf[CLAIM_NAMES.actorId]).toBe(member.id);
    expect(asAgent[CLAIM_NAMES.actorId]).toBe(persona.id);
    // Identity is unchanged: authorization still resolves through the owner.
    expect(asAgent[CLAIM_NAMES.identityId]).toBe(asSelf[CLAIM_NAMES.identityId]);
  });

  // The database is the authority here, and it tests for the literal 'true':
  //   001_core_graph.sql:166
  //   select coalesce(lower(internal.claim_text('tm8.node_admin')) = 'true', false)
  // This test used to assert 'on'/'off' and therefore PINNED A BUG: 'on' never
  // equals 'true', so the claim silently read as "not an admin" instead of
  // failing loudly, and 008's projects_select policy hid a node admin's own
  // projects from him. Verified against a live database 2026-07-25.
  it('encodes node_admin as the literal true/false the DB compares against', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    h.join(owner.identityId, SPACE_A);

    const claims = await h.service.buildClaims({ accountId: owner.id });
    expect(byName(toClaimBindings(claims))[CLAIM_NAMES.nodeAdmin]).toBe('true');
    expect(byName(toClaimBindings({ ...claims, isNodeAdmin: false }))[CLAIM_NAMES.nodeAdmin]).toBe('false');
  });

  it('omits request_id when the caller does not supply one', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const claims = await h.service.buildClaims({ accountId: owner.id });

    expect(toClaimBindings(claims).some((b) => b.name === CLAIM_NAMES.requestId)).toBe(false);
    expect(toClaimBindings(claims, 'req_1').some((b) => b.name === CLAIM_NAMES.requestId)).toBe(true);
  });

  it('pins authorship to the requested space', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const a = h.join(owner.identityId, SPACE_A);
    h.clock.advance(1000);
    const b = h.join(owner.identityId, SPACE_B);

    expect((await h.service.buildClaims({ accountId: owner.id, spaceId: SPACE_B })).actorId).toBe(b.id);
    // Unscoped requests author as the oldest membership — the only one on a v1
    // local node.
    expect((await h.service.buildClaims({ accountId: owner.id })).actorId).toBe(a.id);
  });

  it('binds identity even when the account has joined no space', async () => {
    const h = makeHarness();
    const owner = await h.service.bootstrapOwner();
    const claims = await h.service.buildClaims({ accountId: owner.id });

    expect(claims.identityId).toBe(owner.identityId);
    expect(claims.memberIds).toEqual([]);
    // Empty actor_id: identity is bound, every space predicate is false.
    expect(byName(toClaimBindings(claims))[CLAIM_NAMES.actorId]).toBe('');
  });

  it('anonymous bindings assert nothing — the only "no identity" shape', () => {
    const values = byName(anonymousClaimBindings('req_9'));

    expect(values[CLAIM_NAMES.identityId]).toBe('');
    expect(values[CLAIM_NAMES.actorId]).toBe('');
    expect(values[CLAIM_NAMES.nodeAdmin]).toBe('off');
    // "No identity" must also mean "NOT HUMAN". The anonymous shape binds the
    // refusing value explicitly rather than leaving the claim unbound, for the
    // same reason the other three are bound: an unbound claim could in
    // principle be inherited from an earlier statement on the connection.
    expect(values[CLAIM_NAMES.authKind]).toBe('');
    // Unpinned, bound explicitly for the same reason.
    expect(values[CLAIM_NAMES.sessionSpaceId]).toBe('');
    // No link, bound explicitly for the same reason (992).
    expect(values[CLAIM_NAMES.viaLinkId]).toBe('');
    expect(Object.keys(values)).toHaveLength(7);
    // No bypass claim exists to find.
    expect(Object.keys(values).some((n) => /bypass|service_role|superuser/.test(n))).toBe(false);
  });

  it('every claim name is namespaced under tm8.', () => {
    for (const name of Object.values(CLAIM_NAMES)) {
      expect(name).toMatch(/^tm8\.[a-z_]+$/);
    }
  });
});
