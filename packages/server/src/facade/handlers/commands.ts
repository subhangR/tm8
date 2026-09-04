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
import type { CompleteTaskInput, GateTaskInput, WorkInput } from '@tm8/contract';
import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../context.js';
import { enrichVersionConflict, toCommandResult, type RpcCommandResult } from './entities.js';
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
        // `note` is THREE-STATE in the contract — `schemas.ts:976` declares
        // `note: z.string().nullable().optional()`, so absent, explicit null
        // and a value are three distinct inputs that all validate.
        //
        // The RPC discriminates them with a SEVENTH argument. Per `037:75-82`
        // and the merge at `037:119-124`, `p_clear_note` WINS over `p_note`,
        // and `p_note` NULL means "fall back to the stored value". So
        // `?? null` is the RIGHT binding for `p_note` — but only BECAUSE the
        // seventh argument now carries the distinction. Passing six arguments
        // collapsed absent and explicit-null onto the preserve branch, and an
        // explicit clear returned 200 having done nothing.
        //
        // MEASURED, not reasoned: against a real Server on staged chains, this
        // same request CLEARED the note at chain 036 and silently preserved it
        // at chain 037, from a proven non-null starting value. This RESTORES a
        // capability that demonstrably worked, rather than adding a new one.
        // No migration could have fixed one input without breaking the other,
        // because both collapsed to one wire value UPSTREAM of SQL.
        //
        // NOTE THE POSITION: `p_clear_note` is the seventh parameter, AFTER
        // `p_client_mutation_id` — not adjacent to `p_note`.
        input.note ?? null,
        envelope.clientMutationId ?? null,
        input.note === null,
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

    /**
     * ONE OPERATION, TWO DOORS — user ruling 2026-08-19, "tick marks the
     * session done, but does not close it".
     *
     * `complete` means the same thing on both kinds at the level a user cares
     * about ("I am finished with this row"), so it stays ONE operation rather
     * than growing a second catalog entry for the session case. What differs is
     * entirely below the seam:
     *
     *   task          `complete_task` — checks acceptance criteria, awards
     *                 points, writes `tasks.work_status = 'done'`.
     *   work_session  `set_session_done` — moves the ENVELOPE only. The process
     *                 is untouched: the PTY keeps running and the terminal keeps
     *                 streaming. It is also a TOGGLE, which `complete_task` is
     *                 not, because a session you filed away is one you meant to
     *                 come back to.
     *
     * The kind read costs one indexed lookup on the row this command is about
     * to write anyway. The alternative — teaching `complete_task` a session arm
     * — would put "and it does not actually complete anything" inside a function
     * whose name is a promise, and both doors' preconditions would then live in
     * one body with two unrelated failure modes.
     *
     * `input.completerIds` IS DROPPED on the session path, and that is not an
     * oversight. The schema requires at least one and the client sends the
     * viewer, so nothing has to change on the wire — but a session has no
     * completion to credit and no points to award, and inventing a `completed`
     * edge for "I filed this away" would put a claim in the graph that the
     * ruling does not make. The actor is already recorded on the activity row.
     *
     * The kind read and the RPC are in ONE transaction with the write, so a
     * session that is somehow deleted between the two cannot route a task RPC
     * at a missing row: `live_entity` inside the door refuses it either way.
     */
    const run = (): Promise<unknown> =>
      deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
        const rows = await q.query<{ kind: string }>(
          'select kind from public.entities where id = $1',
          [id],
        );
        const raw = rows[0]?.kind === 'work_session'
          ? await q.rpc<RpcCommandResult>('set_session_done', [
              id,
              input.expectedVersion,
              envelope.actorId ?? null,
              envelope.clientMutationId ?? null,
            ])
          : await q.rpc<RpcCommandResult>('complete_task', [
              id,
              input.expectedVersion,
              input.completerIds ?? [],
              envelope.actorId ?? null,
              envelope.clientMutationId ?? null,
            ]);
        return toCommandResult(q, raw, owner.identityId);
      });

    try {
      return await run();
    } catch (err) {
      // complete_task asserts the version too, so it conflicts the same way a
      // patch does and owes the client the same `current`.
      throw await enrichVersionConflict(deps, ctx, id, err);
    }
  };
}

/**
 * `entities.commands.gate` — 082's opt-in completion gate. The rule lives in
 * the RPC pair (set_task_gate stores the flag; complete_task enforces it), so
 * this handler only binds the input, exactly like `commandsComplete` above.
 */
export function commandsGate(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as GateTaskInput;

    const run = (): Promise<unknown> =>
      deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
        const raw = await q.rpc<RpcCommandResult>('set_task_gate', [
          id,
          input.expectedVersion,
          input.gate,
          envelope.actorId ?? null,
          envelope.clientMutationId ?? null,
        ]);
        return toCommandResult(q, raw, owner.identityId);
      });

    try {
      return await run();
    } catch (err) {
      // set_task_gate asserts the version, so it owes the same `current` a
      // patch conflict does.
      throw await enrichVersionConflict(deps, ctx, id, err);
    }
  };
}

/**
 * `entities.points.add` — the award ledger's manual entry point.
 *
 * Two rules are the RPC's and stay there: points go only to a `member` or
 * `team_member` (007:1577), and the grant is idempotent on
 * `client_event_id` — so a retried grant does not pay twice. The counter on
 * the entity is a trigger-maintained cache of the ledger, never written here.
 */
export function entitiesPointsAdd(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as { amount: number; reason?: string; referenceId?: string };

    return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<RpcCommandResult>('grant_points', [
        id,
        input.amount,
        input.reason ?? 'grant',
        input.referenceId ?? null,
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
