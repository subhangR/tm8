/**
 * The run projection (design 01a182d4 §2.2): `loop_runs` joined to the session
 * that did the work, with the status DERIVED at read time and never stored
 * twice.
 *
 *   skipped    launch='skipped' (overlap, paused, schedule_invalid)
 *   failed     launch='failed', outcome='failed', the session's status is
 *              'failed' (ghost reconciliation, the lost-session reaper), or a
 *              tool run exited non-zero
 *   stopped / timed_out / completed   the settled outcome
 *   running    an unsettled firing whose session is live — or whose launch is
 *              still in flight (no session yet; the executor's sweep fails one
 *              that never records a session)
 *   completed  an unsettled firing whose session has exited cleanly
 *
 * ONE SQL fragment (`LOOP_RUN_STATUS_SQL`) defines it, so the list filter, the
 * single read and the per-loop summary cannot disagree. `exitCode` null reads
 * as unknown, never as zero; `usage` null means the session recorded none.
 */
import {
  CollabError,
  LoopRunSchema,
  decodeCursor,
  encodeCursor,
  type ActorSummary,
  type LoopRun,
  type LoopRunTarget,
  type LoopRunStatus,
  type LoopRunsSummary,
} from '@tm8/contract';
import type { Querier } from '../db/types.js';
import { cursorInstant, cursorUuid } from '../facade/context.js';
import { actorOf, loadActors } from '../facade/entity-read.js';

/**
 * Aliases: `r` = public.loop_runs, `ws` = the (left-joined) work_sessions row.
 * An unsettled run with a terminal session reads what the sweep will settle
 * it as (`outcomeOfExitedSession`, in the same order): stopped first, so a
 * stopped tool run's non-zero exit is not read as a failure.
 */
export const LOOP_RUN_STATUS_SQL = `case
  when r.launch = 'skipped' then 'skipped'
  when r.launch = 'failed' then 'failed'
  when r.outcome is not null then r.outcome
  when r.session_id is null then 'running'
  when ws.status in ('spawning', 'running', 'idle') then 'running'
  when ws.outcome = 'stopped' then 'stopped'
  when ws.status = 'failed' then 'failed'
  when ws.session_kind = 'tool' and ws.tool_exit_code is not null and ws.tool_exit_code <> 0 then 'failed'
  else 'completed'
end`;

/** Microsecond ISO text, so a keyset cursor round-trips the exact instant. */
const FIRED_AT_CURSOR_SQL = `to_char(r.fired_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface LoopRunRow {
  id: string;
  loop_id: string;
  space_id: string;
  fired_at: string | Date;
  fired_at_cursor: string;
  trigger: 'schedule' | 'manual';
  requested_by: string | null;
  action: LoopRun['action'];
  attempt: number;
  acted_as_identity_id: string | null;
  acted_as_member_id: string | null;
  launch: 'fired' | 'skipped' | 'failed';
  skip_reason: LoopRun['skipReason'];
  error: string | null;
  task_id: string | null;
  session_id: string | null;
  outcome: string | null;
  ended_at: string | Date | null;
  status: LoopRunStatus;
  session_kind: string | null;
  ended_kind: string | null;
  started_at: string | Date | null;
  exited_at: string | Date | null;
  tool_exit_code: number | null;
  tool_started_at: string | Date | null;
  tool_exited_at: string | Date | null;
  tool_output_tail?: string | null;
  usage_present: boolean | null;
  usage_input_tokens: string | number | null;
  usage_output_tokens: string | number | null;
  usage_cost_usd: number | null;
  /** Bridges L: what the run did in each target group (401's loop_run_targets). */
  targets?: Array<{ bridgeId: string; result: LoopRunTarget['result']; reason: string | null; messageId: string | null }> | null;
}

/**
 * The rows, as a `select … from … join …` with no WHERE: callers append theirs
 * with the `r` alias. RLS does the authorisation — `loop_runs_select` admits a
 * run when its loop is readable, and the session join is LEFT so a session RLS
 * hides never hides the run.
 */
export function loopRunRowsSql(withOutputTail: boolean): string {
  return `
  select r.id, r.loop_id, r.space_id, r.fired_at, ${FIRED_AT_CURSOR_SQL} as fired_at_cursor,
         r.trigger, r.requested_by, r.action, r.attempt, r.acted_as_identity_id,
         r.launch, r.skip_reason, r.error, r.task_id, r.session_id, r.outcome, r.ended_at,
         ${LOOP_RUN_STATUS_SQL} as status,
         ws.session_kind, ws.ended_kind, ws.started_at, ws.exited_at,
         ws.tool_exit_code, ws.tool_started_at, ws.tool_exited_at,
         ${withOutputTail ? 'ws.tool_output_tail,' : ''}
         (ws.usage is not null) as usage_present,
         (ws.usage #>> '{transcript,totals,inputTokens}')::bigint::text as usage_input_tokens,
         (ws.usage #>> '{transcript,totals,outputTokens}')::bigint::text as usage_output_tokens,
         (ws.usage #>> '{harness,costUsd}')::double precision as usage_cost_usd,
         am.entity_id as acted_as_member_id,
         (select coalesce(jsonb_agg(jsonb_build_object('bridgeId', t.bridge_id, 'result', t.result,
                    'reason', t.reason, 'messageId', t.message_id) order by t.bridge_id), '[]'::jsonb)
            from public.loop_run_targets t where t.run_id = r.id) as targets
    from public.loop_runs r
    -- A dispatch run's session is the space's long-lived dispatcher, shared by
    -- every request: its start, end and usage are not the run's. The run is
    -- settled at delivery, so it is timed by fired_at/ended_at and has no usage.
    left join public.work_sessions ws on ws.entity_id = r.session_id and r.action <> 'dispatch'
    left join public.members am on am.space_id = r.space_id and am.identity_id = r.acted_as_identity_id`;
}

const iso = (value: string | Date | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

const count = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

export function loopRunActorIds(rows: readonly LoopRunRow[]): string[] {
  return rows.flatMap((row) => [row.requested_by, row.acted_as_member_id].filter((id): id is string => typeof id === 'string'));
}

export function projectLoopRun(row: LoopRunRow, actors: Map<string, ActorSummary>, withOutputTail: boolean): LoopRun {
  const isTool = row.session_kind === 'tool';
  const started = isTool ? (row.tool_started_at ?? row.started_at) : row.started_at;
  // A firing that launched has started by the firing instant at the latest;
  // a skipped or failed launch never started.
  const startedAt = row.launch === 'fired' ? (iso(started) ?? iso(row.fired_at)) : null;
  const exited = isTool ? (row.tool_exited_at ?? row.exited_at) : row.exited_at;
  const endedAt = row.status === 'running' ? null : (iso(exited) ?? iso(row.ended_at));
  const durationMs = startedAt !== null && endedAt !== null
    ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime())
    : null;
  const costUsd = row.usage_cost_usd === null || row.usage_cost_usd === undefined ? null : Number(row.usage_cost_usd);
  return LoopRunSchema.parse({
    id: row.id,
    loopId: row.loop_id,
    spaceId: row.space_id,
    firedAt: iso(row.fired_at),
    trigger: row.trigger,
    requestedBy: row.requested_by ? actorOf(actors, row.requested_by) : null,
    action: row.action,
    attempt: Number(row.attempt),
    status: row.status,
    skipReason: row.skip_reason ?? null,
    error: row.error ?? null,
    taskId: row.task_id ?? null,
    sessionId: row.session_id ?? null,
    startedAt,
    endedAt,
    durationMs,
    exitCode: isTool ? row.tool_exit_code ?? null : null,
    outputTail: withOutputTail && isTool ? row.tool_output_tail ?? null : null,
    actedAs: row.acted_as_member_id ? actorOf(actors, row.acted_as_member_id) : null,
    endedKind: row.ended_kind ?? null,
    usage: row.usage_present
      ? {
          inputTokens: count(row.usage_input_tokens),
          outputTokens: count(row.usage_output_tokens),
          costUsd: costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null,
          source: costUsd !== null && Number.isFinite(costUsd) ? 'harness' : null,
        }
      : null,
    targets: row.targets ?? [],
  });
}

/** One run, with the (tool) output tail — `loops.runs.get`. Not found when RLS hides its loop. */
export async function loadLoopRun(q: Querier, runId: string, opts: { withOutputTail: boolean } = { withOutputTail: true }): Promise<LoopRun> {
  const [row] = await q.query<LoopRunRow>(`${loopRunRowsSql(opts.withOutputTail)} where r.id = $1`, [runId]);
  if (!row) throw new CollabError('not_found', 'loop run not found', { details: { runId } });
  const actors = await loadActors(q, loopRunActorIds([row]));
  return projectLoopRun(row, actors, opts.withOutputTail);
}

export interface LoopRunListInput {
  loopId: string;
  status: LoopRunStatus | null;
  limit: number;
  cursor: string | null;
}

/** `loops.runs.list`: newest first, keyset on (fired_at, id), filtered on the DERIVED status. */
export async function listLoopRuns(q: Querier, input: LoopRunListInput): Promise<{ items: LoopRun[]; nextCursor: string | null }> {
  const statusKey = input.status ?? '';
  const keys = input.cursor ? decodeCursor(input.cursor).k : [input.loopId, statusKey, null, null];
  if (keys.length !== 4 || keys[0] !== input.loopId || keys[1] !== statusKey) {
    throw new CollabError('invalid_cursor', 'invalid cursor: it belongs to another loop or filter');
  }
  const afterFiredAt = keys[2] === null ? null : cursorInstant(keys[2]);
  const afterId = keys[3] === null ? null : cursorUuid(keys[3]);
  if ((afterFiredAt === null) !== (afterId === null)) {
    throw new CollabError('invalid_cursor', 'invalid cursor: incomplete keyset');
  }
  const rows = await q.query<LoopRunRow>(
    `select * from (${loopRunRowsSql(false)} where r.loop_id = $1) x
      where ($2::text is null or x.status = $2::text)
        and ($3::timestamptz is null or (x.fired_at, x.id) < ($3::timestamptz, $4::uuid))
      order by x.fired_at desc, x.id desc
      limit $5`,
    [input.loopId, input.status, afterFiredAt, afterId, input.limit + 1],
  );
  const page = rows.slice(0, input.limit);
  const actors = await loadActors(q, loopRunActorIds(page));
  const last = page.at(-1);
  return {
    items: page.map((row) => projectLoopRun(row, actors, false)),
    nextCursor: rows.length > input.limit && last
      ? encodeCursor([input.loopId, statusKey, last.fired_at_cursor, last.id])
      : null,
  };
}

/** The loop facts `loopRunsFacts` needs to decide "waiting on a previous run". */
export interface LoopRunsFactsInput {
  id: string;
  concurrency: string;
  enabled: boolean;
  nextRunAt: string | Date | null;
  pausedUntil: string | Date | null;
}

/** A loop with no runs: zeros and nulls (usage unknown, never zero). */
export function emptyLoopRuns(): LoopRunsSummary {
  return {
    total: 0, last: null, last24h: { fired: 0, failed: 0, skipped: 0 },
    usage: { inputTokens: null, outputTokens: null, costUsd: null },
  };
}

/**
 * `LoopView.runs` (§4.2) and `state.waitingOnRunId` for a SET of loops in three
 * queries, however many rows a list carries: the per-loop aggregate, the newest
 * run per loop (`distinct on`), and the open live run per queue-concurrency
 * loop that is due. A loop with no runs gets `emptyLoopRuns()`. `fired` counts
 * launches; `failed` counts the derived status, so a launch refusal and a
 * session that died both count.
 */
export async function loopRunsFacts(
  q: Querier,
  loops: readonly LoopRunsFactsInput[],
  now: Date = new Date(),
): Promise<Map<string, { runs: LoopRunsSummary; waitingOnRunId: string | null }>> {
  const out = new Map<string, { runs: LoopRunsSummary; waitingOnRunId: string | null }>();
  for (const loop of loops) out.set(loop.id, { runs: emptyLoopRuns(), waitingOnRunId: null });
  if (loops.length === 0) return out;
  const ids = loops.map((loop) => loop.id);

  const aggregates = await q.query<{
    loop_id: string; total: number; fired24: number; failed24: number; skipped24: number;
    input_tokens: string | null; output_tokens: string | null; cost_usd: number | null; usage_runs: number;
  }>(
    `select x.loop_id,
            count(*)::int total,
            count(*) filter (where x.launch = 'fired' and x.fired_at > $2::timestamptz - interval '24 hours')::int fired24,
            count(*) filter (where x.status = 'failed' and x.fired_at > $2::timestamptz - interval '24 hours')::int failed24,
            count(*) filter (where x.launch = 'skipped' and x.fired_at > $2::timestamptz - interval '24 hours')::int skipped24,
            sum(x.usage_input_tokens::bigint)::text input_tokens,
            sum(x.usage_output_tokens::bigint)::text output_tokens,
            sum(x.usage_cost_usd)::double precision cost_usd,
            count(*) filter (where x.usage_present)::int usage_runs
       from (${loopRunRowsSql(false)} where r.loop_id = any($1::uuid[])) x
      group by x.loop_id`,
    [ids, now.toISOString()],
  );
  const lastRows = await q.query<LoopRunRow>(
    `select distinct on (x.loop_id) * from (${loopRunRowsSql(false)} where r.loop_id = any($1::uuid[])) x
      order by x.loop_id, x.fired_at desc, x.id desc`,
    [ids],
  );
  const actors = await loadActors(q, loopRunActorIds(lastRows));
  const lastByLoop = new Map(lastRows.map((row) => [row.loop_id, projectLoopRun(row, actors, false)]));

  for (const agg of aggregates) {
    const usageKnown = agg.usage_runs > 0;
    out.set(agg.loop_id, {
      runs: {
        total: agg.total,
        last: lastByLoop.get(agg.loop_id) ?? null,
        last24h: { fired: agg.fired24, failed: agg.failed24, skipped: agg.skipped24 },
        usage: {
          inputTokens: usageKnown ? count(agg.input_tokens) : null,
          outputTokens: usageKnown ? count(agg.output_tokens) : null,
          costUsd: usageKnown && agg.cost_usd !== null ? Number(agg.cost_usd) : null,
        },
      },
      waitingOnRunId: null,
    });
  }

  const waiting = loops.filter((loop) =>
    loop.concurrency === 'queue' && loop.enabled && loop.nextRunAt !== null
    && new Date(loop.nextRunAt).getTime() <= now.getTime()
    && (loop.pausedUntil === null || new Date(loop.pausedUntil).getTime() <= now.getTime()));
  if (waiting.length > 0) {
    const openRows = await q.query<{ loop_id: string; id: string }>(
      `select distinct on (r.loop_id) r.loop_id, r.id from public.loop_runs r
         left join public.work_sessions ws on ws.entity_id = r.session_id
        where r.loop_id = any($1::uuid[]) and r.launch = 'fired' and r.outcome is null
          -- A dispatch run's session is the shared dispatcher, never the run's liveness.
          and not (r.action = 'dispatch' and r.session_id is not null)
          and ((r.session_id is null and r.fired_at > $2::timestamptz - interval '10 minutes')
               or ws.status in ('spawning', 'running', 'idle'))
        order by r.loop_id, r.fired_at desc`,
      [waiting.map((loop) => loop.id), now.toISOString()],
    );
    for (const row of openRows) {
      const facts = out.get(row.loop_id);
      if (facts) facts.waitingOnRunId = row.id;
    }
  }
  return out;
}
