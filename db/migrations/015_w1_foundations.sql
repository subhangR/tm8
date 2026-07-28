-- =============================================================================
-- 015 W1 foundations — additive Project projections, Space settings, Interaction
-- Profiles, durable message delivery, session handoffs, guarded graph facts,
-- RLS, lock-bearing RPC foundations, conservative backfill, repair and forward
-- compensation seams.
--
-- This is the sole forward migration after the shipped 001-014 sequence.  It
-- deliberately implements storage and database invariants only; W2 owns HTTP
-- handlers and execution-side proc.write orchestration.
-- =============================================================================

-- The delivery worker is cluster-wide just like tm8_app.  It is deliberately a
-- separate LOGIN role with no table privileges and no role memberships.
do $delivery_role$
begin
  if not exists (select 1 from pg_roles where rolname = 'tm8_delivery_worker') then
    create role tm8_delivery_worker login noinherit nosuperuser nocreatedb nocreaterole
      noreplication nobypassrls;
  end if;
  execute format('grant connect on database %I to tm8_delivery_worker', current_database());
end
$delivery_role$;

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry additions and ProjectResource accounting.
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('project', 'core', null, 'folder-kanban'),
  ('interaction_profile', 'core', null, 'sliders-horizontal')
on conflict (kind) where space_id is null do nothing;

insert into public.edge_types(type, src_kinds, dst_kinds, description, acyclic) values
  ('in_project', array['task','work_session','pull_request','commit'], array['project'],
    'Space-local association to a live Project projection', false),
  ('shared_into', array['*'], array['work_session'],
    'Recorder-owned historical successful entity handoff', false),
  ('participates_in', array['team_member'], array['work_session'],
    'Responsible Teammate participation in a work session', false),
  ('authored_from', array['message'], array['work_session'],
    'Immutable Server-recorded work-session message provenance', false),
  ('defaults_to_profile', array['team_member'], array['interaction_profile'],
    'Guarded future-spawn Interaction Profile default', false),
  ('selected_profile', array['work_session'], array['interaction_profile'],
    'Recorder-owned projection of the immutable runtime profile pin', false)
on conflict (type) do nothing;

alter table public.projects
  add column link_frozen boolean not null default false,
  add column active_link_count integer not null default 0,
  add constraint projects_active_link_count_check check (active_link_count >= 0);

-- -----------------------------------------------------------------------------
-- 2. Exact additive tables.  G0.1 requires interaction_profiles to exist before
--    spaces.default_interaction_profile_id is added as its typed FK.
-- -----------------------------------------------------------------------------
create table public.project_links (
  space_id         uuid not null references public.spaces(id) on delete cascade,
  project_id       uuid not null references public.projects(id) on delete restrict,
  project_entity_id uuid not null references public.entities(id) on delete cascade,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (space_id, project_id),
  unique (project_entity_id)
);
create index project_links_project_idx on public.project_links(project_id, space_id);

create table public.project_projection_details (
  entity_id            uuid primary key references public.entities(id) on delete cascade,
  project_id           uuid not null references public.projects(id) on delete restrict,
  materialized_version integer not null default 1 check (materialized_version >= 1),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index project_projection_details_project_idx
  on public.project_projection_details(project_id, entity_id);

create table public.space_menu_configs (
  space_id      uuid primary key references public.spaces(id) on delete cascade,
  schema_version integer not null check (schema_version >= 1),
  revision      integer not null check (revision >= 1),
  payload       jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.interaction_profiles (
  entity_id                    uuid primary key references public.entities(id) on delete cascade,
  status                       text not null default 'draft'
    check (status in ('draft','active','retired')),
  current_draft_version        integer not null default 1 check (current_draft_version >= 1),
  active_version               integer,
  active_hash                  text,
  generated_by_team_member_id  uuid references public.team_members(entity_id) on delete set null,
  retired_at                   timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint interaction_profiles_active_shape check (
    (active_version is null and active_hash is null)
    or (active_version is not null and active_version >= 1 and active_hash is not null)
  ),
  constraint interaction_profiles_retired_shape check (
    (status = 'retired' and retired_at is not null)
    or (status <> 'retired' and retired_at is null)
  )
);

-- G0.1 dependency order: the typed profile table above must precede this ALTER.
alter table public.spaces
  add column default_channel_id uuid references public.channels(entity_id) on delete set null,
  add column settings_revision integer not null default 1,
  add column default_interaction_profile_id uuid
    references public.interaction_profiles(entity_id) on delete restrict,
  add constraint spaces_settings_revision_check check (settings_revision >= 1);
create index spaces_default_interaction_profile_idx
  on public.spaces(default_interaction_profile_id)
  where default_interaction_profile_id is not null;
create index spaces_default_channel_idx
  on public.spaces(default_channel_id)
  where default_channel_id is not null;

create table public.interaction_profile_versions (
  profile_id        uuid not null references public.interaction_profiles(entity_id) on delete cascade,
  version           integer not null check (version >= 1),
  draft_json        jsonb not null check (jsonb_typeof(draft_json) = 'object'),
  validation_status text not null default 'unvalidated'
    check (validation_status in ('unvalidated','valid','invalid')),
  validated_hash    text,
  validation_json   jsonb check (validation_json is null or jsonb_typeof(validation_json) = 'object'),
  created_at        timestamptz not null default now(),
  primary key (profile_id, version),
  constraint interaction_profile_versions_validation_shape check (
    (validation_status = 'unvalidated' and validated_hash is null and validation_json is null)
    or (validation_status in ('valid','invalid') and validation_json is not null)
  )
);
create unique index interaction_profile_versions_validated_hash_idx
  on public.interaction_profile_versions(profile_id, validated_hash)
  where validated_hash is not null;

create table public.work_session_interaction_pins (
  work_session_id uuid not null references public.work_sessions(entity_id) on delete cascade,
  pin_revision    integer not null check (pin_revision >= 1),
  profile_id      uuid references public.interaction_profiles(entity_id) on delete restrict,
  profile_version integer,
  template_key    text not null check (char_length(btrim(template_key)) between 1 and 120),
  template_version integer not null check (template_version >= 1),
  resolved_hash   text not null check (char_length(resolved_hash) between 1 and 256),
  resolved_snapshot jsonb not null check (jsonb_typeof(resolved_snapshot) = 'object'),
  created_at      timestamptz not null default now(),
  primary key (work_session_id, pin_revision),
  unique (work_session_id, resolved_hash, pin_revision),
  constraint work_session_interaction_pins_profile_shape check (
    (profile_id is null and profile_version is null)
    or (profile_id is not null and profile_version is not null and profile_version >= 1)
  )
);
create index work_session_interaction_pins_profile_idx
  on public.work_session_interaction_pins(profile_id, profile_version)
  where profile_id is not null;

create table public.work_session_view_preferences (
  member_id       uuid not null references public.members(entity_id) on delete cascade,
  work_session_id uuid not null references public.work_sessions(entity_id) on delete cascade,
  content_surface text not null default 'terminal' check (content_surface in ('terminal','chat')),
  revision        integer not null default 1 check (revision >= 1),
  updated_at      timestamptz not null default now(),
  primary key (member_id, work_session_id)
);

create table public.session_wake_budgets (
  low_work_session_id  uuid not null references public.work_sessions(entity_id) on delete cascade,
  high_work_session_id uuid not null references public.work_sessions(entity_id) on delete cascade,
  consecutive_agent_wakes integer not null default 0
    check (consecutive_agent_wakes between 0 and 4),
  version             integer not null default 0 check (version >= 0),
  updated_at          timestamptz not null default now(),
  eligible_for_cleanup_at timestamptz,
  primary key (low_work_session_id, high_work_session_id),
  check (low_work_session_id < high_work_session_id)
);

create table public.session_message_deliveries (
  delivery_id            uuid primary key,
  message_id             uuid not null references public.messages(entity_id) on delete cascade,
  source_work_session_id uuid references public.work_sessions(entity_id) on delete restrict,
  target_work_session_id uuid not null references public.work_sessions(entity_id) on delete restrict,
  pair_low_session_id    uuid,
  pair_high_session_id   uuid,
  pair_budget_version    integer,
  status                 text not null check (status in (
    'pending','dispatching','delivered','failed_retryable','failed_permanent',
    'unknown','expired','cancelled')),
  attempt_no             integer not null default 1 check (attempt_no >= 1),
  failure_reason         text,
  reserved_at            timestamptz not null default now(),
  claimed_at             timestamptz,
  settled_at             timestamptz,
  updated_at             timestamptz not null default now(),
  unique (message_id, target_work_session_id, attempt_no),
  constraint session_message_deliveries_pair_shape check (
    (source_work_session_id is null and pair_low_session_id is null
      and pair_high_session_id is null and pair_budget_version is null)
    or (source_work_session_id is not null and pair_low_session_id is not null
      and pair_high_session_id is not null and pair_budget_version is not null
      and pair_low_session_id < pair_high_session_id)
  ),
  constraint session_message_deliveries_state_shape check (
    (status = 'pending' and claimed_at is null and settled_at is null)
    or (status = 'dispatching' and claimed_at is not null and settled_at is null)
    or (status in ('delivered','failed_retryable','failed_permanent','unknown','expired','cancelled')
      and settled_at is not null)
  )
);
create index session_message_deliveries_message_idx
  on public.session_message_deliveries(message_id, attempt_no, delivery_id);
create index session_message_deliveries_target_status_idx
  on public.session_message_deliveries(target_work_session_id, status, reserved_at, delivery_id);
create index session_message_deliveries_pair_active_idx
  on public.session_message_deliveries(pair_low_session_id, pair_high_session_id, status)
  where status in ('pending','dispatching');
create index session_message_deliveries_retention_idx
  on public.session_message_deliveries(settled_at)
  where settled_at is not null;

create table public.session_handoffs (
  handoff_id            uuid primary key,
  source_entity_id      uuid not null references public.entities(id) on delete restrict,
  target_work_session_id uuid not null references public.work_sessions(entity_id) on delete restrict,
  delivery_status       text not null check (delivery_status in
    ('prepared','dispatching','delivered','refused','unknown')),
  record_status         text not null check (record_status in
    ('pending','recorded','failed','withdrawn')),
  request_hash          text not null check (char_length(request_hash) between 1 and 256),
  source_snapshot       jsonb not null check (jsonb_typeof(source_snapshot) = 'object'),
  envelope_hash         text not null check (char_length(envelope_hash) between 1 and 256),
  source_missing        boolean not null default false,
  record_version        integer not null default 1 check (record_version >= 1),
  withdrawn_by          uuid references public.entities(id) on delete set null,
  withdrawn_at          timestamptz,
  withdraw_reason       text check (withdraw_reason is null or char_length(withdraw_reason) between 1 and 256),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint session_handoffs_legal_state check (
    (delivery_status in ('prepared','dispatching') and record_status = 'pending')
    or (delivery_status in ('delivered','refused','unknown')
      and record_status in ('pending','recorded','failed','withdrawn'))
  ),
  constraint session_handoffs_withdraw_shape check (
    (record_status = 'withdrawn' and withdrawn_by is not null and withdrawn_at is not null)
    or (record_status <> 'withdrawn' and withdrawn_by is null and withdrawn_at is null
      and withdraw_reason is null)
  )
);
create index session_handoffs_target_created_idx
  on public.session_handoffs(target_work_session_id, created_at desc, handoff_id desc);
create index session_handoffs_source_idx on public.session_handoffs(source_entity_id, created_at, handoff_id);

-- -----------------------------------------------------------------------------
-- 3. Exact additive columns and indexes on shipped tables.
-- -----------------------------------------------------------------------------
alter table public.messages add column message_batch_id text;
create index messages_batch_idx on public.messages(message_batch_id, entity_id)
  where message_batch_id is not null;

alter table public.notifications
  add column recipient_team_member_id uuid
    references public.team_members(entity_id) on delete cascade;
create index notifications_member_personal_cursor_idx
  on public.notifications(recipient_member_id, created_at desc, id desc)
  where recipient_team_member_id is null;
create index notifications_member_personal_unread_idx
  on public.notifications(recipient_member_id, created_at desc, id desc)
  where recipient_team_member_id is null and read_at is null;
create index notifications_teammate_cursor_idx
  on public.notifications(recipient_team_member_id, created_at desc, id desc)
  where recipient_team_member_id is not null;
create index notifications_teammate_unread_idx
  on public.notifications(recipient_team_member_id, created_at desc, id desc)
  where recipient_team_member_id is not null and read_at is null;

alter table public.activity
  add column work_session_id uuid references public.work_sessions(entity_id) on delete set null;
create index activity_work_session_created_idx
  on public.activity(work_session_id, created_at, id)
  where work_session_id is not null;

-- 001 already shipped edges.updated_at; the W1 migration retains it and adds
-- the type-leading indexes required by participant/provenance lookup.
create index edges_type_src_lookup_idx on public.edges(type, src_id, created_at, id);
create index edges_type_dst_lookup_idx on public.edges(type, dst_id, created_at, id);
create unique index edges_participates_pair_idx on public.edges(src_id, dst_id)
  where type = 'participates_in';
create unique index edges_authored_from_message_idx on public.edges(src_id)
  where type = 'authored_from';
create unique index edges_defaults_to_profile_source_idx on public.edges(src_id)
  where type = 'defaults_to_profile';
create unique index edges_selected_profile_source_idx on public.edges(src_id)
  where type = 'selected_profile';

-- Scratch is an additive execution mode; paths remain Server-computed.
alter table public.work_sessions drop constraint work_sessions_workdir_mode_check;
alter table public.work_sessions add constraint work_sessions_workdir_mode_check
  check (workdir_mode in ('project','worktree','scratch'));

-- -----------------------------------------------------------------------------
-- 4. Shared trigger helpers and typed/immutable-row guards.
-- -----------------------------------------------------------------------------
create or replace function internal.w1_writer() returns text
language sql stable as $$ select internal.claim_text('tm8.w1_writer') $$;

create or replace function internal.w1_set_writer(writer text) returns void
language sql set search_path = public, internal, pg_temp as $$
  select set_config('tm8.w1_writer', coalesce(writer, ''), true)
$$;

create or replace function internal.w1_audit(target_space uuid, audit_kind text, details jsonb)
returns void language sql set search_path = public, internal, pg_temp as $$
  insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
  values (target_space, internal.next_event_seq(target_space), 'migration.w1.audit',
          jsonb_build_object('kind', audit_kind, 'details', coalesce(details, '{}'::jsonb)),
          internal.claim_cmid())
$$;

create or replace function internal.validate_project_projection() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare e public.entities;
begin
  select * into e from public.entities where id = new.entity_id;
  if e.id is null or e.kind <> 'project' then
    raise exception 'project projection detail requires a project entity' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger project_projection_details_validate
before insert or update of entity_id on public.project_projection_details
for each row execute function internal.validate_project_projection();

create or replace function internal.validate_project_link() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare e public.entities; d public.project_projection_details;
begin
  select * into e from public.entities where id = new.project_entity_id;
  select * into d from public.project_projection_details where entity_id = new.project_entity_id;
  if e.id is null or e.kind <> 'project' or e.space_id <> new.space_id
     or d.entity_id is null or d.project_id <> new.project_id then
    raise exception 'project link must map a same-Space typed Project projection'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.space_id <> old.space_id
      or new.project_id <> old.project_id
      or new.project_entity_id <> old.project_entity_id
      or new.created_at <> old.created_at) then
    raise exception 'project link identity is immutable' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger project_links_validate before insert or update on public.project_links
for each row execute function internal.validate_project_link();
create trigger project_links_touch_updated_at before update on public.project_links
for each row execute function internal.touch_updated_at();
create trigger project_projection_details_touch_updated_at
before update on public.project_projection_details
for each row execute function internal.touch_updated_at();
create trigger space_menu_configs_touch_updated_at before update on public.space_menu_configs
for each row execute function internal.touch_updated_at();

create or replace function internal.validate_interaction_profile() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare e public.entities; generator public.entities;
begin
  select * into e from public.entities where id = new.entity_id;
  if e.id is null or e.kind <> 'interaction_profile' then
    raise exception 'interaction profile detail requires an interaction_profile entity'
      using errcode = '23514';
  end if;
  if new.generated_by_team_member_id is not null then
    select * into generator from public.entities where id = new.generated_by_team_member_id;
    if generator.id is null or generator.kind <> 'team_member' or generator.space_id <> e.space_id then
      raise exception 'interaction profile generator must be a same-Space team_member'
        using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if new.entity_id <> old.entity_id
       or new.generated_by_team_member_id is distinct from old.generated_by_team_member_id
       or new.created_at <> old.created_at then
      raise exception 'interaction profile identity and generator provenance are immutable'
        using errcode = '23514';
    end if;
    if new.current_draft_version < old.current_draft_version then
      raise exception 'interaction profile draft revision cannot move backwards'
        using errcode = '23514';
    end if;
    if old.status = 'retired' and new.status <> 'retired' then
      raise exception 'retired interaction profiles cannot be reactivated'
        using errcode = '23514', detail = 'profile_retired';
    end if;
    if new.status = 'retired' and old.status <> 'retired'
       and (exists (select 1 from public.spaces
                     where default_interaction_profile_id = new.entity_id)
         or exists (select 1 from public.edges
                     where type = 'defaults_to_profile' and dst_id = new.entity_id)) then
      raise exception 'Interaction Profile is still referenced by a default'
        using errcode = '23514', detail = 'profile_referenced_default';
    end if;
    if (new.status = 'active' or new.active_version is distinct from old.active_version
        or new.active_hash is distinct from old.active_hash)
       and not exists (
         select 1 from public.interaction_profile_versions version_row
          where version_row.profile_id = new.entity_id
            and version_row.version = new.active_version
            and version_row.validation_status = 'valid'
            and version_row.validated_hash = new.active_hash
       ) then
      raise exception 'Interaction Profile activation requires a matching valid immutable version'
        using errcode = '23514', detail = 'profile_not_validated';
    end if;
  end if;
  return new;
end
$$;
create trigger interaction_profiles_validate before insert or update on public.interaction_profiles
for each row execute function internal.validate_interaction_profile();
create trigger interaction_profiles_touch_updated_at before update on public.interaction_profiles
for each row execute function internal.touch_updated_at();

create or replace function internal.guard_interaction_profile_version() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare profile_entity public.entities;
begin
  select entity_row.* into profile_entity from public.entities entity_row
  join public.interaction_profiles profile_row on profile_row.entity_id = entity_row.id
  where profile_row.entity_id = new.profile_id;
  if profile_entity.id is null then
    raise exception 'profile version requires a typed interaction profile' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.profile_id <> old.profile_id or new.version <> old.version
       or new.draft_json is distinct from old.draft_json or new.created_at <> old.created_at then
      raise exception 'interaction profile version identity and draft are immutable'
        using errcode = '23514';
    end if;
    if old.validation_status <> 'unvalidated'
       and (new.validation_status is distinct from old.validation_status
         or new.validated_hash is distinct from old.validated_hash
         or new.validation_json is distinct from old.validation_json) then
      raise exception 'profile validation result is immutable' using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;
create trigger interaction_profile_versions_guard
before insert or update on public.interaction_profile_versions
for each row execute function internal.guard_interaction_profile_version();

create or replace function internal.guard_space_settings() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare channel_entity public.entities; profile_entity public.entities;
begin
  if tg_op = 'UPDATE' and (
       new.default_channel_id is distinct from old.default_channel_id
    or new.default_interaction_profile_id is distinct from old.default_interaction_profile_id
    or new.settings_revision is distinct from old.settings_revision
  ) and coalesce(internal.w1_writer(), '') <> 'space_settings' then
    raise exception 'Space settings are writable only through their settings RPCs'
      using errcode = '42501';
  end if;
  if new.default_channel_id is not null then
    select * into channel_entity from public.entities where id = new.default_channel_id;
    if channel_entity.id is null or channel_entity.kind <> 'channel'
       or channel_entity.space_id <> new.id or channel_entity.deleted_at is not null then
      raise exception 'default channel must be a live same-Space channel' using errcode = '23514';
    end if;
  end if;
  if new.default_interaction_profile_id is not null then
    select * into profile_entity from public.entities where id = new.default_interaction_profile_id;
    if profile_entity.id is null or profile_entity.kind <> 'interaction_profile'
       or profile_entity.space_id <> new.id or profile_entity.deleted_at is not null then
      raise exception 'default profile must be a live same-Space interaction profile'
        using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;
create trigger spaces_guard_settings
before insert or update of default_channel_id, default_interaction_profile_id, settings_revision
on public.spaces for each row execute function internal.guard_space_settings();

create or replace function internal.guard_launch_project() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.project_id is distinct from old.project_id then
    raise exception 'work_session launch project is immutable provenance'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger work_sessions_launch_project_immutable
before update of project_id on public.work_sessions
for each row execute function internal.guard_launch_project();

create or replace function internal.guard_message_envelope_identity() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if old.kind = 'message' and (
       new.space_id <> old.space_id or new.kind <> old.kind
    or new.parent_id is distinct from old.parent_id
    or new.created_by <> old.created_by or new.created_at <> old.created_at
  ) then
    raise exception 'message entity identity and reply parent are immutable'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger entities_message_identity_immutable
before update of space_id, kind, parent_id, created_by, created_at on public.entities
for each row execute function internal.guard_message_envelope_identity();

create or replace function internal.guard_message_batch_identity() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.message_batch_id is distinct from old.message_batch_id then
    raise exception 'message batch correlation is immutable' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger messages_batch_identity_immutable
before update of message_batch_id on public.messages
for each row execute function internal.guard_message_batch_identity();

create or replace function internal.guard_pin_snapshot() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare ws public.entities; profile public.entities;
begin
  if tg_op in ('UPDATE','DELETE') and coalesce(internal.w1_writer(), '') <> 'forward_compensation' then
    raise exception 'interaction profile pins are immutable; append a revision'
      using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  select * into ws from public.entities where id = new.work_session_id;
  if ws.id is null or ws.kind <> 'work_session' then
    raise exception 'profile pin target must be a work_session' using errcode = '23514';
  end if;
  if new.profile_id is not null then
    select * into profile from public.entities where id = new.profile_id;
    if profile.id is null or profile.kind <> 'interaction_profile'
       or profile.space_id <> ws.space_id then
      raise exception 'profile pin must reference a same-Space interaction profile'
        using errcode = '23514';
    end if;
    if not exists (select 1 from public.interaction_profile_versions v
                    where v.profile_id = new.profile_id and v.version = new.profile_version) then
      raise exception 'profile pin version does not exist' using errcode = '23503';
    end if;
  end if;
  return new;
end
$$;
create trigger work_session_interaction_pins_guard
before insert or update or delete on public.work_session_interaction_pins
for each row execute function internal.guard_pin_snapshot();

create or replace function internal.validate_view_preference() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare member_space uuid; session_space uuid;
begin
  select space_id into member_space from public.members where entity_id = new.member_id;
  select space_id into session_space from public.entities where id = new.work_session_id and kind = 'work_session';
  if member_space is null or session_space is null or member_space <> session_space then
    raise exception 'view preference endpoints must share one Space' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger work_session_view_preferences_validate
before insert or update on public.work_session_view_preferences
for each row execute function internal.validate_view_preference();

-- Graph origin/mutability is enforced independently of endpoint grammar.  The
-- public edge RPC cannot set tm8.w1_writer; only named definer functions and
-- recorder/materializer triggers do so.
create or replace function internal.guard_w1_edge() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  row_value public.edges;
  writer text := internal.w1_writer();
  src public.entities;
  dst public.entities;
  project_resource uuid;
  live_associations integer;
  session_state text;
begin
  if tg_op = 'DELETE' then row_value := old; else row_value := new; end if;
  select * into src from public.entities where id = row_value.src_id;
  select * into dst from public.entities where id = row_value.dst_id;

  -- A file->attached_to->message edge is message-owned even though attached_to
  -- remains generic for every other permitted endpoint pair.
  if row_value.type = 'attached_to' and src.kind = 'file' and dst.kind = 'message'
     and coalesce(writer, '') <> 'message_attachment' then
    raise exception 'message attachment edges are owned by message attachment commands'
      using errcode = '42501', detail = 'attachment_edge_owned';
  end if;

  if row_value.type in ('shared_into','authored_from','selected_profile','defaults_to_profile')
     and not (tg_op = 'DELETE' and coalesce(writer, '') = 'forward_compensation') then
    if (row_value.type = 'shared_into' and coalesce(writer, '') <> 'handoff_recorder')
       or (row_value.type = 'authored_from' and coalesce(writer, '') <> 'message_recorder')
       or (row_value.type = 'selected_profile' and coalesce(writer, '') <> 'profile_pin')
       or (row_value.type = 'defaults_to_profile' and coalesce(writer, '') <> 'profile_default') then
      raise exception 'edge type % is recorder/configuration owned', row_value.type
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.props ? 'origin' and coalesce(writer, '') = '' then
      raise exception 'edge props.origin is Server-owned' using errcode = '42501';
    end if;
    if new.type in ('in_project','participates_in') then
      new.props := new.props || jsonb_build_object('origin', coalesce(nullif(writer, ''), 'user'));
    elsif new.type in ('shared_into','authored_from','selected_profile','defaults_to_profile') then
      new.props := new.props || jsonb_build_object('origin', 'materialized');
    end if;
  elsif tg_op = 'UPDATE' then
    if new.props -> 'origin' is distinct from old.props -> 'origin'
       and coalesce(writer, '') not in ('project_correction','handoff_recorder','message_recorder','profile_pin','profile_default') then
      raise exception 'edge props.origin is Server-owned' using errcode = '42501';
    end if;
  end if;

  -- PR/commit materialized associations are repair-command owned.  Task and
  -- work_session user/backfill associations remain ordinarily mutable.
  if tg_op in ('UPDATE','DELETE') and old.type = 'in_project'
     and src.kind in ('pull_request','commit') and old.props ->> 'origin' = 'materialized'
     and coalesce(writer, '') not in ('project_correction','forward_compensation') then
    raise exception 'materialized Project association requires correction command'
      using errcode = '42501';
  end if;

  -- Removing a participant serializes on the session and every participant edge.
  if tg_op in ('UPDATE','DELETE') and old.type = 'participates_in'
     and (tg_op = 'DELETE' or new.type <> old.type or new.dst_id <> old.dst_id) then
    perform 1 from public.work_sessions where entity_id = old.dst_id for update;
    perform 1 from public.edges
      where type = 'participates_in' and dst_id = old.dst_id
      order by id for update;
    select status into session_state from public.work_sessions where entity_id = old.dst_id;
    if session_state in ('spawning','running','idle')
       and (select count(*) from public.edges
             where type = 'participates_in' and dst_id = old.dst_id) <= 1 then
      raise exception 'a live work session must retain one participant'
        using errcode = '23514';
    end if;
  end if;

  if tg_op in ('INSERT','UPDATE') and new.type = 'in_project'
     and (tg_op = 'INSERT' or new.src_id <> old.src_id or new.dst_id <> old.dst_id
          or new.type <> old.type) then
    select project_id into project_resource
      from public.project_projection_details where entity_id = new.dst_id;
    if project_resource is null then
      raise exception 'Project projection has no resource mapping'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
    perform 1 from public.projects where id = project_resource for update;
    perform 1 from public.spaces where id = new.space_id for update;
    if not exists (select 1 from public.space_projects
                    where space_id = new.space_id and project_id = project_resource)
       or dst.deleted_at is not null
       or not exists (select 1 from public.project_links
                       where space_id = new.space_id and project_id = project_resource
                         and project_entity_id = new.dst_id) then
      raise exception 'Project is not actively linked to this Space'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
    if src.kind = 'work_session' and src.deleted_at is null then
      select count(*) into live_associations
        from public.edges edge
        join public.entities projection on projection.id = edge.dst_id
       where edge.src_id = new.src_id and edge.type = 'in_project'
         and projection.deleted_at is null and edge.id is distinct from new.id;
      if live_associations >= 16 then
        raise exception 'work session Project association cap reached'
          using errcode = '53400', detail = 'project_association_cap';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
create trigger edges_w1_guard
before insert or update or delete on public.edges
for each row execute function internal.guard_w1_edge();

-- Delivery identity and state transitions are immutable even to future RPCs.
create or replace function internal.guard_session_message_delivery() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare message_space uuid; source_space uuid; target_space uuid;
begin
  if tg_op = 'UPDATE' then
    if new.delivery_id <> old.delivery_id or new.message_id <> old.message_id
       or new.source_work_session_id is distinct from old.source_work_session_id
       or new.target_work_session_id <> old.target_work_session_id
       or new.pair_low_session_id is distinct from old.pair_low_session_id
       or new.pair_high_session_id is distinct from old.pair_high_session_id
       or new.pair_budget_version is distinct from old.pair_budget_version
       or new.attempt_no <> old.attempt_no or new.reserved_at <> old.reserved_at then
      raise exception 'delivery reservation identity is immutable' using errcode = '23514';
    end if;
    if not (
      new.status = old.status
      or (old.status = 'pending' and new.status in
        ('dispatching','failed_permanent','expired','cancelled'))
      or (old.status = 'dispatching' and new.status in
        ('delivered','failed_retryable','failed_permanent','unknown'))
    ) then
      raise exception 'illegal delivery transition % -> %', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  select e.space_id into message_space from public.messages m
    join public.entities e on e.id = m.entity_id where m.entity_id = new.message_id;
  select e.space_id into target_space from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id where ws.entity_id = new.target_work_session_id;
  if new.source_work_session_id is not null then
    select e.space_id into source_space from public.work_sessions ws
      join public.entities e on e.id = ws.entity_id where ws.entity_id = new.source_work_session_id;
  end if;
  if message_space is null or target_space is null or message_space <> target_space
     or (new.source_work_session_id is not null and source_space <> target_space)
     or new.source_work_session_id = new.target_work_session_id then
    raise exception 'delivery message and sessions must be distinct same-Space endpoints'
      using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger session_message_deliveries_guard
before insert or update on public.session_message_deliveries
for each row execute function internal.guard_session_message_delivery();

create or replace function internal.validate_wake_budget() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare low_space uuid; high_space uuid;
begin
  select e.space_id into low_space from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id where ws.entity_id = new.low_work_session_id;
  select e.space_id into high_space from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id where ws.entity_id = new.high_work_session_id;
  if low_space is null or high_space is null or low_space <> high_space then
    raise exception 'wake-budget sessions must share one Space' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger session_wake_budgets_validate
before insert or update on public.session_wake_budgets
for each row execute function internal.validate_wake_budget();

create or replace function internal.guard_session_handoff() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare source_space uuid; target_space uuid;
begin
  if tg_op = 'UPDATE' then
    if new.handoff_id <> old.handoff_id or new.source_entity_id <> old.source_entity_id
       or new.target_work_session_id <> old.target_work_session_id
       or new.request_hash <> old.request_hash
       or new.source_snapshot is distinct from old.source_snapshot
       or new.envelope_hash <> old.envelope_hash or new.created_at <> old.created_at then
      raise exception 'handoff request identity and first-attempt facts are immutable'
        using errcode = '23514';
    end if;
    if not (new.delivery_status = old.delivery_status
      or (old.delivery_status = 'prepared' and new.delivery_status = 'dispatching')
      or (old.delivery_status = 'dispatching'
        and new.delivery_status in ('delivered','refused','unknown'))) then
      raise exception 'illegal handoff delivery transition % -> %', old.delivery_status, new.delivery_status
        using errcode = '23514';
    end if;
    if not (new.record_status = old.record_status
      or (old.record_status = 'pending' and new.record_status in ('recorded','failed'))
      or (old.record_status = 'recorded' and new.record_status = 'withdrawn')) then
      raise exception 'illegal handoff record transition % -> %', old.record_status, new.record_status
        using errcode = '23514';
    end if;
    if new.record_status <> old.record_status and new.record_version <> old.record_version + 1 then
      raise exception 'handoff record transition must advance record_version once'
        using errcode = '23514';
    end if;
  end if;
  select space_id into source_space from public.entities where id = new.source_entity_id;
  select e.space_id into target_space from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id where ws.entity_id = new.target_work_session_id;
  if source_space is null or target_space is null or source_space <> target_space then
    raise exception 'handoff source and target session must share one Space'
      using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger session_handoffs_guard
before insert or update on public.session_handoffs
for each row execute function internal.guard_session_handoff();

create or replace function internal.validate_notification_teammate() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare teammate_space uuid; owner_id uuid;
begin
  if new.recipient_team_member_id is null then return new; end if;
  select e.space_id, tm.owner_member_id into teammate_space, owner_id
    from public.team_members tm join public.entities e on e.id = tm.entity_id
   where tm.entity_id = new.recipient_team_member_id;
  if teammate_space is null or teammate_space <> new.space_id
     or owner_id <> new.recipient_member_id then
    raise exception 'Teammate notification must retain its same-Space owner routing Member'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger notifications_validate_teammate
before insert or update of recipient_member_id, recipient_team_member_id, space_id
on public.notifications for each row execute function internal.validate_notification_teammate();

create or replace function internal.validate_activity_work_session() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare session_space uuid;
begin
  if new.work_session_id is null then return new; end if;
  select e.space_id into session_space from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id where ws.entity_id = new.work_session_id;
  if session_space is null or session_space <> new.space_id then
    raise exception 'activity work-session provenance must be same-Space'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger activity_validate_work_session
before insert or update of work_session_id, space_id on public.activity
for each row execute function internal.validate_activity_work_session();

-- -----------------------------------------------------------------------------
-- 5. ProjectResource lock/materializer foundation and core profile pinning.
-- -----------------------------------------------------------------------------
create or replace function internal.guard_project_entity_lifecycle() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if tg_op = 'INSERT' and new.kind = 'project' and coalesce(internal.w1_writer(), '') <> 'project_materializer' then
    raise exception 'Project projections are materializer-owned' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.kind = 'project'
     and (new.space_id <> old.space_id or new.kind <> old.kind
       or new.parent_id is distinct from old.parent_id
       or new.deleted_at is distinct from old.deleted_at)
     and coalesce(internal.w1_writer(), '') not in ('project_materializer','forward_compensation') then
    raise exception 'Project projection lifecycle is materializer-owned' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger entities_project_lifecycle_guard
before insert or update on public.entities
for each row execute function internal.guard_project_entity_lifecycle();

create or replace function internal.w1_projection_actor(target_space uuid, target_project uuid)
returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(
    (select sp.linked_by from public.space_projects sp
      where sp.space_id = target_space and sp.project_id = target_project),
    (select m.entity_id from public.members m where m.space_id = target_space
      order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.joined_at, m.entity_id
      limit 1)
  )
$$;

create or replace function internal.materialize_project_projection(
  target_space uuid, target_project uuid, audit_mutation boolean default true
) returns uuid language plpgsql set search_path = public, internal, pg_temp as $$
declare
  actor uuid;
  projection_id uuid;
  projection_was_deleted boolean := false;
  changed boolean := false;
begin
  -- Universal ProjectResource -> sorted Spaces order.  This helper handles one
  -- Space; multi-Space callers invoke it in ascending UUID order.
  perform 1 from public.projects where id = target_project for update;
  perform 1 from public.spaces where id = target_space for update;
  if not exists (select 1 from public.space_projects
                  where space_id = target_space and project_id = target_project) then
    return null;
  end if;
  actor := internal.w1_projection_actor(target_space, target_project);
  if actor is null then
    perform internal.w1_audit(target_space, 'project_projection_skipped_no_actor',
      jsonb_build_object('projectId', target_project));
    return null;
  end if;

  select link.project_entity_id, entity_row.deleted_at is not null
    into projection_id, projection_was_deleted
    from public.project_links link
    join public.entities entity_row on entity_row.id = link.project_entity_id
   where link.space_id = target_space and link.project_id = target_project;
  perform internal.w1_set_writer('project_materializer');
  if projection_id is null then
    projection_id := internal.new_id();
    insert into public.entities(id, space_id, kind, parent_id, position, created_by)
    values (projection_id, target_space, 'project', null, null, actor);
    insert into public.project_projection_details(entity_id, project_id, materialized_version)
    values (projection_id, target_project, 1);
    insert into public.project_links(space_id, project_id, project_entity_id)
    values (target_space, target_project, projection_id);
    changed := true;
  elsif projection_was_deleted then
    update public.entities
       set deleted_at = null, activity_at = now(), updated_at = now()
     where id = projection_id and deleted_at is not null;
    update public.project_projection_details
       set materialized_version = materialized_version + 1
     where entity_id = projection_id;
    changed := true;
  end if;
  perform internal.w1_set_writer(null);
  if audit_mutation and changed then
    perform internal.w1_audit(target_space, 'project_projection_materialized',
      jsonb_build_object('projectId', target_project, 'projectEntityId', projection_id));
  end if;
  return projection_id;
end
$$;

create or replace function internal.guard_space_project_link() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare active_count integer; frozen boolean; projection_id uuid;
begin
  if tg_op = 'INSERT' then
    select p.active_link_count, p.link_frozen into active_count, frozen
      from public.projects p where p.id = new.project_id for update;
    if active_count is null then
      raise exception 'Project not found' using errcode = 'P0002';
    end if;
    perform 1 from public.spaces where id = new.space_id for update;
    if frozen or active_count >= 16 then
      raise exception 'Project active-link cap reached'
        using errcode = '53400', detail = 'project_over_cap';
    end if;
    return new;
  end if;

  perform 1 from public.projects where id = old.project_id for update;
  perform 1 from public.spaces where id = old.space_id for update;
  select project_entity_id into projection_id from public.project_links
   where space_id = old.space_id and project_id = old.project_id;
  if exists (
    select 1 from public.work_sessions ws
    join public.entities session_entity on session_entity.id = ws.entity_id
    where session_entity.space_id = old.space_id
      and session_entity.deleted_at is null
      and ws.status in ('spawning','running','idle')
      and (ws.project_id = old.project_id
        or exists (select 1 from public.edges edge
                    where edge.src_id = ws.entity_id and edge.dst_id = projection_id
                      and edge.type = 'in_project'))
  ) then
    raise exception 'Project has a live launch root or association in this Space'
      using errcode = '23514', detail = 'project_not_linked';
  end if;
  return old;
end
$$;
create trigger space_projects_w1_lock_guard
before insert or delete on public.space_projects
for each row execute function internal.guard_space_project_link();

create or replace function internal.after_space_project_link() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare projection_id uuid; remaining integer;
begin
  if tg_op = 'INSERT' then
    projection_id := internal.materialize_project_projection(new.space_id, new.project_id, true);
    select count(*) into remaining from public.space_projects where project_id = new.project_id;
    update public.projects set active_link_count = remaining where id = new.project_id;
    return new;
  end if;

  select project_entity_id into projection_id from public.project_links
   where space_id = old.space_id and project_id = old.project_id;
  perform internal.w1_set_writer('project_materializer');
  update public.entities set deleted_at = coalesce(deleted_at, now()), activity_at = now(), updated_at = now()
   where id = projection_id;
  perform internal.w1_set_writer(null);
  select count(*) into remaining from public.space_projects where project_id = old.project_id;
  update public.projects
     set active_link_count = remaining,
         link_frozen = case when remaining <= 16 then false else link_frozen end
   where id = old.project_id;
  perform internal.w1_audit(old.space_id, 'project_projection_unlinked',
    jsonb_build_object('projectId', old.project_id, 'projectEntityId', projection_id));
  return old;
end
$$;
create trigger space_projects_w1_materialize
after insert or delete on public.space_projects
for each row execute function internal.after_space_project_link();

create or replace function internal.guard_frozen_project_update() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if old.link_frozen then
    raise exception 'Project is frozen above the active-link cap'
      using errcode = '53400', detail = 'project_over_cap';
  end if;
  perform 1 from public.spaces s
    join public.space_projects sp on sp.space_id = s.id
   where sp.project_id = old.id order by s.id for update;
  return new;
end
$$;
create trigger projects_w1_update_lock
before update of name, repo_url, working_dir, trust, defaults on public.projects
for each row execute function internal.guard_frozen_project_update();

create or replace function internal.sync_project_projections() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  update public.project_projection_details d
     set materialized_version = materialized_version + 1
    from public.project_links l
   where l.project_id = new.id and l.project_entity_id = d.entity_id
     and exists (select 1 from public.space_projects sp
                  where sp.space_id = l.space_id and sp.project_id = l.project_id);
  update public.entities e set activity_at = now(), updated_at = now()
    from public.project_links l
   where l.project_id = new.id and l.project_entity_id = e.id
     and e.deleted_at is null;
  return new;
end
$$;
create trigger projects_w1_sync_projections
after update of name, repo_url, working_dir, trust, defaults on public.projects
for each row execute function internal.sync_project_projections();

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"home","label":"Home","items":[
      {"type":"view","ref":"dashboard"},{"type":"view","ref":"feed"},
      {"type":"view","ref":"inbox"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"team_member"}]}]},
    {"id":"tracking","label":"Tracking","items":[
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"}]},
    {"id":"collab","label":"Collab","items":[{"type":"kind","ref":"member"}]},
    {"id":"channels","label":"Channels","items":[{"type":"view","ref":"channels"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb
$$;

create or replace function internal.w1_core_pin_snapshot() returns jsonb
language sql immutable parallel safe as $$
  select jsonb_build_object(
    'profile', jsonb_build_object('source','core_default'),
    'template', jsonb_build_object('key','core','version',1,'schemaVersion',1),
    'feedPolicy', jsonb_build_object('scope','session_chat_v1','pageSize',50,'bodyExcerptBytes',4096),
    'providerCaptureMode','explicit-only',
    'terminal', jsonb_build_object('alwaysAvailable',true),
    'composerPolicy', jsonb_build_object('mode','stored_first'))
$$;

create or replace function internal.ensure_core_interaction_pin(target_session uuid)
returns integer language plpgsql set search_path = public, internal, pg_temp as $$
declare next_revision integer;
begin
  if exists (select 1 from public.work_session_interaction_pins where work_session_id = target_session) then
    return (select max(pin_revision) from public.work_session_interaction_pins
             where work_session_id = target_session);
  end if;
  select coalesce(max(pin_revision), 0) + 1 into next_revision
    from public.work_session_interaction_pins where work_session_id = target_session;
  perform internal.w1_set_writer('profile_pin');
  insert into public.work_session_interaction_pins(
    work_session_id, pin_revision, profile_id, profile_version,
    template_key, template_version, resolved_hash, resolved_snapshot)
  values (target_session, next_revision, null, null, 'core', 1,
          'core-profile-v1', internal.w1_core_pin_snapshot());
  perform internal.w1_set_writer(null);
  return next_revision;
end
$$;

create or replace function internal.after_work_session_insert_w1() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare projection_id uuid; session_space uuid; actor uuid;
begin
  perform internal.ensure_core_interaction_pin(new.entity_id);
  if new.project_id is not null then
    select e.space_id, e.created_by into session_space, actor
      from public.entities e where e.id = new.entity_id;
    select l.project_entity_id into projection_id from public.project_links l
      join public.entities projection on projection.id = l.project_entity_id
     where l.space_id = session_space and l.project_id = new.project_id
       and projection.deleted_at is null
       and exists (select 1 from public.space_projects sp
                    where sp.space_id = l.space_id and sp.project_id = l.project_id);
    if projection_id is not null then
      perform internal.w1_set_writer('spawn');
      insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
      values (session_space, new.entity_id, projection_id, 'in_project', '{}'::jsonb, actor)
      on conflict (src_id, dst_id, type) do nothing;
      perform internal.w1_set_writer(null);
    end if;
  end if;
  return new;
end
$$;
create trigger work_sessions_w1_after_insert
after insert on public.work_sessions
for each row execute function internal.after_work_session_insert_w1();

-- -----------------------------------------------------------------------------
-- 6. Space settings/profile-default RPCs.  A03 and A20 serialize on the same
--    spaces row and consume the same settings_revision.
-- -----------------------------------------------------------------------------
create or replace function internal.require_human_space_admin(target_space uuid)
returns uuid language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare member_id uuid; effective_actor uuid;
begin
  perform internal.require_identity();
  if internal.acting_as() is not null then
    raise exception 'Interaction Profile configuration requires a human principal'
      using errcode = '42501', detail = 'profile_principal_required';
  end if;
  member_id := internal.current_member_id(target_space);
  effective_actor := internal.actor_id();
  if member_id is null or (effective_actor is not null and effective_actor <> member_id)
     or not exists (select 1 from public.members
                     where entity_id = member_id and space_id = target_space
                       and role in ('owner','admin')) then
    raise exception 'Space owner/admin human principal required'
      using errcode = '42501', detail = 'profile_principal_required';
  end if;
  return member_id;
end
$$;

create or replace function public.set_space_default_channel(
  p_space_id uuid, p_channel_id uuid, p_expected_settings_revision integer,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; current_revision integer; current_channel uuid; channel_entity public.entities;
declare result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.defaultChannel.set');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  select settings_revision, default_channel_id into current_revision, current_channel
    from public.spaces where id = p_space_id for update;
  if current_revision is null then raise exception 'Space not found' using errcode = 'P0002'; end if;
  if current_revision <> p_expected_settings_revision then
    raise exception 'Space settings revision conflict' using errcode = '40001',
      detail = jsonb_build_object('currentRevision', current_revision)::text;
  end if;
  if p_channel_id is not null then
    select * into channel_entity from public.entities where id = p_channel_id;
    if channel_entity.id is null or channel_entity.kind <> 'channel'
       or channel_entity.space_id <> p_space_id or channel_entity.deleted_at is not null
       or not internal.entity_readable(p_channel_id) then
      raise exception 'channel not found' using errcode = 'P0002';
    end if;
  end if;
  if current_channel is distinct from p_channel_id then
    perform internal.w1_set_writer('space_settings');
    update public.spaces
       set default_channel_id = p_channel_id, settings_revision = settings_revision + 1
     where id = p_space_id
     returning settings_revision into current_revision;
    perform internal.w1_set_writer(null);
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (p_space_id, internal.next_event_seq(p_space_id), 'space.default_channel.updated',
      jsonb_build_object('spaceId', p_space_id, 'channelId', p_channel_id,
                         'settingsRevision', current_revision), p_client_mutation_id);
  end if;
  result := jsonb_build_object('spaceId', p_space_id, 'defaultChannelId', p_channel_id,
    'settingsRevision', current_revision, 'patches', '[]'::jsonb);
  return internal.ledger_record(p_client_mutation_id, 'spaces.defaultChannel.set', result);
end
$$;

create or replace function public.set_space_profile_default(
  p_space_id uuid, p_profile_id uuid, p_expected_settings_revision integer,
  p_confirm_agent_generated boolean default false,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  member_id uuid;
  profile_entity public.entities;
  profile_detail public.interaction_profiles;
  profile_version public.interaction_profile_versions;
  current_revision integer;
  current_profile uuid;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.interactionProfile.setDefault');
  if replay is not null then return replay; end if;
  member_id := internal.require_human_space_admin(p_space_id);

  -- Non-null A20 order is profile entity -> selected active version -> Space.
  if p_profile_id is not null then
    select * into profile_entity from public.entities where id = p_profile_id for update;
    select * into profile_detail from public.interaction_profiles where entity_id = p_profile_id;
    if profile_entity.id is null or profile_detail.entity_id is null
       or profile_entity.kind <> 'interaction_profile'
       or profile_entity.space_id <> p_space_id or profile_entity.deleted_at is not null
       or profile_entity.visibility <> 'space' or not internal.entity_readable(p_profile_id) then
      raise exception 'Interaction Profile not found' using errcode = 'P0002';
    end if;
    if profile_detail.retired_at is not null or profile_detail.status = 'retired' then
      raise exception 'Interaction Profile is retired'
        using errcode = '23514', detail = 'profile_retired';
    end if;
    if profile_detail.active_version is null or profile_detail.active_hash is null then
      raise exception 'Interaction Profile is not validated and active'
        using errcode = '23514', detail = 'profile_not_validated';
    end if;
    select * into profile_version from public.interaction_profile_versions
     where profile_id = p_profile_id and version = profile_detail.active_version for update;
    if profile_version.profile_id is null or profile_version.validation_status <> 'valid'
       or profile_version.validated_hash is distinct from profile_detail.active_hash then
      raise exception 'Interaction Profile validation/hash does not match the active version'
        using errcode = '23514', detail = 'profile_not_validated';
    end if;
    if profile_detail.generated_by_team_member_id is not null
       and not coalesce(p_confirm_agent_generated, false) then
      raise exception 'Agent-generated Space default requires explicit human confirmation'
        using errcode = '42501', detail = 'profile_principal_required';
    end if;
  end if;

  select settings_revision, default_interaction_profile_id
    into current_revision, current_profile
    from public.spaces where id = p_space_id for update;
  if current_revision is null then raise exception 'Space not found' using errcode = 'P0002'; end if;
  if current_revision <> p_expected_settings_revision then
    raise exception 'Space settings revision conflict' using errcode = '40001',
      detail = jsonb_build_object('currentRevision', current_revision)::text;
  end if;

  if current_profile is distinct from p_profile_id then
    perform internal.w1_set_writer('space_settings');
    update public.spaces
       set default_interaction_profile_id = p_profile_id,
           settings_revision = settings_revision + 1
     where id = p_space_id
     returning settings_revision into current_revision;
    perform internal.w1_set_writer(null);
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (p_space_id, internal.next_event_seq(p_space_id),
      'interaction_profile.default_updated',
      jsonb_build_object('spaceId', p_space_id, 'profileId', p_profile_id,
                         'settingsRevision', current_revision, 'selectedBy', member_id),
      p_client_mutation_id);
  end if;
  result := jsonb_build_object('spaceId', p_space_id,
    'defaultInteractionProfileId', p_profile_id,
    'settingsRevision', current_revision, 'patches', '[]'::jsonb);
  return internal.ledger_record(p_client_mutation_id,
    'spaces.interactionProfile.setDefault', result);
end
$$;

create or replace function public.set_space_menu_config(
  p_space_id uuid, p_schema_version integer, p_payload jsonb,
  p_expected_revision integer, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; current_revision integer; current_schema integer; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.menu.update');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  perform 1 from public.spaces where id = p_space_id for update;
  select revision, schema_version into current_revision, current_schema
    from public.space_menu_configs where space_id = p_space_id for update;
  if current_revision is null then
    if p_expected_revision <> 0 then
      raise exception 'Menu revision conflict' using errcode = '40001',
        detail = jsonb_build_object('currentRevision', 0, 'reason', 'menu_revision_conflict')::text;
    end if;
    insert into public.space_menu_configs(space_id, schema_version, revision, payload)
    values (p_space_id, p_schema_version, 1, p_payload)
    returning revision into current_revision;
  else
    if current_schema > 1 then
      raise exception 'Menu schema requires a newer client' using errcode = '40001',
        detail = 'menu_upgrade_required';
    end if;
    if current_revision <> p_expected_revision then
      raise exception 'Menu revision conflict' using errcode = '40001',
        detail = jsonb_build_object('currentRevision', current_revision,
          'reason', 'menu_revision_conflict')::text;
    end if;
    update public.space_menu_configs
       set schema_version = p_schema_version, revision = revision + 1, payload = p_payload
     where space_id = p_space_id returning revision into current_revision;
  end if;
  result := jsonb_build_object('schemaVersion', p_schema_version,
    'revision', current_revision, 'payload', p_payload, 'patches', '[]'::jsonb);
  insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
  values (p_space_id, internal.next_event_seq(p_space_id), 'menu.updated', result, p_client_mutation_id);
  return internal.ledger_record(p_client_mutation_id, 'spaces.menu.update', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 7. Closed three-RPC delivery role surface and universal pair budget.
-- -----------------------------------------------------------------------------
create or replace function internal.require_delivery_principal(
  expected_delivery uuid, expected_message uuid, expected_target uuid,
  expected_budget_version integer default null
) returns void language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare expires_at timestamptz;
begin
  if session_user <> 'tm8_delivery_worker'
     and coalesce(current_setting('role', true), '') <> 'tm8_delivery_worker' then
    raise exception 'system delivery adapter database role required' using errcode = '42501';
  end if;
  if internal.claim_text('tm8.principal_type') <> 'system_delivery_adapter'
     or nullif(internal.claim_text('tm8.delivery_id'), '')::uuid is distinct from expected_delivery
     or nullif(internal.claim_text('tm8.delivery_message_id'), '')::uuid is distinct from expected_message
     or nullif(internal.claim_text('tm8.delivery_target_work_session_id'), '')::uuid
          is distinct from expected_target then
    raise exception 'delivery principal tuple mismatch' using errcode = '42501';
  end if;
  if expected_budget_version is not null
     and nullif(internal.claim_text('tm8.delivery_pair_budget_version'), '')::integer
          is distinct from expected_budget_version then
    raise exception 'delivery reservation version mismatch' using errcode = '42501';
  end if;
  expires_at := nullif(internal.claim_text('tm8.delivery_expires_at'), '')::timestamptz;
  if expires_at is null or expires_at <= now() then
    raise exception 'delivery principal expired' using errcode = '42501';
  end if;
  if internal.actor_id() is not null or internal.acting_as() is not null then
    raise exception 'delivery principal cannot carry actor claims' using errcode = '42501';
  end if;
end
$$;

create or replace function public.reserve_session_message_delivery(
  p_delivery_id uuid, p_message_id uuid, p_target_work_session_id uuid,
  p_attempt_no integer default 1
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  source_session uuid;
  author_kind text;
  low_session uuid;
  high_session uuid;
  budget public.session_wake_budgets;
  delivery public.session_message_deliveries;
begin
  perform internal.require_delivery_principal(
    p_delivery_id, p_message_id, p_target_work_session_id, null);
  select author.kind into author_kind from public.messages m
    join public.entities author on author.id = m.author_id
   where m.entity_id = p_message_id;
  if author_kind is null then raise exception 'message not found' using errcode = 'P0002'; end if;
  select edge.dst_id into source_session from public.edges edge
   where edge.src_id = p_message_id and edge.type = 'authored_from';
  if author_kind = 'team_member' and source_session is null then
    raise exception 'Teammate delivery requires immutable source-session provenance'
      using errcode = '23514';
  end if;
  if source_session = p_target_work_session_id then
    raise exception 'self-contact is forbidden' using errcode = '42501',
      detail = 'session_contact_forbidden';
  end if;

  if source_session is not null then
    low_session := least(source_session, p_target_work_session_id);
    high_session := greatest(source_session, p_target_work_session_id);
    insert into public.session_wake_budgets(low_work_session_id, high_work_session_id)
    values (low_session, high_session) on conflict do nothing;
    select * into budget from public.session_wake_budgets
     where low_work_session_id = low_session and high_work_session_id = high_session
     for update;
    if budget.consecutive_agent_wakes = 4 then
      insert into public.session_message_deliveries(
        delivery_id, message_id, source_work_session_id, target_work_session_id,
        pair_low_session_id, pair_high_session_id, pair_budget_version,
        status, attempt_no, failure_reason, settled_at)
      values (p_delivery_id, p_message_id, source_session, p_target_work_session_id,
        low_session, high_session, budget.version, 'failed_permanent', p_attempt_no,
        'automated_wake_limit', now())
      returning * into delivery;
      return to_jsonb(delivery);
    end if;
    update public.session_wake_budgets
       set consecutive_agent_wakes = consecutive_agent_wakes + 1,
           version = version + 1,
           eligible_for_cleanup_at = null
     where low_work_session_id = low_session and high_work_session_id = high_session
     returning * into budget;
  end if;

  insert into public.session_message_deliveries(
    delivery_id, message_id, source_work_session_id, target_work_session_id,
    pair_low_session_id, pair_high_session_id, pair_budget_version,
    status, attempt_no)
  values (p_delivery_id, p_message_id, source_session, p_target_work_session_id,
    low_session, high_session, case when source_session is null then null else budget.version end,
    'pending', p_attempt_no)
  returning * into delivery;
  return to_jsonb(delivery);
end
$$;

create or replace function public.claim_session_message_delivery(
  p_delivery_id uuid, p_message_id uuid, p_target_work_session_id uuid,
  p_pair_budget_version integer default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare delivery public.session_message_deliveries;
begin
  perform internal.require_delivery_principal(
    p_delivery_id, p_message_id, p_target_work_session_id, p_pair_budget_version);
  select * into delivery from public.session_message_deliveries
   where delivery_id = p_delivery_id for update;
  if delivery.delivery_id is null or delivery.message_id <> p_message_id
     or delivery.target_work_session_id <> p_target_work_session_id
     or delivery.pair_budget_version is distinct from p_pair_budget_version then
    raise exception 'delivery reservation not found' using errcode = 'P0002';
  end if;
  if delivery.status = 'pending' then
    update public.session_message_deliveries
       set status = 'dispatching', claimed_at = now()
     where delivery_id = p_delivery_id returning * into delivery;
  elsif delivery.status <> 'dispatching' then
    raise exception 'delivery cannot be claimed from status %', delivery.status using errcode = '23514';
  end if;
  return to_jsonb(delivery);
end
$$;

create or replace function public.settle_session_message_delivery(
  p_delivery_id uuid, p_message_id uuid, p_target_work_session_id uuid,
  p_pair_budget_version integer, p_status text, p_failure_reason text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare delivery public.session_message_deliveries;
begin
  perform internal.require_delivery_principal(
    p_delivery_id, p_message_id, p_target_work_session_id, p_pair_budget_version);
  if p_status not in ('delivered','failed_retryable','failed_permanent','unknown') then
    raise exception 'invalid delivery settlement status' using errcode = '22023';
  end if;
  select * into delivery from public.session_message_deliveries
   where delivery_id = p_delivery_id for update;
  if delivery.delivery_id is null or delivery.message_id <> p_message_id
     or delivery.target_work_session_id <> p_target_work_session_id
     or delivery.pair_budget_version is distinct from p_pair_budget_version then
    raise exception 'delivery reservation not found' using errcode = 'P0002';
  end if;
  if delivery.status = 'dispatching' then
    update public.session_message_deliveries
       set status = p_status, failure_reason = p_failure_reason, settled_at = now()
     where delivery_id = p_delivery_id returning * into delivery;
  elsif delivery.status <> p_status then
    raise exception 'delivery cannot settle from status %', delivery.status using errcode = '23514';
  end if;
  return to_jsonb(delivery);
end
$$;

-- Member reset is an application RPC, not part of the delivery worker allowlist.
-- It derives the unordered pair solely from immutable reply/delivery provenance.
create or replace function public.reset_session_wake_budget_for_member_reply(
  p_reply_message_id uuid, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; parent_id uuid; author_id uuid; pair record; pair_count integer; author public.entities;
declare result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'messages.delivery.memberReset');
  if replay is not null then return replay; end if;
  select e.parent_id, m.author_id into parent_id, author_id
    from public.entities e
    join public.messages m on m.entity_id = e.id
   where e.id = p_reply_message_id;
  select * into author from public.entities where id = author_id;
  if parent_id is null or author.kind <> 'member' then
    result := jsonb_build_object('reset', false, 'patches', '[]'::jsonb);
    return internal.ledger_record(p_client_mutation_id,
      'messages.delivery.memberReset', result);
  end if;
  perform internal.require_space_member(author.space_id);
  select count(distinct (d.pair_low_session_id, d.pair_high_session_id))::integer
    into pair_count
    from public.session_message_deliveries d
   where d.message_id = parent_id and d.pair_low_session_id is not null;
  if pair_count <> 1 then
    result := jsonb_build_object('reset', false, 'patches', '[]'::jsonb);
    return internal.ledger_record(p_client_mutation_id,
      'messages.delivery.memberReset', result);
  end if;
  select d.pair_low_session_id as low_id, d.pair_high_session_id as high_id into pair
    from public.session_message_deliveries d
   where d.message_id = parent_id and d.pair_low_session_id is not null limit 1;
  perform 1 from public.session_wake_budgets
   where low_work_session_id = pair.low_id and high_work_session_id = pair.high_id for update;
  update public.session_wake_budgets
     set consecutive_agent_wakes = 0, version = version + 1
   where low_work_session_id = pair.low_id and high_work_session_id = pair.high_id;
  result := jsonb_build_object('reset', true, 'lowWorkSessionId', pair.low_id,
    'highWorkSessionId', pair.high_id, 'patches', '[]'::jsonb);
  return internal.ledger_record(p_client_mutation_id,
    'messages.delivery.memberReset', result);
end
$$;

-- Teammate defaults use the guarded 0..1 edge and the same profile-first order.
create or replace function public.set_teammate_profile_default(
  p_team_member_id uuid, p_profile_id uuid, p_expected_version integer,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; teammate public.entities; profile public.entities;
declare detail public.interaction_profiles; validated public.interaction_profile_versions;
declare edge_id uuid; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id,
    'teamMembers.interactionProfile.setDefault');
  if replay is not null then return replay; end if;
  select * into teammate from public.entities where id = p_team_member_id;
  if teammate.id is null or teammate.kind <> 'team_member' then
    raise exception 'Teammate not found' using errcode = 'P0002';
  end if;
  perform internal.require_human_space_admin(teammate.space_id);
  if p_profile_id is not null then
    select * into profile from public.entities where id = p_profile_id for update;
    select * into detail from public.interaction_profiles where entity_id = p_profile_id;
    if profile.id is null or profile.kind <> 'interaction_profile'
       or profile.space_id <> teammate.space_id or profile.deleted_at is not null then
      raise exception 'Interaction Profile not found' using errcode = 'P0002';
    end if;
    if detail.retired_at is not null then
      raise exception 'Interaction Profile is retired' using errcode = '23514', detail = 'profile_retired';
    end if;
    select * into validated from public.interaction_profile_versions
     where profile_id = p_profile_id and version = detail.active_version for update;
    if detail.active_version is null or validated.validation_status <> 'valid'
       or validated.validated_hash is distinct from detail.active_hash then
      raise exception 'Interaction Profile is not validated'
        using errcode = '23514', detail = 'profile_not_validated';
    end if;
  end if;
  perform internal.assert_version(p_team_member_id, p_expected_version);
  perform internal.w1_set_writer('profile_default');
  delete from public.edges where src_id = p_team_member_id and type = 'defaults_to_profile';
  if p_profile_id is not null then
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (teammate.space_id, p_team_member_id, p_profile_id,
      'defaults_to_profile', '{}'::jsonb, internal.current_member_id(teammate.space_id))
    returning id into edge_id;
  end if;
  perform internal.w1_set_writer(null);
  update public.entities set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_team_member_id;
  result := jsonb_build_object('teamMemberId', p_team_member_id,
    'profileId', p_profile_id, 'version', p_expected_version + 1,
    'edgeId', edge_id, 'patches', '[]'::jsonb);
  return internal.ledger_record(p_client_mutation_id,
    'teamMembers.interactionProfile.setDefault', result);
end
$$;

-- Owner inspection is deliberately a read-only definer RPC.  It never calls a
-- read-mark writer and never changes notification.read_at.
create or replace function public.inspect_owned_teammate_inbox(
  p_team_member_id uuid, p_limit integer default 50
) returns setof public.notifications language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select n.* from public.notifications n
  join public.team_members tm on tm.entity_id = n.recipient_team_member_id
  join public.members owner on owner.entity_id = tm.owner_member_id
  where tm.entity_id = p_team_member_id
    and owner.identity_id = internal.identity_id()
  order by n.created_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
$$;

-- Preserve Member-personal versus Teammate-recipient read marks after the
-- additive discriminator column.  Owner inspection never satisfies these writes.
create or replace function public.mark_read(p_anchor_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare e public.entities; member_id uuid; marked timestamptz := now();
begin
  perform internal.ledger_replay(p_client_mutation_id, 'readMarks.upsert');
  e := internal.live_entity(p_anchor_id);
  perform internal.require_space_member(e.space_id);
  member_id := internal.current_member_id(e.space_id);
  insert into public.read_marks(member_id, anchor_id, last_read_at)
  values (member_id, p_anchor_id, marked)
  on conflict (member_id, anchor_id) do update set last_read_at = excluded.last_read_at;
  update public.notifications set read_at = coalesce(read_at, marked)
   where recipient_member_id = member_id and recipient_team_member_id is null
     and target_entity_id = p_anchor_id and read_at is null;
  return internal.ledger_record(p_client_mutation_id, 'readMarks.upsert',
    jsonb_build_object('anchorId', p_anchor_id, 'lastReadAt', marked, 'patches', '[]'::jsonb));
end
$$;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare n public.notifications; selected_teammate uuid := internal.acting_as();
begin
  perform internal.require_identity();
  update public.notifications set read_at = coalesce(read_at, now())
   where id = p_notification_id
     and ((recipient_team_member_id is null and selected_teammate is null
       and exists (select 1 from public.members m
                    where m.entity_id = notifications.recipient_member_id
                      and m.identity_id = internal.identity_id()))
      or (recipient_team_member_id = selected_teammate
       and internal.can_act_as(selected_teammate, notifications.space_id)))
  returning * into n;
  if n.id is null then raise exception 'notification not found' using errcode = 'P0002'; end if;
  return to_jsonb(n);
end
$$;

-- The content dispatcher stays total over every typed detail table.
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then return null; end if;
  if e.kind like 'c:%' then
    select jsonb_build_object('fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case e.kind
      when 'task' then select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- Endpoint omission changes must recompute counterpart reaction/message counters
-- in the same transaction.  Counterpart rows are visited in ascending UUID order.
create or replace function internal.recompute_w1_incident_counters() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare counterpart uuid;
begin
  if new.deleted_at is not distinct from old.deleted_at then return new; end if;
  for counterpart in
    select distinct case when edge.src_id = new.id then edge.dst_id else edge.src_id end
      from public.edges edge where edge.src_id = new.id or edge.dst_id = new.id
     order by 1
  loop
    perform 1 from public.entity_counters where entity_id = counterpart for update;
    update public.entity_counters c set
      likes = (select count(*) from public.edges edge
                join public.entities src on src.id = edge.src_id
                join public.entities dst on dst.id = edge.dst_id
               where edge.dst_id = counterpart and edge.type = 'likes'
                 and src.deleted_at is null and dst.deleted_at is null),
      dislikes = (select count(*) from public.edges edge
                join public.entities src on src.id = edge.src_id
                join public.entities dst on dst.id = edge.dst_id
               where edge.dst_id = counterpart and edge.type = 'dislikes'
                 and src.deleted_at is null and dst.deleted_at is null),
      stars = (select count(*) from public.edges edge
                join public.entities src on src.id = edge.src_id
                join public.entities dst on dst.id = edge.dst_id
               where edge.dst_id = counterpart and edge.type = 'stars'
                 and src.deleted_at is null and dst.deleted_at is null),
      messages = (select count(*) from public.messages m
                   join public.entities me on me.id = m.entity_id
                  where m.anchor_id = counterpart and me.deleted_at is null),
      updated_at = now()
    where c.entity_id = counterpart;
  end loop;
  return new;
end
$$;
create trigger entities_w1_recompute_incident_counters
after update of deleted_at on public.entities
for each row execute function internal.recompute_w1_incident_counters();

-- -----------------------------------------------------------------------------
-- 9. Future defaults plus conservative, repeatable backfill/repair seams.
-- -----------------------------------------------------------------------------
-- Keep the shipped create-space contract, while persisting the channel it
-- already creates as the explicit product default and materializing menu v1.
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
  insert into public.entities(id, space_id, kind, created_by)
  values (member_id, space_id, 'member', member_id);
  insert into public.members(entity_id, space_id, identity_id, role, display_name)
  values (member_id, space_id, identity, 'owner', profile.display_name);
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

  result := jsonb_build_object(
    'space', (select to_jsonb(s) from public.spaces s where s.id = space_id),
    'memberId', member_id,
    'defaultChannelId', channel_id)
    || jsonb_build_object('patches', jsonb_build_array(internal.command_entity(channel_id),
                                                       internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.create', result);
end
$$;

create or replace function internal.w1_backfill_participant(target_session uuid)
returns integer language plpgsql set search_path = public, internal, pg_temp as $$
declare session_space uuid; candidate uuid; candidate_count integer; actor uuid;
begin
  select space_id, created_by into session_space, actor
    from public.entities where id = target_session and kind = 'work_session';
  if session_space is null then return 0; end if;
  if exists (select 1 from public.edges
              where type = 'participates_in' and dst_id = target_session) then
    return 0;
  end if;
  select count(*), (array_agg(candidate_id order by candidate_id))[1]
    into candidate_count, candidate from (
    select distinct case when src.kind = 'team_member' then edge.src_id else edge.dst_id end candidate_id
      from public.edges edge
      join public.entities src on src.id = edge.src_id
      join public.entities dst on dst.id = edge.dst_id
     where edge.type = 'relates_to'
       and ((src.kind = 'team_member' and dst.id = target_session)
         or (dst.kind = 'team_member' and src.id = target_session))
       and src.space_id = session_space and dst.space_id = session_space
       and src.deleted_at is null and dst.deleted_at is null
  ) candidates;
  if candidate_count = 1 then
    perform 1 from public.work_sessions where entity_id = target_session for update;
    perform internal.w1_set_writer('backfill');
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (session_space, candidate, target_session, 'participates_in', '{}'::jsonb,
            coalesce(actor, candidate))
    on conflict (src_id, dst_id, type) do nothing;
    perform internal.w1_set_writer(null);
    return 1;
  end if;
  perform internal.w1_audit(session_space, 'participant_backfill_unresolved',
    jsonb_build_object('workSessionId', target_session, 'candidateCount', candidate_count));
  return 0;
end
$$;

-- The installation pass is conservative and idempotent by construction:
-- mappings come only from shipped active rows, launch provenance never relinks,
-- and nullable additions retain their declared NULL/default values.
do $w1_backfill$
declare project_row record; link_row record; session_row record; space_row record;
declare projection_id uuid; association_count integer;
begin
  update public.projects p set
    active_link_count = counts.link_count,
    link_frozen = counts.link_count > 16
  from (
    select p0.id, count(sp.space_id)::integer link_count
      from public.projects p0 left join public.space_projects sp on sp.project_id = p0.id
     group by p0.id
  ) counts
  where p.id = counts.id;

  for project_row in select id, link_frozen, active_link_count from public.projects order by id loop
    if project_row.link_frozen then
      for space_row in
        select space_id from public.space_projects where project_id = project_row.id order by space_id
      loop
        perform internal.w1_audit(space_row.space_id, 'project_link_frozen',
          jsonb_build_object('projectId', project_row.id,
                             'activeLinkCount', project_row.active_link_count));
      end loop;
    end if;
    for link_row in
      select space_id from public.space_projects
       where project_id = project_row.id order by space_id
    loop
      perform internal.materialize_project_projection(link_row.space_id, project_row.id, true);
    end loop;
  end loop;

  for session_row in
    select ws.entity_id, ws.project_id, e.space_id, e.created_by
      from public.work_sessions ws join public.entities e on e.id = ws.entity_id
     order by ws.entity_id
  loop
    perform internal.ensure_core_interaction_pin(session_row.entity_id);
    if session_row.project_id is not null then
      select l.project_entity_id into projection_id
        from public.project_links l
        join public.space_projects sp on sp.space_id = l.space_id and sp.project_id = l.project_id
        join public.entities pe on pe.id = l.project_entity_id and pe.deleted_at is null
       where l.space_id = session_row.space_id and l.project_id = session_row.project_id;
      if projection_id is null then
        perform internal.w1_audit(session_row.space_id, 'launch_project_unmatched',
          jsonb_build_object('workSessionId', session_row.entity_id,
                             'projectId', session_row.project_id));
      elsif not exists (select 1 from public.edges
                         where src_id = session_row.entity_id and type = 'in_project') then
        select count(*) into association_count from public.edges edge
          join public.entities pe on pe.id = edge.dst_id and pe.deleted_at is null
         where edge.src_id = session_row.entity_id and edge.type = 'in_project';
        if association_count < 16 then
          perform internal.w1_set_writer('backfill');
          insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
          values (session_row.space_id, session_row.entity_id, projection_id,
                  'in_project', '{}'::jsonb, session_row.created_by)
          on conflict (src_id, dst_id, type) do nothing;
          perform internal.w1_set_writer(null);
        else
          perform internal.w1_audit(session_row.space_id, 'launch_project_cap_skipped',
            jsonb_build_object('workSessionId', session_row.entity_id,
                               'projectId', session_row.project_id));
        end if;
      end if;
    end if;
    perform internal.w1_backfill_participant(session_row.entity_id);
  end loop;

  insert into public.space_menu_configs(space_id, schema_version, revision, payload)
  select id, 1, 1, internal.w1_default_menu_payload() from public.spaces
  on conflict (space_id) do nothing;
  for space_row in select id from public.spaces where default_channel_id is null order by id loop
    perform internal.w1_audit(space_row.id, 'default_channel_unresolved',
      jsonb_build_object('defaultChannelId', null, 'feedState', 'no-feed'));
  end loop;
end
$w1_backfill$;

create or replace function public.repair_w1_foundations(
  p_space_id uuid, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; project_row record; session_id uuid; repaired integer := 0; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'maintenance.w1.repair');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  -- Lock all ProjectResources before the affected Space, then visit projections.
  perform 1 from public.projects p join public.space_projects sp on sp.project_id = p.id
   where sp.space_id = p_space_id order by p.id for update of p;
  perform 1 from public.spaces where id = p_space_id for update;
  for project_row in
    select project_id from public.space_projects where space_id = p_space_id order by project_id
  loop
    perform internal.materialize_project_projection(p_space_id, project_row.project_id, true);
    repaired := repaired + 1;
  end loop;
  insert into public.space_menu_configs(space_id, schema_version, revision, payload)
  values (p_space_id, 1, 1, internal.w1_default_menu_payload())
  on conflict (space_id) do nothing;
  for session_id in
    select ws.entity_id from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
    where e.space_id = p_space_id order by ws.entity_id
  loop
    perform internal.ensure_core_interaction_pin(session_id);
    repaired := repaired + internal.w1_backfill_participant(session_id);
  end loop;
  update public.projects p set
    active_link_count = counts.link_count,
    link_frozen = counts.link_count > 16
  from (select project_id, count(*)::integer link_count from public.space_projects
        group by project_id) counts
  where p.id = counts.project_id;
  perform internal.w1_audit(p_space_id, 'repair_completed',
    jsonb_build_object('mutationCount', repaired));
  result := jsonb_build_object('spaceId', p_space_id, 'mutationCount', repaired,
                               'patches', '[]'::jsonb);
  return internal.ledger_record(p_client_mutation_id, 'maintenance.w1.repair', result);
end
$$;

-- Forward-only quiesce/compensation seam.  It refuses undrained work, advances
-- Space revision for a cleared A20 binding, appends (never rewrites) core pins,
-- and removes only materialized projections/edges.  A later explicit migration
-- may remove the nullable FK/index/column once this reports ready=true.
create or replace function public.compensate_w1_foundations(
  p_space_id uuid, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; project_row record; session_row record; next_pin integer;
declare changed integer := 0; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'maintenance.w1.compensate');
  if replay is not null then return replay; end if;
  perform internal.require_human_space_admin(p_space_id);
  if exists (
    select 1 from public.session_message_deliveries d
    join public.entities target on target.id = d.target_work_session_id
    where target.space_id = p_space_id and d.status in ('pending','dispatching')
  ) or exists (
    select 1 from public.session_handoffs h
    join public.entities target on target.id = h.target_work_session_id
    where target.space_id = p_space_id
      and (h.delivery_status in ('prepared','dispatching') or h.record_status = 'pending')
  ) then
    raise exception 'W1 bindings must be quiesced and delivery/handoff rows drained'
      using errcode = '55006';
  end if;

  perform 1 from public.projects p join public.space_projects sp on sp.project_id = p.id
   where sp.space_id = p_space_id order by p.id for update of p;
  perform 1 from public.spaces where id = p_space_id for update;
  if (select default_interaction_profile_id from public.spaces where id = p_space_id) is not null then
    perform internal.w1_set_writer('space_settings');
    update public.spaces set default_interaction_profile_id = null,
      settings_revision = settings_revision + 1 where id = p_space_id;
    perform internal.w1_set_writer(null);
    changed := changed + 1;
  end if;

  perform internal.w1_set_writer('profile_default');
  delete from public.edges
   where space_id = p_space_id and type = 'defaults_to_profile';
  if found then changed := changed + 1; end if;
  perform internal.w1_set_writer(null);

  for session_row in
    select ws.entity_id, coalesce(max(pin.pin_revision), 0) max_pin
      from public.work_sessions ws
      join public.entities e on e.id = ws.entity_id
      left join public.work_session_interaction_pins pin on pin.work_session_id = ws.entity_id
     where e.space_id = p_space_id group by ws.entity_id order by ws.entity_id
  loop
    if exists (select 1 from public.work_session_interaction_pins
                where work_session_id = session_row.entity_id and pin_revision = session_row.max_pin
                  and profile_id is not null) then
      next_pin := session_row.max_pin + 1;
      perform internal.w1_set_writer('profile_pin');
      insert into public.work_session_interaction_pins(
        work_session_id, pin_revision, profile_id, profile_version,
        template_key, template_version, resolved_hash, resolved_snapshot)
      values (session_row.entity_id, next_pin, null, null, 'core', 1,
              'core-profile-v1', internal.w1_core_pin_snapshot());
      delete from public.edges where src_id = session_row.entity_id and type = 'selected_profile';
      perform internal.w1_set_writer(null);
      changed := changed + 1;
    end if;
  end loop;

  perform internal.w1_set_writer('forward_compensation');
  delete from public.edges edge using public.entities src
   where edge.space_id = p_space_id and src.id = edge.src_id
     and edge.type in ('shared_into','authored_from')
     and edge.props ->> 'origin' = 'materialized';
  delete from public.edges edge using public.project_links link
   where link.space_id = p_space_id and edge.dst_id = link.project_entity_id
     and edge.type = 'in_project';
  update public.entities e set deleted_at = coalesce(e.deleted_at, now()), updated_at = now()
   from public.project_links link
   where link.space_id = p_space_id and link.project_entity_id = e.id;
  perform internal.w1_set_writer(null);
  perform internal.w1_audit(p_space_id, 'forward_compensation_completed',
    jsonb_build_object('mutationCount', changed, 'readyForCompensatingMigration', true));
  result := jsonb_build_object('spaceId', p_space_id, 'mutationCount', changed,
    'readyForCompensatingMigration', true, 'patches', '[]'::jsonb);
  return internal.ledger_record(p_client_mutation_id, 'maintenance.w1.compensate', result);
end
$$;

-- Retention is owner-internal maintenance, never part of the delivery-role
-- allowlist.  Eligibility is derived from terminal sessions and zero active
-- reservations; pruning rechecks the same conditions under pair-row locks.
create or replace function internal.w1_refresh_wake_budget_cleanup_eligibility()
returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare pair record; changed integer := 0;
begin
  for pair in
    select b.low_work_session_id, b.high_work_session_id
      from public.session_wake_budgets b
     order by b.low_work_session_id, b.high_work_session_id
     for update
  loop
    if not exists (
      select 1 from public.work_sessions ws
       where ws.entity_id in (pair.low_work_session_id, pair.high_work_session_id)
         and ws.status in ('spawning','running','idle')
    ) and not exists (
      select 1 from public.session_message_deliveries d
       where d.pair_low_session_id = pair.low_work_session_id
         and d.pair_high_session_id = pair.high_work_session_id
         and d.status in ('pending','dispatching')
    ) then
      update public.session_wake_budgets set eligible_for_cleanup_at = coalesce(eligible_for_cleanup_at, now())
       where low_work_session_id = pair.low_work_session_id
         and high_work_session_id = pair.high_work_session_id
         and eligible_for_cleanup_at is null;
    else
      update public.session_wake_budgets set eligible_for_cleanup_at = null
       where low_work_session_id = pair.low_work_session_id
         and high_work_session_id = pair.high_work_session_id
         and eligible_for_cleanup_at is not null;
    end if;
    if found then changed := changed + 1; end if;
  end loop;
  return changed;
end
$$;

create or replace function internal.w1_prune_operational_state(reference_time timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare deliveries_deleted integer; budgets_deleted integer;
begin
  perform internal.w1_refresh_wake_budget_cleanup_eligibility();
  delete from public.session_message_deliveries
   where settled_at < reference_time - interval '30 days'
     and status in ('delivered','failed_retryable','failed_permanent','unknown','expired','cancelled');
  get diagnostics deliveries_deleted = row_count;
  delete from public.session_wake_budgets b
   where b.eligible_for_cleanup_at < reference_time - interval '7 days'
     and not exists (select 1 from public.session_message_deliveries d
                      where d.pair_low_session_id = b.low_work_session_id
                        and d.pair_high_session_id = b.high_work_session_id
                        and d.status in ('pending','dispatching'));
  get diagnostics budgets_deleted = row_count;
  return jsonb_build_object('deliveriesDeleted', deliveries_deleted,
                            'budgetsDeleted', budgets_deleted);
end
$$;

-- -----------------------------------------------------------------------------
-- 10. RLS and the closed grant surface.
-- -----------------------------------------------------------------------------
alter table public.project_links enable row level security;
alter table public.project_projection_details enable row level security;
alter table public.space_menu_configs enable row level security;
alter table public.interaction_profiles enable row level security;
alter table public.interaction_profile_versions enable row level security;
alter table public.work_session_interaction_pins enable row level security;
alter table public.work_session_view_preferences enable row level security;
alter table public.session_wake_budgets enable row level security;
alter table public.session_message_deliveries enable row level security;
alter table public.session_handoffs enable row level security;

create policy project_links_select on public.project_links for select to tm8_app
  using (internal.is_space_member(space_id));
create policy project_projection_details_select on public.project_projection_details for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy space_menu_configs_select on public.space_menu_configs for select to tm8_app
  using (internal.is_space_member(space_id));
create policy interaction_profiles_select on public.interaction_profiles for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy interaction_profile_versions_select on public.interaction_profile_versions for select to tm8_app
  using (internal.entity_readable(profile_id));
create policy work_session_interaction_pins_select on public.work_session_interaction_pins for select to tm8_app
  using (internal.entity_readable(work_session_id));
create policy work_session_view_preferences_select on public.work_session_view_preferences for select to tm8_app
  using (internal.entity_readable(work_session_id)
         and exists (select 1 from public.members member_row
                      where member_row.entity_id = work_session_view_preferences.member_id
                        and member_row.identity_id = internal.identity_id()));
create policy session_wake_budgets_select on public.session_wake_budgets for select to tm8_app
  using (internal.entity_readable(low_work_session_id)
         and internal.entity_readable(high_work_session_id));
create policy session_message_deliveries_select on public.session_message_deliveries for select to tm8_app
  using (internal.entity_readable(target_work_session_id)
         and (source_work_session_id is null or internal.entity_readable(source_work_session_id))
         and exists (select 1 from public.messages canonical_message
                      where canonical_message.entity_id = session_message_deliveries.message_id
                        and internal.entity_readable(canonical_message.entity_id)
                        and internal.entity_readable(canonical_message.anchor_id)));
create policy session_handoffs_select on public.session_handoffs for select to tm8_app
  using (internal.entity_readable(source_entity_id)
         and internal.entity_readable(target_work_session_id));

-- Member-personal and Teammate-recipient inbox rows are mutually exclusive read
-- projections.  Selecting a Teammate is required; owning it alone does not turn
-- its read marks into the Member's read marks.
drop policy notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to tm8_app
  using (
    (recipient_team_member_id is null
      and internal.acting_as() is null
      and exists (select 1 from public.members member_row
                   where member_row.entity_id = notifications.recipient_member_id
                     and member_row.identity_id = internal.identity_id()))
    or
    (recipient_team_member_id is not null
      and recipient_team_member_id = internal.acting_as()
      and internal.can_act_as(recipient_team_member_id, space_id))
  );

grant select on
  public.project_links, public.project_projection_details, public.space_menu_configs,
  public.interaction_profiles, public.interaction_profile_versions,
  public.work_session_interaction_pins, public.work_session_view_preferences,
  public.session_wake_budgets, public.session_message_deliveries, public.session_handoffs
to tm8_app;

-- PostgreSQL grants new functions to PUBLIC by default.  Close every 015-created
-- function first, then enumerate only the application RPCs.  The three delivery
-- RPCs are explicitly revoked from both default and application roles again at
-- their dedicated grant site for auditable proof of the closed allowlist.
revoke all on all functions in schema public from public;
revoke all on all functions in schema internal from public;
grant execute on function
  public.set_space_default_channel(uuid, uuid, integer, text),
  public.set_space_profile_default(uuid, uuid, integer, boolean, text),
  public.set_space_menu_config(uuid, integer, jsonb, integer, text),
  public.reset_session_wake_budget_for_member_reply(uuid, text),
  public.set_teammate_profile_default(uuid, uuid, integer, text),
  public.inspect_owned_teammate_inbox(uuid, integer),
  public.repair_w1_foundations(uuid, text),
  public.compensate_w1_foundations(uuid, text)
to tm8_app;

-- Return to the applying role before closing delivery-worker relation grants.
-- Product relations are owned through tm8_graph_owner membership, while the
-- official migration runner's bookkeeping table is owned by the applier.
reset role;

grant usage on schema public to tm8_delivery_worker;
revoke all on all tables in schema public from tm8_delivery_worker;
revoke all on all sequences in schema public from tm8_delivery_worker;
revoke all on all functions in schema public from tm8_delivery_worker;
revoke all on all functions in schema internal from tm8_delivery_worker;
revoke execute on function
  public.reserve_session_message_delivery(uuid, uuid, uuid, integer),
  public.claim_session_message_delivery(uuid, uuid, uuid, integer),
  public.settle_session_message_delivery(uuid, uuid, uuid, integer, text, text)
from public;
revoke execute on function
  public.reserve_session_message_delivery(uuid, uuid, uuid, integer),
  public.claim_session_message_delivery(uuid, uuid, uuid, integer),
  public.settle_session_message_delivery(uuid, uuid, uuid, integer, text, text)
from tm8_app;
grant execute on function
  public.reserve_session_message_delivery(uuid, uuid, uuid, integer),
  public.claim_session_message_delivery(uuid, uuid, uuid, integer),
  public.settle_session_message_delivery(uuid, uuid, uuid, integer, text, text)
to tm8_delivery_worker;

reset role;
