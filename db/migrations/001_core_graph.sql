-- =============================================================================
-- 001 core graph — roles, schemas, the entity envelope, detail tables, edges,
--                  messages, counters, versions.
--
-- ONE clean sequence (09 §3.1). Cribbed in spirit from the legacy branch's
-- migrations; nothing is imported. There is no identity-bypass machinery here or
-- anywhere in this sequence, and no vendor-specific auth surface: identity
-- arrives as per-transaction claims (R2, see 002).
--
-- Structural laws this file establishes:
--   * envelope + detail (class-table inheritance): `entities` carries the
--     universal columns, one detail table per kind carries the typed fields.
--   * homogeneous hierarchy: a parent is always the SAME kind in the SAME space,
--     and cycles are refused (trigger, not convention).
--   * one `edges` table + a registry; unregistered types must be `x:*`.
--   * derived data (counters, versions, activity) is trigger-owned, never
--     hand-maintained by callers.
--   * the app role is LOW-PRIVILEGE and never a table owner (R2/S9); every write
--     goes through a SECURITY DEFINER RPC owned by tm8_graph_owner (D8).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Roles.
--
-- Roles are cluster-wide, so creation is guarded: the sequence must apply to a
-- second database in the same cluster (tm8_dev + tm8_test) without failing.
--
--   tm8_graph_owner  owns every schema/table/function. NOLOGIN, NOT superuser.
--                    SECURITY DEFINER RPCs run as this role, so the blast radius
--                    of the write path is the graph and nothing else.
--   tm8_app          the role tm8-server connects as. LOGIN, low-privilege:
--                    USAGE + SELECT + EXECUTE only. Never an owner, so RLS
--                    actually applies to it. Zero direct INSERT/UPDATE/DELETE.
-- -----------------------------------------------------------------------------
do $bootstrap$
begin
  if not exists (select 1 from pg_roles where rolname = 'tm8_graph_owner') then
    create role tm8_graph_owner nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'tm8_app') then
    create role tm8_app login;
  end if;
  -- The applying role must be able to SET ROLE to the owner. Superusers always
  -- can; a non-superuser applier is granted membership here.
  if not pg_has_role(current_user, 'tm8_graph_owner', 'MEMBER') then
    execute format('grant tm8_graph_owner to %I', current_user);
  end if;
end
$bootstrap$;

alter schema public owner to tm8_graph_owner;
create schema if not exists internal authorization tm8_graph_owner;

comment on schema internal is
  'Helpers, trigger functions and claim accessors. Not part of the contract '
  'surface: tm8_app gets USAGE + EXECUTE only on the read-only predicates that '
  'RLS policies evaluate.';

do $grants$
begin
  execute format('grant connect on database %I to tm8_app', current_database());
end
$grants$;

grant usage on schema public to tm8_app;

-- Everything below is created BY the owner, so it is owned by the owner.
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Id generation.
--
-- uuidv7 (RFC 9562) everywhere: time-sortable primary keys are the substrate for
-- keyset pagination (04 §3) and the unread-count time-range trick. PG 18 has a
-- native uuidv7(); the fallback exists so the sequence is not wedged to one
-- major version. One indirection (`internal.new_id`) so every default agrees.
-- -----------------------------------------------------------------------------
do $idgen$
begin
  if to_regprocedure('pg_catalog.uuidv7()') is not null then
    execute $native$
      create or replace function internal.new_id() returns uuid
      language sql volatile parallel safe
      as 'select pg_catalog.uuidv7()';
    $native$;
  else
    execute $fallback$
      create or replace function internal.new_id() returns uuid
      language plpgsql volatile as $body$
      declare
        bytes bytea := uuid_send(gen_random_uuid());
        millis bigint := floor(extract(epoch from clock_timestamp()) * 1000);
        millis_hex text := lpad(to_hex(millis), 12, '0');
        hex text;
        i integer;
      begin
        for i in 0..5 loop
          bytes := set_byte(bytes, i, ('x' || substr(millis_hex, i * 2 + 1, 2))::bit(8)::int);
        end loop;
        bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);   -- version 7
        bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);   -- RFC variant
        hex := encode(bytes, 'hex');
        return (substr(hex, 1, 8) || '-' || substr(hex, 9, 4) || '-' || substr(hex, 13, 4)
             || '-' || substr(hex, 17, 4) || '-' || substr(hex, 21, 12))::uuid;
      end
      $body$;
    $fallback$;
  end if;
end
$idgen$;

comment on function internal.new_id() is
  'uuidv7 generator: native pg_catalog.uuidv7() when available, else an '
  'equivalent fallback. The single id source for the whole schema.';

-- Lower bound of the uuidv7 space for an instant — the "unread since" trick
-- (04 §3): `id > internal.uuid_at(last_read_at)` beats a timestamp comparison
-- because it rides the primary key.
create or replace function internal.uuid_at(at timestamptz)
returns uuid language sql immutable parallel safe as $$
  select (lpad(to_hex(floor(extract(epoch from at) * 1000)::bigint), 12, '0')
       || '7000' || '8000' || '000000000000')::uuid
$$;

-- -----------------------------------------------------------------------------
-- 2. Claim accessors (R2).
--
-- Identity is established by tm8-server and bound PER TRANSACTION with
-- `set_config('tm8.<claim>', value, true)` (i.e. SET LOCAL). Nothing here reads
-- a client-supplied header, and there is no flag that can relax it.
--
-- Canonical claim set (ratified with the identity block):
--   tm8.identity_id        opaque immutable identity id            [required]
--   tm8.account_id         node-local account uuid
--   tm8.node_admin         'true' | 'false'
--   tm8.member_ids         CSV of the identity's member entity ids
--   tm8.team_member_ids    CSV of team_member entity ids it owns
--   tm8.acting_as          team_member entity id, or '' when acting as self
--   tm8.actor_id           the effective author entity id
--   tm8.can_act_as         CSV of every actor id the identity may author as
--
-- The CSV claims are a fast path for the server. Authorization NEVER trusts
-- them: `internal.is_space_member` / `internal.can_act_as` (002) resolve against
-- the members/team_members tables using tm8.identity_id, which is the only claim
-- with authority.
-- -----------------------------------------------------------------------------
create or replace function internal.claim_text(claim_name text)
returns text language plpgsql stable as $$
declare v text;
begin
  v := nullif(btrim(coalesce(current_setting(claim_name, true), '')), '');
  return v;
exception when others then
  return null;
end
$$;

create or replace function internal.identity_id() returns text
language sql stable as $$ select internal.claim_text('tm8.identity_id') $$;

create or replace function internal.account_id() returns uuid
language sql stable as $$
  select nullif(internal.claim_text('tm8.account_id'), '')::uuid
$$;

create or replace function internal.is_node_admin() returns boolean
language sql stable as $$
  select coalesce(lower(internal.claim_text('tm8.node_admin')) = 'true', false)
$$;

create or replace function internal.acting_as() returns uuid
language sql stable as $$
  select nullif(internal.claim_text('tm8.acting_as'), '')::uuid
$$;

-- The effective author of a write. Explicit RPC parameters win; this is the
-- fallback so triggers (version snapshots, activity) can attribute a change
-- without every RPC threading an actor argument.
create or replace function internal.actor_id() returns uuid
language sql stable as $$
  select coalesce(nullif(internal.claim_text('tm8.actor_id'), '')::uuid, internal.acting_as())
$$;

create or replace function internal.claim_uuids(claim_name text) returns uuid[]
language sql stable as $$
  select coalesce(
    (select array_agg(t::uuid)
       from unnest(string_to_array(coalesce(internal.claim_text(claim_name), ''), ',')) as t
      where btrim(t) <> ''),
    '{}'::uuid[])
$$;

-- Raised by every write RPC when no identity is bound. 28000 maps to
-- `unauthenticated` in the contract taxonomy.
create or replace function internal.require_identity() returns text
language plpgsql stable as $$
declare id text := internal.identity_id();
begin
  if id is null then
    raise exception 'no identity bound to this transaction'
      using errcode = '28000',
            hint = 'set_config(''tm8.identity_id'', <identity>, true) before any statement';
  end if;
  return id;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. Small shared trigger helpers.
-- -----------------------------------------------------------------------------
create or replace function internal.touch_updated_at() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- 4. Spaces — the sharing boundary.
-- -----------------------------------------------------------------------------
create table public.spaces (
  id            uuid primary key default internal.new_id(),
  name          text not null check (char_length(btrim(name)) between 1 and 200),
  description   text not null default '',
  github_repo   text,
  -- 'private' is the default here AND in the create RPC (01 §2 fixes the
  -- deployed contradiction where the RPC defaulted to public).
  visibility    text not null default 'private' check (visibility in ('private', 'public')),
  created_by_identity text not null,          -- FK to user_profiles added in 002
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index spaces_discovery_idx on public.spaces(updated_at desc, id desc) where visibility = 'public';

create trigger spaces_touch_updated_at before update on public.spaces
for each row execute function internal.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 5. Projects (AM-2 §1, T-D17) — linked resources, deliberately NOT entities.
--
-- A project is a repo/workingDir reference owned by the node and linked to spaces
-- many-to-many. It has no hierarchy, edges, messages or reactions, which is
-- exactly why it is a resource table and not an entity kind.
-- -----------------------------------------------------------------------------
create table public.projects (
  id           uuid primary key default internal.new_id(),
  name         text not null check (char_length(btrim(name)) between 1 and 200),
  repo_url     text,
  -- Absolute path on this node. Path traversal / symlink escape is checked by
  -- the server before it ever gets here (S11); the DB enforces the shape.
  working_dir  text not null check (working_dir like '/%' and working_dir not like '%..%'),
  -- Trust is an explicit grant, never a default (S12).
  trust        text not null default 'untrusted' check (trust in ('trusted', 'untrusted')),
  defaults     jsonb not null default '{}'::jsonb check (jsonb_typeof(defaults) = 'object'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (working_dir)
);

create trigger projects_touch_updated_at before update on public.projects
for each row execute function internal.touch_updated_at();

create table public.space_projects (
  space_id   uuid not null references public.spaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  linked_by  uuid,                              -- member entity id; FK added in 002
  linked_at  timestamptz not null default now(),
  primary key (space_id, project_id)
);
create index space_projects_project_idx on public.space_projects(project_id);

-- -----------------------------------------------------------------------------
-- 6. Kind registry (T-L4 / R7).
--
-- Core kinds are global rows (space_id IS NULL); custom `c:*` kinds are
-- space-scoped. The envelope's kind validation does the same two-step lookup the
-- UI's KindRegistry does: (space_id, kind) first, then the core row.
--
-- The registry lives here rather than in 005 because the entity envelope's
-- validation trigger depends on it; 005 owns `custom_entities`, the scalar
-- field-schema validation (R8) and the evolution rule (R9).
-- -----------------------------------------------------------------------------
create table public.entity_kinds (
  id           uuid primary key default internal.new_id(),
  kind         text not null check (char_length(kind) between 1 and 64),
  origin       text not null default 'custom' check (origin in ('core', 'custom')),
  space_id     uuid references public.spaces(id) on delete cascade,
  icon         text,
  -- [{name, type: text|number|bool|date|enum, required, values[]}] — scalars ONLY (R8).
  field_schema jsonb not null default '[]'::jsonb check (jsonb_typeof(field_schema) = 'array'),
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (space_id, kind),
  -- Core kinds are global and carry no schema; custom kinds are namespaced and
  -- space-scoped. Neither can pretend to be the other.
  constraint entity_kinds_origin_shape check (
    (origin = 'core'   and space_id is null     and kind !~ '^c:')
 or (origin = 'custom' and space_id is not null and kind ~ '^c:[a-z0-9][a-z0-9_]{0,48}$')
  )
);
-- Two spaces may both define c:design_asset; a core kind is unique globally (R7).
create unique index entity_kinds_core_unique_idx on public.entity_kinds(kind) where space_id is null;
create index entity_kinds_space_idx on public.entity_kinds(space_id) where space_id is not null;

create trigger entity_kinds_touch_updated_at before update on public.entity_kinds
for each row execute function internal.touch_updated_at();

insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('channel',      'core', null, 'hash'),
  ('task',         'core', null, 'check-square'),
  ('message',      'core', null, 'message-circle'),
  ('member',       'core', null, 'user'),
  ('team_member',  'core', null, 'bot'),
  ('doc',          'core', null, 'file-text'),
  ('file',         'core', null, 'paperclip'),
  ('spell',        'core', null, 'sparkles'),
  ('skill',        'core', null, 'book-open'),
  ('pull_request', 'core', null, 'git-pull-request'),
  ('commit',       'core', null, 'git-commit'),
  ('work_session', 'core', null, 'terminal'),
  ('collection',   'core', null, 'layers');

-- -----------------------------------------------------------------------------
-- 7. The entity envelope.
-- -----------------------------------------------------------------------------
create table public.entities (
  id          uuid primary key default internal.new_id(),
  space_id    uuid not null references public.spaces(id) on delete cascade,
  kind        text not null,
  -- Same kind, same space, acyclic — enforced by trigger below.
  parent_id   uuid references public.entities(id) deferrable initially deferred,
  -- NOT NULL with no default: a NULL passed in is filled by the position
  -- trigger (append to the end of the sibling list) before the constraint check.
  position    double precision not null,
  created_by  uuid not null references public.entities(id) deferrable initially deferred,
  visibility  text not null default 'space' check (visibility in ('space', 'restricted')),
  version     integer not null default 1 check (version > 0),
  activity_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index entities_space_kind_created_idx on public.entities(space_id, kind, created_at desc, id desc);
create index entities_space_kind_activity_idx on public.entities(space_id, kind, activity_at desc, id desc);
create index entities_parent_position_idx on public.entities(parent_id, position, id) where deleted_at is null;
create index entities_created_by_idx on public.entities(created_by);
create index entities_deleted_idx on public.entities(space_id, deleted_at) where deleted_at is not null;

comment on column public.entities.version is
  'Content version. Advanced by the detail-table snapshot trigger for content '
  'changes and by envelope commands (move) explicitly — never by both for one '
  'logical change.';

-- Kind must be registered: core row, or a custom row in this entity's space (R7).
create or replace function internal.validate_entity_kind() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if not exists (
    select 1 from public.entity_kinds k
     where k.kind = new.kind
       and (k.space_id is null or k.space_id = new.space_id)
  ) then
    raise exception 'unregistered entity kind: %', new.kind
      using errcode = '23514',
            detail = 'core kinds are global rows in entity_kinds; custom c:* kinds must be registered in this space';
  end if;
  return new;
end
$$;
create trigger entities_validate_kind
before insert or update of kind, space_id on public.entities
for each row execute function internal.validate_entity_kind();

-- Homogeneous hierarchy: parent is the same kind in the same space, is not the
-- row itself, and introduces no cycle.
create or replace function internal.validate_entity_parent() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare parent public.entities;
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'entity cannot be its own parent' using errcode = '23514';
  end if;

  select * into parent from public.entities where id = new.parent_id;
  if not found then
    raise exception 'parent entity does not exist' using errcode = '23503';
  end if;
  if parent.space_id <> new.space_id then
    raise exception 'parent must be in the same space' using errcode = '23514';
  end if;
  if parent.kind <> new.kind then
    raise exception 'parent must be the same kind (% <> %)', parent.kind, new.kind
      using errcode = '23514';
  end if;

  if exists (
    with recursive ancestors(id, depth) as (
      select parent.id, 1
      union all
      select e.parent_id, a.depth + 1
        from public.entities e
        join ancestors a on e.id = a.id
       where e.parent_id is not null
         and a.depth < 1024
    )
    select 1 from ancestors where id = new.id
  ) then
    raise exception 'hierarchy cycle refused' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger entities_validate_parent
before insert or update of parent_id, space_id, kind on public.entities
for each row execute function internal.validate_entity_parent();

-- Append semantics: a NULL position means "after the last sibling". Explicit
-- positions (including 0) are honoured, so fractional reordering keeps working.
create or replace function internal.assign_entity_position() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.position is null then
    select coalesce(max(e.position), 0) + 1 into new.position
      from public.entities e
     where e.space_id = new.space_id
       and e.kind = new.kind
       and e.parent_id is not distinct from new.parent_id
       and e.deleted_at is null
       and e.id <> new.id;
  end if;
  return new;
end
$$;
create trigger entities_assign_position
before insert or update of position on public.entities
for each row execute function internal.assign_entity_position();

-- -----------------------------------------------------------------------------
-- 8. Counters — derived, trigger-owned, rebuildable.
-- -----------------------------------------------------------------------------
create table public.entity_counters (
  entity_id  uuid primary key references public.entities(id) on delete cascade,
  likes      integer not null default 0,
  dislikes   integer not null default 0,
  stars      integer not null default 0,
  points     integer not null default 0,
  messages   integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Every entity gets its counter row from one place. RPCs never insert counters:
-- two writers for one derived row is how the legacy branch grew a bootstrap bug.
create or replace function internal.ensure_entity_counter() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  insert into public.entity_counters(entity_id) values (new.id)
  on conflict (entity_id) do nothing;
  return new;
end
$$;
create trigger entities_ensure_counter after insert on public.entities
for each row execute function internal.ensure_entity_counter();

-- -----------------------------------------------------------------------------
-- 9. Detail tables, one per core kind.
-- -----------------------------------------------------------------------------

-- A detail row may only decorate an envelope of its own kind, and where a detail
-- table denormalises space_id it must agree with the envelope. One generic
-- trigger, parameterised by the trigger argument, instead of one per table.
create or replace function internal.validate_detail_envelope() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  expected text := tg_argv[0];
  e public.entities;
  declared_space text;
begin
  select * into e from public.entities where id = new.entity_id;
  if e.id is null then
    raise exception '% detail row has no entity', expected using errcode = '23503';
  end if;
  if e.kind <> expected then
    raise exception '% detail row requires an entity of kind % (got %)', expected, expected, e.kind
      using errcode = '23514';
  end if;
  declared_space := to_jsonb(new) ->> 'space_id';
  if declared_space is not null and declared_space::uuid <> e.space_id then
    raise exception '% detail row space_id must match its envelope', expected using errcode = '23514';
  end if;
  return new;
end
$$;

create table public.channels (
  entity_id  uuid primary key references public.entities(id) on delete cascade,
  space_id   uuid not null references public.spaces(id) on delete cascade,
  name       text not null check (name ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  topic      text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, name)
);
create trigger channels_validate_kind before insert or update of entity_id on public.channels
for each row execute function internal.validate_detail_envelope('channel');
create trigger channels_touch_updated_at before update on public.channels
for each row execute function internal.touch_updated_at();

create table public.tasks (
  entity_id           uuid primary key references public.entities(id) on delete cascade,
  title               text not null check (char_length(btrim(title)) between 1 and 500),
  description         text not null default '' check (char_length(description) <= 200000),
  axes                jsonb not null default '{}'::jsonb check (jsonb_typeof(axes) = 'object'),
  work_status         text not null default 'open'
    check (work_status in ('open','pulled','working','in_review','done','blocked','cancelled')),
  priority            text not null default 'medium'
    check (priority in ('low','medium','high','urgent')),
  acceptance_criteria jsonb not null default '[]'::jsonb check (jsonb_typeof(acceptance_criteria) = 'array'),
  points_estimate     integer check (points_estimate is null or points_estimate >= 0),
  due_date            date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index tasks_axes_gin_idx on public.tasks using gin (axes jsonb_path_ops);
create index tasks_work_status_idx on public.tasks(work_status);
create index tasks_due_date_idx on public.tasks(due_date) where due_date is not null;
create trigger tasks_validate_kind before insert or update of entity_id on public.tasks
for each row execute function internal.validate_detail_envelope('task');

-- Axis definitions are space-scoped configuration, not entities. An empty
-- axis_values array means the axis accepts free text.
create table public.task_axes (
  id          uuid primary key default internal.new_id(),
  space_id    uuid not null references public.spaces(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 100),
  axis_values text[] not null default '{}'::text[] check (array_position(axis_values, null) is null),
  kind        text not null default 'manual' check (kind in ('default','manual')),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (space_id, name)
);
create index task_axes_space_position_idx on public.task_axes(space_id, position, name);
create trigger task_axes_touch_updated_at before update on public.task_axes
for each row execute function internal.touch_updated_at();

-- One value per named axis, and the axis must exist in the task's space.
create or replace function internal.validate_task_axes() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  task_space uuid;
  axis_name text;
  axis_value text;
  allowed text[];
begin
  select space_id into task_space from public.entities where id = new.entity_id;
  if task_space is null then
    raise exception 'task entity does not exist' using errcode = '23503';
  end if;

  for axis_name, axis_value in select key, value from jsonb_each_text(new.axes) loop
    if char_length(btrim(axis_name)) = 0 or char_length(btrim(axis_value)) = 0 then
      raise exception 'task axis names and values must be non-empty' using errcode = '22023';
    end if;
    select axis_values into allowed from public.task_axes
     where space_id = task_space and name = axis_name;
    if not found then
      raise exception 'unknown task axis: %', axis_name using errcode = '22023';
    end if;
    if cardinality(allowed) > 0 and not (axis_value = any(allowed)) then
      raise exception 'invalid value % for task axis %', axis_value, axis_name using errcode = '22023';
    end if;
  end loop;
  return new;
end
$$;
create trigger tasks_validate_axes before insert or update of axes, entity_id on public.tasks
for each row execute function internal.validate_task_axes();

create table public.documents (
  entity_id  uuid primary key references public.entities(id) on delete cascade,
  title      text not null check (char_length(btrim(title)) between 1 and 500),
  body       text not null default '' check (char_length(body) <= 200000),   -- 04 §7
  format     text not null default 'markdown' check (format in ('markdown','mermaid','excalidraw')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger documents_validate_kind before insert or update of entity_id on public.documents
for each row execute function internal.validate_detail_envelope('doc');

-- File METADATA only. Bytes live on disk under the node data dir at
-- blobs/spaces/<spaceId>/<uuid> (S17); the DB stores the relative path, and the
-- server-generated name is the only thing that ever becomes a path component.
create table public.files (
  entity_id       uuid primary key references public.entities(id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 500),
  mime_type       text not null check (char_length(mime_type) between 1 and 255),
  size_bytes      bigint not null check (size_bytes >= 0),
  storage_path    text not null check (storage_path ~ '^spaces/[0-9a-f-]{36}/[0-9a-zA-Z._-]{1,120}$'),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (storage_path)
);
create trigger files_validate_kind before insert or update of entity_id on public.files
for each row execute function internal.validate_detail_envelope('file');

create table public.pull_requests (
  entity_id  uuid primary key references public.entities(id) on delete cascade,
  -- Denormalised from the envelope (trigger-checked) so the "one mirror per
  -- repo+number per space" rule can be a plain unique index.
  space_id   uuid not null references public.spaces(id) on delete cascade,
  provider   text not null default 'github',
  url        text not null,
  repo       text not null,
  number     integer not null check (number > 0),
  title      text not null default '',
  state      text not null default 'open' check (state in ('open','merged','closed','draft')),
  head_sha   text,
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger pull_requests_validate_kind before insert or update of entity_id on public.pull_requests
for each row execute function internal.validate_detail_envelope('pull_request');

create table public.commits (
  entity_id    uuid primary key references public.entities(id) on delete cascade,
  space_id     uuid not null references public.spaces(id) on delete cascade,
  provider     text not null default 'github',
  url          text,
  repo         text not null,
  sha          text not null check (char_length(sha) between 7 and 64),
  message      text not null default '',
  author       text,
  committed_at timestamptz,
  fetched_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger commits_validate_kind before insert or update of entity_id on public.commits
for each row execute function internal.validate_detail_envelope('commit');

-- One tracking mirror per repo+number (or repo+sha) per space: link_pr/link_commit
-- upsert against these.
create unique index pull_requests_space_repo_number_idx
  on public.pull_requests(space_id, provider, repo, number);
create unique index commits_space_repo_sha_idx
  on public.commits(space_id, provider, repo, sha);

create table public.spells (
  entity_id   uuid primary key references public.entities(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 200),
  description text not null default '',
  rule        jsonb not null default '{}'::jsonb check (jsonb_typeof(rule) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger spells_validate_kind before insert or update of entity_id on public.spells
for each row execute function internal.validate_detail_envelope('spell');

create table public.skills (
  entity_id   uuid primary key references public.entities(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 200),
  description text not null default '',
  content     text not null default '' check (char_length(content) <= 200000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger skills_validate_kind before insert or update of entity_id on public.skills
for each row execute function internal.validate_detail_envelope('skill');

-- Curated sets (03 §1.2). Absorbs old maestro's TaskList; membership is
-- `contains` edges with props.position for ordering.
create table public.collections (
  entity_id       uuid primary key references public.entities(id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 200),
  description     text not null default '',
  collection_type text not null default 'manual',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger collections_validate_kind before insert or update of entity_id on public.collections
for each row execute function internal.validate_detail_envelope('collection');

-- The execution shadow (03 §1.1). Born ONLY from execution.spawn — never from
-- entities.create. Terminal bytes never touch this table: share_mode is the
-- graph-side announce/authorize state (T-L10) and nothing more.
create table public.work_sessions (
  entity_id         uuid primary key references public.entities(id) on delete cascade,
  title             text not null default '' check (char_length(title) <= 500),
  node_id           text,                                  -- which node hosts the PTY
  project_id        uuid references public.projects(id) on delete set null,
  -- Server-COMPUTED working directory (S11): never accepted raw from a client.
  workdir_mode      text not null default 'project' check (workdir_mode in ('project','worktree')),
  workdir_path      text check (workdir_path is null or (workdir_path like '/%' and workdir_path not like '%..%')),
  base_ref          text,
  status            text not null default 'spawning'
    check (status in ('spawning','running','idle','exited','failed')),
  status_changed_at timestamptz not null default now(),
  agent_tool        text,
  model             text,
  mode              text check (mode is null or mode in
                       ('worker','coordinator','coordinated-worker','coordinated-coordinator')),
  share_mode        text not null default 'none' check (share_mode in ('none','space','explicit')),
  transcript_doc_id uuid references public.entities(id) on delete set null,
  exit_code         integer,
  error             text,
  started_at        timestamptz,
  exited_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index work_sessions_status_idx on public.work_sessions(status)
  where status in ('spawning','running','idle');
create index work_sessions_project_idx on public.work_sessions(project_id);
create trigger work_sessions_validate_kind before insert or update of entity_id on public.work_sessions
for each row execute function internal.validate_detail_envelope('work_session');
create trigger work_sessions_touch_updated_at before update on public.work_sessions
for each row execute function internal.touch_updated_at();

-- R29: `status` has a SINGLE writer — the execution block's transition function
-- (public.work_session_transition, 007). Any other path that tries to move it is
-- refused here, so a well-meaning future RPC cannot quietly become writer #2.
create or replace function internal.guard_work_session_status() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.status is distinct from old.status
     and coalesce(internal.claim_text('tm8.work_session_transition'), '') <> 'on' then
    raise exception 'work_session.status has a single writer: the execution transition function'
      using errcode = '23514',
            detail = 'call public.work_session_transition(...) — R29';
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end
$$;
create trigger work_sessions_guard_status before update of status on public.work_sessions
for each row execute function internal.guard_work_session_status();

-- -----------------------------------------------------------------------------
-- 10. Edges — one table, one registry.
-- -----------------------------------------------------------------------------
create table public.edge_types (
  type         text primary key,
  src_kinds    text[] not null,
  dst_kinds    text[] not null,
  description  text not null,
  -- Nullable and UNENFORCED in v1 (01 §9): validating JSON schema in a trigger
  -- is cost without a consumer. Revisit when an `x:` type is first promoted.
  props_schema jsonb,
  acyclic      boolean not null default false
);

create table public.edges (
  id         uuid primary key default internal.new_id(),
  space_id   uuid not null references public.spaces(id) on delete cascade,
  src_id     uuid not null references public.entities(id) on delete cascade,
  dst_id     uuid not null references public.entities(id) on delete cascade,
  type       text not null,
  props      jsonb not null default '{}'::jsonb check (jsonb_typeof(props) = 'object'),
  created_by uuid not null references public.entities(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (src_id, dst_id, type)
);
create index edges_src_type_idx on public.edges(src_id, type, created_at desc, id desc);
create index edges_dst_type_idx on public.edges(dst_id, type, created_at desc, id desc);
create index edges_space_type_idx on public.edges(space_id, type);

create or replace function internal.validate_edge() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  src public.entities;
  dst public.entities;
  registered public.edge_types;
begin
  select * into src from public.entities where id = new.src_id;
  select * into dst from public.entities where id = new.dst_id;
  if src.id is null or dst.id is null then
    raise exception 'edge endpoint does not exist' using errcode = '23503';
  end if;
  if src.space_id <> new.space_id or dst.space_id <> new.space_id then
    raise exception 'edge endpoints must live in the edge space' using errcode = '23514';
  end if;

  select * into registered from public.edge_types where type = new.type;
  if found then
    -- '*' means any registered kind: used by the deliberately-any types.
    if not (src.kind = any(registered.src_kinds) or registered.src_kinds = array['*']) then
      raise exception 'edge % rejects source kind %', new.type, src.kind using errcode = '23514';
    end if;
    if not (dst.kind = any(registered.dst_kinds) or registered.dst_kinds = array['*']) then
      raise exception 'edge % rejects destination kind %', new.type, dst.kind using errcode = '23514';
    end if;
  elsif new.type !~ '^x:[a-z0-9][a-z0-9_]{0,48}$' then
    raise exception 'unregistered edge types must be namespaced x:*' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger edges_validate before insert or update on public.edges
for each row execute function internal.validate_edge();

-- Registry-driven acyclicity: a future acyclic type is protected by flipping a
-- flag, not by writing another trigger.
create or replace function internal.prevent_edge_cycle() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare is_acyclic boolean;
begin
  select acyclic into is_acyclic from public.edge_types where type = new.type;
  if coalesce(is_acyclic, false) is not true then
    return new;
  end if;
  if new.src_id = new.dst_id then
    raise exception 'acyclic edge % cannot target itself', new.type using errcode = '23514';
  end if;
  if exists (
    with recursive reachable(id, path, depth) as (
      select e.dst_id, array[e.src_id, e.dst_id], 1
        from public.edges e
       where e.src_id = new.dst_id and e.type = new.type and e.id is distinct from new.id
      union all
      select e.dst_id, r.path || e.dst_id, r.depth + 1
        from public.edges e
        join reachable r on e.src_id = r.id
       where e.type = new.type
         and e.id is distinct from new.id
         and not e.dst_id = any(r.path)
         and r.depth < 256
    )
    select 1 from reachable where id = new.src_id
  ) then
    raise exception 'acyclic edge % would create a cycle', new.type using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger edges_prevent_cycles before insert or update of src_id, dst_id, type on public.edges
for each row execute function internal.prevent_edge_cycle();

-- A relationship is neighbourhood movement, never a content version: both ends
-- move their activity_at, neither bumps `version`.
create or replace function internal.touch_edge_activity() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if tg_op in ('DELETE','UPDATE') then
    update public.entities set activity_at = now()
     where id in (old.src_id, old.dst_id) and deleted_at is null;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    update public.entities set activity_at = now()
     where id in (new.src_id, new.dst_id) and deleted_at is null;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
create trigger edges_touch_activity after insert or update or delete on public.edges
for each row execute function internal.touch_edge_activity();

create or replace function internal.maintain_reaction_counters() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if tg_op in ('DELETE','UPDATE') and old.type in ('likes','dislikes','stars') then
    update public.entity_counters
       set likes    = likes    - (old.type = 'likes')::int,
           dislikes = dislikes - (old.type = 'dislikes')::int,
           stars    = stars    - (old.type = 'stars')::int,
           updated_at = now()
     where entity_id = old.dst_id;
  end if;
  if tg_op in ('INSERT','UPDATE') and new.type in ('likes','dislikes','stars') then
    update public.entity_counters
       set likes    = likes    + (new.type = 'likes')::int,
           dislikes = dislikes + (new.type = 'dislikes')::int,
           stars    = stars    + (new.type = 'stars')::int,
           updated_at = now()
     where entity_id = new.dst_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
create trigger edges_reaction_counters after insert or update or delete on public.edges
for each row execute function internal.maintain_reaction_counters();

create trigger edges_touch_updated_at before update on public.edges
for each row execute function internal.touch_updated_at();

-- The registry. `*` = any registered kind, which keeps the deliberately-any
-- types honest instead of re-listing every kind and drifting on each addition.
insert into public.edge_types(type, src_kinds, dst_kinds, description, acyclic) values
  ('depends_on', array['*'], array['*'], 'Sequencing or prerequisite relation', true),
  ('assigned_to', array['task'], array['member','team_member'], 'Task assignment', false),
  ('pulled', array['member','team_member'], array['channel','task','doc','file','spell','skill','collection'],
     'Local projection/adoption', false),
  ('working_on', array['member','team_member','work_session'], array['task'], 'Active work', false),
  ('attached_to',
     array['task','member','team_member','doc','file','spell','skill','pull_request','commit','work_session','collection'],
     array['*'], 'Context attachment; channel destinations power hub tabs and pinned shelves', false),
  ('relates_to', array['*'], array['*'], 'Generic relation', false),
  ('completed_by', array['task'], array['member','team_member'], 'Task completion attribution', false),
  ('tracks', array['task'], array['pull_request','commit'], 'Task implementation tracking', false),
  ('equips', array['task','team_member','work_session'], array['spell','skill'],
     'Capability selection feeding manifests', false),
  ('copy_of', array['*'], array['*'], 'Copy provenance', false),
  -- Reactions are authored by a human member: an agent persona reports work via
  -- messages and edges, it does not silently vote for its owner.
  ('likes', array['member'], array['*'], 'Positive reaction', false),
  ('dislikes', array['member'], array['*'], 'Negative reaction', false),
  ('stars', array['member'], array['*'], 'Bookmark/favourite reaction', false),
  -- tm8 additions (03 §1.2, review §4, 01 §S4/§S5).
  ('contains', array['collection'], array['*'], 'Curated membership; props.position orders it', false),
  ('member_of', array['team_member'], array['team_member'],
     'Secondary team affiliation (primary org line is the hierarchy)', false),
  ('visible_to', array['*'], array['member','team_member'],
     'Restricted-visibility grant. Registered now, inert in v1 (01 §S4)', false),
  ('approval_requested_from', array['task'], array['member','team_member'],
     'Approval request; props {verdict, note}. Inert in v1 (01 §S5)', false),
  ('approved_by', array['task'], array['member','team_member'],
     'Approval verdict; props {verdict, note}. Inert in v1 (01 §S5)', false);

-- -----------------------------------------------------------------------------
-- 11. Messages — unified, anchored, immutable-by-default.
-- -----------------------------------------------------------------------------
create table public.messages (
  entity_id       uuid primary key references public.entities(id) on delete cascade,
  anchor_id       uuid not null references public.entities(id),
  root_message_id uuid references public.messages(entity_id),
  author_id       uuid not null references public.entities(id),
  body            text not null check (char_length(body) between 1 and 10000),   -- 04 §7
  mentions        jsonb not null default '[]'::jsonb check (jsonb_typeof(mentions) = 'array'),
  attachments     jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  client_msg_id   text,
  edited_at       timestamptz,
  redacted_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (author_id, client_msg_id)
);
create index messages_anchor_created_idx on public.messages(anchor_id, created_at, entity_id);
create index messages_root_created_idx on public.messages(root_message_id, created_at, entity_id);
create index messages_author_created_idx on public.messages(author_id, created_at desc);
create index messages_mentions_gin_idx on public.messages using gin (mentions jsonb_path_ops);
create trigger messages_validate_kind before insert or update of entity_id on public.messages
for each row execute function internal.validate_detail_envelope('message');

create or replace function internal.validate_message() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  self public.entities;
  anchor public.entities;
  author public.entities;
  parent public.messages;
begin
  select * into self   from public.entities where id = new.entity_id;
  select * into anchor from public.entities where id = new.anchor_id;
  select * into author from public.entities where id = new.author_id;

  if anchor.id is null or anchor.space_id <> self.space_id then
    raise exception 'message anchor must exist in the message space' using errcode = '23503';
  end if;
  if author.id is null or author.space_id <> self.space_id
     or author.kind not in ('member','team_member') then
    raise exception 'message author must be a member or team_member of the space' using errcode = '23514';
  end if;

  -- Immutability (D-inherited): identity, anchor, author, thread root and the
  -- idempotency key can never change. Only body/mentions/attachments may.
  if tg_op = 'UPDATE' and (
       new.entity_id <> old.entity_id
    or new.anchor_id <> old.anchor_id
    or new.author_id <> old.author_id
    or new.root_message_id is distinct from old.root_message_id
    or new.client_msg_id is distinct from old.client_msg_id
    or new.created_at <> old.created_at
  ) then
    raise exception 'message identity, anchor, author, root and client id are immutable'
      using errcode = '23514';
  end if;

  if self.parent_id is null then
    if new.root_message_id is not null then
      raise exception 'a top-level message has no thread root' using errcode = '23514';
    end if;
  else
    select * into parent from public.messages where entity_id = self.parent_id;
    if parent.entity_id is null then
      raise exception 'a message reply must have a message parent' using errcode = '23503';
    end if;
    if parent.anchor_id <> new.anchor_id then
      raise exception 'a reply must use its parent message anchor' using errcode = '23514';
    end if;
    if new.root_message_id is distinct from coalesce(parent.root_message_id, parent.entity_id) then
      raise exception 'reply root_message_id must match its thread root' using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;
create trigger messages_validate before insert or update on public.messages
for each row execute function internal.validate_message();

-- An edit is a content change to the MESSAGE (version bump + edited_at) and
-- deliberately produces no entity_versions snapshot: edited_at plus the live
-- body is a message's history model.
create or replace function internal.touch_message_content() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.body is not distinct from old.body
     and new.mentions is not distinct from old.mentions
     and new.attachments is not distinct from old.attachments then
    return new;
  end if;
  new.edited_at := now();
  new.updated_at := now();
  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = new.entity_id;
  return new;
end
$$;
create trigger messages_touch_content before update of body, mentions, attachments on public.messages
for each row execute function internal.touch_message_content();

-- A message advances its anchor's neighbourhood signal only. It never bumps the
-- anchor's version, so a pulled task does not go stale because someone replied.
create or replace function internal.maintain_message_counter() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare anchor uuid;
begin
  -- NEW/OLD are each only assigned for their own operation.
  if tg_op = 'DELETE' then anchor := old.anchor_id; else anchor := new.anchor_id; end if;
  update public.entity_counters
     set messages = greatest(messages + case when tg_op = 'DELETE' then -1 else 1 end, 0),
         updated_at = now()
   where entity_id = anchor;
  update public.entities set activity_at = now() where id = anchor and deleted_at is null;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
create trigger messages_counter_after_insert after insert on public.messages
for each row execute function internal.maintain_message_counter();
create trigger messages_counter_after_delete after delete on public.messages
for each row execute function internal.maintain_message_counter();

-- -----------------------------------------------------------------------------
-- 12. Versions — one snapshot trigger for every content-bearing kind (01 §5.1).
--
-- This closes the audited hole where documents bumped `version` with no
-- snapshot: the trigger, not the RPC, owns both. RPCs update ONLY the detail
-- row for a content change; envelope-only commands (move) bump version
-- themselves. Exactly one writer per logical change.
-- -----------------------------------------------------------------------------
create table public.entity_versions (
  entity_id  uuid not null references public.entities(id) on delete cascade,
  version    integer not null,
  snapshot   jsonb not null,
  changed_by uuid references public.entities(id) on delete set null,
  changed_at timestamptz not null default now(),
  primary key (entity_id, version)
);
create index entity_versions_recent_idx on public.entity_versions(entity_id, changed_at desc);

-- Kind-dispatched detail content. THE single place that knows which detail table
-- belongs to which kind; snapshots, command results and reads all go through it.
-- 005 replaces this one function to add the custom-kind branch — the only
-- sanctioned extension point.
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then
    return null;
  end if;
  case e.kind
    when 'task' then
      select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
    when 'doc' then
      select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
    when 'spell' then
      select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
    when 'skill' then
      select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
    when 'team_member' then
      -- team_members lands in 002; the reference resolves at call time.
      execute 'select to_jsonb(t) - ''entity_id'' from public.team_members t where t.entity_id = $1'
        into content using target;
    when 'collection' then
      select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
    when 'channel' then
      select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
    when 'file' then
      select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
    else
      content := '{}'::jsonb;
  end case;
  return coalesce(content, '{}'::jsonb);
end
$$;

create or replace function internal.entity_snapshot(target uuid)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'entity', jsonb_build_object(
      'id', e.id, 'space_id', e.space_id, 'kind', e.kind, 'parent_id', e.parent_id,
      'position', e.position, 'visibility', e.visibility, 'version', e.version),
    'content', coalesce(internal.entity_content(target), '{}'::jsonb)
  )
  from public.entities e where e.id = target
$$;

-- Debounce window: a further edit by the SAME actor inside this window updates
-- the latest snapshot in place instead of appending a new one (gaps-doc D6).
create or replace function internal.version_debounce_window() returns interval
language sql immutable parallel safe as $$ select interval '5 minutes' $$;

create or replace function internal.snapshot_entity_version() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  actor uuid := internal.actor_id();
  next_version integer;
  latest record;
begin
  -- Nothing changed materially → no version, no snapshot.
  if to_jsonb(new) - 'updated_at' = to_jsonb(old) - 'updated_at' then
    return new;
  end if;

  if actor is null then
    select created_by into actor from public.entities where id = new.entity_id;
  end if;

  select version + 1 into next_version from public.entities where id = new.entity_id for update;

  select entity_id, version, changed_by, changed_at into latest
    from public.entity_versions
   where entity_id = new.entity_id
   order by version desc
   limit 1;

  if latest.entity_id is not null
     and latest.changed_by is not distinct from actor
     and latest.changed_at > now() - internal.version_debounce_window() then
    -- Debounced: fold this edit into the open snapshot. `version` still advances
    -- on the envelope so optimistic concurrency stays honest.
    update public.entities
       set version = next_version, activity_at = now(), updated_at = now()
     where id = new.entity_id;
    update public.entity_versions
       set version = next_version,
           snapshot = internal.entity_snapshot(new.entity_id),
           changed_at = now()
     where entity_id = new.entity_id and version = latest.version;
  else
    update public.entities
       set version = next_version, activity_at = now(), updated_at = now()
     where id = new.entity_id;
    insert into public.entity_versions(entity_id, version, snapshot, changed_by)
    values (new.entity_id, next_version, internal.entity_snapshot(new.entity_id), actor);
  end if;
  return new;
end
$$;

-- The versioned kinds (01 §5.1) + collection. team_members joins in 002.
create trigger tasks_snapshot_version after update on public.tasks
for each row execute function internal.snapshot_entity_version();
create trigger documents_snapshot_version after update on public.documents
for each row execute function internal.snapshot_entity_version();
create trigger spells_snapshot_version after update on public.spells
for each row execute function internal.snapshot_entity_version();
create trigger skills_snapshot_version after update on public.skills
for each row execute function internal.snapshot_entity_version();
create trigger collections_snapshot_version after update on public.collections
for each row execute function internal.snapshot_entity_version();

-- Retention (01 §10): keep the newest N snapshots per entity. Called by the
-- scheduler (R26), not on the write path.
create or replace function internal.prune_entity_versions(keep integer default 50)
returns bigint language plpgsql set search_path = public, internal, pg_temp as $$
declare removed bigint;
begin
  with ranked as (
    select entity_id, version, row_number() over (partition by entity_id order by version desc) as rn
      from public.entity_versions
  )
  delete from public.entity_versions v
   using ranked r
   where v.entity_id = r.entity_id and v.version = r.version and r.rn > greatest(keep, 1);
  get diagnostics removed = row_count;
  return removed;
end
$$;

-- The initial snapshot for a newly created entity: RPCs call this once, right
-- after inserting the detail row (an INSERT is not an UPDATE, so the snapshot
-- trigger correctly does not fire).
create or replace function internal.record_initial_version(target uuid, actor uuid)
returns void language sql set search_path = public, internal, pg_temp as $$
  insert into public.entity_versions(entity_id, version, snapshot, changed_by)
  select target, e.version, internal.entity_snapshot(target), actor
    from public.entities e where e.id = target
  on conflict (entity_id, version) do nothing
$$;

-- -----------------------------------------------------------------------------
-- 13. Privilege posture for this file.
--
-- Function EXECUTE defaults to PUBLIC in Postgres, so it is revoked wholesale;
-- 008 grants EXECUTE back to tm8_app on exactly the contract RPCs and the
-- read-only predicates RLS policies must evaluate. RLS itself is enabled in 008
-- for every table in one auditable place.
-- -----------------------------------------------------------------------------
revoke all on all functions in schema internal from public;
revoke all on all functions in schema public from public;

reset role;
