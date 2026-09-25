-- =============================================================================
-- 222 — forms.pendingForSessions: the viewer must belong to the space asked about.
--
-- 221's `public.forms_pending_for_sessions` resolved the viewer as
-- coalesce(actor_id(), current_member_id(space)) and then checked only its
-- KIND. A teammate bound in space A that reads space B (its owner's identity is
-- a member of B, so RLS admits the read) was treated as a team_member
-- respondent of B: B's `respondents: anyone` forms were listed as waiting on
-- it, though form_assert_respondent refuses that respondent (space mismatch),
-- so the chip named forms it could never answer. The viewer is now resolved
-- only when it is a live entity OF p_space_id; otherwise nothing waits on it.
--
-- REPLACES THE WHOLE FUNCTION (221's body, one change: the viewer_kind lookup).
-- A later file replacing it again must carry that change too.
-- =============================================================================

set role tm8_graph_owner;

create or replace function public.forms_pending_for_sessions(p_space_id uuid, p_session_ids uuid[])
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  -- Resolved ONCE, as plpgsql constants: the claim readers are not
  -- immutable, so inside the statement they would defeat every index on the
  -- entities and form_responses lookups keyed by the viewer.
  viewer uuid := coalesce(internal.actor_id(), internal.current_member_id(p_space_id));
  viewer_kind text;
  out jsonb;
begin
  if viewer is null then
    return jsonb_build_object('sessions', '[]'::jsonb);
  end if;
  -- The viewer must be a live respondent entity OF THIS SPACE: a teammate
  -- bound from another space reads this one through its owner's identity, but
  -- form_assert_respondent refuses it here (space mismatch), so nothing waits
  -- on it. 222: 221 checked only the kind.
  select e.kind into viewer_kind from public.entities e
   where e.id = viewer and e.space_id = p_space_id and e.deleted_at is null;
  if viewer_kind is null then
    return jsonb_build_object('sessions', '[]'::jsonb);
  end if;

  with waiting as (
    -- Driven by the session ids, one (type, dst_id) index probe each: the
    -- authored_from set as a whole also holds every message authored from a
    -- session, so it must never be scanned by source. `offset 0` fences the
    -- lateral so the planner cannot flatten it into such a scan when its
    -- statistics are small (a fresh node, a test database).
    select sid.id as session_id, f.entity_id as form_id, f.title, fe.version, f.structure_version,
           f.opened_at, fe.created_at
      from unnest(p_session_ids) as sid(id)
      cross join lateral (
        select e.src_id from public.edges e
         where e.dst_id = sid.id and e.type = 'authored_from'
        offset 0) ed
      join public.entities fe on fe.id = ed.src_id and fe.kind = 'form' and fe.deleted_at is null
                             and fe.space_id = p_space_id
      join public.forms f on f.entity_id = fe.id and f.status = 'open'
     where (viewer_kind = 'member'
            or (viewer_kind = 'team_member'
                and internal.form_settings_effective(f.settings) ->> 'respondents' = 'anyone'))
       and not exists (
         select 1 from public.form_responses r
          where r.form_id = f.entity_id and r.status = 'submitted'
            and case internal.form_settings_effective(f.settings) ->> 'responses'
                  when 'single' then r.is_current
                  when 'unlimited' then r.respondent_id = viewer
                  else r.is_current and r.respondent_id = viewer
                end)
  ),
  ranked as (
    select w.*, row_number() over (partition by w.session_id
                                   order by coalesce(w.opened_at, w.created_at) desc, w.form_id desc) as rn,
           count(*) over (partition by w.session_id) as total
      from waiting w
  ),
  listed as (
    select r.session_id, max(r.total) as total,
           jsonb_agg(jsonb_build_object(
             'formId', r.form_id,
             'title', r.title,
             'version', r.version,
             'structureVersion', r.structure_version,
             'questionCount', (select count(*) from public.form_questions q where q.form_id = r.form_id),
             'openedAt', to_char(r.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'draft', (select jsonb_build_object('id', dr.id, 'version', dr.version)
                         from public.form_responses dr
                        where dr.form_id = r.form_id and dr.status = 'draft' and dr.respondent_id = viewer
                        limit 1))
             order by r.rn) as forms
      from ranked r
     where r.rn <= 20
     group by r.session_id
  ),
  -- QUEUED means waiting for THIS session to come back (§7.3, R4): a pending
  -- row aimed at the requesting session while it is not live ('spawning', a
  -- resume in progress, still counts). An injection in flight to a live
  -- session is not queued, and neither is a row routed to a new session.
  -- Driven by the session ids through form_deliveries_pending_by_session,
  -- fenced like the edges probe above so it never becomes a scan of every
  -- response in the node.
  queued as (
    select sid.id as session_id, count(*) as queued
      from unnest(p_session_ids) as sid(id)
      cross join lateral (
        select d.route_override,
               -- key probes per row, never a join the planner may hash
               (select f.settings from public.form_responses fr
                  join public.forms f on f.entity_id = fr.form_id
                 where fr.id = d.response_id) as settings
          from public.form_deliveries d
         where d.work_session_id = sid.id and d.status = 'pending'
        offset 0) fd
     -- One primary-key probe per session, not a join the planner may hash.
     where coalesce((select ws.status from public.work_sessions ws where ws.entity_id = sid.id), '')
             not in ('running', 'idle')
       and internal.form_delivery_effective(fd.settings, fd.route_override) ->> 'target' = 'requesting_session'
     group by sid.id
  )
  select jsonb_build_object('sessions', coalesce(jsonb_agg(jsonb_build_object(
           'workSessionId', s.id,
           'total', coalesce(l.total, 0),
           'queued', coalesce(qd.queued, 0),
           'forms', coalesce(l.forms, '[]'::jsonb)) order by s.ord), '[]'::jsonb))
    into out
    from unnest(p_session_ids) with ordinality as s(id, ord)
    left join listed l on l.session_id = s.id
    left join queued qd on qd.session_id = s.id
   where l.session_id is not null or qd.session_id is not null;
  return out;
end
$$;
revoke all on function public.forms_pending_for_sessions(uuid, uuid[]) from public;
grant execute on function public.forms_pending_for_sessions(uuid, uuid[]) to tm8_app;

-- -----------------------------------------------------------------------------
-- VERIFY — the replacement carries the space check.
-- -----------------------------------------------------------------------------
do $verify$
begin
  if position('e.space_id = p_space_id and e.deleted_at is null' in
              pg_get_functiondef('public.forms_pending_for_sessions(uuid,uuid[])'::regprocedure)) = 0 then
    raise exception '222: forms_pending_for_sessions lacks the viewer space check';
  end if;
end
$verify$;

reset role;
