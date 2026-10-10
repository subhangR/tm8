-- =============================================================================
-- 316 — RENAME the `design` kind to `craft` (task 01a1255e, owner decision doc
-- 01a1255d §1, Kalai 2026-10-10: "Design" appears nowhere in the product).
--
-- 304 shipped the kind as `design`. This migration moves every piece of it:
--   * the registry row (entity_kinds) and `contains` src_kinds;
--   * every `entities` row of kind design (the capture trigger emits one
--     entity.upsert per row, so live clients see the new kind);
--   * the detail table `designs` -> `crafts`, its constraints, index, policy
--     and triggers (validate_kind is re-created: its argument is the kind);
--   * the doors and helpers: create_/update_design_entity ->
--     create_/update_craft_entity, assert_design_acyclic ->
--     assert_craft_acyclic, design_contains_guard -> craft_contains_guard,
--     design_summary -> craft_summary (bodies are 304's with the kind renamed);
--     backfill_graph_designs is dropped (one-time, already ran);
--   * re-issued shared objects: entity_content (296+304 verbatim, `craft` arm),
--     set_collection_item / remove_collection_item (304 verbatim, `craft`);
--   * stored kind strings: cross_space_refs.target_kind, workflows.kind,
--     workspace_drafts.kind, workspace tab state, menu kind leaves, saved
--     view filters, activity summaries, the command ledger's stored results
--     (replays), and the
--     space event log since 304 landed (2026-10-06);
--   * 315_craft_workspaces' one old-name check (craft_workspace_save's
--     `e.kind in ('craft', 'design')` -> `e.kind = 'craft'`), so that nothing
--     in the DB says design after 316.
--
-- INPUT ALIAS: `design` stays accepted as a kind INPUT until 2027-01-08 in the
-- contract (`normalizeKindAlias`), never here: the DB only ever holds `craft`.
--
-- REVERSIBLE: db/rollback/316_design_to_craft.down.sql is this file with
-- design<->craft swapped, up to a hand-written NOT SWAPPED tail
-- (packages/server/test/db/craft-kind.pg.test.ts checks that it is, and runs
-- down -> up on a populated database).
--
-- SHARED-OBJECT NOTICE: §4 REPLACES `internal.entity_content` (latest definer
-- was 304) and §6 the membership pair (latest definer was 304).
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry and edge types. A core registry row is immutable by trigger
--    (005: "promotion is a migration") — this is that migration.
-- -----------------------------------------------------------------------------
alter table public.entity_kinds disable trigger entity_kinds_guard_core;
update public.entity_kinds set kind = 'craft' where kind = 'design' and space_id is null;
alter table public.entity_kinds enable trigger entity_kinds_guard_core;

update public.edge_types
   set src_kinds = array_replace(src_kinds, 'design', 'craft'),
       dst_kinds = array_replace(dst_kinds, 'design', 'craft')
 where 'design' = any(src_kinds) or 'design' = any(dst_kinds);

-- -----------------------------------------------------------------------------
-- 2. Retire the old objects. The edge trigger goes first: nothing may run the
--    old guard against a half-renamed kind.
-- -----------------------------------------------------------------------------
drop trigger if exists edges_design_contains_acyclic on public.edges;
drop function if exists internal.design_contains_guard();
drop function if exists internal.assert_design_acyclic(uuid, uuid);
drop function if exists internal.design_summary(uuid);
drop function if exists public.create_design_entity(uuid, text, uuid, text, uuid, double precision, text);
drop function if exists public.update_design_entity(uuid, integer, uuid, text, text, text);
drop function if exists internal.backfill_graph_designs();

-- -----------------------------------------------------------------------------
-- 3. The rows and the detail table.
-- -----------------------------------------------------------------------------
update public.entities set kind = 'craft' where kind = 'design';

alter table public.designs rename to crafts;
alter table public.crafts rename constraint designs_pkey to crafts_pkey;
alter table public.crafts rename constraint designs_entity_id_fkey to crafts_entity_id_fkey;
alter table public.crafts rename constraint designs_title_check to crafts_title_check;
alter table public.crafts rename constraint designs_description_check to crafts_description_check;

drop trigger designs_validate_kind on public.crafts;
create trigger crafts_validate_kind
before insert or update of entity_id on public.crafts
for each row execute function internal.validate_detail_envelope('craft');
alter trigger designs_touch_updated_at on public.crafts rename to crafts_touch_updated_at;
alter trigger designs_w2_snapshot_version on public.crafts rename to crafts_w2_snapshot_version;

drop policy designs_select on public.crafts;
create policy crafts_select on public.crafts for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = crafts.entity_id and readable_entity.deleted_at is null offset 0)));

-- -----------------------------------------------------------------------------
-- 4-8. 304's bodies with the kind renamed.
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
      -- 304/316: the craft's title and description. Its pages are `contains`
      -- edges ordered by props.position, never embedded here.
      when 'craft' then select to_jsonb(dsg) - 'entity_id' into content from public.crafts dsg where dsg.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;


-- -----------------------------------------------------------------------------
-- 4. Create door. Ledger label `entities.create` (091/135/194/283).
--    `p_parent_id` is the envelope's homogeneous hierarchy and is passed
--    through as every door does; NESTING a craft is a page (`contains`),
--    never hierarchy.
-- -----------------------------------------------------------------------------
create or replace function public.create_craft_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null,
  p_description text default '',
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  craft_id uuid;
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
    raise exception 'craft title is required (1..200 chars after trim)' using errcode = '22023';
  end if;
  if length(coalesce(p_description, '')) > 20000 then
    raise exception 'craft description is too long (% chars; limit 20000)', length(p_description) using errcode = '22023';
  end if;

  craft_id := internal.create_envelope(p_space_id, 'craft', actor, p_parent_id, p_position);
  insert into public.crafts(entity_id, title, description)
  values (craft_id, btrim(p_title), coalesce(p_description, ''));
  perform internal.record_initial_version(craft_id, actor);

  activity_id := internal.record_activity(p_space_id, craft_id, actor, 'created',
                   null, jsonb_build_object('kind', 'craft'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(craft_id, null, activity_id, array[craft_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Update door. `null` MERGES (the loop/graph/drawing/story pattern): a
--    patch carries only what it changes. "Empty" is '', never null. Pages are
--    not patched here: they are `contains` edges (collection add/remove).
-- -----------------------------------------------------------------------------
create or replace function public.update_craft_entity(
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
  e := internal.live_entity(p_entity_id, 'craft');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  if p_title is not null and length(btrim(p_title)) not between 1 and 200 then
    raise exception 'craft title must be 1..200 chars after trim' using errcode = '22023';
  end if;
  if p_description is not null and length(p_description) > 20000 then
    raise exception 'craft description is too long (% chars; limit 20000)', length(p_description) using errcode = '22023';
  end if;

  update public.crafts
     set title       = coalesce(btrim(p_title), title),
         description = coalesce(p_description, description),
         updated_at  = now()
   where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'craft')), array[p_entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 6. THE CYCLE GUARD (D2). Putting `p_item` into craft `p_craft` closes a
--    loop iff `p_craft` is reachable from `p_item` along craft -> page
--    `contains` edges — that is, `p_item` is the craft itself or a craft
--    somewhere above it. Deleted crafts' edges count: a restore must not
--    bring a loop back. `union` (not `union all`) makes the walk terminate on
--    any graph, even one an older build let loop. Definer-side (it is called
--    from the doors and from a trigger that may fire under tm8_app), so RLS
--    cannot hide a link in the loop from the check.
-- -----------------------------------------------------------------------------
create or replace function internal.assert_craft_acyclic(p_craft uuid, p_item uuid)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  craft_space uuid;
begin
  if p_item = p_craft then
    raise exception 'a craft cannot contain itself' using errcode = '22023';
  end if;
  if not exists (select 1 from public.entities where id = p_item and kind = 'craft') then
    return;
  end if;
  select space_id into craft_space from public.entities where id = p_craft;
  -- Serialise every craft-into-craft write in the space: two concurrent
  -- adds (A into B, B into A) each see no loop alone.
  perform pg_advisory_xact_lock(hashtextextended('tm8.craft_nesting:' || coalesce(craft_space::text, ''), 0));
  if exists (
    with recursive below(id) as (
      select p_item
      union
      select c.dst_id
        from below b
        join public.edges c on c.src_id = b.id and c.type = 'contains'
        join public.entities d on d.id = c.dst_id and d.kind = 'craft'
    )
    select 1 from below where id = p_craft
  ) then
    raise exception 'a craft cannot contain a craft it is already inside (that would make a loop)'
      using errcode = '22023';
  end if;
end
$$;

create or replace function internal.craft_contains_guard()
returns trigger language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if exists (select 1 from public.entities where id = new.src_id and kind = 'craft') then
    perform internal.assert_craft_acyclic(new.src_id, new.dst_id);
  end if;
  return new;
end
$$;

create trigger edges_craft_contains_acyclic
before insert or update of src_id, dst_id, type on public.edges
for each row when (new.type = 'contains')
execute function internal.craft_contains_guard();

-- -----------------------------------------------------------------------------
-- 7. The membership doors accept a CRAFT container (D1). Both bodies are
--    283's VERBATIM (the latest definer) with these changes only: the kind
--    check names three kinds, and `set_collection_item` runs the cycle guard
--    for a craft container before it writes. Same signatures, so `create or
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
  if collection.kind not in ('collection', 'story', 'craft') then
    raise exception 'entity % is a %, expected a collection, a story or a craft', p_collection_id, collection.kind
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
  if collection.kind not in ('collection', 'story', 'craft') then
    raise exception 'entity % is a %, expected a collection, a story or a craft', p_collection_id, collection.kind
      using errcode = '22023';
  end if;
  perform internal.require_space_member(collection.space_id);
  actor := internal.resolve_actor(p_actor_id, collection.space_id);
  perform internal.bind_actor(actor);
  perform internal.live_entity(p_entity_id);
  -- 304 (D2): a craft may not hold itself or a craft above it.
  if collection.kind = 'craft' then
    perform internal.assert_craft_acyclic(p_collection_id, p_entity_id);
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
-- 8. THE SUMMARY (D3) — contract `CraftState`, read by BOTH twins: the
--    live pages' count and their kinds IN PAGE ORDER (so a Crafts card draws
--    its page icons without a detail read), under the caller's RLS (security
--    invoker, 252's attention_badges posture).
-- -----------------------------------------------------------------------------
create or replace function internal.craft_summary(p_craft_id uuid)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'kind', 'craft',
    'pageCount', count(*)::integer,
    'pageKinds', coalesce(jsonb_agg(p.kind order by p.pos nulls last, p.created_at, p.id), '[]'::jsonb))
    from (
      select pe.kind, c.created_at, c.id,
             case when jsonb_typeof(c.props -> 'position') = 'number'
                  then (c.props ->> 'position')::double precision end as pos
        from public.edges c
        join public.entities pe on pe.id = c.dst_id and pe.deleted_at is null
       where c.src_id = p_craft_id and c.type = 'contains'
    ) p
$$;


-- -----------------------------------------------------------------------------
-- 9. Stored kind strings outside the envelope.
-- -----------------------------------------------------------------------------
update public.cross_space_refs set target_kind = 'craft' where target_kind = 'design';
update public.workflows set kind = 'craft' where kind = 'design';
update public.activity
   set summary = jsonb_set(summary, '{kind}', '"craft"')
 where summary ->> 'kind' = 'design';
-- The replayable event log: only events since 304 can name the kind.
update public.workspace_events
   set payload = replace(payload::text, '"kind": "design"', '"kind": "craft"')::jsonb
 where occurred_at >= timestamptz '2026-10-05'
   and payload::text like '%"kind": "design"%';

-- A replayed command (24h ledger TTL) answers with the stored result.
update public.command_ledger
   set result = replace(result::text, '"kind": "design"', '"kind": "craft"')::jsonb
 where result::text like '%"kind": "design"%';

-- -----------------------------------------------------------------------------
-- 10. Privileges (full signatures; 304's posture).
-- -----------------------------------------------------------------------------
revoke all on function public.create_craft_entity(uuid,text,uuid,text,uuid,double precision,text) from public;
grant execute on function public.create_craft_entity(uuid,text,uuid,text,uuid,double precision,text) to tm8_app;
revoke all on function public.update_craft_entity(uuid,integer,uuid,text,text,text) from public;
grant execute on function public.update_craft_entity(uuid,integer,uuid,text,text,text) to tm8_app;
-- The re-issued membership pair keeps 100's explicit privileges.
revoke all on function public.remove_collection_item(uuid,uuid,uuid,text) from public;
grant execute on function public.remove_collection_item(uuid,uuid,uuid,text) to tm8_app;
revoke all on function public.set_collection_item(uuid,uuid,double precision,uuid,text) from public;
grant execute on function public.set_collection_item(uuid,uuid,double precision,uuid,text) to tm8_app;
-- The guard runs inside the definer doors and from the trigger, which may
-- fire under tm8_app.
revoke all on function internal.assert_craft_acyclic(uuid,uuid) from public;
grant execute on function internal.assert_craft_acyclic(uuid,uuid) to tm8_app, tm8_graph_owner;
revoke all on function internal.craft_contains_guard() from public;
grant execute on function internal.craft_contains_guard() to tm8_app, tm8_graph_owner;
-- Invoker-rights read: granting it gives neither role a row it could not
-- already select.
revoke all on function internal.craft_summary(uuid) from public;
grant execute on function internal.craft_summary(uuid) to tm8_app, tm8_graph_owner;

reset role;

-- 305/311's tables belong to the migration runner, not tm8_graph_owner.
update public.workspace_drafts set kind = 'craft' where kind = 'design';
-- Workspace tab state is opaque jsonb of {kind, id} refs; jsonb's text form
-- always prints `"kind": "design"` with exactly one space.
update public.workspaces
   set state = replace(state::text, '"kind": "design"', '"kind": "craft"')::jsonb
 where state::text like '%"kind": "design"%';
set role tm8_graph_owner;
-- Menus name kinds as {"type":"kind","ref":...}; jsonb prints keys shortest
-- first, so the leaf's text form is fixed. Saved views filter by kind.
update public.space_menu_configs
   set payload = replace(payload::text, '{"ref": "design", "type": "kind"}', '{"ref": "craft", "type": "kind"}')::jsonb
 where payload::text like '%{"ref": "design", "type": "kind"}%';
update public.saved_views
   set query = replace(query::text, '"kind": "design"', '"kind": "craft"')::jsonb
 where query::text like '%"kind": "design"%';
reset role;

analyze public.crafts;

-- =============================================================================
-- NOT SWAPPED: the rollback carries its own inverse of everything below.
-- 315_craft_workspaces (task 01a1255e-1431) accepts the old kind name in one
-- place, public.craft_workspace_save's `e.kind in ('craft', 'design')`. After
-- this rename only `craft` exists, so the check narrows in place. create or
-- replace keeps the runner's ownership and 315's grants. It is a no-op on a
-- database without 315.
-- =============================================================================
do $rename$
declare
  fn  regprocedure := to_regprocedure('public.craft_workspace_save(uuid,uuid,bigint,bigint,jsonb,uuid,boolean)');
  src text;
begin
  if fn is null then
    return;
  end if;
  src := pg_get_functiondef(fn);
  if position($k$e.kind in ('craft', 'design')$k$ in src) = 0 then
    raise exception '316: craft_workspace_save lost the kind check this migration narrows';
  end if;
  src := replace(src, $k$e.kind in ('craft', 'design')$k$, $k$e.kind = 'craft'$k$);
  if src ilike '%design%' then
    raise exception '316: craft_workspace_save still names design';
  end if;
  execute src;
end
$rename$;
