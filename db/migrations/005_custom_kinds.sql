-- =============================================================================
-- 005 custom kinds — `custom_entities`, scalar-only field validation (R8), and
--                    the additive-or-relaxing schema evolution rule (R9).
--
-- The registry itself (`entity_kinds`) lives in 001 because the entity
-- envelope's kind-validation trigger depends on it. This file adds the part that
-- makes a custom kind usable: typed-but-dumb field storage.
--
-- The guardrails are the point. Custom kinds get the whole envelope for free —
-- hierarchy, edges, messages, reactions, counters, versions, collection views —
-- and in exchange they get NO custom commands, NO custom triggers, and NO
-- relation fields. If a relation matters, it is an edge, full stop (R8): an
-- `entity_ref` field type would rebuild the denormalised-id mess the edge table
-- exists to kill.
-- =============================================================================
set role tm8_graph_owner;

create table public.custom_entities (
  entity_id uuid primary key references public.entities(id) on delete cascade,
  fields    jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Filters and group-by run over jsonb, so it is indexed like the task axes are.
create index custom_entities_fields_gin_idx on public.custom_entities using gin (fields jsonb_path_ops);

-- The envelope for a custom-entity row must be a `c:*` kind registered in its own
-- space. (The generic detail-kind validator can't express "any custom kind".)
create or replace function internal.validate_custom_entity_kind() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare e public.entities;
begin
  select * into e from public.entities where id = new.entity_id;
  if e.id is null then
    raise exception 'custom entity row has no entity' using errcode = '23503';
  end if;
  if e.kind !~ '^c:' then
    raise exception 'custom_entities requires a c:* kind (got %)', e.kind using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger custom_entities_validate_kind before insert or update of entity_id on public.custom_entities
for each row execute function internal.validate_custom_entity_kind();
create trigger custom_entities_touch_updated_at before update on public.custom_entities
for each row execute function internal.touch_updated_at();
create trigger custom_entities_snapshot_version after update on public.custom_entities
for each row execute function internal.snapshot_entity_version();

-- -----------------------------------------------------------------------------
-- Scalars ONLY (R8). One value per declared field; nothing structural.
-- -----------------------------------------------------------------------------
create or replace function internal.validate_custom_fields() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  schema_def jsonb;
  field jsonb;
  field_name text;
  field_type text;
  value jsonb;
  value_type text;
  declared_names text[] := '{}';
  unknown text[];
begin
  select * into e from public.entities where id = new.entity_id;
  select k.field_schema into schema_def
    from public.entity_kinds k
   where k.kind = e.kind and k.space_id = e.space_id;
  if schema_def is null then
    raise exception 'kind % is not registered in this space', e.kind using errcode = '23514';
  end if;

  for field in select jsonb_array_elements(schema_def) loop
    field_name := field ->> 'name';
    field_type := field ->> 'type';
    declared_names := declared_names || field_name;
    value := new.fields -> field_name;
    value_type := jsonb_typeof(value);

    if value is null or value_type = 'null' then
      -- Missing is fine unless the field is required. Reads tolerate absence and
      -- render empty, which is what makes R9's grandfathering work.
      if coalesce((field ->> 'required')::boolean, false) then
        raise exception 'field % is required for kind %', field_name, e.kind using errcode = '22023';
      end if;
      continue;
    end if;

    if value_type in ('object','array') then
      raise exception 'field % must be a scalar (custom kinds hold no structure — use an edge)', field_name
        using errcode = '22023';
    end if;

    case field_type
      when 'text' then
        if value_type <> 'string' then
          raise exception 'field % must be text', field_name using errcode = '22023';
        end if;
      when 'number' then
        if value_type <> 'number' then
          raise exception 'field % must be a number', field_name using errcode = '22023';
        end if;
      when 'bool' then
        if value_type <> 'boolean' then
          raise exception 'field % must be a boolean', field_name using errcode = '22023';
        end if;
      when 'date' then
        if value_type <> 'string' then
          raise exception 'field % must be an ISO date string', field_name using errcode = '22023';
        end if;
        begin
          perform (value #>> '{}')::timestamptz;
        exception when others then
          raise exception 'field % is not a parseable date: %', field_name, value #>> '{}'
            using errcode = '22023';
        end;
      when 'enum' then
        if value_type <> 'string' then
          raise exception 'field % must be one of its enum values', field_name using errcode = '22023';
        end if;
        if not (value #>> '{}' = any (
          select jsonb_array_elements_text(coalesce(field -> 'values', '[]'::jsonb))
        )) then
          raise exception 'field % has value % outside its enum', field_name, value #>> '{}'
            using errcode = '22023';
        end if;
      else
        raise exception 'unsupported field type % on kind % (scalars only: text|number|bool|date|enum)',
          field_type, e.kind using errcode = '22023';
    end case;
  end loop;

  -- Undeclared keys are refused: silently storing them would make the schema a
  -- suggestion, and the next reader would find fields no renderer knows about.
  select array_agg(key) into unknown
    from jsonb_object_keys(new.fields) as key
   where key <> all (declared_names);
  if unknown is not null then
    raise exception 'undeclared field(s) % for kind %', unknown, e.kind using errcode = '22023';
  end if;

  return new;
end
$$;
create trigger custom_entities_validate_fields before insert or update of fields, entity_id
on public.custom_entities
for each row execute function internal.validate_custom_fields();

-- -----------------------------------------------------------------------------
-- Schema evolution (R9): additive or relaxing by default.
--
-- Allowed freely: adding an optional field, widening an enum, making a required
-- field optional. Refused unless the admin explicitly opts into a backfill:
-- adding a required field, narrowing an enum, changing a field's type, or
-- removing a field (existing rows would instantly hold undeclared keys).
--
-- Validation is on WRITE ONLY — old rows are grandfathered until touched.
-- -----------------------------------------------------------------------------
create or replace function internal.assert_schema_evolution(
  old_schema jsonb, new_schema jsonb, allow_tightening boolean default false
) returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare
  old_field jsonb;
  new_field jsonb;
  field_name text;
  old_values text[];
  new_values text[];
  tightenings text[] := '{}';
begin
  -- New fields must be optional (a required new field invalidates every row).
  for new_field in select jsonb_array_elements(new_schema) loop
    field_name := new_field ->> 'name';
    if not exists (
      select 1 from jsonb_array_elements(old_schema) f where f ->> 'name' = field_name
    ) and coalesce((new_field ->> 'required')::boolean, false) then
      tightenings := tightenings || format('new field %s is required', field_name);
    end if;
  end loop;

  for old_field in select jsonb_array_elements(old_schema) loop
    field_name := old_field ->> 'name';
    select f into new_field from jsonb_array_elements(new_schema) f where f ->> 'name' = field_name;

    if new_field is null then
      tightenings := tightenings || format('field %s was removed', field_name);
      continue;
    end if;
    if (new_field ->> 'type') is distinct from (old_field ->> 'type') then
      tightenings := tightenings || format('field %s changed type %s -> %s',
        field_name, old_field ->> 'type', new_field ->> 'type');
    end if;
    if coalesce((new_field ->> 'required')::boolean, false)
       and not coalesce((old_field ->> 'required')::boolean, false) then
      tightenings := tightenings || format('field %s became required', field_name);
    end if;
    if (old_field ->> 'type') = 'enum' then
      select coalesce(array_agg(v), '{}') into old_values
        from jsonb_array_elements_text(coalesce(old_field -> 'values', '[]'::jsonb)) v;
      select coalesce(array_agg(v), '{}') into new_values
        from jsonb_array_elements_text(coalesce(new_field -> 'values', '[]'::jsonb)) v;
      if exists (select 1 from unnest(old_values) v where v <> all (new_values)) then
        tightenings := tightenings || format('field %s enum narrowed', field_name);
      end if;
    end if;
  end loop;

  if array_length(tightenings, 1) > 0 and not allow_tightening then
    raise exception 'schema change tightens the kind: %', array_to_string(tightenings, '; ')
      using errcode = '23514',
            detail = 'run it as an explicit admin backfill (allowTightening) — R9';
  end if;
end
$$;

-- Core registry rows are not editable data: promoting a custom kind to a core one
-- is a migration (a typed detail table and real commands), never an UPDATE.
create or replace function internal.guard_core_entity_kind() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.origin = 'core' then
      raise exception 'core kinds cannot be deleted' using errcode = '42501';
    end if;
    -- Refuse to strand entities: a kind in use is not removable.
    if exists (select 1 from public.entities e where e.kind = old.kind and e.space_id = old.space_id) then
      raise exception 'kind % still has entities in this space', old.kind using errcode = '23514';
    end if;
    return old;
  end if;
  if old.origin = 'core' and (new.kind <> old.kind or new.origin <> old.origin
                              or new.field_schema <> old.field_schema) then
    raise exception 'core kind rows are immutable (promotion is a migration)' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger entity_kinds_guard_core before update or delete on public.entity_kinds
for each row execute function internal.guard_core_entity_kind();

-- -----------------------------------------------------------------------------
-- Content resolution learns about custom kinds — the one sanctioned extension
-- point of internal.entity_content (declared in 001). Snapshots, command results
-- and reads all inherit the new branch for free.
-- -----------------------------------------------------------------------------
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
  if e.kind like 'c:%' then
    select jsonb_build_object('fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
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
        select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then
        select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then
        select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'file' then
        select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      else
        content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

revoke all on all functions in schema internal from public;
revoke all on all functions in schema public from public;

reset role;
