/**
 * `entities.refs.*` (migration 279, lane L3; owner decisions D3, D7).
 *
 * A reference is a row in home space A naming an entity in target space B.
 * It is never an edge (D3), and it is made only through the caller's OWN
 * signed-in space link (D7):
 *
 *   1. the A entity's space is read under the caller's claims (RLS);
 *   2. the caller's own link row is resolved (260) and must be signed_in;
 *   3. B's entity is read THROUGH that link with `entities.get` via
 *      `spaceLinks.invoke` — every guard of the invoke path applies, and the
 *      read writes its audit row in A. A reference therefore only ever names
 *      something the caller could read in B;
 *   4. `add_cross_space_ref` re-checks the link row in SQL and stores the
 *      kind and title snapshot that read returned.
 *
 * `list` resolves each reference live only when the VIEWER can read B's
 * entity directly; otherwise it carries the snapshot alone.
 */
import {
  CROSS_SPACE_REF_LINK_INACTIVE,
  CROSS_SPACE_REF_NO_LINK,
  CollabError,
  CrossSpaceRefAddInputSchema,
  isCollabError,
  type CrossSpaceRef,
  type CrossSpaceRefRemoved,
  type EntityDetail,
  type SpaceLinksInvokeResult,
} from '@tm8/contract';

import type { DbClaims } from '../../../db/types.js';
import type { OperationHandler, RequestContext } from '../../../http/types.js';
import type { DbSpaceLinkStore } from '../../../credentials/space-link-store.js';
import { requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';

export function createCrossSpaceRefHandlers(
  deps: FacadeDeps,
  store: DbSpaceLinkStore,
  claimsOf: (ctx: RequestContext) => Promise<DbClaims>,
  invoke: OperationHandler,
): { list: OperationHandler; add: OperationHandler; remove: OperationHandler } {
  const list: OperationHandler = async (ctx): Promise<CrossSpaceRef[]> =>
    deps.db.rpc<CrossSpaceRef[]>(await claimsOf(ctx), 'list_cross_space_refs', [requireUuidParam(ctx, 'id')]);

  const add: OperationHandler = async (ctx): Promise<CrossSpaceRef> => {
    const entityId = requireUuidParam(ctx, 'id');
    const { link, targetEntityId } = CrossSpaceRefAddInputSchema.parse(ctx.body);
    const claims = await claimsOf(ctx);

    // 1. A: the referencing entity, as the caller can see it.
    const rows = await deps.db.query<{ space_id: string }>(claims,
      'select space_id from public.entities where id = $1 and deleted_at is null', [entityId]);
    const homeSpaceId = rows[0]?.space_id;
    if (!homeSpaceId) throw new CollabError('not_found', 'entity not found');

    // 2. D7: the caller's own row, signed in. No row is no link.
    let row;
    try {
      row = await store.resolveInvoke(claims, homeSpaceId, link);
    } catch (error) {
      if (isCollabError(error) && (error.code === 'not_found' || error.details?.['sqlstate'] === 'P0002')) {
        throw new CollabError('forbidden',
          `no space link ${JSON.stringify(link)} from this entity's space for your member: a cross-space reference needs one (ask your human to run \`tm8 link add\`)`,
          { details: { reason: CROSS_SPACE_REF_NO_LINK } });
      }
      throw error;
    }
    if (row.status !== 'signed_in') {
      throw new CollabError('forbidden',
        `space link ${JSON.stringify(link)} is ${row.status}: ask your human to sign in to it (\`tm8 link login\`)`,
        { details: { reason: CROSS_SPACE_REF_LINK_INACTIVE, status: row.status } });
    }

    // 3. B: read the target through the link, as the member, audited in A.
    const read = await invoke({
      ...ctx,
      params: { spaceId: homeSpaceId, link: row.linkId },
      query: new URLSearchParams(),
      body: { op: 'entities.get', params: { id: targetEntityId } },
    }) as SpaceLinksInvokeResult;
    const target = read.result as Partial<EntityDetail> | null;
    if (!target || target.id !== targetEntityId || typeof target.kind !== 'string'
      || (target.spaceId !== undefined && target.spaceId !== row.targetSpaceId)) {
      throw new CollabError('not_found', 'the target entity is not in the linked space');
    }

    // 4. Store it in A; SQL re-checks the link row (D7).
    return deps.db.rpc<CrossSpaceRef>(claims, 'add_cross_space_ref', [
      entityId, row.linkId, targetEntityId, target.kind, typeof target.title === 'string' ? target.title : '',
    ]);
  };

  const remove: OperationHandler = async (ctx): Promise<CrossSpaceRefRemoved> =>
    deps.db.rpc<CrossSpaceRefRemoved>(await claimsOf(ctx), 'remove_cross_space_ref', [
      requireUuidParam(ctx, 'id'), requireUuidParam(ctx, 'refId'),
    ]);

  return { list, add, remove };
}
