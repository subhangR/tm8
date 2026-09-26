/**
 * The relay's name -> base URL lookup (W8, 991), lifted out of `main.ts` so a
 * test drives the same code the relay runs.
 *
 * THE CALLER'S claims, never the owner's (G1). A bearer carries its own
 * identity and admin bit; the auto-owner IS the owner. It reads
 * `server_directory`: a home member reaches a server entity their space holds,
 * and 044's RLS still admits node admins only to an unadopted 044 row. Names
 * are unique per space, not per node: two matches refuse.
 */
import type { Db } from '../db/types.js';
import type { ServerConnectionTargetResolver } from '../http/remote-proxy.js';
import type { LoopbackOwner } from '../identity/loopback.js';

export function directoryTargetResolver(db: Db, owner: () => Promise<LoopbackOwner>): ServerConnectionTargetResolver {
  return async (name, caller) => {
    const nodeOwner = await owner();
    const bearer = caller.kind === 'bearer' ? caller : undefined;
    if (bearer && !bearer.identityId) return null;
    const rows = await db.query<{ base_url: string }>(
      {
        identityId: bearer ? bearer.identityId! : nodeOwner.identityId,
        nodeAdmin: bearer ? bearer.nodeAdmin === true : nodeOwner.isNodeAdmin,
        ...(caller.authKind ? { authKind: caller.authKind } : {}),
      },
      `select base_url from public.server_directory where lower(name) = lower($1) limit 2`,
      [name],
    );
    return rows.length === 1 ? rows[0]!.base_url : null;
  };
}
