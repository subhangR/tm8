-- =============================================================================
-- 072 agent session credentials — persona-pinned bearer per work-session run.
--
-- A spawned agent must never inherit the human's browser/CLI credential. Each
-- spawn (and each resume) gets a newly-minted agent session pinned to both the
-- persona and work_session. Minting atomically revokes the previous live token
-- for that work_session; lifecycle cleanup revokes it again on exit/terminate.
-- Plaintext exists only in the process environment of the agent run.
-- =============================================================================
set role tm8_graph_owner;

alter table public.auth_sessions
  add column if not exists work_session_id uuid
    references public.work_sessions(entity_id) on delete cascade;

create unique index if not exists auth_sessions_one_live_agent_per_work_session
  on public.auth_sessions(work_session_id)
  where kind = 'agent' and work_session_id is not null and revoked_at is null;

comment on column public.auth_sessions.work_session_id is
  'For agent sessions, the exact work_session run this credential belongs to. '
  'A resume re-mints and atomically revokes the previous live row.';

-- 007 body preserved, plus workSessionId. This remains the claim-free bearer
-- bootstrap read; the hash is the credential and is never returned.
create or replace function public.resolve_auth_session(p_token_hash text)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'sessionId', s.id, 'accountId', a.id, 'identityId', a.identity_id,
    'username', a.username, 'displayName', a.display_name,
    'isNodeAdmin', a.is_node_admin, 'isOwner', a.is_owner,
    'kind', s.kind, 'actingAsTeamMemberId', s.acting_as_team_member_id,
    'workSessionId', s.work_session_id,
    'expiresAt', s.expires_at, 'label', s.label)
    from public.auth_sessions s
    join public.accounts a on a.id = s.account_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and a.status = 'active'
$$;

create or replace function public.issue_agent_auth_session(
  p_work_session_id uuid,
  p_team_member_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text := internal.require_identity();
  target_space uuid;
  account public.accounts;
  issued public.auth_sessions;
begin
  if p_expires_at <= now() then
    raise exception 'agent auth session expiry must be in the future' using errcode = '22023';
  end if;

  select e.space_id into target_space
    from public.entities e
    join public.work_sessions ws on ws.entity_id = e.id
   where e.id = p_work_session_id and e.deleted_at is null
   for update of ws;
  if target_space is null then
    raise exception 'work session not found' using errcode = 'P0002';
  end if;

  if not internal.can_act_as(p_team_member_id, target_space)
     or not exists (
       select 1 from public.edges edge
        where edge.src_id = p_team_member_id
          and edge.dst_id = p_work_session_id
          and edge.type = 'participates_in'
     ) then
    raise exception 'agent credential persona does not participate in this work session'
      using errcode = '42501';
  end if;

  select * into account
    from public.accounts a
   where a.identity_id = identity and a.status = 'active';
  if account.id is null then
    raise exception 'account not found or disabled' using errcode = 'P0002';
  end if;

  -- Serialize on the work_session above, then retire every earlier run token
  -- before inserting the replacement. Plaintext is never persisted here.
  update public.auth_sessions
     set revoked_at = now()
   where work_session_id = p_work_session_id
     and kind = 'agent'
     and revoked_at is null;

  insert into public.auth_sessions(
    account_id, kind, acting_as_team_member_id, work_session_id,
    token_hash, label, expires_at
  ) values (
    account.id, 'agent', p_team_member_id, p_work_session_id,
    p_token_hash, p_label, p_expires_at
  ) returning * into issued;

  return to_jsonb(issued) - 'token_hash';
end
$$;

create or replace function public.revoke_agent_auth_session(p_work_session_id uuid)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  target_space uuid;
  persona_id uuid;
begin
  perform internal.require_identity();
  select e.space_id, s.acting_as_team_member_id
    into target_space, persona_id
    from public.auth_sessions s
    join public.entities e on e.id = s.work_session_id
   where s.work_session_id = p_work_session_id
     and s.kind = 'agent'
   order by s.created_at desc
   limit 1;
  if target_space is null then return; end if;
  if persona_id is null or not internal.can_act_as(persona_id, target_space) then
    raise exception 'not permitted to revoke this agent credential' using errcode = '42501';
  end if;
  update public.auth_sessions
     set revoked_at = now()
   where work_session_id = p_work_session_id
     and kind = 'agent'
     and revoked_at is null;
end
$$;

revoke all on function public.resolve_auth_session(text) from public;
revoke all on function public.issue_agent_auth_session(uuid, uuid, text, timestamptz, text) from public;
revoke all on function public.revoke_agent_auth_session(uuid) from public;
grant execute on function public.resolve_auth_session(text) to tm8_app;
grant execute on function public.issue_agent_auth_session(uuid, uuid, text, timestamptz, text) to tm8_app;
grant execute on function public.revoke_agent_auth_session(uuid) to tm8_app;

reset role;
