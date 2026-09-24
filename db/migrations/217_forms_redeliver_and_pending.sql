-- =============================================================================
-- 217  FORMS W3 — REDELIVER and the PENDING-FORMS read (FORMS-DESIGN §7.3, §10).
--
-- Two buttons the delivery chip needs, and one read the session tile needs:
--
--   A. `form_deliveries.route_override`: a per-row override of the form's
--      delivery settings. 'new_session' routes the row to a fresh session
--      whatever the form says; 'resume' resumes the requesting session.
--   B. `internal.form_delivery_effective` — the form's effective delivery
--      settings with a row's override applied: the ONE place the override is
--      read.
--   C. `claim_form_deliveries`, redefined. 214's body verbatim, except that each
--      of its seven reads of settings.delivery now goes through B. That includes
--      step 2's session_deleted sweep: without it, a redelivered row whose
--      session is deleted (the main case for "Send to a new session") would be
--      cancelled again by the very next claim.
--   D. `public.redeliver_form_response` — forms.responses.redeliver.
--        to = 'new_session' (default): a CANCELLED row goes back to pending with
--          route_override 'new_session', so 215's new_session handler spawns
--          it. This is "Send to a new session" (W2 risk R1).
--        to = 'resume': a still-PENDING row whose session is not deleted gets
--          route_override 'resume', and any backoff is cleared, so the next
--          claim resumes the session. This is "Resume now" for a queued answer
--          (R4). The server resumes, as the W2 ruling says: the respondent
--          never needs the right to resume that session themselves.
--      The row is updated IN PLACE: the PK is (response_id, work_session_id),
--      and a spawn has no session id until it happens. 'spawned' and
--      spawned_session_id record the outcome, as for every spawn-mode row.
--      Who: the respondent, the form's author, or a space admin.
--   E. `public.forms_pending_for_sessions` — forms.pendingForSessions. Per
--      session: the open forms authored from it that still wait on the CALLER,
--      plus the count of queued deliveries. One statement, run as the caller,
--      so RLS decides visibility.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- A. The override.
-- -----------------------------------------------------------------------------
alter table public.form_deliveries
  add column if not exists route_override text
    constraint form_deliveries_route_override_check check (route_override in ('new_session', 'resume'));

comment on column public.form_deliveries.route_override is
  'forms.responses.redeliver (217): overrides the form''s delivery settings for this row.';

-- -----------------------------------------------------------------------------
-- B. Effective delivery settings for one row.
-- -----------------------------------------------------------------------------
create or replace function internal.form_delivery_effective(p_settings jsonb, p_override text)
returns jsonb language sql immutable set search_path = public, internal, pg_temp as $$
  select case p_override
    when 'new_session' then d || jsonb_build_object('target', 'new_session')
    when 'resume' then d || jsonb_build_object('target', 'requesting_session', 'onSessionNotLive', 'resume')
    else d end
    from (select internal.form_settings_effective(p_settings) -> 'delivery' as d) s
$$;
revoke all on function internal.form_delivery_effective(jsonb, text) from public;

-- -----------------------------------------------------------------------------
-- C. The claim, with the override applied (214 D, otherwise unchanged).
-- -----------------------------------------------------------------------------
create or replace function public.claim_form_deliveries(
  p_response_id uuid default null,
  p_work_session_id uuid default null,
  p_limit integer default 25,
  p_lease_seconds integer default 120,
  p_route_modes text[] default '{}'::text[]
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
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
       and internal.is_space_member(fr.space_id)
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
       and internal.is_space_member(fe.space_id)
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
       and internal.is_space_member(fr.space_id)
       and (p_response_id is null or d.response_id = p_response_id)
       and (p_work_session_id is null or d.work_session_id = p_work_session_id)
       and internal.form_delivery_effective(f.settings, d.route_override) ->> 'target' = 'requesting_session'
       and internal.form_delivery_effective(f.settings, d.route_override) ->> 'onSessionNotLive' in ('resume', 'queue')
    returning 1
  )
  select count(*) into cancelled from gone;
  update public.form_notices fn
     set status = 'cancelled', last_error = 'session_deleted', claimed_at = null
    from public.entities se, public.entities fe
   where se.id = fn.work_session_id and fe.id = fn.form_id
     and fn.status = 'pending' and fn.delivery_id is null
     and se.deleted_at is not null
     and internal.is_space_member(fe.space_id)
     and p_response_id is null
     and (p_work_session_id is null or fn.work_session_id = p_work_session_id);

  -- 3. CLAIM. Responses first (a waiting agent asked for them), then notices.
  for r in
    select d.response_id, d.work_session_id, d.attempts, fr.message_id, fr.form_id,
           ws.status as session_status,
           internal.form_delivery_effective(f.settings, d.route_override) as delivery,
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
       and internal.is_space_member(fr.space_id)
       and (p_response_id is null or d.response_id = p_response_id)
       and (p_work_session_id is null or d.work_session_id = p_work_session_id)
       and (
         -- inject: the requesting session, live now
         ((internal.form_delivery_effective(f.settings, d.route_override) ->> 'target') = 'requesting_session'
          and se.deleted_at is null and ws.status in ('running', 'idle'))
         -- route (the seam): a mode the caller can act on
         or ((internal.form_delivery_effective(f.settings, d.route_override) ->> 'target') = 'new_session'
             and 'new_session' = any(modes))
         or ((internal.form_delivery_effective(f.settings, d.route_override) ->> 'target') = 'requesting_session'
             and (se.deleted_at is not null or ws.status is null or ws.status not in ('running', 'idle', 'spawning'))
             and (internal.form_delivery_effective(f.settings, d.route_override) ->> 'onSessionNotLive') = any(modes))
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
         and internal.is_space_member(fe.space_id)
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
$$;

revoke all on function public.claim_form_deliveries(uuid, uuid, integer, integer, text[]) from public;
grant execute on function public.claim_form_deliveries(uuid, uuid, integer, integer, text[]) to tm8_app;

-- -----------------------------------------------------------------------------
-- D. forms.responses.redeliver.
-- -----------------------------------------------------------------------------
create or replace function public.redeliver_form_response(
  p_response_id uuid,
  p_to text default 'new_session',
  p_delivery_session_id uuid default null,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  target text := coalesce(p_to, 'new_session');
  fr public.form_responses;
  e public.entities;
  actor uuid;
  d public.form_deliveries;
  rows_found integer;
  session_gone boolean;
  changed boolean := false;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'forms.responses.redeliver');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay->>'responseId', p_response_id::text, 'form response');
    return replay;
  end if;
  if target not in ('new_session', 'resume') then
    raise exception 'to must be new_session or resume' using errcode = '22023';
  end if;

  select * into fr from public.form_responses where id = p_response_id and status = 'submitted';
  if fr.id is null then
    raise exception 'form response % not found', p_response_id using errcode = 'P0002';
  end if;
  e := internal.form_entity(fr.form_id);
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  if actor is distinct from fr.respondent_id and actor is distinct from e.created_by
     and not internal.is_space_admin(e.space_id) then
    raise exception 'only the respondent, the form''s author or a space admin may redeliver a response'
      using errcode = '42501';
  end if;

  -- Which delivery row: the named one, else the only one.
  if p_delivery_session_id is null then
    select count(*) into rows_found from public.form_deliveries where response_id = p_response_id;
    if rows_found > 1 then
      raise exception 'this response has % deliveries; name one with deliverySessionId', rows_found
        using errcode = '22023';
    end if;
  end if;
  select * into d from public.form_deliveries
   where response_id = p_response_id
     and (p_delivery_session_id is null or work_session_id = p_delivery_session_id)
   for update;
  if d.response_id is null then
    raise exception 'form response % has no delivery%', p_response_id,
      case when p_delivery_session_id is null then '' else ' to session ' || p_delivery_session_id end
      using errcode = 'P0002';
  end if;

  if target = 'new_session' then
    if d.status = 'cancelled' then
      update public.form_deliveries
         set status = 'pending', route_override = 'new_session',
             delivery_id = null, claimed_at = null, spawn_mutation_id = null,
             last_error = left('redelivered_from: ' || coalesce(d.last_error, 'cancelled'), 200)
       where response_id = d.response_id and work_session_id = d.work_session_id
      returning * into d;
      changed := true;
    elsif not (d.route_override = 'new_session' and d.status in ('pending', 'spawned')) then
      raise exception 'only a cancelled delivery can be sent to a new session (this one is %)', d.status
        using errcode = 'TFC01',
              detail = jsonb_build_object('reason', 'delivery_not_cancelled', 'status', d.status)::text;
    end if;
  else
    if d.status <> 'pending' then
      raise exception 'only a pending delivery can be resumed (this one is %)', d.status
        using errcode = 'TFC01',
              detail = jsonb_build_object('reason', 'delivery_not_pending', 'status', d.status)::text;
    end if;
    select se.deleted_at is not null into session_gone from public.entities se where se.id = d.work_session_id;
    if coalesce(session_gone, true) then
      raise exception 'the session was deleted; send the response to a new session instead'
        using errcode = 'TFC01',
              detail = jsonb_build_object('reason', 'session_deleted', 'status', d.status)::text;
    end if;
    -- A future claimed_at is a backoff (215 D); a past one is a live lease,
    -- which is left alone so no second claimer steals an attempt in flight.
    changed := d.route_override is distinct from 'resume'
               or (d.claimed_at is not null and d.claimed_at > now());
    if changed then
      update public.form_deliveries
         set route_override = 'resume',
             claimed_at = case when claimed_at > now() then null else claimed_at end
       where response_id = d.response_id and work_session_id = d.work_session_id
      returning * into d;
    end if;
  end if;

  return internal.ledger_record(p_client_mutation_id, 'forms.responses.redeliver',
           jsonb_build_object('responseId', d.response_id, 'workSessionId', d.work_session_id,
                              'to', target, 'status', d.status, 'redelivered', changed));
end
$$;
revoke all on function public.redeliver_form_response(uuid, text, uuid, uuid, text) from public;
grant execute on function public.redeliver_form_response(uuid, text, uuid, uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- E. forms.pendingForSessions. SECURITY INVOKER: every row it reads passes the
--    caller's RLS, so an unreadable session or form is simply absent.
--
--    WAITING = open, authored_from one of the sessions, the caller may respond
--    (a member; a team_member only when respondents = 'anyone'), and the caller
--    is not done: per_member → no current submitted row of the caller;
--    single → no current submitted row on the form; unlimited → the caller has
--    no submitted row. A draft does not stop a form waiting.
-- -----------------------------------------------------------------------------
create or replace function public.forms_pending_for_sessions(p_space_id uuid, p_session_ids uuid[])
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  with viewer as (
    select v.id, ve.kind
      from (select coalesce(internal.actor_id(), internal.current_member_id(p_space_id)) as id) v
      left join public.entities ve on ve.id = v.id
  ),
  sessions as (
    select s.id, s.ord
      from unnest(p_session_ids) with ordinality as s(id, ord)
  ),
  waiting as (
    select s.id as session_id, f.entity_id as form_id, f.title, fe.version, f.structure_version,
           f.opened_at, fe.created_at
      from sessions s
      join public.edges ed on ed.dst_id = s.id and ed.type = 'authored_from'
      join public.entities fe on fe.id = ed.src_id and fe.kind = 'form' and fe.deleted_at is null
                             and fe.space_id = p_space_id
      join public.forms f on f.entity_id = fe.id and f.status = 'open'
      cross join viewer
     where viewer.id is not null
       and (viewer.kind = 'member'
            or (viewer.kind = 'team_member'
                and internal.form_settings_effective(f.settings) ->> 'respondents' = 'anyone'))
       and not exists (
         select 1 from public.form_responses r
          where r.form_id = f.entity_id and r.status = 'submitted'
            and case internal.form_settings_effective(f.settings) ->> 'responses'
                  when 'single' then r.is_current
                  when 'unlimited' then r.respondent_id = viewer.id
                  else r.is_current and r.respondent_id = viewer.id
                end)
  ),
  ranked as (
    select w.*, row_number() over (partition by w.session_id
                                   order by coalesce(w.opened_at, w.created_at) desc, w.form_id desc) as rn,
           count(*) over (partition by w.session_id) as total
      from waiting w
  ),
  per_session as (
    select s.id, s.ord,
           coalesce(t.total, 0) as total,
           (select count(*) from public.form_deliveries fd
             where fd.work_session_id = s.id and fd.status = 'pending') as queued,
           coalesce(t.forms, '[]'::jsonb) as forms
      from sessions s
      left join lateral (
        select max(r.total) as total,
               jsonb_agg(jsonb_build_object(
                 'formId', r.form_id,
                 'title', r.title,
                 'version', r.version,
                 'structureVersion', r.structure_version,
                 'questionCount', (select count(*) from public.form_questions q where q.form_id = r.form_id),
                 'openedAt', to_char(r.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'draft', (select jsonb_build_object('id', dr.id, 'version', dr.version)
                             from public.form_responses dr, viewer
                            where dr.form_id = r.form_id and dr.status = 'draft'
                              and dr.respondent_id = viewer.id
                            limit 1))
                 order by r.rn) as forms
          from ranked r
         where r.session_id = s.id and r.rn <= 20
      ) t on true
  )
  select jsonb_build_object('sessions', coalesce(jsonb_agg(jsonb_build_object(
           'workSessionId', p.id, 'total', p.total, 'queued', p.queued, 'forms', p.forms)
           order by p.ord) filter (where p.total > 0 or p.queued > 0), '[]'::jsonb))
    from per_session p
$$;
revoke all on function public.forms_pending_for_sessions(uuid, uuid[]) from public;
grant execute on function public.forms_pending_for_sessions(uuid, uuid[]) to tm8_app;

-- -----------------------------------------------------------------------------
-- F. VERIFY — only what this file creates.
-- -----------------------------------------------------------------------------
do $verify$
declare missing text;
begin
  select string_agg(needed, ', ') into missing
    from unnest(array[
      'internal.form_delivery_effective(jsonb,text)',
      'public.claim_form_deliveries(uuid,uuid,integer,integer,text[])',
      'public.redeliver_form_response(uuid,text,uuid,uuid,text)',
      'public.forms_pending_for_sessions(uuid,uuid[])'
    ]) as needed
   where to_regprocedure(needed) is null;
  if missing is not null then
    raise exception '217: missing %', missing;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'form_deliveries'
                    and column_name = 'route_override') then
    raise exception '217: form_deliveries.route_override missing';
  end if;
end
$verify$;

reset role;
