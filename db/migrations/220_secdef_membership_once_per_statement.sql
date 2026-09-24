-- =============================================================================
-- 220 — SECURITY DEFINER RPCs resolve membership once per statement, not per row.
--
-- WHAT THIS CHANGES
--   218 moved every RLS POLICY off the per-row `internal.is_space_member(X)`
--   call. It could not reach SECURITY DEFINER functions: they bypass RLS and
--   test membership themselves, and seven of them still did it once per
--   candidate ROW, in a WHERE clause over many rows:
--       public.unread_counts            messages of the space        (1 site)
--       public.claim_form_deliveries    deliveries / notices         (6 sites)
--       public.claim_pending_task_nudges pending task nudges          (2 sites)
--       public.claim_pending_nudges     pending session nudges       (1 site)
--       public.retire_stale_pending_nudges  (called by the above)     (1 site)
--       public.observer_watch_targets   open pull requests           (1 site)
--       public.claim_tracking_refresh   queued refresh requests      (1 site)
--   Each such site now reads
--       X = any ((select internal.member_space_ids())::uuid[])
--   the exact form 218 gave the policies: an uncorrelated scalar sub-select,
--   hoisted to an InitPlan, so ONE `members` probe per statement and an array
--   compare per row. `internal.member_space_ids()` is 218's function; no new
--   function is added.
--   `unread_counts` keeps `internal.is_space_member(p_space_id)`: its argument
--   is the function parameter, so the planner already runs it once, as a
--   One-Time Filter. Only the per-row `message_entity.space_id` test changes.
--
--   Also: `internal.uuid_at(timestamptz)` is declared IMMUTABLE but its body
--   used `extract(epoch from <timestamptz>)`, which is STABLE, so Postgres
--   refused to inline it and ran a SQL-function call per row (6.7 k calls per
--   `unread_counts` for the largest space). `extract(epoch from at at time
--   zone 'UTC')` is the same number (epoch is zone-free) and IMMUTABLE, so the
--   function now inlines. No index or constraint uses uuid_at.
--
-- WHY (tm8_perf restored prod copy, 216 + 218 applied = prod at 3560068f)
--   unread_counts(largest space), 9-space identity: 6 673 is_space_member
--   calls + 6 674 uuid_at calls + 13 350 claim_text calls per call. See the PR
--   for before/after timings.
--
-- WHY THIS IS EQUIVALENT
--   * `is_space_member(X)` = identity set AND a `members` row (X, identity).
--     `member_space_ids()` returns exactly the space ids of the caller's
--     `members` rows ('{}' for an unset claim), so `X = any(...)` is true iff
--     the old call was. NULL X: old false, new NULL; every site is a WHERE
--     conjunct, where both reject the row.
--   * Snapshot: the InitPlan runs inside the same statement the per-row call
--     ran in, so it sees the same snapshot (both are STABLE).
--   * Row-set equivalence was checked on the prod copy: every function's
--     output, before and after, for every identity (see the PR).
--
-- LOCKS: CREATE OR REPLACE FUNCTION takes no table lock, only a row lock on
--   the pg_proc entry; callers already executing keep their cached plan.
--   lock_timeout is set anyway so the file can never queue behind a
--   long-running transaction that has the same function's catalog row locked.
-- =============================================================================

set local lock_timeout = '5s';

-- FIX, not perf: 148 created `internal.repo_slug_from_url` without
-- `set role tm8_graph_owner`, so it is owned by the migration user and only
-- `tm8_app` was granted EXECUTE. `internal.pr_owning_session` calls it, and
-- two SECURITY DEFINER callers run it as `tm8_graph_owner`:
-- `observer_watch_targets` and `claim_pending_nudges`. Both raise
-- "permission denied for function repo_slug_from_url" as soon as a candidate
-- PR reaches the lateral. Reproduced on the prod copy; prod's ACL is the same.
-- Granted here, BEFORE `set role`, because only the owner can grant.
grant execute on function internal.repo_slug_from_url(text) to tm8_graph_owner;

set role tm8_graph_owner;

create or replace function internal.uuid_at(at timestamp with time zone)
 returns uuid
 language sql
 immutable parallel safe
as $function$
  -- 220: `at time zone 'UTC'` keeps the body IMMUTABLE (extract on a
  -- timestamptz is only STABLE), so the planner can inline this call.
  select (lpad(to_hex(floor(extract(epoch from (at at time zone 'UTC')) * 1000)::bigint), 12, '0')
       || '7000' || '8000' || '000000000000')::uuid
$function$;

CREATE OR REPLACE FUNCTION public.unread_counts(p_space_id uuid)
 RETURNS TABLE(anchor_id uuid, unread integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
  with me as (select internal.current_member_id(p_space_id) as member_id)
  select message_row.anchor_id, count(*)::integer as unread
    from public.messages message_row
    join public.entities message_entity
      on message_entity.id = message_row.entity_id and message_entity.deleted_at is null
    join public.entities anchor_entity
      on anchor_entity.id = message_row.anchor_id and anchor_entity.space_id = p_space_id
    left join public.read_marks mark_row
      on mark_row.anchor_id = message_row.anchor_id
     and mark_row.member_id = (select member_id from me)
   where internal.is_space_member(p_space_id)
     -- WAS: `and internal.entity_readable(message_row.entity_id)`.
     and message_entity.space_id = any ((select internal.member_space_ids())::uuid[])
     and (
       message_entity.visibility = 'space'
       or (
         message_entity.visibility = 'restricted'
         and message_entity.kind = 'project'
         and exists (
           select 1
             from public.project_links link
             join public.space_projects active_link
               on active_link.space_id = link.space_id
              and active_link.project_id = link.project_id
            where link.project_entity_id = message_entity.id
              and link.space_id = message_entity.space_id
         )
       )
     )
     -- WAS: `and internal.entity_readable(message_row.anchor_id)`. The
     -- `deleted_at` conjunct is NEW here only in the sense that the call used
     -- to carry it; see this section's header.
     and anchor_entity.deleted_at is null
     and (
       anchor_entity.visibility = 'space'
       or (
         anchor_entity.visibility = 'restricted'
         and anchor_entity.kind = 'project'
         and exists (
           select 1
             from public.project_links link
             join public.space_projects active_link
               on active_link.space_id = link.space_id
              and active_link.project_id = link.project_id
            where link.project_entity_id = anchor_entity.id
              and link.space_id = anchor_entity.space_id
         )
       )
     )
     and message_row.author_id is distinct from (select member_id from me)
     and (mark_row.last_read_at is null
       or message_row.entity_id > internal.uuid_at(mark_row.last_read_at))
   group by message_row.anchor_id
$function$;

CREATE OR REPLACE FUNCTION public.claim_form_deliveries(p_response_id uuid DEFAULT NULL::uuid, p_work_session_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 25, p_lease_seconds integer DEFAULT 120, p_route_modes text[] DEFAULT '{}'::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  lim integer := least(greatest(coalesce(p_limit, 25), 1), 200);
  lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 10));
  modes text[] := coalesce(p_route_modes, '{}'::text[]);
  who text := internal.identity_id();
  r record;
  n record;
  attempt integer;
  items jsonb := '[]'::jsonb;
  cancelled integer := 0;
  adopted integer := 0;
begin
  perform internal.require_identity();

  -- 1. RECONCILE: adopt what session_message_deliveries already knows, so a
  --    crash between reserve and record never produces a second reservation.
  for r in
    select d.response_id, d.work_session_id, s.delivery_id, s.status, s.failure_reason
      from public.form_deliveries d
      join public.form_responses fr on fr.id = d.response_id
      join lateral (
        select x.delivery_id, x.status, x.failure_reason
          from public.session_message_deliveries x
         where x.message_id = fr.message_id and x.target_work_session_id = d.work_session_id
         order by x.attempt_no desc limit 1
      ) s on true
     where d.status = 'pending'
       and fr.space_id = any ((select internal.member_space_ids())::uuid[])
       and (p_response_id is null or d.response_id = p_response_id)
       and (p_work_session_id is null or d.work_session_id = p_work_session_id)
       and ((s.status in ('pending', 'dispatching', 'delivered', 'unknown')
             and d.delivery_id is distinct from s.delivery_id)
            or (d.delivery_id = s.delivery_id and s.status not in ('pending', 'dispatching')))
  loop
    if r.status in ('pending', 'dispatching', 'delivered', 'unknown') then
      update public.form_deliveries set delivery_id = r.delivery_id
       where response_id = r.response_id and work_session_id = r.work_session_id and status = 'pending';
      adopted := adopted + 1;
    end if;
    -- A terminal outcome on the row's own delivery: settle it now.
    if r.status not in ('pending', 'dispatching') then
      perform internal.form_delivery_apply(r.delivery_id, r.status, r.failure_reason);
    end if;
  end loop;
  for n in
    select fn.message_id, s.delivery_id, s.status, s.failure_reason
      from public.form_notices fn
      join public.entities fe on fe.id = fn.form_id
      join lateral (
        select x.delivery_id, x.status, x.failure_reason
          from public.session_message_deliveries x
         where x.message_id = fn.message_id and x.target_work_session_id = fn.work_session_id
         order by x.attempt_no desc limit 1
      ) s on true
     where fn.status = 'pending'
       and fe.space_id = any ((select internal.member_space_ids())::uuid[])
       and p_response_id is null
       and (p_work_session_id is null or fn.work_session_id = p_work_session_id)
       and ((s.status in ('pending', 'dispatching', 'delivered', 'unknown')
             and fn.delivery_id is distinct from s.delivery_id)
            or (fn.delivery_id = s.delivery_id and s.status not in ('pending', 'dispatching')))
  loop
    if n.status in ('pending', 'dispatching', 'delivered', 'unknown') then
      update public.form_notices set delivery_id = n.delivery_id
       where message_id = n.message_id and status = 'pending';
    end if;
    if n.status not in ('pending', 'dispatching') then
      perform internal.form_delivery_apply(n.delivery_id, n.status, n.failure_reason);
    end if;
  end loop;

  -- 2. DELETED SESSIONS: a resume/queue delivery to the requesting session, and
  --    every notice, is cancelled. The response stays stored. Spawn modes are
  --    the seam's to decide (a deleted session can still get a new one).
  with gone as (
    update public.form_deliveries d
       set status = 'cancelled', last_error = 'session_deleted', claimed_at = null
      from public.form_responses fr, public.forms f, public.entities se
     where fr.id = d.response_id and f.entity_id = fr.form_id and se.id = d.work_session_id
       and d.status = 'pending' and d.delivery_id is null
       and se.deleted_at is not null
       and fr.space_id = any ((select internal.member_space_ids())::uuid[])
       and (p_response_id is null or d.response_id = p_response_id)
       and (p_work_session_id is null or d.work_session_id = p_work_session_id)
       and internal.form_settings_effective(f.settings) #>> '{delivery,target}' = 'requesting_session'
       and internal.form_settings_effective(f.settings) #>> '{delivery,onSessionNotLive}' in ('resume', 'queue')
    returning 1
  )
  select count(*) into cancelled from gone;
  update public.form_notices fn
     set status = 'cancelled', last_error = 'session_deleted', claimed_at = null
    from public.entities se, public.entities fe
   where se.id = fn.work_session_id and fe.id = fn.form_id
     and fn.status = 'pending' and fn.delivery_id is null
     and se.deleted_at is not null
     and fe.space_id = any ((select internal.member_space_ids())::uuid[])
     and p_response_id is null
     and (p_work_session_id is null or fn.work_session_id = p_work_session_id);

  -- 3. CLAIM. Responses first (a waiting agent asked for them), then notices.
  for r in
    select d.response_id, d.work_session_id, d.attempts, fr.message_id, fr.form_id,
           ws.status as session_status,
           internal.form_settings_effective(f.settings) -> 'delivery' as delivery,
           (ws.status in ('running', 'idle')) as live
      from public.form_deliveries d
      join public.form_responses fr on fr.id = d.response_id
      join public.forms f on f.entity_id = fr.form_id
      join public.entities se on se.id = d.work_session_id
      left join public.work_sessions ws on ws.entity_id = d.work_session_id
     where d.status = 'pending'
       and d.delivery_id is null
       and (d.claimed_at is null or d.claimed_at < now() - lease)
       and fr.message_id is not null
       and fr.space_id = any ((select internal.member_space_ids())::uuid[])
       and (p_response_id is null or d.response_id = p_response_id)
       and (p_work_session_id is null or d.work_session_id = p_work_session_id)
       and (
         -- inject: the requesting session, live now
         ((internal.form_settings_effective(f.settings) #>> '{delivery,target}') = 'requesting_session'
          and se.deleted_at is null and ws.status in ('running', 'idle'))
         -- route (the seam): a mode the caller can act on
         or ((internal.form_settings_effective(f.settings) #>> '{delivery,target}') = 'new_session'
             and 'new_session' = any(modes))
         or ((internal.form_settings_effective(f.settings) #>> '{delivery,target}') = 'requesting_session'
             and (se.deleted_at is not null or ws.status is null or ws.status not in ('running', 'idle', 'spawning'))
             and (internal.form_settings_effective(f.settings) #>> '{delivery,onSessionNotLive}') = any(modes))
       )
     order by d.created_at
     limit lim
     for update of d skip locked
  loop
    select greatest(r.attempts, coalesce(max(x.attempt_no), 0)) + 1 into attempt
      from public.session_message_deliveries x
     where x.message_id = r.message_id and x.target_work_session_id = r.work_session_id;
    update public.form_deliveries
       set attempts = attempt, claimed_at = now(), claimed_by = who
     where response_id = r.response_id and work_session_id = r.work_session_id;
    items := items || jsonb_build_array(
      internal.form_delivery_item('response', r.response_id, r.message_id, r.form_id,
        r.work_session_id, attempt, r.session_status, r.delivery, r.live
          and (r.delivery ->> 'target') = 'requesting_session'));
  end loop;

  if p_response_id is null then
    for n in
      select fn.message_id, fn.form_id, fn.work_session_id, fn.attempts, ws.status as session_status
        from public.form_notices fn
        join public.entities fe on fe.id = fn.form_id
        join public.entities se on se.id = fn.work_session_id and se.deleted_at is null
        join public.work_sessions ws on ws.entity_id = fn.work_session_id
       where fn.status = 'pending'
         and fn.delivery_id is null
         and (fn.claimed_at is null or fn.claimed_at < now() - lease)
         and ws.status in ('running', 'idle')
         and fe.space_id = any ((select internal.member_space_ids())::uuid[])
         and (p_work_session_id is null or fn.work_session_id = p_work_session_id)
       order by fn.created_at
       limit lim
       for update of fn skip locked
    loop
      select greatest(n.attempts, coalesce(max(x.attempt_no), 0)) + 1 into attempt
        from public.session_message_deliveries x
       where x.message_id = n.message_id and x.target_work_session_id = n.work_session_id;
      update public.form_notices
         set attempts = attempt, claimed_at = now(), claimed_by = who
       where message_id = n.message_id;
      items := items || jsonb_build_array(
        internal.form_delivery_item('notice', null, n.message_id, n.form_id,
          n.work_session_id, attempt, n.session_status, null, true));
    end loop;
  end if;

  return jsonb_build_object('items', items, 'cancelled', cancelled, 'adopted', adopted);
end
$function$;

CREATE OR REPLACE FUNCTION public.claim_pending_task_nudges(p_limit integer DEFAULT 50, p_max_age_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare result jsonb;
begin
  perform internal.require_identity();

  update public.pending_task_nudges q
     set state = 'retired', settled_at = now(), retire_reason = 'expired'
   where q.state = 'pending'
     and q.space_id = any ((select internal.member_space_ids())::uuid[])
     and q.detected_at < now() - make_interval(hours => greatest(coalesce(p_max_age_hours, 24), 1));

  select coalesce(jsonb_agg(t.payload order by t.detected_at), '[]'::jsonb) into result
    from (
      select q.detected_at,
        jsonb_build_object(
          'pendingId', q.id,
          'spaceId', q.space_id,
          'workSessionId', q.work_session_id,
          'taskId', q.task_id,
          'loopKind', q.loop_kind,
          'cause', q.cause,
          'status', q.status,
          'actorId', q.actor_id,
          'teammateId', q.teammate_id,
          'sessionStatus', ws.status,
          'attempts', q.attempts
        ) as payload
        from public.pending_task_nudges q
        left join public.work_sessions ws on ws.entity_id = q.work_session_id
       where q.state = 'pending'
         and q.space_id = any ((select internal.member_space_ids())::uuid[])
       order by q.detected_at
       limit greatest(coalesce(p_limit, 50), 1)
    ) t;

  return jsonb_build_object('pending', result);
end
$function$;

CREATE OR REPLACE FUNCTION public.claim_pending_nudges(p_limit integer DEFAULT 20, p_max_age_hours integer DEFAULT 48)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare result jsonb;
begin
  perform internal.require_identity();
  perform public.retire_stale_pending_nudges(p_max_age_hours);

  select coalesce(jsonb_agg(t.payload order by t.detected_at), '[]'::jsonb) into result
    from (
      select q.detected_at,
        jsonb_build_object(
          'pendingId', q.id,
          'spaceId', q.space_id,
          'prEntityId', q.pr_entity_id,
          'loopKind', q.loop_kind,
          'scopeKey', q.scope_key,
          'headSha', q.head_sha,
          'payload', q.payload,
          'attempts', q.attempts,
          'repo', pr.repo,
          'number', pr.number,
          'headRef', pr.head_ref,
          'baseRef', pr.base_ref,
          'taskId', (select ed.src_id from public.edges ed
                      where ed.dst_id = pr.entity_id and ed.type = 'tracks'
                      order by ed.created_at limit 1),
          'owningSessionId', sess.id
        ) as payload
        from public.pending_session_nudges q
        join public.pull_requests pr on pr.entity_id = q.pr_entity_id
        join lateral (select internal.pr_owning_session(q.pr_entity_id) as id) sess on true
        join public.work_sessions ws on ws.entity_id = sess.id
       where q.status = 'pending'
         and q.space_id = any ((select internal.member_space_ids())::uuid[])
         -- The addressee test. No live agent ⇒ not returned ⇒ still pending.
         and ws.status in ('spawning', 'running', 'idle')
         and internal.is_agent_session(sess.id)
       order by q.detected_at
       limit greatest(coalesce(p_limit, 20), 1)
    ) t;

  return jsonb_build_object('pending', result);
end
$function$;

CREATE OR REPLACE FUNCTION public.retire_stale_pending_nudges(p_max_age_hours integer DEFAULT 48)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare retired integer;
begin
  perform internal.require_identity();
  with settled as (
    update public.pending_session_nudges q
       set status = 'retired', settled_at = now(),
           retire_reason = case
             when pr.state not in ('open', 'draft') then 'pr_settled'
             when q.head_sha is not null and pr.head_sha is not null
                  and lower(q.head_sha) <> lower(pr.head_sha) then 'head_moved'
             when q.loop_kind = 'review_thread' and not exists (
                    select 1 from public.pr_review_thread_facts f
                     where f.pr_entity_id = q.pr_entity_id
                       and f.thread_key = q.scope_key and f.is_resolved = false
                  ) then 'thread_gone'
             else 'expired' end
      from public.pull_requests pr
     where pr.entity_id = q.pr_entity_id
       and q.status = 'pending'
       and q.space_id = any ((select internal.member_space_ids())::uuid[])
       and (
         pr.state not in ('open', 'draft')
         or (q.head_sha is not null and pr.head_sha is not null
             and lower(q.head_sha) <> lower(pr.head_sha))
         or (q.loop_kind = 'review_thread' and not exists (
               select 1 from public.pr_review_thread_facts f
                where f.pr_entity_id = q.pr_entity_id
                  and f.thread_key = q.scope_key and f.is_resolved = false))
         or q.detected_at < now() - make_interval(hours => greatest(coalesce(p_max_age_hours, 48), 1))
       )
     returning 1
  )
  select count(*)::integer into retired from settled;
  return jsonb_build_object('retired', retired);
end
$function$;

CREATE OR REPLACE FUNCTION public.observer_watch_targets(p_limit integer DEFAULT 25, p_min_age_seconds integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare result jsonb;
begin
  perform internal.require_identity();

  select coalesce(jsonb_agg(t.payload order by t.ordinal), '[]'::jsonb) into result
    from (
      select
        row_number() over (order by coalesce(pr.fetched_at, 'epoch'::timestamptz), pr.entity_id) as ordinal,
        jsonb_build_object(
          'prEntityId', pr.entity_id,
          'spaceId', pr.space_id,
          'provider', pr.provider,
          'repo', pr.repo,
          'number', pr.number,
          'state', pr.state,
          'headSha', pr.head_sha,
          'headRef', pr.head_ref,
          'baseRef', pr.base_ref,
          'ciStatus', pr.ci_status,
          'mergeableState', pr.mergeable_state,
          'taskId', (select ed.src_id from public.edges ed
                      where ed.dst_id = pr.entity_id and ed.type = 'tracks'
                      order by ed.created_at limit 1),
          'owningSessionId', sess.id,
          'owningSessionStatus', ws.status,
          'owningSessionLive', coalesce(ws.status in ('spawning','running','idle'), false),
          'stackedOnOpenParent', exists (
            select 1 from public.pull_requests parent
             where parent.space_id = pr.space_id
               and parent.repo = pr.repo
               and parent.entity_id <> pr.entity_id
               and parent.head_ref is not null
               and parent.head_ref = pr.base_ref
               and parent.state in ('open','draft'))
        ) as payload
        from public.pull_requests pr
        join public.entities pe on pe.id = pr.entity_id and pe.deleted_at is null
        left join lateral (
          select internal.pr_owning_session(pr.entity_id) as id
        ) sess on true
        left join public.work_sessions ws on ws.entity_id = sess.id
       where pr.state in ('open','draft')
         and pr.space_id = any ((select internal.member_space_ids())::uuid[])
         and exists (select 1 from public.edges ed
                      where ed.dst_id = pr.entity_id and ed.type = 'tracks')
         -- A floor on how often one PR may be re-polled, so a small watch list
         -- cannot turn a short interval into a hot loop against the provider.
         and (pr.fetched_at is null
              or pr.fetched_at < now() - make_interval(secs => greatest(coalesce(p_min_age_seconds, 0), 0)))
       order by coalesce(pr.fetched_at, 'epoch'::timestamptz), pr.entity_id
       limit greatest(coalesce(p_limit, 25), 1)
    ) t;

  return jsonb_build_object('targets', result);
end
$function$;

CREATE OR REPLACE FUNCTION public.claim_tracking_refresh(p_limit integer DEFAULT 10, p_stale_after_seconds integer DEFAULT 600, p_max_attempts integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare claimed jsonb;
begin
  perform internal.require_identity();

  update public.tracking_refresh_requests
     set status = 'queued', started_at = null
   where status = 'running'
     and started_at is not null
     and started_at < now() - make_interval(secs => greatest(p_stale_after_seconds, 1));

  -- Retire the rows that have burned their budget. Recorded as `failed` with a
  -- reason rather than left queued, so an operator sees a terminal row instead
  -- of a tick that mysteriously never finishes.
  update public.tracking_refresh_requests
     set status = 'failed',
         error = coalesce(error, '') ||
                 case when coalesce(error, '') = '' then '' else '; ' end ||
                 'retired after ' || attempts || ' attempts',
         completed_at = now()
   where status = 'queued'
     and attempts >= greatest(coalesce(p_max_attempts, 5), 1);

  with picked as (
    select id from public.tracking_refresh_requests r
     where r.status = 'queued'
       -- Same entitlement the apply doors enforce. Claiming what we could never
       -- apply is what turns one bad row into a permanent wedge.
       and r.space_id = any ((select internal.member_space_ids())::uuid[])
     order by r.created_at
     limit greatest(coalesce(p_limit, 10), 1)
     for update skip locked
  ), taken as (
    update public.tracking_refresh_requests r
       set status = 'running', started_at = now(), attempts = r.attempts + 1
      from picked
     where r.id = picked.id
     returning r.id, r.space_id, r.entity_ids, r.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'requestId', t.id, 'spaceId', t.space_id, 'attempts', t.attempts,
           'targets', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'entityId', e.id, 'kind', e.kind,
                      'provider', coalesce(pr.provider, c.provider),
                      'repo',     coalesce(pr.repo, c.repo),
                      'number',   pr.number,
                      'sha',      c.sha))
               from public.entities e
               left join public.pull_requests pr on pr.entity_id = e.id
               left join public.commits c        on c.entity_id  = e.id
              where e.space_id = t.space_id
                and e.deleted_at is null
                and e.kind in ('pull_request','commit')
                -- An empty/absent entity_ids means "everything tracked in this
                -- space", which is what 017's door accepts and records.
                and (t.entity_ids is null or cardinality(t.entity_ids) = 0
                     or e.id = any(t.entity_ids))
           ), '[]'::jsonb))), '[]'::jsonb)
    into claimed
    from taken t;

  return jsonb_build_object('claimed', claimed);
end
$function$;

reset role;
