-- =============================================================================
-- 252 · attention_badges — ONE definition of the per-entity attention badge
-- aggregate (Attention v2, slice S1 · Consolidate, G9).
--
-- Before this file the aggregate was written out twice, in
-- packages/server/src/facade/entity-read.ts (the read path) and
-- packages/server/src/events/projector.ts (the event projection). Both copies
-- were identical; this function is that query, verbatim, so both callers now
-- read the same rows and cannot drift. NO behaviour change.
--
-- SECURITY INVOKER (the default) on purpose: the caller runs as tm8_app, and
-- `attention_requests_select` (050, reshaped by 218) must keep deciding which
-- requests are visible exactly as it did for the inline query. No SET clause,
-- so the planner can still inline this `language sql stable` body into the
-- caller's query.
-- =============================================================================

create or replace function public.attention_badges(p_entity_ids uuid[])
returns table (
  entity_id uuid,
  pending_count integer,
  total_points integer,
  max_points integer,
  latest_reason text,
  oldest_requested_at timestamptz
) language sql stable as $$
  select ar.entity_id,
         count(*)::int as pending_count,
         sum(ar.points)::int as total_points,
         max(ar.points)::int as max_points,
         (array_agg(ar.reason order by ar.created_at desc, ar.id desc))[1] as latest_reason,
         min(ar.created_at) as oldest_requested_at
    from public.attention_requests ar
   where ar.entity_id = any(p_entity_ids)
     and ar.status in ('open', 'acknowledged')
   group by ar.entity_id
$$;

comment on function public.attention_badges(uuid[]) is
  'Per-entity attention badge aggregate over unresolved (open/acknowledged) '
  'attention_requests. Security invoker: RLS on attention_requests applies. '
  'The single source for entity-read and the projector (Attention v2 S1).';

-- Lock PUBLIC out (the default EXECUTE-to-PUBLIC on new functions: the
-- delivery role's surface is pinned at exactly three functions by
-- w2-execution.pg.test.ts) and grant the two roles the inline query ran under:
-- tm8_app on the request path and tm8_graph_owner for the collection and
-- projector readers. Invoker rights mean neither role gains anything it could
-- not already select; `attention_requests`' grant and RLS still decide rows.
revoke all on function public.attention_badges(uuid[]) from public;
grant execute on function public.attention_badges(uuid[]) to tm8_app, tm8_graph_owner;
