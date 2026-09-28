-- ordinal: placeholder (988, lane L1; the Release Owner numbers it at merge, after #930's 274 and R1/S7b's 995)
-- =============================================================================
-- W6 a2 (task 01a0e767-3aaf) + hardening (task 01a0db7e-6ef5). Decision 31 and
-- E2: on B, a `link` session is the member for every op EXCEPT credential ops,
-- which B refuses IN SQL. W6 (250/251) put the refusal on the credential
-- WRITERS through the strict gate; L1's verify probe on main 79efe3fb found the
-- READERS still admitted a `link` session (only the TS layer stopped them).
-- This file makes SQL the first layer. It only ever TIGHTENS: no caller other
-- than a `link` session (and, for expire_pending, a non-human one) sees a
-- different answer.
--
-- Measured set (pg_proc: every public function tm8_app may execute whose name
-- is credential-family, called as H's link session in B vs H's browser, on
-- main b790934d; plus the facade registry). Rulings: P1b coordinator
-- 01a0e734, credentials coordinator 01a0e724, epic lead amendment 2026-09-28.
-- Register 01a0e26b, section "L1 / W6-a2 + hardening".
--
--   REFUSED for link (42501, first statement; internal.refuse_link_session):
--     list_space_credentials        (239 body)
--     read_space_credential         (239 body)
--     my_space_credential_default_id (255 body; #930's link-bound spawn skips
--                                    it, credential-resolution.ts:180)
--     repoint_session_space_credentials(uuid) (239 body; the (uuid, text[])
--                                    overload (255) calls it, so both refuse)
--   CONDITIONAL, no raise:
--     session_stream_credential_allowed (257 body): for a link caller the
--       private-credential OWNER exemption is dropped, so a link never sees a
--       session that records a private space credential, not even the
--       holder's own. It stays a boolean: execution.journal/transcript and the
--       PTY recheck ask it per session and must not error for a link member.
--   ADMITTED for link ONLY under #930's live link-spawn reservation, else 42501
--   (the link spawn in B reads them under link claims):
--     read_space_credential_policy, read_node_credential_policy,
--     usable_space_credential_ids, record_session_credential_binding
--     -- §6, pending #930's internal.link_spawn_reservation_live(uuid).
--   Hardening a1: expire_pending_space_credentials (239 body) calls the strict
--     gate internal.require_human_auth_kind() first. Every caller borrows a
--     human space-login principal's claims (credential-sessions.ts:957, 1473),
--     so tm8_app keeps EXECUTE and the caller class is what is pinned.
--   space_credential_readiness: §7, on R1/S7b's 995 body once merged.
--
-- Every function here is tm8_graph_owner-owned (measured, fresh DB), so every
-- redefinition sits inside the role block; create or replace keeps the owner.
-- Bodies are verbatim from the latest definer named, plus the guard.
-- =============================================================================

set local lock_timeout = '5s';
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 0. The one refusal every reader below makes. Invoker rights: it reads only
--    the caller's own claim.
-- -----------------------------------------------------------------------------
create or replace function internal.refuse_link_session(p_what text)
returns void
language plpgsql stable set search_path = public, internal, pg_temp as $$
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    raise exception 'a space link session cannot %', p_what
      using errcode = '42501', detail = jsonb_build_object('reason', 'link_session')::text;
  end if;
end
$$;
revoke all on function internal.refuse_link_session(text) from public;

-- -----------------------------------------------------------------------------
-- 1. list_space_credentials — 239 body.
-- -----------------------------------------------------------------------------
create or replace function public.list_space_credentials(p_space_id uuid, p_include_revoked boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare rows jsonb;
begin
  perform internal.refuse_link_session('list space credentials');
  perform internal.require_space_member(p_space_id);
  select coalesce(jsonb_agg(internal.space_credential_json(sc)
                            order by sc.provider, sc.is_default desc, sc.label), '[]'::jsonb)
    into rows
    from public.space_credentials sc
   where sc.space_id = p_space_id
     and (coalesce(p_include_revoked, false) or sc.status <> 'revoked');
  return rows;
end
$$;

-- -----------------------------------------------------------------------------
-- 2. read_space_credential — 239 body.
-- -----------------------------------------------------------------------------
create or replace function public.read_space_credential(p_credential_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  perform internal.refuse_link_session('read a space credential');
  select * into stored from public.space_credentials where id = p_credential_id;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    return null;
  end if;
  return internal.space_credential_json(stored);
end
$$;

-- -----------------------------------------------------------------------------
-- 3. my_space_credential_default_id — 255 body.
-- -----------------------------------------------------------------------------
create or replace function public.my_space_credential_default_id(p_space_id uuid, p_provider text)
returns uuid
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v_id uuid;
begin
  perform internal.refuse_link_session('read a default space credential');
  perform internal.require_space_member(p_space_id);
  select md.credential_id into v_id
    from public.member_defaults md
    join public.space_credentials sc on sc.id = md.credential_id
   where md.space_id = p_space_id
     and md.account_id = internal.current_account_id()
     and md.provider = p_provider
     and sc.status = 'active';
  return v_id;
end
$$;

-- -----------------------------------------------------------------------------
-- 4. session_stream_credential_allowed — 257 body. The only change is the
--    owner exemption, which a link caller no longer gets.
-- -----------------------------------------------------------------------------
create or replace function public.session_stream_credential_allowed(p_session_id uuid)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select coalesce(internal.is_space_member(
           (select e.space_id from public.entities e where e.id = p_session_id)), false)
     and not exists (
    select 1
      from public.session_space_credentials ssc
      join public.space_credentials sc
        on sc.id = ssc.space_credential_id and sc.space_id = ssc.space_id
     where ssc.work_session_id = p_session_id
       and sc.visibility = 'private'
       and (coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link'
            or not exists (
         select 1 from public.accounts a
          where a.id = sc.owner_account_id
            and a.status = 'active'
            and a.identity_id = nullif(btrim(current_setting('tm8.identity_id', true)), ''))))
$$;

-- -----------------------------------------------------------------------------
-- 5. expire_pending_space_credentials — 239 body behind the strict gate
--    (hardening 01a0db7e a1). A node-wide delete no longer runs for an agent,
--    a link, or a claim-free caller.
-- -----------------------------------------------------------------------------
create or replace function public.expire_pending_space_credentials()
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare removed integer; expired uuid[];
begin
  perform internal.require_human_auth_kind();
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
-- 5b. repoint_session_space_credentials(uuid) — 239 body (hardening 01a0db7e
--     a2: LIVE, SpawnService.ts:1183 on resume). The (uuid, text[]) overload
--     (255) calls this one, so a link resume refuses on either.
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
  perform internal.refuse_link_session('re-point a session''s space credentials');
  e := internal.live_entity(p_work_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  v_launcher := internal.current_account_id();
  if v_launcher is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

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
-- 6. PENDING #930's internal.link_spawn_reservation_live(uuid): the four
--    spawn-path readers admit a link only under it.
-- 7. PENDING R1/S7b's 995: space_credential_readiness refuses link.
-- -----------------------------------------------------------------------------

reset role;
