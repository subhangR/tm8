-- 100_collection_membership.sql
--
-- Collections grow their first write verbs: `collections.addItem` /
-- `collections.removeItem` (catalog, 2026-08-12). Membership stays what 001
-- declared it to be — a `contains` edge (collection → any entity, ordered by
-- props.position) — so the add path reuses 007's `set_collection_item` sugar
-- unchanged. What was missing is the inverse: a replay-safe removal addressed
-- by (collection, entity) rather than by edge id, so a client that never saw
-- the edge row can still take an item out of a list.
--
-- Mirrors `delete_edge` (018) exactly: same ledger family (`edges.delete`),
-- same P0002 on a missing membership, same `unlinked` activity shape. The
-- edge-row trigger from 003 emits `edge.deleted`, so projections and live
-- collection views update without any new event plumbing.

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

grant execute on function public.remove_collection_item(uuid,uuid,uuid,text) to tm8_app;

-- 007 created `set_collection_item` before the blanket grant era ended; make
-- its grant explicit so the add path is deliberate rather than incidental.
grant execute on function public.set_collection_item(uuid,uuid,double precision,uuid,text) to tm8_app;
