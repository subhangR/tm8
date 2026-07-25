/**
 * The closed kind-command namespace (02 §3.2): `/commands/work` and
 * `/commands/complete`.
 *
 * These are separate operations rather than patches because they carry rules a
 * uniform patch cannot express, and the rules live in the RPC where they are
 * unreachable rather than merely discouraged:
 *
 *   - `set_work_state` REFUSES `done` (007:1894). Completion has a gate, and
 *     routing around it via a status write is exactly what that refusal stops.
 *   - `complete_task` checks every acceptance criterion, writes the
 *     `completed_by` edges and pays the point award in ONE transaction
 *     (007:1807), keyed so a retry cannot pay twice.
 *
 * So the handler's whole job is to bind the input and let the database be the
 * authority. Any validation added here would be a second, weaker copy.
 */
import type { CompleteTaskInput, WorkInput } from '@tm8/contract';
import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../context.js';
import { toCommandResult, type RpcCommandResult } from './entities.js';
import { loadActivity } from './activity.js';

export function commandsWork(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as WorkInput;

    return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<RpcCommandResult>('set_work_state', [
        id,
        input.status,
        envelope.actorId ?? null,
        input.startedAt ?? null,
        input.note ?? null,
        envelope.clientMutationId ?? null,
      ]);
      return toCommandResult(q, raw, owner.identityId);
    });
  };
}

export function commandsComplete(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as CompleteTaskInput;

    return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<RpcCommandResult>('complete_task', [
        id,
        input.expectedVersion,
        input.completerIds ?? [],
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
      ]);
      return toCommandResult(q, raw, owner.identityId);
    });
  };
}

/** `entities.activity` — the lazy history section of an entity page. */
export function entitiesActivity(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const limitRaw = ctx.query.get('limit');
    const cursor = ctx.query.get('cursor');

    return deps.db.tx(claimsFor(owner, ctx), (q) =>
      loadActivity(q, {
        entityId: id,
        ...(limitRaw ? { limit: Number.parseInt(limitRaw, 10) } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    );
  };
}
