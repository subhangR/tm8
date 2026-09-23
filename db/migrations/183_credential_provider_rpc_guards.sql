-- =============================================================================
-- 125 — CREDENTIAL PROVIDER RPC GUARDS FOLLOW THE ADMITTED PROVIDER SET.
--
-- WHAT WAS BROKEN. Migrations 123 and 124 widened the two provider CHECKs for
-- Gemini, Hermes and Cursor, but the SECURITY DEFINER RPCs that write those
-- tables still carried 083's original inline provider lists. Those guards run
-- before either INSERT reaches its widened CHECK, so a valid new provider was
-- refused with 22023 even though the table admitted it. The UI could render a
-- Connect tile whose first database call was guaranteed to fail.
--
-- ONE SQL AUTHORITY. `internal.is_credential_provider` is the complete SESSION
-- set: every provider for which a login terminal may be opened. A seventh
-- provider is added there, once, rather than by finding every RPC body that
-- happened to copy the old list.
--
-- WHY THERE ARE TWO PREDICATES. The tables deliberately encode two storage
-- shapes. Five providers are FILE-shaped and may be indexed in
-- `account_agent_credentials`; GitHub is string-shaped and remains in
-- `account_git_credentials`. The file predicate derives from the session
-- predicate and excludes that one explicit exception, so it neither restates
-- the five-provider list nor creates a second provider authority.
--
-- WHY REPLACE BOTH RPCs WHOLE. PostgreSQL cannot patch one plpgsql statement.
-- Each definition below is 083's body verbatim, comments included, with only
-- its provider guard changed to call the appropriate predicate. Migration 083
-- itself stays immutable, and `create or replace` preserves the signatures,
-- ownership, grants and every behaviour outside provider admission.
-- =============================================================================

set role tm8_graph_owner;

-- Every provider for which a credential login terminal may be opened.
create or replace function internal.is_credential_provider(p_provider text)
returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    p_provider = any (array[
      'anthropic',
      'openai',
      'github',
      'gemini',
      'hermes',
      'cursor'
    ]::text[]),
    false
  )
$$;

-- Every FILE-shaped provider whose metadata belongs in
-- `account_agent_credentials`. GitHub is deliberately string-shaped.
create or replace function internal.is_file_credential_provider(p_provider text)
returns boolean
language sql immutable parallel safe as $$
  select internal.is_credential_provider(p_provider)
     and coalesce(p_provider <> 'github', false)
$$;

-- Neither helper is an application RPC. The SECURITY DEFINER functions below
-- run as their owner and need no tm8_app grant to call them.
revoke all on function internal.is_credential_provider(text) from public;
revoke all on function internal.is_file_credential_provider(text) from public;

-- Open a login terminal.
--
-- `node_id` is NOT written and must never be — see D5 in the header. The row
-- gets `share_mode = 'none'` because the terminal streams a device code and the
-- member's own keystrokes, and nobody else in the space has any business
-- watching that.
create or replace function public.start_credential_session(
  p_space_id uuid,
  p_provider text,
  p_ttl_seconds integer default 900,
  p_session_cap integer default 2
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  v_actor uuid;
  v_ttl integer;
  v_session_id uuid;
  v_expires_at timestamptz;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);

  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if not internal.is_credential_provider(p_provider) then
    raise exception 'unsupported credential provider' using errcode = '22023';
  end if;

  -- Clamp rather than reject: a login that is allowed to sit open for an hour
  -- is a terminal nobody is watching, and the floor keeps a caller from
  -- creating a session that has already expired.
  v_ttl := least(greatest(coalesce(p_ttl_seconds, 900), 60), 1800);

  -- The MIRROR cap. Disjoint from the agent cap on purpose: see section 3.
  if internal.credential_session_count(null) >= greatest(coalesce(p_session_cap, 2), 1) then
    raise exception 'credential session concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_session_cap,
                                  'live', internal.credential_session_count(null))::text;
  end if;

  -- The actor is the caller's own membership in this space, never
  -- `internal.resolve_actor`: resolve_actor exists so a caller can act AS a
  -- teammate, and a credential session is the one thing that must never be
  -- opened on someone else's behalf. `require_space_member` above guarantees
  -- this is non-null.
  v_actor := internal.current_member_id(p_space_id);

  v_expires_at := now() + make_interval(secs => v_ttl);

  v_session_id := internal.create_envelope(p_space_id, 'work_session', v_actor, null, null);
  insert into public.work_sessions(entity_id, title, status, share_mode, session_kind)
  values (v_session_id, 'Connect ' || p_provider, 'spawning', 'none', 'credential');

  -- Same transaction as the work_sessions insert, and tm8_app has no insert
  -- grant on either table, so there is no path that produces one without the
  -- other.
  insert into public.credential_sessions(work_session_id, account_id, provider, expires_at)
  values (v_session_id, v_account_id, p_provider, v_expires_at);

  return jsonb_build_object(
    'workSessionId', v_session_id,
    'spaceId', p_space_id,
    'provider', p_provider,
    'expiresAt', v_expires_at
  );
end
$$;

-- Upsert the metadata row after a login succeeds. The secret is already on
-- disk by the time this is called; this only records that it is there.
create or replace function public.set_account_agent_credential(
  p_provider text,
  p_login text,
  p_auth_method text,
  p_status text default 'active'
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  stored public.account_agent_credentials;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if not internal.is_file_credential_provider(p_provider) then
    raise exception 'unsupported agent credential provider' using errcode = '22023';
  end if;
  if coalesce(p_status, 'active') not in ('active', 'stale', 'revoked') then
    raise exception 'unsupported credential status' using errcode = '22023';
  end if;

  insert into public.account_agent_credentials(
    account_id, provider, login, auth_method, status, last_verified_at
  ) values (
    v_account_id, p_provider, nullif(btrim(p_login), ''), nullif(btrim(p_auth_method), ''),
    coalesce(p_status, 'active'), now()
  )
  on conflict (account_id, provider) do update
     set login            = excluded.login,
         auth_method      = excluded.auth_method,
         status           = excluded.status,
         last_verified_at = excluded.last_verified_at
  returning * into stored;

  return jsonb_build_object(
    'connected', stored.status = 'active',
    'provider', stored.provider,
    'login', stored.login,
    'authMethod', stored.auth_method,
    'status', stored.status,
    'connectedAt', stored.connected_at,
    'lastVerifiedAt', stored.last_verified_at
  );
end
$$;

reset role;
