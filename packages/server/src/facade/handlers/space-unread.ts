/** A lazy map read. Entity summaries and workspace boot never call this scan. */
import { CollabError, SPACE_UNREAD_COUNTS_LIMIT, type SpaceUnreadCounts } from '@tm8/contract';
import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, requireUuidParam } from '../context.js';

export function spacesUnreadCounts(deps: FacadeDeps): OperationHandler {
  return async (ctx): Promise<SpaceUnreadCounts> => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const claims = claimsFor(await deps.owner(), ctx);
    if (!claims.identityId) throw new CollabError('unauthenticated', 'authentication is required');
    return deps.db.tx(claims, async (q) => {
      const members = await q.query<{ entity_id: string }>(
        'select entity_id from public.members where space_id = $1 and identity_id = $2',
        [spaceId, claims.identityId],
      );
      if (!members[0]) throw new CollabError('forbidden', 'not a member of this space');
      // One call to the existing SECURITY DEFINER RPC, under the same viewer
      // claims as navigation. Bound the wire result in SQL; fetching one extra
      // row makes truncation explicit without a second unread scan.
      const rows = await q.query<{ anchor_id: string; unread: number }>(
        `select anchor_id, unread from public.unread_counts($1)
         order by anchor_id limit $2`,
        [spaceId, SPACE_UNREAD_COUNTS_LIMIT + 1],
      );
      return {
        spaceId,
        counts: rows.slice(0, SPACE_UNREAD_COUNTS_LIMIT).map(row => ({ anchorId: row.anchor_id, unread: Number(row.unread) })),
        complete: rows.length <= SPACE_UNREAD_COUNTS_LIMIT,
      };
    });
  };
}
