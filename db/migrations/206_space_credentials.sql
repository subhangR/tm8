-- =============================================================================
-- 206 — SPACE CREDENTIALS: agent credentials that belong to a space, not to a
-- member. Design 01a0cfa8 (decisions D1–D12 locked), task SC-1.
--
-- THIS IS THE ONLY MIGRATION THE SPACE-CREDENTIALS EFFORT TAKES. Every table,
-- writer and reader the later lanes (SC-2 launch resolution, SC-3 catalog ops,
-- SC-4, SC-6 containment) need is here, so none of them takes an ordinal. It
-- adds NO operation-catalog row: the catalog belongs to SC-3.
--
-- POSTURE — 093's and 203's, unchanged:
--
--   * RLS: a space member selects the space's rows; a non-member selects none.
--     There is no node-admin bypass.
--   * tm8_app gets a COLUMN-LEVEL select grant that omits secret_ciphertext
--     and secret_nonce, and no insert, update or delete privilege on any table
--     here. Every write is a SECURITY DEFINER RPC.
--   * Management RPCs call internal.require_human_auth_kind() (I2): an agent
--     can USE a space credential by inheritance and can never create, change,
--     rotate, delete or log it in.
--   * secret_ciphertext is AES-256-GCM ciphertext||tag under the node key
--     (<dataDir>/.git-credential.key, 0600, outside Postgres), AAD-bound to
--     <space_id>|<credential_id>|<provider>. Ciphertext moved to another row,
--     another space, or 093/203's tables does not open. key_hint is the last
--     four characters and nothing more (I5).
--   * Status is written only by a probed step (create/rekey after the TS
--     store's vendor probe, login finish, record_space_credential_probe) —
--     never inferred from files on disk (I6).
--
-- WHAT A LATER MIGRATION MUST NOT DO:
--
--   * Re-create public.record_session_manifest from 199's body. 206 folds the
--     session_space_credentials writer into it (M9); 199's body would silently
--     drop the writer. Start from THIS file's body. `space-credentials.pg.test`
--     asserts the manifest path writes the row, so the revert goes red.
--   * Drop or rename credential_sessions_one_live_per_account_provider without
--     keeping its `space_credential_id is null` predicate (section 5).
--   * Re-create public.finish_credential_session (083) without its
--     `space_credential_id is null` predicate: the member finish must never
--     close a space login (section 5).
--   * Raise 55000 for a state refusal. 206 uses 23514 (invariant_violation):
--     55000 is unmapped in SQLSTATE_TO_ERROR_CODE and would surface as a 503.
--   * 206 deliberately does NOT touch public.start_credential_session,
--     internal.is_credential_provider or credential_sessions_provider_check.
--     Open PR #666 (203_grok_credentials) re-creates the latter two; because
--     206 leaves them alone, applying #666 before or after 206 reverts nothing
--     here (advisor M1).
--
-- STABLE SIGNATURES (SC-2, SC-3, SC-6 code against these; changing one is a
-- cross-lane change). "human" = require_human_auth_kind; "member" = caller is a
-- member of the space; "manager" = D11, the credential's creator (still a
-- member) or a space admin/owner. Every function answers jsonb.
--
--   Management (human-only):
--     create_space_credential(p_credential_id uuid, p_space_id uuid,
--         p_provider text, p_shape text, p_label text, p_key_hint text,
--         p_secret_ciphertext bytea, p_secret_nonce bytea,
--         p_display_login text default null)                       member (D1)
--       api_key/token only; the caller chooses the id because the AAD binds
--       it. Becomes the default when the (space, provider) has none.
--     start_space_credential_login(p_space_id uuid, p_provider text,
--         p_label text default null, p_credential_id uuid default null,
--         p_ttl_seconds integer default 900, p_session_cap integer default 2)
--       id null  -> any member; creates a 'pending' login credential.
--       id given -> manager only (re-login onto an existing credential, D11/M4).
--       Opens a credential login terminal exactly as 083 does.
--     finish_space_credential_login(p_work_session_id uuid, p_ok boolean,
--         p_display_login text default null)       the login's own account
--       Locks the credential FOR UPDATE; refuses unless pending/active/stale.
--       Exception: a REVOKED credential with p_ok = false only stamps the
--       terminal finished (no status, default or file change); the opener,
--       the credential's creator or a space admin may do it. This is how the
--       delete path closes a terminal after killing its PTY.
--     rekey_space_credential(p_credential_id uuid, p_key_hint text,
--         p_secret_ciphertext bytea, p_secret_nonce bytea,
--         p_display_login text default null)                 manager (D7/D11)
--     rename_space_credential(p_credential_id uuid, p_label text)   manager
--     set_space_credential_default(p_credential_id uuid)            manager
--     record_space_credential_probe(p_credential_id uuid, p_ok boolean) manager
--     delete_space_credential(p_credential_id uuid)                 manager
--       REVOKES (FOR UPDATE), clears the sealed bytes; the row stays as a
--       tombstone so containment can still find the sessions that used it.
--     set_space_credential_policy(p_space_id uuid, p_provider text,
--         p_allowed_sources text[])            space admin (D5); null resets
--     set_node_credential_policy(p_provider text, p_allow_node boolean)
--                                                          node admin (D5/D9)
--     space_credential_live_sessions(p_credential_id uuid)          manager
--     member_space_credential_sessions(p_space_id uuid, p_account_id uuid)
--             node admin, space admin, or that account itself; a null
--             p_space_id means every space (node admin or self only)
--
--   Spawn path (NOT human-only: agent children inherit, the 093 precedent):
--     read_space_credential_for_spawn(p_launch_space_id uuid,
--         p_provider text, p_credential_id uuid default null)       member
--       The pinned id, or the space default when null. Returns the sealed
--       bytes (api_key/token) or the home key (login) — nothing else. Never a
--       catalog operation (A1).
--     record_session_manifest(...)  — 199's signature, unchanged. Writes one
--       session_space_credentials row per provider whose
--       manifest.launch.credentialSources[provider] = 'space', taking the id
--       from manifest.launch.spaceCredentialIds[provider]. Both maps must
--       agree or the manifest is refused.
--     repoint_session_space_credentials(p_work_session_id uuid)     member
--       Resume (C3): launcher_account_id := the resumer, under a FOR SHARE
--       lock that requires every recorded credential still to be active.
--     read_space_credential_policy(p_space_id uuid)                 member
--     read_node_credential_policy()                            any identity
--     expire_pending_space_credentials()                       tm8_app sweep
--
-- launcher_account_id is ALWAYS internal.current_account_id() under the
-- claims of the call that writes it — the account that minted the (agent)
-- auth session, i.e. the root human launcher. Never team_members'
-- owner_member_id, never entities.created_by (coordinator A3/C2).
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. public.space_credentials
-- -----------------------------------------------------------------------------
create table public.space_credentials (
  id                     uuid primary key default internal.new_id(),
  space_id               uuid not null references public.spaces(id) on delete cascade,
  provider               text not null,
  shape                  text not null,
  label                  text not null,
  is_default             boolean not null default false,
  -- 'pending' is a login that has not finished yet (M3). It is invisible to
  -- the default index, to resolution and to the spawn reader, and
  -- expire_pending_space_credentials removes it once pending_expires_at passes.
  status                 text not null default 'active',
  -- D12: the credential outlives its creator. Account delete nulls this, the
  -- row stays, and only space admins can manage it from then on.
  created_by_account_id  uuid references public.accounts(id) on delete set null,
  created_by_identity_id text,
  display_login          text,
  key_hint               text,
  secret_ciphertext      bytea,
  secret_nonce           bytea,
  pending_expires_at     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  last_used_at           timestamptz,
  last_probe_at          timestamptz,
  constraint space_credentials_provider_check
    check (provider in ('anthropic', 'openai', 'github')),
  constraint space_credentials_shape_check
    check (shape in ('login', 'api_key', 'token')),
  -- GitHub is a PAT (D10); the agent vendors are a login or an API key (D2).
  constraint space_credentials_provider_shape_check
    check ((provider = 'github' and shape = 'token')
        or (provider in ('anthropic', 'openai') and shape in ('login', 'api_key'))),
  constraint space_credentials_status_check
    check (status in ('pending', 'active', 'stale', 'revoked')),
  constraint space_credentials_label_check
    check (char_length(btrim(label)) between 1 and 80),
  constraint space_credentials_display_login_check
    check (display_login is null or char_length(btrim(display_login)) between 1 and 200),
  -- Only a login can be pending, and a pending row always has a deadline.
  constraint space_credentials_pending_check
    check ((status = 'pending') = (pending_expires_at is not null)
       and (status <> 'pending' or shape = 'login')),
  -- A default is a usable credential; pending and revoked never are.
  constraint space_credentials_default_check
    check (not is_default or status in ('active', 'stale')),
  -- A login's secret is a file in its space home, never a column. A string
  -- credential carries its sealed bytes until it is revoked, and none after.
  constraint space_credentials_secret_shape_check
    check (case
      when shape = 'login' then
        secret_ciphertext is null and secret_nonce is null and key_hint is null
      when status = 'revoked' then
        secret_ciphertext is null and secret_nonce is null
      else
        secret_ciphertext is not null and secret_nonce is not null and key_hint is not null
    end),
  constraint space_credentials_hint_check
    check (key_hint is null or char_length(key_hint) between 1 and 4),
  constraint space_credentials_nonce_check
    check (secret_nonce is null or octet_length(secret_nonce) = 12),
  constraint space_credentials_ciphertext_check
    check (secret_ciphertext is null or octet_length(secret_ciphertext) between 17 and 8192),
  -- The target of session_space_credentials' composite foreign key.
  constraint space_credentials_id_space_key unique (id, space_id)
);

comment on table public.space_credentials is
  'Space-owned agent credentials (206, design 01a0cfa8). Secret columns are '
  'AES-256-GCM sealed with a node-filesystem key, AAD <space>|<id>|<provider>, '
  'and are never granted to tm8_app. Read the 206 header before changing a '
  'column, policy, grant or RPC.';

-- D6a: one space default per provider, among ACTIVE credentials.
create unique index space_credentials_one_default_per_provider
  on public.space_credentials(space_id, provider)
  where is_default and status = 'active';

-- A label names one live credential per (space, provider). A revoked row is a
-- tombstone kept for containment; it must not hold its label forever.
create unique index space_credentials_unique_label
  on public.space_credentials(space_id, provider, label)
  where status <> 'revoked';

create index space_credentials_pending_expiry_idx
  on public.space_credentials(pending_expires_at)
  where status = 'pending';

create trigger space_credentials_touch_updated_at
before update on public.space_credentials
for each row execute function internal.touch_updated_at();

alter table public.space_credentials enable row level security;

create policy space_credentials_member_select on public.space_credentials
  for select using (internal.is_space_member(space_id));

grant select (id, space_id, provider, shape, label, is_default, status,
              created_by_account_id, created_by_identity_id, display_login,
              key_hint, pending_expires_at, created_at, updated_at,
              last_used_at, last_probe_at)
  on public.space_credentials to tm8_app;
-- No insert/update/delete grant, and no grant on secret_ciphertext/secret_nonce.

-- -----------------------------------------------------------------------------
-- 2. Policies (D5). Absent row = every source allowed.
-- -----------------------------------------------------------------------------
-- A CHECK cannot hold a subquery, so the set rule is an immutable function.
create or replace function internal.is_credential_source_set(p_sources text[])
returns boolean
language sql immutable parallel safe as $$
  select p_sources is not null
     and cardinality(p_sources) between 1 and 3
     and array_position(p_sources, null) is null
     and p_sources <@ array['member', 'space', 'node']::text[]
     and cardinality(p_sources) = (select count(distinct s) from unnest(p_sources) s)
$$;

create table public.space_credential_policies (
  space_id              uuid not null references public.spaces(id) on delete cascade,
  provider              text not null,
  allowed_sources       text[] not null,
  updated_by_account_id uuid references public.accounts(id) on delete set null,
  updated_at            timestamptz not null default now(),
  primary key (space_id, provider),
  constraint space_credential_policies_provider_check
    check (provider in ('anthropic', 'openai', 'github')),
  -- A11: a non-empty subset of member/space/node, no nulls, no repeats.
  constraint space_credential_policies_sources_check
    check (internal.is_credential_source_set(allowed_sources))
);

alter table public.space_credential_policies enable row level security;
create policy space_credential_policies_member_select on public.space_credential_policies
  for select using (internal.is_space_member(space_id));
grant select (space_id, provider, allowed_sources, updated_by_account_id, updated_at)
  on public.space_credential_policies to tm8_app;

-- The node policy (D5/D9). Absent row = node fallback allowed, today's behaviour.
create table public.node_credential_policies (
  provider              text primary key,
  allow_node            boolean not null,
  updated_by_account_id uuid references public.accounts(id) on delete set null,
  updated_at            timestamptz not null default now(),
  constraint node_credential_policies_provider_check
    check (provider in ('anthropic', 'openai', 'github'))
);

alter table public.node_credential_policies enable row level security;
create policy node_credential_policies_identity_select on public.node_credential_policies
  for select using (internal.identity_id() is not null);
grant select (provider, allow_node, updated_by_account_id, updated_at)
  on public.node_credential_policies to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. session_space_credentials — the D8 record, and what containment queries.
--
-- The SOURCE OF TRUTH for "which space credential did this session launch
-- on". Its only writer is record_session_manifest (M9), so the manifest and
-- this table agree by construction. The composite foreign key makes
-- "the row's space is the credential's space" declarative; the writer adds
-- "and the session's space".
-- -----------------------------------------------------------------------------
create table public.session_space_credentials (
  work_session_id     uuid not null references public.work_sessions(entity_id) on delete cascade,
  provider            text not null,
  space_credential_id uuid not null,
  space_id            uuid not null,
  -- The root human launcher (A6/C2): current_account_id() under the claims of
  -- the spawn — or of the resume, which re-points it (C3).
  launcher_account_id uuid references public.accounts(id) on delete set null,
  recorded_at         timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (work_session_id, provider),
  constraint session_space_credentials_provider_check
    check (provider in ('anthropic', 'openai', 'github')),
  constraint session_space_credentials_credential_fk
    foreign key (space_credential_id, space_id)
    references public.space_credentials(id, space_id) on delete cascade
);

create index session_space_credentials_credential_idx
  on public.session_space_credentials(space_credential_id);
create index session_space_credentials_launcher_idx
  on public.session_space_credentials(space_id, launcher_account_id);

alter table public.session_space_credentials enable row level security;
create policy session_space_credentials_member_select on public.session_space_credentials
  for select using (internal.is_space_member(space_id));
grant select (work_session_id, provider, space_credential_id, space_id,
              launcher_account_id, recorded_at, updated_at)
  on public.session_space_credentials to tm8_app;

-- -----------------------------------------------------------------------------
-- 4. Shared internal helpers. Revoked from public, granted to nobody: only the
--    SECURITY DEFINER functions below call them.
-- -----------------------------------------------------------------------------

-- D11: the creator (while still a member) or a space admin/owner.
create or replace function internal.can_manage_space_credential(p_credential public.space_credentials)
returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.is_space_member(p_credential.space_id)
     and (internal.is_space_admin(p_credential.space_id)
          or (p_credential.created_by_account_id is not null
              and p_credential.created_by_account_id = internal.current_account_id()))
$$;

-- Lock one credential FOR UPDATE and require the caller may manage it. A
-- missing row and a row in a space the caller is not in answer the same way.
create or replace function internal.lock_managed_space_credential(p_credential_id uuid)
returns public.space_credentials
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  select * into stored from public.space_credentials
   where id = p_credential_id for update;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if not internal.can_manage_space_credential(stored) then
    raise exception 'only the credential''s creator or a space admin can change it'
      using errcode = '42501';
  end if;
  return stored;
end
$$;

-- Metadata only (I5): never a secret column.
create or replace function internal.space_credential_json(p public.space_credentials)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', p.id, 'spaceId', p.space_id, 'provider', p.provider, 'shape', p.shape,
    'label', p.label, 'isDefault', p.is_default, 'status', p.status,
    'createdByAccountId', p.created_by_account_id,
    'displayLogin', p.display_login, 'keyHint', p.key_hint,
    'pendingExpiresAt', p.pending_expires_at,
    'createdAt', p.created_at, 'updatedAt', p.updated_at,
    'lastUsedAt', p.last_used_at, 'lastProbeAt', p.last_probe_at)
$$;

-- Make p_credential the default when its (space, provider) has no active one.
create or replace function internal.default_space_credential_if_none(p_credential_id uuid)
returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare target public.space_credentials;
begin
  select * into target from public.space_credentials where id = p_credential_id;
  if target.status <> 'active' then return; end if;
  -- Serialise defaulting per (space, provider) so two first credentials cannot
  -- both see "no default" and both claim it.
  perform pg_advisory_xact_lock(hashtextextended(target.space_id::text || '|' || target.provider, 206));
  if not exists (select 1 from public.space_credentials
                  where space_id = target.space_id and provider = target.provider
                    and is_default and status = 'active') then
    update public.space_credentials set is_default = true where id = p_credential_id;
  end if;
end
$$;

-- Called by every path that makes a credential ACTIVE again (login finish,
-- probe, rekey). A default that went stale keeps is_default (the badge
-- survives staleness), but while it was stale default_space_credential_if_none
-- may have promoted another credential. Repairing the old one must then give
-- up its flag rather than collide with the one-default index. Same advisory
-- lock as default_space_credential_if_none, so the two cannot interleave.
create or replace function internal.prepare_space_credential_activation(p_credential_id uuid)
returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare target public.space_credentials;
begin
  select * into target from public.space_credentials where id = p_credential_id;
  perform pg_advisory_xact_lock(hashtextextended(target.space_id::text || '|' || target.provider, 206));
  if target.is_default and exists (
       select 1 from public.space_credentials
        where space_id = target.space_id and provider = target.provider
          and is_default and status = 'active' and id <> target.id) then
    update public.space_credentials set is_default = false where id = target.id;
  end if;
end
$$;

-- A label is required and trimmed; answer 22023 rather than a raw CHECK.
create or replace function internal.require_space_credential_label(p_label text)
returns text
language plpgsql immutable as $$
begin
  if p_label is null or char_length(btrim(p_label)) not between 1 and 80 then
    raise exception 'a label of 1 to 80 characters is required' using errcode = '22023';
  end if;
  return btrim(p_label);
end
$$;

revoke all on function internal.prepare_space_credential_activation(uuid) from public;
revoke all on function internal.require_space_credential_label(text) from public;
revoke all on function internal.can_manage_space_credential(public.space_credentials) from public;
revoke all on function internal.lock_managed_space_credential(uuid) from public;
revoke all on function internal.space_credential_json(public.space_credentials) from public;
revoke all on function internal.default_space_credential_if_none(uuid) from public;

-- -----------------------------------------------------------------------------
-- 5. credential_sessions learns about space logins.
--
-- 083's one-live-login index was (account_id, provider). A member running a
-- login for a SPACE credential must be able to do so while their own login
-- for the same provider is open, and two logins onto ONE space credential race
-- one config directory exactly as two member logins would. So the index
-- splits in two. The member half KEEPS 083's name: credential-sessions.ts
-- recognises that name in a 23505.
-- -----------------------------------------------------------------------------
alter table public.credential_sessions
  add column space_credential_id uuid references public.space_credentials(id) on delete cascade;

comment on column public.credential_sessions.space_credential_id is
  'Null: the member''s own login (083). Set: a login INTO this space credential''s '
  'home (206). Member-login readers (Disconnect, the start-time reclaim) must '
  'filter on space_credential_id is null.';

drop index public.credential_sessions_one_live_per_account_provider;

create unique index credential_sessions_one_live_per_account_provider
  on public.credential_sessions(account_id, provider)
  where finished_at is null and space_credential_id is null;

create unique index credential_sessions_one_live_per_space_credential
  on public.credential_sessions(space_credential_id)
  where finished_at is null and space_credential_id is not null;

grant select (space_credential_id) on public.credential_sessions to tm8_app;

-- 083's member finish, re-created with ONE change: it never closes a login
-- INTO a space credential (`and space_credential_id is null`). The member
-- path probes the member's own home and records a member credential; a space
-- login is finished only by finish_space_credential_login, which probes the
-- space home and checks the credential's state. A space login id answers
-- exactly as another account's id does (`finished: false`), so the guard
-- holds even if the TypeScript routing sends the wrong id here (SC-4, M5).
-- A later migration re-creating this function must keep the predicate.
create or replace function public.finish_credential_session(p_work_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  stored public.credential_sessions;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  update public.credential_sessions
     set finished_at = now()
   where work_session_id = p_work_session_id
     and account_id = v_account_id
     and finished_at is null
     and space_credential_id is null
  returning * into stored;

  if stored.work_session_id is null then
    -- Either already finished, or not this account's, or a space login. All
    -- answer the same way on purpose: distinguishing them tells a caller
    -- whether someone else's session exists.
    return jsonb_build_object('workSessionId', p_work_session_id, 'finished', false);
  end if;

  return jsonb_build_object(
    'workSessionId', stored.work_session_id,
    'provider', stored.provider,
    'finished', true,
    'finishedAt', stored.finished_at
  );
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Management RPCs (human-only).
-- -----------------------------------------------------------------------------

create or replace function public.create_space_credential(
  p_credential_id uuid,
  p_space_id uuid,
  p_provider text,
  p_shape text,
  p_label text,
  p_key_hint text,
  p_secret_ciphertext bytea,
  p_secret_nonce bytea,
  p_display_login text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_credential_id is null then
    raise exception 'a credential id is required: the seal is bound to it' using errcode = '22023';
  end if;
  -- A login is created by start_space_credential_login, never pasted.
  if p_shape is null or p_shape not in ('api_key', 'token') then
    raise exception 'create_space_credential takes an api_key or token; a login starts with start_space_credential_login'
      using errcode = '22023';
  end if;

  insert into public.space_credentials(
    id, space_id, provider, shape, label, status,
    created_by_account_id, created_by_identity_id, display_login,
    key_hint, secret_ciphertext, secret_nonce, last_probe_at
  ) values (
    p_credential_id, p_space_id, p_provider, p_shape, internal.require_space_credential_label(p_label), 'active',
    v_account_id, internal.identity_id(), nullif(btrim(p_display_login), ''),
    p_key_hint, p_secret_ciphertext, p_secret_nonce, now()
  ) returning * into stored;

  perform internal.default_space_credential_if_none(stored.id);
  select * into stored from public.space_credentials where id = stored.id;
  return internal.space_credential_json(stored);
end
$$;

-- Open a login terminal onto a space credential. Mirrors 183's
-- start_credential_session (the work_session shape, node_id NULL, share_mode
-- 'none', the mirror cap) and adds the credential. It is a separate function
-- on purpose: start_credential_session is re-created by other lanes (#666),
-- and a change folded into it would be reverted by whichever applied last.
create or replace function public.start_space_credential_login(
  p_space_id uuid,
  p_provider text,
  p_label text default null,
  p_credential_id uuid default null,
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
  target public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_provider is null or p_provider not in ('anthropic', 'openai') then
    raise exception 'unsupported space login provider' using errcode = '22023';
  end if;

  v_ttl := least(greatest(coalesce(p_ttl_seconds, 900), 60), 1800);
  if internal.credential_session_count(null) >= greatest(coalesce(p_session_cap, 2), 1) then
    raise exception 'credential session concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_session_cap,
                                  'live', internal.credential_session_count(null))::text;
  end if;
  v_expires_at := now() + make_interval(secs => v_ttl);

  if p_credential_id is null then
    -- A NEW login credential (D1: any member). Pending until finish; the
    -- deadline leaves the finish step a margin past the terminal's own expiry.
    insert into public.space_credentials(
      space_id, provider, shape, label, status, pending_expires_at,
      created_by_account_id, created_by_identity_id
    ) values (
      p_space_id, p_provider, 'login', internal.require_space_credential_label(p_label), 'pending',
      v_expires_at + interval '5 minutes', v_account_id, internal.identity_id()
    ) returning * into target;
  else
    -- A RE-LOGIN onto an existing credential: D11/M4, creator or admin.
    target := internal.lock_managed_space_credential(p_credential_id);
    if target.space_id <> p_space_id or target.provider <> p_provider then
      raise exception 'space credential not found' using errcode = 'P0002';
    end if;
    if target.shape <> 'login' then
      raise exception 'only a login credential can be logged into; rekey an api key instead'
        using errcode = '22023';
    end if;
    if target.status not in ('active', 'stale') then
      raise exception 'space credential is %', target.status using errcode = '23514';
    end if;
  end if;

  v_actor := internal.current_member_id(p_space_id);
  v_session_id := internal.create_envelope(p_space_id, 'work_session', v_actor, null, null);
  insert into public.work_sessions(entity_id, title, status, share_mode, session_kind)
  values (v_session_id, 'Connect ' || p_provider || ' for the space', 'spawning', 'none', 'credential');
  insert into public.credential_sessions(work_session_id, account_id, provider, expires_at, space_credential_id)
  values (v_session_id, v_account_id, p_provider, v_expires_at, target.id);

  return jsonb_build_object(
    'workSessionId', v_session_id,
    'spaceId', p_space_id,
    'provider', p_provider,
    'expiresAt', v_expires_at,
    'credential', internal.space_credential_json(target)
  );
end
$$;

-- Close a space login after the TS service has terminated the PTY and PROBED
-- the space home (I6). p_ok = the probe's verdict.
--
-- Locks the credential FOR UPDATE and refuses unless it is pending, active or
-- stale: a credential deleted while its login ran must not come back to life
-- (M3/M6). 'stale' is admitted because re-login is exactly how a stale login
-- is repaired. Only the account that opened the terminal can finish it.
--
-- One exception (coordinator decision (a), SC-3): on a REVOKED credential,
-- p_ok = false stamps the terminal finished and does nothing else — no status,
-- no default, no file. This is how delete's second step (and anything else
-- that has killed the PTY) closes the terminal. The opener, the credential's
-- creator or a space admin may do it: an admin deleting a credential must be
-- able to close another member's login (M6). p_ok = true stays refused.
create or replace function public.finish_space_credential_login(
  p_work_session_id uuid,
  p_ok boolean,
  p_display_login text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  login public.credential_sessions;
  target public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  select * into login from public.credential_sessions
   where work_session_id = p_work_session_id
     and space_credential_id is not null
   for update;
  if login.work_session_id is not null then
    select * into target from public.space_credentials
     where id = login.space_credential_id for update;
  end if;
  -- Someone else's terminal is visible only as the revoked-close exception
  -- admits it; otherwise it answers exactly as a missing one.
  if login.work_session_id is null
     or (login.account_id is distinct from v_account_id
         and not (target.status = 'revoked' and not coalesce(p_ok, false)
                  and internal.can_manage_space_credential(target))) then
    raise exception 'no space login terminal of yours with that id' using errcode = 'P0002';
  end if;

  if target.status = 'revoked' and not coalesce(p_ok, false) then
    update public.credential_sessions set finished_at = coalesce(finished_at, now())
     where work_session_id = p_work_session_id;
    return jsonb_build_object(
      'workSessionId', p_work_session_id,
      'finished', true,
      'connected', false,
      'credential', internal.space_credential_json(target)
    );
  end if;
  if target.status not in ('pending', 'active', 'stale') then
    raise exception 'space credential is %', target.status using errcode = '23514';
  end if;
  if not internal.is_space_member(target.space_id) then
    raise exception 'not a member of this space' using errcode = '42501';
  end if;

  update public.credential_sessions set finished_at = coalesce(finished_at, now())
   where work_session_id = p_work_session_id;

  if coalesce(p_ok, false) then
    perform internal.prepare_space_credential_activation(target.id);
    update public.space_credentials
       set status = 'active',
           pending_expires_at = null,
           display_login = coalesce(nullif(btrim(p_display_login), ''), display_login),
           last_probe_at = now()
     where id = target.id
    returning * into target;
    perform internal.default_space_credential_if_none(target.id);
    select * into target from public.space_credentials where id = target.id;
  end if;
  -- A failed probe changes nothing: a pending row ages out, an existing
  -- credential keeps the state its last good probe gave it.

  return jsonb_build_object(
    'workSessionId', p_work_session_id,
    'finished', true,
    'connected', coalesce(p_ok, false),
    'credential', internal.space_credential_json(target)
  );
end
$$;

-- Rotate an api_key/token (D7: takes effect at the next spawn or resume).
create or replace function public.rekey_space_credential(
  p_credential_id uuid,
  p_key_hint text,
  p_secret_ciphertext bytea,
  p_secret_nonce bytea,
  p_display_login text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  stored := internal.lock_managed_space_credential(p_credential_id);
  if stored.shape = 'login' then
    raise exception 'a login credential is rotated by logging in again' using errcode = '22023';
  end if;
  if stored.status not in ('active', 'stale') then
    raise exception 'space credential is %', stored.status using errcode = '23514';
  end if;
  perform internal.prepare_space_credential_activation(stored.id);
  update public.space_credentials
     set key_hint = p_key_hint,
         secret_ciphertext = p_secret_ciphertext,
         secret_nonce = p_secret_nonce,
         display_login = coalesce(nullif(btrim(p_display_login), ''), display_login),
         status = 'active',
         last_probe_at = now()
   where id = stored.id
  returning * into stored;
  return internal.space_credential_json(stored);
end
$$;

create or replace function public.rename_space_credential(p_credential_id uuid, p_label text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  stored := internal.lock_managed_space_credential(p_credential_id);
  if stored.status = 'revoked' then
    raise exception 'space credential is revoked' using errcode = '23514';
  end if;
  update public.space_credentials set label = internal.require_space_credential_label(p_label)
   where id = stored.id returning * into stored;
  return internal.space_credential_json(stored);
end
$$;

create or replace function public.set_space_credential_default(p_credential_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  stored := internal.lock_managed_space_credential(p_credential_id);
  if stored.status <> 'active' then
    raise exception 'only an active credential can be the default' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(stored.space_id::text || '|' || stored.provider, 206));
  update public.space_credentials set is_default = false
   where space_id = stored.space_id and provider = stored.provider
     and is_default and id <> stored.id;
  update public.space_credentials set is_default = true
   where id = stored.id returning * into stored;
  return internal.space_credential_json(stored);
end
$$;

-- A probe's verdict on an existing credential (I6): active or stale.
create or replace function public.record_space_credential_probe(p_credential_id uuid, p_ok boolean)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  stored := internal.lock_managed_space_credential(p_credential_id);
  if stored.status not in ('active', 'stale') then
    raise exception 'space credential is %', stored.status using errcode = '23514';
  end if;
  if coalesce(p_ok, false) then
    perform internal.prepare_space_credential_activation(stored.id);
  end if;
  update public.space_credentials
     set status = case when coalesce(p_ok, false) then 'active' else 'stale' end,
         last_probe_at = now()
   where id = stored.id returning * into stored;
  return internal.space_credential_json(stored);
end
$$;

-- Delete = REVOKE (D7, design §5 step 1). Takes the row FOR UPDATE, so it
-- waits for — and then defeats — any in-flight session_space_credentials
-- insert holding FOR SHARE (M7). The sealed bytes go with it; the row stays as
-- a tombstone so space_credential_live_sessions can still find every session
-- that used it. Killing those sessions and removing a login's file home are
-- the caller's steps 2 and 3. Idempotent.
create or replace function public.delete_space_credential(p_credential_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  stored public.space_credentials;
  was_revoked boolean;
begin
  perform internal.require_human_auth_kind();
  stored := internal.lock_managed_space_credential(p_credential_id);
  was_revoked := stored.status = 'revoked';
  if not was_revoked then
    update public.space_credentials
       set status = 'revoked',
           is_default = false,
           pending_expires_at = null,
           secret_ciphertext = null,
           secret_nonce = null
     where id = stored.id returning * into stored;
    -- An open login terminal onto it is NOT stamped here: it would vanish
    -- from space_credential_live_sessions while its PTY still runs, and a
    -- retried delete could never find it. The caller kills the PTY, then
    -- calls finish_space_credential_login(ws, false), which on a revoked
    -- credential only stamps the terminal (the member Disconnect's order).
  end if;
  return internal.space_credential_json(stored) || jsonb_build_object('revoked', not was_revoked);
end
$$;

create or replace function public.set_space_credential_policy(
  p_space_id uuid,
  p_provider text,
  p_allowed_sources text[]
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credential_policies;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_admin(p_space_id);
  if p_allowed_sources is null then
    delete from public.space_credential_policies where space_id = p_space_id and provider = p_provider;
    return jsonb_build_object('spaceId', p_space_id, 'provider', p_provider, 'allowedSources', null);
  end if;
  insert into public.space_credential_policies(space_id, provider, allowed_sources, updated_by_account_id)
  values (p_space_id, p_provider, p_allowed_sources, internal.current_account_id())
  on conflict (space_id, provider) do update
     set allowed_sources = excluded.allowed_sources,
         updated_by_account_id = excluded.updated_by_account_id,
         updated_at = now()
  returning * into stored;
  return jsonb_build_object('spaceId', stored.space_id, 'provider', stored.provider,
                            'allowedSources', to_jsonb(stored.allowed_sources),
                            'updatedAt', stored.updated_at);
end
$$;

create or replace function public.set_node_credential_policy(p_provider text, p_allow_node boolean)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.node_credential_policies;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_node_admin();
  if p_allow_node is null then
    delete from public.node_credential_policies where provider = p_provider;
    return jsonb_build_object('provider', p_provider, 'allowNode', null);
  end if;
  insert into public.node_credential_policies(provider, allow_node, updated_by_account_id)
  values (p_provider, p_allow_node, internal.current_account_id())
  on conflict (provider) do update
     set allow_node = excluded.allow_node,
         updated_by_account_id = excluded.updated_by_account_id,
         updated_at = now()
  returning * into stored;
  return jsonb_build_object('provider', stored.provider, 'allowNode', stored.allow_node,
                            'updatedAt', stored.updated_at);
end
$$;

-- -----------------------------------------------------------------------------
-- 7. Containment lookups (M6/A6). SECURITY DEFINER so they see sessions RLS
--    and share_mode would hide: other members' sessions and agent-spawned
--    children, whatever their launcher.
-- -----------------------------------------------------------------------------

-- Every LIVE agent session recorded on this credential, and every open login
-- terminal onto it. For delete's step 2; the credential may already be revoked.
create or replace function public.space_credential_live_sessions(p_credential_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  stored public.space_credentials;
  sessions jsonb;
  logins jsonb;
begin
  perform internal.require_human_auth_kind();
  select * into stored from public.space_credentials where id = p_credential_id;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if not internal.can_manage_space_credential(stored) then
    raise exception 'only the credential''s creator or a space admin can change it'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'workSessionId', ssc.work_session_id, 'provider', ssc.provider,
           'launcherAccountId', ssc.launcher_account_id, 'status', ws.status)
           order by ssc.work_session_id), '[]'::jsonb)
    into sessions
    from public.session_space_credentials ssc
    join public.work_sessions ws on ws.entity_id = ssc.work_session_id
   where ssc.space_credential_id = p_credential_id
     and ws.status in ('spawning', 'running', 'idle');

  select coalesce(jsonb_agg(jsonb_build_object(
           'workSessionId', cs.work_session_id, 'accountId', cs.account_id,
           'expiresAt', cs.expires_at)
           order by cs.work_session_id), '[]'::jsonb)
    into logins
    from public.credential_sessions cs
   where cs.space_credential_id = p_credential_id
     and cs.finished_at is null;

  return jsonb_build_object('credentialId', p_credential_id,
                            'sessions', sessions, 'loginTerminals', logins);
end
$$;

-- Every live session a member LAUNCHED on this space's credentials (SC-6:
-- member removal). A space admin may ask about anyone; a member about
-- themselves.
create or replace function public.member_space_credential_sessions(p_space_id uuid, p_account_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare sessions jsonb;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_identity();
  -- A node admin may ask across every space (SC-6's account disable); a
  -- space admin about their space; anyone about themselves.
  if not (internal.is_node_admin()
          or (p_space_id is not null and internal.is_space_admin(p_space_id))
          or (p_account_id is not null and p_account_id = internal.current_account_id())) then
    raise exception 'space admin required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'workSessionId', ssc.work_session_id, 'provider', ssc.provider,
           'spaceId', ssc.space_id,
           'spaceCredentialId', ssc.space_credential_id, 'status', ws.status)
           order by ssc.work_session_id, ssc.provider), '[]'::jsonb)
    into sessions
    from public.session_space_credentials ssc
    join public.work_sessions ws on ws.entity_id = ssc.work_session_id
   where (p_space_id is null or ssc.space_id = p_space_id)
     and ssc.launcher_account_id = p_account_id
     and ws.status in ('spawning', 'running', 'idle');

  return jsonb_build_object('spaceId', p_space_id, 'accountId', p_account_id,
                            'sessions', sessions);
end
$$;

-- -----------------------------------------------------------------------------
-- 8. The spawn path. NOT human-only: an agent's claims are its root human
--    launcher's identity with auth_kind 'agent', and children inherit (093).
-- -----------------------------------------------------------------------------

-- The narrow spawn reader (A1). Membership is checked against the LAUNCH
-- space, and the credential must be IN that space: a pinned id from another
-- space answers exactly like a missing one. Only an ACTIVE credential is
-- usable — the same predicate the session_space_credentials writer enforces,
-- so a credential the reader hands out is one the manifest can record.
--
-- Returns the sealed bytes (api_key/token) or the home key (login), and never
-- plaintext: opening happens in the TS store, under the node key.
create or replace function public.read_space_credential_for_spawn(
  p_launch_space_id uuid,
  p_provider text,
  p_credential_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  perform internal.require_space_member(p_launch_space_id);

  if p_credential_id is null then
    select * into stored from public.space_credentials
     where space_id = p_launch_space_id and provider = p_provider
       and is_default and status = 'active';
    if stored.id is null then
      raise exception 'this space has no default % credential', p_provider using errcode = 'P0002',
        detail = jsonb_build_object('reason', 'no_default', 'provider', p_provider)::text;
    end if;
  else
    select * into stored from public.space_credentials
     where id = p_credential_id and space_id = p_launch_space_id;
    if stored.id is null or stored.provider is distinct from p_provider then
      raise exception 'space credential not found in this space' using errcode = 'P0002',
        detail = jsonb_build_object('reason', 'not_found', 'provider', p_provider)::text;
    end if;
    if stored.status <> 'active' then
      raise exception 'space credential "%" is %', stored.label, stored.status using errcode = '23514',
        detail = jsonb_build_object('reason', stored.status, 'provider', p_provider)::text;
    end if;
  end if;

  update public.space_credentials set last_used_at = now()
   where id = stored.id;

  return jsonb_build_object(
    'credentialId', stored.id,
    'spaceId', stored.space_id,
    'provider', stored.provider,
    'shape', stored.shape,
    'label', stored.label,
    'displayLogin', stored.display_login,
    'secretCiphertext', case when stored.shape = 'login' then null else encode(stored.secret_ciphertext, 'base64') end,
    'secretNonce', case when stored.shape = 'login' then null else encode(stored.secret_nonce, 'base64') end
  );
end
$$;

-- The session_space_credentials writer (M7, M9, t1-10). Called ONLY from
-- record_session_manifest below. One statement: the credential's active check
-- and its FOR SHARE lock live inside the insert's select, so a concurrent
-- delete (FOR UPDATE) either commits first — and this insert re-reads the row
-- as revoked and inserts nothing — or waits for this transaction to finish.
create or replace function internal.record_session_space_credential(
  p_work_session_id uuid,
  p_provider text,
  p_credential_id uuid
) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_launcher uuid;
  inserted integer;
  v_session_space uuid;
  v_session_status text;
  v_credential public.space_credentials;
begin
  v_launcher := internal.current_account_id();
  if v_launcher is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  -- A2: a retried manifest write (a timed-out write may have committed)
  -- must not fail a spawn that succeeded. The identical row is a no-op;
  -- a DIFFERENT credential for the provider is refused below.
  if exists (select 1 from public.session_space_credentials
              where work_session_id = p_work_session_id and provider = p_provider
                and space_credential_id = p_credential_id) then
    return;
  end if;

  begin
    insert into public.session_space_credentials(
      work_session_id, provider, space_credential_id, space_id, launcher_account_id)
    select ws.entity_id, sc.provider, sc.id, sc.space_id, v_launcher
      from public.space_credentials sc
      join public.entities e on e.space_id = sc.space_id
      join public.work_sessions ws on ws.entity_id = e.id
     where sc.id = p_credential_id
       and sc.provider = p_provider
       and sc.status = 'active'
       and e.id = p_work_session_id
       and e.kind = 'work_session'
       and e.deleted_at is null
       and ws.status = 'spawning'
       and ws.session_kind = 'agent'
       for share of sc;
    get diagnostics inserted = row_count;
  exception when unique_violation then
    raise exception 'session already records a different % space credential', p_provider
      using errcode = '23505';
  end;

  if inserted = 1 then
    return;
  end if;

  -- Nothing inserted: say which condition failed. These reads only explain a
  -- refusal the insert above already made; they decide nothing.
  select e.space_id, ws.status into v_session_space, v_session_status
    from public.entities e join public.work_sessions ws on ws.entity_id = e.id
   where e.id = p_work_session_id and e.deleted_at is null;
  select * into v_credential from public.space_credentials where id = p_credential_id;
  if v_credential.id is null or v_credential.space_id is distinct from v_session_space
     or v_credential.provider is distinct from p_provider then
    raise exception 'space credential is not in this session''s space' using errcode = '42501';
  end if;
  if v_session_status is distinct from 'spawning' then
    raise exception 'a space credential is recorded only while a session is spawning'
      using errcode = '23514';
  end if;
  raise exception 'space credential is %', v_credential.status using errcode = '23514';
end
$$;

revoke all on function internal.record_session_space_credential(uuid, text, uuid) from public;

-- Resume (C3): the resumer becomes the launcher. Every recorded credential
-- must still be active, checked under a FOR SHARE lock held to commit, so a
-- concurrent delete either wins first (this refuses) or waits.
create or replace function public.repoint_session_space_credentials(p_work_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  v_launcher uuid;
  v_recorded integer;
  v_active integer;
  rows jsonb;
begin
  e := internal.live_entity(p_work_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  v_launcher := internal.current_account_id();
  if v_launcher is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  select count(*) into v_recorded from public.session_space_credentials
   where work_session_id = p_work_session_id;
  select count(*) into v_active from (
    select sc.id from public.space_credentials sc
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

-- Policy readers (e). Not human-only: resolution runs under agent claims too.
-- Absent providers mean "every source allowed" / "node allowed".
create or replace function public.read_space_credential_policy(p_space_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
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
  perform internal.require_identity();
  return coalesce((select jsonb_object_agg(provider, allow_node)
                     from public.node_credential_policies), '{}'::jsonb);
end
$$;

-- The pending-expiry sweep (M3). Removes login credentials whose login never
-- finished and whose deadline has passed, unless a login terminal onto them is
-- still unfinished — its PTY may be alive past expires_at, and the delete
-- would cascade its row away. The terminal is closed first (its opener's
-- finish_space_credential_login(ws, false)); the next sweep then removes it. Touches nothing else; safe to call from
-- the credential-sessions interval sweep under any claims.
create or replace function public.expire_pending_space_credentials()
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare removed integer;
begin
  delete from public.space_credentials sc
   where sc.status = 'pending'
     and sc.pending_expires_at < now()
     and not exists (select 1 from public.credential_sessions cs
                      where cs.space_credential_id = sc.id
                        and cs.finished_at is null);
  get diagnostics removed = row_count;
  return jsonb_build_object('expired', removed);
end
$$;

-- -----------------------------------------------------------------------------
-- 9. Grants. Revoked from public, granted to tm8_app — and nothing else.
-- -----------------------------------------------------------------------------
revoke all on function public.create_space_credential(uuid, uuid, text, text, text, text, bytea, bytea, text) from public;
revoke all on function public.start_space_credential_login(uuid, text, text, uuid, integer, integer) from public;
revoke all on function public.finish_space_credential_login(uuid, boolean, text) from public;
revoke all on function public.rekey_space_credential(uuid, text, bytea, bytea, text) from public;
revoke all on function public.rename_space_credential(uuid, text) from public;
revoke all on function public.set_space_credential_default(uuid) from public;
revoke all on function public.record_space_credential_probe(uuid, boolean) from public;
revoke all on function public.delete_space_credential(uuid) from public;
revoke all on function public.set_space_credential_policy(uuid, text, text[]) from public;
revoke all on function public.set_node_credential_policy(text, boolean) from public;
revoke all on function public.space_credential_live_sessions(uuid) from public;
revoke all on function public.member_space_credential_sessions(uuid, uuid) from public;
revoke all on function public.read_space_credential_for_spawn(uuid, text, uuid) from public;
revoke all on function public.repoint_session_space_credentials(uuid) from public;
revoke all on function public.read_space_credential_policy(uuid) from public;
revoke all on function public.read_node_credential_policy() from public;
revoke all on function public.expire_pending_space_credentials() from public;

grant execute on function public.create_space_credential(uuid, uuid, text, text, text, text, bytea, bytea, text) to tm8_app;
grant execute on function public.start_space_credential_login(uuid, text, text, uuid, integer, integer) to tm8_app;
grant execute on function public.finish_space_credential_login(uuid, boolean, text) to tm8_app;
grant execute on function public.rekey_space_credential(uuid, text, bytea, bytea, text) to tm8_app;
grant execute on function public.rename_space_credential(uuid, text) to tm8_app;
grant execute on function public.set_space_credential_default(uuid) to tm8_app;
grant execute on function public.record_space_credential_probe(uuid, boolean) to tm8_app;
grant execute on function public.delete_space_credential(uuid) to tm8_app;
grant execute on function public.set_space_credential_policy(uuid, text, text[]) to tm8_app;
grant execute on function public.set_node_credential_policy(text, boolean) to tm8_app;
grant execute on function public.space_credential_live_sessions(uuid) to tm8_app;
grant execute on function public.member_space_credential_sessions(uuid, uuid) to tm8_app;
grant execute on function public.read_space_credential_for_spawn(uuid, text, uuid) to tm8_app;
grant execute on function public.repoint_session_space_credentials(uuid) to tm8_app;
grant execute on function public.read_space_credential_policy(uuid) to tm8_app;
grant execute on function public.read_node_credential_policy() to tm8_app;
grant execute on function public.expire_pending_space_credentials() to tm8_app;

reset role;

-- -----------------------------------------------------------------------------
-- 10. record_session_manifest, re-created OUTSIDE tm8_graph_owner: 199 created
--     it as the migration role, so only that role can replace it. Ownership,
--     signature and grants are 199's, unchanged.
-- -----------------------------------------------------------------------------
-- 199's record_session_manifest, plus the space-credential record (M9). The
-- body up to the marked block is 199's verbatim.
create or replace function public.record_session_manifest(
  p_session_id uuid, p_manifest jsonb, p_env_var_names text[] default '{}'::text[],
  p_system_prompt text default null, p_task_prompt text default null,
  p_agent_config_dir text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  v_sources jsonb;
  v_ids jsonb;
  v_provider text;
begin
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);

  if p_agent_config_dir is not null and p_agent_config_dir !~ '^/' then
    raise exception using errcode = '22023', message = 'agent config dir must be absolute';
  end if;

  insert into public.session_manifests(
    work_session_id, manifest, env_var_names, system_prompt, task_prompt)
  values (
    p_session_id, p_manifest, coalesce(p_env_var_names, '{}'::text[]),
    nullif(p_system_prompt, ''), nullif(p_task_prompt, ''))
  on conflict (work_session_id) do update
    set manifest      = excluded.manifest,
        env_var_names = excluded.env_var_names,
        system_prompt = coalesce(excluded.system_prompt, session_manifests.system_prompt),
        task_prompt   = coalesce(excluded.task_prompt, session_manifests.task_prompt);

  update public.work_sessions
     set agent_config_dir = coalesce(agent_config_dir, nullif(p_agent_config_dir, '')),
         skills = coalesce(p_manifest -> 'effectiveSkills', skills)
   where entity_id = p_session_id;

  -- ADDED IN 206 (M9). launch.credentialSources[p] = 'space' and
  -- launch.spaceCredentialIds[p] must name the same providers; each pair is
  -- recorded in session_space_credentials in THIS transaction, so the manifest
  -- and the table cannot disagree.
  v_sources := p_manifest #> '{launch,credentialSources}';
  v_ids := p_manifest #> '{launch,spaceCredentialIds}';
  if v_ids is not null and jsonb_typeof(v_ids) <> 'object' then
    raise exception 'manifest launch.spaceCredentialIds must be an object' using errcode = '22023';
  end if;
  if jsonb_typeof(v_sources) = 'object' then
    for v_provider in
      select key from jsonb_each_text(v_sources) where value = 'space'
    loop
      if v_ids is null or jsonb_typeof(v_ids -> v_provider) is distinct from 'string' then
        raise exception 'manifest names space as the % source without a credential id', v_provider
          using errcode = '22023';
      end if;
    end loop;
  end if;
  if v_ids is not null then
    for v_provider in select key from jsonb_each(v_ids) order by key loop
      if v_sources is null or (v_sources ->> v_provider) is distinct from 'space' then
        raise exception 'manifest carries a space credential id for %, whose source is not space', v_provider
          using errcode = '22023';
      end if;
      if (v_ids ->> v_provider) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'manifest launch.spaceCredentialIds.% is not a credential id', v_provider
          using errcode = '22023';
      end if;
      perform internal.record_session_space_credential(
        p_session_id, v_provider, (v_ids ->> v_provider)::uuid);
    end loop;
  end if;

  return jsonb_build_object('workSessionId', p_session_id);
end
$$;

revoke all on function public.record_session_manifest(uuid, jsonb, text[], text, text, text) from public;
grant execute on function public.record_session_manifest(uuid, jsonb, text[], text, text, text) to tm8_app;
