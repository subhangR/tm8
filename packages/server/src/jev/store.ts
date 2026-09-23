/**
 * What Ask Jev cost, and what it suggested (design 01a0cb80 §6, migration 201).
 *
 * Every function runs in the CALLER'S transaction as `tm8_app`, so 201's RLS
 * is the authority: a run is written only into a space the caller is a member
 * of and only as the caller (`requested_by` defaults to them and is never
 * passed), and a call row joins only the caller's own run.
 *
 * NOTHING SENSITIVE IS STORED. `suggestions` holds entity ids, scores, levels,
 * the model verdict and each group's status — never a statement, a title, a
 * description, a prompt or a response body.
 */
import type {
  EntitySuggestion,
  JevCost,
  JevGroupResult,
  LaunchSuggestGroup,
  ModelSuggestion,
  TeammateSuggestion,
} from '@tm8/contract';

import type { Querier } from '../db/types.js';
import { fail } from '../http/errors.js';
import type { JevCallRecord } from './port.js';

type AnyGroupResult = JevGroupResult<ModelSuggestion | TeammateSuggestion | EntitySuggestion>;

/** One group's result as `jev_runs.suggestions` holds it: ids and numbers, no text. */
export function storedSuggestion(
  group: LaunchSuggestGroup,
  requestId: string,
  result: AnyGroupResult,
): Record<string, unknown> {
  if (result.status !== 'ok') return { status: result.status, reason: result.reason, requestId };
  if (group === 'model') return { status: 'ok', requestId, verdict: result.value };
  const value = result.value as TeammateSuggestion | EntitySuggestion;
  return {
    status: 'ok',
    requestId,
    items: value.items.map((item) => ({ id: item.entityId, score: item.score, level: item.level, suggested: item.suggested })),
    ...('noFit' in value ? { noFit: value.noFit } : { considered: value.considered, total: value.total }),
  };
}

/**
 * Create the run, or merge this request's groups into it: the LATEST result
 * per group wins, groups this request did not ask keep their earlier answer.
 *
 * A `runId` already used in another space is refused rather than merged — the
 * run's space is fixed at its first write. One owned by another caller is
 * refused by 201's update policy (SQLSTATE 42501), mapped to `forbidden`.
 */
export async function upsertRun(
  q: Querier,
  run: { runId: string; spaceId: string; subjectId: string; suggestions: Record<string, unknown> },
): Promise<void> {
  let rows: Array<{ id: string }>;
  try {
    rows = await q.query<{ id: string }>(
      `insert into public.jev_runs (id, space_id, subject_id, suggestions)
       values ($1, $2, $3, $4::jsonb)
       on conflict (id) do update
         set suggestions = public.jev_runs.suggestions || excluded.suggestions
         where public.jev_runs.space_id = excluded.space_id
       returning id`,
      [run.runId, run.spaceId, run.subjectId, JSON.stringify(run.suggestions)],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '42501') {
      throw fail('forbidden', `run ${run.runId} belongs to someone else`);
    }
    throw error;
  }
  if (rows.length === 0) throw fail('invalid_input', `run ${run.runId} belongs to another space`);
}

/**
 * One row per Jev HTTP call, failures included. `chunk` is `firstChunk + i`.
 * `on conflict do nothing` on (run_id, request_id, grp, chunk): a retried
 * `requestId` never double-counts.
 */
export async function insertCalls(
  q: Querier,
  runId: string,
  requestId: string,
  group: LaunchSuggestGroup,
  firstChunk: number,
  calls: readonly JevCallRecord[],
): Promise<void> {
  if (calls.length === 0) return;
  await q.query(
    `insert into public.jev_calls
       (run_id, request_id, grp, chunk, jev_model, input_tokens, output_tokens, cost_usd, latency_ms, outcome)
     select $1, $2, $3, c.chunk, c.jev_model, c.input_tokens, c.output_tokens, c.cost_usd, c.latency_ms, c.outcome
       from unnest($4::int[], $5::text[], $6::int[], $7::int[], $8::numeric[], $9::int[], $10::text[])
         as c(chunk, jev_model, input_tokens, output_tokens, cost_usd, latency_ms, outcome)
     on conflict (run_id, request_id, grp, chunk) do nothing`,
    [
      runId,
      requestId,
      group,
      calls.map((_, i) => firstChunk + i),
      calls.map((call) => call.jevModel),
      calls.map((call) => Math.max(0, Math.round(call.inputTokens))),
      calls.map((call) => Math.max(0, Math.round(call.outputTokens))),
      calls.map((call) => call.costUsd),
      calls.map((call) => Math.max(0, Math.round(call.latencyMs))),
      calls.map((call) => call.outcome),
    ],
  );
}

/**
 * The whole run so far, across every request. `latencyMs` is the time a
 * person waited: each request's groups and chunks run in parallel, so a
 * request took as long as its slowest call, and the run is the sum of its
 * requests.
 */
export async function runTotals(q: Querier, runId: string): Promise<JevCost> {
  const row = (await q.query<{ calls: string; input_tokens: string; output_tokens: string; usd: string; latency_ms: string }>(
    `with c as (select * from public.jev_calls where run_id = $1),
          per_request as (select max(latency_ms) as waited from c group by request_id)
     select (select count(*) from c)::text as calls,
            (select coalesce(sum(input_tokens), 0) from c)::text as input_tokens,
            (select coalesce(sum(output_tokens), 0) from c)::text as output_tokens,
            (select coalesce(sum(cost_usd), 0) from c)::text as usd,
            (select coalesce(sum(waited), 0) from per_request)::text as latency_ms`,
    [runId],
  ))[0];
  return {
    calls: Number(row?.calls ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    usd: Number(row?.usd ?? 0),
    latencyMs: Number(row?.latency_ms ?? 0),
  };
}

/**
 * Tie a run to the session it launched. The FIRST launch wins: a replayed or
 * second spawn never moves a run's attribution. Returns false when the run is
 * absent, in another space, not the caller's, or already linked elsewhere —
 * the caller logs that; a launch that already happened is never failed for it.
 */
export async function linkSession(q: Querier, runId: string, sessionId: string, spaceId: string): Promise<boolean> {
  const rows = await q.query<{ id: string }>(
    `update public.jev_runs set session_id = $2
      where id = $1 and space_id = $3 and (session_id is null or session_id = $2)
      returning id`,
    [runId, sessionId, spaceId],
  );
  return rows.length > 0;
}
