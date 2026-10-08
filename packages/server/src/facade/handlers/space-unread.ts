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
      // Match the RPC's membership and session-space pin gate. A denied RPC
      // returns no rows, which must never be mistaken for a complete zero.
      const membership = await q.query<{ allowed: boolean }>(
        'select internal.is_space_member($1) as allowed',
        [spaceId],
      );
      if (membership[0]?.allowed !== true) throw new CollabError('forbidden', 'not a member of this space');
      // One call to the existing SECURITY DEFINER RPC, under the same viewer
      // claims as navigation. Bound the wire result in SQL; fetching one extra
      // row makes truncation explicit without a second unread scan.
      // The entity join reapplies current canonical RLS before the bound; the
      // RPC's inlined visibility predicate must not replace current anchor authorization.
      const rows = await q.query<{ anchor_id: string; unread: number }>(
        `select counts.anchor_id, counts.unread from public.unread_counts($1) counts
         join public.entities anchor on anchor.id = counts.anchor_id and anchor.space_id = $1
         order by counts.anchor_id limit $2`,
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
