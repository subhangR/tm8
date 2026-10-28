import {
  CollabError, LoopSpawnConfigSchema,
  type ActorSummary, type LoopAction, type LoopConcurrency, type LoopRunsSummary, type LoopView, type ToolJsonValue,
} from '@tm8/contract';
import { loadActors, actorOf } from '../facade/entity-read.js';
import { previewSchedule } from '../scheduler/schedule.js';
import type { Querier } from '../db/types.js';
import { loopRunsFacts } from './runs.js';

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

interface LoopRow {
  id: string; space_id: string; version: number; created_by: string | null; created_at: Date | string;
  title: string; schedule: string; timezone: string; action: LoopAction;
  team_member_id: string | null; subject_id: string | null; tool_id: string | null;
  tool_inputs: Record<string, ToolJsonValue>; prompt: string; config: unknown;
  concurrency: LoopConcurrency; max_runtime_seconds: number | null;
  retry_attempts: number; retry_delay_seconds: number;
  enabled: boolean; paused_until: Date | string | null;
  next_run_at: Date | string | null; last_run_at: Date | string | null; last_error: string | null;
  armed_by_member_id: string | null; armed_at: Date | string | null;
  armer_active: boolean; fallback_member_id: string | null; viewer_member_id: string | null;
  updated_at: Date | string;
}

/**
 * Who the NEXT firing runs as (§7), by 375's rule: the armer while still an
 * active member, else the space's active owner, else nobody.
 */
const LOOP_SELECT = `
  select e.id, e.space_id, e.version, e.created_by, e.created_at,
         l.title, l.schedule, l.timezone, l.action, l.team_member_id, l.subject_id, l.tool_id,
         l.tool_inputs, l.prompt, l.config, l.concurrency, l.max_runtime_seconds,
         l.retry_attempts, l.retry_delay_seconds, l.enabled, l.paused_until,
         l.next_run_at, l.last_run_at, l.last_error, l.armed_by_member_id, l.armed_at, l.updated_at,
         exists (select 1 from public.members m where m.entity_id = l.armed_by_member_id
                   and m.identity_id = l.armed_by_identity_id and m.space_id = e.space_id
                   and m.status = 'active') as armer_active,
         (select m.entity_id from public.members m where m.space_id = e.space_id
             and m.role = 'owner' and m.status = 'active' order by m.entity_id limit 1) as fallback_member_id,
         internal.current_member_id(e.space_id) as viewer_member_id
    from public.entities e join public.loops l on l.entity_id = e.id
   where e.deleted_at is null and internal.entity_readable(e.id)`;

export interface LoopViewOptions {
  /** loops.get: the next five instants. List rows pass false: no cron stepping per row. */
  withNext: boolean;
}

function viewOf(row: LoopRow, actors: Map<string, ActorSummary>, options: LoopViewOptions,
  facts: { runs: LoopRunsSummary; waitingOnRunId: string | null }): LoopView {
  const config = LoopSpawnConfigSchema.safeParse(row.config ?? {});
  const actingMember = row.armer_active ? row.armed_by_member_id : row.fallback_member_id;
  const via = row.armer_active ? 'armer' : row.fallback_member_id ? 'fallback' : 'none';
  const { runs, waitingOnRunId } = facts;
  const member = row.viewer_member_id !== null;
  return {
    id: row.id, spaceId: row.space_id, version: Number(row.version),
    definition: {
      title: row.title, schedule: row.schedule, timezone: row.timezone, action: row.action,
      teamMemberId: row.team_member_id, subjectId: row.subject_id, toolId: row.tool_id,
      toolInputs: row.tool_inputs ?? {}, prompt: row.prompt,
      // A config stored before 384 validated it reads as empty rather than failing the view.
      config: config.success ? config.data : {},
      concurrency: row.concurrency, maxRuntimeSeconds: row.max_runtime_seconds,
      retry: { attempts: Number(row.retry_attempts), delaySeconds: Number(row.retry_delay_seconds) },
    },
    schedule: previewSchedule(row.schedule, row.timezone, options.withNext ? 5 : 0),
    state: {
      enabled: row.enabled, pausedUntil: iso(row.paused_until),
      nextRunAt: iso(row.next_run_at), lastRunAt: iso(row.last_run_at), lastError: row.last_error,
      armedBy: row.armed_by_member_id ? actorOf(actors, row.armed_by_member_id) : null,
      armedAt: iso(row.armed_at),
      actingAs: { identity: actingMember ? actorOf(actors, actingMember) : null, via },
      waitingOnRunId,
    },
    runs,
    createdBy: row.created_by ? actorOf(actors, row.created_by) : null,
    createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
    capabilities: { canEdit: member, canControl: member, canRun: member, canDelete: member },
  };
}

async function viewsOf(q: Querier, rows: LoopRow[], options: LoopViewOptions): Promise<LoopView[]> {
  const ids = rows.flatMap(row => [row.created_by, row.armed_by_member_id, row.fallback_member_id])
    .filter((id): id is string => id !== null);
  const actors = await loadActors(q, ids);
  // PR2: the loop_runs projection — total, last run, 24h health, usage, and
  // the run a queue-concurrency loop is waiting on — batched for the page.
  const facts = await loopRunsFacts(q, rows.map(row => ({
    id: row.id, concurrency: row.concurrency, enabled: row.enabled,
    nextRunAt: row.next_run_at, pausedUntil: row.paused_until,
  })));
  const none = { runs: { total: 0, last: null, last24h: { fired: 0, failed: 0, skipped: 0 },
    usage: { inputTokens: null, outputTokens: null, costUsd: null } }, waitingOnRunId: null } satisfies
    { runs: LoopRunsSummary; waitingOnRunId: string | null };
  return rows.map(row => viewOf(row, actors, options, facts.get(row.id) ?? none));
}

export async function loadLoopView(q: Querier, loopId: string, options: LoopViewOptions = { withNext: true }): Promise<LoopView> {
  const rows = await q.query<LoopRow>(`${LOOP_SELECT} and e.id = $1`, [loopId]);
  if (rows.length === 0) throw new CollabError('not_found', 'Loop is unavailable');
  return (await viewsOf(q, rows, options))[0]!;
}

export interface LoopListFilter { spaceId: string; enabled: boolean | null; action: LoopAction | null; words: string; afterId: string | null; limit: number }

/** One page plus one row, keyed by entity id, so the caller can tell whether more follow. */
export async function listLoopViews(q: Querier, filter: LoopListFilter): Promise<LoopView[]> {
  const rows = await q.query<LoopRow>(`${LOOP_SELECT}
       and e.space_id = $1
       and ($2::boolean is null or l.enabled = $2::boolean)
       and ($3::text is null or l.action = $3::text)
       and ($4 = '' or strpos(lower(l.title || ' ' || l.prompt), lower($4)) > 0)
       and ($5::uuid is null or e.id > $5::uuid)
     order by e.id limit $6`,
    [filter.spaceId, filter.enabled, filter.action, filter.words, filter.afterId, filter.limit + 1]);
  return viewsOf(q, rows, { withNext: false });
}
