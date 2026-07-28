-- =============================================================================
-- 024 — W2.G09 saved views and action-discovery storage boundary.
--
-- `saved_views` and its private/shared SELECT policy shipped in 003/008. This
-- migration adds only the three command-ledger-backed write RPCs. Action
-- discovery is capability/composition-derived in the Server and needs no
-- table. The application role keeps SELECT-only table access and receives
-- EXECUTE only on these named functions.
-- =============================================================================
set role tm8_graph_owner;

create or replace function public.create_saved_view(
  p_space_id uuid,
  p_name text,
  p_share_mode text,
  p_query jsonb,
  p_graph_layout jsonb,
  p_actor_id uuid,
  p_client_mutation_id text
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  owner_member uuid;
  saved public.saved_views;
begin
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 200 then
    raise exception 'saved view name must contain 1..200 characters' using errcode = '22023';
  end if;
  if p_share_mode is null or p_share_mode not in ('private', 'space') then
    raise exception 'invalid saved view share mode' using errcode = '22023';
  end if;
  if p_query is null or jsonb_typeof(p_query) <> 'object' then
    raise exception 'saved view query must be an object' using errcode = '22023';
  end if;
  if p_graph_layout is not null and jsonb_typeof(p_graph_layout) <> 'object' then
    raise exception 'saved view graph layout must be an object' using errcode = '22023';
  end if;
  if p_query ->> 'spaceId' is null
     or (p_query ->> 'spaceId')::uuid is distinct from p_space_id then
    raise exception 'saved view query must target its owning Space' using errcode = '22023';
  end if;

  replay := internal.ledger_replay(p_client_mutation_id, 'savedViews.create');
  if replay is not null then
    perform internal.require_space_member((replay ->> 'space_id')::uuid);
    if internal.current_member_id((replay ->> 'space_id')::uuid)
       is distinct from (replay ->> 'owner_member_id')::uuid then
      raise exception 'only the saved view owner may replay this command' using errcode = '42501';
    end if;
    return replay;
  end if;

  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);
  owner_member := internal.current_member_id(p_space_id);

  insert into public.saved_views(
    space_id, owner_member_id, name, share_mode, query, graph_layout)
  values (
    p_space_id, owner_member, p_name, p_share_mode, p_query, p_graph_layout)
  returning * into saved;

  return internal.ledger_record(
    p_client_mutation_id,
    'savedViews.create',
    to_jsonb(saved)
  );
end
$$;

create or replace function public.update_saved_view(
  p_view_id uuid,
  p_name text,
  p_share_mode text,
  p_query jsonb,
  p_graph_layout jsonb,
  p_actor_id uuid,
  p_client_mutation_id text
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  saved public.saved_views;
begin
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 200 then
    raise exception 'saved view name must contain 1..200 characters' using errcode = '22023';
  end if;
  if p_share_mode is null or p_share_mode not in ('private', 'space') then
    raise exception 'invalid saved view share mode' using errcode = '22023';
  end if;
  if p_query is null or jsonb_typeof(p_query) <> 'object' then
    raise exception 'saved view query must be an object' using errcode = '22023';
  end if;
  if p_graph_layout is not null and jsonb_typeof(p_graph_layout) <> 'object' then
    raise exception 'saved view graph layout must be an object' using errcode = '22023';
  end if;

  replay := internal.ledger_replay(p_client_mutation_id, 'savedViews.update');
  if replay is not null then
    perform internal.require_space_member((replay ->> 'space_id')::uuid);
    if internal.current_member_id((replay ->> 'space_id')::uuid)
       is distinct from (replay ->> 'owner_member_id')::uuid then
      raise exception 'only the saved view owner may replay this command' using errcode = '42501';
    end if;
    return replay;
  end if;

  select * into saved from public.saved_views where id = p_view_id for update;
  if saved.id is null then
    raise exception 'saved view not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(saved.space_id);
  actor := internal.resolve_actor(p_actor_id, saved.space_id);
  perform internal.bind_actor(actor);
  if internal.current_member_id(saved.space_id) is distinct from saved.owner_member_id then
    raise exception 'only the saved view owner may update it' using errcode = '42501';
  end if;
  if p_query ->> 'spaceId' is null
     or (p_query ->> 'spaceId')::uuid is distinct from saved.space_id then
    raise exception 'a saved view cannot move between Spaces' using errcode = '22023';
  end if;

  update public.saved_views
     set name = p_name,
         share_mode = p_share_mode,
         query = p_query,
         graph_layout = p_graph_layout
   where id = p_view_id
  returning * into saved;

  return internal.ledger_record(
    p_client_mutation_id,
    'savedViews.update',
    to_jsonb(saved)
  );
end
$$;

create or replace function public.delete_saved_view(
  p_view_id uuid,
  p_actor_id uuid,
  p_client_mutation_id text
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  saved public.saved_views;
begin
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;

  replay := internal.ledger_replay(p_client_mutation_id, 'savedViews.delete');
  if replay is not null then
    perform internal.require_space_member((replay ->> 'space_id')::uuid);
    if internal.current_member_id((replay ->> 'space_id')::uuid)
       is distinct from (replay ->> 'owner_member_id')::uuid then
      raise exception 'only the saved view owner may replay this command' using errcode = '42501';
    end if;
    return replay;
  end if;

  select * into saved from public.saved_views where id = p_view_id for update;
  if saved.id is null then
    raise exception 'saved view not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(saved.space_id);
  actor := internal.resolve_actor(p_actor_id, saved.space_id);
  perform internal.bind_actor(actor);
  if internal.current_member_id(saved.space_id) is distinct from saved.owner_member_id then
    raise exception 'only the saved view owner may delete it' using errcode = '42501';
  end if;

  delete from public.saved_views where id = p_view_id returning * into saved;

  return internal.ledger_record(
    p_client_mutation_id,
    'savedViews.delete',
    to_jsonb(saved)
  );
end
$$;

revoke all on function
  public.create_saved_view(uuid, text, text, jsonb, jsonb, uuid, text),
  public.update_saved_view(uuid, text, text, jsonb, jsonb, uuid, text),
  public.delete_saved_view(uuid, uuid, text)
from public;

grant execute on function
  public.create_saved_view(uuid, text, text, jsonb, jsonb, uuid, text),
  public.update_saved_view(uuid, text, text, jsonb, jsonb, uuid, text),
  public.delete_saved_view(uuid, uuid, text)
to tm8_app;

reset role;
