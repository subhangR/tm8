-- =============================================================================
-- 101 — the control plane (2026-08-11).
--
-- Creating a user becomes ONE operation that provisions the whole user: an
-- account, THEIR OWN SPACE, and the record of the home their agents will
-- eventually run in. Today `public.ensure_account` (007:150) inserts a profile
-- row and an account row and stops — no space, no member row — so a provisioned
-- person logs in and the UI says "No spaces on this node". On this very node,
-- `ramu` has an account and zero memberships and has been in that state since
-- the account was made.
--
-- WHAT THIS MIGRATION IS NOT. It touches no filesystem and creates no OS user.
-- `user_homes` records the home a user WILL have, in state `db_ready`, and the
-- node drives it forward later. That split is deliberate: provisioning spans
-- Postgres, the filesystem and /etc/passwd, and only one of those can roll
-- back, so it is a durable state machine and not a transaction pretending to be
-- one. Phase 1 is the half that IS transactional.
--
-- FOUR PIECES:
--   A. capabilities — `node_admin` stops being one bundle of 18 RPCs
--   B. `internal.create_space_for` — create a space for SOMEONE ELSE, safely
--   C. `provision_user` — the atomic Phase-A transaction
--   D. the backfill, so the eight accounts already here get what new ones get
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- A. Capabilities.
--
-- `internal.require_node_admin()` gates EIGHTEEN RPCs, and the set spans
-- "register a working directory" and "reset any account's password" with no
-- distinction between them. That is why seven of the eight accounts on this
-- node hold `is_node_admin`: connecting a folder needs it, so onboarding a
-- teammate meant granting it, and the grant carried account takeover along for
-- the ride. A coarse capability manufactured a privilege-inflation policy.
--
-- The capabilities below are named individually so a grant can be narrow. This
-- migration only ESTABLISHES them and backfills the current admins to the full
-- set — no RPC changes its guard here, so nothing can break. Re-pointing the
-- eighteen guards and revoking the five unnecessary admins is a later step,
-- deliberately separate: de-escalating before the narrow grants exist would
-- just break onboarding again and teach everyone that the flag is necessary.
-- -----------------------------------------------------------------------------
create table public.account_capabilities (
  account_id uuid not null references public.accounts(id) on delete cascade,
  capability text not null check (capability in (
    'users.provision',        -- create a user: account + space + home
    'users.credentials',      -- reset ANOTHER account's password  ← TAKEOVER
    'users.suspend',          -- disable/enable, revoke sessions
    'users.delete',           -- deprovision
    'projects.register',      -- register a project inside MY OWN home
    'projects.register.any',  -- ... anywhere on the node
    'connections.manage',     -- local server connections
    'node.maintain',          -- prune sessions, sweep upload slots
    'capabilities.grant'      -- grant/revoke capabilities
  )),
  granted_by uuid references public.accounts(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (account_id, capability)
);
create index account_capabilities_capability_idx on public.account_capabilities(capability);

comment on table public.account_capabilities is
  'Named node-level capabilities. Replaces accounts.is_node_admin, which bundles '
  'account takeover with project registration in one flag (see 101 section A).';

-- Table-resolved, like every other authority predicate in this schema.
--
-- The `is_node_admin` arm is a TRANSITIONAL implication, not a permanent one:
-- it keeps every existing admin working while no guard has moved yet, and the
-- de-escalation step removes it so `account_capabilities` becomes the whole
-- truth. `is_owner` implies everything permanently — a node has exactly one
-- owner (002:63) and it is the account of last resort.
create or replace function internal.has_capability(p_capability text) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null and exists (
    select 1 from public.accounts a
     where a.identity_id = internal.identity_id()
       and a.status = 'active'
       and (
         a.is_owner
         or a.is_node_admin        -- TRANSITIONAL. Removed at de-escalation.
         or exists (select 1 from public.account_capabilities c
                     where c.account_id = a.id and c.capability = p_capability)
       )
  )
$$;

create or replace function internal.require_capability(p_capability text) returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_identity();
  if not internal.has_capability(p_capability) then
    -- One message shape for every capability, naming the capability so an
    -- operator can act on it. The capability name is not a secret: knowing that
    -- `users.provision` exists tells you nothing about who holds it.
    raise exception 'capability required: %', p_capability using errcode = '42501';
  end if;
end
$$;

grant execute on function internal.has_capability(text) to tm8_app;

create policy account_capabilities_select on public.account_capabilities for select to tm8_app
  using (internal.has_capability('capabilities.grant')
         or exists (select 1 from public.accounts a
                     where a.id = account_capabilities.account_id
                       and a.identity_id = internal.identity_id()));
alter table public.account_capabilities enable row level security;
grant select on public.account_capabilities to tm8_app;

-- -----------------------------------------------------------------------------
-- B. Space creation for another identity.
--
-- `public.create_space` (015:1731) mints the CALLER's member row via
-- `internal.require_identity()`. The control plane has to create a space for
-- somebody else, and there are two ways to get there. The wrong one is for the
-- server to bind the new user's `identityId` claim in TypeScript and call the
-- public RPC — that puts a working impersonation primitive one refactor away
-- from every handler in the facade. The right one is a named function in
-- `internal`, which 008:250-252 leaves ungranted by default, so it is not
-- reachable by `tm8_app` at all.
--
-- The body below is 015's, moved verbatim. `public.create_space` becomes a
-- one-line caller, so `spaces.create` behaves identically — including its
-- ledger replay, which stays in the public wrapper because `provision_user`
-- carries its own durable idempotency and must not record a second ledger row.
-- -----------------------------------------------------------------------------
create or replace function internal.create_space_for(
  p_identity text, p_name text, p_description text default '',
  p_visibility text default 'private', p_github_repo text default null
) returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare
  space_id uuid := internal.new_id();
  member_id uuid := internal.new_id();
  channel_id uuid := internal.new_id();
  profile public.user_profiles;
begin
  if p_identity is null or btrim(p_identity) = '' then
    raise exception 'an identity is required to create a space' using errcode = '22023';
  end if;
  if coalesce(p_visibility, 'private') not in ('private','public') then
    raise exception 'invalid space visibility' using errcode = '22023';
  end if;

  select * into profile from public.user_profiles where identity_id = p_identity;
  if profile.identity_id is null then
    insert into public.user_profiles(identity_id) values (p_identity) returning * into profile;
  end if;
  insert into public.spaces(id, name, description, github_repo, visibility, created_by_identity)
  values (space_id, p_name, coalesce(p_description, ''), p_github_repo,
          coalesce(p_visibility, 'private'), p_identity);
  insert into public.entities(id, space_id, kind, created_by)
  values (member_id, space_id, 'member', member_id);
  insert into public.members(entity_id, space_id, identity_id, role, display_name)
  values (member_id, space_id, p_identity, 'owner', profile.display_name);
  insert into public.entities(id, space_id, kind, created_by)
  values (channel_id, space_id, 'channel', member_id);
  insert into public.channels(entity_id, space_id, name, topic)
  values (channel_id, space_id, 'general', 'General collaboration');

  perform internal.w1_set_writer('space_settings');
  update public.spaces set default_channel_id = channel_id where id = space_id;
  perform internal.w1_set_writer(null);
  insert into public.space_menu_configs(space_id, schema_version, revision, payload)
  values (space_id, 1, 1, internal.w1_default_menu_payload());
  insert into public.task_axes(space_id, name, axis_values, kind, position)
  values (space_id, 'type', array['default','code','design','review','test'], 'default', 0);
  perform internal.record_activity(space_id, member_id, member_id, 'joined',
            null, jsonb_build_object('role', 'owner'));

  return jsonb_build_object(
    'space', (select to_jsonb(s) from public.spaces s where s.id = space_id),
    'memberId', member_id,
    'defaultChannelId', channel_id)
    || jsonb_build_object('patches', jsonb_build_array(internal.command_entity(channel_id),
                                                       internal.command_entity(member_id)));
end
$$;

create or replace function public.create_space(
  p_name text, p_description text default '', p_visibility text default 'private',
  p_github_repo text default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.create');
  if replay is not null then return replay; end if;
  result := internal.create_space_for(
    internal.require_identity(), p_name, p_description, p_visibility, p_github_repo);
  return internal.ledger_record(p_client_mutation_id, 'spaces.create', result);
end
$$;

-- The same extraction for account creation, and for the same reason: the F1
-- guard (claim-free ONLY while the node has zero accounts) belongs to the
-- PUBLIC entry point, while `provision_user` runs its own guard and then needs
-- the row-writing half without a second authorization check.
create or replace function internal.ensure_account_row(
  p_identity_id text, p_username text, p_display_name text default null,
  p_email text default null, p_is_owner boolean default false,
  p_is_node_admin boolean default false,
  p_password_algorithm text default null, p_password_hash text default null
) returns public.accounts language plpgsql set search_path = public, internal, pg_temp as $$
declare a public.accounts;
begin
  select * into a from public.accounts
   where identity_id = p_identity_id or lower(username) = lower(btrim(p_username));
  if a.id is not null then
    return a;
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
  return a;
end
$$;

create or replace function public.ensure_account(
  p_identity_id text, p_username text, p_display_name text default null,
  p_email text default null, p_is_owner boolean default false,
  p_is_node_admin boolean default false,
  p_password_algorithm text default null, p_password_hash text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare a public.accounts;
begin
  -- F1 (unchanged, and load-bearing): claim-free ONLY while the node has zero
  -- accounts — that is the first-run case. From the second account onward this
  -- is node-admin-only, or an unauthenticated caller could mint itself one.
  if exists (select 1 from public.accounts) then
    if internal.identity_id() is null then
      raise exception 'account creation requires an authenticated node admin'
        using errcode = '28000';
    end if;
    perform internal.require_node_admin();
  end if;
  a := internal.ensure_account_row(p_identity_id, p_username, p_display_name, p_email,
                                   p_is_owner, p_is_node_admin,
                                   p_password_algorithm, p_password_hash);
  return to_jsonb(a) - 'password_hash';
end
$$;

-- -----------------------------------------------------------------------------
-- C. The user's own space, and the record of their home.
-- -----------------------------------------------------------------------------

-- Which space IS a person, as opposed to a space they happen to belong to.
-- Nullable and unique: shared spaces (this node has one with seven members)
-- keep working untouched, and nobody can end up with two personal spaces.
alter table public.spaces
  add column personal_for_identity text references public.user_profiles(identity_id);
create unique index spaces_personal_for_identity_idx
  on public.spaces(personal_for_identity) where personal_for_identity is not null;

-- The OS username is derived from a SERIAL, not from the identity id: an
-- identity is `id_<uuid>` at 39 characters and `useradd` caps a name at 32. A
-- serial also survives a rename, which an identity-derived name would not.
create sequence public.user_home_serial start 1;

create table public.user_homes (
  identity_id   text primary key references public.user_profiles(identity_id) on delete cascade,
  -- Durable idempotency. NOT the command ledger: `internal.prune_command_ledger`
  -- (004:152) drops rows after 24 hours, so a retry on day two would re-run a
  -- provisioning the ledger had forgotten and mint a second personal space.
  request_key   text unique,
  serial        integer not null unique,
  os_username   text not null unique check (os_username ~ '^tm8u[0-9]{1,6}$'),
  os_uid        integer unique,
  home_path     text not null unique check (home_path like '/%' and home_path not like '%..%'),
  -- The state machine IS the repair mechanism: whatever step failed, the node
  -- drives forward from where the row says it stopped. There is deliberately no
  -- rollback — auto-undo would mean an account-deletion primitive reachable
  -- from a failure path, which turns "disk full" into "account gone".
  state         text not null default 'db_ready'
                check (state in ('db_ready','fs_ready','ready','failed')),
  -- What was ACHIEVED, never what was requested. A user provisioned before the
  -- privileged helper exists carries 'shared-uid' honestly until repaired.
  isolation     text not null default 'pending'
                check (isolation in ('pending','shared-uid','os-users')),
  quota_backend text,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger user_homes_touch_updated_at before update on public.user_homes
for each row execute function internal.touch_updated_at();

alter table public.user_homes enable row level security;
-- Your own row, or any row if you provision users. `home_path` is not a secret
-- from its owner, and an operator needs the whole list to repair the node.
create policy user_homes_select on public.user_homes for select to tm8_app
  using (identity_id = internal.identity_id()
         or internal.has_capability('users.provision'));
grant select on public.user_homes to tm8_app;

-- The one operation. Account + personal space + home record, one transaction.
create or replace function public.provision_user(
  p_username text,
  p_display_name text default null,
  p_email text default null,
  p_password_algorithm text default null,
  p_password_hash text default null,
  -- Node configuration, supplied by the caller rather than hardcoded here: the
  -- homes root is a property of the machine (TM8_HOMES_ROOT), and a second
  -- opinion about it living in the schema is how the two drift.
  p_homes_root text default '/srv/tm8/homes',
  p_request_key text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  account public.accounts;
  home public.user_homes;
  new_identity text;
  next_serial integer;
  space_result jsonb;
  space_id uuid;
  replayed jsonb;
begin
  -- The same first-run hole `ensure_account` carries, for the same reason: on a
  -- virgin node nobody can be authenticated yet. From the second account on, a
  -- capability is required.
  if exists (select 1 from public.accounts) then
    if internal.identity_id() is null then
      raise exception 'provisioning a user requires an authenticated operator'
        using errcode = '28000';
    end if;
    perform internal.require_capability('users.provision');
  end if;

  if p_username is null or btrim(p_username) = '' then
    raise exception 'username is required' using errcode = '22023';
  end if;
  if p_homes_root is null or p_homes_root not like '/%' or p_homes_root like '%..%' then
    raise exception 'homes root must be an absolute path with no parent traversal'
      using errcode = '22023';
  end if;

  -- Durable replay. Returns the ORIGINAL result forever, not for 24 hours.
  if p_request_key is not null then
    select * into home from public.user_homes where request_key = p_request_key;
    if home.identity_id is not null then
      select * into account from public.accounts where identity_id = home.identity_id;
      select id into space_id from public.spaces where personal_for_identity = home.identity_id;
      return jsonb_build_object(
        'account', to_jsonb(account) - 'password_hash',
        'home', to_jsonb(home),
        'spaceId', space_id,
        'replayed', true);
    end if;
  end if;

  -- An existing username returns the existing account rather than raising, so
  -- detect that by identity and refuse rather than hand back someone else's.
  new_identity := 'id_' || gen_random_uuid()::text;
  account := internal.ensure_account_row(
    new_identity, p_username, p_display_name, p_email,
    false,  -- provisioning never mints an owner
    false,  -- and never a node admin: capabilities are granted explicitly
    p_password_algorithm, p_password_hash);
  if account.identity_id is distinct from new_identity then
    raise exception 'an account with this username already exists'
      using errcode = '23505';
  end if;

  next_serial := nextval('public.user_home_serial');

  space_result := internal.create_space_for(
    new_identity,
    coalesce(nullif(btrim(p_display_name), ''), p_username) || '''s Space',
    'Personal space', 'private', null);
  space_id := (space_result -> 'space' ->> 'id')::uuid;
  update public.spaces set personal_for_identity = new_identity where id = space_id;

  insert into public.user_homes(identity_id, request_key, serial, os_username, home_path)
  values (new_identity, p_request_key, next_serial,
          'tm8u' || next_serial::text,
          p_homes_root || '/tm8u' || next_serial::text)
  returning * into home;

  -- Every provisioned user can register a project in their own home. THIS is
  -- the de-escalation lever: the reason seven accounts hold node admin is that
  -- registering a project required it, so once this is a default grant nobody
  -- needs the flag to onboard and revoking it costs nothing.
  insert into public.account_capabilities(account_id, capability, granted_by)
  values (account.id, 'projects.register',
          (select id from public.accounts where identity_id = internal.identity_id()))
  on conflict do nothing;

  return jsonb_build_object(
    'account', to_jsonb(account) - 'password_hash',
    'home', to_jsonb(home),
    'spaceId', space_id,
    'replayed', false);
end
$$;

-- The node reporting what it managed to do. Phase 1 never calls this with
-- anything but 'shared-uid'; it exists now so the state machine is complete
-- rather than retrofitted.
create or replace function public.set_user_home_state(
  p_identity_id text, p_state text, p_os_uid integer default null,
  p_isolation text default null, p_quota_backend text default null,
  p_last_error text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare home public.user_homes;
begin
  perform internal.require_capability('users.provision');
  update public.user_homes
     set state = p_state,
         os_uid = coalesce(p_os_uid, os_uid),
         isolation = coalesce(p_isolation, isolation),
         quota_backend = coalesce(p_quota_backend, quota_backend),
         -- Cleared on any non-failed state so a repaired row stops carrying the
         -- error that no longer describes it.
         last_error = case when p_state = 'failed' then p_last_error else null end
   where identity_id = p_identity_id
  returning * into home;
  if home.identity_id is null then
    raise exception 'no home record for this identity' using errcode = 'P0002';
  end if;
  return to_jsonb(home);
end
$$;

-- Capability administration.
create or replace function public.grant_account_capability(
  p_account_id uuid, p_capability text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare granter public.accounts; target public.accounts;
begin
  perform internal.require_identity();
  select * into granter from public.accounts where identity_id = internal.identity_id();
  select * into target from public.accounts where id = p_account_id;
  if target.id is null then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  -- Only the owner may hand out the two capabilities that can be used to take
  -- the node: the right to grant rights, and the right to reset any password.
  if p_capability in ('capabilities.grant','users.credentials') then
    if not coalesce(granter.is_owner, false) then
      raise exception 'only the node owner may grant %', p_capability using errcode = '42501';
    end if;
  else
    perform internal.require_capability('capabilities.grant');
  end if;
  -- No self-grant, ever. An operator who could widen themselves makes every
  -- other guard here decorative.
  if target.id = granter.id then
    raise exception 'an account may not grant itself a capability' using errcode = '42501';
  end if;

  insert into public.account_capabilities(account_id, capability, granted_by)
  values (p_account_id, p_capability, granter.id)
  on conflict (account_id, capability) do nothing;
  return jsonb_build_object('accountId', p_account_id, 'capability', p_capability);
end
$$;

create or replace function public.revoke_account_capability(
  p_account_id uuid, p_capability text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare remaining integer;
begin
  perform internal.require_identity();
  if p_capability in ('capabilities.grant','users.credentials') then
    if not exists (select 1 from public.accounts
                    where identity_id = internal.identity_id() and is_owner) then
      raise exception 'only the node owner may revoke %', p_capability using errcode = '42501';
    end if;
  else
    perform internal.require_capability('capabilities.grant');
  end if;

  delete from public.account_capabilities
   where account_id = p_account_id and capability = p_capability;

  -- Make the locked-out state unrepresentable rather than documented — the same
  -- move `accounts_single_owner_idx` (002:63) makes for the owner.
  if p_capability = 'users.credentials' then
    select count(*) into remaining
      from public.account_capabilities c
      join public.accounts a on a.id = c.account_id
     where c.capability = 'users.credentials' and a.status = 'active';
    if remaining = 0 and not exists (select 1 from public.accounts where is_owner and status = 'active') then
      raise exception 'refusing to leave this node with no account able to reset a credential'
        using errcode = '23514';
    end if;
  end if;
  return jsonb_build_object('accountId', p_account_id, 'capability', p_capability);
end
$$;

-- Operator read. Deliberately never selects `password_hash`.
create or replace function public.list_provisioned_users()
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare rows jsonb;
begin
  perform internal.require_capability('users.provision');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.username), '[]'::jsonb)
    into rows
    from (
      select a.id "accountId", a.identity_id "identityId", a.username, a.display_name "displayName",
             a.email, a.status, a.is_owner "isOwner", a.is_node_admin "isNodeAdmin",
             h.os_username "osUsername", h.os_uid "osUid", h.home_path "homePath",
             h.state "homeState", h.isolation, h.quota_backend "quotaBackend", h.last_error "lastError",
             s.id "personalSpaceId", s.name "personalSpaceName",
             coalesce((select jsonb_agg(c.capability order by c.capability)
                         from public.account_capabilities c where c.account_id = a.id),
                      '[]'::jsonb) capabilities
        from public.accounts a
        left join public.user_homes h on h.identity_id = a.identity_id
        left join public.spaces s on s.personal_for_identity = a.identity_id
    ) t;
  return rows;
end
$$;

revoke all on function internal.create_space_for(text, text, text, text, text) from public;
revoke all on function internal.ensure_account_row(text, text, text, text, boolean, boolean, text, text) from public;
revoke all on function public.provision_user(text, text, text, text, text, text, text) from public;
revoke all on function public.set_user_home_state(text, text, integer, text, text, text) from public;
revoke all on function public.grant_account_capability(uuid, text) from public;
revoke all on function public.revoke_account_capability(uuid, text) from public;
revoke all on function public.list_provisioned_users() from public;
grant execute on function public.provision_user(text, text, text, text, text, text, text) to tm8_app;
grant execute on function public.set_user_home_state(text, text, integer, text, text, text) to tm8_app;
grant execute on function public.grant_account_capability(uuid, text) to tm8_app;
grant execute on function public.revoke_account_capability(uuid, text) to tm8_app;
grant execute on function public.list_provisioned_users() to tm8_app;
-- `internal.create_space_for` and `internal.ensure_account_row` are NOT granted.
-- That is the point: creating a space as somebody else is reachable only from a
-- definer function in this file, never from a tm8_app connection.

-- -----------------------------------------------------------------------------
-- D. Backfill — the accounts that are already here.
--
-- Without this the migration ships a promise: new users get a space, existing
-- ones stay as they are, and `ramu` still logs in to "No spaces on this node".
--
-- ADOPTION is conservative on purpose. A space is adopted as someone's personal
-- space only when it has exactly ONE member and that member is the identity who
-- created it. On this node that matches three spaces and provably cannot match
-- the seven-member shared one — which keeps working, untouched, as a shared
-- space. Anyone left without a personal space gets one created.
-- -----------------------------------------------------------------------------
do $backfill$
declare
  rec record;
  next_serial integer;
  space_result jsonb;
  new_space uuid;
begin
  -- 1. Adopt existing single-member self-created spaces.
  update public.spaces s
     set personal_for_identity = s.created_by_identity
   where s.personal_for_identity is null
     and s.created_by_identity is not null
     and (select count(*) from public.members m where m.space_id = s.id) = 1
     and exists (select 1 from public.members m
                  where m.space_id = s.id and m.identity_id = s.created_by_identity)
     -- Never adopt a space for an identity that already has one.
     and not exists (select 1 from public.spaces other
                      where other.personal_for_identity = s.created_by_identity);

  -- 2. Everyone with an account but no personal space gets one, and everyone
  --    gets a home record and the baseline capability.
  for rec in
    select a.id account_id, a.identity_id, a.username, a.display_name, a.is_node_admin
      from public.accounts a
     order by a.created_at
  loop
    if not exists (select 1 from public.spaces where personal_for_identity = rec.identity_id) then
      space_result := internal.create_space_for(
        rec.identity_id,
        coalesce(nullif(btrim(rec.display_name), ''), rec.username) || '''s Space',
        'Personal space', 'private', null);
      new_space := (space_result -> 'space' ->> 'id')::uuid;
      update public.spaces set personal_for_identity = rec.identity_id where id = new_space;
    end if;

    if not exists (select 1 from public.user_homes where identity_id = rec.identity_id) then
      next_serial := nextval('public.user_home_serial');
      insert into public.user_homes(identity_id, serial, os_username, home_path, isolation)
      values (rec.identity_id, next_serial, 'tm8u' || next_serial::text,
              '/srv/tm8/homes/tm8u' || next_serial::text,
              -- Honest: these users' agents share one uid today, and saying
              -- 'pending' would imply work is queued that nothing will do.
              'shared-uid');
    end if;

    insert into public.account_capabilities(account_id, capability)
    values (rec.account_id, 'projects.register')
    on conflict do nothing;

    -- Existing node admins are backfilled to the FULL set, so that when the
    -- transitional `is_node_admin` arm of `has_capability` is removed, nobody
    -- silently loses access they are using today. Narrowing these is the
    -- separate, deliberate de-escalation step.
    if rec.is_node_admin then
      insert into public.account_capabilities(account_id, capability)
      select rec.account_id, c
        from unnest(array['users.provision','users.credentials','users.suspend','users.delete',
                          'projects.register.any','connections.manage','node.maintain']) c
      on conflict do nothing;
    end if;
  end loop;
end
$backfill$;

reset role;
