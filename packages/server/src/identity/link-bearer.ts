/**
 * 992 (W7p, lead ruling A'): a `link` session spawns nothing.
 *
 * A space link's stored session is the linking human's full membership of the
 * target space, so it must never launch, resume or read a spawn credential on
 * its own bearer. `execution.spawn`, `execution.resume` and the spawn reader
 * (`SpaceCredentialStore.readForSpawn`) refuse it first, and SQL
 * `read_space_credential_for_spawn` refuses `tm8.auth_kind = 'link'` again.
 *
 * An agent minted under a link (authKind `agent`, `viaLinkId` set) is NOT a
 * link bearer and is not refused here; its link-bound rules apply instead.
 * The only exception, `spaceLinks.invoke`, arrives with #884 and carries its
 * own marker; until then nothing admits a link bearer to a spawn.
 */
import { CollabError } from '@tm8/contract';
import type { DbClaims } from '../db/types.js';

export const LINK_BEARER_SPAWN_REFUSED = 'a space link session cannot spawn, resume or read a spawn credential';

export function refuseLinkBearer(claims: Pick<DbClaims, 'authKind'>): void {
  if (claims.authKind === 'link') {
    throw new CollabError('forbidden', LINK_BEARER_SPAWN_REFUSED, { details: { sqlstate: '42501' } });
  }
}
