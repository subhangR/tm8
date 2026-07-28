-- =============================================================================
-- 018 — W2.G03 public edge and placement boundary.
--
-- The relation and registry tables already exist.  This migration turns their
-- published property schemas into write invariants, preserves the shipped RPC
-- signatures, and resolves the frozen placement grammar inside one database
-- transaction.  No application role receives table-write privileges.
--
-- Full-order note: embed placements issue the honest named `messages.delete`
-- inverse.  Migration 020 predates that inverse in its closed allowlist; the
-- post-019 integration migration extends redemption after G04 supplies the
-- named message tombstone RPC.  G03 never disguises this as another inverse.
-- =============================================================================
set role tm8_graph_owner;

-- Every registered type publishes an object schema.  Known semantic fields
-- are typed; forward-compatible fields remain admitted because several older
-- typed RPCs already persist additional operational metadata.
update public.edge_types
   set props_schema = jsonb_build_object(
     'type', 'object',
     'properties',
       case type
         when 'depends_on' then jsonb_build_object(
           'hard', jsonb_build_object('type', 'boolean'))
         when 'contains' then jsonb_build_object(
           'position', jsonb_build_object('type', 'number'))
         when 'working_on' then jsonb_build_object(
           'status', jsonb_build_object('type', 'string'),
           'startedAt', jsonb_build_object('type', 'string'),
           'note', jsonb_build_object('type', jsonb_build_array('string','null')))
         when 'pulled' then jsonb_build_object(
           'localId', jsonb_build_object('type', 'string'),
           'pinnedVersion', jsonb_build_object('type', 'number'),
           'pulledAt', jsonb_build_object('type', 'string'))
         when 'tracks' then jsonb_build_object(
           'localId', jsonb_build_object('type', 'string'),
           'pinnedVersion', jsonb_build_object('type', 'number'))
         when 'approval_requested_from' then jsonb_build_object(
           'verdict', jsonb_build_object('type', 'string'),
           'note', jsonb_build_object('type', jsonb_build_array('string','null')))
         when 'approved_by' then jsonb_build_object(
           'verdict', jsonb_build_object('type', 'string'),
           'note', jsonb_build_object('type', jsonb_build_array('string','null')))
         when 'in_project' then jsonb_build_object(
           'origin', jsonb_build_object('type', 'string'))
         when 'participates_in' then jsonb_build_object(
           'origin', jsonb_build_object('type', 'string'))
         when 'shared_into' then jsonb_build_object(
           'origin', jsonb_build_object('type', 'string'))
         when 'authored_from' then jsonb_build_object(
           'origin', jsonb_build_object('type', 'string'))
         when 'defaults_to_profile' then jsonb_build_object(
           'origin', jsonb_build_object('type', 'string'))
         when 'selected_profile' then jsonb_build_object(
           'origin', jsonb_build_object('type', 'string'))
         else '{}'::jsonb
       end,
     'additionalProperties', true
   );

create or replace function internal.edge_json_type_matches(
  value jsonb,
  expected jsonb
) returns boolean
language plpgsql
immutable
set search_path = public, internal, pg_temp
as $$
declare expected_name text;
begin
  if jsonb_typeof(expected) = 'array' then
    return exists (
      select 1
        from jsonb_array_elements_text(expected) item(name)
       where internal.edge_json_type_matches(value, to_jsonb(item.name))
    );
  end if;
  expected_name := expected #>> '{}';
  return case expected_name
    when 'null' then value = 'null'::jsonb
    when 'object' then jsonb_typeof(value) = 'object'
    when 'array' then jsonb_typeof(value) = 'array'
    when 'string' then jsonb_typeof(value) = 'string'
    when 'boolean' then jsonb_typeof(value) = 'boolean'
    when 'number' then jsonb_typeof(value) = 'number'
    when 'integer' then jsonb_typeof(value) = 'number'
      and (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
    else false
  end;
end
$$;

create or replace function internal.validate_edge_props_schema() returns trigger
language plpgsql
set search_path = public, internal, pg_temp
as $$
declare
  schema jsonb;
  property record;
  required_name text;
begin
  select props_schema into schema from public.edge_types where type = new.type;
  if schema is null then return new; end if;
  if not internal.edge_json_type_matches(new.props, coalesce(schema -> 'type', '"object"'::jsonb)) then
    raise exception 'edge % properties do not match the registered object schema', new.type
      using errcode = '22023';
  end if;

  for property in select key, value from jsonb_each(coalesce(schema -> 'properties', '{}'::jsonb))
  loop
    if new.props ? property.key
       and not internal.edge_json_type_matches(new.props -> property.key, property.value -> 'type') then
      raise exception 'edge % property % has the wrong type', new.type, property.key
        using errcode = '22023';
    end if;
  end loop;

  for required_name in select jsonb_array_elements_text(coalesce(schema -> 'required', '[]'::jsonb))
  loop
    if not new.props ? required_name then
      raise exception 'edge % requires property %', new.type, required_name
        using errcode = '22023';
    end if;
  end loop;

  if schema ->> 'additionalProperties' = 'false'
     and exists (
       select 1 from jsonb_object_keys(new.props) key
        where not coalesce(schema -> 'properties', '{}'::jsonb) ? key
     ) then
    raise exception 'edge % properties contain an unregistered field', new.type
      using errcode = '22023';
  end if;
  return new;
end
$$;

-- Alphabetical trigger order puts this before `edges_w1_guard`.  Inserts are
-- checked as submitted; the W1 guard may then append its Server-owned origin.
create trigger edges_props_schema
before insert or update of type, props on public.edges
for each row execute function internal.validate_edge_props_schema();

create or replace function public.write_edge(
  p_src_id uuid, p_dst_id uuid, p_type text, p_props jsonb default '{}'::jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  replay jsonb;
  src public.entities;
  dst public.entities;
  actor uuid;
  edge_id uuid;
  activity_id uuid;
  project_resource uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.create');
  if replay is not null then return replay; end if;
  if coalesce(p_props, '{}'::jsonb) ? 'origin' then
    raise exception 'edge props.origin is Server-owned' using errcode = '42501';
  end if;
  -- `in_project` has a stricter lock order than generic graph writes.  Resolve
  -- the projection mapping even when the envelope was concurrently hidden,
  -- lock ProjectResource first, and keep every unlink race on the frozen
  -- project_not_linked path instead of degrading to a generic not_found.
  if p_type = 'in_project' then
    select project_id into project_resource
      from public.project_projection_details where entity_id = p_dst_id;
    if project_resource is null then
      raise exception 'Project projection has no resource mapping'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
    perform 1 from public.projects where id = project_resource for update;
    select * into dst from public.entities where id = p_dst_id and deleted_at is null;
    if dst.id is null then
      raise exception 'Project is not actively linked to this Space'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
  else
    dst := internal.live_entity(p_dst_id);
  end if;
  src := internal.live_entity(p_src_id);
  if src.space_id <> dst.space_id then
    raise exception 'edge endpoints must be in the same space' using errcode = '23514';
  end if;
  perform internal.require_space_member(src.space_id);
  actor := internal.resolve_actor(p_actor_id, src.space_id);
  perform internal.bind_actor(actor);

  insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
  values (src.space_id, p_src_id, p_dst_id, p_type, coalesce(p_props, '{}'::jsonb), actor)
  on conflict (src_id, dst_id, type) do update
    set props = excluded.props
      || case when public.edges.props ? 'origin'
           then jsonb_build_object('origin', public.edges.props -> 'origin')
           else '{}'::jsonb end,
        updated_at = now()
  returning id into edge_id;

  activity_id := internal.record_activity(
    src.space_id, p_src_id, actor, 'linked', edge_id,
    jsonb_build_object('type', p_type, 'dstId', p_dst_id));
  return internal.ledger_record(
    p_client_mutation_id,
    'edges.create',
    internal.command_result(
      null, edge_id, activity_id, array[p_src_id, p_dst_id],
      internal.issue_undo_token(
        src.space_id, actor, 'Undo link', 'edges.delete',
        jsonb_build_object('edgeId', edge_id))));
end
$$;

create or replace function public.update_edge(
  p_edge_id uuid, p_props jsonb, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  replay jsonb;
  edge public.edges;
  actor uuid;
  next_props jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.patch');
  if replay is not null then return replay; end if;
  if coalesce(p_props, '{}'::jsonb) ? 'origin' then
    raise exception 'edge props.origin is Server-owned' using errcode = '42501';
  end if;
  select g.* into edge
    from public.edges g
    join public.entities src on src.id = g.src_id and src.deleted_at is null
    join public.entities dst on dst.id = g.dst_id and dst.deleted_at is null
   where g.id = p_edge_id
   for update of g;
  if edge.id is null then
    raise exception 'edge not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(edge.space_id);
  actor := internal.resolve_actor(p_actor_id, edge.space_id);
  perform internal.bind_actor(actor);
  next_props := coalesce(p_props, '{}'::jsonb)
    || case when edge.props ? 'origin'
         then jsonb_build_object('origin', edge.props -> 'origin')
         else '{}'::jsonb end;
  update public.edges set props = next_props, updated_at = now() where id = p_edge_id;
  return internal.ledger_record(
    p_client_mutation_id,
    'edges.patch',
    internal.command_result(null, p_edge_id, null, array[edge.src_id, edge.dst_id]));
end
$$;

-- Signature intentionally unchanged: migration 020 calls this exact overload.
create or replace function public.delete_edge(
  p_edge_id uuid, p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  replay jsonb;
  edge public.edges;
  actor uuid;
  activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.delete');
  if replay is not null then return replay; end if;
  select g.* into edge
    from public.edges g
    join public.entities src on src.id = g.src_id and src.deleted_at is null
    join public.entities dst on dst.id = g.dst_id and dst.deleted_at is null
   where g.id = p_edge_id
   for update of g;
  if edge.id is null then
    raise exception 'edge not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(edge.space_id);
  actor := internal.resolve_actor(p_actor_id, edge.space_id);
  perform internal.bind_actor(actor);
  delete from public.edges where id = p_edge_id;
  activity_id := internal.record_activity(
    edge.space_id, edge.src_id, actor, 'unlinked', p_edge_id,
    jsonb_build_object('type', edge.type, 'dstId', edge.dst_id));
  return internal.ledger_record(
    p_client_mutation_id,
    'edges.delete',
    internal.command_result(null, null, activity_id, array[edge.src_id, edge.dst_id]));
end
$$;

create or replace function public.place_entity(
  p_source_id uuid, p_target_id uuid, p_intent text, p_embed_message text default null,
  p_position double precision default null, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  replay jsonb;
  source public.entities;
  target public.entities;
  actor uuid;
  task_id uuid;
  assignee_id uuid;
  next_position double precision;
  result jsonb;
  message_result jsonb;
  message_id uuid;
  body text;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'placements.apply');
  if replay is not null then return replay; end if;
  source := internal.live_entity(p_source_id);
  target := internal.live_entity(p_target_id);
  if source.space_id <> target.space_id then
    raise exception 'placement endpoints must be in the same space' using errcode = '23514';
  end if;
  perform internal.require_space_member(source.space_id);
  actor := internal.resolve_actor(p_actor_id, source.space_id);
  perform internal.bind_actor(actor);

  case p_intent
    when 'attach' then
      result := public.write_edge(
        p_source_id, p_target_id, 'attached_to', '{}'::jsonb, actor, null);
      if p_embed_message is not null then
        body := concat_ws(
          ' ', nullif(btrim(p_embed_message), ''),
          '{{embed:' || p_source_id::text || '}}');
        message_result := public.post_message(
          p_target_id, body, actor, null, '[]'::jsonb, '[]'::jsonb, null);
      end if;

    when 'assign' then
      if source.kind = 'task' and target.kind in ('member','team_member') then
        task_id := source.id;
        assignee_id := target.id;
      elsif target.kind = 'task' and source.kind in ('member','team_member') then
        task_id := target.id;
        assignee_id := source.id;
      else
        raise exception 'assign needs a task and a member/team_member' using errcode = '22023';
      end if;
      result := public.write_edge(
        task_id, assignee_id, 'assigned_to', '{}'::jsonb, actor, null);

    when 'depend' then
      result := public.write_edge(
        p_target_id, p_source_id, 'depends_on', '{"hard":true}'::jsonb, actor, null);

    when 'subtask', 'reparent' then
      if source.kind <> target.kind then
        raise exception 'hierarchy placements require same-kind endpoints' using errcode = '22023';
      end if;
      if p_position is null then
        select coalesce(max(e.position), -1) + 1 into next_position
          from public.entities e
         where e.parent_id = p_target_id and e.deleted_at is null;
      else
        next_position := p_position;
      end if;
      result := public.move_entity(
        p_source_id, p_target_id, next_position, source.version, actor, null);

    when 'embed' then
      body := concat_ws(
        ' ', nullif(btrim(coalesce(p_embed_message, '')), ''),
        '{{embed:' || p_source_id::text || '}}');
      message_result := public.post_message(
        p_target_id, body, actor, null, '[]'::jsonb, '[]'::jsonb, null);
      message_id := (message_result #>> '{entity,id}')::uuid;
      result := jsonb_set(
        message_result,
        '{undo}',
        internal.issue_undo_token(
          source.space_id, actor, 'Undo embed', 'messages.delete',
          jsonb_build_object('messageId', message_id)),
        true);

    else
      raise exception 'unsupported placement intent: %', p_intent using errcode = '22023';
  end case;

  return internal.ledger_record(p_client_mutation_id, 'placements.apply', result);
end
$$;

revoke all on function internal.edge_json_type_matches(jsonb, jsonb) from public;
revoke all on function internal.validate_edge_props_schema() from public;

revoke all on function public.write_edge(uuid, uuid, text, jsonb, uuid, text) from public;
revoke all on function public.update_edge(uuid, jsonb, uuid, text) from public;
revoke all on function public.delete_edge(uuid, uuid, text) from public;
revoke all on function public.place_entity(uuid, uuid, text, text, double precision, uuid, text) from public;
grant execute on function public.write_edge(uuid, uuid, text, jsonb, uuid, text) to tm8_app;
grant execute on function public.update_edge(uuid, jsonb, uuid, text) to tm8_app;
grant execute on function public.delete_edge(uuid, uuid, text) to tm8_app;
grant execute on function public.place_entity(uuid, uuid, text, text, double precision, uuid, text) to tm8_app;

reset role;
