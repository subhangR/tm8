-- =============================================================================
-- 991 (HIGH PLACEHOLDER: the real ordinal is taken at merge time, 288+ in merge
-- order) — the repoint_session_space_credentials family, stacked on 990
-- (#1006, credential definers link scope). Three follow-ups:
--
--   01a0fb56-c9d0  The 1-arg re-point gets the resume gate 255 gave the 2-arg
--                  overload (F-R13a): under the work_sessions row lock that
--                  execution_resume takes, the session must be 'spawning' with a
--                  resume on record (55000 otherwise), and the caller must be
--                  able to act as the session's persona (42501). Before this,
--                  the 1-arg form re-pointed launcher_account_id at any time on
--                  membership alone. Both overloads now share
--                  internal.require_resume_window. 990's link-scope guard
--                  (internal.require_link_started) stays first in each body.
--
--   01a0fb58-2260  CLASSIFICATION of repoint_session_space_credentials: LIVE.
--                  pg_proc: both overloads are SECURITY DEFINER with EXECUTE
--                  granted to tm8_app. It has no catalog op. Its one caller is
--                  SpawnService.repointSpaceCredentials, through the space-
--                  credential port: the 1-arg form on the unreadable-posture
--                  path, the 2-arg form otherwise. Both run inside the resume
--                  window. It admits kind 'link' only for a session its link
--                  started (990; W7's matrix cell is 990's pg cell).
--                  GUARD for expire_pending_space_credentials: an identity is
--                  required (internal.require_identity), on top of 990's
--                  link_bound() refusal. Before this, a tm8_app call carrying
--                  no claims at all ran the node-wide delete. Agent kinds stay
--                  admitted, as 206 deliberately allowed and as 990's table
--                  records. The caller set is pinned in
--                  test/expire-pending-caller-pin.test.ts (TS callers) and by
--                  a pg cell that no SQL function calls it.
--                  internal.require_human_auth_kind() and its pin list are NOT
--                  touched.
--
--   01a0fb59-5ec0  F-R13b: the 2-arg re-point no longer DELETEs the rows of the
--                  providers a resume did not resolve. It MOVES them into
--                  public.session_space_credential_history, a tombstone with
--                  superseded_at, in the same statement. History lives in its
--                  own table, so every live reader of session_space_credentials
--                  ignores tombstones without being redefined: the 1-arg
--                  re-point's active/usable check, the revoke and
--                  switch-to-private kill lists, the R8 sweep, the stream gate,
--                  disable and membership containment, and the runs_on edge.
--                  Only the two history readers change, and each unions both
--                  tables: space_credential_usage (rows carry supersededAt)
--                  and space_credential_foreign_launches. The table is owned
--                  by tm8_graph_owner, with RLS on and the same member-select
--                  policy as session_space_credentials. It is STRICTER on
--                  grants: no grant to public, and none to tm8_app, whereas
--                  session_space_credentials grants tm8_app column SELECT.
--                  Only the two SECURITY DEFINER readers above read it.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The tombstone table.
-- -----------------------------------------------------------------------------
create table public.session_space_credential_history (
  work_session_id      uuid not null references public.work_sessions(entity_id) on delete cascade,
  provider             text not null,
  space_credential_id  uuid not null,
  space_id             uuid not null,
  launcher_account_id  uuid references public.accounts(id) on delete set null,
  recorded_at          timestamptz not null,
  updated_at           timestamptz not null,
  owner_account_id     uuid references public.accounts(id) on delete set null,
  agent_session_id     uuid references public.work_sessions(entity_id) on delete set null,
  source               text,
  superseded_at        timestamptz not null default now(),
  superseded_by_account_id uuid references public.accounts(id) on delete set null,
  primary key (work_session_id, provider, superseded_at),
  constraint session_space_credential_history_credential_fk
    foreign key (space_credential_id, space_id)
    references public.space_credentials(id, space_id) on delete cascade
);

create index session_space_credential_history_credential_idx
  on public.session_space_credential_history (space_credential_id);

alter table public.session_space_credential_history enable row level security;

create policy session_space_credential_history_member_select
  on public.session_space_credential_history for select
  using (space_id = any ((select internal.member_space_ids())::uuid[]));

revoke all on table public.session_space_credential_history from public;

-- -----------------------------------------------------------------------------
-- 2. The resume window (255's F-R13a body, lifted so both overloads share it).
-- -----------------------------------------------------------------------------
create or replace function internal.require_resume_window(p_work_session_id uuid, p_space_id uuid)
returns void
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  v_status text;
  v_persona uuid;
begin
  -- 'spawning' is entered by the spawn insert and by execution_resume alone
  -- (work_session_transition refuses it), and a fresh spawn never re-points,
  -- so 'spawning' with a resume on record IS the resume window.
  select status into v_status from public.work_sessions
   where entity_id = p_work_session_id for update;
  if v_status is distinct from 'spawning'
     or not exists (select 1 from public.activity a
                     where a.entity_id = p_work_session_id and a.verb = 'restored'
                       and a.summary ->> 'action' = 'resumed') then
    raise exception 'only a session being resumed can be re-pointed' using errcode = '55000';
  end if;
  -- Resume's authorization, not bare membership: the caller may act as the
  -- session's persona, exactly as execution_resume requires.
  select dst_id into v_persona from public.edges
   where src_id = p_work_session_id and type = 'relates_to'
   limit 1;
  if v_persona is not null and not internal.can_act_as(v_persona, p_space_id) then
    raise exception 'not permitted to resume this persona' using errcode = '42501';
  end if;
end
$$;

revoke all on function internal.require_resume_window(uuid, uuid) from public;

-- -----------------------------------------------------------------------------
-- 3. The 1-arg re-point: 990's body plus the resume window.
-- -----------------------------------------------------------------------------
create or replace function public.repoint_session_space_credentials(p_work_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  v_launcher uuid;
  v_recorded integer;
  v_active integer;
  v_usable integer;
  rows jsonb;
begin
  perform internal.require_link_started(p_work_session_id);
  e := internal.live_entity(p_work_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  v_launcher := internal.current_account_id();
  if v_launcher is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  perform internal.require_resume_window(p_work_session_id, e.space_id);

  select count(*) into v_recorded from public.session_space_credentials
   where work_session_id = p_work_session_id;
  select count(*),
         count(*) filter (where locked.visibility = 'public' or locked.owner_account_id is null
                                or locked.owner_account_id = v_launcher)
    into v_active, v_usable
    from (
    select sc.id, sc.visibility, sc.owner_account_id from public.space_credentials sc
      join public.session_space_credentials ssc on ssc.space_credential_id = sc.id
     where ssc.work_session_id = p_work_session_id
       and sc.status = 'active'
       and sc.space_id = e.space_id
     order by sc.id
       for share of sc
  ) locked;
  if v_active <> v_recorded then
    raise exception 'a space credential this session launched on is no longer active'
      using errcode = '23514';
  end if;
  if v_usable <> v_recorded then
    raise exception 'a space credential this session launched on is private to its owner'
      using errcode = '42501',
            detail = jsonb_build_object('reason', 'not_usable')::text;
  end if;

  update public.session_space_credentials
     set launcher_account_id = v_launcher, updated_at = now()
   where work_session_id = p_work_session_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'provider', provider, 'spaceCredentialId', space_credential_id)
           order by provider), '[]'::jsonb)
    into rows
    from public.session_space_credentials where work_session_id = p_work_session_id;
  return jsonb_build_object('workSessionId', p_work_session_id,
                            'launcherAccountId', v_launcher, 'credentials', rows);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. The 2-arg re-point: 990's body; the gate is the shared helper, and the
--    unresolved providers' rows move to history instead of being deleted. A
--    refusal later in the tail call rolls the move back with everything else.
-- -----------------------------------------------------------------------------
create or replace function public.repoint_session_space_credentials(p_work_session_id uuid, p_providers text[])
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  v_me uuid;
begin
  perform internal.require_link_started(p_work_session_id);
  e := internal.live_entity(p_work_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  v_me := internal.current_account_id();
  if v_me is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  perform internal.require_resume_window(p_work_session_id, e.space_id);
  with gone as (
    delete from public.session_space_credentials
     where work_session_id = p_work_session_id
       and provider <> all (coalesce(p_providers, array[]::text[]))
    returning *
  )
  insert into public.session_space_credential_history (
    work_session_id, provider, space_credential_id, space_id, launcher_account_id,
    recorded_at, updated_at, owner_account_id, agent_session_id, source,
    superseded_at, superseded_by_account_id)
  select work_session_id, provider, space_credential_id, space_id, launcher_account_id,
         recorded_at, updated_at, owner_account_id, agent_session_id, source,
         now(), v_me
    from gone;
  return public.repoint_session_space_credentials(p_work_session_id);
end
$$;

-- -----------------------------------------------------------------------------
-- 5. The pending sweep: 990's body plus an identity.
-- -----------------------------------------------------------------------------
create or replace function public.expire_pending_space_credentials()
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare removed integer; expired uuid[];
begin
  if internal.link_bound() then
    raise exception 'a space link session cannot run the pending-credential sweep' using errcode = '42501';
  end if;
  perform internal.require_identity();
  with gone as (
    delete from public.space_credentials sc
     where sc.status = 'pending'
       and sc.pending_expires_at < now()
       and not exists (select 1 from public.credential_sessions cs
                        where cs.space_credential_id = sc.id
                          and cs.finished_at is null)
    returning sc.id
  )
  select coalesce(array_agg(id), array[]::uuid[]) into expired from gone;
  removed := coalesce(array_length(expired, 1), 0);
  if removed > 0 then
    perform set_config('tm8.credential_write', 'on', true);
    begin
      update public.entities set deleted_at = now(), updated_at = now()
       where id = any(expired) and kind = 'credential' and deleted_at is null;
    exception when others then
      perform set_config('tm8.credential_write', '', true);
      raise;
    end;
    perform set_config('tm8.credential_write', '', true);
  end if;
  return jsonb_build_object('expired', removed);
end
$$;

-- -----------------------------------------------------------------------------
-- 6. The history readers: 270's usage and 255's foreign-launches bodies, each
--    over live rows UNION tombstones.
-- -----------------------------------------------------------------------------
create or replace function public.space_credential_usage(p_credential_id uuid, p_limit integer default 100)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; rows jsonb;
begin
  perform internal.require_human_auth_kind();
  select * into stored from public.space_credentials where id = p_credential_id;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if not (coalesce(stored.owner_account_id = internal.current_account_id(), false)
          or ((stored.visibility = 'public' or stored.owner_account_id is null)
              and internal.is_space_admin(stored.space_id))) then
    raise exception 'only the credential''s owner can see its usage' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(u.row order by u.recorded_at desc, u.work_session_id), '[]'::jsonb) into rows
    from (
      select r.recorded_at, r.work_session_id,
             jsonb_build_object(
               'workSessionId', r.work_session_id, 'provider', r.provider,
               'source', r.source, 'credentialId', r.space_credential_id,
               'ownerAccountId', r.owner_account_id,
               'launcherAccountId', r.launcher_account_id,
               'agentSessionId', r.agent_session_id, 'status', ws.status,
               'recordedAt', r.recorded_at, 'updatedAt', r.updated_at,
               'supersededAt', r.superseded_at) as row
        from (
          select ssc.work_session_id, ssc.provider, ssc.source, ssc.space_credential_id,
                 ssc.owner_account_id, ssc.launcher_account_id, ssc.agent_session_id,
                 ssc.recorded_at, ssc.updated_at, null::timestamptz as superseded_at
            from public.session_space_credentials ssc
           where ssc.space_credential_id = stored.id
          union all
          select h.work_session_id, h.provider, h.source, h.space_credential_id,
                 h.owner_account_id, h.launcher_account_id, h.agent_session_id,
                 h.recorded_at, h.updated_at, h.superseded_at
            from public.session_space_credential_history h
           where h.space_credential_id = stored.id
        ) r
        join public.work_sessions ws on ws.entity_id = r.work_session_id
       order by r.recorded_at desc, r.work_session_id
       limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) u;
  return jsonb_build_object('credentialId', stored.id, 'sessions', rows);
end
$$;

create or replace function public.space_credential_foreign_launches(p_credential_id uuid, p_limit integer default 500)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; rows jsonb;
begin
  perform internal.require_human_auth_kind();
  select * into stored from public.space_credentials where id = p_credential_id;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if stored.owner_account_id is distinct from internal.current_account_id() then
    raise exception 'only the credential''s owner can scrub its login home' using errcode = '42501';
  end if;
  if stored.shape <> 'login' or stored.visibility <> 'private' or stored.status <> 'active' then
    return '[]'::jsonb;
  end if;
  -- A tombstoned row counts on the same terms as a live one: it was never
  -- re-pointed (the move copies updated_at as it was), it names a non-owner
  -- launcher, and the session has ended. One entry per session.
  select coalesce(jsonb_agg(u.row order by u.work_session_id), '[]'::jsonb) into rows
    from (
      select distinct on (r.work_session_id) r.work_session_id,
             jsonb_build_object(
               'workSessionId', r.work_session_id, 'provider', r.provider,
               'nativeSessionId', ws.native_session_id) as row
        from (
          select ssc.work_session_id, ssc.provider, ssc.launcher_account_id,
                 ssc.recorded_at, ssc.updated_at
            from public.session_space_credentials ssc
           where ssc.space_credential_id = stored.id
          union all
          select h.work_session_id, h.provider, h.launcher_account_id,
                 h.recorded_at, h.updated_at
            from public.session_space_credential_history h
           where h.space_credential_id = stored.id
        ) r
        join public.work_sessions ws on ws.entity_id = r.work_session_id
       where r.launcher_account_id is not null
         and r.launcher_account_id <> stored.owner_account_id
         and r.updated_at = r.recorded_at
         and ws.status in ('exited', 'failed')
       order by r.work_session_id, r.provider
       limit least(greatest(coalesce(p_limit, 500), 1), 500)
    ) u;
  return rows;
end
$$;

-- Grants unchanged by create or replace; restated for the redefined doors.
revoke all on function public.repoint_session_space_credentials(uuid) from public;
revoke all on function public.repoint_session_space_credentials(uuid, text[]) from public;
revoke all on function public.expire_pending_space_credentials() from public;
revoke all on function public.space_credential_usage(uuid, integer) from public;
revoke all on function public.space_credential_foreign_launches(uuid, integer) from public;
grant execute on function public.repoint_session_space_credentials(uuid) to tm8_app;
grant execute on function public.repoint_session_space_credentials(uuid, text[]) to tm8_app;
grant execute on function public.expire_pending_space_credentials() to tm8_app;
grant execute on function public.space_credential_usage(uuid, integer) to tm8_app;
grant execute on function public.space_credential_foreign_launches(uuid, integer) to tm8_app;

reset role;
