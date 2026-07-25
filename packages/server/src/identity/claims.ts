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

/** The complete trusted claim surface. Adding a name here widens what RLS can trust. */
export const CLAIM_NAMES = {
  identityId: 'tm8.identity_id',
  actorId: 'tm8.actor_id',
  nodeAdmin: 'tm8.node_admin',
  requestId: 'tm8.request_id',
} as const;

/** `on`/`off` per 002's `internal.is_node_admin()`. */
function boolClaim(value: boolean): string {
  return value ? 'on' : 'off';
}

/**
 * Project a claim set into `SET LOCAL` bindings.
 *
 * The db layer applies each as `SELECT set_config($1, $2, true)` — `true` = local
 * to the transaction, so claims never leak across pooled connections.
 */
export function toClaimBindings(claims: ClaimSet, requestId?: string): ClaimBinding[] {
  const bindings: ClaimBinding[] = [
    { name: CLAIM_NAMES.identityId, value: claims.identityId },
    { name: CLAIM_NAMES.actorId, value: claims.actorId },
    { name: CLAIM_NAMES.nodeAdmin, value: boolClaim(claims.isNodeAdmin) },
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
  ];
  if (requestId !== undefined) {
    bindings.push({ name: CLAIM_NAMES.requestId, value: requestId });
  }
  return bindings;
}
