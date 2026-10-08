import {
  CollabError,
  TaskCancellationObservationsInputSchema,
  type TaskCancellationObservations,
} from '@tm8/contract';

import type { Querier } from '../db/types.js';
import type { OperationHandler } from '../http/types.js';
import { claimsFor, requireUuidParam } from './context.js';
import type { FacadeDeps } from './deps.js';

/** Read under the authenticated caller's transaction claims, never an owner. */
export async function loadTaskCancellationObservations(
  q: Querier,
  spaceId: string,
  taskIds: readonly string[],
): Promise<TaskCancellationObservations> {
  // Bound the helper as well as HTTP; internal callers cannot bypass the limit.
  const input = TaskCancellationObservationsInputSchema.safeParse({ taskIds });
  if (!input.success) throw new CollabError('invalid_input', 'taskIds must contain at most 500 UUIDs');
  const rows = await q.query<{ task_id: string; status_changed_not_after: Date | string }>(
    `select o.task_id, o.status_changed_not_after
       from internal.task_cancellation_observations o
       join public.tasks t on t.entity_id = o.task_id
       join public.entities e on e.id = t.entity_id
      where e.space_id = $1 and e.id = any($2::uuid[])
        and e.kind = 'task' and e.deleted_at is null
        and internal.entity_readable(e.id)
        and t.work_status = 'cancelled' and t.status_changed_at is null
      order by o.task_id`,
    [spaceId, [...new Set(input.data.taskIds)]],
  );
  return {
    schemaVersion: 'tm8.task-cancellation-observations.v1',
    spaceId,
    complete: true,
    facts: rows.map((row) => ({
      taskId: row.task_id,
      statusChangedNotAfter: new Date(row.status_changed_not_after).toISOString(),
    })),
  };
}

export function taskCancellationObservations(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const input = TaskCancellationObservationsInputSchema.safeParse(ctx.body);
    if (!input.success) throw new CollabError('invalid_input', 'invalid cancellation observation request');
    const claims = claimsFor(await deps.owner(), ctx);
    if (!claims.identityId) throw new CollabError('unauthenticated', 'authentication is required');
    return deps.db.tx(claims, async (q) => {
      const members = await q.query<{ entity_id: string }>(
        `select entity_id from public.members where space_id = $1 and identity_id = $2`,
        [spaceId, claims.identityId],
      );
      if (!members.length) throw new CollabError('forbidden', 'not a member of this space');
      return loadTaskCancellationObservations(q, spaceId, input.data.taskIds);
    });
  };
}
