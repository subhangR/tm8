-- =============================================================================
-- 990 (PLACEHOLDER ordinal; the real one is taken at the merge position)
-- — the credential definers 250's header left open to kind `link`
-- (task 01a0fb54, follow-up from #864's security review).
--
-- THE PROBLEM. 250's header named six security-definer credential functions,
-- granted to tm8_app, that never call `internal.require_human_auth_kind()`:
--
--   function                                 caller (packages/server/src)                       kinds that legitimately call it
--   read_account_git_credential (093/256)    credentials/github-credential-store.ts:81           browser, cli, agent, agent_runtime
--   read_space_credential_for_spawn (206/271) credentials/space-credential-store.ts:560          browser, cli, agent, agent_runtime
--   read_space_credential_policy (206)       credentials/space-credential-port.ts:71 (spawn),   browser, cli, agent, agent_runtime;
--                                            facade/services/w2/space-credential-catalog.ts:517  link only on its own target (L4)
--   read_node_credential_policy (206)        space-credential-port.ts:72, catalog.ts:518/543    as above; link with its link claim
--   repoint_session_space_credentials        credentials/space-credential-port.ts:158 (resume)  browser, cli, agent, agent_runtime;
--     (uuid) 239, (uuid, text[]) 255                                                         link only for a session its link started
--   expire_pending_space_credentials (239)   facade/services/w2/credential-sessions.ts:957,1473  browser, cli (the login opener's
--                                            (the space-login sweep)                             claims); agent tolerated (206: "any
--                                                                                                claims"); never link-bound
--
-- None of them may join the strict gate: agents spawn and resume, and 206
-- documents the policy readers and the sweep as callable under agent claims.
-- The two sealed-secret readers are already done by W7 (256 and 271): 093
-- refuses every link-bound caller, 206 admits a link-bound caller only for the
-- target's default credential. This file covers the other four.
--
-- WHY NOT A FLAT `kind = link` REFUSAL. On main a link session never reaches
-- these: `execution.spawn/resume/dispatch` and the transport refuse it in TS
-- (identity/link-bearer.ts). The owner's decision D1/D4/D8 (form 01a0fbb4,
-- W7b lane L4, on tm8/cross-space-integration) lets `spaceLinks.invoke` run
-- spawn and resume in the target space AS the link session, which reads both
-- policies and re-points on resume. So the SQL rule is the link's own scope,
-- the same narrowing L4 applies to the mint, and it refuses everything else:
--
--   1. read_space_credential_policy(p_space_id): a `link` caller must carry its
--      `tm8.via_link` claim, and p_space_id must be that link's target space.
--   2. read_node_credential_policy(): a `link` caller must carry its claim.
--   3. repoint_session_space_credentials, both overloads: a `link` caller must
--      carry its claim AND the work session must hold an auth session minted
--      under that link (the link started it — L4's "resumes only sessions it
--      started" rule). On main no such session exists, so this refuses. The
--      (uuid, text[]) overload checks before its delete.
--   4. expire_pending_space_credentials(): refuses every link-bound caller
--      (`internal.link_bound()`: kind link, or a via_link agent). Nothing on a
--      link opens a space login; there is no caller to admit.
--
-- Agent kinds, browser and cli are unchanged. All refusals are 42501.
--
-- 250'S HEADER. It says these six "are not refused for `link` by this file:
-- that SQL refusal is W7's gate". Before this file that held for two of six
-- (256, 271). With it, all six refuse a `link` caller outside its link's
-- scope in SQL, so the claim matches the code. 250 itself is not edited: it
-- is applied, and db/migrate.mjs refuses a checksum drift.
--
-- ADDS ONLY — per top-level statement:
--   * create or replace function: 2 new internal helpers; 5 redefinitions, each
--     the latest body (named at each) plus one guard as its first statement.
--   * revoke: the two new helpers only. No grant changes, no data change.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The helper. A no-op for every kind but `link`. A `link` caller needs its
--    link claim; with p_space_id it must also be that link's live target.
-- -----------------------------------------------------------------------------
create or replace function internal.require_link_scope(p_space_id uuid)
returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v_link uuid;
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') <> 'link' then
    return;
  end if;
  v_link := nullif(internal.claim_text('tm8.via_link'), '')::uuid;
  if v_link is null then
    raise exception 'a space link session without its link is refused here' using errcode = '42501';
  end if;
  if p_space_id is not null and not exists (
    select 1
      from public.space_links l
      join public.entities e on e.id = l.entity_id
     where l.entity_id = v_link
       and l.target_space_id = p_space_id
       and e.deleted_at is null
  ) then
    raise exception 'a space link session acts only in its link''s target space' using errcode = '42501';
  end if;
end
$$;

revoke all on function internal.require_link_scope(uuid) from public;

-- -----------------------------------------------------------------------------
-- 2. Policy readers — 206 bodies plus the scope.
-- -----------------------------------------------------------------------------
create or replace function public.read_space_credential_policy(p_space_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_link_scope(p_space_id);
  perform internal.require_space_member(p_space_id);
  return coalesce((select jsonb_object_agg(provider, to_jsonb(allowed_sources))
                     from public.space_credential_policies where space_id = p_space_id),
                  '{}'::jsonb);
end
$$;

create or replace function public.read_node_credential_policy()
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_link_scope(null);
  perform internal.require_identity();
  return coalesce((select jsonb_object_agg(provider, allow_node)
                     from public.node_credential_policies), '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 3. Resume re-point. 239's body for (uuid), 255's for (uuid, text[]); each
--    first refuses a `link` caller whose link did not start the session.
-- -----------------------------------------------------------------------------
create or replace function internal.require_link_started(p_work_session_id uuid)
returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') <> 'link' then
    return;
  end if;
  perform internal.require_link_scope(null);
  if not exists (
    select 1 from public.auth_sessions s
     where s.work_session_id = p_work_session_id
       and s.via_link_id = internal.claim_text('tm8.via_link')::uuid
  ) then
    raise exception 'a space link re-points only sessions it started' using errcode = '42501';
  end if;
end
$$;

revoke all on function internal.require_link_started(uuid) from public;

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

create or replace function public.repoint_session_space_credentials(p_work_session_id uuid, p_providers text[])
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  v_status text;
  v_persona uuid;
begin
  perform internal.require_link_started(p_work_session_id);
  e := internal.live_entity(p_work_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  if internal.current_account_id() is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  -- F-R13a: the resume window only, under the row lock execution_resume (062)
  -- takes. 'spawning' is entered by the spawn insert and by execution_resume
  -- alone (work_session_transition refuses it), and a fresh spawn never
  -- re-points, so 'spawning' with a resume on record IS the resume window.
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
  if v_persona is not null and not internal.can_act_as(v_persona, e.space_id) then
    raise exception 'not permitted to resume this persona' using errcode = '42501';
  end if;
  delete from public.session_space_credentials
   where work_session_id = p_work_session_id
     and provider <> all (coalesce(p_providers, array[]::text[]));
  return public.repoint_session_space_credentials(p_work_session_id);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. The pending-expiry sweep — 239's body; a link-bound caller is refused.
-- -----------------------------------------------------------------------------
create or replace function public.expire_pending_space_credentials()
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare removed integer; expired uuid[];
begin
  if internal.link_bound() then
    raise exception 'a space link session cannot run the pending-credential sweep' using errcode = '42501';
  end if;
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
