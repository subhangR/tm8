/**
 * Claim production (R2 / T-L11).
 *
 * This module turns an authenticated identity into the name/value pairs the db
 * layer binds with `SET LOCAL` at the top of every transaction. It is the whole
 * of the identity block's contact with authorization-in-Postgres: we produce
 * claims, the db layer applies them, RLS reads them. Nothing here opens a
 * connection, holds a credential, or mints a JWT.
 *
 * THE TRUSTED SURFACE IS FOUR SETTINGS, and that is deliberate (Vega ruling
 * 2026-07-25, W1b): `tm8.identity_id`, `tm8.actor_id`, `tm8.node_admin`,
 * `tm8.request_id`. Membership and `can_act_as` are NOT claims — 008's policies
 * resolve them from `members`/`team_members` via `internal.is_space_member()`,
 * `internal.is_space_admin()` and `internal.can_act_as()`.
 *
 * Why not ship the id lists too: a claim-carried membership list is whatever the
 * server believed at claim-assembly time. Every path that changes membership
 * (join, leave, role change, invite redeem, account disable) then has a window
 * where the claim disagrees with the rows — and the disagreement is invisible,
 * because RLS happily answers from the claim. Authorization truth lives in rows.
 *
 * `ClaimSet` still carries `memberIds`/`teamMemberIds`/`canActAs` — the facade
 * needs them server-side for capability gating and to verify `acting_as` before
 * it is bound. They are a pre-check and a UX input. They are not authority, and
 * they never reach Postgres.
 */

import type { ClaimSet } from './types.js';

export interface ClaimBinding {
  /** Postgres custom GUC name, e.g. `tm8.identity_id`. */
  name: string;
  value: string;
}

/**
 * The complete trusted claim surface. Adding a name here widens what RLS can
 * trust.
 *
 * `authKind` joined it in 082 (architect ruling R11). The test that admitted it
 * is IMMUTABILITY, not usefulness: the header above rejects membership because
 * every membership-changing verb opens a window where the claim disagrees with
 * the rows. An auth session's kind is fixed at issue and no verb changes it, so
 * that window does not exist. Apply the same test to a sixth.
 */
export const CLAIM_NAMES = {
  identityId: 'tm8.identity_id',
  actorId: 'tm8.actor_id',
  nodeAdmin: 'tm8.node_admin',
  requestId: 'tm8.request_id',
  authKind: 'tm8.auth_kind',
} as const;

/**
 * `true`/`false` — the literal strings `internal.is_node_admin()` tests for.
 *
 * 001_core_graph.sql:166 is the authority:
 *     select coalesce(lower(internal.claim_text('tm8.node_admin')) = 'true', false)
 * This previously emitted `on`/`off` (and cited 002, where the function does not
 * live), which meant the claim could never grant node-admin — `'on' = 'true'` is
 * false, so it silently degraded to "not an admin" instead of failing loudly.
 * Caught by Deneb against a live database, 2026-07-25.
 *
 * The blast radius was narrow only by luck: `internal.require_node_admin()`
 * reads the accounts TABLE rather than this claim, so the command path worked.
 * The one consumer that does read it is 008's projects_select policy — so a
 * node admin could not SELECT a project outside his own spaces.
 */
function boolClaim(value: boolean): string {
  return value ? 'true' : 'false';
}

/**
 * Project a claim set into `SET LOCAL` bindings.
 *
 * The db layer applies each as `SELECT set_config($1, $2, true)` — `true` = local
 * to the transaction, so claims never leak across pooled connections.
 */
export function toClaimBindings(
  claims: ClaimSet,
  requestId?: string,
  /**
   * The auth session's kind, when the caller knows it. OMITTED means "not
   * stated", which `internal.require_human_auth_kind()` refuses — see
   * `anonymousClaimBindings` for why the refusing value is bound explicitly
   * rather than left unbound.
   */
  authKind?: string,
): ClaimBinding[] {
  const bindings: ClaimBinding[] = [
    { name: CLAIM_NAMES.identityId, value: claims.identityId },
    { name: CLAIM_NAMES.actorId, value: claims.actorId },
    { name: CLAIM_NAMES.nodeAdmin, value: boolClaim(claims.isNodeAdmin) },
    { name: CLAIM_NAMES.authKind, value: authKind ?? '' },
  ];
  if (requestId !== undefined) {
    bindings.push({ name: CLAIM_NAMES.requestId, value: requestId });
  }
  return bindings;
}

/**
 * The anonymous binding: identity unset. 002's helpers return false for every
 * predicate, so reads see zero rows and write RPCs raise 28000. There is no
 * bypass flag and no client-asserted identity — this is the only "no identity"
 * shape that exists (T-L11).
 */
export function anonymousClaimBindings(requestId?: string): ClaimBinding[] {
  const bindings: ClaimBinding[] = [
    { name: CLAIM_NAMES.identityId, value: '' },
    { name: CLAIM_NAMES.actorId, value: '' },
    { name: CLAIM_NAMES.nodeAdmin, value: 'off' },
    // Bound to the refusing value rather than left unbound, for the same reason
    // the three above are: an unbound claim could in principle be inherited,
    // and "no identity" must mean "not human" as well as "nobody".
    { name: CLAIM_NAMES.authKind, value: '' },
  ];
  if (requestId !== undefined) {
    bindings.push({ name: CLAIM_NAMES.requestId, value: requestId });
  }
  return bindings;
}
