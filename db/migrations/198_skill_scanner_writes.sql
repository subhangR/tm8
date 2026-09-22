-- Server scanner writes metadata references through the ordinary entity/event
-- triggers. Missing files retain their entities and every relationship.
set role tm8_graph_owner;

-- A filesystem path identifies a reference within a Space, never across Spaces.
alter table public.skills add column space_id uuid references public.spaces(id) on delete cascade;
update public.skills s set space_id = e.space_id from public.entities e where e.id = s.entity_id;
alter table public.skills alter column space_id set not null;
drop index public.skills_source_path_unique;
create unique index skills_space_source_path_unique on public.skills(space_id, source_path)
  where source_path is not null;

-- Legacy graph-only create RPCs omit space_id. Fill only omissions; an explicit
-- mismatch must reach the shared envelope validator and be rejected.
create or replace function internal.populate_skill_space() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.space_id is null then
    select space_id into new.space_id from public.entities where id = new.entity_id;
  end if;
  return new;
end $$;
create trigger skills_populate_space before insert on public.skills
for each row execute function internal.populate_skill_space();
drop trigger skills_validate_kind on public.skills;
create trigger skills_validate_kind before insert or update of entity_id, space_id on public.skills
for each row execute function internal.validate_detail_envelope('skill');

create or replace function public.upsert_skill_reference(p_space_id uuid, p_metadata jsonb)
returns uuid language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare actor uuid; target uuid; existing public.entities; path text := p_metadata->>'source_path';
begin
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(null, p_space_id);
  perform internal.bind_actor(actor);
  if path is null or path not like '/%' or p_metadata->>'provider' = 'tm8' then
    raise exception 'scanner requires an absolute file-backed source path' using errcode = '22023';
  end if;
  -- Serialize absent-path inserts as well as existing-path refreshes.
  perform pg_advisory_xact_lock(hashtextextended('skill-reference:' || p_space_id::text || ':' || path, 0));
  select s.entity_id into target from public.skills s where s.space_id = p_space_id and s.source_path = path;
  if target is not null then
    existing := internal.live_entity(target, 'skill');
    if existing.space_id <> p_space_id then
      raise exception 'skill path belongs to another space' using errcode = '42501';
    end if;
    perform internal.assert_version(target, existing.version);
    if exists(select 1 from public.skills where entity_id = target and last_seen_at > (p_metadata->>'last_seen_at')::timestamptz) then return target; end if;
    update public.skills set
      name = p_metadata->>'name', description = coalesce(p_metadata->>'description', ''), content = '',
      provider = p_metadata->>'provider', level = p_metadata->>'level',
      root_kind = p_metadata->>'root_kind', root_ref = p_metadata->>'root_ref',
      dir_name = p_metadata->>'dir_name', frontmatter = coalesce(p_metadata->'frontmatter', '{}'),
      loader_metadata = coalesce(p_metadata->'loader_metadata', '{}'),
      content_hash = p_metadata->>'content_hash', file_mtime = (p_metadata->>'file_mtime')::timestamptz,
      body_bytes = (p_metadata->>'body_bytes')::integer, bundle = p_metadata->'bundle',
      missing = false, last_seen_at = (p_metadata->>'last_seen_at')::timestamptz
      where entity_id = target and space_id = p_space_id;
    perform internal.record_activity(p_space_id, target, actor, 'updated', null, jsonb_build_object('kind','skill','scan',true));
  else
    target := internal.create_envelope(p_space_id, 'skill', actor, null, null);
    insert into public.skills(entity_id, space_id, name, description, content, provider, level, root_kind, root_ref,
      source_path, dir_name, frontmatter, loader_metadata, content_hash, file_mtime, body_bytes, bundle, missing, last_seen_at)
    values(target, p_space_id, p_metadata->>'name', coalesce(p_metadata->>'description',''), '',
      p_metadata->>'provider', p_metadata->>'level', p_metadata->>'root_kind', p_metadata->>'root_ref',
      path, p_metadata->>'dir_name', coalesce(p_metadata->'frontmatter','{}'), coalesce(p_metadata->'loader_metadata','{}'),
      p_metadata->>'content_hash', (p_metadata->>'file_mtime')::timestamptz,
      (p_metadata->>'body_bytes')::integer, p_metadata->'bundle', false, (p_metadata->>'last_seen_at')::timestamptz);
    perform internal.record_initial_version(target, actor);
    perform internal.record_activity(p_space_id, target, actor, 'created', null, jsonb_build_object('kind','skill','scan',true));
  end if;
  return target;
end $$;

create or replace function public.mark_skill_references_missing(p_space_id uuid, p_ids uuid[], p_scanned_at timestamptz)
returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare actor uuid; target uuid; existing public.entities; n integer := 0;
begin
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(null, p_space_id);
  perform internal.bind_actor(actor);
  foreach target in array p_ids loop
    existing := internal.live_entity(target, 'skill');
    if existing.space_id <> p_space_id then
      raise exception 'skill belongs to another space' using errcode = '42501';
    end if;
    perform internal.assert_version(target, existing.version);
    -- Do not overwrite a reappearance observed by a newer concurrent scan.
    update public.skills set missing = true where entity_id = target and space_id = p_space_id and source_path is not null
      and missing = false and (last_seen_at is null or last_seen_at <= p_scanned_at);
    if found then
      n := n + 1;
      perform internal.record_activity(p_space_id, target, actor, 'updated', null, jsonb_build_object('kind','skill','missing',true));
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.upsert_skill_reference(uuid,jsonb) from public;
revoke all on function public.mark_skill_references_missing(uuid,uuid[],timestamptz) from public;
grant execute on function public.upsert_skill_reference(uuid,jsonb) to tm8_app;
grant execute on function public.mark_skill_references_missing(uuid,uuid[],timestamptz) to tm8_app;
reset role;
