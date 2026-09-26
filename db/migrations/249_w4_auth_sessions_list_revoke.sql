-- =============================================================================
-- 249 (W4, ordinal allocated by the merge coordinator; sorts after 248) — list and revoke auth sessions
-- (plan 01a0d9eb W4).
--
-- A human sees every live session of their own account, and a space admin sees
-- every live session PINNED to that space, whoever owns it. Either may revoke
-- what they can see. This is the control the owner chose instead of target
-- consent (K5 rejected, decision 33): a space learns about sessions pinned to
-- it here, and ends them here.
--
--   1. `auth_sessions.parent_session_id` — the gate session `enter_space` (233)
--      minted a pinned session from. Null for every other row: gate sessions,
--      agent kinds, and a pinned session the loopback auto-owner entered (it
--      has no session row to point at).
--   2. `enter_space` records that parent. 248's body (233's plus 232's
--      `m.status = 'active'`) plus the one column.
--   3. Revoking a session revokes its live children, in the same statement
--      (coordinator ruling, W4). A trigger rather than a line in each revoker,
--      so logout (`revoke_auth_session`), W1's membership end and account
--      disable all cascade without being edited. The expiry cap 233 put on a
--      child still holds; this ends the child early instead of at that cap.
--   4. `public.list_auth_sessions(p_space_id)` — null: the caller's own
--      sessions; a space: that space's pinned sessions, space admin only.
--   5. `public.revoke_listed_auth_session(p_session_id)` — revoke one row the
--      caller could list, and return every id this call revoked (the row plus
--      its cascaded children), so the server can close exactly their sockets.
--
-- HUMANS ONLY. Both functions call `internal.require_human_auth_kind()`: an
-- agent token neither lists nor ends sessions. A row the caller may not see is
-- `P0002 session not found`, the same answer as a missing id, so revoke is not
-- an oracle for other people's session ids.
--
-- NEVER A TOKEN. Neither function reads or returns `token_hash`.
--
-- ORIGIN is derived, not stored: `spawn` (agent, minted for a work session),
-- `chat` (agent_runtime), `space_enter` (a pinned human session), `login` (a
-- human gate session). W6 adds `link`; its label (`stored in <space>`) lands
-- with it.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The parent link.
-- -----------------------------------------------------------------------------
alter table public.auth_sessions
  add column if not exists parent_session_id uuid
    references public.auth_sessions(id) on delete cascade;

create index if not exists auth_sessions_parent_live_idx
  on public.auth_sessions(parent_session_id)
  where parent_session_id is not null and revoked_at is null;

create index if not exists auth_sessions_space_live_idx
  on public.auth_sessions(space_id)
  where space_id is not null and revoked_at is null;

comment on column public.auth_sessions.parent_session_id is
  'The gate session enter_space (233) minted this pinned session from (249). '
  'Revoking the parent revokes this row in the same statement.';

-- -----------------------------------------------------------------------------
-- 2. enter_space records the parent. 233's body; the insert gains one column.
-- -----------------------------------------------------------------------------
create or replace function public.enter_space(
  p_space_id uuid,
  p_parent_session_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  caller text;
  acct public.accounts;
  parent public.auth_sessions;
  new_kind text := 'browser';
  new_expiry timestamptz := p_expires_at;
  s public.auth_sessions;
begin
  caller := internal.require_identity();
  if nullif(current_setting('tm8.session_space_id', true), '') is not null then
    raise exception 'a space-pinned session cannot enter a space; use the gate session'
      using errcode = '42501';
  end if;
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli') then
    raise exception 'only a human session can enter a space' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'invalid space session credential' using errcode = '22023';
  end if;

  select a.* into acct
    from public.accounts a
   where a.identity_id = caller and a.status = 'active'
   order by a.is_owner desc, a.created_at
   limit 1;
  if acct.id is null then
    raise exception 'account not found or disabled' using errcode = 'P0002';
  end if;

  if p_parent_session_id is not null then
    select s0.* into parent
      from public.auth_sessions s0
     where s0.id = p_parent_session_id
       and s0.revoked_at is null
       and s0.expires_at > now()
       and s0.space_id is null
       and s0.kind in ('browser', 'cli');
    if parent.id is null then
      raise exception 'gate session not found' using errcode = '42501';
    end if;
    select a.* into acct from public.accounts a
     where a.id = parent.account_id and a.identity_id = caller and a.status = 'active';
    if acct.id is null then
      raise exception 'gate session not found' using errcode = '42501';
    end if;
    new_kind := parent.kind;
    new_expiry := least(p_expires_at, parent.expires_at);
  end if;

  -- Membership of the target, read directly (the caller is unpinned, so this
  -- is exactly `is_space_member`). Not-a-member and no-such-space answer the
  -- same so the call is not a space-existence oracle.
  if not exists (
    select 1 from public.members m
     where m.space_id = p_space_id and m.identity_id = caller
       and m.status = 'active'
  ) then
    raise exception 'not a member of that space' using errcode = '42501';
  end if;

  insert into public.auth_sessions(account_id, kind, token_hash, label, expires_at, space_id, parent_session_id)
  values (acct.id, new_kind, p_token_hash, p_label, new_expiry, p_space_id, parent.id)
  returning * into s;
  return to_jsonb(s) - 'token_hash';
end
$$;

revoke all on function public.enter_space(uuid, uuid, text, timestamptz, text) from public;
grant execute on function public.enter_space(uuid, uuid, text, timestamptz, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. Revoking a parent revokes its live children.
-- -----------------------------------------------------------------------------
create or replace function internal.cascade_auth_session_revoke()
returns trigger language plpgsql security definer
set search_path = public, internal, pg_temp as $$
begin
  update public.auth_sessions
     set revoked_at = new.revoked_at
   where parent_session_id = new.id
     and revoked_at is null;
  return null;
end
$$;

revoke all on function internal.cascade_auth_session_revoke() from public;

drop trigger if exists auth_sessions_cascade_revoke on public.auth_sessions;
create trigger auth_sessions_cascade_revoke
  after update of revoked_at on public.auth_sessions
  for each row
  when (old.revoked_at is null and new.revoked_at is not null)
  execute function internal.cascade_auth_session_revoke();

-- -----------------------------------------------------------------------------
-- 4. list_auth_sessions.
-- -----------------------------------------------------------------------------
create or replace function internal.auth_session_view(s public.auth_sessions)
returns jsonb language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'sessionId', s.id,
    'kind', s.kind,
    'createdAt', s.created_at,
    'lastUsedAt', s.last_used_at,
    'expiresAt', s.expires_at,
    'label', s.label,
    'spaceId', s.space_id,
    'spaceName', (select sp.name from public.spaces sp where sp.id = s.space_id),
    'parentSessionId', s.parent_session_id,
    'origin', case
      when s.kind = 'agent' then 'spawn'
      when s.kind = 'agent_runtime' then 'chat'
      when s.kind = 'link' then 'link'
      when s.space_id is not null then 'space_enter'
      else 'login'
    end,
    'originEntityId', case
      when s.kind = 'agent' then s.work_session_id
      when s.kind = 'agent_runtime' then coalesce(s.runtime_chat_id, s.runtime_thread_root_id)
      else null
    end,
    'owner', jsonb_build_object(
      'identityId', a.identity_id,
      'displayName', coalesce(
        (select m.display_name from public.members m
          where m.space_id = s.space_id and m.identity_id = a.identity_id limit 1),
        (select p.display_name from public.user_profiles p where p.identity_id = a.identity_id),
        a.username)
    )
  )
  from public.accounts a
  where a.id = s.account_id
$$;

revoke all on function internal.auth_session_view(public.auth_sessions) from public;

create or replace function public.list_auth_sessions(p_space_id uuid default null)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  caller text;
  rows jsonb;
begin
  caller := internal.require_identity();
  perform internal.require_human_auth_kind();

  if p_space_id is null then
    select coalesce(jsonb_agg(internal.auth_session_view(s) order by s.created_at desc), '[]'::jsonb)
      into rows
      from public.auth_sessions s
      join public.accounts a on a.id = s.account_id
     where a.identity_id = caller
       -- W4-P1: under a pin the own list is that space's sessions only; the
       -- account's gate sessions and its sessions in other spaces stay unseen.
       and (internal.session_space_id() is null or s.space_id = internal.session_space_id())
       and s.revoked_at is null
       and s.expires_at > now();
    return rows;
  end if;

  -- 227's helper honours the pin: an admin pinned to another space is refused.
  if not internal.is_space_admin(p_space_id) then
    raise exception 'space admin required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(internal.auth_session_view(s) order by s.created_at desc), '[]'::jsonb)
    into rows
    from public.auth_sessions s
   where s.space_id = p_space_id
     and s.revoked_at is null
     and s.expires_at > now();
  return rows;
end
$$;

revoke all on function public.list_auth_sessions(uuid) from public;
grant execute on function public.list_auth_sessions(uuid) to tm8_app;

comment on function public.list_auth_sessions(uuid) is
  'auth.sessions.list (249, plan W4). Null: the caller''s own live sessions '
  '(under a pin: only those pinned to that space). '
  'A space: its live pinned sessions, space admin only (pin-aware). Humans only.';

-- -----------------------------------------------------------------------------
-- 5. revoke_listed_auth_session.
-- -----------------------------------------------------------------------------
create or replace function public.revoke_listed_auth_session(p_session_id uuid)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  caller text;
  target public.auth_sessions;
  owner_identity text;
  was_live boolean;
  stamp timestamptz := now();
  ended uuid[];
begin
  caller := internal.require_identity();
  perform internal.require_human_auth_kind();

  select s.* into target from public.auth_sessions s where s.id = p_session_id for update;
  if target.id is not null then
    select a.identity_id into owner_identity from public.accounts a where a.id = target.account_id;
  end if;
  -- Own, or pinned to a space the caller administers (pin-aware), or a node
  -- admin on a gate session (233 K6). Anything else reads as missing.
  -- W4-P1: a pinned caller reaches only sessions pinned to its own space.
  if target.id is null
     or (internal.session_space_id() is not null
         and target.space_id is distinct from internal.session_space_id())
     or not (owner_identity = caller
             or (target.space_id is not null and internal.is_space_admin(target.space_id))
             or internal.is_node_admin()) then
    raise exception 'session not found' using errcode = 'P0002';
  end if;

  was_live := target.revoked_at is null;
  if was_live then
    update public.auth_sessions set revoked_at = stamp where id = target.id;
  end if;
  -- The row plus whatever the trigger just cascaded, stamped by this call.
  select coalesce(array_agg(s.id), '{}') into ended
    from public.auth_sessions s
   where (s.id = target.id or s.parent_session_id = target.id)
     and s.revoked_at = stamp;

  return jsonb_build_object(
    'sessionId', target.id,
    'revoked', was_live,
    'revokedSessionIds', to_jsonb(ended)
  );
end
$$;

revoke all on function public.revoke_listed_auth_session(uuid) from public;
grant execute on function public.revoke_listed_auth_session(uuid) to tm8_app;

comment on function public.revoke_listed_auth_session(uuid) is
  'auth.sessions.revoke (249, plan W4). Own session, a session pinned to a '
  'space the caller administers, or (gate only) node admin; a pinned caller '
  'only within its own space. Cascades to '
  'children; returns every id it revoked. Humans only.';

-- VERIFY: enter_space is 248's body plus the widening. A fresh DB applies
-- 249 after 248, so the last enter_space must record the parent AND keep
-- 232's tombstone (248's VERIFY); either missing means an ordering clash.
do $verify$
declare
  -- prosrc, not pg_get_functiondef: the signature (and 248's body) already
  -- name p_parent_session_id, so match the insert's column list itself.
  e text := (select prosrc from pg_proc where oid = 'public.enter_space(uuid, uuid, text, timestamptz, text)'::regprocedure);
begin
  if e not like '%space_id, parent_session_id)%' then
    raise exception 'VERIFY 249: enter_space does not record parent_session_id';
  end if;
  if e not like '%m.status = ''active''%' then
    raise exception 'VERIFY 249: enter_space admits an ended membership';
  end if;
end
$verify$;

reset role;
