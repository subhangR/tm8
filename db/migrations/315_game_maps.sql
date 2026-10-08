-- Map identity uses the approved graph/tm8-map entity fallback. Graph content
-- contains identity only; high-volume writes have no entity/event triggers.
create schema map authorization tm8_graph_owner;
set role tm8_graph_owner;
grant usage on schema map to tm8_app;

create unique index game_map_identity on public.graphs
  ((layout->>'type'), (layout#>>'{scope,kind}'), ((layout#>>'{scope,id}')::uuid))
  where graph_type = 'tm8-map';

create function map.validate_selection(p_space uuid, p_selection jsonb) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare scope_id uuid := (p_selection#>>'{scope,id}')::uuid;
begin
  perform internal.require_space_member(p_space);
  if coalesce(p_selection->>'type','') not in ('hub','taskland','office','library','factory','town') then
    raise exception 'unknown map type' using errcode='22023';
  end if;
  if p_selection#>>'{scope,kind}' = 'space' then
    if scope_id is distinct from p_space then raise exception 'scope belongs to another space' using errcode='42501'; end if;
  elsif p_selection#>>'{scope,kind}' = 'story' then
    if not exists(select 1 from public.entities where id=scope_id and space_id=p_space and kind='story' and deleted_at is null)
      or not internal.entity_readable(scope_id) then raise exception 'story not found' using errcode='P0002'; end if;
  else raise exception 'invalid map scope' using errcode='22023'; end if;
end $$;

create function map.identity_guard() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare space uuid;
begin
  if tg_op='UPDATE' and old.graph_type='tm8-map' and
    (new.graph_type<>old.graph_type or new.layout<>old.layout or new.entity_id<>old.entity_id) then
    raise exception 'map identity is immutable' using errcode='23514';
  end if;
  if new.graph_type='tm8-map' then
    if new.nodes<>'[]'::jsonb or new.edges<>'[]'::jsonb or new.source is not null
      or new.layout - array['type','scope'] <> '{}'::jsonb then
      raise exception 'map entity stores identity only' using errcode='23514';
    end if;
    select space_id into space from public.entities where id=new.entity_id;
    if new.layout#>>'{scope,kind}'='space' then
      if (new.layout#>>'{scope,id}')::uuid<>space then raise exception 'invalid space scope' using errcode='23514'; end if;
    elsif new.layout#>>'{scope,kind}'='story' then
      if not exists(select 1 from public.entities where id=(new.layout#>>'{scope,id}')::uuid and space_id=space and kind='story') then
        raise exception 'invalid story scope' using errcode='23514'; end if;
    else raise exception 'invalid map scope' using errcode='23514'; end if;
    if coalesce(new.layout->>'type','') not in ('hub','taskland','office','library','factory','town') or new.layout#>>'{scope,id}'<>(new.layout#>>'{scope,id}')::uuid::text then
      raise exception 'invalid or noncanonical map identity' using errcode='23514'; end if;
  end if;
  return new;
end $$;
create trigger game_map_identity_guard before insert or update on public.graphs
for each row execute function map.identity_guard();

create table map.editors(map_id uuid not null, actor_id uuid not null,
  role text not null check(role in ('owner','editor','viewer')), primary key(map_id,actor_id));
create table map.placements(
  map_id uuid not null, item_id uuid not null, entity_id uuid,
  kind text not null check(kind in ('ref','decor','path','portal','landmark')),
  x double precision not null check(x between -1000000 and 1000000),
  z double precision not null check(z between -1000000 and 1000000),
  rotation double precision not null default 0 check(rotation between -360 and 360),
  spec jsonb not null default '{}' check(jsonb_typeof(spec)='object'),
  layer text not null check(layer in ('human','agent')), by_actor uuid not null,
  version integer not null check(version>0), expires_at timestamptz, deleted_at timestamptz,
  primary key(map_id,item_id), check((kind='ref')=(entity_id is not null))
);
create index map_placements_entity on map.placements(entity_id) where entity_id is not null;
create table map.terrain_chunks(map_id uuid not null, chunk_x integer not null, chunk_z integer not null,
  tiles jsonb not null check(jsonb_typeof(tiles)='array' and jsonb_array_length(tiles)<=4096),
  version integer not null, by_actor uuid not null, deleted_at timestamptz,
  primary key(map_id,chunk_x,chunk_z));
create table map.edits(map_id uuid not null, seq bigserial primary key, actor_id uuid not null,
  op text not null, item_key text not null, before_state jsonb, after_state jsonb,
  at timestamptz not null default clock_timestamp(), undone_by bigint, source_edit_seq bigint);
create index map_edits_actor on map.edits(map_id,actor_id,at,seq);
create table map.activity(map_id uuid not null, seq bigserial primary key, actor_id uuid not null,
  kind text not null check(kind in ('marker','narration','celebration','spotlight')),
  target_entity_id uuid, text text not null check(length(text)<=1000), audience uuid,
  created_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null);
create index map_activity_since on map.activity(map_id,seq);
create table map.player_states(map_id uuid not null, member_id uuid not null, state jsonb not null,
  updated_at timestamptz not null default clock_timestamp(), primary key(map_id,member_id));
create table map.navigation_states(space_id uuid not null, member_id uuid not null, state jsonb not null,
  revision bigint not null default 1, updated_at timestamptz not null default clock_timestamp(), primary key(space_id,member_id));

-- Denormalized scope is checked on insertion, never trusted from a client.
create function map.bind_space() returns trigger language plpgsql
set search_path = public, internal, pg_temp as $$
declare actual uuid;
begin
  actual := (map.identity(new.map_id)->>'spaceId')::uuid;
  if new.space_id is not null and new.space_id<>actual then
    raise exception 'map row belongs to another space' using errcode='42501'; end if;
  new.space_id:=actual; return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['editors','placements','terrain_chunks','edits','activity','player_states'] loop
    execute format('alter table map.%I add column space_id uuid not null',t);
    execute format('create trigger map_row_scope before insert or update on map.%I for each row execute function map.bind_space()',t);
  end loop;
end $$;

create function map.identity(p_map uuid) returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  select jsonb_build_object('id',e.id,'spaceId',e.space_id,'title',g.title,'type',g.layout->'type','scope',g.layout->'scope')
    into result from public.entities e join public.graphs g on g.entity_id=e.id
    where e.id=p_map and e.deleted_at is null and g.graph_type='tm8-map' and internal.entity_readable(e.id);
  if result is null then raise exception 'map not found' using errcode='P0002'; end if;
  perform map.validate_selection((result->>'spaceId')::uuid,result);
  return result;
end $$;
create function map.readable(p_map uuid) returns boolean
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin perform map.identity(p_map); return true;
exception when no_data_found or insufficient_privilege then return false; end $$;

-- No map table has a foreign key or trigger into the entity/event store.
do $$ declare t text; begin
  foreach t in array array['editors','placements','terrain_chunks','edits','activity','player_states'] loop
    execute format('alter table map.%I enable row level security',t);
    execute format('create policy map_read on map.%I for select to tm8_app using(internal.is_space_member(space_id) and map.readable(map_id))',t);
    execute format('grant select on map.%I to tm8_app',t);
  end loop;
end $$;
drop policy map_read on map.player_states;
create policy player_self on map.player_states for select to tm8_app using
  (internal.is_space_member(space_id) and map.readable(map_id) and internal.claim_text('tm8.auth_kind') in ('browser','cli')
    and member_id=internal.current_member_id(space_id) and (internal.actor_id() is null or internal.actor_id()=member_id));
drop policy map_read on map.activity;
create policy activity_audience on map.activity for select to tm8_app using
  (internal.is_space_member(space_id) and map.readable(map_id) and (audience is null or audience=internal.current_member_id(space_id)));
alter table map.navigation_states enable row level security;
create policy navigation_self on map.navigation_states for select to tm8_app using
  (internal.is_space_member(space_id) and internal.claim_text('tm8.auth_kind') in ('browser','cli')
    and member_id=internal.current_member_id(space_id) and (internal.actor_id() is null or internal.actor_id()=member_id));
grant select on map.navigation_states to tm8_app;

create function map.ensure_identity(p_space uuid,p_selection jsonb,p_actor uuid) returns uuid
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare map_id uuid;
begin
  p_selection:=jsonb_build_object('type',p_selection->'type','scope',jsonb_build_object('kind',p_selection#>>'{scope,kind}','id',(p_selection#>>'{scope,id}')::uuid::text));
  perform map.validate_selection(p_space,p_selection);
  perform pg_advisory_xact_lock(hashtextextended('map-identity:'||p_selection::text,0));
  select g.entity_id into map_id from public.graphs g join public.entities e on e.id=g.entity_id
    where g.graph_type='tm8-map' and g.layout=p_selection and e.space_id=p_space;
  if map_id is null then
    map_id:=internal.create_envelope(p_space,'graph',p_actor,null,null);
    insert into public.graphs(entity_id,title,graph_type,layout)
      values(map_id,initcap(p_selection->>'type')||' map','tm8-map',p_selection);
    perform internal.record_initial_version(map_id,p_actor);
  elsif exists(select 1 from public.entities where id=map_id and deleted_at is not null) then
    perform public.restore_entity(map_id,p_actor,null);
  end if;
  return map_id;
end $$;

create table map.command_inputs(client_mutation_id text primary key, op text not null, input_hash text not null, created_at timestamptz not null default clock_timestamp());
create index map_command_inputs_expiry on map.command_inputs(created_at);
-- Hash retention follows the ledger replay window; retain its existing return contract.
create or replace function internal.prune_command_ledger(retain interval default interval '24 hours')
returns bigint language plpgsql set search_path = public, internal, pg_temp as $$
declare removed bigint;
begin
  delete from public.command_ledger where created_at<now()-retain;
  get diagnostics removed=row_count;
  delete from map.command_inputs where created_at<now()-retain;
  return removed;
end $$;
create function map.require_mutation(p_cmid text) returns void language plpgsql as $$
begin
  if p_cmid is null or length(btrim(p_cmid)) not between 1 and 200 then raise exception 'clientMutationId is required' using errcode='22023'; end if;
  perform internal.require_replay_principal(p_cmid);
end $$;
create function map.check_payload(p_cmid text,p_op text,p_input jsonb) returns void language plpgsql as $$
declare request_hash text:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
begin
  delete from map.command_inputs where created_at<clock_timestamp()-interval '24 hours';
  if exists(select 1 from map.command_inputs where client_mutation_id=p_cmid and (op<>p_op or map.command_inputs.input_hash<>request_hash)) then
    raise exception 'mutation id reused with different input' using errcode='23514'; end if;
  insert into map.command_inputs(client_mutation_id,op,input_hash) values(p_cmid,p_op,request_hash) on conflict do nothing;
end $$;

create function public.game_map_open(p_space uuid,p_selection jsonb,p_cmid text) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare actor uuid; replay jsonb; mid uuid;
begin
  perform map.require_mutation(p_cmid);
  p_selection:=jsonb_build_object('type',p_selection->'type','scope',jsonb_build_object('kind',p_selection#>>'{scope,kind}','id',(p_selection#>>'{scope,id}')::uuid::text));
  perform map.validate_selection(p_space,p_selection);
  replay:=internal.ledger_replay(p_cmid,'maps.open');
  perform map.check_payload(p_cmid,'maps.open',jsonb_build_object('spaceId',p_space,'selection',p_selection));
  if replay is not null then
    if replay->>'spaceId'<>p_space::text or replay->'type'<>p_selection->'type' or replay->'scope'<>p_selection->'scope' then
      raise exception 'mutation belongs to another map' using errcode='23514'; end if;
    return map.identity((replay->>'id')::uuid);
  end if;
  actor:=internal.resolve_actor(internal.actor_id(),p_space); perform internal.bind_actor(actor);
  mid:=map.ensure_identity(p_space,p_selection,actor);
  return internal.ledger_record(p_cmid,'maps.open',map.identity(mid));
end $$;

create function map.require_ref(p_map uuid,p_entity uuid) returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare identity jsonb:=map.identity(p_map); entity_kind text; story uuid:=(identity#>>'{scope,id}')::uuid;
begin
  if p_entity is null or not exists(select 1 from public.entities where id=p_entity and deleted_at is null
    and space_id=(identity->>'spaceId')::uuid) or not internal.entity_readable(p_entity) then
    raise exception 'target entity not found' using errcode='P0002'; end if;
  select kind into entity_kind from public.entities where id=p_entity;
  if not (case identity->>'type'
    when 'hub' then entity_kind='story'
    when 'taskland' then entity_kind in ('task','work_session')
    when 'office' then entity_kind in ('member','team_member','work_session','skill')
    when 'library' then entity_kind in ('doc','drawing','artifact','file')
    when 'factory' then entity_kind in ('project','pull_request','commit','worktree')
    when 'town' then entity_kind in ('task','work_session','doc','drawing','artifact','file','project','pull_request','commit','worktree')
    else false end) then raise exception 'entity kind not admitted by map type' using errcode='22023'; end if;
  if identity#>>'{scope,kind}'='story' and p_entity<>story and not exists
    (select 1 from internal.story_trail(story) where entity_id=p_entity) then
    raise exception 'target outside story scope' using errcode='42501'; end if;
end $$;
create function map.ref_readable(p_map uuid,p_entity uuid) returns boolean
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin perform map.require_ref(p_map,p_entity); return true;
exception when no_data_found or insufficient_privilege or invalid_parameter_value then return false; end $$;
create function map.is_agent(p_actor uuid) returns boolean language sql stable as $$
  select exists(select 1 from public.entities where id=p_actor and kind='team_member')
    or coalesce(internal.claim_text('tm8.auth_kind') in ('agent','agent_runtime'),false)
$$;
create function map.check_edit(p_map uuid,p_actor uuid,p_layer text,p_terrain boolean default false) returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare identity jsonb:=map.identity(p_map);
begin
  if map.is_agent(p_actor) and (p_layer='human' or p_terrain) then
    raise exception 'agents cannot change human placements or terrain' using errcode='42501'; end if;
  if (p_terrain or (identity->>'type'<>'town' and p_layer='human')) and not exists(select 1 from map.editors where map_id=p_map and actor_id=p_actor and role in ('owner','editor'))
    and not internal.is_space_admin((identity->>'spaceId')::uuid) then
    raise exception 'terrain requires a human editor' using errcode='42501'; end if;
end $$;
create function map.rate_check(p_map uuid,p_actor uuid) returns void
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if (select count(*) from map.edits where map_id=p_map and actor_id=p_actor and at>clock_timestamp()-interval '1 minute')+
     (select count(*) from map.activity where map_id=p_map and actor_id=p_actor and created_at>clock_timestamp()-interval '1 minute') >=60 then
    raise exception 'map rate limit exceeded' using errcode='TM429'; end if;
end $$;

create function map.undo_edit(p_map uuid,p_seq bigint,p_actor uuid,p_chain_state jsonb default null) returns bigint
language plpgsql set search_path = public, internal, pg_temp as $$
declare edit map.edits; current_state jsonb; restored jsonb; new_seq bigint; ver integer; identity jsonb:=map.identity(p_map);
begin
  select * into edit from map.edits where map_id=p_map and seq=p_seq for update;
  if not found then raise exception 'edit not found' using errcode='P0002'; end if;
  if edit.undone_by is not null then raise exception 'edit already undone' using errcode='40001'; end if;
  if p_actor<>edit.actor_id and not (identity->>'type'='town' and edit.op<>'paint' and not map.is_agent(p_actor)) and (map.is_agent(p_actor) or not exists(select 1 from map.editors where map_id=p_map and actor_id=p_actor and role in ('owner','editor'))
    and not internal.is_space_admin((identity->>'spaceId')::uuid)) then
    raise exception 'only the author or human editor may undo' using errcode='42501'; end if;
  if edit.op='paint' then
    select to_jsonb(t) into current_state from map.terrain_chunks t where map_id=p_map
      and chunk_x=(edit.after_state->>'chunk_x')::integer and chunk_z=(edit.after_state->>'chunk_z')::integer;
    perform map.check_edit(p_map,p_actor,'human',true);
  else
    select to_jsonb(p) into current_state from map.placements p where map_id=p_map and item_id=edit.item_key::uuid;
    perform map.check_edit(p_map,p_actor,current_state->>'layer');
  end if;
  if current_state is distinct from edit.after_state and not
    (p_chain_state is not null and current_state=p_chain_state and current_state-array['version','by_actor']=edit.after_state-array['version','by_actor']) then raise exception 'edit changed since: cannot undo' using errcode='40001'; end if;
  ver:=(current_state->>'version')::integer+1;
  restored:=coalesce(edit.before_state,current_state||jsonb_build_object('deleted_at',clock_timestamp()));
  restored:=restored||jsonb_build_object('version',ver,'by_actor',p_actor);
  if edit.op='paint' then
    update map.terrain_chunks set tiles=restored->'tiles',version=ver,by_actor=p_actor,
      deleted_at=(restored->>'deleted_at')::timestamptz where map_id=p_map
      and chunk_x=(restored->>'chunk_x')::integer and chunk_z=(restored->>'chunk_z')::integer;
    select to_jsonb(t) into restored from map.terrain_chunks t where map_id=p_map
      and chunk_x=(restored->>'chunk_x')::integer and chunk_z=(restored->>'chunk_z')::integer;
  else
    if restored->>'deleted_at' is null and restored->>'entity_id' is not null then perform map.require_ref(p_map,(restored->>'entity_id')::uuid); end if;
    update map.placements set entity_id=(restored->>'entity_id')::uuid,kind=restored->>'kind',x=(restored->>'x')::float8,
      z=(restored->>'z')::float8,rotation=(restored->>'rotation')::float8,spec=restored->'spec',layer=restored->>'layer',
      by_actor=p_actor,version=ver,expires_at=(restored->>'expires_at')::timestamptz,deleted_at=(restored->>'deleted_at')::timestamptz
      where map_id=p_map and item_id=edit.item_key::uuid;
    select to_jsonb(p) into restored from map.placements p where map_id=p_map and item_id=edit.item_key::uuid;
  end if;
  -- Store inverse writes as ordinary edits; terrain keeps its resource kind.
  insert into map.edits(map_id,actor_id,op,item_key,before_state,after_state,source_edit_seq)
    values(p_map,p_actor,case when edit.op='paint' then 'paint' else 'undo' end,edit.item_key,current_state,restored,p_seq) returning seq into new_seq;
  update map.edits set undone_by=new_seq where seq=p_seq;
  return new_seq;
end $$;

create function public.game_map_write(p_map uuid,p_op text,p_input jsonb,p_cmid text) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare identity jsonb:=map.identity(p_map); actor uuid; agent boolean; replay jsonb; result jsonb;
  item uuid; before_state jsonb; after_state jsonb; edit_seq bigint; placement_layer text; ver integer; ttl integer;
  cx integer; cz integer; original record; undone jsonb:='[]'; conflicts jsonb:='[]'; chains jsonb:='{}'; resource_key text; last_selected bigint;
begin
  perform map.require_mutation(p_cmid);
  replay:=internal.ledger_replay(p_cmid,'maps.'||p_op);
  perform map.check_payload(p_cmid,'maps.'||p_op,jsonb_build_object('mapId',p_map,'input',p_input));
  if replay is not null then
    if replay->>'mapId'<>p_map::text then raise exception 'mutation belongs to another map' using errcode='23514'; end if;
    return replay;
  end if;
  actor:=internal.resolve_actor(internal.actor_id(),(identity->>'spaceId')::uuid); perform internal.bind_actor(actor);
  agent:=map.is_agent(actor);
  perform pg_advisory_xact_lock(hashtextextended('map-write:'||p_map::text,0));
  perform map.rate_check(p_map,actor);
  if p_op in ('place','move','remove') then
    item:=(p_input->>'itemId')::uuid;
    select to_jsonb(p) into before_state from map.placements p where map_id=p_map and item_id=item for update;
    if coalesce((before_state->>'version')::integer,0) is distinct from (p_input->>'expectedVersion')::integer then
      raise exception 'placement version conflict' using errcode='40001'; end if;
    if before_state is not null then perform map.check_edit(p_map,actor,before_state->>'layer'); end if;
    ver:=coalesce((before_state->>'version')::integer,0)+1;
    if p_op='place' then
      placement_layer:=case when agent then 'agent' else 'human' end;
      if p_input->>'kind'='ref' then perform map.require_ref(p_map,(p_input->>'entityId')::uuid); end if;
      if p_input->>'kind'='portal' then
        if p_input#>>'{spec,targetMapId}' is null then raise exception 'portal target required' using errcode='22023'; end if;
        if (map.identity((p_input#>>'{spec,targetMapId}')::uuid)->>'spaceId')<>identity->>'spaceId' then
          raise exception 'portal belongs to another space' using errcode='42501'; end if;
      end if;
      if (p_input->'spec') - array['asset','text','targetMapId'] <> '{}'::jsonb then raise exception 'unknown placement fields' using errcode='22023'; end if;
      if p_input->>'kind'<>'ref' and p_input#>>'{spec,asset}' is not null and p_input#>>'{spec,asset}' not in ('tree','rock','plant','lamp','path','sign','banner','portal','landmark') then
        raise exception 'buildings require real entities' using errcode='22023'; end if;
      if agent and (select count(*) from map.placements where map_id=p_map and by_actor=actor and layer='agent'
        and deleted_at is null and expires_at>clock_timestamp() and item_id<>item)>=200 then
        raise exception 'agent placement cap exceeded' using errcode='TM429'; end if;
      ttl:=coalesce((p_input->>'ttlSeconds')::integer,86400);
      if ttl not between 1 and 86400 then raise exception 'invalid TTL' using errcode='22023'; end if;
      insert into map.placements(map_id,item_id,entity_id,kind,x,z,rotation,spec,layer,by_actor,version,expires_at,deleted_at) values(p_map,item,(p_input->>'entityId')::uuid,p_input->>'kind',
        (p_input->>'x')::float8,(p_input->>'z')::float8,coalesce((p_input->>'rotation')::float8,0),coalesce(p_input->'spec','{}'),
        placement_layer,actor,ver,case when agent then clock_timestamp()+make_interval(secs=>ttl) end,null)
      on conflict(map_id,item_id) do update set entity_id=excluded.entity_id,kind=excluded.kind,x=excluded.x,z=excluded.z,
        rotation=excluded.rotation,spec=excluded.spec,layer=excluded.layer,by_actor=excluded.by_actor,version=excluded.version,
        expires_at=excluded.expires_at,deleted_at=null;
    else
      if before_state is null or before_state->>'deleted_at' is not null then raise exception 'placement not found' using errcode='P0002'; end if;
      if p_op='move' then
        update map.placements set x=(p_input->>'x')::float8,z=(p_input->>'z')::float8,version=ver,by_actor=actor,layer=case when agent then 'agent' else 'human' end,expires_at=case when agent then expires_at else null end where map_id=p_map and item_id=item;
      else update map.placements set deleted_at=clock_timestamp(),version=ver,by_actor=actor,layer=case when agent then 'agent' else 'human' end,expires_at=case when agent then expires_at else null end where map_id=p_map and item_id=item; end if;
    end if;
    select to_jsonb(p) into after_state from map.placements p where map_id=p_map and item_id=item;
    insert into map.edits(map_id,actor_id,op,item_key,before_state,after_state) values(p_map,actor,p_op,item::text,before_state,after_state) returning map.edits.seq into edit_seq;
    result:=jsonb_build_object('mapId',p_map,'itemId',item,'version',ver,'editSeq',edit_seq);
  elsif p_op='paint' then
    perform map.check_edit(p_map,actor,'human',true);
    cx:=(p_input->>'chunkX')::integer; cz:=(p_input->>'chunkZ')::integer;
    if cx not between -10000 and 10000 or cz not between -10000 and 10000
      or jsonb_typeof(p_input->'tiles')<>'array' or jsonb_array_length(p_input->'tiles')>4096 then
      raise exception 'invalid terrain chunk' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements(p_input->'tiles') v where jsonb_typeof(v)<>'number'
      or (v#>>'{}')::numeric not between 0 and 65535 or trunc((v#>>'{}')::numeric)<>(v#>>'{}')::numeric) then
      raise exception 'invalid terrain tile' using errcode='22023'; end if;
    select to_jsonb(t) into before_state from map.terrain_chunks t where map_id=p_map and t.chunk_x=cx and t.chunk_z=cz for update;
    if coalesce((before_state->>'version')::integer,0) is distinct from (p_input->>'expectedVersion')::integer then raise exception 'terrain version conflict' using errcode='40001'; end if;
    ver:=coalesce((before_state->>'version')::integer,0)+1;
    insert into map.terrain_chunks(map_id,chunk_x,chunk_z,tiles,version,by_actor,deleted_at) values(p_map,cx,cz,p_input->'tiles',ver,actor,null)
      on conflict(map_id,chunk_x,chunk_z) do update set tiles=excluded.tiles,version=excluded.version,by_actor=actor,deleted_at=null;
    select to_jsonb(t) into after_state from map.terrain_chunks t where map_id=p_map and t.chunk_x=cx and t.chunk_z=cz;
    insert into map.edits(map_id,actor_id,op,item_key,before_state,after_state) values(p_map,actor,p_op,cx||','||cz,before_state,after_state) returning map.edits.seq into edit_seq;
    result:=jsonb_build_object('mapId',p_map,'version',ver,'editSeq',edit_seq);
  elsif p_op='undo' then
    edit_seq:=map.undo_edit(p_map,(p_input->>'editSeq')::bigint,actor);
    result:=jsonb_build_object('mapId',p_map,'editSeq',edit_seq);
  elsif p_op='revert' then
    -- Reverse chronological order; a compensation may continue the same
    -- actor's chain only against the exact row returned by this batch.
    for original in select e.seq,e.op,e.item_key from map.edits e where e.map_id=p_map and e.actor_id=(p_input->>'byActor')::uuid
      and e.at>=(p_input->>'since')::timestamptz and e.undone_by is null and e.source_edit_seq is null
      and (p_input->>'beforeSeq' is null or e.seq<(p_input->>'beforeSeq')::bigint) order by e.seq desc limit 200 loop
      begin
        last_selected:=original.seq;
        resource_key:=case when original.op='paint' then 'terrain:' else 'placement:' end||original.item_key;
        edit_seq:=map.undo_edit(p_map,original.seq,actor,chains->resource_key); undone:=undone||jsonb_build_array(original.seq);
        select e.after_state into after_state from map.edits e where e.seq=edit_seq;
        chains:=jsonb_set(chains,array[resource_key],after_state);
      exception when serialization_failure then conflicts:=conflicts||jsonb_build_array(original.seq); end;
    end loop;
    result:=jsonb_build_object('mapId',p_map,'undone',undone,'conflicts',conflicts,'nextBefore',last_selected,'hasMore',exists(select 1 from map.edits e where e.map_id=p_map and e.actor_id=(p_input->>'byActor')::uuid and e.at>=(p_input->>'since')::timestamptz and e.undone_by is null and e.source_edit_seq is null and e.seq<last_selected));
  elsif p_op='activity.append' then
    if p_input->>'kind'<>'narration' or p_input->>'targetEntityId' is not null then perform map.require_ref(p_map,(p_input->>'targetEntityId')::uuid); end if;
    if p_input->>'kind'='narration' and p_input->>'audience' is not null then raise exception 'narration is shared' using errcode='22023'; end if;
    if p_input->>'audience' is not null and not exists(select 1 from public.members where entity_id=(p_input->>'audience')::uuid and space_id=(identity->>'spaceId')::uuid and status='active') then
      raise exception 'audience member not found' using errcode='P0002'; end if;
    ttl:=coalesce((p_input->>'ttlSeconds')::integer,case when p_input->>'kind'='celebration' then 7200 else 86400 end);
    if ttl not between 1 and (case when p_input->>'kind'='celebration' then 7200 else 86400 end) then raise exception 'invalid TTL' using errcode='22023'; end if;
    -- Pruning cannot erase rate-limit accounting for the previous minute.
    delete from map.activity where map_id=p_map and expires_at<clock_timestamp() and created_at<clock_timestamp()-interval '1 minute';
    if agent and (select count(*) from map.activity where map_id=p_map and actor_id=actor and expires_at>clock_timestamp())>=200 then
      raise exception 'agent activity cap exceeded' using errcode='TM429'; end if;
    insert into map.activity(map_id,actor_id,kind,target_entity_id,text,audience,expires_at)
      values(p_map,actor,p_input->>'kind',(p_input->>'targetEntityId')::uuid,p_input->>'text',(p_input->>'audience')::uuid,
        clock_timestamp()+make_interval(secs=>ttl)) returning map.activity.seq into edit_seq;
    result:=jsonb_build_object('mapId',p_map,'seq',edit_seq);
  else raise exception 'unknown map operation' using errcode='22023'; end if;
  return internal.ledger_record(p_cmid,'maps.'||p_op,result);
end $$;

create table map.navigation_limits(space_id uuid not null,member_id uuid not null,window_start timestamptz not null,writes integer not null,primary key(space_id,member_id));
alter table map.navigation_limits enable row level security;
create function map.validate_memory(p_state jsonb) returns void language plpgsql as $$
declare vector jsonb; value jsonb;
begin
  if jsonb_typeof(p_state)<>'object' or p_state-array['position','camera']<>'{}' then raise exception 'invalid map memory' using errcode='22023'; end if;
  if p_state ? 'position' then
    if jsonb_typeof(p_state->'position')<>'object' or (p_state->'position')-array['x','z']<>'{}' then raise exception 'invalid position' using errcode='22023'; end if;
    foreach vector in array array[p_state#>'{position,x}',p_state#>'{position,z}'] loop
      if vector is null or jsonb_typeof(vector)<>'number' then raise exception 'invalid coordinate' using errcode='22023'; end if;
      if (vector#>>'{}')::numeric not between -1000000 and 1000000 then raise exception 'coordinate out of bounds' using errcode='22023'; end if;
    end loop;
  end if;
  if p_state ? 'camera' then
    if jsonb_typeof(p_state->'camera')<>'object' or (p_state->'camera')-array['zoom','position','target']<>'{}' or jsonb_typeof(p_state#>'{camera,zoom}') is distinct from 'number' then raise exception 'invalid camera' using errcode='22023'; end if;
    if (p_state#>>'{camera,zoom}')::numeric not between 0.1 and 1000 then raise exception 'invalid zoom' using errcode='22023'; end if;
    foreach vector in array array[p_state#>'{camera,position}',p_state#>'{camera,target}'] loop
      if vector is null or jsonb_typeof(vector)<>'array' or jsonb_array_length(vector)<>3 then raise exception 'invalid camera vector' using errcode='22023'; end if;
      for value in select jsonb_array_elements(vector) loop
        if jsonb_typeof(value)<>'number' then raise exception 'invalid camera coordinate' using errcode='22023'; end if;
        if (value#>>'{}')::numeric not between -1000000 and 1000000 then raise exception 'camera coordinate out of bounds' using errcode='22023'; end if;
      end loop;
    end loop;
  end if;
end $$;

create function map.normalize_navigation(p_space uuid,p_save jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare route jsonb:=(p_save->'stack')||jsonb_build_array(p_save->'current');
  valid_route jsonb:='[]'; selection jsonb; previous jsonb; entry record; parts jsonb;
  memories jsonb:='{}'; truncated boolean:=false; dropped integer:=0; stack jsonb;
begin
  for selection in select value from jsonb_array_elements(route) loop
    begin
      if previous is not null and (previous->>'type'<>'hub' or (selection->>'type'<>'hub' and selection->'scope'<>previous->'scope')
        or (selection->>'type'='hub' and (selection#>>'{scope,kind}'<>'story' or selection#>>'{scope,id}'=previous#>>'{scope,id}'))) then
        raise exception 'malformed navigation route' using errcode='22023'; end if;
      perform map.validate_selection(p_space,selection);
      if previous is not null and selection->>'type'='hub' and previous#>>'{scope,kind}'='story'
        and not exists(select 1 from public.entities where id=(selection#>>'{scope,id}')::uuid and parent_id=(previous#>>'{scope,id}')::uuid) then
        raise exception 'invalid story parent' using errcode='42501'; end if;
    exception when no_data_found or insufficient_privilege then truncated:=true; exit; end;
    valid_route:=valid_route||jsonb_build_array(selection); previous:=selection;
  end loop;
  if jsonb_array_length(valid_route)=0 then valid_route:=jsonb_build_array(jsonb_build_object('type','hub','scope',jsonb_build_object('kind','space','id',p_space))); end if;
  select coalesce(jsonb_agg(value order by ordinality),'[]') into stack from jsonb_array_elements(valid_route) with ordinality
    where ordinality<jsonb_array_length(valid_route);
  for entry in select key,value from jsonb_each(p_save->'maps') loop
    parts:=entry.key::jsonb;
    selection:=jsonb_build_object('type',parts->2,'scope',jsonb_build_object('kind',parts->0,'id',parts->1));
    begin
      perform map.validate_selection(p_space,selection);
    exception when no_data_found or insufficient_privilege then dropped:=dropped+1; continue; end;
    memories:=memories||jsonb_build_object(entry.key,entry.value);
  end loop;
  return jsonb_build_object('save',p_save||jsonb_build_object('current',valid_route->(jsonb_array_length(valid_route)-1),'stack',stack,'maps',memories),
    'repairs',jsonb_build_object('routeTruncated',truncated,'droppedMemories',dropped));
end $$;

create function public.game_navigation_get(p_space uuid) returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare member uuid; saved map.navigation_states; memories jsonb;
begin
  perform internal.require_human_auth_kind(); perform internal.require_space_member(p_space); member:=internal.current_member_id(p_space);
  if member is null or (internal.actor_id() is not null and internal.actor_id()<>member) then raise exception 'member required' using errcode='42501'; end if;
  select * into saved from map.navigation_states where space_id=p_space and member_id=member;
  if not found then return jsonb_build_object('spaceId',p_space,'memberId',member,'save',null,'revision',0,'repairs',jsonb_build_object('routeTruncated',false,'droppedMemories',0)); end if;
  select coalesce(jsonb_object_agg('['||to_jsonb(g.layout#>>'{scope,kind}')::text||','||
      to_jsonb(g.layout#>>'{scope,id}')::text||','||to_jsonb(g.layout->>'type')::text||']',s.state),'{}') into memories
    from map.player_states s join public.graphs g on g.entity_id=s.map_id
    join public.entities e on e.id=g.entity_id and e.space_id=p_space and e.deleted_at is null
    where s.member_id=member and internal.entity_readable(e.id);
  return jsonb_build_object('spaceId',p_space,'memberId',member,'revision',saved.revision)||map.normalize_navigation(p_space,saved.state||jsonb_build_object('maps',memories));
end $$;

create function public.game_navigation_save(p_space uuid,p_save jsonb,p_revision bigint,p_cmid text) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare member uuid; actor uuid; replay jsonb; rev bigint; entry record; selection jsonb; mid uuid; route jsonb; previous jsonb; story uuid; result jsonb; repairs jsonb; writes integer;
begin
  perform internal.require_human_auth_kind(); perform map.require_mutation(p_cmid); perform internal.require_space_member(p_space);
  member:=internal.current_member_id(p_space); actor:=internal.resolve_actor(internal.actor_id(),p_space);
  if member is null or actor<>member or map.is_agent(actor) or p_save->>'spaceId' is distinct from p_space::text or p_save->>'memberId' is distinct from member::text then
    raise exception 'navigation belongs to signed-in member' using errcode='42501'; end if;
  replay:=internal.ledger_replay(p_cmid,'maps.navigation.save');
  perform map.check_payload(p_cmid,'maps.navigation.save',jsonb_build_object('spaceId',p_space,'save',p_save,'revision',p_revision));
  if replay is not null then
    if replay#>>'{save,spaceId}'<>p_space::text then raise exception 'mutation belongs to another space' using errcode='23514'; end if; return replay; end if;
  perform internal.bind_actor(actor);
  if octet_length(p_save::text)>65536 or p_save-array['version','spaceId','memberId','current','stack','maps']<>'{}' or p_save->>'version'<>'1' or jsonb_typeof(p_save->'stack')<>'array' or jsonb_array_length(p_save->'stack')>64
    or jsonb_typeof(p_save->'maps')<>'object' or (select count(*) from jsonb_object_keys(p_save->'maps'))>128 then
    raise exception 'invalid navigation save' using errcode='22023'; end if;
  result:=map.normalize_navigation(p_space,p_save);
  p_save:=result->'save'; repairs:=result->'repairs';
  perform pg_advisory_xact_lock(hashtextextended('map-navigation:'||p_space::text||member::text,0));
  select revision into rev from map.navigation_states where space_id=p_space and member_id=member;
  if coalesce(rev,0) is distinct from p_revision then raise exception 'navigation revision conflict' using errcode='40001',detail=public.game_navigation_get(p_space)::text; end if;
  insert into map.navigation_limits values(p_space,member,clock_timestamp(),1)
    on conflict(space_id,member_id) do update set
      writes=case when map.navigation_limits.window_start<clock_timestamp()-interval '1 minute' then 1 else map.navigation_limits.writes+1 end,
      window_start=case when map.navigation_limits.window_start<clock_timestamp()-interval '1 minute' then clock_timestamp() else map.navigation_limits.window_start end
    returning map.navigation_limits.writes into writes;
  if writes>120 then raise exception 'navigation rate limit exceeded' using errcode='TM429'; end if;
  -- Canonical keys are verified before storage, with each referenced scope live.
  for entry in select key,value from jsonb_each(p_save->'maps') loop
    perform map.validate_memory(entry.value);
    route:=entry.key::jsonb;
    selection:=jsonb_build_object('type',route->2,'scope',jsonb_build_object('kind',route->0,'id',route->1));
    if entry.key<>'['||to_jsonb(selection#>>'{scope,kind}')::text||','||to_jsonb(selection#>>'{scope,id}')::text||','||to_jsonb(selection->>'type')::text||']' then
      raise exception 'invalid map memory key' using errcode='22023'; end if;
    select g.entity_id into mid from public.graphs g join public.entities e on e.id=g.entity_id
      where g.graph_type='tm8-map' and g.layout=selection and e.space_id=p_space and e.deleted_at is null;
    if mid is null then
      repairs:=jsonb_set(repairs,'{droppedMemories}',to_jsonb((repairs->>'droppedMemories')::integer+1));
      continue;
    end if;
    insert into map.player_states(map_id,member_id,state,updated_at) values(mid,member,entry.value,clock_timestamp())
      on conflict(map_id,member_id) do update set state=excluded.state,updated_at=excluded.updated_at where map.player_states.state is distinct from excluded.state;
  end loop;
  -- A replacement save also drops evicted memories (Phase1's 128-map bound).
  delete from map.player_states s using public.graphs g,public.entities e
    where s.map_id=g.entity_id and e.id=g.entity_id and e.space_id=p_space and s.member_id=member and not
      (p_save->'maps' ? ('['||to_jsonb(g.layout#>>'{scope,kind}')::text||','||to_jsonb(g.layout#>>'{scope,id}')::text||','||to_jsonb(g.layout->>'type')::text||']'));
  insert into map.navigation_states values(p_space,member,p_save-'maps',coalesce(rev,0)+1,clock_timestamp())
    on conflict(space_id,member_id) do update set state=excluded.state,revision=excluded.revision,updated_at=excluded.updated_at;
  return internal.ledger_record(p_cmid,'maps.navigation.save',public.game_navigation_get(p_space)||jsonb_build_object('repairs',repairs));
end $$;

drop policy map_read on map.placements;
create policy placement_visible on map.placements for select to tm8_app using
  (internal.is_space_member(space_id) and map.readable(map_id) and (entity_id is null or map.ref_readable(map_id,entity_id))
    and (spec->>'targetMapId' is null or map.readable((spec->>'targetMapId')::uuid)));
drop policy map_read on map.edits;
create policy edit_visible on map.edits for select to tm8_app using
  (internal.is_space_member(space_id) and map.readable(map_id) and
    (coalesce(after_state,before_state)->>'entity_id' is null or map.ref_readable(map_id,(coalesce(after_state,before_state)->>'entity_id')::uuid)));
drop policy activity_audience on map.activity;
create policy activity_visible on map.activity for select to tm8_app using
  (internal.is_space_member(space_id) and map.readable(map_id) and (audience is null or audience=internal.current_member_id(space_id))
    and (target_entity_id is null or map.ref_readable(map_id,target_entity_id)));

-- Private helpers are not an alternate write surface. Only these three doors
-- are executable by app callers; all writes enforce claims inside the door.
revoke all on all functions in schema map from public;
grant execute on function map.identity(uuid),map.readable(uuid),map.ref_readable(uuid,uuid) to tm8_app;
revoke all on function public.game_map_open(uuid,jsonb,text),public.game_map_write(uuid,text,jsonb,text),
  public.game_navigation_get(uuid),public.game_navigation_save(uuid,jsonb,bigint,text) from public;
grant execute on function public.game_map_open(uuid,jsonb,text),public.game_map_write(uuid,text,jsonb,text),
  public.game_navigation_get(uuid),public.game_navigation_save(uuid,jsonb,bigint,text) to tm8_app;
reset role;
