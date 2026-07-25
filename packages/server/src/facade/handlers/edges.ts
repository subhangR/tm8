/**
 * `edges.create` — the write side of the relationship seam.
 *
 * The reads have rendered edges since the beginning: `connections` groups them
 * by type, `badges.blocked` resolves hard `depends_on` targets, and
 * `state.assignees` comes from `assigned_to`. All of that had no way to be
 * PRODUCED over the API — a read path with no write path is a half-built seam,
 * and it is why the conformance world builder could not construct its
 * narrative.
 *
 * Validation is the database's: `internal.validate_edge` (001:778) checks the
 * type is registered and that the endpoint kinds are legal for it, and
 * `internal.prevent_edge_cycle` refuses a cycle on an acyclic type like
 * `depends_on`. Duplicating any of that here would just create a second,
 * weaker copy that drifts.
 */
import type { CreateEdgeInput } from '@tm8/contract';
import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, commandEnvelope } from '../context.js';
import { toCommandResult, type RpcCommandResult } from './entities.js';

export function edgesCreate(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const input = ctx.body as CreateEdgeInput;

    return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      // `write_edge` is an UPSERT on (src, dst, type): re-linking an existing
      // pair updates its props rather than raising. That is deliberate in the
      // RPC, so `edges.create` is naturally idempotent on the edge identity
      // even without a clientMutationId.
      const raw = await q.rpc<RpcCommandResult>('write_edge', [
        input.srcId,
        input.dstId,
        input.type,
        JSON.stringify(input.props ?? {}),
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
      ]);
      const result = await toCommandResult(q, raw, owner.identityId);
      return { kind: 'json' as const, status: 201, data: result };
    });
  };
}
