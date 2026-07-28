-- =============================================================================
-- 027 W2.G12 — custom entity-kind commands and the restricted Interaction
-- Profile lifecycle. Static Chat templates remain closed shipped registry
-- assets; immutable work-session pins remain the runtime authority.
--
-- Depends only on the frozen 001-016 foundation. There is no generic profile
-- mutation path and no public template authoring surface.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- Shared exact renderers and closed registry assets.
-- -----------------------------------------------------------------------------

create or replace function internal.w2g12_iso(p_value timestamptz)
returns text language sql immutable parallel safe as $$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create or replace function internal.w2g12_hash_json(p_value jsonb)
returns text language sql immutable parallel safe as $$
  select 'sha256:' || encode(sha256(convert_to(p_value::text, 'UTF8')), 'hex')
$$;

-- A function, rather than a table, is intentional: these are versioned binary
-- assets with no entity id, write path, API noun or mutable database row.
create or replace function internal.w2g12_static_chat_template(p_key text, p_version integer)
returns jsonb language sql immutable parallel safe as $$
  select case
    when p_key = 'tm8.chat.core' and p_version = 1 then jsonb_build_object(
      'key', 'tm8.chat.core',
      'version', 1,
      'schemaVersion', 1,
      'composerSchemaRef', 'tm8.composer.v1',
      'allowedOperationBindings', jsonb_build_array(
        'messages.post', 'messages.attachments.add',
        'messages.attachments.remove', 'readMarks.upsert'
      )
    )
    else null
  end
$$;

-- Validation schema v1's exact public operation-name set. Reserved operations
-- are intentionally absent: a profile cannot make an unavailable operation
-- discoverable. Invocation still re-authorizes every request independently.
create or replace function internal.w2g12_catalog_operation(p_name text)
returns boolean language sql immutable parallel safe as $$
  select p_name = any(array[
    'identity.get','spaces.list','spaces.create','spaces.get','spaces.update',
    'spaces.navigation','spaces.home','spaces.settings','spaces.members.list',
    'spaces.invites.list','spaces.invites.create','spaces.invites.revoke',
    'spaces.invites.redeem','spaces.taskAxes.list','spaces.taskAxes.create',
    'spaces.taskAxes.update','spaces.taskAxes.delete','spaces.leaderboard','spaces.awards',
    'entities.get','entities.create','entities.patch','entities.move','entities.delete',
    'entities.restore','entities.children','entities.hierarchy','entities.connections',
    'entities.versions','entities.activity','entities.react','entities.points.add',
    'entities.commands.complete','entities.commands.work','entities.commands.pull',
    'entities.commands.linkPr','entities.commands.linkCommit','tracking.refresh',
    'edges.list','edges.create','edges.patch','edges.delete','edgeTypes.list',
    'messages.list','messages.post','messages.edit','messages.delete','collections.query',
    'graph.query','placements.apply','commands.undo','projects.list','projects.create',
    'projects.get','projects.update','projects.link','projects.unlink','files.uploadInit',
    'files.uploadComplete','files.uploadAbort','files.download','inbox.list','inbox.markRead',
    'readMarks.upsert','savedViews.list','savedViews.create','savedViews.update',
    'savedViews.delete','actions.list','events.subscribe','events.poll','presence.get',
    'execution.spawn','execution.prompt','execution.terminate','execution.streams.attach',
    'entityKinds.list','entityKinds.create','entityKinds.update','spaces.menu.get',
    'spaces.menu.update','spaces.defaultChannel.set','projects.associations.correct',
    'handoffs.send','handoffs.list','handoffs.withdraw','messages.attachments.add',
    'messages.attachments.remove','messages.delivery.get','entities.feed','entities.context',
    'interactionProfiles.propose','interactionProfiles.updateDraft',
    'interactionProfiles.validate','interactionProfiles.preview','interactionProfiles.activate',
    'interactionProfiles.retire','teamMembers.interactionProfile.setDefault',
    'spaces.interactionProfile.setDefault'
  ]::text[])
$$;

create or replace function internal.w2g12_core_draft()
returns jsonb language sql immutable parallel safe as $$
  select '{
    "name":"Core collaboration",
    "templateKey":"tm8.chat.core",
    "templateVersion":1,
    "promptPolicy":{
      "kernelTemplate":"tm8.core.v1",
      "manifestMaxBytes":4096,
      "kernelMaxBytes":6144,
      "initialContextMaxBytes":32768,
      "rollingControlMaxBytes":32768,
      "allowedInjectionKinds":[],
      "untrustedEncoding":"escaped-xml"
    },
    "toolDiscoveryPolicy":{
      "rootHelpRef":"tm8://help",
      "preloadNouns":["entities","messages"],
      "semanticSearchEnabled":true,
      "semanticMaxMatches":5,
      "nounShardMaxBytes":8192,
      "commandShardMaxBytes":16384,
      "entityContextDefaultBytes":16384,
      "providerToolRegistrationAllowlist":["entities.get","messages.post"]
    },
    "feedPolicy":{"scope":"session_chat_v1","pageSize":50,"bodyExcerptBytes":1024},
    "providerCaptureMode":"explicit-only",
    "composerPolicy":{
      "schemaRef":"tm8.composer.v1",
      "supportsReply":true,
      "supportsAttachments":true,
      "allowedAttachmentKinds":["file"],
      "operationBindings":["messages.post","messages.attachments.add"]
    }
  }'::jsonb
$$;

-- Replace the provisional W1 fallback with the closed registry identity. W1's
-- existing pins remain immutable and auditable; future fallback revisions use
-- this complete snapshot.
create or replace function internal.w1_core_pin_snapshot() returns jsonb
language sql immutable parallel safe as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'projectorVersion', 1,
    'profile', jsonb_build_object('source', 'core_default'),
    'template', internal.w2g12_static_chat_template('tm8.chat.core', 1),
    'draft', internal.w2g12_core_draft(),
    'terminal', jsonb_build_object('alwaysAvailable', true),
    'agentProjection', jsonb_build_object(
      'promptPolicy', internal.w2g12_core_draft() -> 'promptPolicy',
      'toolDiscoveryPolicy', internal.w2g12_core_draft() -> 'toolDiscoveryPolicy',
      'feedPolicy', internal.w2g12_core_draft() -> 'feedPolicy',
      'providerCaptureMode', 'explicit-only'
    ),
    'browserProjection', jsonb_build_object(
      'templateKey', 'tm8.chat.core', 'templateVersion', 1,
      'feedPolicy', internal.w2g12_core_draft() -> 'feedPolicy',
      'composerPolicy', internal.w2g12_core_draft() -> 'composerPolicy'
    )
  )
$$;

-- -----------------------------------------------------------------------------
-- Replay authorization.
--
-- internal.ledger_replay is keyed on the caller-supplied clientMutationId
-- alone — not on identity, Space or input — so returning its result without a
-- check hands one caller's stored command result to any other caller who names
-- the same mutation id. For this group that result is the whole
-- InteractionProfileView, promptPolicy and toolDiscoveryPolicy included, which
-- §6.4 says never leaves the authorized surface.
--
-- Authorizing only the ROUTE would not close it here, because every route
-- argument is caller-supplied while the ledger is global: an outsider can name
-- its own Space and still be handed a foreign row. So each replay is authorized
-- against the SPACE OF THE STORED RESULT, at the same tier the live path
-- requires, which is the shape the frozen savedViews commands (024) already
-- use. The mapping below is total and enumerable; an unlisted operation is
-- refused rather than allowed.
-- -----------------------------------------------------------------------------

create or replace function internal.w2g12_authorize_replay(
  p_operation text, p_replay jsonb
) returns void language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare target_space uuid;
begin
  if p_replay is null then return; end if;
  target_space := case p_operation
    when 'interactionProfiles.validate' then (
      select entity_row.space_id from public.entities entity_row
       where entity_row.id = nullif(p_replay ->> 'profileId', '')::uuid)
    when 'teamMembers.interactionProfile.setDefault' then (
      select entity_row.space_id from public.entities entity_row
       where entity_row.id = nullif(p_replay ->> 'teamMemberId', '')::uuid)
    else nullif(p_replay ->> 'spaceId', '')::uuid
  end;
  if target_space is null then
    raise exception 'replayed % result carries no authorizable Space', p_operation
      using errcode = '42501';
  end if;
  if p_operation in ('entityKinds.create', 'entityKinds.update') then
    perform internal.require_space_admin(target_space);
  elsif p_operation in ('interactionProfiles.propose', 'interactionProfiles.updateDraft',
                        'interactionProfiles.validate') then
    perform internal.require_space_member(target_space);
  elsif p_operation in ('interactionProfiles.activate', 'interactionProfiles.retire',
                        'teamMembers.interactionProfile.setDefault',
                        'spaces.interactionProfile.setDefault') then
    perform internal.require_human_space_admin(target_space);
  else
    raise exception 'no enumerated replay authorization for %', p_operation using errcode = '42501';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Custom entity-kind registry commands.
-- -----------------------------------------------------------------------------

create or replace function internal.w2g12_assert_capabilities(p_capabilities jsonb)
returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
begin
  if jsonb_typeof(p_capabilities) is distinct from 'object'
     or exists (
       select 1 from jsonb_each(p_capabilities) capability where jsonb_typeof(capability.value) <> 'boolean'
     ) then
    raise exception 'entity-kind capabilities must be a boolean object' using errcode = '22023';
  end if;
end
$$;

create or replace function internal.w2g12_assert_field_schema(p_schema jsonb)
returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare field_value jsonb; names text[] := array[]::text[]; enum_values text[];
begin
  if jsonb_typeof(p_schema) is distinct from 'array' or jsonb_array_length(p_schema) > 64 then
    raise exception 'fieldSchema must be an array with at most 64 scalar fields' using errcode = '22023';
  end if;
  for field_value in select value from jsonb_array_elements(p_schema) loop
    if jsonb_typeof(field_value) <> 'object'
       or not (field_value ?& array['name','type'])
       or exists (
         select 1 from jsonb_object_keys(field_value) field_key
          where field_key not in ('name','type','required','values')
       )
       or jsonb_typeof(field_value -> 'name') <> 'string'
       or jsonb_typeof(field_value -> 'type') <> 'string'
       or char_length(btrim(field_value ->> 'name')) not between 1 and 64
       or (field_value ? 'required' and jsonb_typeof(field_value -> 'required') <> 'boolean')
       or field_value ->> 'type' not in ('text','number','bool','date','enum') then
      raise exception 'invalid scalar custom field definition' using errcode = '22023';
    end if;
    if field_value ->> 'name' = any(names) then
      raise exception 'custom field names must be unique' using errcode = '22023';
    end if;
    names := array_append(names, field_value ->> 'name');
    if field_value ->> 'type' = 'enum' then
      if not (field_value ? 'values') or jsonb_typeof(field_value -> 'values') <> 'array'
         or jsonb_array_length(field_value -> 'values') = 0
         or exists (
           select 1 from jsonb_array_elements(field_value -> 'values') item
            where jsonb_typeof(item) <> 'string' or btrim(item #>> '{}') = ''
         ) then
        raise exception 'enum fields require non-empty string values' using errcode = '22023';
      end if;
      select array_agg(value order by value) into enum_values
        from jsonb_array_elements_text(field_value -> 'values') value;
      if cardinality(enum_values) <> cardinality(array(select distinct value from unnest(enum_values) value)) then
        raise exception 'enum field values must be unique' using errcode = '22023';
      end if;
    elsif field_value ? 'values' then
      raise exception 'only enum fields may declare values' using errcode = '22023';
    end if;
  end loop;
end
$$;

create or replace function internal.w2g12_assert_fields_match_schema(p_fields jsonb, p_schema jsonb)
returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare field_value jsonb; field_name text; field_type text; supplied jsonb;
begin
  if jsonb_typeof(p_fields) <> 'object' then
    raise exception 'custom fields must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_fields) supplied_name
     where not exists (
       select 1 from jsonb_array_elements(p_schema) declared
        where declared ->> 'name' = supplied_name
     )
  ) then
    raise exception 'custom fields contain an undeclared value' using errcode = '23514';
  end if;
  for field_value in select value from jsonb_array_elements(p_schema) loop
    field_name := field_value ->> 'name';
    field_type := field_value ->> 'type';
    supplied := p_fields -> field_name;
    if supplied is null or jsonb_typeof(supplied) = 'null' then
      if coalesce((field_value ->> 'required')::boolean, false) then
        raise exception 'existing custom data lacks required field %', field_name using errcode = '23514';
      end if;
      continue;
    end if;
    if (field_type = 'text' and jsonb_typeof(supplied) <> 'string')
       or (field_type = 'number' and jsonb_typeof(supplied) <> 'number')
       or (field_type = 'bool' and jsonb_typeof(supplied) <> 'boolean')
       or (field_type = 'date' and jsonb_typeof(supplied) <> 'string')
       or (field_type = 'enum' and (
         jsonb_typeof(supplied) <> 'string'
         or not exists (
           select 1 from jsonb_array_elements_text(field_value -> 'values') allowed
            where allowed = supplied #>> '{}'
         )
       )) then
      raise exception 'existing custom data violates the proposed schema at field %', field_name
        using errcode = '23514';
    end if;
    if field_type = 'date' then
      begin
        perform (supplied #>> '{}')::timestamptz;
      exception when others then
        raise exception 'existing custom date field % is invalid', field_name using errcode = '23514';
      end;
    end if;
  end loop;
end
$$;

create or replace function internal.w2g12_entity_kind_view(p_kind_id uuid)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', kind_row.id,
    'kind', kind_row.kind,
    'origin', kind_row.origin,
    'spaceId', kind_row.space_id,
    'icon', kind_row.icon,
    'fieldSchema', kind_row.field_schema,
    'capabilities', kind_row.capabilities,
    'createdBy', kind_row.created_by,
    'createdAt', internal.w2g12_iso(kind_row.created_at)
  )
  from public.entity_kinds kind_row where kind_row.id = p_kind_id
$$;

create or replace function public.w2_create_entity_kind(
  p_space_id uuid,
  p_kind text,
  p_icon text,
  p_field_schema jsonb,
  p_capabilities jsonb,
  p_actor_id uuid,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; kind_id uuid; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entityKinds.create');
  if replay is not null then
    perform internal.w2g12_authorize_replay('entityKinds.create', replay);
    return replay;
  end if;
  perform internal.require_space_admin(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  if p_kind is null or p_kind !~ '^c:[a-z0-9][a-z0-9_]{0,48}$' then
    raise exception 'custom entity kinds must use the c:* namespace' using errcode = '22023';
  end if;
  if p_icon is not null and char_length(p_icon) > 100 then
    raise exception 'entity-kind icon is too long' using errcode = '22023';
  end if;
  perform internal.w2g12_assert_field_schema(coalesce(p_field_schema, '[]'::jsonb));
  perform internal.w2g12_assert_capabilities(coalesce(p_capabilities, '{}'::jsonb));
  insert into public.entity_kinds(kind, origin, space_id, icon, field_schema, capabilities, created_by)
  values (p_kind, 'custom', p_space_id, p_icon, coalesce(p_field_schema, '[]'::jsonb),
          coalesce(p_capabilities, '{}'::jsonb), actor)
  returning id into kind_id;
  result := internal.w2g12_entity_kind_view(kind_id);
  return internal.ledger_record(p_client_mutation_id, 'entityKinds.create', result);
end
$$;

create or replace function public.w2_update_entity_kind(
  p_space_id uuid,
  p_kind text,
  p_patch jsonb,
  p_actor_id uuid,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; current_row public.entity_kinds; new_schema jsonb; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entityKinds.update');
  if replay is not null then
    perform internal.w2g12_authorize_replay('entityKinds.update', replay);
    return replay;
  end if;
  perform internal.require_space_admin(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  if p_kind is null or p_kind !~ '^c:[a-z0-9][a-z0-9_]{0,48}$'
     or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
     or exists (
       select 1 from jsonb_object_keys(p_patch) patch_key
        where patch_key not in ('icon','fieldSchema','capabilities','allowTightening')
     ) then
    raise exception 'invalid custom entity-kind update' using errcode = '22023';
  end if;
  select * into current_row from public.entity_kinds
   where space_id = p_space_id and kind = p_kind and origin = 'custom' for update;
  if current_row.id is null then raise exception 'custom entity kind not found' using errcode = 'P0002'; end if;
  if p_patch ? 'icon' and jsonb_typeof(p_patch -> 'icon') not in ('string','null') then
    raise exception 'entity-kind icon must be a string or null' using errcode = '22023';
  end if;
  if p_patch ? 'allowTightening' and jsonb_typeof(p_patch -> 'allowTightening') <> 'boolean' then
    raise exception 'allowTightening must be boolean' using errcode = '22023';
  end if;
  new_schema := case when p_patch ? 'fieldSchema' then p_patch -> 'fieldSchema' else current_row.field_schema end;
  perform internal.w2g12_assert_field_schema(new_schema);
  if p_patch ? 'capabilities' then perform internal.w2g12_assert_capabilities(p_patch -> 'capabilities'); end if;
  perform internal.assert_schema_evolution(
    current_row.field_schema,
    new_schema,
    coalesce((p_patch ->> 'allowTightening')::boolean, false)
  );
  if coalesce((p_patch ->> 'allowTightening')::boolean, false) then
    perform internal.w2g12_assert_fields_match_schema(custom_row.fields, new_schema)
      from public.custom_entities custom_row
      join public.entities entity_row on entity_row.id = custom_row.entity_id
     where entity_row.space_id = p_space_id and entity_row.kind = p_kind;
  end if;
  update public.entity_kinds
     set icon = case when p_patch ? 'icon' then p_patch ->> 'icon' else icon end,
         field_schema = new_schema,
         capabilities = case when p_patch ? 'capabilities' then p_patch -> 'capabilities' else capabilities end
   where id = current_row.id;
  result := internal.w2g12_entity_kind_view(current_row.id);
  return internal.ledger_record(p_client_mutation_id, 'entityKinds.update', result);
end
$$;

-- -----------------------------------------------------------------------------
-- Restricted Interaction Profile validation and render helpers.
-- -----------------------------------------------------------------------------

create or replace function internal.w2g12_assert_profile_draft_input(p_draft jsonb)
returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare policy jsonb; discovery jsonb; feed jsonb; composer jsonb;
begin
  if jsonb_typeof(p_draft) <> 'object'
     or not (p_draft ?& array[
       'name','templateKey','templateVersion','promptPolicy','toolDiscoveryPolicy',
       'feedPolicy','providerCaptureMode','composerPolicy'
     ])
     or exists (
       select 1 from jsonb_object_keys(p_draft) draft_key where draft_key not in (
         'name','templateKey','templateVersion','promptPolicy','toolDiscoveryPolicy',
         'feedPolicy','providerCaptureMode','composerPolicy'
       )
     )
     or jsonb_typeof(p_draft -> 'name') <> 'string'
     or char_length(p_draft ->> 'name') not between 1 and 80
     or jsonb_typeof(p_draft -> 'templateKey') <> 'string'
     or btrim(p_draft ->> 'templateKey') = ''
     or jsonb_typeof(p_draft -> 'templateVersion') <> 'number'
     or (p_draft ->> 'templateVersion')::numeric <> trunc((p_draft ->> 'templateVersion')::numeric)
     or (p_draft ->> 'templateVersion')::integer < 1 then
    raise exception 'invalid Interaction Profile draft shape' using errcode = '22023';
  end if;
  if p_draft ->> 'providerCaptureMode' <> 'explicit-only' then
    raise exception 'provider capture mode is reserved in Phase 1'
      using errcode = '22023', detail = 'profile_capture_mode_reserved';
  end if;
  policy := p_draft -> 'promptPolicy';
  discovery := p_draft -> 'toolDiscoveryPolicy';
  feed := p_draft -> 'feedPolicy';
  composer := p_draft -> 'composerPolicy';
  if jsonb_typeof(policy) <> 'object'
     or not (policy ?& array['kernelTemplate','manifestMaxBytes','kernelMaxBytes',
       'initialContextMaxBytes','rollingControlMaxBytes','allowedInjectionKinds','untrustedEncoding'])
     or exists (select 1 from jsonb_object_keys(policy) k where k not in (
       'kernelTemplate','manifestMaxBytes','kernelMaxBytes','initialContextMaxBytes',
       'rollingControlMaxBytes','allowedInjectionKinds','untrustedEncoding'))
     or policy ->> 'untrustedEncoding' <> 'escaped-xml'
     or jsonb_typeof(policy -> 'allowedInjectionKinds') <> 'array'
     or (policy ->> 'manifestMaxBytes')::integer not between 1 and 4096
     or (policy ->> 'kernelMaxBytes')::integer not between 1 and 6144
     or (policy ->> 'initialContextMaxBytes')::integer not between 1 and 32768
     or (policy ->> 'rollingControlMaxBytes')::integer not between 1 and 32768 then
    raise exception 'invalid closed prompt policy' using errcode = '22023';
  end if;
  if jsonb_typeof(discovery) <> 'object'
     or not (discovery ?& array['rootHelpRef','preloadNouns','semanticSearchEnabled',
       'semanticMaxMatches','nounShardMaxBytes','commandShardMaxBytes','entityContextDefaultBytes'])
     or exists (select 1 from jsonb_object_keys(discovery) k where k not in (
       'rootHelpRef','preloadNouns','semanticSearchEnabled','semanticMaxMatches','nounShardMaxBytes',
       'commandShardMaxBytes','entityContextDefaultBytes','providerToolRegistrationAllowlist'))
     or discovery ->> 'rootHelpRef' <> 'tm8://help'
     or jsonb_typeof(discovery -> 'preloadNouns') <> 'array'
     or jsonb_typeof(discovery -> 'semanticSearchEnabled') <> 'boolean'
     or (discovery ->> 'semanticMaxMatches')::integer not between 0 and 5
     or (discovery ->> 'nounShardMaxBytes')::integer not between 1 and 32768
     or (discovery ->> 'commandShardMaxBytes')::integer not between 1 and 32768
     or (discovery ->> 'entityContextDefaultBytes')::integer not between 1024 and 32768
     or (discovery ? 'providerToolRegistrationAllowlist'
       and jsonb_typeof(discovery -> 'providerToolRegistrationAllowlist') <> 'array') then
    raise exception 'invalid tool discovery policy' using errcode = '22023';
  end if;
  if jsonb_typeof(feed) <> 'object'
     or not (feed ?& array['scope','pageSize','bodyExcerptBytes'])
     or exists (select 1 from jsonb_object_keys(feed) k where k not in ('scope','pageSize','bodyExcerptBytes'))
     or feed ->> 'scope' not in ('direct_v1','session_chat_v1')
     or (feed ->> 'pageSize')::integer not between 1 and 100
     or (feed ->> 'bodyExcerptBytes')::integer not between 0 and 4096 then
    raise exception 'invalid feed policy' using errcode = '22023';
  end if;
  if jsonb_typeof(composer) <> 'object'
     or not (composer ?& array['schemaRef','supportsReply','supportsAttachments',
       'allowedAttachmentKinds','operationBindings'])
     or exists (select 1 from jsonb_object_keys(composer) k where k not in (
       'schemaRef','supportsReply','supportsAttachments','allowedAttachmentKinds','operationBindings'))
     or jsonb_typeof(composer -> 'schemaRef') <> 'string'
     or jsonb_typeof(composer -> 'supportsReply') <> 'boolean'
     or jsonb_typeof(composer -> 'supportsAttachments') <> 'boolean'
     or jsonb_typeof(composer -> 'allowedAttachmentKinds') <> 'array'
     or jsonb_typeof(composer -> 'operationBindings') <> 'array' then
    raise exception 'invalid composer interaction policy' using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_array_elements(policy -> 'allowedInjectionKinds') item
        where jsonb_typeof(item) <> 'string' or btrim(item #>> '{}') = ''
     )
     or jsonb_array_length(policy -> 'allowedInjectionKinds') <> (
       select count(distinct item #>> '{}') from jsonb_array_elements(policy -> 'allowedInjectionKinds') item
     )
     or exists (
       select 1 from jsonb_array_elements(discovery -> 'preloadNouns') item
        where jsonb_typeof(item) <> 'string' or btrim(item #>> '{}') = ''
     )
     or jsonb_array_length(discovery -> 'preloadNouns') <> (
       select count(distinct item #>> '{}') from jsonb_array_elements(discovery -> 'preloadNouns') item
     )
     or exists (
       select 1 from jsonb_array_elements(composer -> 'allowedAttachmentKinds') item
        where jsonb_typeof(item) <> 'string' or btrim(item #>> '{}') = ''
     )
     or jsonb_array_length(composer -> 'allowedAttachmentKinds') <> (
       select count(distinct item #>> '{}') from jsonb_array_elements(composer -> 'allowedAttachmentKinds') item
     )
     or exists (
       select 1 from jsonb_array_elements(composer -> 'operationBindings') item
        where jsonb_typeof(item) <> 'string' or btrim(item #>> '{}') = ''
     )
     or jsonb_array_length(composer -> 'operationBindings') <> (
       select count(distinct item #>> '{}') from jsonb_array_elements(composer -> 'operationBindings') item
     )
     or (discovery ? 'providerToolRegistrationAllowlist' and (
       exists (
         select 1 from jsonb_array_elements(discovery -> 'providerToolRegistrationAllowlist') item
          where jsonb_typeof(item) <> 'string' or btrim(item #>> '{}') = ''
       )
       or jsonb_array_length(discovery -> 'providerToolRegistrationAllowlist') <> (
         select count(distinct item #>> '{}')
           from jsonb_array_elements(discovery -> 'providerToolRegistrationAllowlist') item
       )
     )) then
    raise exception 'profile policy string arrays must contain unique non-empty strings'
      using errcode = '22023';
  end if;
end
$$;

create or replace function internal.w2g12_profile_view(p_profile_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare entity_row public.entities; profile_row public.interaction_profiles;
declare draft_row public.interaction_profile_versions; result jsonb;
begin
  select * into entity_row from public.entities where id = p_profile_id;
  select * into profile_row from public.interaction_profiles where entity_id = p_profile_id;
  select * into draft_row from public.interaction_profile_versions
   where profile_id = p_profile_id and version = profile_row.current_draft_version;
  if entity_row.id is null or profile_row.entity_id is null or draft_row.profile_id is null then
    raise exception 'Interaction Profile not found' using errcode = 'P0002';
  end if;
  result := jsonb_build_object(
    'profileId', p_profile_id,
    'spaceId', entity_row.space_id,
    'status', profile_row.status,
    'currentDraftVersion', profile_row.current_draft_version,
    'validatedVersion', case when draft_row.validation_status = 'valid' then draft_row.version else null end,
    'validatedHash', case when draft_row.validation_status = 'valid' then draft_row.validated_hash else null end,
    'activeVersion', profile_row.active_version,
    'activeHash', profile_row.active_hash,
    'generatedByTeamMemberId', profile_row.generated_by_team_member_id,
    'retiredAt', case when profile_row.retired_at is null then null else internal.w2g12_iso(profile_row.retired_at) end,
    'version', entity_row.version,
    'draft', draft_row.draft_json
  );
  return result;
end
$$;

-- The restricted kind remains universally readable/reactable/connectable, but
-- generic patch/move/delete/restore may not become a second lifecycle writer.
create or replace function internal.w2g12_guard_profile_envelope() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if old.kind = 'interaction_profile' and (
       new.parent_id is distinct from old.parent_id
    or new.position is distinct from old.position
    or new.visibility is distinct from old.visibility
    or new.deleted_at is distinct from old.deleted_at
  ) then
    raise exception 'interaction_profile lifecycle is restricted to its named commands'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger entities_w2g12_restricted_profile_envelope
before update of parent_id, position, visibility, deleted_at on public.entities
for each row execute function internal.w2g12_guard_profile_envelope();

create or replace function internal.w2g12_advance_profile_entity(p_profile_id uuid, p_actor uuid)
returns integer language plpgsql set search_path = public, internal, pg_temp as $$
declare next_version integer;
begin
  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_profile_id
   returning version into next_version;
  insert into public.entity_versions(entity_id, version, snapshot, changed_by)
  values (p_profile_id, next_version, internal.entity_snapshot(p_profile_id), p_actor)
  on conflict (entity_id, version) do nothing;
  return next_version;
end
$$;

create or replace function internal.w2g12_authorize_profile_draft(
  p_profile_id uuid, p_actor_id uuid
) returns uuid language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare entity_row public.entities; profile_row public.interaction_profiles; actor uuid; actor_entity public.entities;
begin
  select * into entity_row from public.entities where id = p_profile_id;
  select * into profile_row from public.interaction_profiles where entity_id = p_profile_id;
  if entity_row.id is null or entity_row.deleted_at is not null or profile_row.entity_id is null then
    raise exception 'Interaction Profile not found' using errcode = 'P0002';
  end if;
  if profile_row.status = 'retired' then
    raise exception 'Interaction Profile is retired' using errcode = '23514', detail = 'profile_retired';
  end if;
  actor := internal.resolve_actor(p_actor_id, entity_row.space_id);
  select * into actor_entity from public.entities where id = actor;
  if actor_entity.kind = 'team_member' then
    if profile_row.generated_by_team_member_id is distinct from actor then
      raise exception 'Teammate may update only its own proposed Interaction Profile'
        using errcode = '42501';
    end if;
  elsif actor_entity.kind = 'member' then
    if not exists (
      select 1 from public.members member_row where member_row.entity_id = actor
       and member_row.space_id = entity_row.space_id and member_row.role in ('owner','admin')
    ) then
      raise exception 'Space owner/admin or proposing Teammate required' using errcode = '42501';
    end if;
  else
    raise exception 'invalid Interaction Profile author' using errcode = '42501';
  end if;
  perform internal.bind_actor(actor);
  return actor;
end
$$;

create or replace function internal.w2g12_profile_snapshot(
  p_profile_id uuid, p_profile_version integer, p_source text
) returns jsonb language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'projectorVersion', 1,
    'profile', jsonb_build_object(
      'id', version_row.profile_id, 'version', version_row.version, 'source', p_source,
      'validationHash', version_row.validated_hash,
      'generatedByTeamMemberId', profile_row.generated_by_team_member_id
    ),
    'template', internal.w2g12_static_chat_template(
      version_row.draft_json ->> 'templateKey',
      (version_row.draft_json ->> 'templateVersion')::integer
    ),
    'draft', version_row.draft_json,
    'terminal', jsonb_build_object('alwaysAvailable', true),
    'agentProjection', jsonb_build_object(
      'promptPolicy', version_row.draft_json -> 'promptPolicy',
      'toolDiscoveryPolicy', version_row.draft_json -> 'toolDiscoveryPolicy',
      'feedPolicy', version_row.draft_json -> 'feedPolicy',
      'providerCaptureMode', version_row.draft_json -> 'providerCaptureMode'
    ),
    'browserProjection', jsonb_build_object(
      'templateKey', version_row.draft_json -> 'templateKey',
      'templateVersion', version_row.draft_json -> 'templateVersion',
      'feedPolicy', version_row.draft_json -> 'feedPolicy',
      'composerPolicy', version_row.draft_json -> 'composerPolicy'
    )
  )
  from public.interaction_profile_versions version_row
  join public.interaction_profiles profile_row on profile_row.entity_id = version_row.profile_id
  where version_row.profile_id = p_profile_id
    and version_row.version = p_profile_version
    and version_row.validation_status = 'valid'
$$;

create or replace function internal.w2g12_profile_validation_evidence(
  p_profile_id uuid,
  p_profile_version integer,
  p_draft jsonb,
  p_generated_by uuid,
  p_active_version integer
) returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare template jsonb; issues jsonb := '[]'::jsonb; allowed jsonb; operation_value jsonb;
declare prior_draft jsonb; baseline text; structured_diff jsonb; hash_input jsonb; validated_hash text;
begin
  template := internal.w2g12_static_chat_template(
    p_draft ->> 'templateKey', (p_draft ->> 'templateVersion')::integer
  );
  if template is null then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'path', 'templateKey', 'code', 'unknown_static_template',
      'message', 'static template key/version is not shipped by this Server'
    ));
  else
    if p_draft #>> '{composerPolicy,schemaRef}' is distinct from template ->> 'composerSchemaRef' then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'path', 'composerPolicy.schemaRef', 'code', 'template_schema_mismatch',
        'message', 'composer schema does not match the selected static template version'
      ));
    end if;
    allowed := template -> 'allowedOperationBindings';
    for operation_value in
      select value from jsonb_array_elements(p_draft #> '{composerPolicy,operationBindings}')
    loop
      if jsonb_typeof(operation_value) <> 'string'
         or not (allowed ? (operation_value #>> '{}')) then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', 'composerPolicy.operationBindings', 'code', 'unsupported_operation_binding',
          'message', 'static template does not request this catalog operation'
        ));
      end if;
    end loop;
  end if;
  if p_draft::text ~* '"(credential|credentials|secret|api[_-]?key|authority|permissions?|grant)"[[:space:]]*:' then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'path', '', 'code', 'authority_or_credential_declaration',
      'message', 'profiles may narrow interaction but cannot declare authority or credentials'
    ));
  end if;
  if p_draft::text ~ '(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})' then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'path', '', 'code', 'credential_value_detected',
      'message', 'Interaction Profiles may not contain credential values'
    ));
  end if;
  if p_active_version is null then
    prior_draft := null;
    baseline := 'initial activation — no prior baseline';
  else
    select draft_json into prior_draft from public.interaction_profile_versions
     where profile_id = p_profile_id and version = p_active_version;
    baseline := format('active profile version %s', p_active_version);
  end if;
  structured_diff := jsonb_build_object(
    'baseline', baseline,
    'sections', jsonb_build_object(
      'template', jsonb_build_object(
        'before', case when prior_draft is null then null else jsonb_build_object(
          'key', prior_draft -> 'templateKey', 'version', prior_draft -> 'templateVersion') end,
        'after', jsonb_build_object('key', p_draft -> 'templateKey', 'version', p_draft -> 'templateVersion'),
        'changed', prior_draft is null or (prior_draft -> 'templateKey') is distinct from (p_draft -> 'templateKey')
          or (prior_draft -> 'templateVersion') is distinct from (p_draft -> 'templateVersion')
      ),
      'promptPolicy', jsonb_build_object('before', prior_draft -> 'promptPolicy',
        'after', p_draft -> 'promptPolicy',
        'changed', prior_draft is null or (prior_draft -> 'promptPolicy') is distinct from (p_draft -> 'promptPolicy')),
      'toolDiscoveryPolicy', jsonb_build_object('before', prior_draft -> 'toolDiscoveryPolicy',
        'after', p_draft -> 'toolDiscoveryPolicy',
        'changed', prior_draft is null or (prior_draft -> 'toolDiscoveryPolicy') is distinct from (p_draft -> 'toolDiscoveryPolicy')),
      'feedPolicy', jsonb_build_object('before', prior_draft -> 'feedPolicy',
        'after', p_draft -> 'feedPolicy',
        'changed', prior_draft is null or (prior_draft -> 'feedPolicy') is distinct from (p_draft -> 'feedPolicy')),
      'composerPolicy', jsonb_build_object('before', prior_draft -> 'composerPolicy',
        'after', p_draft -> 'composerPolicy',
        'changed', prior_draft is null or (prior_draft -> 'composerPolicy') is distinct from (p_draft -> 'composerPolicy')),
      'providerCaptureMode', jsonb_build_object('before', prior_draft -> 'providerCaptureMode',
        'after', p_draft -> 'providerCaptureMode',
        'changed', prior_draft is null or (prior_draft -> 'providerCaptureMode') is distinct from (p_draft -> 'providerCaptureMode'))
    )
  );
  if p_draft #> '{toolDiscoveryPolicy,providerToolRegistrationAllowlist}' is not null then
    for operation_value in
      select value from jsonb_array_elements(
        p_draft #> '{toolDiscoveryPolicy,providerToolRegistrationAllowlist}'
      )
    loop
      if jsonb_typeof(operation_value) <> 'string'
         or not internal.w2g12_catalog_operation(operation_value #>> '{}') then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'path', 'toolDiscoveryPolicy.providerToolRegistrationAllowlist',
          'code', 'unknown_operation_request',
          'message', 'tool discovery may request only a catalogued v1 operation'
        ));
      end if;
    end loop;
  end if;
  hash_input := jsonb_build_object(
    'schemaVersion', 1, 'projectorVersion', 1,
    'profileId', p_profile_id, 'profileVersion', p_profile_version,
    'generatedByTeamMemberId', p_generated_by,
    'template', template, 'draft', p_draft
  );
  if jsonb_array_length(issues) = 0 then
    validated_hash := internal.w2g12_hash_json(hash_input);
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'profileId', p_profile_id,
    'profileVersion', p_profile_version,
    'template', coalesce(template, jsonb_build_object(
      'key', p_draft -> 'templateKey', 'version', p_draft -> 'templateVersion')),
    'provenance', jsonb_build_object(
      'generatedByTeamMemberId', p_generated_by,
      'validatedByIdentityId', internal.identity_id(),
      'validatedActorId', internal.actor_id()
    ),
    'structuredDiff', structured_diff,
    'issues', issues,
    'validatedHash', validated_hash
  );
end
$$;

-- -----------------------------------------------------------------------------
-- A13-A18: the sole restricted profile content/lifecycle family.
-- -----------------------------------------------------------------------------

create or replace function public.propose_interaction_profile(
  p_space_id uuid,
  p_draft jsonb,
  p_actor_id uuid,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; actor_entity public.entities; profile_id uuid; generator uuid; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'interactionProfiles.propose');
  if replay is not null then
    perform internal.w2g12_authorize_replay('interactionProfiles.propose', replay);
    return replay;
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);
  select * into actor_entity from public.entities where id = actor;
  if actor_entity.kind = 'team_member' then
    generator := actor;
  elsif actor_entity.kind = 'member' then
    if not exists (
      select 1 from public.members member_row where member_row.entity_id = actor
       and member_row.space_id = p_space_id and member_row.role in ('owner','admin')
    ) then
      raise exception 'Space owner/admin or Teammate required to propose a profile'
        using errcode = '42501';
    end if;
    generator := null;
  else
    raise exception 'invalid Interaction Profile proposer' using errcode = '42501';
  end if;
  perform internal.w2g12_assert_profile_draft_input(p_draft);
  profile_id := internal.create_envelope(p_space_id, 'interaction_profile', actor, null, null);
  insert into public.interaction_profiles(entity_id, status, current_draft_version,
    generated_by_team_member_id)
  values (profile_id, 'draft', 1, generator);
  insert into public.interaction_profile_versions(profile_id, version, draft_json)
  values (profile_id, 1, p_draft);
  perform internal.record_initial_version(profile_id, actor);
  perform internal.record_activity(p_space_id, profile_id, actor, 'created', null,
    jsonb_build_object('kind','interaction_profile','draftVersion',1));
  result := internal.w2g12_profile_view(profile_id);
  return internal.ledger_record(p_client_mutation_id, 'interactionProfiles.propose', result);
end
$$;

create or replace function public.update_interaction_profile_draft(
  p_profile_id uuid,
  p_expected_version integer,
  p_draft jsonb,
  p_actor_id uuid,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_row public.entities; profile_row public.interaction_profiles;
declare next_draft integer; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'interactionProfiles.updateDraft');
  if replay is not null then
    perform internal.w2g12_authorize_replay('interactionProfiles.updateDraft', replay);
    return replay;
  end if;
  -- Authorize the route entity BEFORE the optimistic check: assert_version is
  -- SECURITY DEFINER and raises 40001 carrying currentVersion, so running it
  -- first tells an unauthorized caller that a foreign profile exists and what
  -- version it is on.
  actor := internal.w2g12_authorize_profile_draft(p_profile_id, p_actor_id);
  perform internal.assert_version(p_profile_id, p_expected_version);
  select * into entity_row from public.entities where id = p_profile_id;
  select * into profile_row from public.interaction_profiles where entity_id = p_profile_id for update;
  perform internal.w2g12_assert_profile_draft_input(p_draft);
  next_draft := profile_row.current_draft_version + 1;
  insert into public.interaction_profile_versions(profile_id, version, draft_json)
  values (p_profile_id, next_draft, p_draft);
  update public.interaction_profiles set current_draft_version = next_draft where entity_id = p_profile_id;
  perform internal.w2g12_advance_profile_entity(p_profile_id, actor);
  perform internal.record_activity(entity_row.space_id, p_profile_id, actor, 'updated', null,
    jsonb_build_object('kind','interaction_profile','draftVersion',next_draft));
  result := internal.w2g12_profile_view(p_profile_id);
  return internal.ledger_record(p_client_mutation_id, 'interactionProfiles.updateDraft', result);
end
$$;

create or replace function public.validate_interaction_profile(
  p_profile_id uuid,
  p_expected_version integer,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; entity_row public.entities; profile_row public.interaction_profiles;
declare version_row public.interaction_profile_versions; evidence jsonb; status text; v_validated_hash text;
declare result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'interactionProfiles.validate');
  if replay is not null then
    perform internal.w2g12_authorize_replay('interactionProfiles.validate', replay);
    return replay;
  end if;
  actor := internal.w2g12_authorize_profile_draft(p_profile_id, internal.actor_id());
  perform internal.assert_version(p_profile_id, p_expected_version);
  select * into entity_row from public.entities where id = p_profile_id;
  select * into profile_row from public.interaction_profiles where entity_id = p_profile_id for update;
  select * into version_row from public.interaction_profile_versions
   where profile_id = p_profile_id and version = profile_row.current_draft_version for update;
  if version_row.profile_id is null then raise exception 'Interaction Profile version not found' using errcode = 'P0002'; end if;
  if version_row.validation_status = 'unvalidated' then
    evidence := internal.w2g12_profile_validation_evidence(
      p_profile_id, version_row.version, version_row.draft_json,
      profile_row.generated_by_team_member_id, profile_row.active_version
    );
    v_validated_hash := evidence ->> 'validatedHash';
    status := case when v_validated_hash is null then 'invalid' else 'valid' end;
    update public.interaction_profile_versions
       set validation_status = status,
           validated_hash = v_validated_hash,
           validation_json = evidence
     where profile_id = p_profile_id and version = version_row.version;
    perform internal.w2g12_advance_profile_entity(p_profile_id, actor);
    perform internal.record_activity(entity_row.space_id, p_profile_id, actor, 'updated', null,
      jsonb_build_object('kind','interaction_profile','validationStatus',status,
                         'profileVersion',version_row.version));
  else
    status := version_row.validation_status;
    v_validated_hash := version_row.validated_hash;
    evidence := version_row.validation_json;
  end if;
  result := jsonb_build_object(
    'profileId', p_profile_id,
    'profileVersion', version_row.version,
    'status', status,
    'validatedHash', v_validated_hash,
    'issues', coalesce(evidence -> 'issues', '[]'::jsonb)
  );
  return internal.ledger_record(p_client_mutation_id, 'interactionProfiles.validate', result);
end
$$;

-- POST read by catalog classification: no cmid, no ledger, no event and no
-- write. The returned shape intentionally cannot carry prompt/tool/capture.
create or replace function public.preview_interaction_profile(
  p_profile_id uuid,
  p_profile_version integer
) returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare entity_row public.entities; profile_row public.interaction_profiles;
declare version_row public.interaction_profile_versions;
begin
  select * into entity_row from public.entities where id = p_profile_id;
  select * into profile_row from public.interaction_profiles where entity_id = p_profile_id;
  if entity_row.id is null or entity_row.deleted_at is not null or not internal.entity_readable(p_profile_id) then
    raise exception 'Interaction Profile not found' using errcode = 'P0002';
  end if;
  select * into version_row from public.interaction_profile_versions
   where profile_id = p_profile_id and version = p_profile_version;
  if version_row.profile_id is null then raise exception 'Interaction Profile version not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'profileId', p_profile_id,
    'profileVersion', version_row.version,
    'name', version_row.draft_json ->> 'name',
    'templateKey', version_row.draft_json ->> 'templateKey',
    'templateVersion', (version_row.draft_json ->> 'templateVersion')::integer,
    'feedPolicy', version_row.draft_json -> 'feedPolicy',
    'composerPolicy', version_row.draft_json -> 'composerPolicy',
    'validatedHash', version_row.validated_hash,
    'generatedByTeamMemberId', profile_row.generated_by_team_member_id
  );
end
$$;

create or replace function public.activate_interaction_profile(
  p_profile_id uuid,
  p_validated_version integer,
  p_validated_hash text,
  p_confirm boolean,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; member_id uuid; entity_row public.entities; profile_row public.interaction_profiles;
declare version_row public.interaction_profile_versions; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'interactionProfiles.activate');
  if replay is not null then
    perform internal.w2g12_authorize_replay('interactionProfiles.activate', replay);
    return replay;
  end if;
  select * into entity_row from public.entities where id = p_profile_id for update;
  select * into profile_row from public.interaction_profiles where entity_id = p_profile_id for update;
  if entity_row.id is null or entity_row.deleted_at is not null or profile_row.entity_id is null then
    raise exception 'Interaction Profile not found' using errcode = 'P0002';
  end if;
  member_id := internal.require_human_space_admin(entity_row.space_id);
  perform internal.bind_actor(member_id);
  if profile_row.status = 'retired' then
    raise exception 'Interaction Profile is retired' using errcode = '23514', detail = 'profile_retired';
  end if;
  if not coalesce(p_confirm, false) then raise exception 'activation confirmation required' using errcode = '22023'; end if;
  select * into version_row from public.interaction_profile_versions
   where profile_id = p_profile_id and version = p_validated_version for update;
  if version_row.profile_id is null or version_row.validation_status <> 'valid'
     or version_row.validated_hash is distinct from p_validated_hash then
    raise exception 'exact validated version/hash required for activation'
      using errcode = '23514', detail = 'profile_not_validated';
  end if;
  if profile_row.active_version is distinct from p_validated_version
     or profile_row.active_hash is distinct from p_validated_hash
     or profile_row.status <> 'active' then
    update public.interaction_profiles
       set status = 'active', active_version = p_validated_version, active_hash = p_validated_hash
     where entity_id = p_profile_id;
    perform internal.w2g12_advance_profile_entity(p_profile_id, member_id);
    perform internal.record_activity(entity_row.space_id, p_profile_id, member_id, 'updated', null,
      jsonb_build_object(
        'kind','interaction_profile','activeVersion',p_validated_version,
        'validatedHash',p_validated_hash,
        'generatedByTeamMemberId',profile_row.generated_by_team_member_id,
        'structuredDiff',version_row.validation_json -> 'structuredDiff'
      ));
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (entity_row.space_id, internal.next_event_seq(entity_row.space_id),
      'interaction_profile.activated', jsonb_build_object(
        'profileId',p_profile_id,'profileVersion',p_validated_version,
        'validatedHash',p_validated_hash,
        'generatedByTeamMemberId',profile_row.generated_by_team_member_id,
        'structuredDiff',version_row.validation_json -> 'structuredDiff'
      ), p_client_mutation_id);
  end if;
  result := internal.w2g12_profile_view(p_profile_id);
  return internal.ledger_record(p_client_mutation_id, 'interactionProfiles.activate', result);
end
$$;

create or replace function public.retire_interaction_profile(
  p_profile_id uuid,
  p_expected_version integer,
  p_confirm boolean,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; member_id uuid; entity_row public.entities; profile_row public.interaction_profiles; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'interactionProfiles.retire');
  if replay is not null then
    perform internal.w2g12_authorize_replay('interactionProfiles.retire', replay);
    return replay;
  end if;
  select * into entity_row from public.entities where id = p_profile_id;
  select * into profile_row from public.interaction_profiles where entity_id = p_profile_id for update;
  if entity_row.id is null or entity_row.deleted_at is not null or profile_row.entity_id is null then
    raise exception 'Interaction Profile not found' using errcode = 'P0002';
  end if;
  member_id := internal.require_human_space_admin(entity_row.space_id);
  perform internal.bind_actor(member_id);
  perform internal.assert_version(p_profile_id, p_expected_version);
  if not coalesce(p_confirm, false) then raise exception 'retirement confirmation required' using errcode = '22023'; end if;
  if profile_row.status = 'retired' then
    raise exception 'Interaction Profile is retired' using errcode = '23514', detail = 'profile_retired';
  end if;
  perform 1 from public.spaces where default_interaction_profile_id = p_profile_id order by id for update;
  perform 1 from public.edges where type = 'defaults_to_profile' and dst_id = p_profile_id order by id for update;
  if exists (select 1 from public.spaces where default_interaction_profile_id = p_profile_id)
     or exists (select 1 from public.edges where type = 'defaults_to_profile' and dst_id = p_profile_id) then
    raise exception 'Interaction Profile is still referenced by a default'
      using errcode = '23514', detail = 'profile_referenced_default';
  end if;
  update public.interaction_profiles set status = 'retired', retired_at = now()
   where entity_id = p_profile_id;
  perform internal.w2g12_advance_profile_entity(p_profile_id, member_id);
  perform internal.record_activity(entity_row.space_id, p_profile_id, member_id, 'deleted', null,
    jsonb_build_object('kind','interaction_profile','retired',true));
  insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
  values (entity_row.space_id, internal.next_event_seq(entity_row.space_id),
    'interaction_profile.retired', jsonb_build_object('profileId',p_profile_id), p_client_mutation_id);
  result := internal.w2g12_profile_view(p_profile_id);
  return internal.ledger_record(p_client_mutation_id, 'interactionProfiles.retire', result);
end
$$;

-- -----------------------------------------------------------------------------
-- A19/A20: sole guarded future-spawn default writers.
-- -----------------------------------------------------------------------------

create or replace function internal.w2g12_assert_active_profile(
  p_profile_id uuid, p_space_id uuid
) returns public.interaction_profiles language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare entity_row public.entities; profile_row public.interaction_profiles;
declare version_row public.interaction_profile_versions;
begin
  select * into entity_row from public.entities where id = p_profile_id for update;
  select * into profile_row from public.interaction_profiles where entity_id = p_profile_id;
  if entity_row.id is null or profile_row.entity_id is null
     or entity_row.kind <> 'interaction_profile' or entity_row.space_id <> p_space_id
     or entity_row.deleted_at is not null or entity_row.visibility <> 'space'
     or not internal.entity_readable(p_profile_id) then
    raise exception 'Interaction Profile not found' using errcode = 'P0002';
  end if;
  if profile_row.status = 'retired' or profile_row.retired_at is not null then
    raise exception 'Interaction Profile is retired'
      using errcode = '23514', detail = 'profile_retired';
  end if;
  if profile_row.status <> 'active' or profile_row.active_version is null or profile_row.active_hash is null then
    raise exception 'Interaction Profile is not validated and active'
      using errcode = '23514', detail = 'profile_not_validated';
  end if;
  select * into version_row from public.interaction_profile_versions
   where profile_id = p_profile_id and version = profile_row.active_version for update;
  if version_row.profile_id is null or version_row.validation_status <> 'valid'
     or version_row.validated_hash is distinct from profile_row.active_hash
     or internal.w2g12_static_chat_template(
       version_row.draft_json ->> 'templateKey',
       (version_row.draft_json ->> 'templateVersion')::integer
     ) is null then
    raise exception 'Interaction Profile validation/hash does not match its active version'
      using errcode = '23514', detail = 'profile_not_validated';
  end if;
  return profile_row;
end
$$;

create or replace function public.set_teammate_profile_default(
  p_team_member_id uuid,
  p_profile_id uuid,
  p_expected_version integer,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; teammate public.entities; profile_row public.interaction_profiles;
declare current_profile uuid; member_id uuid; result jsonb; current_version integer;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'teamMembers.interactionProfile.setDefault');
  if replay is not null then
    perform internal.w2g12_authorize_replay('teamMembers.interactionProfile.setDefault', replay);
    return replay;
  end if;
  select * into teammate from public.entities where id = p_team_member_id;
  if teammate.id is null or teammate.kind <> 'team_member' or teammate.deleted_at is not null then
    raise exception 'Teammate not found' using errcode = 'P0002';
  end if;
  member_id := internal.require_human_space_admin(teammate.space_id);
  perform internal.bind_actor(member_id);
  -- Non-null lock order is profile/version first, then the Teammate envelope.
  if p_profile_id is not null then
    profile_row := internal.w2g12_assert_active_profile(p_profile_id, teammate.space_id);
  end if;
  perform internal.assert_version(p_team_member_id, p_expected_version);
  select edge_row.dst_id into current_profile from public.edges edge_row
   where edge_row.src_id = p_team_member_id and edge_row.type = 'defaults_to_profile'
   order by edge_row.id limit 1 for update;
  select version into current_version from public.entities where id = p_team_member_id;
  if current_profile is distinct from p_profile_id then
    perform internal.w1_set_writer('profile_default');
    delete from public.edges where src_id = p_team_member_id and type = 'defaults_to_profile';
    if p_profile_id is not null then
      insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
      values (teammate.space_id, p_team_member_id, p_profile_id,
        'defaults_to_profile', '{}'::jsonb, member_id);
    end if;
    perform internal.w1_set_writer(null);
    update public.entities set version = version + 1, activity_at = now(), updated_at = now()
     where id = p_team_member_id returning version into current_version;
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (teammate.space_id, internal.next_event_seq(teammate.space_id),
      'interaction_profile.teammate_default_updated', jsonb_build_object(
        'teamMemberId',p_team_member_id,'profileId',p_profile_id,
        'version',current_version,'selectedBy',member_id
      ), p_client_mutation_id);
  end if;
  result := jsonb_build_object(
    'teamMemberId', p_team_member_id,
    'defaultInteractionProfileId', p_profile_id,
    'version', current_version
  );
  return internal.ledger_record(p_client_mutation_id,
    'teamMembers.interactionProfile.setDefault', result);
end
$$;

create or replace function public.set_space_profile_default(
  p_space_id uuid,
  p_profile_id uuid,
  p_expected_settings_revision integer,
  p_confirm_agent_generated boolean default false,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; profile_row public.interaction_profiles; space_row public.spaces;
declare member_id uuid; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.interactionProfile.setDefault');
  if replay is not null then
    perform internal.w2g12_authorize_replay('spaces.interactionProfile.setDefault', replay);
    return replay;
  end if;
  member_id := internal.require_human_space_admin(p_space_id);
  perform internal.bind_actor(member_id);
  -- Non-null A20 order is profile/version then Space settings row.
  if p_profile_id is not null then
    profile_row := internal.w2g12_assert_active_profile(p_profile_id, p_space_id);
    if profile_row.generated_by_team_member_id is not null
       and not coalesce(p_confirm_agent_generated, false) then
      raise exception 'Agent-generated Space default requires explicit human confirmation'
        using errcode = '42501', detail = 'profile_principal_required';
    end if;
  end if;
  select * into space_row from public.spaces where id = p_space_id for update;
  if space_row.id is null then raise exception 'Space not found' using errcode = 'P0002'; end if;
  if space_row.settings_revision <> p_expected_settings_revision then
    raise exception 'Space settings revision conflict' using errcode = '40001',
      detail = jsonb_build_object('currentRevision',space_row.settings_revision)::text;
  end if;
  if space_row.default_interaction_profile_id is distinct from p_profile_id then
    perform internal.w1_set_writer('space_settings');
    update public.spaces set default_interaction_profile_id = p_profile_id,
      settings_revision = settings_revision + 1 where id = p_space_id returning * into space_row;
    perform internal.w1_set_writer(null);
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (p_space_id, internal.next_event_seq(p_space_id),
      'interaction_profile.space_default_updated', jsonb_build_object(
        'spaceId',p_space_id,'profileId',p_profile_id,
        'settingsRevision',space_row.settings_revision,'selectedBy',member_id
      ), p_client_mutation_id);
  end if;
  result := jsonb_build_object(
    'spaceId', p_space_id,
    'defaultInteractionProfileId', p_profile_id,
    'settingsRevision', space_row.settings_revision
  );
  return internal.ledger_record(p_client_mutation_id,
    'spaces.interactionProfile.setDefault', result);
end
$$;

-- -----------------------------------------------------------------------------
-- Launch resolution and recorder-owned immutable pin/provenance seams.
-- These functions are intentionally not catalog handlers.
-- -----------------------------------------------------------------------------

create or replace function internal.w2g12_resolved_profile(
  p_profile_id uuid,
  p_source text
) returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare profile_row public.interaction_profiles; entity_row public.entities;
declare snapshot jsonb; resolved_hash text;
begin
  select * into entity_row from public.entities where id = p_profile_id;
  select * into profile_row from public.interaction_profiles where entity_id = p_profile_id;
  if entity_row.id is null or entity_row.deleted_at is not null
     or profile_row.status <> 'active' or profile_row.retired_at is not null
     or profile_row.active_version is null or profile_row.active_hash is null
     or not internal.entity_readable(p_profile_id) then
    return null;
  end if;
  snapshot := internal.w2g12_profile_snapshot(p_profile_id, profile_row.active_version, p_source);
  if snapshot is null or snapshot -> 'template' is null or jsonb_typeof(snapshot -> 'template') = 'null' then
    return null;
  end if;
  resolved_hash := internal.w2g12_hash_json(snapshot);
  return jsonb_build_object(
    'profileId', p_profile_id,
    'profileVersion', profile_row.active_version,
    'templateKey', snapshot #>> '{template,key}',
    'templateVersion', (snapshot #>> '{template,version}')::integer,
    'resolvedHash', resolved_hash,
    'source', p_source,
    'snapshot', snapshot
  );
end
$$;

create or replace function internal.w2_resolve_interaction_profile_for_launch(
  p_space_id uuid,
  p_team_member_id uuid,
  p_override_profile_id uuid
) returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare teammate public.entities; selected_id uuid; resolved jsonb; core_snapshot jsonb;
begin
  perform internal.require_space_member(p_space_id);
  if p_team_member_id is not null then
    select * into teammate from public.entities where id = p_team_member_id;
    if teammate.id is null or teammate.kind <> 'team_member' or teammate.space_id <> p_space_id
       or teammate.deleted_at is not null or not internal.can_act_as(p_team_member_id, p_space_id) then
      raise exception 'Teammate not found' using errcode = 'P0002';
    end if;
  end if;
  if p_override_profile_id is not null then
    perform internal.require_human_space_admin(p_space_id);
    if exists (
      select 1 from public.interaction_profiles profile_row
       where profile_row.entity_id = p_override_profile_id
         and (profile_row.status = 'retired' or profile_row.retired_at is not null)
    ) then
      raise exception 'Interaction Profile is retired'
        using errcode = '23514', detail = 'profile_retired';
    end if;
    resolved := internal.w2g12_resolved_profile(p_override_profile_id, 'spawn_override');
    if resolved is null then
      raise exception 'Interaction Profile is not active and launchable'
        using errcode = '23514', detail = 'profile_not_validated';
    end if;
    return resolved;
  end if;
  if p_team_member_id is not null then
    select edge_row.dst_id into selected_id from public.edges edge_row
     where edge_row.src_id = p_team_member_id and edge_row.type = 'defaults_to_profile'
     order by edge_row.id limit 1;
    if selected_id is not null then
      resolved := internal.w2g12_resolved_profile(selected_id, 'teammate_default');
      if resolved is not null then return resolved; end if;
    end if;
  end if;
  select default_interaction_profile_id into selected_id from public.spaces where id = p_space_id;
  if selected_id is not null then
    resolved := internal.w2g12_resolved_profile(selected_id, 'space_default');
    if resolved is not null then return resolved; end if;
  end if;
  core_snapshot := internal.w1_core_pin_snapshot()
    || jsonb_build_object('profile', jsonb_build_object('source','core_default'));
  return jsonb_build_object(
    'profileId', null,
    'profileVersion', null,
    'templateKey', 'tm8.chat.core',
    'templateVersion', 1,
    'resolvedHash', internal.w2g12_hash_json(core_snapshot),
    'source', 'core_default',
    'snapshot', core_snapshot
  );
end
$$;

create or replace function internal.w2_record_interaction_profile_pin(
  p_work_session_id uuid,
  p_profile_id uuid,
  p_profile_version integer,
  p_source text,
  p_resolved_hash text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare session_entity public.entities; profile_row public.interaction_profiles;
declare expected_selection jsonb; snapshot jsonb; next_revision integer; created timestamptz;
declare actor uuid;
begin
  if p_source not in ('spawn_override','teammate_default','space_default','core_default')
     or (p_source = 'core_default') <> (p_profile_id is null)
     or (p_profile_id is null) <> (p_profile_version is null) then
    raise exception 'invalid Interaction Profile pin source/identity' using errcode = '22023';
  end if;
  select * into session_entity from public.entities where id = p_work_session_id for update;
  if session_entity.id is null or session_entity.kind <> 'work_session'
     or session_entity.deleted_at is not null then
    raise exception 'work session not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(session_entity.space_id);
  actor := coalesce(internal.actor_id(), internal.current_member_id(session_entity.space_id));
  if p_source = 'core_default' then
    snapshot := internal.w1_core_pin_snapshot()
      || jsonb_build_object('profile', jsonb_build_object('source','core_default'));
    expected_selection := jsonb_build_object(
      'profileId',null,'profileVersion',null,'templateKey','tm8.chat.core','templateVersion',1,
      'resolvedHash',internal.w2g12_hash_json(snapshot),'source','core_default','snapshot',snapshot
    );
  else
    profile_row := internal.w2g12_assert_active_profile(p_profile_id, session_entity.space_id);
    if profile_row.active_version <> p_profile_version then
      raise exception 'profile pin version no longer matches the active version'
        using errcode = '23514', detail = 'profile_not_validated';
    end if;
    if p_source = 'spawn_override' then
      perform internal.require_human_space_admin(session_entity.space_id);
    elsif p_source = 'space_default' and not exists (
      select 1 from public.spaces where id = session_entity.space_id
       and default_interaction_profile_id = p_profile_id
    ) then
      raise exception 'Space profile default changed before pin recording' using errcode = '40001';
    elsif p_source = 'teammate_default' and not exists (
      select 1
        from public.edges session_teammate
        join public.entities teammate on teammate.id = session_teammate.dst_id
        join public.edges default_edge on default_edge.src_id = teammate.id
       where session_teammate.src_id = p_work_session_id
         and session_teammate.type = 'relates_to'
         and teammate.space_id = session_entity.space_id
         and teammate.kind = 'team_member'
         and default_edge.type = 'defaults_to_profile'
         and default_edge.dst_id = p_profile_id
    ) then
      raise exception 'Teammate profile default changed before pin recording' using errcode = '40001';
    end if;
    expected_selection := internal.w2g12_resolved_profile(p_profile_id, p_source);
    if expected_selection is null then
      raise exception 'Interaction Profile is not launchable'
        using errcode = '23514', detail = 'profile_not_validated';
    end if;
    snapshot := expected_selection -> 'snapshot';
  end if;
  if expected_selection ->> 'resolvedHash' is distinct from p_resolved_hash then
    raise exception 'profile resolution hash changed before pin recording'
      using errcode = '40001', detail = 'profile_pin_hash_conflict';
  end if;
  select coalesce(max(pin_revision),0) + 1 into next_revision
    from public.work_session_interaction_pins where work_session_id = p_work_session_id;
  perform internal.w1_set_writer('profile_pin');
  insert into public.work_session_interaction_pins(
    work_session_id,pin_revision,profile_id,profile_version,template_key,template_version,
    resolved_hash,resolved_snapshot
  ) values (
    p_work_session_id,next_revision,p_profile_id,p_profile_version,
    expected_selection ->> 'templateKey',(expected_selection ->> 'templateVersion')::integer,
    p_resolved_hash,snapshot
  ) returning created_at into created;
  delete from public.edges where src_id = p_work_session_id and type = 'selected_profile';
  if p_profile_id is not null then
    insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
    values (session_entity.space_id,p_work_session_id,p_profile_id,'selected_profile',
      jsonb_build_object('pinRevision',next_revision,'resolvedHash',p_resolved_hash,'source',p_source),actor);
  end if;
  perform internal.w1_set_writer(null);
  return jsonb_build_object(
    'workSessionId',p_work_session_id,
    'pinRevision',next_revision,
    'profileId',p_profile_id,
    'profileVersion',p_profile_version,
    'templateKey',expected_selection ->> 'templateKey',
    'templateVersion',(expected_selection ->> 'templateVersion')::integer,
    'resolvedHash',p_resolved_hash,
    'source',p_source,
    'createdAt',internal.w2g12_iso(created)
  );
end
$$;

-- -----------------------------------------------------------------------------
-- Closed application surface. tm8_app keeps SELECT+RLS only; all mutations use
-- the enumerated definer functions. No delivery-role RPC is added.
-- -----------------------------------------------------------------------------

revoke execute on function public.w2_create_entity_kind(uuid,text,text,jsonb,jsonb,uuid,text) from public;
revoke execute on function public.w2_update_entity_kind(uuid,text,jsonb,uuid,text) from public;
revoke execute on function public.propose_interaction_profile(uuid,jsonb,uuid,text) from public;
revoke execute on function public.update_interaction_profile_draft(uuid,integer,jsonb,uuid,text) from public;
revoke execute on function public.validate_interaction_profile(uuid,integer,text) from public;
revoke execute on function public.preview_interaction_profile(uuid,integer) from public;
revoke execute on function public.activate_interaction_profile(uuid,integer,text,boolean,text) from public;
revoke execute on function public.retire_interaction_profile(uuid,integer,boolean,text) from public;
revoke execute on function public.set_teammate_profile_default(uuid,uuid,integer,text) from public;
revoke execute on function public.set_space_profile_default(uuid,uuid,integer,boolean,text) from public;
revoke all on all functions in schema internal from public;

grant execute on function
  public.w2_create_entity_kind(uuid,text,text,jsonb,jsonb,uuid,text),
  public.w2_update_entity_kind(uuid,text,jsonb,uuid,text),
  public.propose_interaction_profile(uuid,jsonb,uuid,text),
  public.update_interaction_profile_draft(uuid,integer,jsonb,uuid,text),
  public.validate_interaction_profile(uuid,integer,text),
  public.preview_interaction_profile(uuid,integer),
  public.activate_interaction_profile(uuid,integer,text,boolean,text),
  public.retire_interaction_profile(uuid,integer,boolean,text),
  public.set_teammate_profile_default(uuid,uuid,integer,text),
  public.set_space_profile_default(uuid,uuid,integer,boolean,text)
to tm8_app;

grant execute on function
  internal.w2_resolve_interaction_profile_for_launch(uuid,uuid,uuid),
  internal.w2_record_interaction_profile_pin(uuid,uuid,integer,text,text)
to tm8_app;

reset role;
