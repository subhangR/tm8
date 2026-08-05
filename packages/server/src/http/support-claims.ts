/**
 * Claims for the SUPPORT TRANSPORTS — the raw-byte routes that are dispatched
 * before the catalog and therefore never get a `RequestContext`.
 *
 * `facade/context.ts` owns `claimsFor`, and every catalog handler must use it;
 * that is a structural guard, not a convention (test/one-identity-path.test.ts
 * explains which two outages it exists because of). It cannot serve here,
 * though: it takes a `RequestContext`, whose first field is the catalog
 * `OperationBinding` this request does not have and must not pretend to have.
 *
 * So the support transports get ONE derivation, here, rather than one apiece.
 * The rule is the same as the catalog's: anonymous is refused, an auto-owner
 * borrows the node owner's identity, and node-admin is granted only when the
 * resolved identity IS the node owner.
 */
import { CollabError } from '@tm8/contract';

import type { DbClaims } from '../db/types.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { RequestIdentity } from './types.js';

export async function supportClaims(
  deps: FacadeDeps,
  identity: RequestIdentity,
  requestId: string,
): Promise<DbClaims> {
  if (identity.kind === 'anonymous') {
    throw new CollabError('unauthenticated', 'authentication is required');
  }
  const owner = await deps.owner();
  const identityId = identity.kind === 'auto-owner' ? owner.identityId : identity.identityId;
  if (!identityId) throw new CollabError('unauthenticated', 'bearer identity is unresolved');
  return {
    identityId,
    nodeAdmin: identityId === owner.identityId ? owner.isNodeAdmin : false,
    requestId,
  };
}
