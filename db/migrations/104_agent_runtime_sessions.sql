-- =============================================================================
-- 104 agent-runtime sessions — requesting-human authority, teammate provenance.
--
-- TM8 Chat's headless runtime is neither a browser/CLI human nor an ordinary
-- spawned worker. It therefore gets a distinct, server-resolved auth kind.
-- The credential carries the requesting human account's authorization, is
-- pinned to the selected teammate for authorship, and is attributable to the
-- member + thread root that caused it to exist.
--
-- NOTE TO MERGE COORDINATOR: 104 was the free origin/main number at write
-- time. Lane 2 owns the earlier C2 migration and merge order is 1 -> 2 -> 3;
-- re-measure and renumber this file after lane 2 lands.
-- =============================================================================
set role tm8_graph_owner;

alter table public.auth_sessions
  drop constraint if exists auth_sessions_kind_check;
alter table public.auth_sessions
  add constraint auth_sessions_kind_check
  check (kind in ('browser', 'cli', 'agent', 'agent_runtime'));

alter table public.auth_sessions
  add column if not exists runtime_member_id uuid
    references public.members(entity_id) on delete cascade,
  add column if not exists runtime_thread_root_id uuid
    references public.messages(entity_id) on delete cascade;

alter table public.auth_sessions
  add constraint auth_sessions_agent_runtime_shape check (
    (
      kind = 'agent_runtime'
      and acting_as_team_member_id is not null
      and runtime_member_id is not null
      and runtime_thread_root_id is not null
      and work_session_id is null
    )
    or (
      kind <> 'agent_runtime'
      and runtime_member_id is null
      and runtime_thread_root_id is null
    )
  );

create unique index auth_sessions_one_live_runtime_per_thread
  on public.auth_sessions(runtime_thread_root_id)
  where kind = 'agent_runtime' and revoked_at is null;

comment on column public.auth_sessions.runtime_member_id is
  'For agent_runtime sessions, the requesting human member whose account claims authorize tool calls.';
comment on column public.auth_sessions.runtime_thread_root_id is
  'For agent_runtime sessions, the root message whose hot runtime owns this short-lived credential.';

-- 074 body preserved, plus runtime attribution. This is still the one
-- claim-free bearer bootstrap read; plaintext is never stored or returned.
create or replace function public.resolve_auth_session(p_token_hash text)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'sessionId', s.id, 'accountId', a.id, 'identityId', a.identity_id,
    'username', a.username, 'displayName', a.display_name,
    'isNodeAdmin', a.is_node_admin, 'isOwner', a.is_owner,
    'kind', s.kind, 'actingAsTeamMemberId', s.acting_as_team_member_id,
    'workSessionId', s.work_session_id,
    'runtimeMemberId', s.runtime_member_id,
    'runtimeThreadRootId', s.runtime_thread_root_id,
    'expiresAt', s.expires_at, 'label', s.label)
    from public.auth_sessions s
    join public.accounts a on a.id = s.account_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and a.status = 'active'
$$;

-- Internal server helper only. This is deliberately NOT a catalog operation:
-- the browser never mints a runtime credential, and C4's single catalog row
-- belongs to lane 2's thread-start/config operation.
create or replace function public.issue_agent_runtime_session(
  p_thread_root_id uuid,
  p_team_member_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text := internal.require_identity();
  target_space uuid;
  requester_member uuid;
  account public.accounts;
  issued public.auth_sessions;
begin
  -- Runtime credentials inherit a human account's authority, so only an
  -- authenticated browser/CLI request may create one. In particular, an
  -- agent_runtime token cannot extend its own lifetime by minting a successor.
  perform internal.require_human_auth_kind();

  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid agent runtime token hash' using errcode = '22023';
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '24 hours' then
    raise exception 'agent runtime expiry must be within the next 24 hours' using errcode = '22023';
  end if;

  -- A chat thread is an ordinary ROOT message. Locking it serializes two
  -- concurrent turn-start attempts before the old live token is revoked.
  select entity_row.space_id into target_space
    from public.messages message_row
    join public.entities entity_row on entity_row.id = message_row.entity_id
   where message_row.entity_id = p_thread_root_id
     and message_row.root_message_id is null
     and entity_row.deleted_at is null
   for update of message_row;
  if target_space is null then
    raise exception 'chat thread root not found' using errcode = 'P0002';
  end if;

  requester_member := internal.current_member_id(target_space);
  if requester_member is null then
    raise exception 'requesting identity is not a member of this thread space' using errcode = '42501';
  end if;
  if not internal.can_act_as(p_team_member_id, target_space) then
    raise exception 'requesting member cannot use this teammate in the thread space' using errcode = '42501';
  end if;

  select * into account
    from public.accounts account_row
   where account_row.identity_id = identity and account_row.status = 'active';
  if account.id is null then
    raise exception 'account not found or disabled' using errcode = 'P0002';
  end if;

  update public.auth_sessions
     set revoked_at = now()
   where runtime_thread_root_id = p_thread_root_id
     and kind = 'agent_runtime'
     and revoked_at is null;

  insert into public.auth_sessions(
    account_id, kind, acting_as_team_member_id,
    runtime_member_id, runtime_thread_root_id,
    token_hash, label, expires_at
  ) values (
    account.id, 'agent_runtime', p_team_member_id,
    requester_member, p_thread_root_id,
    p_token_hash, p_label, p_expires_at
  ) returning * into issued;

  return to_jsonb(issued) - 'token_hash';
end
$$;

-- Idempotent lifecycle cleanup. Any current member of the thread's space may
-- close its runtime; the row still records which member originally minted it.
create or replace function public.revoke_agent_runtime_session(p_thread_root_id uuid)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  target_space uuid;
begin
  perform internal.require_identity();
  perform internal.require_human_auth_kind();
  select entity_row.space_id into target_space
    from public.messages message_row
    join public.entities entity_row on entity_row.id = message_row.entity_id
   where message_row.entity_id = p_thread_root_id
     and message_row.root_message_id is null;
  if target_space is null then return; end if;
  if not internal.is_space_member(target_space) then
    raise exception 'not permitted to revoke this thread runtime' using errcode = '42501';
  end if;

  update public.auth_sessions
     set revoked_at = now()
   where runtime_thread_root_id = p_thread_root_id
     and kind = 'agent_runtime'
     and revoked_at is null;
end
$$;

revoke all on function public.resolve_auth_session(text) from public;
revoke all on function public.issue_agent_runtime_session(uuid, uuid, text, timestamptz, text) from public;
revoke all on function public.revoke_agent_runtime_session(uuid) from public;
grant execute on function public.resolve_auth_session(text) to tm8_app;
grant execute on function public.issue_agent_runtime_session(uuid, uuid, text, timestamptz, text) to tm8_app;
grant execute on function public.revoke_agent_runtime_session(uuid) to tm8_app;

reset role;
