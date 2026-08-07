-- =============================================================================
-- 077 — finish collection membership: remove, safe nesting, ordered reads.
--
-- The collection framework has been 60% built since 001. `public.collections`
-- (001:680) holds the set, `contains` (001:921) holds the membership with
-- `src_kinds=['collection']`, `dst_kinds=['*']` and `props.position` for order,
-- and `set_collection_item` (007:1160) is the sugar that appends to it. What
-- was never built is the other half of a curated list: you could add an item
-- and you could not take it out, you could nest a collection and it could
-- contain its own ancestor, and the curated order could not be read back.
--
-- THREE THINGS, AND ONE OF THEM IS THE REAL BUG.
--
-- **`unset_collection_item`.** `delete_edge` (007:1350) already removes a
-- membership, but only if you know the edge's id — and nothing on the read
-- side hands one out for a collection item, so the caller who knows
-- (collection, entity) has no way to reach the edge that joins them. This is
-- the mirror of `set_collection_item` and takes the same pair. It is sugar
-- over the same delete, so the `edges.delete` undo token (020:24) still
-- applies: removing an item from a collection stays undoable.
--
-- **`contains` becomes acyclic.** Nesting was already legal — `dst_kinds` is
-- `['*']`, which includes `collection` — but `acyclic` was false, so A could
-- contain B while B contained A. `internal.prevent_edge_cycle` (001:814) is
-- registry-driven exactly so a type can be protected by flipping the flag
-- rather than by writing a second trigger, so that is all this does. The check
-- costs nothing on a flat collection: the recursive walk starts at `dst_id`
-- and only follows `contains`, and a task or a doc is never the SOURCE of one
-- (`src_kinds` is `['collection']`), so the walk terminates on its first step
-- for every non-collection member.
--
-- **The ordering index.** `sort:'position'` used to read `e.position` — the
-- entity's position among its HIERARCHY siblings, which for a curated set is a
-- number about a completely different tree. A collection's order lives in
-- `props.position` on the edge, so ordered membership reads need an index that
-- covers it; without one, every collection open is a sort of the whole
-- `contains` fan-out. The expression is written exactly as the readers cast it
-- so the planner can actually use it.
--
-- NO NEW TABLE, DELIBERATELY. The obvious reading of "collections need an
-- entries table" is a `collection_entries` relation beside `public.edges`, and
-- it was considered and refused: `contains` already carries heterogeneous
-- membership with ordering, kind validation (001:794), RLS, cascade delete and
-- traversal by `graph.query` and `collections.query`'s edge filter. A parallel
-- table would be a SECOND membership mechanism that none of those readers can
-- see, which is two divergent answers to "what is in this list". The entries
-- table already exists; it is spelled `edges where type='contains'`.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Nesting without cycles.
-- -----------------------------------------------------------------------------

-- Refuse the flip if a cycle is already on disk: the trigger only guards new
-- writes, so flipping the flag over existing cyclic data would leave rows no
-- future write could reproduce, and every reader that walks the nesting would
-- recurse until its depth guard caught it.
do $$
begin
  if exists (
    with recursive nested(root_id, id, path, depth) as (
      select e.src_id, e.dst_id, array[e.src_id, e.dst_id], 1
        from public.edges e
        join public.entities d on d.id = e.dst_id
       where e.type = 'contains' and d.kind = 'collection'
      union all
      select n.root_id, e.dst_id, n.path || e.dst_id, n.depth + 1
        from public.edges e
        join nested n on e.src_id = n.id
       where e.type = 'contains'
         and not e.dst_id = any(n.path)
         and n.depth < 256
    )
    select 1 from nested where id = root_id
  ) then
    raise exception 'cannot make `contains` acyclic: a collection nesting cycle already exists';
  end if;
end
$$;

update public.edge_types
   set acyclic = true,
       description = 'Curated membership; props.position orders it. Nesting is acyclic'
 where type = 'contains';

-- -----------------------------------------------------------------------------
-- 2. Ordered membership reads.
-- -----------------------------------------------------------------------------

-- `(src_id, position, dst_id)`: the leading column narrows to one collection,
-- the second gives the curated order without a sort, and the third is the
-- keyset tiebreaker every paged read needs when two items share a position.
create index if not exists edges_contains_position_idx
  on public.edges(src_id, ((props ->> 'position')::double precision), dst_id)
  where type = 'contains';

-- -----------------------------------------------------------------------------
-- 3. Removing an item.
-- -----------------------------------------------------------------------------

-- The pair-addressed mirror of `set_collection_item`. Removing an item that is
-- not in the collection SUCCEEDS and reports `removed:false` rather than
-- raising: the caller's intent is "this entity should not be in this list",
-- and that intent is already satisfied. A retry after a dropped response, or
-- two people clicking remove on the same row, must not become an error — and
-- because the second call does no work, it also records no activity, so an
-- untouched collection does not accumulate `unlinked` noise.
create or replace function public.unset_collection_item(
  p_collection_id uuid, p_entity_id uuid,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  collection public.entities;
  actor uuid;
  edge public.edges;
  activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.delete');
  if replay is not null then return replay; end if;
  collection := internal.live_entity(p_collection_id, 'collection');
  perform internal.require_space_member(collection.space_id);
  actor := internal.resolve_actor(p_actor_id, collection.space_id);
  perform internal.bind_actor(actor);

  select * into edge from public.edges
   where src_id = p_collection_id and dst_id = p_entity_id and type = 'contains';

  if edge.id is null then
    -- Already absent. Touch nothing, and say so in the result so a caller that
    -- cares (an undo builder deciding whether it has an inverse to offer) can
    -- tell a real removal from a no-op.
    return internal.ledger_record(p_client_mutation_id, 'edges.delete',
             internal.command_result(null, null, null, array[p_collection_id])
             || jsonb_build_object('removed', false));
  end if;

  delete from public.edges where id = edge.id;
  activity_id := internal.record_activity(collection.space_id, p_collection_id, actor, 'unlinked',
                   edge.id, jsonb_build_object('type', 'contains', 'dstId', p_entity_id));
  return internal.ledger_record(p_client_mutation_id, 'edges.delete',
           internal.command_result(null, null, activity_id, array[p_collection_id, p_entity_id])
           || jsonb_build_object('removed', true));
end
$$;

revoke all on function public.unset_collection_item(uuid, uuid, uuid, text) from public;
grant execute on function public.unset_collection_item(uuid, uuid, uuid, text) to tm8_app;

reset role;
