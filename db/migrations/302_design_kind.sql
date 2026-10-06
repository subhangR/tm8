-- =============================================================================
-- 302 — `design`, an ordered set of PAGES (Craft → Designs, change list items
-- 1 and 15; task 01a1118f, discussion 01a1115b, Subhang 2026-10-06).
--
-- A design is a title and a description. Its PAGES are any entities — a
-- graph, a doc, an artifact, a drawing, another design — held as ordered
-- `contains` edges from the design (`props.position`). There is no per-page
-- wrapper entity: the page IS the doc or the graph, and opens normally
-- anywhere else. The story precedent (283) throughout:
--
-- D1: MEMBERSHIP RIDES THE EXISTING DOORS. `design` is APPENDED to `contains`
-- src_kinds (052's lesson: never a full-array rewrite), and 283's
-- `set_collection_item` / `remove_collection_item` are re-issued to accept a
-- design container. Positions are `props.position`, appended after the
-- current maximum when none is given; re-adding a page re-positions it, which
-- is how a page is reordered. CRUD rides `entities.create` / `entities.patch`
-- through the doors below (056/091/135/194/283 posture): ZERO new catalog rows.
--
-- D2: NO CYCLES. A design may hold another design as a page (nesting), but
-- never itself or any design above it. `internal.assert_design_acyclic` is
-- the one rule; `set_collection_item` calls it for a clear early refusal, and
-- a trigger on `edges` calls it for every `contains` row a design sources, so
-- a generic `edges.create` cannot go round the door. Writers that nest
-- designs serialise on a per-space advisory lock, so two concurrent adds
-- (A into B, B into A) cannot both pass.
--
-- D3: BOTH READ PATHS READ THE SAME FUNCTION. The facade (`entity-read.ts`)
-- and the projector (`events/projector.ts`) each select
-- `internal.design_summary(e.id)` for a design row (the contract's
-- `DesignState`: page count and page kinds in order). The ordered pages themselves load on a detail
-- read only.
--
-- D4 (item 15): EXISTING BLUEPRINTS GET A DESIGN. Every live `graph` that is
-- a page of no design gets one design with the same title and that graph as
-- its only page, so the Designs home is never empty for an existing space.
-- Authored by the graph's own creator; no activity row (a migration is not
-- an actor's act), so it does not show in anyone's feed as news.
--
-- NUMBERED 302, measured 2026-10-06 against every remote ref: main tops at
-- 301, no lane branch holds 302+. RE-MEASURE at assembly.
--
-- SHARED-OBJECT NOTICE (053/…/261/283/284/287/296): §3 REPLACES
-- `internal.entity_content`. Its body is 296's VERBATIM plus one `design`
-- arm. Omitting an arm is SILENT: that kind's content resolves to '{}'.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry, and the one edge type a design may SOURCE (append, idempotent).
--    `dst_kinds` is already '{*}'.
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('design', 'core', null, 'layers')
on conflict (kind) where space_id is null do nothing;

update public.edge_types
   set src_kinds = array_append(src_kinds, 'design')
 where type = 'contains'
   and not ('design' = any(src_kinds));

-- -----------------------------------------------------------------------------
-- 2. Detail table. `entity_id` and `updated_at` are load-bearing:
--    snapshot_entity_version() reads both unqualified. Title lives on the
--    detail row (`public.entities` has no title column; 091 precedent).
-- -----------------------------------------------------------------------------
create table public.designs (
  entity_id   uuid primary key references public.entities(id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 200),
  description text not null default '' check (length(description) <= 20000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger designs_validate_kind
before insert or update of entity_id on public.designs
for each row execute function internal.validate_detail_envelope('design');

create trigger designs_touch_updated_at before update on public.designs
for each row execute function internal.touch_updated_at();

create trigger designs_w2_snapshot_version after update on public.designs
for each row execute function internal.snapshot_entity_version();

alter table public.designs enable row level security;

-- 218 §4's shape: readable when the entity is.
create policy designs_select on public.designs for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = designs.entity_id and readable_entity.deleted_at is null offset 0)));

grant select on public.designs to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. Content hydration. See the SHARED-OBJECT NOTICE above. Body copied from
--    296 verbatim (the latest definer on main); the `design` arm is the only
--    addition.
-- -----------------------------------------------------------------------------
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then return null; end if;
  if e.kind like 'c:%' then
    select jsonb_build_object('title', c.title, 'fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case e.kind
      when 'task' then select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'voice_channel' then select to_jsonb(v) - 'entity_id' into content from public.voice_channels v where v.entity_id = target;
      when 'artifact' then select to_jsonb(a) - 'entity_id' into content from public.artifacts a where a.entity_id = target;
      when 'memory' then select to_jsonb(m) - 'entity_id' into content from public.memories m where m.entity_id = target;
      when 'worktree' then select to_jsonb(w) - 'entity_id' into content from public.worktrees w where w.entity_id = target;
      when 'loop' then select to_jsonb(l) - 'entity_id' into content from public.loops l where l.entity_id = target;
      when 'graph' then select to_jsonb(g) - 'entity_id' into content from public.graphs g where g.entity_id = target;
      when 'chat' then select to_jsonb(c) - 'entity_id' - 'cwd' - 'native_session_id' - 'client_mutation_id'
                       into content from public.chats c where c.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      when 'container' then select to_jsonb(c) - 'entity_id' - 'runtime_ref' - 'host_spec'
                              into content from public.containers c where c.entity_id = target;
      when 'drawing' then select to_jsonb(d) - 'entity_id' into content from public.drawings d where d.entity_id = target;
      -- `-` binds tighter than `||`: the entity_id is dropped, THEN the
      -- ordered sections and questions are merged in.
      when 'form' then select to_jsonb(fm) - 'entity_id'
                              || jsonb_build_object('sections', internal.form_sections_json(target),
                                                    'questions', internal.form_questions_json(target))
                         into content from public.forms fm where fm.entity_id = target;
      -- An allow-list, never to_jsonb(sc): the row holds the sealed secret,
      -- the hint and the vendor login (§3a).
      when 'credential' then select to_jsonb(cc) - 'entity_id' into content from public.credential_cards cc where cc.entity_id = target;
      -- 250 (W6): the shared link's metadata. `space_links` holds no secret; the
      -- sealed per-member token is `space_link_tokens` (251) and has no arm.
      when 'space_link' then select to_jsonb(sl) - 'entity_id' into content from public.space_links sl where sl.entity_id = target;
      -- W8: the server's metadata. `servers` holds no secret; the sealed
      -- per-member gate session is `server_gate_tokens` and has no arm.
      when 'server' then select to_jsonb(sv) - 'entity_id' into content from public.servers sv where sv.entity_id = target;
      -- 283: the story's title and description. Its roots are `contains`
      -- edges and its trail is computed (story_trail), never embedded here.
      when 'story' then select to_jsonb(st) - 'entity_id' into content from public.stories st where st.entity_id = target;
      -- 284: a space style's detail row. The row holds nothing secret (the
      -- document, tags and attribution), so the house form applies; the
      -- contract's camelCase shape is the read facade's job (`contentOf`).
      when 'style' then select to_jsonb(sty) - 'entity_id' into content from public.styles sty where sty.entity_id = target;
      when 'op_request' then select to_jsonb(opr) - 'entity_id' - 'requester_identity_id' - 'decided_identity_id'
        into content from public.op_requests opr where opr.entity_id = target;
      when 'mcp_server' then select to_jsonb(m) - 'entity_id' into content from public.mcp_servers m where m.entity_id=target;
      -- 302: the design's title and description. Its pages are `contains`
      -- edges ordered by props.position, never embedded here.
      when 'design' then select to_jsonb(dsg) - 'entity_id' into content from public.designs dsg where dsg.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. Create door. Ledger label `entities.create` (091/135/194/283).
--    `p_parent_id` is the envelope's homogeneous hierarchy and is passed
--    through as every door does; NESTING a design is a page (`contains`),
--    never hierarchy.
-- -----------------------------------------------------------------------------
create or replace function public.create_design_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null,
  p_description text default '',
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  design_id uuid;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  if length(btrim(coalesce(p_title, ''))) not between 1 and 200 then
    raise exception 'design title is required (1..200 chars after trim)' using errcode = '22023';
  end if;
  if length(coalesce(p_description, '')) > 20000 then
    raise exception 'design description is too long (% chars; limit 20000)', length(p_description) using errcode = '22023';
  end if;

  design_id := internal.create_envelope(p_space_id, 'design', actor, p_parent_id, p_position);
  insert into public.designs(entity_id, title, description)
  values (design_id, btrim(p_title), coalesce(p_description, ''));
  perform internal.record_initial_version(design_id, actor);

  activity_id := internal.record_activity(p_space_id, design_id, actor, 'created',
                   null, jsonb_build_object('kind', 'design'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(design_id, null, activity_id, array[design_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Update door. `null` MERGES (the loop/graph/drawing/story pattern): a
--    patch carries only what it changes. "Empty" is '', never null. Pages are
--    not patched here: they are `contains` edges (collection add/remove).
-- -----------------------------------------------------------------------------
create or replace function public.update_design_entity(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_description text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_entity_id, 'design');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  if p_title is not null and length(btrim(p_title)) not between 1 and 200 then
    raise exception 'design title must be 1..200 chars after trim' using errcode = '22023';
  end if;
  if p_description is not null and length(p_description) > 20000 then
    raise exception 'design description is too long (% chars; limit 20000)', length(p_description) using errcode = '22023';
  end if;

  update public.designs
     set title       = coalesce(btrim(p_title), title),
         description = coalesce(p_description, description),
         updated_at  = now()
   where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'design')), array[p_entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 6. THE CYCLE GUARD (D2). Putting `p_item` into design `p_design` closes a
--    loop iff `p_design` is reachable from `p_item` along design -> page
--    `contains` edges — that is, `p_item` is the design itself or a design
--    somewhere above it. Deleted designs' edges count: a restore must not
--    bring a loop back. `union` (not `union all`) makes the walk terminate on
--    any graph, even one an older build let loop. Definer-side (it is called
--    from the doors and from a trigger that may fire under tm8_app), so RLS
--    cannot hide a link in the loop from the check.
-- -----------------------------------------------------------------------------
create or replace function internal.assert_design_acyclic(p_design uuid, p_item uuid)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  design_space uuid;
begin
  if p_item = p_design then
    raise exception 'a design cannot contain itself' using errcode = '22023';
  end if;
  if not exists (select 1 from public.entities where id = p_item and kind = 'design') then
    return;
  end if;
  select space_id into design_space from public.entities where id = p_design;
  -- Serialise every design-into-design write in the space: two concurrent
  -- adds (A into B, B into A) each see no loop alone.
  perform pg_advisory_xact_lock(hashtextextended('tm8.design_nesting:' || coalesce(design_space::text, ''), 0));
  if exists (
    with recursive below(id) as (
      select p_item
      union
      select c.dst_id
        from below b
        join public.edges c on c.src_id = b.id and c.type = 'contains'
        join public.entities d on d.id = c.dst_id and d.kind = 'design'
    )
    select 1 from below where id = p_design
  ) then
    raise exception 'a design cannot contain a design it is already inside (that would make a loop)'
      using errcode = '22023';
  end if;
end
$$;

create or replace function internal.design_contains_guard()
returns trigger language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if exists (select 1 from public.entities where id = new.src_id and kind = 'design') then
    perform internal.assert_design_acyclic(new.src_id, new.dst_id);
  end if;
  return new;
end
$$;

create trigger edges_design_contains_acyclic
before insert or update of src_id, dst_id, type on public.edges
for each row when (new.type = 'contains')
execute function internal.design_contains_guard();

-- -----------------------------------------------------------------------------
-- 7. The membership doors accept a DESIGN container (D1). Both bodies are
--    283's VERBATIM (the latest definer) with these changes only: the kind
--    check names three kinds, and `set_collection_item` runs the cycle guard
--    for a design container before it writes. Same signatures, so `create or
--    replace` keeps the handlers' call sites.
-- -----------------------------------------------------------------------------
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
  collection := internal.live_entity(p_collection_id);
  if collection.kind not in ('collection', 'story', 'design') then
    raise exception 'entity % is a %, expected a collection, a story or a design', p_collection_id, collection.kind
      using errcode = '22023';
  end if;
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
  collection := internal.live_entity(p_collection_id);
  if collection.kind not in ('collection', 'story', 'design') then
    raise exception 'entity % is a %, expected a collection, a story or a design', p_collection_id, collection.kind
      using errcode = '22023';
  end if;
  perform internal.require_space_member(collection.space_id);
  actor := internal.resolve_actor(p_actor_id, collection.space_id);
  perform internal.bind_actor(actor);
  perform internal.live_entity(p_entity_id);
  -- 302 (D2): a design may not hold itself or a design above it.
  if collection.kind = 'design' then
    perform internal.assert_design_acyclic(p_collection_id, p_entity_id);
  end if;

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

-- -----------------------------------------------------------------------------
-- 8. THE SUMMARY (D3) — contract `DesignState`, read by BOTH twins: the
--    live pages' count and their kinds IN PAGE ORDER (so a Designs card draws
--    its page icons without a detail read), under the caller's RLS (security
--    invoker, 252's attention_badges posture).
-- -----------------------------------------------------------------------------
create or replace function internal.design_summary(p_design_id uuid)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'kind', 'design',
    'pageCount', count(*)::integer,
    'pageKinds', coalesce(jsonb_agg(p.kind order by p.pos nulls last, p.created_at, p.id), '[]'::jsonb))
    from (
      select pe.kind, c.created_at, c.id,
             case when jsonb_typeof(c.props -> 'position') = 'number'
                  then (c.props ->> 'position')::double precision end as pos
        from public.edges c
        join public.entities pe on pe.id = c.dst_id and pe.deleted_at is null
       where c.src_id = p_design_id and c.type = 'contains'
    ) p
$$;

-- -----------------------------------------------------------------------------
-- 9. BACKFILL (D4, change list item 15): one design per live graph that is a
--    page of no design — same title, that graph its only page at position 1.
--    A function rather than a bare DO block so it is idempotent by
--    construction (a graph already in a design is skipped) and testable; it
--    runs once below. Returns how many designs it made. Owner-only: no grant.
-- -----------------------------------------------------------------------------
create or replace function internal.backfill_graph_designs()
returns integer language plpgsql set search_path = public, internal, pg_temp as $$
declare
  g record;
  design_id uuid;
  made integer := 0;
begin
  for g in
    select e.id, e.space_id, e.created_by, gr.title
      from public.entities e
      join public.graphs gr on gr.entity_id = e.id
     where e.kind = 'graph' and e.deleted_at is null
       and not exists (
         select 1 from public.edges c
           join public.entities d on d.id = c.src_id and d.kind = 'design'
          where c.dst_id = e.id and c.type = 'contains')
     order by e.created_at, e.id
  loop
    design_id := internal.create_envelope(g.space_id, 'design', g.created_by, null, null);
    insert into public.designs(entity_id, title, description)
    values (design_id, g.title, '');
    perform internal.record_initial_version(design_id, g.created_by);
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (g.space_id, design_id, g.id, 'contains', jsonb_build_object('position', 1), g.created_by);
    made := made + 1;
  end loop;
  return made;
end
$$;

revoke all on function internal.backfill_graph_designs() from public;

select internal.backfill_graph_designs();

-- 008's wholesale grant was a one-time statement; functions created afterwards
-- need their own. Full argument signatures.
revoke all on function public.create_design_entity(uuid,text,uuid,text,uuid,double precision,text) from public;
grant execute on function public.create_design_entity(uuid,text,uuid,text,uuid,double precision,text) to tm8_app;
revoke all on function public.update_design_entity(uuid,integer,uuid,text,text,text) from public;
grant execute on function public.update_design_entity(uuid,integer,uuid,text,text,text) to tm8_app;
-- The re-issued membership pair keeps 100's explicit privileges.
revoke all on function public.remove_collection_item(uuid,uuid,uuid,text) from public;
grant execute on function public.remove_collection_item(uuid,uuid,uuid,text) to tm8_app;
revoke all on function public.set_collection_item(uuid,uuid,double precision,uuid,text) from public;
grant execute on function public.set_collection_item(uuid,uuid,double precision,uuid,text) to tm8_app;
-- The guard runs inside the definer doors and from the trigger, which may
-- fire under tm8_app.
revoke all on function internal.assert_design_acyclic(uuid,uuid) from public;
grant execute on function internal.assert_design_acyclic(uuid,uuid) to tm8_app, tm8_graph_owner;
revoke all on function internal.design_contains_guard() from public;
grant execute on function internal.design_contains_guard() to tm8_app, tm8_graph_owner;
-- Invoker-rights read: granting it gives neither role a row it could not
-- already select.
revoke all on function internal.design_summary(uuid) from public;
grant execute on function internal.design_summary(uuid) to tm8_app, tm8_graph_owner;

reset role;

-- Never-analyzed tables are estimated at 10 pages (225); 229's precedent.
analyze public.designs;
