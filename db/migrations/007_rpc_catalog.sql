-- =============================================================================
-- 007 RPC catalog — the write surface (01 §6 + the tm8 additions) and the
--                   compound reads (entity_tree, leaderboard, ready_to_work).
--
-- Posture (D8): tm8_app holds SELECT and EXECUTE only. Every write in the system
-- is one of these SECURITY DEFINER functions. Because a definer function
-- BYPASSES RLS, each one re-asserts membership and actor authorization itself —
-- those guards are not belt-and-braces, they are the belt.
--
-- Uniform command protocol, in this order, no exceptions:
--   1. internal.ledger_replay(cmid, operation)  → replay wins, nothing re-runs
--   2. internal.require_space_member(space)     → membership
--   3. internal.resolve_actor(actor, space)     → can_act_as, T-L7
--   4. do the work (detail tables only for content — triggers own version/activity)
--   5. internal.ledger_record(cmid, operation, result)
--
-- `operation` is the frozen catalog name (packages/contract/src/catalog.ts), so
-- the ledger doubles as a contract-level audit trail (DEV-9 / S10).
--
-- Reads that need SQL (recursive subtrees, ranked ledgers) are SECURITY INVOKER
-- and views are declared `security_invoker = true` — a definer read would
-- silently hand tm8_app every space in the database.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Result assembly helpers.
--
-- The DB returns ROWS (envelope + typed content + counters), never rendered
-- DTOs: derived truth — badges, capabilities, titles, autoTabs — is assembled in
-- exactly one place and that place is the server (L3).
-- -----------------------------------------------------------------------------
create or replace function internal.command_entity(target uuid) returns jsonb
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select to_jsonb(e)
       || jsonb_build_object(
            'content', coalesce(internal.entity_content(target), '{}'::jsonb),
            'counters', coalesce(to_jsonb(c) - 'entity_id', '{}'::jsonb))
    from public.entities e
    left join public.entity_counters c on c.entity_id = e.id
   where e.id = target
$$;

create or replace function internal.command_edge(target uuid) returns jsonb
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select to_jsonb(e) from public.edges e where e.id = target
$$;

create or replace function internal.command_result(
  p_entity uuid default null, p_edge uuid default null, p_activity uuid default null,
  p_patches uuid[] default '{}'::uuid[], p_undo jsonb default null
) returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'entity',   case when p_entity is null then null else internal.command_entity(p_entity) end,
    'edge',     case when p_edge is null then null else internal.command_edge(p_edge) end,
    'activity', p_activity,
    'undo',     p_undo
  )) || jsonb_build_object(
    'patches', coalesce((
      select jsonb_agg(internal.command_entity(pid))
        from unnest(p_patches) as pid
       where pid is not null
    ), '[]'::jsonb)
  )
$$;

-- Optimistic concurrency, one place. 40001 → version_conflict (409), and the
-- current version travels in DETAIL so the facade can attach `current`.
create or replace function internal.assert_version(target uuid, expected integer) returns void
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare current_version integer;
begin
  select version into current_version from public.entities where id = target;
  if current_version is null then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;
  if expected is not null and current_version <> expected then
    raise exception 'version conflict on %', target
      using errcode = '40001',
            detail = jsonb_build_object('entityId', target, 'currentVersion', current_version)::text;
  end if;
end
$$;

-- Fetch a live entity of an expected kind, or raise not_found. Tombstoned rows
-- are not found by default: only the tombstone-aware read paths see them.
create or replace function internal.live_entity(target uuid, expected_kind text default null)
returns public.entities language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare e public.entities;
begin
  select * into e from public.entities where id = target and deleted_at is null;
  if e.id is null then
    raise exception 'entity % not found', target using errcode = 'P0002';
  end if;
  if expected_kind is not null and e.kind <> expected_kind then
    raise exception 'entity % is a %, expected %', target, e.kind, expected_kind using errcode = '22023';
  end if;
  return e;
end
$$;

-- -----------------------------------------------------------------------------
-- 2. Identity RPCs (consumed by the identity block).
--
-- resolve_auth_session is the ONE claim-free read in the schema, and it has to
-- be: a caller presenting a bearer token has no identity yet. It takes a token
-- HASH (never a token), returns only what the server needs to build claims, and
-- is the single bootstrap hole in the claim model.
-- -----------------------------------------------------------------------------
create or replace function public.resolve_auth_session(p_token_hash text)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'sessionId', s.id, 'accountId', a.id, 'identityId', a.identity_id,
    'username', a.username, 'displayName', a.display_name,
    'isNodeAdmin', a.is_node_admin, 'isOwner', a.is_owner,
    'kind', s.kind, 'actingAsTeamMemberId', s.acting_as_team_member_id,
    'expiresAt', s.expires_at, 'label', s.label)
    from public.auth_sessions s
    join public.accounts a on a.id = s.account_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and a.status = 'active'
$$;

-- The auth-only twin of resolve_auth_session: password login has no identity to
-- bind yet, so this read is claim-free BY DESIGN. It is deliberately the second
-- and last such hole in the schema. It returns the verifier, never a decision —
-- constant-time comparison (and the dummy-hash path that makes a missing login
-- cost the same as a wrong password) belongs in the identity block.
create or replace function public.resolve_account_credential(p_login text)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'accountId', a.id, 'identityId', a.identity_id, 'username', a.username,
    'passwordHash', a.password_hash, 'passwordAlgorithm', a.password_algorithm,
    'isNodeAdmin', a.is_node_admin, 'isOwner', a.is_owner,
    'status', a.status, 'disabledAt', a.disabled_at)
    from public.accounts a
   where lower(a.username) = lower(btrim(p_login))
$$;

comment on function public.resolve_account_credential(text) is
  'Claim-free by design (auth bootstrap): a caller presenting a password has no '
  'identity yet. Returns the stored verifier for server-side comparison — never '
  'an authentication verdict.';

-- First-run owner bootstrap (T-L7 degenerate case: one row, same code path).
-- Idempotent by construction — the single-owner index makes a second owner
-- impossible, so a repeated bootstrap returns the existing one.
create or replace function public.ensure_account(
  p_identity_id text, p_username text, p_display_name text default null,
  p_email text default null, p_is_owner boolean default false,
  p_is_node_admin boolean default false,
  p_password_algorithm text default null, p_password_hash text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare a public.accounts;
begin
  -- F1 (Lyra's security review): this function is reachable by anything holding
  -- a tm8_app connection and must be callable with NO claim bound — that is the
  -- first-run case. So it is claim-free ONLY while the node has zero accounts;
  -- from the second account onward it is node-admin-only. Without this, an
  -- unauthenticated caller could mint itself an account.
  if exists (select 1 from public.accounts) then
    if internal.identity_id() is null then
      raise exception 'account creation requires an authenticated node admin'
        using errcode = '28000';
    end if;
    perform internal.require_node_admin();
  end if;

  select * into a from public.accounts
   where identity_id = p_identity_id or lower(username) = lower(btrim(p_username));
  if a.id is not null then
    return to_jsonb(a) - 'password_hash';
  end if;
  if p_is_owner then
    select * into a from public.accounts where is_owner;
    if a.id is not null then
      raise exception 'this node already has an owner account'
        using errcode = '23505', detail = jsonb_build_object('identityId', a.identity_id)::text;
    end if;
  end if;

  insert into public.user_profiles(identity_id, display_name, email)
  values (p_identity_id, p_display_name, p_email)
  on conflict (identity_id) do update
    set display_name = coalesce(excluded.display_name, user_profiles.display_name),
        email = coalesce(excluded.email, user_profiles.email);

  insert into public.accounts(identity_id, username, display_name, email, is_owner, is_node_admin,
                              password_algorithm, password_hash)
  values (p_identity_id, p_username, p_display_name, p_email, p_is_owner,
          p_is_node_admin or p_is_owner, p_password_algorithm, p_password_hash)
  returning * into a;
  return to_jsonb(a) - 'password_hash';
end
$$;

-- R6 recovery. Either you are changing your own credential, or you administer
-- the node — there is no third case.
create or replace function public.set_account_credential(
  p_account_id uuid, p_hash text, p_algo text
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare owner_identity text;
begin
  perform internal.require_identity();
  select identity_id into owner_identity from public.accounts where id = p_account_id;
  if owner_identity is null then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if owner_identity is distinct from internal.identity_id() then
    perform internal.require_node_admin();
  end if;
  update public.accounts set password_hash = p_hash, password_algorithm = p_algo
   where id = p_account_id;
end
$$;

-- R6 revocation. Flips the account only: the member entity and everything it
-- authored stay exactly where they are. Disabling a person does not un-write
-- their history.
create or replace function public.set_account_disabled(p_account_id uuid, p_disabled boolean)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare a public.accounts;
begin
  perform internal.require_node_admin();
  update public.accounts
     set status = case when p_disabled then 'disabled' else 'active' end,
         disabled_at = case when p_disabled then now() else null end
   where id = p_account_id
  returning * into a;
  if a.id is null then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  -- A revocation that leaves valid bearer tokens behind is not a revocation.
  if p_disabled then
    perform public.revoke_account_sessions(p_account_id);
  end if;
  return to_jsonb(a) - 'password_hash';
end
$$;

create or replace function public.revoke_account_sessions(p_account_id uuid)
returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  revoked integer;
  owner_identity text;
begin
  perform internal.require_identity();
  select identity_id into owner_identity from public.accounts where id = p_account_id;
  if owner_identity is null then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if owner_identity is distinct from internal.identity_id() then
    perform internal.require_node_admin();
  end if;
  update public.auth_sessions set revoked_at = now()
   where account_id = p_account_id and revoked_at is null;
  get diagnostics revoked = row_count;
  return revoked;
end
$$;

-- Claim-READING (the caller has already bound tm8.identity_id from
-- resolve_auth_session): the identity's whole actor scope across every space in
-- one round trip, so claim assembly needs no third claim-free hole.
create or replace function public.current_actor_scope()
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  identity text := internal.require_identity();
begin
  return jsonb_build_object(
    'identityId', identity,
    'memberIds', coalesce((
      select jsonb_agg(jsonb_build_object('memberId', m.entity_id, 'spaceId', m.space_id, 'role', m.role)
             order by m.joined_at)
        from public.members m where m.identity_id = identity), '[]'::jsonb),
    'teamMembers', coalesce((
      select jsonb_agg(jsonb_build_object('id', tm.entity_id, 'spaceId', owner.space_id,
                                          'ownerMemberId', tm.owner_member_id, 'name', tm.name)
             order by tm.name)
        from public.team_members tm
        join public.members owner on owner.entity_id = tm.owner_member_id
       where owner.identity_id = identity), '[]'::jsonb));
end
$$;

create or replace function public.issue_auth_session(
  p_account_id uuid, p_token_hash text, p_kind text, p_expires_at timestamptz,
  p_acting_as_team_member_id uuid default null, p_label text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  s public.auth_sessions;
  a public.accounts;
begin
  select * into a from public.accounts where id = p_account_id and status = 'active';
  if a.id is null then
    raise exception 'account not found or disabled' using errcode = 'P0002';
  end if;
  -- Minting a token for somebody else is node administration. Minting your own
  -- (login, a CLI token, an agent session for your own persona) is not.
  if internal.identity_id() is distinct from a.identity_id then
    perform internal.require_node_admin();
  end if;
  insert into public.auth_sessions(account_id, kind, acting_as_team_member_id, token_hash, label, expires_at)
  values (p_account_id, p_kind, p_acting_as_team_member_id, p_token_hash, p_label, p_expires_at)
  returning * into s;
  return to_jsonb(s) - 'token_hash';
end
$$;

create or replace function public.revoke_auth_session(p_session_id uuid)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare owner_identity text;
begin
  perform internal.require_identity();
  select a.identity_id into owner_identity
    from public.auth_sessions s join public.accounts a on a.id = s.account_id
   where s.id = p_session_id;
  if owner_identity is null then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  if owner_identity is distinct from internal.identity_id() then
    perform internal.require_node_admin();
  end if;
  update public.auth_sessions set revoked_at = now()
   where id = p_session_id and revoked_at is null;
end
$$;

-- Called on every authenticated request. Deliberately does no authorization: it
-- is reached only after resolve_auth_session already matched the token hash.
create or replace function public.touch_auth_session(p_session_id uuid)
returns void language sql security definer set search_path = public, internal, pg_temp as $$
  update public.auth_sessions set last_used_at = now()
   where id = p_session_id and revoked_at is null
$$;

create or replace function public.prune_auth_sessions(p_retain interval default interval '30 days')
returns bigint language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare removed bigint;
begin
  perform internal.require_node_admin();
  delete from public.auth_sessions
   where (revoked_at is not null and revoked_at < now() - p_retain)
      or (expires_at < now() - p_retain);
  get diagnostics removed = row_count;
  return removed;
end
$$;

create or replace function public.upsert_user_profile(
  p_display_name text default null, p_avatar text default null, p_email text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text := internal.require_identity();
  profile public.user_profiles;
begin
  insert into public.user_profiles(identity_id, display_name, avatar, email)
  values (identity, p_display_name, p_avatar, p_email)
  on conflict (identity_id) do update
    set display_name = coalesce(excluded.display_name, user_profiles.display_name),
        avatar = coalesce(excluded.avatar, user_profiles.avatar),
        email = coalesce(excluded.email, user_profiles.email),
        updated_at = now()
  returning * into profile;
  return to_jsonb(profile);
end
$$;

-- identity.get — who the bound claim is, node-wide.
create or replace function public.current_identity()
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  identity text := internal.require_identity();
  result jsonb;
begin
  select jsonb_build_object(
      'identityId', a.identity_id, 'accountId', a.id, 'username', a.username,
      'displayName', coalesce(p.display_name, a.display_name), 'avatar', p.avatar,
      'email', coalesce(p.email, a.email),
      'isNodeAdmin', a.is_node_admin, 'isOwner', a.is_owner, 'status', a.status,
      'actingAs', internal.acting_as(),
      'memberships', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'spaceId', m.space_id, 'memberId', m.entity_id, 'role', m.role)
               order by m.joined_at)
          from public.members m where m.identity_id = a.identity_id), '[]'::jsonb))
    into result
    from public.accounts a
    left join public.user_profiles p on p.identity_id = a.identity_id
   where a.identity_id = identity;
  if result is null then
    raise exception 'no account for the bound identity' using errcode = '28000';
  end if;
  return result;
end
$$;

-- Per-space identity: the member row plus the personas this identity may act as.
create or replace function public.current_space_identity(p_space_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  perform internal.require_space_member(p_space_id);
  select jsonb_build_object(
      'spaceId', m.space_id, 'memberId', m.entity_id, 'role', m.role,
      'identityId', m.identity_id, 'displayName', coalesce(m.display_name, p.display_name),
      'teamMemberIds', coalesce((
        select jsonb_agg(tm.entity_id order by tm.name)
          from public.team_members tm where tm.owner_member_id = m.entity_id), '[]'::jsonb))
    into result
    from public.members m
    left join public.user_profiles p on p.identity_id = m.identity_id
   where m.space_id = p_space_id and m.identity_id = internal.identity_id();
  return result;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. Spaces (spaces.create / update / invites / join).
-- -----------------------------------------------------------------------------

-- spaces.create — creates the space, the caller's owner member, a `general`
-- channel and the default `type` task axis in one transaction. Default
-- visibility is 'private' (01 §2 fixes the deployed contradiction where the
-- column defaulted private and the RPC defaulted public).
create or replace function public.create_space(
  p_name text, p_description text default '', p_visibility text default 'private',
  p_github_repo text default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text;
  replay jsonb;
  space_id uuid := internal.new_id();
  member_id uuid := internal.new_id();
  channel_id uuid := internal.new_id();
  profile public.user_profiles;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.create');
  if replay is not null then return replay; end if;
  identity := internal.require_identity();
  if coalesce(p_visibility, 'private') not in ('private','public') then
    raise exception 'invalid space visibility' using errcode = '22023';
  end if;

  select * into profile from public.user_profiles where identity_id = identity;
  if profile.identity_id is null then
    insert into public.user_profiles(identity_id) values (identity) returning * into profile;
  end if;

  insert into public.spaces(id, name, description, github_repo, visibility, created_by_identity)
  values (space_id, p_name, coalesce(p_description, ''), p_github_repo,
          coalesce(p_visibility, 'private'), identity);

  -- The owner member entity is its own creator: the first row in a space has
  -- nobody else to be attributed to (the FK is deferred for exactly this).
  insert into public.entities(id, space_id, kind, created_by) values (member_id, space_id, 'member', member_id);
  insert into public.members(entity_id, space_id, identity_id, role, display_name)
  values (member_id, space_id, identity, 'owner', profile.display_name);

  insert into public.entities(id, space_id, kind, created_by) values (channel_id, space_id, 'channel', member_id);
  insert into public.channels(entity_id, space_id, name, topic)
  values (channel_id, space_id, 'general', 'General collaboration');

  insert into public.task_axes(space_id, name, axis_values, kind, position)
  values (space_id, 'type', array['default','code','design','review','test'], 'default', 0);

  perform internal.record_activity(space_id, member_id, member_id, 'joined',
            null, jsonb_build_object('role', 'owner'));

  result := jsonb_build_object(
    'space', (select to_jsonb(s) from public.spaces s where s.id = space_id),
    'memberId', member_id,
    'defaultChannelId', channel_id)
    || jsonb_build_object('patches', jsonb_build_array(internal.command_entity(channel_id),
                                                       internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.create', result);
end
$$;

create or replace function public.update_space(
  p_space_id uuid, p_name text default null, p_description text default null,
  p_github_repo text default null, p_visibility text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.update');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  if p_visibility is not null and p_visibility not in ('private','public') then
    raise exception 'invalid space visibility' using errcode = '22023';
  end if;
  update public.spaces
     set name = coalesce(p_name, name),
         description = coalesce(p_description, description),
         github_repo = coalesce(p_github_repo, github_repo),
         visibility = coalesce(p_visibility, visibility)
   where id = p_space_id;
  if not found then
    raise exception 'space not found' using errcode = 'P0002';
  end if;
  result := jsonb_build_object('space', (select to_jsonb(s) from public.spaces s where s.id = p_space_id),
                               'patches', '[]'::jsonb);
  return internal.ledger_record(p_client_mutation_id, 'spaces.update', result);
end
$$;

-- Joining a space always goes through one path (invite or public discovery), so
-- member creation lives in one place.
create or replace function internal.attach_member(p_space_id uuid, p_identity text, p_role text default 'member')
returns uuid language plpgsql set search_path = public, internal, pg_temp as $$
declare
  member_id uuid;
  profile public.user_profiles;
begin
  select entity_id into member_id from public.members
   where space_id = p_space_id and identity_id = p_identity;
  if member_id is not null then
    return member_id;
  end if;
  select * into profile from public.user_profiles where identity_id = p_identity;
  if profile.identity_id is null then
    insert into public.user_profiles(identity_id) values (p_identity) returning * into profile;
  end if;
  member_id := internal.new_id();
  insert into public.entities(id, space_id, kind, created_by)
  values (member_id, p_space_id, 'member', member_id);
  insert into public.members(entity_id, space_id, identity_id, role, display_name)
  values (member_id, p_space_id, p_identity, p_role, profile.display_name);
  perform internal.record_activity(p_space_id, member_id, member_id, 'joined',
            null, jsonb_build_object('role', p_role));
  return member_id;
end
$$;

create or replace function public.join_public_space(p_space_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text;
  replay jsonb;
  target public.spaces;
  member_id uuid;
  existed boolean;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.redeem');
  if replay is not null then return replay; end if;
  identity := internal.require_identity();
  select * into target from public.spaces where id = p_space_id;
  if target.id is null then
    raise exception 'space not found' using errcode = 'P0002';
  end if;
  select entity_id into member_id from public.members
   where space_id = p_space_id and identity_id = identity;
  existed := member_id is not null;
  if not existed then
    if target.visibility <> 'public' then
      raise exception 'space is not public' using errcode = '42501';
    end if;
    member_id := internal.attach_member(p_space_id, identity, 'member');
  end if;
  result := jsonb_build_object('spaceId', p_space_id, 'memberId', member_id, 'joined', not existed,
                               'patches', jsonb_build_array(internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.invites.redeem', result);
end
$$;

create or replace function public.create_invite(
  p_space_id uuid, p_max_uses integer default 1, p_expires_at timestamptz default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  invite public.space_invites;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.create');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  insert into public.space_invites(space_id, code, created_by, max_uses, expires_at)
  values (p_space_id, 'inv_' || replace(internal.new_id()::text, '-', ''),
          actor, coalesce(p_max_uses, 1), p_expires_at)
  returning * into invite;
  result := jsonb_build_object('invite', to_jsonb(invite), 'patches', '[]'::jsonb);
  return internal.ledger_record(p_client_mutation_id, 'spaces.invites.create', result);
end
$$;

create or replace function public.revoke_invite(p_invite_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  invite public.space_invites;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.revoke');
  if replay is not null then return replay; end if;
  select * into invite from public.space_invites where id = p_invite_id;
  if invite.id is null then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_admin(invite.space_id);
  update public.space_invites set revoked_at = coalesce(revoked_at, now()) where id = p_invite_id
  returning * into invite;
  result := jsonb_build_object('invite', to_jsonb(invite), 'patches', '[]'::jsonb);
  return internal.ledger_record(p_client_mutation_id, 'spaces.invites.revoke', result);
end
$$;

create or replace function public.redeem_invite(p_code text, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text;
  replay jsonb;
  invite public.space_invites;
  member_id uuid;
  existed boolean;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.redeem');
  if replay is not null then return replay; end if;
  identity := internal.require_identity();
  -- Lock the invite row: max_uses is a real limit, not a hint, so two
  -- simultaneous redemptions of a single-use code cannot both win.
  select * into invite from public.space_invites where code = p_code for update;
  if invite.id is null then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  if invite.revoked_at is not null then
    raise exception 'invite was revoked' using errcode = '42501';
  end if;
  if invite.expires_at is not null and invite.expires_at < now() then
    raise exception 'invite has expired' using errcode = '42501';
  end if;

  select entity_id into member_id from public.members
   where space_id = invite.space_id and identity_id = identity;
  existed := member_id is not null;
  if not existed then
    if invite.use_count >= invite.max_uses then
      raise exception 'invite is exhausted' using errcode = '53400';
    end if;
    member_id := internal.attach_member(invite.space_id, identity, 'member');
    update public.space_invites set use_count = use_count + 1 where id = invite.id;
    perform internal.notify(invite.space_id, invite.created_by, 'join', member_id, member_id,
                            jsonb_build_object('inviteId', invite.id));
  end if;
  result := jsonb_build_object('spaceId', invite.space_id, 'memberId', member_id, 'joined', not existed,
                               'patches', jsonb_build_array(internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.invites.redeem', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. Task axes (space configuration).
-- -----------------------------------------------------------------------------
create or replace function public.create_task_axis(
  p_space_id uuid, p_name text, p_axis_values text[] default '{}'::text[],
  p_kind text default 'manual', p_position integer default 0,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  axis public.task_axes;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.taskAxes.create');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  insert into public.task_axes(space_id, name, axis_values, kind, position)
  values (p_space_id, p_name, coalesce(p_axis_values, '{}'::text[]),
          coalesce(p_kind, 'manual'), coalesce(p_position, 0))
  returning * into axis;
  return internal.ledger_record(p_client_mutation_id, 'spaces.taskAxes.create',
           jsonb_build_object('axis', to_jsonb(axis), 'patches', '[]'::jsonb));
end
$$;

create or replace function public.update_task_axis(
  p_axis_id uuid, p_name text default null, p_axis_values text[] default null,
  p_position integer default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  axis public.task_axes;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.taskAxes.update');
  if replay is not null then return replay; end if;
  select * into axis from public.task_axes where id = p_axis_id;
  if axis.id is null then
    raise exception 'task axis not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_admin(axis.space_id);
  -- Narrowing an axis would invalidate tasks already carrying a dropped value,
  -- and the task trigger would then refuse their next edit for a reason the
  -- author never chose. Same principle as R9 for custom kinds.
  if p_axis_values is not null and cardinality(axis.axis_values) > 0 then
    if exists (
      select 1 from unnest(axis.axis_values) v
       where v <> all (p_axis_values)
         and exists (select 1 from public.tasks t
                       join public.entities e on e.id = t.entity_id
                      where e.space_id = axis.space_id and t.axes ->> axis.name = v)
    ) then
      raise exception 'cannot remove an axis value that tasks still use' using errcode = '23514';
    end if;
  end if;
  update public.task_axes
     set name = coalesce(p_name, name),
         axis_values = coalesce(p_axis_values, axis_values),
         position = coalesce(p_position, position)
   where id = p_axis_id
  returning * into axis;
  return internal.ledger_record(p_client_mutation_id, 'spaces.taskAxes.update',
           jsonb_build_object('axis', to_jsonb(axis), 'patches', '[]'::jsonb));
end
$$;

create or replace function public.delete_task_axis(p_axis_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  axis public.task_axes;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.taskAxes.delete');
  if replay is not null then return replay; end if;
  select * into axis from public.task_axes where id = p_axis_id;
  if axis.id is null then
    raise exception 'task axis not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_admin(axis.space_id);
  if exists (select 1 from public.tasks t join public.entities e on e.id = t.entity_id
              where e.space_id = axis.space_id and t.axes ? axis.name) then
    raise exception 'axis is still in use by tasks' using errcode = '23514';
  end if;
  delete from public.task_axes where id = p_axis_id;
  return internal.ledger_record(p_client_mutation_id, 'spaces.taskAxes.delete',
           jsonb_build_object('axisId', p_axis_id, 'patches', '[]'::jsonb));
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Projects (AM-2 §1) — node-level registry, then linked to spaces.
--
-- `workingDir` is never taken from a client at spawn time (S11): it is
-- registered here, once, by a node admin, and every later spawn derives its cwd
-- from this row.
-- -----------------------------------------------------------------------------
create or replace function public.create_project(
  p_name text, p_working_dir text, p_repo_url text default null,
  p_trust text default 'untrusted', p_defaults jsonb default '{}'::jsonb,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  project public.projects;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.create');
  if replay is not null then return replay; end if;
  perform internal.require_node_admin();
  if coalesce(p_trust, 'untrusted') not in ('trusted','untrusted') then
    raise exception 'invalid trust level' using errcode = '22023';
  end if;
  insert into public.projects(name, working_dir, repo_url, trust, defaults)
  values (p_name, p_working_dir, p_repo_url, coalesce(p_trust, 'untrusted'),
          coalesce(p_defaults, '{}'::jsonb))
  returning * into project;
  return internal.ledger_record(p_client_mutation_id, 'projects.create',
           jsonb_build_object('project', to_jsonb(project), 'patches', '[]'::jsonb));
end
$$;

create or replace function public.update_project(
  p_project_id uuid, p_name text default null, p_working_dir text default null,
  p_repo_url text default null, p_trust text default null, p_defaults jsonb default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  project public.projects;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.update');
  if replay is not null then return replay; end if;
  perform internal.require_node_admin();
  if p_trust is not null and p_trust not in ('trusted','untrusted') then
    raise exception 'invalid trust level' using errcode = '22023';
  end if;
  update public.projects
     set name = coalesce(p_name, name),
         working_dir = coalesce(p_working_dir, working_dir),
         repo_url = coalesce(p_repo_url, repo_url),
         trust = coalesce(p_trust, trust),
         defaults = coalesce(p_defaults, defaults)
   where id = p_project_id
  returning * into project;
  if project.id is null then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  return internal.ledger_record(p_client_mutation_id, 'projects.update',
           jsonb_build_object('project', to_jsonb(project), 'patches', '[]'::jsonb));
end
$$;

create or replace function public.link_project(
  p_space_id uuid, p_project_id uuid, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.link');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  if not exists (select 1 from public.projects where id = p_project_id) then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  insert into public.space_projects(space_id, project_id, linked_by)
  values (p_space_id, p_project_id, actor)
  on conflict (space_id, project_id) do nothing;
  return internal.ledger_record(p_client_mutation_id, 'projects.link',
           jsonb_build_object('spaceId', p_space_id, 'projectId', p_project_id, 'patches', '[]'::jsonb));
end
$$;

create or replace function public.unlink_project(
  p_space_id uuid, p_project_id uuid, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.unlink');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  -- A live session is running out of this project's directory right now; pulling
  -- the link would leave it unattributable.
  if exists (
    select 1 from public.work_sessions ws
      join public.entities e on e.id = ws.entity_id
     where ws.project_id = p_project_id and e.space_id = p_space_id
       and ws.status in ('spawning','running','idle')
  ) then
    raise exception 'project has live work sessions in this space' using errcode = '23514';
  end if;
  delete from public.space_projects where space_id = p_space_id and project_id = p_project_id;
  return internal.ledger_record(p_client_mutation_id, 'projects.unlink',
           jsonb_build_object('spaceId', p_space_id, 'projectId', p_project_id, 'patches', '[]'::jsonb));
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Entity creation — per-kind typed RPCs.
--
-- The layer rule (02 §6): SQL stays fully typed per kind; the SERVICE layer
-- presents the uniform `entities.create` / `entities.patch` and dispatches on
-- kind. Uniformity is an API property, not a database one.
-- -----------------------------------------------------------------------------

-- Attribute trigger-written rows (versions, activity) to the resolved actor
-- without every trigger needing an argument.
create or replace function internal.bind_actor(p_actor uuid) returns void
language sql set search_path = public, internal, pg_temp as $$
  select set_config('tm8.actor_id', coalesce(p_actor::text, ''), true)
$$;

-- Shared envelope insert for every create_* RPC: one place that knows the
-- envelope columns, the initial version snapshot and the optional atomic attach.
create or replace function internal.create_envelope(
  p_space_id uuid, p_kind text, p_actor uuid, p_parent_id uuid, p_position double precision
) returns uuid language plpgsql set search_path = public, internal, pg_temp as $$
declare new_id uuid := internal.new_id();
begin
  insert into public.entities(id, space_id, kind, parent_id, position, created_by)
  values (new_id, p_space_id, p_kind, p_parent_id, p_position, p_actor);
  return new_id;
end
$$;

-- `attachTo` on a create input means "create the thing and the edge atomically"
-- (channel-create, promote-message). Two statements, one transaction, no window
-- where the entity exists unattached.
create or replace function internal.attach_on_create(
  p_space_id uuid, p_new_id uuid, p_actor uuid, p_target uuid, p_edge_type text
) returns uuid language plpgsql set search_path = public, internal, pg_temp as $$
declare edge_id uuid;
begin
  if p_target is null then
    return null;
  end if;
  if coalesce(p_edge_type, 'attached_to') not in ('attached_to','relates_to') then
    raise exception 'attachTo supports attached_to or relates_to' using errcode = '22023';
  end if;
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (p_space_id, p_new_id, p_target, coalesce(p_edge_type, 'attached_to'), p_actor)
  on conflict (src_id, dst_id, type) do update set updated_at = now()
  returning id into edge_id;
  return edge_id;
end
$$;

create or replace function public.create_task(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_description text default '',
  p_axes jsonb default '{}'::jsonb, p_parent_id uuid default null,
  p_position double precision default null, p_priority text default 'medium',
  p_acceptance_criteria jsonb default '[]'::jsonb, p_points_estimate integer default null,
  p_due_date date default null, p_attach_to uuid default null,
  p_attach_edge_type text default 'attached_to', p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  task_id uuid;
  activity_id uuid;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then return replay; end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  task_id := internal.create_envelope(p_space_id, 'task', actor, p_parent_id, p_position);
  insert into public.tasks(entity_id, title, description, axes, priority,
                           acceptance_criteria, points_estimate, due_date)
  values (task_id, p_title, coalesce(p_description, ''), coalesce(p_axes, '{}'::jsonb),
          coalesce(p_priority, 'medium'), coalesce(p_acceptance_criteria, '[]'::jsonb),
          p_points_estimate, p_due_date);
  perform internal.record_initial_version(task_id, actor);
  perform internal.attach_on_create(p_space_id, task_id, actor, p_attach_to, p_attach_edge_type);
  activity_id := internal.record_activity(p_space_id, task_id, actor, 'created',
                   null, jsonb_build_object('kind', 'task'));

  result := internal.command_result(task_id, null, activity_id, array[task_id]);
  return internal.ledger_record(p_client_mutation_id, 'entities.create', result);
end
$$;

-- update_task_content keeps full-snapshot semantics deliberately (01 §6): the
-- caller sends the whole content block. Only the DETAIL row is written here —
-- the snapshot trigger owns version, activity_at and the entity_versions row.
create or replace function public.update_task_content(
  p_task_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_description text default null, p_axes jsonb default null,
  p_work_status text default null, p_priority text default null,
  p_acceptance_criteria jsonb default null, p_points_estimate integer default null,
  p_due_date date default null, p_clear_due_date boolean default false,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_task_id, 'task');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_task_id, p_expected_version);
  if p_work_status = 'done' then
    raise exception 'completion goes through complete_task' using errcode = '23514';
  end if;

  update public.tasks
     set title = coalesce(p_title, title),
         description = coalesce(p_description, description),
         axes = coalesce(p_axes, axes),
         work_status = coalesce(p_work_status, work_status),
         priority = coalesce(p_priority, priority),
         acceptance_criteria = coalesce(p_acceptance_criteria, acceptance_criteria),
         points_estimate = coalesce(p_points_estimate, points_estimate),
         due_date = case when p_clear_due_date then null else coalesce(p_due_date, due_date) end,
         updated_at = now()
   where entity_id = p_task_id;
  activity_id := internal.record_activity(e.space_id, p_task_id, actor, 'updated',
                   null, jsonb_build_object('kind', 'task'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_task_id, null, activity_id, array[p_task_id]));
end
$$;

create or replace function public.create_document(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_body text default '',
  p_format text default 'markdown', p_parent_id uuid default null,
  p_position double precision default null, p_attach_to uuid default null,
  p_attach_edge_type text default 'attached_to', p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  doc_id uuid;
  activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then return replay; end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  doc_id := internal.create_envelope(p_space_id, 'doc', actor, p_parent_id, p_position);
  insert into public.documents(entity_id, title, body, format)
  values (doc_id, p_title, coalesce(p_body, ''), coalesce(p_format, 'markdown'));
  perform internal.record_initial_version(doc_id, actor);
  perform internal.attach_on_create(p_space_id, doc_id, actor, p_attach_to, p_attach_edge_type);
  activity_id := internal.record_activity(p_space_id, doc_id, actor, 'created',
                   null, jsonb_build_object('kind', 'doc'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(doc_id, null, activity_id, array[doc_id]));
end
$$;

create or replace function public.update_document(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_body text default null, p_format text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id, 'doc');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.documents
     set title = coalesce(p_title, title),
         body = coalesce(p_body, body),
         format = coalesce(p_format, format),
         updated_at = now()
   where entity_id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
                   null, jsonb_build_object('kind', 'doc'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$$;

create or replace function public.create_channel(
  p_space_id uuid, p_name text, p_actor_id uuid default null, p_topic text default '',
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  channel_id uuid;
  activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then return replay; end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);
  channel_id := internal.create_envelope(p_space_id, 'channel', actor, p_parent_id, p_position);
  insert into public.channels(entity_id, space_id, name, topic)
  values (channel_id, p_space_id, lower(btrim(p_name)), coalesce(p_topic, ''));
  perform internal.record_initial_version(channel_id, actor);
  activity_id := internal.record_activity(p_space_id, channel_id, actor, 'created',
                   null, jsonb_build_object('kind', 'channel'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(channel_id, null, activity_id, array[channel_id]));
end
$$;

create or replace function public.update_channel(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_name text default null, p_topic text default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id, 'channel');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.channels
     set name = coalesce(lower(btrim(p_name)), name), topic = coalesce(p_topic, topic), updated_at = now()
   where entity_id = p_entity_id;
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'channel')), array[p_entity_id]));
end
$$;

create or replace function public.create_collection(
  p_space_id uuid, p_name text, p_actor_id uuid default null, p_description text default '',
  p_collection_type text default 'manual', p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  collection_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then return replay; end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);
  collection_id := internal.create_envelope(p_space_id, 'collection', actor, p_parent_id, p_position);
  insert into public.collections(entity_id, name, description, collection_type)
  values (collection_id, p_name, coalesce(p_description, ''), coalesce(p_collection_type, 'manual'));
  perform internal.record_initial_version(collection_id, actor);
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(collection_id, null,
             internal.record_activity(p_space_id, collection_id, actor, 'created',
               null, jsonb_build_object('kind', 'collection')), array[collection_id]));
end
$$;

create or replace function public.update_collection(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_name text default null, p_description text default null,
  p_collection_type text default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id, 'collection');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.collections
     set name = coalesce(p_name, name), description = coalesce(p_description, description),
         collection_type = coalesce(p_collection_type, collection_type), updated_at = now()
   where entity_id = p_entity_id;
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'collection')), array[p_entity_id]));
end
$$;

-- Collection membership is `contains` edges; ordering is props.position. Sugar
-- over write_edge so the UI has one call for "put this in that list".
create or replace function public.set_collection_item(
  p_collection_id uuid, p_entity_id uuid, p_position double precision default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  collection public.entities;
  actor uuid;
  next_position double precision;
  edge_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.create');
  if replay is not null then return replay; end if;
  collection := internal.live_entity(p_collection_id, 'collection');
  perform internal.require_space_member(collection.space_id);
  actor := internal.resolve_actor(p_actor_id, collection.space_id);
  perform internal.bind_actor(actor);
  perform internal.live_entity(p_entity_id);

  next_position := p_position;
  if next_position is null then
    select coalesce(max((props ->> 'position')::double precision), 0) + 1 into next_position
      from public.edges where src_id = p_collection_id and type = 'contains';
  end if;
  insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
  values (collection.space_id, p_collection_id, p_entity_id, 'contains',
          jsonb_build_object('position', next_position), actor)
  on conflict (src_id, dst_id, type) do update
    set props = public.edges.props || jsonb_build_object('position', next_position), updated_at = now()
  returning id into edge_id;
  return internal.ledger_record(p_client_mutation_id, 'edges.create',
           internal.command_result(null, edge_id,
             internal.record_activity(collection.space_id, p_collection_id, actor, 'linked',
               edge_id, jsonb_build_object('type', 'contains')),
             array[p_collection_id, p_entity_id]));
end
$$;

create or replace function public.create_team_member(
  p_space_id uuid, p_name text, p_actor_id uuid default null, p_role text default '',
  p_identity text default '', p_model text default null, p_agent_tool text default null,
  p_mode text default null, p_permission_mode text default null,
  p_capabilities jsonb default '{}'::jsonb, p_command_permissions jsonb default '{}'::jsonb,
  p_avatar text default null, p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  owner_member uuid;
  persona_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then return replay; end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  -- A persona is owned by a HUMAN member: an agent cannot mint another agent for
  -- itself, or can_act_as would grow a new root every spawn.
  owner_member := internal.current_member_id(p_space_id);
  if owner_member is null then
    raise exception 'only a member may own a team_member persona' using errcode = '42501';
  end if;
  persona_id := internal.create_envelope(p_space_id, 'team_member', actor, p_parent_id, p_position);
  insert into public.team_members(entity_id, owner_member_id, name, role, identity, model,
                                  agent_tool, mode, permission_mode, capabilities,
                                  command_permissions, avatar)
  values (persona_id, owner_member, p_name, coalesce(p_role, ''), coalesce(p_identity, ''),
          p_model, p_agent_tool, p_mode, p_permission_mode,
          coalesce(p_capabilities, '{}'::jsonb), coalesce(p_command_permissions, '{}'::jsonb), p_avatar);
  perform internal.record_initial_version(persona_id, actor);
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(persona_id, null,
             internal.record_activity(p_space_id, persona_id, actor, 'created',
               null, jsonb_build_object('kind', 'team_member')), array[persona_id]));
end
$$;

create or replace function public.update_team_member(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_name text default null, p_role text default null, p_identity text default null,
  p_model text default null, p_agent_tool text default null, p_mode text default null,
  p_permission_mode text default null, p_capabilities jsonb default null,
  p_command_permissions jsonb default null, p_avatar text default null,
  p_memories jsonb default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  owner_member uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id, 'team_member');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  -- Only the owning human (or a space admin) reshapes a persona. An agent
  -- rewriting its own permissions is precisely the escalation S13 forbids.
  select owner_member_id into owner_member from public.team_members where entity_id = p_entity_id;
  if not internal.is_space_admin(e.space_id)
     and owner_member is distinct from internal.current_member_id(e.space_id) then
    raise exception 'only the owning member or a space admin may update this persona'
      using errcode = '42501';
  end if;

  update public.team_members
     set name = coalesce(p_name, name), role = coalesce(p_role, role),
         identity = coalesce(p_identity, identity), model = coalesce(p_model, model),
         agent_tool = coalesce(p_agent_tool, agent_tool), mode = coalesce(p_mode, mode),
         permission_mode = coalesce(p_permission_mode, permission_mode),
         capabilities = coalesce(p_capabilities, capabilities),
         command_permissions = coalesce(p_command_permissions, command_permissions),
         avatar = coalesce(p_avatar, avatar), memories = coalesce(p_memories, memories),
         updated_at = now()
   where entity_id = p_entity_id;
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'team_member')), array[p_entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 7. Edges.
-- -----------------------------------------------------------------------------
create or replace function public.write_edge(
  p_src_id uuid, p_dst_id uuid, p_type text, p_props jsonb default '{}'::jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  src public.entities;
  dst public.entities;
  actor uuid;
  edge_id uuid;
  activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.create');
  if replay is not null then return replay; end if;
  src := internal.live_entity(p_src_id);
  dst := internal.live_entity(p_dst_id);
  if src.space_id <> dst.space_id then
    raise exception 'edge endpoints must be in the same space' using errcode = '23514';
  end if;
  perform internal.require_space_member(src.space_id);
  actor := internal.resolve_actor(p_actor_id, src.space_id);
  perform internal.bind_actor(actor);

  insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
  values (src.space_id, p_src_id, p_dst_id, p_type, coalesce(p_props, '{}'::jsonb), actor)
  on conflict (src_id, dst_id, type) do update set props = excluded.props, updated_at = now()
  returning id into edge_id;
  activity_id := internal.record_activity(src.space_id, p_src_id, actor, 'linked', edge_id,
                   jsonb_build_object('type', p_type, 'dstId', p_dst_id));
  return internal.ledger_record(p_client_mutation_id, 'edges.create',
           internal.command_result(null, edge_id, activity_id, array[p_src_id, p_dst_id],
             internal.issue_undo_token(src.space_id, actor, 'Undo link', 'edges.delete',
               jsonb_build_object('edgeId', edge_id))));
end
$$;

create or replace function public.update_edge(
  p_edge_id uuid, p_props jsonb, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  edge public.edges;
  actor uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.patch');
  if replay is not null then return replay; end if;
  select * into edge from public.edges where id = p_edge_id;
  if edge.id is null then
    raise exception 'edge not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(edge.space_id);
  actor := internal.resolve_actor(p_actor_id, edge.space_id);
  perform internal.bind_actor(actor);
  update public.edges set props = coalesce(p_props, '{}'::jsonb), updated_at = now() where id = p_edge_id;
  return internal.ledger_record(p_client_mutation_id, 'edges.patch',
           internal.command_result(null, p_edge_id, null, array[edge.src_id, edge.dst_id]));
end
$$;

create or replace function public.delete_edge(
  p_edge_id uuid, p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  edge public.edges;
  actor uuid;
  activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.delete');
  if replay is not null then return replay; end if;
  select * into edge from public.edges where id = p_edge_id;
  if edge.id is null then
    raise exception 'edge not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(edge.space_id);
  actor := internal.resolve_actor(p_actor_id, edge.space_id);
  perform internal.bind_actor(actor);
  delete from public.edges where id = p_edge_id;
  activity_id := internal.record_activity(edge.space_id, edge.src_id, actor, 'unlinked', p_edge_id,
                   jsonb_build_object('type', edge.type, 'dstId', edge.dst_id));
  return internal.ledger_record(p_client_mutation_id, 'edges.delete',
           internal.command_result(null, null, activity_id, array[edge.src_id, edge.dst_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 8. Envelope commands: move, delete, restore, react, points, placements.
-- -----------------------------------------------------------------------------

-- entities.move — the only envelope-level write that bumps `version` itself
-- (no detail row changed, so no snapshot trigger fires).
create or replace function public.move_entity(
  p_entity_id uuid, p_parent_id uuid, p_position double precision, p_expected_version integer,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.move');
  if replay is not null then return replay; end if;
  select * into e from public.entities where id = p_entity_id and deleted_at is null for update;
  if e.id is null then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  update public.entities
     set parent_id = p_parent_id, position = p_position,
         version = version + 1, updated_at = now(), activity_at = now()
   where id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'moved', null,
                   jsonb_build_object('fromParentId', e.parent_id, 'toParentId', p_parent_id));
  return internal.ledger_record(p_client_mutation_id, 'entities.move',
           internal.command_result(p_entity_id, null, activity_id, array[p_entity_id],
             internal.issue_undo_token(e.space_id, actor, 'Undo move', 'entities.move',
               jsonb_build_object('entityId', p_entity_id, 'parentId', e.parent_id,
                                  'position', e.position, 'expectedVersion', e.version + 1))));
end
$$;

-- The ONLY writer of deleted_at (design §5.4). Soft-deletes the whole subtree in
-- one transaction, because a hierarchy with a live child under a dead parent is
-- a shape the reads would have to special-case forever.
create or replace function public.delete_entity(
  p_entity_id uuid, p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  affected uuid[];
  activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.delete');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id);
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  if e.kind = 'member' then
    raise exception 'a member entity is removed by leaving the space, not deleted'
      using errcode = '23514';
  end if;

  -- Collect the subtree first: the patch list must name every entity whose state
  -- changed, and after the UPDATE the traversal can no longer distinguish rows
  -- this command tombstoned from rows that were already gone.
  with recursive subtree(id) as (
    select p_entity_id
    union all
    select child.id from public.entities child join subtree s on child.parent_id = s.id
  )
  select array_agg(s.id) into affected
    from subtree s join public.entities e2 on e2.id = s.id
   where e2.deleted_at is null;

  update public.entities set deleted_at = now(), updated_at = now()
   where id = any (coalesce(affected, array[]::uuid[]));

  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'deleted', null,
                   jsonb_build_object('kind', e.kind));
  return internal.ledger_record(p_client_mutation_id, 'entities.delete',
           internal.command_result(p_entity_id, null, activity_id, coalesce(affected, array[p_entity_id]),
             internal.issue_undo_token(e.space_id, actor, 'Undo delete', 'entities.restore',
               jsonb_build_object('entityId', p_entity_id))));
end
$$;

create or replace function public.restore_entity(
  p_entity_id uuid, p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  affected uuid[];
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.restore');
  if replay is not null then return replay; end if;
  select * into e from public.entities where id = p_entity_id;
  if e.id is null then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  -- Restoring under a still-deleted parent would resurrect an orphan.
  if e.parent_id is not null and exists (
    select 1 from public.entities p where p.id = e.parent_id and p.deleted_at is not null
  ) then
    raise exception 'restore the parent first' using errcode = '23514';
  end if;

  with recursive subtree(id) as (
    select p_entity_id
    union all
    select child.id from public.entities child join subtree s on child.parent_id = s.id
  )
  update public.entities set deleted_at = null, updated_at = now()
   where id in (select id from subtree) and deleted_at is not null;
  select array_agg(id) into affected from public.entities
   where id = p_entity_id or parent_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'entities.restore',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'restored', null,
               jsonb_build_object('kind', e.kind)),
             coalesce(affected, array[p_entity_id])));
end
$$;

-- entities.react — edge sugar. Like and dislike are mutually exclusive; star is
-- independent. Reactions are authored by a human member (registry enforces it).
create or replace function public.react(
  p_entity_id uuid, p_reaction text, p_enabled boolean default true,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  target public.entities;
  actor uuid;
  edge_type text;
  opposite text;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.react');
  if replay is not null then return replay; end if;
  edge_type := case lower(p_reaction)
                 when 'like' then 'likes' when 'likes' then 'likes'
                 when 'dislike' then 'dislikes' when 'dislikes' then 'dislikes'
                 when 'star' then 'stars' when 'stars' then 'stars'
                 else null end;
  if edge_type is null then
    raise exception 'unsupported reaction: %', p_reaction using errcode = '22023';
  end if;
  target := internal.live_entity(p_entity_id);
  perform internal.require_space_member(target.space_id);
  actor := coalesce(internal.current_member_id(target.space_id), p_actor_id);
  if actor is null or not exists (select 1 from public.members where entity_id = actor) then
    raise exception 'reactions are authored by a member' using errcode = '42501';
  end if;
  perform internal.bind_actor(actor);

  if not p_enabled then
    delete from public.edges where src_id = actor and dst_id = p_entity_id and type = edge_type;
  else
    opposite := case edge_type when 'likes' then 'dislikes' when 'dislikes' then 'likes' else null end;
    if opposite is not null then
      delete from public.edges where src_id = actor and dst_id = p_entity_id and type = opposite;
    end if;
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (target.space_id, actor, p_entity_id, edge_type, actor)
    on conflict (src_id, dst_id, type) do nothing;
  end if;
  return internal.ledger_record(p_client_mutation_id, 'entities.react',
           internal.command_result(p_entity_id, null,
             internal.record_activity(target.space_id, p_entity_id, actor, 'reacted', null,
               jsonb_build_object('reaction', edge_type, 'enabled', p_enabled)), array[p_entity_id]));
end
$$;

create or replace function public.grant_points(
  p_entity_id uuid, p_amount integer, p_reason text default 'grant',
  p_ref_id uuid default null, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  target public.entities;
  actor uuid;
  event_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.points.add');
  if replay is not null then return replay; end if;
  if p_amount = 0 then
    raise exception 'point amount must be non-zero' using errcode = '22023';
  end if;
  target := internal.live_entity(p_entity_id);
  perform internal.require_space_member(target.space_id);
  actor := internal.resolve_actor(p_actor_id, target.space_id);
  perform internal.bind_actor(actor);
  if target.kind not in ('member','team_member') then
    raise exception 'points are granted to a member or team_member' using errcode = '22023';
  end if;

  -- Domain-level idempotency stays where it already is (04 §5.1): the ledger is
  -- an envelope on top, not a replacement for the ledger key here.
  insert into public.point_events(space_id, entity_id, actor_id, amount, reason, ref_id, client_event_id)
  values (target.space_id, p_entity_id, actor, p_amount, coalesce(p_reason, 'grant'), p_ref_id,
          nullif(p_client_mutation_id, ''))
  on conflict (client_event_id) do nothing
  returning id into event_id;
  if event_id is null and p_client_mutation_id is not null then
    select id into event_id from public.point_events where client_event_id = p_client_mutation_id;
  end if;
  return internal.ledger_record(p_client_mutation_id, 'entities.points.add',
           internal.command_result(p_entity_id, null, null, array[p_entity_id])
             || jsonb_build_object('pointEventId', event_id));
end
$$;

-- placements.apply — intent resolution for drag/drop. It resolves to an existing
-- command; it is not a fifth way to write the graph.
create or replace function public.place_entity(
  p_source_id uuid, p_target_id uuid, p_intent text, p_embed_message text default null,
  p_position double precision default null, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  source public.entities;
  target public.entities;
  edge_type text;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'placements.apply');
  if replay is not null then return replay; end if;
  source := internal.live_entity(p_source_id);
  target := internal.live_entity(p_target_id);
  perform internal.require_space_member(source.space_id);

  if p_intent in ('subtask','reparent') then
    return internal.ledger_record(p_client_mutation_id, 'placements.apply',
             public.move_entity(p_source_id, p_target_id, p_position, source.version, p_actor_id, null));
  end if;
  edge_type := case p_intent
                 when 'attach' then 'attached_to'
                 when 'assign' then 'assigned_to'
                 when 'depend' then 'depends_on'
                 when 'embed' then 'relates_to'
                 else null end;
  if edge_type is null then
    raise exception 'unsupported placement intent: %', p_intent using errcode = '22023';
  end if;
  return internal.ledger_record(p_client_mutation_id, 'placements.apply',
           public.write_edge(p_source_id, p_target_id, edge_type,
             case when p_intent = 'embed' then jsonb_build_object('message', p_embed_message)
                  else '{}'::jsonb end,
             p_actor_id, null));
end
$$;

-- commands.undo — redeems a token by running its recorded inverse. The client
-- never names the inverse command; it only holds an opaque token (DEV-11).
create or replace function public.undo_command(p_token text, p_actor_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  token public.undo_tokens;
  args jsonb;
begin
  select * into token from public.undo_tokens where undo_tokens.token = p_token for update;
  if token.token is null then
    raise exception 'undo token not found' using errcode = 'P0002';
  end if;
  if token.redeemed_at is not null then
    raise exception 'undo token already redeemed' using errcode = '23514';
  end if;
  if token.expires_at < now() then
    raise exception 'undo token expired' using errcode = '23514';
  end if;
  perform internal.require_space_member(token.space_id);
  if not internal.can_act_as(token.actor_id, token.space_id) then
    raise exception 'only the original actor may undo this' using errcode = '42501';
  end if;
  update public.undo_tokens set redeemed_at = now() where undo_tokens.token = p_token;

  args := token.arguments;
  case token.operation
    when 'edges.delete' then
      return public.delete_edge((args ->> 'edgeId')::uuid, token.actor_id, null);
    when 'entities.move' then
      return public.move_entity((args ->> 'entityId')::uuid, (args ->> 'parentId')::uuid,
                                (args ->> 'position')::double precision,
                                (args ->> 'expectedVersion')::integer, token.actor_id, null);
    when 'entities.restore' then
      return public.restore_entity((args ->> 'entityId')::uuid, token.actor_id, null);
    else
      raise exception 'no inverse registered for %', token.operation using errcode = '0A000';
  end case;
end
$$;

-- -----------------------------------------------------------------------------
-- 9. Messages.
-- -----------------------------------------------------------------------------
create or replace function public.post_message(
  p_anchor_id uuid, p_body text, p_actor_id uuid default null,
  p_parent_message_id uuid default null, p_mentions jsonb default '[]'::jsonb,
  p_attachments jsonb default '[]'::jsonb, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  anchor public.entities;
  actor uuid;
  existing uuid;
  message_id uuid;
  thread_root uuid;
  parent public.messages;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'messages.post');
  if replay is not null then return replay; end if;
  anchor := internal.live_entity(p_anchor_id);
  perform internal.require_space_member(anchor.space_id);
  actor := internal.resolve_actor(p_actor_id, anchor.space_id);
  perform internal.bind_actor(actor);

  -- Domain idempotency predates the ledger and stays (04 §5.1).
  if p_client_mutation_id is not null then
    select entity_id into existing from public.messages
     where author_id = actor and client_msg_id = p_client_mutation_id;
    if existing is not null then
      return internal.ledger_record(p_client_mutation_id, 'messages.post',
               internal.command_result(existing, null, null, array[p_anchor_id]));
    end if;
  end if;

  if p_parent_message_id is not null then
    select * into parent from public.messages where entity_id = p_parent_message_id;
    if parent.entity_id is null then
      raise exception 'parent message not found' using errcode = '23503';
    end if;
    thread_root := coalesce(parent.root_message_id, parent.entity_id);
  end if;

  message_id := internal.new_id();
  insert into public.entities(id, space_id, kind, parent_id, created_by)
  values (message_id, anchor.space_id, 'message', p_parent_message_id, actor);
  insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body,
                              mentions, attachments, client_msg_id)
  values (message_id, p_anchor_id, thread_root, actor, p_body,
          coalesce(p_mentions, '[]'::jsonb), coalesce(p_attachments, '[]'::jsonb),
          nullif(p_client_mutation_id, ''));
  -- Deliberately NO activity row: a thread is its own record (01 §S3).
  return internal.ledger_record(p_client_mutation_id, 'messages.post',
           internal.command_result(message_id, null, null, array[p_anchor_id]));
end
$$;

create or replace function public.edit_message(
  p_message_id uuid, p_body text, p_expected_version integer default null,
  p_mentions jsonb default null, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  message public.messages;
  actor uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'messages.edit');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_message_id, 'message');
  select * into message from public.messages where entity_id = p_message_id;
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_message_id, p_expected_version);
  -- Only the author edits a message. An admin may redact it, never rewrite it:
  -- an edited-by-someone-else message is a forged quote.
  if message.author_id <> actor and not internal.can_act_as(message.author_id, e.space_id) then
    raise exception 'only the author may edit this message' using errcode = '42501';
  end if;
  update public.messages
     set body = p_body, mentions = coalesce(p_mentions, mentions)
   where entity_id = p_message_id;
  return internal.ledger_record(p_client_mutation_id, 'messages.edit',
           internal.command_result(p_message_id, null, null, array[message.anchor_id]));
end
$$;

-- messages.delete IS the tombstone/redaction semantics (02 §3.2): the row stays
-- so the thread keeps its shape; the body is replaced by a tombstone.
create or replace function public.redact_message(
  p_message_id uuid, p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  message public.messages;
  actor uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'messages.delete');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_message_id, 'message');
  select * into message from public.messages where entity_id = p_message_id;
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  if message.author_id <> actor
     and not internal.can_act_as(message.author_id, e.space_id)
     and not internal.is_space_admin(e.space_id) then
    raise exception 'only the author or a space admin may redact this message' using errcode = '42501';
  end if;

  update public.messages
     set body = '[redacted]', mentions = '[]'::jsonb, attachments = '[]'::jsonb, redacted_at = now()
   where entity_id = p_message_id;
  update public.entities set deleted_at = now(), updated_at = now() where id = p_message_id;
  return internal.ledger_record(p_client_mutation_id, 'messages.delete',
           internal.command_result(p_message_id, null, null, array[message.anchor_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 10. Task kind-commands (02 §3.2) — the few operations that carry an invariant
--     a uniform patch cannot express.
-- -----------------------------------------------------------------------------

-- entities.commands.complete — criteria gate, completion attribution and the
-- award ledger in ONE transaction. A task that is "done" with unfinished
-- acceptance criteria, or completed twice paying out twice, are both unreachable
-- states rather than bugs to be found later.
create or replace function public.complete_task(
  p_task_id uuid, p_expected_version integer, p_completer_ids uuid[] default '{}'::uuid[],
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  completer uuid;
  task public.tasks;
  activity_id uuid;
  patches uuid[];
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.commands.complete');
  if replay is not null then return replay; end if;
  select * into e from public.entities where id = p_task_id and kind = 'task' and deleted_at is null for update;
  if e.id is null then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_task_id, p_expected_version);

  select * into task from public.tasks where entity_id = p_task_id;
  if task.work_status = 'done' then
    raise exception 'task is already complete' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(task.acceptance_criteria) c
     where not coalesce((c ->> 'done')::boolean, false)
  ) then
    raise exception 'all acceptance criteria must be complete first' using errcode = '23514';
  end if;

  patches := array[p_task_id];
  update public.tasks set work_status = 'done', updated_at = now() where entity_id = p_task_id;

  foreach completer in array coalesce(p_completer_ids, '{}'::uuid[]) loop
    if not exists (
      select 1 from public.entities c
       where c.id = completer and c.space_id = e.space_id
         and c.kind in ('member','team_member') and c.deleted_at is null
    ) then
      raise exception 'invalid completer %', completer using errcode = '23503';
    end if;
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (e.space_id, p_task_id, completer, 'completed_by', actor)
    on conflict (src_id, dst_id, type) do nothing;
    -- The award is idempotent per (command, completer): a retry of the same
    -- completion cannot pay twice, which is why the key includes both.
    insert into public.point_events(space_id, entity_id, actor_id, amount, reason, ref_id, client_event_id)
    select e.space_id, completer, actor, task.points_estimate, 'award', p_task_id,
           case when p_client_mutation_id is null then null
                else p_client_mutation_id || ':award:' || completer::text end
     where coalesce(task.points_estimate, 0) > 0
    on conflict (client_event_id) do nothing;
    patches := patches || completer;
  end loop;

  activity_id := internal.record_activity(e.space_id, p_task_id, actor, 'completed', null,
                   jsonb_build_object('completerIds', to_jsonb(coalesce(p_completer_ids, '{}'::uuid[]))));
  return internal.ledger_record(p_client_mutation_id, 'entities.commands.complete',
           internal.command_result(p_task_id, null, activity_id, patches));
end
$$;

-- entities.commands.work — work_status transitions with the per-actor
-- `working_on` edge. `done` is refused here on purpose: completion has a gate.
create or replace function public.set_work_state(
  p_task_id uuid, p_status text, p_actor_id uuid default null,
  p_started_at timestamptz default null, p_note text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  edge_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.commands.work');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_task_id, 'task');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  if p_status not in ('open','pulled','working','in_review','blocked','cancelled') then
    if p_status = 'done' then
      raise exception 'completion goes through complete_task' using errcode = '23514';
    end if;
    raise exception 'invalid work status: %', p_status using errcode = '22023';
  end if;

  if p_status in ('open','cancelled') then
    delete from public.edges
     where src_id = actor and dst_id = p_task_id and type = 'working_on';
  else
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (e.space_id, actor, p_task_id, 'working_on',
            jsonb_build_object('status', p_status, 'startedAt', coalesce(p_started_at, now()), 'note', p_note),
            actor)
    on conflict (src_id, dst_id, type) do update
      set props = excluded.props, updated_at = now()
    returning id into edge_id;
  end if;

  update public.tasks set work_status = p_status, updated_at = now() where entity_id = p_task_id;
  return internal.ledger_record(p_client_mutation_id, 'entities.commands.work',
           internal.command_result(p_task_id, edge_id,
             internal.record_activity(e.space_id, p_task_id, actor, 'work.changed', edge_id,
               jsonb_build_object('status', p_status)), array[p_task_id]));
end
$$;

-- entities.commands.pull — the projection/adoption edge carrying the pinned
-- version. Staleness (pinnedVersion < entity.version) is derived by the server
-- from this edge; nothing here duplicates that computation.
create or replace function public.set_pull_state(
  p_entity_id uuid, p_pinned_version integer, p_local_id text default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  edge_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.commands.pull');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id);
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  if p_pinned_version < 1 or p_pinned_version > e.version then
    raise exception 'pinned version % is not a version of this entity', p_pinned_version
      using errcode = '22023';
  end if;

  insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
  values (e.space_id, actor, p_entity_id, 'pulled',
          jsonb_build_object('localId', p_local_id, 'pinnedVersion', p_pinned_version,
                             'pulledAt', now()), actor)
  on conflict (src_id, dst_id, type) do update set props = excluded.props, updated_at = now()
  returning id into edge_id;
  return internal.ledger_record(p_client_mutation_id, 'entities.commands.pull',
           internal.command_result(p_entity_id, edge_id,
             internal.record_activity(e.space_id, p_entity_id, actor, 'pulled', edge_id,
               jsonb_build_object('pinnedVersion', p_pinned_version)), array[p_entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 11. Read state: read marks, unread counts, inbox.
-- -----------------------------------------------------------------------------
create or replace function public.mark_read(p_anchor_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  member_id uuid;
  marked timestamptz := now();
begin
  perform internal.ledger_replay(p_client_mutation_id, 'readMarks.upsert');
  e := internal.live_entity(p_anchor_id);
  perform internal.require_space_member(e.space_id);
  member_id := internal.current_member_id(e.space_id);
  insert into public.read_marks(member_id, anchor_id, last_read_at)
  values (member_id, p_anchor_id, marked)
  on conflict (member_id, anchor_id) do update set last_read_at = excluded.last_read_at;
  -- Reading the thing the notification pointed at IS reading the notification.
  update public.notifications set read_at = coalesce(read_at, marked)
   where recipient_member_id = member_id and target_entity_id = p_anchor_id and read_at is null;
  return internal.ledger_record(p_client_mutation_id, 'readMarks.upsert',
           jsonb_build_object('anchorId', p_anchor_id, 'lastReadAt', marked, 'patches', '[]'::jsonb));
end
$$;

-- Unread counts for every anchor the caller can see, in ONE call — this powers
-- channel badges and the navigation total together. The comparison rides the
-- uuidv7 primary key (04 §3) instead of a timestamp column.
create or replace function public.unread_counts(p_space_id uuid)
returns table(anchor_id uuid, unread integer)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  with me as (select internal.current_member_id(p_space_id) as member_id)
  select m.anchor_id, count(*)::integer as unread
    from public.messages m
    join public.entities me_entity on me_entity.id = m.entity_id and me_entity.deleted_at is null
    join public.entities anchor on anchor.id = m.anchor_id and anchor.space_id = p_space_id
    left join public.read_marks r
      on r.anchor_id = m.anchor_id and r.member_id = (select member_id from me)
   where internal.is_space_member(p_space_id)
     and m.author_id is distinct from (select member_id from me)
     and (r.last_read_at is null or m.entity_id > internal.uuid_at(r.last_read_at))
   group by m.anchor_id
$$;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare n public.notifications;
begin
  perform internal.require_identity();
  update public.notifications set read_at = coalesce(read_at, now())
   where id = p_notification_id
     and exists (select 1 from public.members m
                  where m.entity_id = notifications.recipient_member_id
                    and m.identity_id = internal.identity_id())
  returning * into n;
  if n.id is null then
    raise exception 'notification not found' using errcode = 'P0002';
  end if;
  return to_jsonb(n);
end
$$;

-- -----------------------------------------------------------------------------
-- 12. Execution (R16/R29) — the graph side of the spawn loop.
--
-- `work_session` is excluded from entities.create by the contract: a session is
-- born HERE and nowhere else (S10), so RLS, the concurrency cap and the command
-- ledger see every spawn that has ever happened.
-- -----------------------------------------------------------------------------
create or replace function public.execution_spawn(
  p_space_id uuid, p_team_member_id uuid, p_task_ids uuid[] default '{}'::uuid[],
  p_project_id uuid default null, p_workdir_mode text default 'project',
  p_workdir_path text default null, p_base_ref text default null,
  p_mode text default null, p_model text default null, p_agent_tool text default null,
  p_title text default null, p_node_id text default null,
  p_confirm_untrusted boolean default false, p_session_cap integer default 8,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  persona public.entities;
  project public.projects;
  session_id uuid;
  task_id uuid;
  patches uuid[];
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.spawn');
  if replay is not null then
    return replay || jsonb_build_object('__tm8_replayed', true);
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  -- The persona must be one this identity may act as: spawning an agent is
  -- speaking as it (T-L7).
  persona := internal.live_entity(p_team_member_id, 'team_member');
  if persona.space_id <> p_space_id then
    raise exception 'persona belongs to another space' using errcode = '22023';
  end if;
  if not internal.can_act_as(p_team_member_id, p_space_id) then
    raise exception 'not permitted to spawn this persona' using errcode = '42501';
  end if;

  -- Governance cap (S10): refuse loudly at capacity, never queue silently.
  -- 53400 → limit_exceeded (429), retryable once a session exits.
  if internal.live_work_session_count(null) >= greatest(coalesce(p_session_cap, 8), 1) then
    raise exception 'session concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_session_cap,
                                  'live', internal.live_work_session_count(null))::text;
  end if;

  if p_project_id is not null then
    select * into project from public.projects where id = p_project_id;
    if project.id is null then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    if not exists (select 1 from public.space_projects
                    where space_id = p_space_id and project_id = p_project_id) then
      raise exception 'project is not linked to this space' using errcode = '42501';
    end if;
    -- S12: trust is informed consent, and consent has to be given per spawn.
    if project.trust = 'untrusted' and not coalesce(p_confirm_untrusted, false) then
      raise exception 'spawning into an untrusted project requires explicit confirmation'
        using errcode = '42501',
              detail = jsonb_build_object('projectId', p_project_id, 'trust', project.trust)::text;
    end if;
  elsif coalesce(p_workdir_mode, 'project') = 'worktree' then
    raise exception 'worktree mode requires a project' using errcode = '22023';
  end if;

  session_id := internal.create_envelope(p_space_id, 'work_session', actor, null, null);
  insert into public.work_sessions(entity_id, title, node_id, project_id, workdir_mode,
                                   workdir_path, base_ref, status, agent_tool, model, mode)
  values (session_id, coalesce(p_title, ''), p_node_id, p_project_id,
          coalesce(p_workdir_mode, 'project'), p_workdir_path, p_base_ref,
          'spawning', p_agent_tool, p_model, p_mode);

  patches := array[session_id];
  foreach task_id in array coalesce(p_task_ids, '{}'::uuid[]) loop
    perform internal.live_entity(task_id, 'task');
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, session_id, task_id, 'working_on', actor)
    on conflict (src_id, dst_id, type) do nothing;
    patches := patches || task_id;
  end loop;
  -- Attribution: the session belongs to the persona that runs in it.
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (p_space_id, session_id, p_team_member_id, 'relates_to', actor)
  on conflict (src_id, dst_id, type) do nothing;

  return internal.ledger_record(p_client_mutation_id, 'execution.spawn',
           internal.command_result(session_id, null,
             internal.record_activity(p_space_id, session_id, actor, 'created', null,
               jsonb_build_object('kind', 'work_session', 'teamMemberId', p_team_member_id)),
             patches)) || jsonb_build_object('__tm8_replayed', false);
end
$$;

-- R29: THE single writer of work_session.status. The table trigger refuses any
-- other path, so "who moved this session to failed" always has one answer.
create or replace function public.work_session_transition(
  p_session_id uuid, p_status text, p_exit_code integer default null,
  p_error text default null, p_transcript_doc_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  current_status text;
  allowed boolean;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.transition');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  if p_status not in ('spawning','running','idle','exited','failed') then
    raise exception 'invalid work_session status: %', p_status using errcode = '22023';
  end if;

  select status into current_status from public.work_sessions where entity_id = p_session_id for update;
  -- Terminal states are terminal. A late frame from a dead PTY must not
  -- resurrect a session that already produced its transcript.
  allowed := case
    when current_status = p_status then true
    when current_status in ('exited','failed') then false
    when p_status = 'spawning' then false
    else true end;
  if not allowed then
    raise exception 'illegal work_session transition % -> %', current_status, p_status
      using errcode = '23514';
  end if;

  perform set_config('tm8.work_session_transition', 'on', true);
  update public.work_sessions
     set status = p_status,
         exit_code = coalesce(p_exit_code, exit_code),
         error = coalesce(p_error, error),
         transcript_doc_id = coalesce(p_transcript_doc_id, transcript_doc_id),
         started_at = case when p_status = 'running' then coalesce(started_at, now()) else started_at end,
         exited_at = case when p_status in ('exited','failed') then coalesce(exited_at, now()) else exited_at end
   where entity_id = p_session_id;
  perform set_config('tm8.work_session_transition', 'off', true);

  -- Status is detail-table state, but durable UI events project from entity
  -- envelope changes. Advance the envelope so running/exited/failed is emitted
  -- through the ordinary entity.upsert sequence instead of requiring a poll.
  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_session_id;

  return internal.ledger_record(p_client_mutation_id, 'execution.transition',
           internal.command_result(p_session_id, null, null, array[p_session_id]));
end
$$;

create or replace function public.record_session_manifest(
  p_session_id uuid, p_manifest jsonb, p_env_var_names text[] default '{}'::text[]
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare e public.entities;
begin
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  insert into public.session_manifests(work_session_id, manifest, env_var_names)
  values (p_session_id, p_manifest, coalesce(p_env_var_names, '{}'::text[]))
  on conflict (work_session_id) do update
    set manifest = excluded.manifest, env_var_names = excluded.env_var_names;
  return jsonb_build_object('workSessionId', p_session_id);
end
$$;

-- execution.streams.attach — the graph authorises, and returns a GRANT. Bytes
-- never pass through here (T-L10). `drive` is owner-only in v1 (S14).
create or replace function public.grant_stream_attach(
  p_session_id uuid, p_mode text default 'view', p_token_hash text default null,
  p_ttl interval default interval '15 minutes', p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  session public.work_sessions;
  identity text;
  grant_row public.stream_grants;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.streams.attach');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  identity := internal.identity_id();
  select * into session from public.work_sessions where entity_id = p_session_id;
  if p_mode not in ('view','drive') then
    raise exception 'invalid stream mode' using errcode = '22023';
  end if;

  -- view: space share mode or explicit membership in the space.
  if session.share_mode = 'none' and e.created_by is distinct from internal.current_member_id(e.space_id)
     and not internal.can_act_as(e.created_by, e.space_id) then
    raise exception 'this session is not shared' using errcode = '42501';
  end if;
  -- drive: input into somebody's live shell. v1 grants it to the spawner only.
  if p_mode = 'drive' and not internal.can_act_as(e.created_by, e.space_id) then
    raise exception 'drive access is limited to the spawning owner in v1' using errcode = '42501';
  end if;

  insert into public.stream_grants(work_session_id, subject_identity, mode, granted_by,
                                   token_hash, expires_at)
  values (p_session_id, identity, p_mode, e.created_by, p_token_hash,
          now() + coalesce(p_ttl, interval '15 minutes'))
  on conflict (work_session_id, subject_identity, mode) where revoked_at is null
  do update set token_hash = excluded.token_hash, expires_at = excluded.expires_at
  returning * into grant_row;

  return internal.ledger_record(p_client_mutation_id, 'execution.streams.attach',
           jsonb_build_object('grant', to_jsonb(grant_row) - 'token_hash', 'patches', '[]'::jsonb));
end
$$;

-- execution.prompt / execution.terminate deliver into a live PTY: their EFFECT
-- is not graph state (R17). What the graph owes them is an audit row, which the
-- ledger already is — this records the intent and returns the session.
create or replace function public.record_execution_command(
  p_session_id uuid, p_operation text, p_payload jsonb default '{}'::jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
begin
  if p_operation not in ('execution.prompt','execution.terminate') then
    raise exception 'unsupported execution command: %', p_operation using errcode = '22023';
  end if;
  replay := internal.ledger_replay(p_client_mutation_id, p_operation);
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  return internal.ledger_record(p_client_mutation_id, p_operation,
           internal.command_result(p_session_id, null, null, array[p_session_id]));
end
$$;

create or replace function public.open_session_modal(
  p_session_id uuid, p_kind text, p_prompt jsonb default '{}'::jsonb,
  p_expires_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  modal public.session_modals;
begin
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  insert into public.session_modals(work_session_id, space_id, kind, prompt, expires_at)
  values (p_session_id, e.space_id, p_kind, coalesce(p_prompt, '{}'::jsonb), p_expires_at)
  returning * into modal;
  return to_jsonb(modal);
end
$$;

create or replace function public.answer_session_modal(p_modal_id uuid, p_response jsonb)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare modal public.session_modals;
begin
  select * into modal from public.session_modals where id = p_modal_id for update;
  if modal.id is null then
    raise exception 'modal not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(modal.space_id);
  if modal.status <> 'open' then
    raise exception 'modal is already %', modal.status using errcode = '23514';
  end if;
  update public.session_modals
     set status = 'answered', response = coalesce(p_response, '{}'::jsonb), answered_at = now()
   where id = p_modal_id
  returning * into modal;
  return to_jsonb(modal);
end
$$;

-- -----------------------------------------------------------------------------
-- 13. Compound reads.
--
-- SECURITY INVOKER, every one of them: a definer read here would hand tm8_app
-- every space in the database and silently make RLS decorative. Views carry
-- `security_invoker = true` for the same reason.
-- -----------------------------------------------------------------------------

-- The subtree walk boards, doc navigation, the composer and delete_entity all
-- reuse. Depth-capped so a pathological tree cannot become an unbounded scan.
create or replace function public.entity_tree(p_root_id uuid, p_max_depth integer default 10)
returns table(id uuid, parent_id uuid, kind text, depth integer, path uuid[], sort_position double precision)
language sql stable set search_path = public, internal, pg_temp as $$
  with recursive tree(id, parent_id, kind, depth, path, sort_position) as (
    select e.id, e.parent_id, e.kind, 0, array[e.id], e.position
      from public.entities e
     where e.id = p_root_id and e.deleted_at is null
    union all
    select child.id, child.parent_id, child.kind, t.depth + 1, t.path || child.id, child.position
      from public.entities child
      join tree t on child.parent_id = t.id
     where child.deleted_at is null
       and t.depth < greatest(coalesce(p_max_depth, 10), 0)
       and not child.id = any (t.path)
  )
  select id, parent_id, kind, depth, path, sort_position from tree order by depth, sort_position, id
$$;

-- The points ledger, grouped and ranked. The ledger is the truth; the counter is
-- a cache — so the leaderboard reads the ledger.
create or replace function public.leaderboard(p_space_id uuid, p_limit integer default 50)
returns table(actor_id uuid, kind text, score bigint, rank bigint)
language sql stable set search_path = public, internal, pg_temp as $$
  select e.id as actor_id, e.kind, coalesce(sum(p.amount), 0)::bigint as score,
         rank() over (order by coalesce(sum(p.amount), 0) desc)::bigint as rank
    from public.entities e
    left join public.point_events p on p.entity_id = e.id
   where e.space_id = p_space_id
     and e.kind in ('member','team_member')
     and e.deleted_at is null
   group by e.id, e.kind
   order by score desc, e.id
   limit greatest(coalesce(p_limit, 50), 1)
$$;

-- Open tasks with no unresolved hard dependency — backs the readyToPull home
-- preset and the agent's "what can I pull" question (01 §5.2).
create or replace function public.ready_to_work(p_space_id uuid)
returns table(entity_id uuid, title text, priority text, work_status text, due_date date, sort_position double precision)
language sql stable set search_path = public, internal, pg_temp as $$
  select t.entity_id, t.title, t.priority, t.work_status, t.due_date, e.position
    from public.tasks t
    join public.entities e on e.id = t.entity_id
   where e.space_id = p_space_id
     and e.deleted_at is null
     and t.work_status in ('open','pulled')
     and not exists (
       select 1 from public.edges dep
        where dep.src_id = t.entity_id
          and dep.type = 'depends_on'
          and coalesce((dep.props ->> 'hard')::boolean, true)
          and not internal.is_resolved(dep.dst_id)
     )
   order by
     case t.priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
     t.due_date nulls last, e.position, t.entity_id
$$;

revoke all on all functions in schema internal from public;
revoke all on all functions in schema public from public;

reset role;
