-- =============================================================================
-- 226 — an auth session records the space it is pinned to (plan 01a0d9eb W0a).
--
-- WHAT THIS CHANGES
--   1. `auth_sessions.space_id uuid null references spaces(id)`.
--   2. Backfill: every `agent` / `agent_runtime` row gets the space of the
--      thing it was minted for — its work session, else its chat, else its
--      pre-176 thread root, else its persona. Every source is an entity with a
--      non-null `space_id`, and each is the value the issuing RPC resolved and
--      checked `can_act_as` against at mint time. Only rows with
--      `space_id is null` are touched, so a second run updates zero rows.
--   3. `check (kind not in ('agent','agent_runtime','link') or space_id is not
--      null)`. `link` is not a legal kind yet (W6 adds it); it is named here so
--      that W6 inherits the rule instead of having to remember it.
--   4. The three issuers — `issue_agent_auth_session` (074),
--      `issue_work_session_agent_session` (072) and
--      `issue_agent_runtime_session` (176) — store the space they ALREADY
--      resolve (`target_space` / `session_space`). Bodies are otherwise the
--      latest shipped text, unchanged.
--   5. `resolve_auth_session` returns `spaceId` (176 body + one key).
--
-- WHAT THIS DOES NOT DO: bind anything. The column is data. Whether the server
-- turns it into the `tm8.session_space_id` claim is `TM8_SPACE_SESSIONS`
-- (default `agents`); what the claim narrows is 227.
--
-- Human kinds (`browser`, `cli`) keep `space_id = null` — a "gate session"
-- (plan A9). W3 pins them.
--
-- A ROW NO SOURCE CAN PLACE is deleted, not guessed. It would be an agent
-- credential bound to no work session, no chat and no persona: nothing
-- attributes it to a space, and a live one is exactly the unscoped agent
-- token this migration exists to end. Nothing references `auth_sessions`
-- (no inbound FK), and the count is reported by NOTICE.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

alter table public.auth_sessions
  add column if not exists space_id uuid references public.spaces(id) on delete cascade;

comment on column public.auth_sessions.space_id is
  'The one space this session may act in (226). Required for agent, '
  'agent_runtime and link sessions; null for a human gate session. Bound as '
  'tm8.session_space_id when TM8_SPACE_SESSIONS pins the kind (227).';

-- -----------------------------------------------------------------------------
-- Backfill. Idempotent: every statement is restricted to `space_id is null`.
-- -----------------------------------------------------------------------------
update public.auth_sessions s
   set space_id = e.space_id
  from public.entities e
 where s.space_id is null
   and s.kind in ('agent', 'agent_runtime')
   and e.id = s.work_session_id;

update public.auth_sessions s
   set space_id = e.space_id
  from public.entities e
 where s.space_id is null
   and s.kind in ('agent', 'agent_runtime')
   and e.id = s.runtime_chat_id;

update public.auth_sessions s
   set space_id = e.space_id
  from public.entities e
 where s.space_id is null
   and s.kind in ('agent', 'agent_runtime')
   and e.id = s.runtime_thread_root_id;

update public.auth_sessions s
   set space_id = e.space_id
  from public.entities e
 where s.space_id is null
   and s.kind in ('agent', 'agent_runtime')
   and e.id = s.acting_as_team_member_id;

do $unplaceable$
declare dropped integer;
begin
  delete from public.auth_sessions
   where space_id is null
     and kind in ('agent', 'agent_runtime');
  get diagnostics dropped = row_count;
  if dropped > 0 then
    raise notice '226: deleted % agent session row(s) with no work session, chat or persona to place them', dropped;
  end if;
end
$unplaceable$;

alter table public.auth_sessions
  drop constraint if exists auth_sessions_pinned_kinds_have_space;
alter table public.auth_sessions
  add constraint auth_sessions_pinned_kinds_have_space
  check (kind not in ('agent', 'agent_runtime', 'link') or space_id is not null);

-- -----------------------------------------------------------------------------
-- resolve_auth_session: 176's body plus `spaceId`.
-- -----------------------------------------------------------------------------
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
    'runtimeChatId', s.runtime_chat_id,
    'spaceId', s.space_id,
    'expiresAt', s.expires_at, 'label', s.label)
    from public.auth_sessions s
    join public.accounts a on a.id = s.account_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and a.status = 'active'
$$;

-- -----------------------------------------------------------------------------
-- 074's issuer; the insert now stores `target_space`.
-- -----------------------------------------------------------------------------
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
    token_hash, label, expires_at, space_id
  ) values (
    account.id, 'agent', p_team_member_id, p_work_session_id,
    p_token_hash, p_label, p_expires_at, target_space
  ) returning * into issued;

  return to_jsonb(issued) - 'token_hash';
end
$$;

-- -----------------------------------------------------------------------------
-- 176's issuer; the insert now stores `target_space`.
-- -----------------------------------------------------------------------------
create or replace function public.issue_agent_runtime_session(
  p_chat_id uuid,
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
  perform internal.require_human_auth_kind();

  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid agent runtime token hash' using errcode = '22023';
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '24 hours' then
    raise exception 'agent runtime expiry must be within the next 24 hours' using errcode = '22023';
  end if;

  -- Locking the chat serializes two concurrent turn starts before the old live
  -- token is revoked.
  select e.space_id into target_space
    from public.chats c
    join public.entities e on e.id = c.entity_id
   where c.entity_id = p_chat_id and e.deleted_at is null
   for update of c;
  if target_space is null then
    raise exception 'chat not found' using errcode = 'P0002';
  end if;

  requester_member := internal.current_member_id(target_space);
  if requester_member is null then
    raise exception 'requesting identity is not a member of this chat space' using errcode = '42501';
  end if;
  if not internal.can_act_as(p_team_member_id, target_space) then
    raise exception 'requesting member cannot use this teammate in the chat space' using errcode = '42501';
  end if;

  select * into account
    from public.accounts account_row
   where account_row.identity_id = identity and account_row.status = 'active';
  if account.id is null then
    raise exception 'account not found or disabled' using errcode = 'P0002';
  end if;

  update public.auth_sessions
     set revoked_at = now()
   where runtime_chat_id = p_chat_id
     and kind = 'agent_runtime'
     and revoked_at is null;

  insert into public.auth_sessions(
    account_id, kind, acting_as_team_member_id,
    runtime_member_id, runtime_chat_id,
    token_hash, label, expires_at, space_id
  ) values (
    account.id, 'agent_runtime', p_team_member_id,
    requester_member, p_chat_id,
    p_token_hash, p_label, p_expires_at, target_space
  ) returning * into issued;

  return to_jsonb(issued) - 'token_hash';
end
$$;

revoke all on function public.resolve_auth_session(text) from public;
grant execute on function public.resolve_auth_session(text) to tm8_app;
revoke all on function public.issue_agent_auth_session(uuid, uuid, text, timestamptz, text) from public;
grant execute on function public.issue_agent_auth_session(uuid, uuid, text, timestamptz, text) to tm8_app;
revoke all on function public.issue_agent_runtime_session(uuid, uuid, text, timestamptz, text) from public;
grant execute on function public.issue_agent_runtime_session(uuid, uuid, text, timestamptz, text) to tm8_app;


reset role;

-- -----------------------------------------------------------------------------
-- 072's issuer; the insert now stores `session_space`. 072 created it as the
-- migrating role, not tm8_graph_owner, so it is replaced after `reset role` to
-- keep that owner (tm8_graph_owner cannot replace a function it does not own).
-- -----------------------------------------------------------------------------
create or replace function public.issue_work_session_agent_session(
  p_work_session_id uuid,
  p_team_member_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  account_row public.accounts;
  session_row public.auth_sessions;
  session_space uuid;
begin
  perform internal.require_identity();
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at <= now() then
    raise exception 'invalid work-session credential' using errcode = '22023';
  end if;

  select a.* into account_row
    from public.accounts a
   where a.identity_id = internal.identity_id() and a.status = 'active'
   order by a.is_owner desc, a.created_at
   limit 1;
  if account_row.id is null then
    raise exception 'active account not found' using errcode = 'P0002';
  end if;

  select e.space_id into session_space
    from public.entities e
    join public.work_sessions ws on ws.entity_id = e.id
    join public.edges relation on relation.src_id = e.id
      and relation.dst_id = p_team_member_id and relation.type = 'relates_to'
   where e.id = p_work_session_id
     and e.deleted_at is null
     and ws.status in ('spawning','running','idle')
   for update of ws;
  if session_space is null then
    raise exception 'live work session/persona relationship not found' using errcode = 'P0002';
  end if;
  if not internal.can_act_as(p_team_member_id, session_space) then
    raise exception 'cannot issue a credential for this session persona' using errcode = '42501';
  end if;

  update public.auth_sessions
     set revoked_at = now()
   where work_session_id = p_work_session_id and revoked_at is null;

  insert into public.auth_sessions(
    account_id, kind, acting_as_team_member_id, work_session_id,
    token_hash, label, expires_at, space_id
  ) values (
    account_row.id, 'agent', p_team_member_id, p_work_session_id,
    p_token_hash, p_label, p_expires_at, session_space
  ) returning * into session_row;

  return to_jsonb(session_row) - 'token_hash';
end
$$;

revoke all on function public.issue_work_session_agent_session(uuid, uuid, text, timestamptz, text) from public;
grant execute on function public.issue_work_session_agent_session(uuid, uuid, text, timestamptz, text) to tm8_app;

do $verify$
begin
  if exists (
    select 1 from public.auth_sessions
     where kind in ('agent', 'agent_runtime') and space_id is null
  ) then
    raise exception 'VERIFY 226: an agent session was left without a space';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.auth_sessions'::regclass
       and conname = 'auth_sessions_pinned_kinds_have_space'
       and convalidated
  ) then
    raise exception 'VERIFY 226: the pinned-kind check is missing or not validated';
  end if;
end
$verify$;
