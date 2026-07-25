-- =============================================================================
-- 006 execution + blob side tables (03 §4, AM-2 §2).
--
-- Operational bookkeeping, never graph data (T-L3). Nothing here is an entity:
-- manifests, modals, stream grants and upload slots are the machinery around the
-- `work_session` and `file` entities, and modelling them as entities would put
-- terminal plumbing into the hierarchy the user browses.
--
-- Two invariants this file exists to hold structurally:
--   * S15 — provider secrets NEVER enter Postgres. `session_manifests` stores
--     env var NAMES, never values, which is what makes pg_dump backups
--     secret-free by construction. There is a guard trigger, not just a promise.
--   * S17 — blob bytes live on disk; the DB holds metadata and a
--     SERVER-GENERATED path. A client-supplied filename is metadata, never a
--     path component.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Spawn manifests.
-- -----------------------------------------------------------------------------
create table public.session_manifests (
  work_session_id uuid primary key references public.entities(id) on delete cascade,
  manifest        jsonb not null check (jsonb_typeof(manifest) = 'object'),
  -- Names only, e.g. ['ANTHROPIC_API_KEY'] — the execution block injects the
  -- values from the OS environment at spawn time and they never come back here.
  env_var_names   text[] not null default '{}'::text[],
  created_at      timestamptz not null default now()
);

comment on table public.session_manifests is
  'The composed spawn manifest as handed to the terminal: auditable, not graph '
  'data (T-L3). Secret VALUES are structurally absent (S15) — see the guard.';

-- Defence in depth for S15: if a credential-shaped string ever reaches a
-- manifest, the write fails loudly instead of quietly persisting a secret that
-- then flows into every backup and transcript.
create or replace function internal.guard_manifest_secrets() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare rendered text := new.manifest::text;
begin
  if rendered ~ '(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})' then
    raise exception 'manifest appears to contain a credential value'
      using errcode = '23514',
            detail = 'session_manifests stores env var NAMES, never values (S15)';
  end if;
  if exists (
    select 1 from unnest(new.env_var_names) as n
     where n !~ '^[A-Z][A-Z0-9_]{0,80}$'
  ) then
    raise exception 'env_var_names must be environment variable names, not values'
      using errcode = '22023';
  end if;
  return new;
end
$$;
create trigger session_manifests_guard_secrets before insert or update on public.session_manifests
for each row execute function internal.guard_manifest_secrets();

-- -----------------------------------------------------------------------------
-- 2. Interactive modals raised mid-run.
--
-- An agent asks a question, the UI answers it. Operational + an immediate-class
-- event; never an entity, and the compat adapter carries the verbs (R29).
-- -----------------------------------------------------------------------------
create table public.session_modals (
  id              uuid primary key default internal.new_id(),
  work_session_id uuid not null references public.entities(id) on delete cascade,
  space_id        uuid not null references public.spaces(id) on delete cascade,
  kind            text not null,
  prompt          jsonb not null default '{}'::jsonb check (jsonb_typeof(prompt) = 'object'),
  response        jsonb check (response is null or jsonb_typeof(response) = 'object'),
  status          text not null default 'open' check (status in ('open','answered','cancelled','expired')),
  created_at      timestamptz not null default now(),
  answered_at     timestamptz,
  expires_at      timestamptz,
  constraint session_modals_answer_shape check (
    (status = 'answered' and response is not null and answered_at is not null)
 or (status <> 'answered' and answered_at is null)
  )
);
create index session_modals_open_idx on public.session_modals(work_session_id) where status = 'open';

-- -----------------------------------------------------------------------------
-- 3. Stream grants (T-L10 / S14).
--
-- The graph announces and authorises; bytes flow client↔host over the socket and
-- never touch this table. `drive` (input) is a higher tier than `view`: in v1 it
-- is granted only to the spawning owner.
-- -----------------------------------------------------------------------------
create table public.stream_grants (
  id              uuid primary key default internal.new_id(),
  work_session_id uuid not null references public.entities(id) on delete cascade,
  subject_identity text not null references public.user_profiles(identity_id) on delete cascade,
  mode            text not null check (mode in ('view','drive')),
  granted_by      uuid not null references public.entities(id) on delete cascade,
  token_hash      text check (token_hash is null or token_hash ~ '^[a-f0-9]{64}$'),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);
create unique index stream_grants_live_idx
  on public.stream_grants(work_session_id, subject_identity, mode)
  where revoked_at is null;
create index stream_grants_expiry_idx on public.stream_grants(expires_at) where revoked_at is null;

-- -----------------------------------------------------------------------------
-- 4. Blob upload slots (AM-2 §2, S17).
--
-- `uploadInit` reserves a slot; the client PUTs bytes; `uploadComplete` verifies
-- size + checksum and creates the `file` entity in one transaction. An abandoned
-- slot is GC'd after its grant expires — an upload that never completes leaves
-- no graph trace at all.
-- -----------------------------------------------------------------------------
create table public.file_upload_slots (
  id              uuid primary key default internal.new_id(),
  space_id        uuid not null references public.spaces(id) on delete cascade,
  created_by      uuid not null references public.members(entity_id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 500),
  mime_type       text not null check (char_length(mime_type) between 1 and 255),
  size_bytes      bigint not null check (size_bytes >= 0),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  -- Server-GENERATED, never derived from `name` (S17): spaces/<spaceId>/<uuid>.
  storage_path    text not null unique check (storage_path ~ '^spaces/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  -- Optional anchor: on complete, the file entity is attached_to this entity.
  anchor_entity_id uuid references public.entities(id) on delete set null,
  token_hash      text check (token_hash is null or token_hash ~ '^[a-f0-9]{64}$'),
  status          text not null default 'pending'
    check (status in ('pending','completed','aborted','expired')),
  file_entity_id  uuid references public.entities(id) on delete set null,
  expires_at      timestamptz not null,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  constraint file_upload_slots_completion_shape check (
    (status = 'completed' and file_entity_id is not null and completed_at is not null)
 or (status <> 'completed' and file_entity_id is null)
  )
);
create index file_upload_slots_pending_idx on public.file_upload_slots(expires_at) where status = 'pending';
create index file_upload_slots_space_idx on public.file_upload_slots(space_id, created_at desc, id desc);

create or replace function internal.expire_file_upload_slots() returns bigint
language plpgsql set search_path = public, internal, pg_temp as $$
declare affected bigint;
begin
  update public.file_upload_slots
     set status = 'expired'
   where status = 'pending' and expires_at < now();
  get diagnostics affected = row_count;
  return affected;
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Tracking refresh queue (PR/commit provider fetches).
--
-- A worker with provider credentials consumes this; the credentials stay outside
-- Postgres (S15), so the queue carries intent only.
-- -----------------------------------------------------------------------------
create table public.tracking_refresh_requests (
  id           uuid primary key default internal.new_id(),
  space_id     uuid not null references public.spaces(id) on delete cascade,
  requested_by uuid not null references public.members(entity_id) on delete cascade,
  entity_ids   uuid[],
  status       text not null default 'queued' check (status in ('queued','running','completed','failed')),
  error        text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index tracking_refresh_queued_idx on public.tracking_refresh_requests(created_at) where status = 'queued';

-- -----------------------------------------------------------------------------
-- 6. Concurrency accounting for the spawn cap (S10).
--
-- `execution.spawn` refuses over the cap with limit_exceeded (429) rather than
-- queueing silently. The cap value is server config; the count lives here so the
-- decision is made against the same rows the graph sees.
-- -----------------------------------------------------------------------------
create or replace function internal.live_work_session_count(target_space uuid default null)
returns integer language sql stable set search_path = public, internal, pg_temp as $$
  select count(*)::integer
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where ws.status in ('spawning','running','idle')
     and e.deleted_at is null
     and (target_space is null or e.space_id = target_space)
$$;

revoke all on all functions in schema internal from public;
revoke all on all functions in schema public from public;

reset role;
