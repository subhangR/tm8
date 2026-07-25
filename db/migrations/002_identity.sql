-- =============================================================================
-- 002 identity — node-local accounts, bearer sessions, graph-side profiles,
--                members, team_member personas, and the claim-reading helpers
--                every RLS policy and write RPC is keyed on (R1, R2, R6).
--
-- Two layers, deliberately separate:
--   accounts / auth_sessions   node-local authentication (who may connect)
--   user_profiles / members / team_members   the graph's identity surface
-- They meet at ONE value: `identity_id` — opaque, immutable, issued by the
-- identity block (R6). That id is what tm8-server binds into the transaction as
-- the `tm8.identity_id` claim, and it is the only claim with authority.
--
-- There is no client-asserted identity path, no header fallback, and no flag
-- that relaxes any of this. If the claim is unset, every helper answers false.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Graph-side profile — keyed by the opaque identity id (03 §5).
-- -----------------------------------------------------------------------------
create table public.user_profiles (
  identity_id  text primary key check (char_length(btrim(identity_id)) between 1 and 200),
  display_name text,
  avatar       text,
  email        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger user_profiles_touch_updated_at before update on public.user_profiles
for each row execute function internal.touch_updated_at();

-- Deferred from 001: spaces are created by an identity.
alter table public.spaces
  add constraint spaces_created_by_identity_fkey
  foreign key (created_by_identity) references public.user_profiles(identity_id);

-- -----------------------------------------------------------------------------
-- 2. Accounts — node-local credentials (R6).
--
-- Credentials live inline for v1 (Vega's call): one row is the whole story for a
-- single-owner laptop node. `password_hash` is a LOCAL verifier, not a provider
-- secret — S15's "secrets never enter Postgres" is about provider API keys,
-- which live in the OS environment and are injected at spawn time.
-- -----------------------------------------------------------------------------
create table public.accounts (
  id                 uuid primary key default internal.new_id(),
  identity_id        text not null unique check (char_length(btrim(identity_id)) between 1 and 200),
  username           text not null unique check (char_length(btrim(username)) between 1 and 100),
  display_name       text,
  email              text,
  is_node_admin      boolean not null default false,
  is_owner           boolean not null default false,
  status             text not null default 'active' check (status in ('active','disabled')),
  password_algorithm text,
  password_hash      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  disabled_at        timestamptz,
  constraint accounts_disabled_shape check (
    (status = 'active' and disabled_at is null) or (status = 'disabled' and disabled_at is not null)
  )
);
-- T-L7 at the schema level: there is exactly ONE owner account per node, so
-- first-run bootstrap is idempotent by construction rather than by convention.
create unique index accounts_single_owner_idx on public.accounts(is_owner) where is_owner;
create index accounts_identity_idx on public.accounts(identity_id);
-- Logins are matched case-insensitively; the DB agrees with the server's
-- normalisation instead of trusting it.
create unique index accounts_username_lower_idx on public.accounts(lower(username));

create trigger accounts_touch_updated_at before update on public.accounts
for each row execute function internal.touch_updated_at();

-- An identity id is a permanent handle: rows all over the graph point at it by
-- value (members, spaces, activity). Rewriting one would silently re-attribute
-- history, so it is refused outright (R6).
create or replace function internal.guard_identity_immutability() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.identity_id is distinct from old.identity_id then
    raise exception 'identity_id is immutable' using errcode = '23514',
      detail = 'disable the account and issue a new identity instead (R6)';
  end if;
  return new;
end
$$;
create trigger accounts_identity_immutable before update of identity_id on public.accounts
for each row execute function internal.guard_identity_immutability();

-- -----------------------------------------------------------------------------
-- 3. Members and team_member personas.
-- -----------------------------------------------------------------------------
create table public.members (
  entity_id    uuid primary key references public.entities(id) on delete cascade,
  space_id     uuid not null references public.spaces(id) on delete cascade,
  identity_id  text not null references public.user_profiles(identity_id),
  role         text not null default 'member' check (role in ('owner','admin','member')),
  display_name text,
  joined_at    timestamptz not null default now(),
  unique (space_id, identity_id)
);
create index members_identity_idx on public.members(identity_id);
create trigger members_validate_envelope before insert or update of entity_id on public.members
for each row execute function internal.validate_detail_envelope('member');

-- Deferred from 001: a project link is attributed to the member who made it.
alter table public.space_projects
  add constraint space_projects_linked_by_fkey
  foreign key (linked_by) references public.members(entity_id) on delete set null;

-- Agent personas. The org tree is the entity hierarchy (leader = parent);
-- secondary affiliation is a `member_of` edge (03 §3, review §4).
create table public.team_members (
  entity_id           uuid primary key references public.entities(id) on delete cascade,
  owner_member_id     uuid not null references public.members(entity_id) on delete cascade,
  name                text not null check (char_length(btrim(name)) between 1 and 200),
  role                text not null default '',
  identity            text not null default '' check (char_length(identity) <= 200000),
  memories            jsonb not null default '[]'::jsonb check (jsonb_typeof(memories) = 'array'),
  model               text,
  agent_tool          text,
  mode                text check (mode is null or mode in
                        ('worker','coordinator','coordinated-worker','coordinated-coordinator')),
  permission_mode     text,
  capabilities        jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  command_permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(command_permissions) = 'object'),
  avatar              text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index team_members_owner_idx on public.team_members(owner_member_id);
create trigger team_members_validate_envelope before insert or update of entity_id on public.team_members
for each row execute function internal.validate_detail_envelope('team_member');

-- team_member is a versioned kind (01 §5.1): the persona's identity prompt and
-- permissions are content, and changing them is a reviewable event.
create trigger team_members_snapshot_version after update on public.team_members
for each row execute function internal.snapshot_entity_version();

-- A persona must be owned by a member of the SAME space it lives in: ownership is
-- the whole basis of can_act_as, so a cross-space owner would be an escalation.
create or replace function internal.validate_team_member_owner() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare persona_space uuid; owner_space uuid;
begin
  select space_id into persona_space from public.entities where id = new.entity_id;
  select space_id into owner_space from public.members where entity_id = new.owner_member_id;
  if owner_space is null then
    raise exception 'team_member owner must be a member' using errcode = '23503';
  end if;
  if owner_space <> persona_space then
    raise exception 'team_member owner must be a member of the same space' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger team_members_validate_owner
before insert or update of owner_member_id, entity_id on public.team_members
for each row execute function internal.validate_team_member_owner();

-- -----------------------------------------------------------------------------
-- 4. Bearer sessions (S8).
--
-- The token itself is NEVER stored — only its SHA-256. A stolen database gives
-- an attacker no usable credential, and revocation is a row update.
-- -----------------------------------------------------------------------------
create table public.auth_sessions (
  id                       uuid primary key default internal.new_id(),
  account_id               uuid not null references public.accounts(id) on delete cascade,
  kind                     text not null check (kind in ('browser','cli','agent')),
  -- Set for agent sessions: the persona this token may author as. Narrowing
  -- only — it can never widen beyond what can_act_as already allows.
  acting_as_team_member_id uuid references public.team_members(entity_id) on delete set null,
  token_hash               text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  label                    text,
  created_at               timestamptz not null default now(),
  expires_at               timestamptz not null,
  last_used_at             timestamptz,
  revoked_at               timestamptz
);
create index auth_sessions_account_live_idx on public.auth_sessions(account_id) where revoked_at is null;
create index auth_sessions_expiry_idx on public.auth_sessions(expires_at) where revoked_at is null;

comment on table public.auth_sessions is
  'Bearer sessions for non-browser clients (CLI, spawned agents) and the browser '
  'session. token_hash = sha256(token); the plaintext token exists only in the '
  'client and in the manifest env of a spawned agent (S8/S15).';

-- -----------------------------------------------------------------------------
-- 4b. Space invites (01 §2) — the only way a second human joins a private space.
-- -----------------------------------------------------------------------------
create table public.space_invites (
  id         uuid primary key default internal.new_id(),
  space_id   uuid not null references public.spaces(id) on delete cascade,
  code       text not null unique check (char_length(code) between 8 and 100),
  created_by uuid not null references public.members(entity_id) on delete cascade,
  max_uses   integer not null default 1 check (max_uses > 0),
  use_count  integer not null default 0 check (use_count >= 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint space_invites_uses_shape check (use_count <= max_uses)
);
create index space_invites_space_idx on public.space_invites(space_id, created_at desc, id desc);

-- -----------------------------------------------------------------------------
-- 5. The claim-reading authorization helpers (R2).
--
-- These are the ONLY authorization primitives in the schema. Every RLS policy
-- (008) and every write RPC (007) resolves through them. They read exactly one
-- claim with authority — tm8.identity_id — and resolve membership against the
-- tables. The CSV claims (tm8.member_ids, tm8.team_member_ids, tm8.can_act_as)
-- are a server-side fast path and are NEVER trusted here: a compromised or buggy
-- caller cannot widen its own reach by editing a claim.
-- -----------------------------------------------------------------------------
create or replace function internal.is_authenticated() returns boolean
language sql stable set search_path = public, internal, pg_temp as $$
  select exists (
    select 1 from public.accounts a
     where a.identity_id = internal.identity_id() and a.status = 'active'
  )
$$;

create or replace function internal.current_member_id(target_space uuid) returns uuid
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select m.entity_id from public.members m
   where m.space_id = target_space and m.identity_id = internal.identity_id()
$$;

create or replace function internal.is_space_member(target_space uuid) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null and exists (
    select 1 from public.members m
     where m.space_id = target_space and m.identity_id = internal.identity_id()
  )
$$;

create or replace function internal.is_space_admin(target_space uuid) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null and exists (
    select 1 from public.members m
     where m.space_id = target_space
       and m.identity_id = internal.identity_id()
       and m.role in ('owner','admin')
  )
$$;

-- The bound identity may author as: its own member row in the space, or a
-- team_member persona owned by that member row (T-L7).
--
-- Node-admin does NOT widen this. Being able to administer the node is not the
-- same as being able to speak as somebody else's agent, and conflating them is
-- how audit trails start lying.
create or replace function internal.can_act_as(target_actor uuid, target_space uuid) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null and (
    exists (
      select 1 from public.members m
       where m.entity_id = target_actor
         and m.space_id = target_space
         and m.identity_id = internal.identity_id()
    )
    or exists (
      select 1
        from public.team_members tm
        join public.members owner on owner.entity_id = tm.owner_member_id
       where tm.entity_id = target_actor
         and owner.space_id = target_space
         and owner.identity_id = internal.identity_id()
    )
  )
$$;

-- Resolve the effective actor for a write: an explicit RPC argument wins, then
-- the tm8.actor_id / tm8.acting_as claim, then the caller's own member row.
-- Whatever comes out is authorized by can_act_as before it is used.
create or replace function internal.resolve_actor(requested uuid, target_space uuid) returns uuid
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare actor uuid;
begin
  perform internal.require_identity();
  actor := coalesce(requested, internal.actor_id(), internal.current_member_id(target_space));
  if actor is null then
    raise exception 'no actor available in this space' using errcode = '42501';
  end if;
  if not internal.can_act_as(actor, target_space) then
    raise exception 'not permitted to act as this actor' using errcode = '42501';
  end if;
  return actor;
end
$$;

-- Guard pair used at the top of every write RPC: membership first (is the caller
-- in this space at all), then actor authorization. SECURITY DEFINER bypasses
-- RLS, so an RPC that skips these has no protection whatsoever — they are not
-- belt-and-braces, they ARE the belt.
create or replace function internal.require_space_member(target_space uuid) returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_identity();
  if not internal.is_space_member(target_space) then
    raise exception 'not a member of this space' using errcode = '42501';
  end if;
end
$$;

create or replace function internal.require_space_admin(target_space uuid) returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_identity();
  if not internal.is_space_admin(target_space) then
    raise exception 'space admin required' using errcode = '42501';
  end if;
end
$$;

-- Node-level administration (project registry, node-wide maintenance). Distinct
-- from space admin on purpose.
create or replace function internal.require_node_admin() returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_identity();
  if not exists (
    select 1 from public.accounts a
     where a.identity_id = internal.identity_id()
       and a.status = 'active'
       and (a.is_node_admin or a.is_owner)
  ) then
    raise exception 'node admin required' using errcode = '42501';
  end if;
end
$$;

revoke all on all functions in schema internal from public;
revoke all on all functions in schema public from public;

reset role;
