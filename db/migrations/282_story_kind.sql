-- =============================================================================
-- 282 — `story`, one line of work as an entity (task 01a0fbf9, "Story as an
-- Entity", rulings by Subhang 2026-10-02; brief doc 01a0fc6f).
--
-- A story is a title, a description and the status every kind already has
-- (152 gives every kind a workflow; the birth trigger seeds it, so this file
-- adds no status column). Things are put in BY HAND as `contains` edges from
-- the story — the story's ROOTS — and everything connected to a root FOLLOWS:
--
--   * along parent -> child (the envelope's `parent_id`), and along these
--     edge types in either direction: attached_to, tracks, working_on, about,
--     created_in, assigned_to, has_member, produces, remembers, dispatched_by;
--   * NOT along likes, stars, pulled, visible_to (reactions and access are not
--     part of the work);
--   * to depth 3 from each root, under a 500-row bound on the whole trail.
--
-- D1: THE TRAIL IS COMPUTED AT READ TIME, NEVER STORED (ruling). One function,
-- `internal.story_trail`, walks it breadth-first with a visited set per root,
-- so fan-out cannot explode the way a path-unique recursive CTE does, and
-- every level is LIMITed by the remaining budget. Materialise later only if
-- lists get slow.
--
-- D2: BOTH READ PATHS READ THE SAME FUNCTION. The facade (`entity-read.ts`)
-- and the projector (`events/projector.ts`) each select
-- `internal.story_summary(e.id)` for a story row; that is the mirror, by
-- construction rather than by comment. Progress, live sessions, pending
-- attention and last activity are never stored.
--
-- D3: SECURITY INVOKER throughout. The walk reads `entities`/`edges` as the
-- caller, so RLS decides what is in a viewer's story; the projector runs as
-- tm8_graph_owner, exactly like 252's attention_badges.
--
-- D4: MEMBERSHIP RIDES THE EXISTING DOORS. `story` is APPENDED to `contains`
-- and `attached_to` src_kinds (052's lesson: never a full-array rewrite), and
-- 100's `set_collection_item` / `remove_collection_item` are re-issued to
-- accept a story container. CRUD rides `entities.create`/`entities.patch`
-- through the doors below (056/091/135/194 posture): ZERO new catalog rows.
--
-- D5: `public.stories_containing(id)` answers the reverse question — which
-- stories is this entity in — for spawn-on-story, walking the same edge set
-- backwards (child -> parent for hierarchy) under the same bounds.
--
-- NUMBERED 282, measured 2026-10-02 against every remote ref: main tops at
-- 277, lane branches reach 281 (281_path_grants, 281_space_link_spawn).
-- RE-MEASURE at assembly.
--
-- SHARED-OBJECT NOTICE (053/…/250/261): §3 REPLACES `internal.entity_content`.
-- Its body is 261's VERBATIM plus one `story` arm. Omitting an arm is SILENT:
-- that kind's content resolves to '{}'::jsonb forever.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry, and the two edge types a story may SOURCE (append, idempotent).
--    `dst_kinds` is already '{*}' on both.
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('story', 'core', null, 'book-open')
on conflict (kind) where space_id is null do nothing;

update public.edge_types
   set src_kinds = array_append(src_kinds, 'story')
 where type = 'contains'
   and not ('story' = any(src_kinds));

update public.edge_types
   set src_kinds = array_append(src_kinds, 'story')
 where type = 'attached_to'
   and not ('story' = any(src_kinds));

-- -----------------------------------------------------------------------------
-- 2. Detail table. `entity_id` and `updated_at` are load-bearing:
--    snapshot_entity_version() reads both unqualified. Title lives on the
--    detail row (`public.entities` has no title column; 091 precedent).
-- -----------------------------------------------------------------------------
create table public.stories (
  entity_id   uuid primary key references public.entities(id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 200),
  description text not null default '' check (length(description) <= 20000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger stories_validate_kind
before insert or update of entity_id on public.stories
for each row execute function internal.validate_detail_envelope('story');

create trigger stories_touch_updated_at before update on public.stories
for each row execute function internal.touch_updated_at();

create trigger stories_w2_snapshot_version after update on public.stories
for each row execute function internal.snapshot_entity_version();

alter table public.stories enable row level security;

-- 218 §4's shape: readable when the entity is.
create policy stories_select on public.stories for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = stories.entity_id and readable_entity.deleted_at is null offset 0)));

grant select on public.stories to tm8_app;

-- 3. Content hydration. See the SHARED-OBJECT NOTICE above. Body copied from
--    261 verbatim (the latest definer on main); the `story` arm is the only
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
      -- 282: the story's title and description. Its roots are `contains`
      -- edges and its trail is computed (story_trail), never embedded here.
      when 'story' then select to_jsonb(st) - 'entity_id' into content from public.stories st where st.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;


-- -----------------------------------------------------------------------------
-- 4. Create door. Ledger label `entities.create` (091/135/194). `p_parent_id`
--    is the homogeneous child door: a story's parent can only be a story —
--    that is what makes child stories. Putting a thing IN is `contains`, never
--    hierarchy.
-- -----------------------------------------------------------------------------
create or replace function public.create_story_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null,
  p_description text default '',
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  story_id uuid;
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
    raise exception 'story title is required (1..200 chars after trim)' using errcode = '22023';
  end if;
  if length(coalesce(p_description, '')) > 20000 then
    raise exception 'story description is too long (% chars; limit 20000)', length(p_description) using errcode = '22023';
  end if;

  story_id := internal.create_envelope(p_space_id, 'story', actor, p_parent_id, p_position);
  insert into public.stories(entity_id, title, description)
  values (story_id, btrim(p_title), coalesce(p_description, ''));
  perform internal.record_initial_version(story_id, actor);

  activity_id := internal.record_activity(p_space_id, story_id, actor, 'created',
                   null, jsonb_build_object('kind', 'story'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(story_id, null, activity_id, array[story_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Update door. `null` MERGES (the loop/graph/drawing pattern): a patch
--    carries only what it changes. "Empty" is '', never null.
-- -----------------------------------------------------------------------------
create or replace function public.update_story_entity(
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
  e := internal.live_entity(p_entity_id, 'story');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  if p_title is not null and length(btrim(p_title)) not between 1 and 200 then
    raise exception 'story title must be 1..200 chars after trim' using errcode = '22023';
  end if;
  if p_description is not null and length(p_description) > 20000 then
    raise exception 'story description is too long (% chars; limit 20000)', length(p_description) using errcode = '22023';
  end if;

  update public.stories
     set title       = coalesce(btrim(p_title), title),
         description = coalesce(p_description, description),
         updated_at  = now()
   where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'story')), array[p_entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 6. The membership doors accept a STORY container (D4). Both bodies are
--    100's VERBATIM (the latest and only definer) with one change each: the
--    container is fetched without a kind pin and then checked against the two
--    kinds that may own a `contains` edge. Same signatures, so `create or
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
  if collection.kind not in ('collection', 'story') then
    raise exception 'entity % is a %, expected a collection or a story', p_collection_id, collection.kind
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
  if collection.kind not in ('collection', 'story') then
    raise exception 'entity % is a %, expected a collection or a story', p_collection_id, collection.kind
      using errcode = '22023';
  end if;
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


-- -----------------------------------------------------------------------------
-- 7. THE TRAIL (D1). Breadth-first from every root, one level at a time, with
--    a visited set keyed by (entity, root): a row reached from two roots is in
--    both roots' trails (that is what a cross-root link is), but never twice
--    in one. Each level is LIMITed by what is left of the 500-row budget, so
--    the walk is bounded no matter how wide a level fans out.
--
--    Rows: one per (entity, root). Roots are depth 0 with `via_id` = the story,
--    `edge_type` = 'contains'. `direction` is 'out' when the edge is stored
--    via -> entity, 'in' when entity -> via; hierarchy is ('parent', 'out').
--    The story itself is never in its own trail.
-- -----------------------------------------------------------------------------
create or replace function internal.story_trail(p_story_id uuid)
returns table(entity_id uuid, root_id uuid, depth integer, via_id uuid,
              edge_type text, edge_id uuid, direction text, root_position double precision)
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  followed constant text[] := array['attached_to', 'tracks', 'working_on', 'about', 'created_in',
                                    'assigned_to', 'has_member', 'produces', 'remembers', 'dispatched_by'];
  max_depth constant integer := 3;
  budget integer := 500;
  a_ids uuid[]; a_roots uuid[]; a_depth integer[]; a_via uuid[];
  a_type text[]; a_edge uuid[]; a_dir text[]; a_pos double precision[];
  f_ids uuid[]; f_roots uuid[];
  n_ids uuid[]; n_roots uuid[]; n_via uuid[]; n_type text[]; n_edge uuid[]; n_dir text[];
  lvl integer;
begin
  -- Roots: the live `contains` targets, ordered by the edge's position.
  select coalesce(array_agg(r.dst_id order by r.pos nulls last, r.dst_id), '{}'),
         coalesce(array_agg(r.edge_id order by r.pos nulls last, r.dst_id), '{}'),
         coalesce(array_agg(r.pos order by r.pos nulls last, r.dst_id), '{}')
    into a_ids, a_edge, a_pos
    from (
      select c.dst_id, c.id as edge_id,
             case when jsonb_typeof(c.props -> 'position') = 'number'
                  then (c.props ->> 'position')::double precision end as pos
        from public.edges c
        join public.entities re on re.id = c.dst_id and re.deleted_at is null
       where c.src_id = p_story_id and c.type = 'contains' and c.dst_id <> p_story_id
       order by pos nulls last, c.dst_id
       limit budget
    ) r;
  a_roots := a_ids;
  a_depth := array_fill(0, array[cardinality(a_ids)]);
  a_via := array_fill(p_story_id, array[cardinality(a_ids)]);
  a_type := array_fill('contains'::text, array[cardinality(a_ids)]);
  a_dir := array_fill('out'::text, array[cardinality(a_ids)]);
  budget := budget - cardinality(a_ids);
  f_ids := a_ids; f_roots := a_roots;

  lvl := 1;
  while lvl <= max_depth and budget > 0 and cardinality(f_ids) > 0 loop
    select coalesce(array_agg(s.id), '{}'), coalesce(array_agg(s.root), '{}'), coalesce(array_agg(s.via), '{}'),
           coalesce(array_agg(s.etype), '{}'), coalesce(array_agg(s.eid), '{}'), coalesce(array_agg(s.dir), '{}')
      into n_ids, n_roots, n_via, n_type, n_edge, n_dir
      from (
        select distinct on (nb.id, f.root) nb.id, f.root, f.via, nb.etype, nb.eid, nb.dir
          from unnest(f_ids, f_roots) as f(via, root)
          cross join lateral (
            select ch.id, 'parent'::text as etype, null::uuid as eid, 'out'::text as dir
              from public.entities ch
             where ch.parent_id = f.via and ch.deleted_at is null
            union all
            select g.dst_id, g.type, g.id, 'out'
              from public.edges g where g.src_id = f.via and g.type = any(followed)
            union all
            select g.src_id, g.type, g.id, 'in'
              from public.edges g where g.dst_id = f.via and g.type = any(followed)
          ) nb
          join public.entities ne on ne.id = nb.id and ne.deleted_at is null
         where nb.id <> p_story_id
           and not exists (
             select 1 from unnest(a_ids, a_roots) as v(id, root)
              where v.id = nb.id and v.root = f.root)
         order by nb.id, f.root, nb.etype, nb.eid
         limit budget
      ) s;
    exit when cardinality(n_ids) = 0;
    a_ids := a_ids || n_ids; a_roots := a_roots || n_roots; a_via := a_via || n_via;
    a_type := a_type || n_type; a_edge := a_edge || n_edge; a_dir := a_dir || n_dir;
    a_depth := a_depth || array_fill(lvl, array[cardinality(n_ids)]);
    budget := budget - cardinality(n_ids);
    f_ids := n_ids; f_roots := n_roots;
    lvl := lvl + 1;
  end loop;

  return query
    select t.id, t.root, t.d, t.via, t.etype, t.eid, t.dir, rp.pos
      from unnest(a_ids, a_roots, a_depth, a_via, a_type, a_edge, a_dir)
             as t(id, root, d, via, etype, eid, dir)
      left join unnest(a_ids[1:cardinality(a_pos)], a_pos) as rp(id, pos) on rp.id = t.root;
end
$$;

comment on function internal.story_trail(uuid) is
  '282: the story''s roots (contains targets) and everything that follows from '
  'them — parent->child and the ten followed edge types, depth 3, 500 rows. '
  'Computed at read time, security invoker: RLS decides what a viewer sees.';

-- A progress tally over a set of entity ids (contract `StoryProgress`).
-- work = category not cancelled (and not null); done = category done;
-- blocked = work, not done, with an unresolved hard depends_on. The bands are
-- disjoint: done + inProgress + toDo + blocked = work.
create or replace function internal.story_tally(p_ids uuid[])
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'work',       count(*) filter (where e.status_category in ('to_do', 'in_progress', 'done')),
    'done',       count(*) filter (where e.status_category = 'done'),
    'inProgress', count(*) filter (where e.status_category = 'in_progress' and not b.blocked),
    'toDo',       count(*) filter (where e.status_category = 'to_do' and not b.blocked),
    'blocked',    count(*) filter (where e.status_category in ('to_do', 'in_progress') and b.blocked),
    'cancelled',  count(*) filter (where e.status_category = 'cancelled'))
    from public.entities e
    cross join lateral (select exists (
      select 1 from public.edges dep
       where dep.src_id = e.id and dep.type = 'depends_on'
         and coalesce((dep.props ->> 'hard')::boolean, true)
         and not internal.is_resolved(dep.dst_id)) as blocked) b
   where e.id = any(coalesce(p_ids, '{}'::uuid[])) and e.deleted_at is null
$$;

-- -----------------------------------------------------------------------------
-- 8. THE SUMMARY (D2) — contract `StoryState`, read by BOTH twins.
--
--    `rollup` is the task tally over the UNION of this story's tasks and every
--    descendant story's (same-kind parent_id, 4 levels, 50 stories): a task in
--    two stories of one family counts once.
-- -----------------------------------------------------------------------------
create or replace function internal.story_summary(p_story_id uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  trail_rows integer;
  root_count integer;
  item_ids uuid[];
  task_ids uuid[];
  family_task_ids uuid[];
  live_sessions integer;
  pending integer;
  last_at timestamptz;
  child_count integer;
begin
  select count(*), count(*) filter (where t.depth = 0), coalesce(array_agg(distinct t.entity_id), '{}')
    into trail_rows, root_count, item_ids
    from internal.story_trail(p_story_id) t;

  select coalesce(array_agg(e.id), '{}') into task_ids
    from public.entities e where e.id = any(item_ids) and e.kind = 'task';

  with recursive kids(id, lvl) as (
    select c.id, 1 from public.entities c
     where c.parent_id = p_story_id and c.kind = 'story' and c.deleted_at is null
    union all
    select c.id, k.lvl + 1 from kids k
      join public.entities c on c.parent_id = k.id and c.kind = 'story' and c.deleted_at is null
     where k.lvl < 4
  )
  select coalesce(array_agg(distinct e.id), '{}') into family_task_ids
    from (select id from kids limit 50) k
    cross join lateral internal.story_trail(k.id) t
    join public.entities e on e.id = t.entity_id and e.kind = 'task';
  family_task_ids := array(select distinct x from unnest(family_task_ids || task_ids) x);

  select count(*) into live_sessions
    from public.work_sessions ws
   where ws.entity_id = any(item_ids) and ws.status in ('spawning', 'running', 'idle');

  select count(*) into pending
    from public.attention_requests ar
   where ar.entity_id = any(item_ids || p_story_id) and ar.status in ('open', 'acknowledged');

  select max(e.activity_at) into last_at
    from public.entities e where e.id = any(item_ids || p_story_id);

  select count(*) into child_count
    from public.entities c
   where c.parent_id = p_story_id and c.kind = 'story' and c.deleted_at is null;

  return jsonb_build_object(
    'kind', 'story',
    'rootCount', root_count,
    'itemCount', cardinality(item_ids),
    'truncated', trail_rows >= 500,
    'progress', internal.story_tally(item_ids),
    'taskProgress', internal.story_tally(task_ids),
    'rollup', internal.story_tally(family_task_ids),
    'liveSessionCount', live_sessions,
    'pendingAttentionCount', pending,
    'lastActivityAt', last_at,
    'childStoryCount', child_count);
end
$$;

-- -----------------------------------------------------------------------------
-- 9. WHICH STORIES IS THIS IN (D5). The trail walked backwards from the
--    entity: the same ten edge types either way, and hierarchy child ->
--    parent. Every reached row that is a `contains` target of a live story
--    names that story; `depth` is how far the entity sits from that root.
-- -----------------------------------------------------------------------------
create or replace function public.stories_containing(p_entity_id uuid)
returns table(story_id uuid, root_id uuid, depth integer)
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  followed constant text[] := array['attached_to', 'tracks', 'working_on', 'about', 'created_in',
                                    'assigned_to', 'has_member', 'produces', 'remembers', 'dispatched_by'];
  budget integer := 500;
  a_ids uuid[] := array[p_entity_id];
  a_depth integer[] := array[0];
  f_ids uuid[] := array[p_entity_id];
  n_ids uuid[];
  lvl integer := 1;
begin
  while lvl <= 3 and budget > 0 and cardinality(f_ids) > 0 loop
    select coalesce(array_agg(s.id), '{}') into n_ids
      from (
        select distinct nb.id
          from unnest(f_ids) as f(id)
          cross join lateral (
            select p.parent_id as id from public.entities p
             where p.id = f.id and p.parent_id is not null
            union all
            select g.src_id from public.edges g where g.dst_id = f.id and g.type = any(followed)
            union all
            select g.dst_id from public.edges g where g.src_id = f.id and g.type = any(followed)
          ) nb
          join public.entities ne on ne.id = nb.id and ne.deleted_at is null
         where not (nb.id = any(a_ids))
         limit budget
      ) s;
    exit when cardinality(n_ids) = 0;
    a_ids := a_ids || n_ids;
    a_depth := a_depth || array_fill(lvl, array[cardinality(n_ids)]);
    budget := budget - cardinality(n_ids);
    f_ids := n_ids;
    lvl := lvl + 1;
  end loop;

  return query
    select c.src_id, c.dst_id, min(r.d)::integer
      from unnest(a_ids, a_depth) as r(id, d)
      join public.edges c on c.dst_id = r.id and c.type = 'contains'
      join public.entities st on st.id = c.src_id and st.kind = 'story' and st.deleted_at is null
     group by c.src_id, c.dst_id
     order by min(r.d), c.src_id;
end
$$;

-- 008's wholesale grant was a one-time statement; functions created afterwards
-- need their own. Full argument signatures.
revoke all on function public.create_story_entity(uuid,text,uuid,text,uuid,double precision,text) from public;
grant execute on function public.create_story_entity(uuid,text,uuid,text,uuid,double precision,text) to tm8_app;
revoke all on function public.update_story_entity(uuid,integer,uuid,text,text,text) from public;
grant execute on function public.update_story_entity(uuid,integer,uuid,text,text,text) to tm8_app;
-- The re-issued membership pair keeps 100's explicit privileges.
revoke all on function public.remove_collection_item(uuid,uuid,uuid,text) from public;
grant execute on function public.remove_collection_item(uuid,uuid,uuid,text) to tm8_app;
revoke all on function public.set_collection_item(uuid,uuid,double precision,uuid,text) from public;
grant execute on function public.set_collection_item(uuid,uuid,double precision,uuid,text) to tm8_app;
-- The read functions are invoker-rights: granting them gives neither role a
-- row it could not already select (252's attention_badges posture).
revoke all on function internal.story_trail(uuid) from public;
grant execute on function internal.story_trail(uuid) to tm8_app, tm8_graph_owner;
revoke all on function internal.story_tally(uuid[]) from public;
grant execute on function internal.story_tally(uuid[]) to tm8_app, tm8_graph_owner;
revoke all on function internal.story_summary(uuid) from public;
grant execute on function internal.story_summary(uuid) to tm8_app, tm8_graph_owner;
revoke all on function public.stories_containing(uuid) from public;
grant execute on function public.stories_containing(uuid) to tm8_app, tm8_graph_owner;

reset role;
