-- Shared placement lives only in entities(parent_id, position). Serializing by
-- space covers concurrent inserts AND opposing reparent operations (cycles).
-- Never take an entity row lock before this lock in either placement RPC.
create or replace function internal.lock_entity_placement(p_space_id uuid) returns void
language sql volatile set search_path = public, internal, pg_temp as $$
  select pg_advisory_xact_lock(hashtextextended('entity-placement:' || p_space_id::text, 0))
$$;

-- A cursor epoch, not a second source of placement. Inserts at the head do not
-- invalidate keysets; moves/rebalancing do. Clients restart a stale page chain.
create table public.entity_placement_revisions (
  space_id uuid primary key references public.spaces(id) on delete cascade,
  revision bigint not null default 1
);
alter table public.entity_placement_revisions enable row level security;
create policy placement_revision_read on public.entity_placement_revisions for select
  using (internal.is_space_member(space_id));
grant select on public.entity_placement_revisions to tm8_app;

create or replace function internal.entity_placement_changed() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if new.position is distinct from old.position or new.parent_id is distinct from old.parent_id then
    insert into public.entity_placement_revisions(space_id) values (new.space_id)
    on conflict (space_id) do update set revision = entity_placement_revisions.revision + 1;
  end if;
  return new;
end
$$;
create trigger entities_placement_revision after update of position, parent_id on public.entities
for each row execute function internal.entity_placement_changed();

-- Rare rank maintenance preserves (position,id) order. Normal updates publish
-- the existing entity events, so every authorized client receives the ranks.
create or replace function internal.rebalance_entity_positions(p_space_id uuid, p_kind text, p_parent_id uuid)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
begin
  perform internal.lock_entity_placement(p_space_id);
  with ranked as (
    select id, (row_number() over (order by position, id) * 1024)::double precision as rank
      from public.entities where space_id = p_space_id and kind = p_kind
        and parent_id is not distinct from p_parent_id and deleted_at is null
  )
  update public.entities e set position = ranked.rank from ranked
    where e.id = ranked.id and e.position is distinct from ranked.rank;
end
$$;

create or replace function internal.assign_entity_position() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare first_rank double precision;
begin
  perform internal.lock_entity_placement(new.space_id);
  if new.position is null then
    select min(position) into first_rank from public.entities
      where space_id = new.space_id and kind = new.kind
        and parent_id is not distinct from new.parent_id and deleted_at is null and id <> new.id;
    if first_rank is not null and (first_rank - 1024 = first_rank or abs(first_rank) > 1e15) then
      perform internal.rebalance_entity_positions(new.space_id, new.kind, new.parent_id);
      select min(position) into first_rank from public.entities
        where space_id = new.space_id and kind = new.kind
          and parent_id is not distinct from new.parent_id and deleted_at is null and id <> new.id;
    end if;
    new.position := coalesce(first_rank, 1024) - 1024;
  end if;
  if not (new.position > '-Infinity'::double precision and new.position < 'Infinity'::double precision) then
    raise exception 'position must be finite' using errcode = '22023';
  end if;
  return new;
end
$$;

-- This door changes placement only. In particular sessions keep their execution
-- lifecycle, sharing, authorship and runtime fields; membership authorizes the
-- shared list edit, just as it authorizes a display-title edit.
create or replace function public.move_entity(
  p_entity_id uuid, p_parent_id uuid, p_position double precision, p_expected_version integer,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; activity_id uuid; affected uuid[];
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.move');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_entity_id);
  perform internal.require_space_member(e.space_id);
  if e.kind in ('member','message','project','interaction_profile','credential','server','space_link','container','style','op_request') then
    raise exception 'entity placement is command-owned for kind %', e.kind using errcode = '42501';
  end if;
  perform internal.lock_entity_placement(e.space_id);
  select * into e from public.entities where id = p_entity_id and deleted_at is null for update;
  if e.id is null then raise exception 'entity not found' using errcode = 'P0002'; end if;
  if p_parent_id is not null then perform internal.live_entity(p_parent_id, e.kind); end if;
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  update public.entities set parent_id = p_parent_id, position = p_position, version = version + 1,
    updated_at = now(), activity_at = now() where id = p_entity_id;
  insert into public.entity_versions(entity_id,version,snapshot,changed_by)
    select p_entity_id,current.version,internal.entity_snapshot(p_entity_id),actor
      from public.entities current where current.id=p_entity_id on conflict(entity_id,version) do nothing;
  affected := array_remove(array[p_entity_id, e.parent_id, p_parent_id], null);
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'moved', null,
    jsonb_build_object('fromParentId',e.parent_id,'toParentId',p_parent_id));
  return internal.ledger_record(p_client_mutation_id, 'entities.move',
    internal.command_result(p_entity_id, null, activity_id, affected,
      internal.issue_undo_token(e.space_id, actor, 'Undo move', 'entities.move',
        jsonb_build_object('entityId',p_entity_id,'parentId',e.parent_id,'position',e.position,
                           'expectedVersion',e.version + 1))));
end
$$;

-- Relative placement is resolved against the full sibling set while locked,
-- never against a browser page. NULL target + inside means first at the root.
create or replace function public.move_entity_relative(
  p_entity_id uuid, p_target_id uuid, p_relation text, p_expected_version integer,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare e public.entities; target public.entities; parent uuid; lo double precision;
  hi double precision; rank double precision; replay jsonb; attempt integer;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.move');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_entity_id);
  perform internal.require_space_member(e.space_id);
  perform internal.lock_entity_placement(e.space_id);
  -- Validate before maintenance: a forbidden/stale operation changes nothing.
  perform internal.assert_version(p_entity_id, p_expected_version);
  if p_relation not in ('before','after','inside') or p_relation is null
      or (p_target_id is null and p_relation <> 'inside') or p_target_id = p_entity_id then
    raise exception 'invalid placement target or relation' using errcode = '22023';
  end if;
  if p_target_id is not null then
    target := internal.live_entity(p_target_id, e.kind);
    if target.space_id <> e.space_id then raise exception 'target must be in the same space' using errcode = '23514'; end if;
  end if;
  parent := case when p_relation = 'inside' then p_target_id else target.parent_id end;
  for attempt in 1..2 loop
    lo := null; hi := null;
    if p_relation = 'inside' then
      select min(position) into hi from public.entities where space_id = e.space_id and kind = e.kind
        and parent_id is not distinct from parent and deleted_at is null and id <> e.id;
    else
      target := internal.live_entity(p_target_id, e.kind);
      if p_relation = 'before' then
        hi := target.position;
        select position into lo from public.entities where space_id = e.space_id and kind = e.kind
          and parent_id is not distinct from parent and deleted_at is null and id <> e.id
          and (position,id) < (target.position,target.id) order by position desc,id desc limit 1;
      else
        lo := target.position;
        select position into hi from public.entities where space_id = e.space_id and kind = e.kind
          and parent_id is not distinct from parent and deleted_at is null and id <> e.id
          and (position,id) > (target.position,target.id) order by position,id limit 1;
      end if;
    end if;
    rank := case when lo is null then coalesce(hi,1024) - 1024 when hi is null then lo + 1024 else lo / 2 + hi / 2 end;
    if (lo is null or rank > lo) and (hi is null or rank < hi) and abs(rank) < 1e15 then exit; end if;
    perform internal.rebalance_entity_positions(e.space_id, e.kind, parent);
  end loop;
  return public.move_entity(p_entity_id, parent, rank, p_expected_version, p_actor_id, p_client_mutation_id);
end
$$;
revoke all on function public.move_entity_relative(uuid,uuid,text,integer,uuid,text) from public;
grant execute on function public.move_entity_relative(uuid,uuid,text,integer,uuid,text) to tm8_app;
revoke all on function internal.lock_entity_placement(uuid), internal.rebalance_entity_positions(uuid,text,uuid),
  internal.entity_placement_changed() from public;

-- Existing RPCs are owned by the graph role. Newly created helpers must share
-- that owner: CREATE OR REPLACE preserves an old function's owner.
alter function internal.lock_entity_placement(uuid) owner to tm8_graph_owner;
alter function internal.rebalance_entity_positions(uuid,text,uuid) owner to tm8_graph_owner;
alter function internal.entity_placement_changed() owner to tm8_graph_owner;
alter function public.move_entity_relative(uuid,uuid,text,integer,uuid,text) owner to tm8_graph_owner;
alter table public.entity_placement_revisions owner to tm8_graph_owner;
