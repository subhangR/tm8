-- 100_collection_membership.sql
--
-- Collections grow their first write verbs: `collections.addItem` /
-- `collections.removeItem` (catalog, 2026-08-12). Membership stays what 001
-- declared it to be — a `contains` edge (collection → any entity, ordered by
-- props.position) — so the add path is 007's `set_collection_item` sugar,
-- re-issued below with two guards 007 lacked. What was missing is the
-- inverse: a replay-safe removal addressed by (collection, entity) rather
-- than by edge id, so a client that never saw the edge row can still take an
-- item out of a list.
--
-- Mirrors `delete_edge` (018) in shape: same ledger family (`edges.delete`),
-- same P0002 on a missing membership, same `unlinked` activity. ONE deliberate
-- divergence: `delete_edge` joins both endpoints live and so refuses edges
-- touching tombstones; this removal requires only the COLLECTION live, so a
-- membership pointing at an archived entity can still be cleaned out of the
-- list. The edge-row trigger from 003 emits `edge.deleted`, so projections
-- and live collection views update without any new event plumbing.

-- Function ownership and privileges follow the 007/018/020 convention:
-- created as tm8_graph_owner, EXECUTE revoked from PUBLIC (postgres grants it
-- by default on new functions), granted to tm8_app alone. A SECURITY DEFINER
-- function whose claims ride settable GUCs must not be callable by any
-- connectable role that is not the app.
set role tm8_graph_owner;

create or replace function public.remove_collection_item(
  p_collection_id uuid, p_entity_id uuid,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  replay jsonb;
  collection public.entities;
  edge public.edges;
  actor uuid;
  activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.delete');
  if replay is not null then return replay; end if;
  collection := internal.live_entity(p_collection_id, 'collection');
  perform internal.require_space_member(collection.space_id);
  actor := internal.resolve_actor(p_actor_id, collection.space_id);
  perform internal.bind_actor(actor);
  select g.* into edge
    from public.edges g
   where g.src_id = p_collection_id and g.dst_id = p_entity_id and g.type = 'contains'
   for update of g;
  if edge.id is null then
    raise exception 'entity is not in this collection' using errcode = 'P0002';
  end if;
  delete from public.edges where id = edge.id;
  activity_id := internal.record_activity(
    collection.space_id, p_collection_id, actor, 'unlinked', edge.id,
    jsonb_build_object('type', 'contains', 'dstId', p_entity_id));
  return internal.ledger_record(
    p_client_mutation_id,
    'edges.delete',
    internal.command_result(null, null, activity_id, array[p_collection_id, p_entity_id]));
end
$$;

-- `set_collection_item`, re-issued from 007 with two guards the original
-- lacked — both found in review before this migration ever shipped, so the
-- function is replaced here rather than in a follow-up:
--
--   1. SELF-CONTAINMENT IS REFUSED. `contains` is registered non-acyclic
--      (001:921 — nested collections are legal), so `prevent_edge_cycle`
--      never runs for it and nothing else stops `add(C, C)`: a collection
--      would list itself in its own items and count itself in itemCount.
--      Deeper cycles (A⊂B⊂A) remain expressible by that same registration —
--      making `contains` acyclic is a product decision about nesting, not a
--      bug fix, and is deliberately not taken here.
--
--   2. THE POSITION CAST IS TYPE-GUARDED. `props` on an edge is
--      client-controlled (`write_edge` accepts any jsonb but `origin`), so
--      one membership written with `props: {position: "top"}` made the bare
--      `(props->>'position')::double precision` raise 22P02 on EVERY later
--      auto-positioned add — and 22P02 maps to not_found, so a live
--      collection answered 404. Non-numeric positions now simply don't bid
--      for the max. (The facade's preview read guards its own copy of the
--      cast the same way.)
create or replace function public.set_collection_item(
  p_collection_id uuid, p_entity_id uuid, p_position double precision default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  collection public.entities;
  actor uuid;
  next_position double precision;
  edge_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.create');
  if replay is not null then return replay; end if;
  if p_entity_id = p_collection_id then
    raise exception 'a collection cannot contain itself' using errcode = '22023';
  end if;
  collection := internal.live_entity(p_collection_id, 'collection');
  perform internal.require_space_member(collection.space_id);
  actor := internal.resolve_actor(p_actor_id, collection.space_id);
  perform internal.bind_actor(actor);
  perform internal.live_entity(p_entity_id);

  next_position := p_position;
  if next_position is null then
    select coalesce(max(case when jsonb_typeof(props -> 'position') = 'number'
                             then (props ->> 'position')::double precision end), 0) + 1
      into next_position
      from public.edges where src_id = p_collection_id and type = 'contains';
  end if;
  insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
  values (collection.space_id, p_collection_id, p_entity_id, 'contains',
          jsonb_build_object('position', next_position), actor)
  on conflict (src_id, dst_id, type) do update
    set props = public.edges.props || jsonb_build_object('position', next_position), updated_at = now()
  returning id into edge_id;
  return internal.ledger_record(p_client_mutation_id, 'edges.create',
           internal.command_result(null, edge_id,
             internal.record_activity(collection.space_id, p_collection_id, actor, 'linked',
               edge_id, jsonb_build_object('type', 'contains')),
             array[p_collection_id, p_entity_id]));
end
$$;

revoke all on function public.remove_collection_item(uuid,uuid,uuid,text) from public;
grant execute on function public.remove_collection_item(uuid,uuid,uuid,text) to tm8_app;

-- 007 created `set_collection_item` before the blanket grant era ended; make
-- its privileges explicit so the add path is deliberate rather than incidental.
revoke all on function public.set_collection_item(uuid,uuid,double precision,uuid,text) from public;
grant execute on function public.set_collection_item(uuid,uuid,double precision,uuid,text) to tm8_app;

reset role;
