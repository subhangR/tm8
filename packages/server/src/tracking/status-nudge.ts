import type { ResultWarning } from '@tm8/contract';
import type { Querier } from '../db/types.js';

/**
 * The status nudge (task P0g, ac4): a session that posts results or links code
 * on a task it holds in `working` gets a reminder to move the status, in the
 * command's own result. The owner's choice (form 01a111ba-85b5, 6 Oct 2026) is a
 * CLI notice and nothing more: no attention, no message, no status change.
 *
 * The audit behind it (doc 01a111b7-3ab4): 35 finished tasks still `working`,
 * 61 never moved after their claimant ended. The moment a session posts a
 * result or links a PR is the moment it is most likely to have finished.
 *
 * Only the CALLER's own active claim counts: a message from someone else on a
 * task a session holds is not that session's result, and a person's command
 * (no work session) is never nudged.
 */
export const TASK_STILL_WORKING = 'task_still_working';

interface HeldRow { task_id: string; version: number }

/** The notice text, one line, naming the next step with filled-in ids. */
export function stillWorkingWarning(taskId: string, version: number): ResultWarning {
  return {
    code: TASK_STILL_WORKING,
    message:
      `you hold task ${taskId} and it is still \`working\`. If this is the result: ` +
      `\`tm8 task complete ${taskId} --expect-version ${version} --by <your team_member>\`; ` +
      `waiting on a review: \`tm8 task transition ${taskId} in_review\`; ` +
      `stuck: \`tm8 task transition ${taskId} blocked\` with a message; ` +
      `handing off: \`tm8 task release ${taskId} --note "<where it stands>"\`. ` +
      'If you are still working on it, carry on (`tm8 help routine`).',
  };
}

/**
 * The warnings for `taskIds` the calling session holds in `working`. The
 * session is `sessionId` when the handler resolved it, else the bearer's
 * `tm8.work_session_id` claim of this transaction (302). Runs inside the
 * command's own transaction, so it sees the status the command left.
 */
export async function stillWorkingWarnings(
  q: Querier,
  taskIds: readonly string[],
  sessionId?: string | null,
): Promise<ResultWarning[]> {
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return [];
  const rows = await q.query<HeldRow>(
    `with caller as (
       select coalesce($2::uuid, case
         when current_setting('tm8.work_session_id', true)
              ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then current_setting('tm8.work_session_id', true)::uuid end) as id
     )
     select t.entity_id as task_id, e.version
       from public.tasks t
       join public.entities e on e.id = t.entity_id and e.deleted_at is null
       join caller c on c.id is not null
       join public.edges g on g.dst_id = t.entity_id and g.src_id = c.id
                          and g.type = 'working_on' and (g.props->>'endedAt') is null
      where t.entity_id = any($1::uuid[])
        and t.work_status = 'working'
      order by t.entity_id`,
    [ids, sessionId ?? null],
  );
  // Querier is an external seam; broad test fakes answer every SELECT.
  return rows
    .filter((r) => typeof r.task_id === 'string' && ids.includes(r.task_id))
    .map((r) => stillWorkingWarning(r.task_id, Number(r.version)));
}

/** Append warnings to a result that may already carry some. */
export function withWarnings<T extends object>(result: T, warnings: readonly ResultWarning[]): T {
  if (warnings.length === 0) return result;
  const existing = (result as { warnings?: ResultWarning[] }).warnings ?? [];
  return { ...result, warnings: [...existing, ...warnings] };
}
