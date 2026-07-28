-- =============================================================================
-- 029 W2.G14 — per-Space MenuConfig and persisted default-channel commands.
--
-- Depends on 001-016. Migration 015 introduced the config side table, the
-- persisted settings columns and their shared revision; 016 closed the command
-- ledger's concurrent-first-attempt race. This migration completes A01-A03
-- without introducing a second settings counter or a second default payload.
-- =============================================================================

set role tm8_graph_owner;

-- The frozen six view rows are data, not UI conditionals. The reserved v:
-- namespace is accepted by the database validator only after a later migration
-- registers the view as both menu-eligible and implemented. The v1 HTTP schema
-- remains the still-narrower closed six-ref boundary.
create table public.menu_view_registry (
  ref            text primary key check (
    ref in ('dashboard','feed','inbox','workspace','channels','settings')
    or ref ~ '^v:[a-z0-9][a-z0-9_-]{0,48}$'
  ),
  route_template text not null check (char_length(btrim(route_template)) between 1 and 200),
  menu_eligible boolean not null default false,
  required      boolean not null default false,
  implemented   boolean not null default false
);

insert into public.menu_view_registry(ref, route_template, menu_eligible, required, implemented)
values
  ('dashboard', '#/s/{s}/home',       true, false, true),
  ('feed',      '#/s/{s}/feed',       true, false, true),
  ('inbox',     '#/s/{s}/inbox',      true, false, true),
  ('workspace', '#/s/{s}/workspace',  true, false, true),
  ('channels',  '#/s/{s}/channels',   true, false, true),
  ('settings',  '#/s/{s}/settings',   true, true,  true);

revoke all on public.menu_view_registry from public, tm8_app;

-- Validate the storage payload shape (`{groups}`) and return its canonical
-- jsonb form. Array order is intentionally retained: menu reordering is the
-- command's semantic content. jsonb canonicalizes object-key ordering.
create or replace function internal.w2_normalize_menu_payload(
  p_space_id uuid,
  p_payload jsonb
) returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  group_value jsonb;
  item_value jsonb;
  leaf_value jsonb;
  item_children jsonb;
  group_id text;
  item_type text;
  item_ref text;
  group_ids text[] := array[]::text[];
  refs text[] := array[]::text[];
begin
  if jsonb_typeof(p_payload) is distinct from 'object'
     or not (p_payload ? 'groups')
     or exists (
       select 1 from jsonb_object_keys(p_payload) as payload_keys(key_name)
        where key_name <> 'groups'
     )
     or jsonb_typeof(p_payload -> 'groups') is distinct from 'array'
     or jsonb_array_length(p_payload -> 'groups') > 8 then
    raise exception 'invalid MenuConfig payload' using errcode = '22023';
  end if;

  for group_value in select value from jsonb_array_elements(p_payload -> 'groups') loop
    if jsonb_typeof(group_value) is distinct from 'object'
       or not (group_value ?& array['id','label','items'])
       or exists (
         select 1 from jsonb_object_keys(group_value) as group_keys(key_name)
          where key_name not in ('id','label','items')
       )
       or jsonb_typeof(group_value -> 'id') is distinct from 'string'
       or jsonb_typeof(group_value -> 'label') is distinct from 'string'
       or jsonb_typeof(group_value -> 'items') is distinct from 'array'
       or jsonb_array_length(group_value -> 'items') > 12 then
      raise exception 'invalid MenuConfig group' using errcode = '22023';
    end if;

    group_id := group_value ->> 'id';
    if group_id !~ '^[a-z0-9][a-z0-9-]{0,31}$'
       or char_length(group_value ->> 'label') not between 1 and 32
       or group_id = any(group_ids) then
      raise exception 'invalid or duplicate MenuConfig group' using errcode = '22023';
    end if;
    group_ids := array_append(group_ids, group_id);

    for item_value in select value from jsonb_array_elements(group_value -> 'items') loop
      if jsonb_typeof(item_value) is distinct from 'object'
         or not (item_value ?& array['type','ref'])
         or jsonb_typeof(item_value -> 'type') is distinct from 'string'
         or jsonb_typeof(item_value -> 'ref') is distinct from 'string' then
        raise exception 'invalid MenuConfig item' using errcode = '22023';
      end if;

      item_type := item_value ->> 'type';
      item_ref := item_value ->> 'ref';
      if item_ref = any(refs) then
        raise exception 'MenuConfig refs must be globally unique' using errcode = '22023';
      end if;
      refs := array_append(refs, item_ref);

      if item_type = 'view' then
        if exists (
             select 1 from jsonb_object_keys(item_value) as item_keys(key_name)
              where key_name not in ('type','ref','children')
           )
           or not exists (
             select 1 from public.menu_view_registry registry_row
              where registry_row.ref = item_ref
                and registry_row.menu_eligible
                and registry_row.implemented
           ) then
          raise exception 'unknown or unavailable MenuConfig view ref' using errcode = '22023';
        end if;

        if item_value ? 'children' then
          item_children := item_value -> 'children';
          if jsonb_typeof(item_children) is distinct from 'array'
             or jsonb_array_length(item_children) > 8 then
            raise exception 'invalid MenuConfig children' using errcode = '22023';
          end if;
          for leaf_value in select value from jsonb_array_elements(item_children) loop
            if jsonb_typeof(leaf_value) is distinct from 'object'
               or not (leaf_value ?& array['type','ref'])
               or exists (
                 select 1 from jsonb_object_keys(leaf_value) as leaf_keys(key_name)
                  where key_name not in ('type','ref')
               )
               or jsonb_typeof(leaf_value -> 'type') is distinct from 'string'
               or jsonb_typeof(leaf_value -> 'ref') is distinct from 'string' then
              raise exception 'invalid MenuConfig child' using errcode = '22023';
            end if;
            item_type := leaf_value ->> 'type';
            item_ref := leaf_value ->> 'ref';
            if item_ref = any(refs) then
              raise exception 'MenuConfig refs must be globally unique' using errcode = '22023';
            end if;
            refs := array_append(refs, item_ref);
            if item_type = 'view' then
              if not exists (
                select 1 from public.menu_view_registry registry_row
                 where registry_row.ref = item_ref
                   and registry_row.menu_eligible
                   and registry_row.implemented
              ) then
                raise exception 'unknown or unavailable MenuConfig child view ref'
                  using errcode = '22023';
              end if;
            elsif item_type = 'kind' then
              if item_ref in ('channel','message') or not exists (
                select 1 from public.entity_kinds kind_row
                 where kind_row.kind = item_ref
                   and (kind_row.space_id = p_space_id or kind_row.space_id is null)
              ) then
                raise exception 'unknown or non-collection MenuConfig child kind ref'
                  using errcode = '22023';
              end if;
            else
              raise exception 'invalid MenuConfig child type' using errcode = '22023';
            end if;
          end loop;
        end if;
      elsif item_type = 'kind' then
        if exists (
             select 1 from jsonb_object_keys(item_value) as item_keys(key_name)
              where key_name not in ('type','ref')
           )
           or item_ref in ('channel','message')
           or not exists (
             select 1 from public.entity_kinds kind_row
              where kind_row.kind = item_ref
                and (kind_row.space_id = p_space_id or kind_row.space_id is null)
           ) then
          raise exception 'unknown or non-collection MenuConfig kind ref' using errcode = '22023';
        end if;
      else
        raise exception 'invalid MenuConfig item type' using errcode = '22023';
      end if;
    end loop;
  end loop;

  if not ('settings' = any(refs)) then
    raise exception 'MenuConfig requires the settings view' using errcode = '22023';
  end if;
  return jsonb_build_object('groups', p_payload -> 'groups');
end
$$;

create or replace function internal.w2_menu_payload_valid(
  p_space_id uuid,
  p_payload jsonb
) returns boolean language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
begin
  perform internal.w2_normalize_menu_payload(p_space_id, p_payload);
  return true;
exception when others then
  return false;
end
$$;

create or replace function internal.w2_render_menu(
  p_space_id uuid,
  p_schema_version integer,
  p_revision integer,
  p_payload jsonb
) returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare render_revision integer := greatest(coalesce(p_revision, 1), 1);
begin
  if p_schema_version = 1 and internal.w2_menu_payload_valid(p_space_id, p_payload) then
    return jsonb_build_object(
      'schemaVersion', 1,
      'revision', render_revision,
      'groups', p_payload -> 'groups'
    );
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'revision', render_revision,
    'groups', internal.w1_default_menu_payload() -> 'groups'
  );
end
$$;

-- Every understood-version save, including maintenance writes, crosses the
-- same validator. Future versions remain raw and untouched for upgrade safety.
create or replace function internal.w2_guard_menu_config() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.schema_version = 1 then
    new.payload := internal.w2_normalize_menu_payload(new.space_id, new.payload);
  end if;
  return new;
end
$$;

create trigger space_menu_configs_w2_validate
before insert or update of space_id, schema_version, payload
on public.space_menu_configs for each row execute function internal.w2_guard_menu_config();

-- Apply the one shipped v1 default to genuinely missing rows. Existing future
-- rows and understood-but-malformed rows are deliberately not rewritten: their
-- distinct read/edit laws need the stored revision and raw evidence intact.
insert into public.space_menu_configs(space_id, schema_version, revision, payload)
select space_row.id, 1, 1, internal.w1_default_menu_payload()
  from public.spaces space_row
 where not exists (
   select 1 from public.space_menu_configs menu_row where menu_row.space_id = space_row.id
 );

-- Member read with fail-closed rendering. A missing row can occur only after
-- damage/partial restore once this backfill is installed; it renders revision 1
-- while the documented repair command still creates it at expectedRevision 0.
create or replace function public.get_space_menu(p_space_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare menu_row public.space_menu_configs;
begin
  perform internal.require_space_member(p_space_id);
  select * into menu_row from public.space_menu_configs where space_id = p_space_id;
  return internal.w2_render_menu(
    p_space_id,
    menu_row.schema_version,
    menu_row.revision,
    menu_row.payload
  );
end
$$;

-- Human owner/admin authorization is shared by menu and default-channel
-- configuration but deliberately carries no profile-specific error reason.
create or replace function internal.w2_require_human_space_admin(p_space_id uuid)
returns uuid language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare member_id uuid; effective_actor uuid;
begin
  perform internal.require_identity();
  if internal.acting_as() is not null then
    raise exception 'Space settings require a human principal' using errcode = '42501';
  end if;
  member_id := internal.current_member_id(p_space_id);
  effective_actor := internal.actor_id();
  if member_id is null
     or (effective_actor is not null and effective_actor <> member_id)
     or not exists (
       select 1 from public.members member_row
        where member_row.entity_id = member_id
          and member_row.space_id = p_space_id
          and member_row.role in ('owner','admin')
     ) then
    raise exception 'Space owner/admin human principal required' using errcode = '42501';
  end if;
  return member_id;
end
$$;

create or replace function internal.w2_iso(p_value timestamptz)
returns text language sql immutable parallel safe as $$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- Build the exact A03 response while the command still owns the Space lock.
-- The complete snapshot is stored in command_ledger, so a later retry remains
-- identical even if membership, invites, axes, menu or profile defaults changed
-- after the first attempt committed.
create or replace function internal.w2_space_settings_view(p_space_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  space_row public.spaces;
  menu_row public.space_menu_configs;
  menu_result jsonb;
  result jsonb;
begin
  select * into space_row from public.spaces where id = p_space_id;
  if space_row.id is null then raise exception 'Space not found' using errcode = 'P0002'; end if;
  select * into menu_row from public.space_menu_configs where space_id = p_space_id;
  menu_result := internal.w2_render_menu(
    p_space_id, menu_row.schema_version, menu_row.revision, menu_row.payload
  );

  select jsonb_build_object(
    'space', jsonb_build_object(
      'id', space_value.id,
      'name', space_value.name,
      'description', space_value.description,
      'memberCount', (
        select count(*)::integer from public.members member_count_row
         where member_count_row.space_id = space_value.id
      ),
      'unreadTotal', (
        select count(*)::integer
          from public.messages message_row
          join public.entities message_entity
            on message_entity.id = message_row.entity_id and message_entity.deleted_at is null
          join public.entities anchor_entity
            on anchor_entity.id = message_row.anchor_id and anchor_entity.space_id = space_value.id
          join public.members viewer
            on viewer.space_id = space_value.id and viewer.identity_id = internal.identity_id()
          left join public.read_marks mark_row
            on mark_row.anchor_id = message_row.anchor_id
           and mark_row.member_id = viewer.entity_id
         where message_row.author_id is distinct from viewer.entity_id
           and (mark_row.last_read_at is null
             or message_row.entity_id > internal.uuid_at(mark_row.last_read_at))
      ),
      'githubRepo', space_value.github_repo,
      'createdAt', internal.w2_iso(space_value.created_at)
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'actor', jsonb_build_object(
          'id', member_row.entity_id,
          'kind', 'member',
          'displayName', coalesce(member_row.display_name, profile_row.display_name, 'Member'),
          'avatar', profile_row.avatar,
          'role', member_row.role,
          'isAgent', false
        ),
        'role', member_row.role,
        'joinedAt', internal.w2_iso(member_row.joined_at)
      ) order by member_row.joined_at, member_row.entity_id)
        from public.members member_row
        left join public.user_profiles profile_row
          on profile_row.identity_id = member_row.identity_id
       where member_row.space_id = space_value.id
    ), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', invite_row.id,
        'code', invite_row.code,
        'maxUses', invite_row.max_uses,
        'uses', invite_row.use_count,
        'expiresAt', case when invite_row.expires_at is null then null
                          else internal.w2_iso(invite_row.expires_at) end,
        'revoked', invite_row.revoked_at is not null
      ) order by invite_row.created_at desc, invite_row.id desc)
        from public.space_invites invite_row
       where invite_row.space_id = space_value.id
    ), '[]'::jsonb),
    'taskAxes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', axis_row.id,
        'spaceId', axis_row.space_id,
        'name', axis_row.name,
        'axisValues', axis_row.axis_values,
        'kind', axis_row.kind,
        'position', axis_row.position
      ) order by axis_row.position, axis_row.name, axis_row.id)
        from public.task_axes axis_row
       where axis_row.space_id = space_value.id
    ), '[]'::jsonb),
    'menu', menu_result,
    'defaultChannelId', space_value.default_channel_id,
    'defaultInteractionProfileId', space_value.default_interaction_profile_id,
    'settingsRevision', space_value.settings_revision
  ) into result
    from public.spaces space_value
   where space_value.id = p_space_id;
  return result;
end
$$;

create or replace function public.update_space_menu(
  p_space_id uuid,
  p_payload jsonb,
  p_expected_revision integer,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  menu_row public.space_menu_configs;
  normalized_payload jsonb;
  current_menu jsonb;
  menu_result jsonb;
  ledger_result jsonb;
  event_effect jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.menu.update');
  perform internal.w2_require_human_space_admin(p_space_id);
  if replay is not null then return replay; end if;

  if p_client_mutation_id is null or btrim(p_client_mutation_id) = ''
     or p_expected_revision is null or p_expected_revision < 0
     or jsonb_typeof(p_payload) is distinct from 'object'
     or not (p_payload ?& array['schemaVersion','groups'])
     or exists (
       select 1 from jsonb_object_keys(p_payload) as payload_keys(key_name)
        where key_name not in ('schemaVersion','groups')
     )
     or jsonb_typeof(p_payload -> 'schemaVersion') is distinct from 'number'
     or (p_payload ->> 'schemaVersion')::numeric <> 1 then
    raise exception 'MenuConfigPayload must be strict schemaVersion 1'
      using errcode = '22023';
  end if;
  normalized_payload := internal.w2_normalize_menu_payload(
    p_space_id,
    jsonb_build_object('groups', p_payload -> 'groups')
  );

  perform 1 from public.spaces where id = p_space_id for update;
  if not found then raise exception 'Space not found' using errcode = 'P0002'; end if;
  select * into menu_row
    from public.space_menu_configs
   where space_id = p_space_id
   for update;

  if menu_row.space_id is not null and menu_row.schema_version > 1 then
    raise exception 'Menu schema requires a newer client' using errcode = '40001',
      detail = jsonb_build_object('reason', 'menu_upgrade_required')::text;
  end if;

  if menu_row.space_id is null then
    if p_expected_revision <> 0 then
      current_menu := internal.w2_render_menu(p_space_id, null, null, null);
      raise exception 'Menu revision conflict' using errcode = '40001',
        detail = jsonb_build_object(
          'reason', 'menu_revision_conflict',
          'currentRevision', 0,
          'currentMenu', current_menu
        )::text;
    end if;
    insert into public.space_menu_configs(space_id, schema_version, revision, payload)
    values (p_space_id, 1, 1, normalized_payload)
    returning * into menu_row;
  else
    if menu_row.revision <> p_expected_revision then
      current_menu := internal.w2_render_menu(
        p_space_id, menu_row.schema_version, menu_row.revision, menu_row.payload
      );
      raise exception 'Menu revision conflict' using errcode = '40001',
        detail = jsonb_build_object(
          'reason', 'menu_revision_conflict',
          'currentRevision', menu_row.revision,
          'currentMenu', current_menu
        )::text;
    end if;
    update public.space_menu_configs
       set schema_version = 1,
           revision = revision + 1,
           payload = normalized_payload
     where space_id = p_space_id
     returning * into menu_row;
  end if;

  menu_result := internal.w2_render_menu(
    p_space_id, menu_row.schema_version, menu_row.revision, menu_row.payload
  );
  event_effect := jsonb_strip_nulls(jsonb_build_object(
    'type', 'menu.updated',
    'menu', menu_result,
    'clientMutationId', p_client_mutation_id
  ));
  insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
  values (
    p_space_id,
    internal.next_event_seq(p_space_id),
    'menu.updated',
    event_effect,
    p_client_mutation_id
  );
  ledger_result := jsonb_build_object('menu', menu_result);
  perform internal.ledger_record(
    p_client_mutation_id,
    'spaces.menu.update',
    ledger_result
  );
  -- Only a committing first attempt carries the integration publication
  -- effect. A ledger replay returns ledger_result verbatim and cannot emit it
  -- twice; the durable workspace_events row remains the publication authority.
  return ledger_result || jsonb_build_object('eventEffect', event_effect);
end
$$;

-- A selected default channel cannot be soft-deleted behind A03. The deletion
-- owner must first use spaces.defaultChannel.set with a live successor or the
-- explicit null/no-feed state.
create or replace function internal.w2_guard_default_channel_deletion() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if old.kind = 'channel'
     and old.deleted_at is null
     and new.deleted_at is not null
     and exists (
       select 1 from public.spaces space_row where space_row.default_channel_id = old.id
     ) then
    raise exception 'select a live successor or explicit no-feed before deleting the default channel'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger entities_w2_guard_default_channel_deletion
before update of deleted_at on public.entities
for each row execute function internal.w2_guard_default_channel_deletion();

-- The shipped FK used ON DELETE SET NULL, which could infer no-feed outside
-- A03 on physical deletion. Restrict makes the explicit successor/null command
-- a prerequisite for hard deletion too.
alter table public.spaces drop constraint spaces_default_channel_id_fkey;
alter table public.spaces add constraint spaces_default_channel_id_fkey
  foreign key (default_channel_id) references public.channels(entity_id) on delete restrict;

create or replace function public.set_space_default_channel(
  p_space_id uuid,
  p_channel_id uuid,
  p_expected_settings_revision integer,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  space_row public.spaces;
  channel_entity public.entities;
  result jsonb;
  event_effect jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.defaultChannel.set');
  perform internal.w2_require_human_space_admin(p_space_id);
  if replay is not null then return replay; end if;

  if p_client_mutation_id is null or btrim(p_client_mutation_id) = ''
     or p_expected_settings_revision is null or p_expected_settings_revision < 1 then
    raise exception 'invalid default-channel command envelope' using errcode = '22023';
  end if;

  select * into space_row from public.spaces where id = p_space_id for update;
  if space_row.id is null then raise exception 'Space not found' using errcode = 'P0002'; end if;
  if space_row.settings_revision <> p_expected_settings_revision then
    raise exception 'Space settings revision conflict' using errcode = '40001',
      detail = jsonb_build_object('currentRevision', space_row.settings_revision)::text;
  end if;

  if p_channel_id is not null then
    select * into channel_entity
      from public.entities
     where id = p_channel_id
     for update;
    if channel_entity.id is null
       or channel_entity.kind <> 'channel'
       or channel_entity.space_id <> p_space_id
       or channel_entity.deleted_at is not null
       or not internal.entity_readable(p_channel_id) then
      raise exception 'channel not found' using errcode = 'P0002';
    end if;
  end if;

  if space_row.default_channel_id is distinct from p_channel_id then
    perform internal.w1_set_writer('space_settings');
    update public.spaces
       set default_channel_id = p_channel_id,
           settings_revision = settings_revision + 1
     where id = p_space_id
     returning * into space_row;
    perform internal.w1_set_writer(null);
    event_effect := jsonb_build_object(
      'type', 'space.default_channel.updated',
      'channelId', p_channel_id,
      'settingsRevision', space_row.settings_revision
    ) || case when p_client_mutation_id is null then '{}'::jsonb else
      jsonb_build_object('clientMutationId', p_client_mutation_id) end;
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (
      p_space_id,
      internal.next_event_seq(p_space_id),
      'space.default_channel.updated',
      event_effect,
      p_client_mutation_id
    );
  end if;

  result := internal.w2_space_settings_view(p_space_id);
  return internal.ledger_record(
    p_client_mutation_id,
    'spaces.defaultChannel.set',
    result
  );
end
$$;

-- Import remains outside the public A01-A03 surface. This owner-only internal
-- effect accepts only an explicitly resolved stable mapping or explicit null;
-- the no-feed branch is always audited and never guesses a channel by name or
-- creation order.
create or replace function internal.w2_import_default_channel(
  p_space_id uuid,
  p_mapped_channel_id uuid,
  p_exported_stable_ref text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare space_row public.spaces; channel_entity public.entities;
begin
  select * into space_row from public.spaces where id = p_space_id for update;
  if space_row.id is null then raise exception 'Space not found' using errcode = 'P0002'; end if;
  if p_mapped_channel_id is not null then
    select * into channel_entity from public.entities
     where id = p_mapped_channel_id for update;
    if channel_entity.id is null or channel_entity.kind <> 'channel'
       or channel_entity.space_id <> p_space_id or channel_entity.deleted_at is not null then
      raise exception 'imported default channel mapping must resolve to a live same-Space channel'
        using errcode = '23514';
    end if;
  end if;
  if space_row.default_channel_id is distinct from p_mapped_channel_id then
    perform internal.w1_set_writer('space_settings');
    update public.spaces
       set default_channel_id = p_mapped_channel_id,
           settings_revision = settings_revision + 1
     where id = p_space_id
     returning * into space_row;
    perform internal.w1_set_writer(null);
  end if;
  if p_mapped_channel_id is null then
    perform internal.w1_audit(
      p_space_id,
      'default_channel_import_no_feed',
      jsonb_build_object(
        'exportedStableRef', p_exported_stable_ref,
        'defaultChannelId', null,
        'feedState', 'no-feed'
      )
    );
  end if;
  return jsonb_build_object(
    'defaultChannelId', p_mapped_channel_id,
    'settingsRevision', space_row.settings_revision
  );
end
$$;

-- Close implicit PostgreSQL function grants and the superseded loose menu RPC.
revoke execute on function public.get_space_menu(uuid) from public;
revoke execute on function public.update_space_menu(uuid, jsonb, integer, text) from public;
revoke execute on function public.set_space_default_channel(uuid, uuid, integer, text) from public;
revoke execute on function public.set_space_menu_config(uuid, integer, jsonb, integer, text) from tm8_app;
revoke all on all functions in schema internal from public;

grant execute on function
  public.get_space_menu(uuid),
  public.update_space_menu(uuid, jsonb, integer, text),
  public.set_space_default_channel(uuid, uuid, integer, text)
to tm8_app;

reset role;
