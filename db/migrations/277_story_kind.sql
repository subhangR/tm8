-- =============================================================================
-- 277 — `story`, the narrative container kind (task 01a0fbf9, "Story as an
-- Entity", 2026-10-02).
--
-- DRAFT FROM A DESIGN SESSION. Subhang ruled on 2026-10-02 that the shape is
-- designed first and built after; this file is the opening draft parked for
-- the session that builds it, and every ruling below is a PROPOSAL until the
-- design doc on the task settles it.
--
-- WHAT A STORY IS. A higher-level entity that gathers everything that happens
-- in one line of work — tasks, docs, drawings, artifacts, files, chats,
-- sessions, teammates, members, collections, graphs, anything — and reads the
-- lot back as ONE thing with a premise, a stage and a progress figure. It is a
-- place to keep different ideas apart: each story is its own idea, and the
-- rows it tracks are the evidence of that idea moving.
--
-- D1: a story is a FIRST-CLASS CORE KIND, not a collection subtype and not a
-- graph. A `collection_type = 'story'` was the cheaper home and was declined:
-- a story carries prose (the premise) and a stage that a collection has no
-- column for, it gets its own palette row, panel, slug and list treatment,
-- and its progress is a computed fact a collection row never carries.
--
-- D2: TRACKING IS THE EXISTING `contains` EDGE (story -> any entity). The
-- edge is what every membership surface already speaks — the UI's membership
-- block and picker, `collections.addItem` / `removeItem`, the live item
-- counts on both read paths — so a story tracks a thing the moment the edge
-- exists, with no new door and no new catalog row. `story` is APPENDED to
-- `contains`'s `src_kinds` (052's lesson: never a full-array rewrite), and
-- the two membership doors below are re-issued to accept a story container.
-- A dedicated edge type would have needed its own doors and its own UI lane
-- for the same result.
--
-- D3: `stage` IS A SLUG GRAMMAR, NOT A CLOSED LIST (135's R3 lesson, 194's
-- `format`). The vocabulary — idea, shaping, building, shipped, parked — is
-- owned by the contract (`STORY_STAGES`) and drawn by the UI; a sixth stage
-- later is a contract/UI change, never a migration.
--
-- D4: PROGRESS IS COMPUTED, NEVER STORED. Both server read paths derive it
-- from the tracked rows' `status_category` (147): work = tracked rows that
-- carry a category other than `cancelled`, done = those at `done`. Storing a
-- percentage would go stale the moment a tracked task moved.
--
-- D5: single-writer, like every entity: patched under `internal.assert_version`.
--
-- NUMBERED 277, MEASURED 2026-10-02 against ALL remote refs (`git ls-tree` of
-- db/migrations over every origin branch): the union's real max is 276
-- (`276_chat_model_switchable`); the 99x files on lane branches are
-- placeholders numbered at composition and do not count. RE-MEASURE before
-- the build lands: a later main may have moved it.
--
-- SHARED-OBJECT NOTICE, same as 053/055/056/057/091/135/176/177/194/209/239/
-- 250/261: §3 REPLACES `internal.entity_content`. Its body is copied VERBATIM
-- from 261 — the latest definition in the chain — plus one `story` arm.
-- Omitting an arm is SILENT: that kind's content resolves to '{}'::jsonb
-- forever, which is why the db suite's first step asserts the content.
--
-- CRUD rides `entities.create`/`entities.patch` through the doors below —
-- the 056/091/135/194 pattern exactly: ZERO new catalog rows in this feature.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry. `entity_kinds_guard_core` (005) fires on UPDATE/DELETE only, so
--    the seed is an ordinary insert (053/056/091/135/194 precedent).
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('story', 'core', null, 'book-open')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 1b. `contains` must accept a story as a SOURCE (D2), and `attached_to` too,
--     so a story can be pinned to a channel or a task as context the way a
--     collection can. APPEND, NOT A FULL-ARRAY REWRITE (052's header records
--     why); the guard also makes both idempotent. `dst_kinds` is already '{*}'
--     on both, so a story can track anything without touching it.
-- -----------------------------------------------------------------------------
update public.edge_types
   set src_kinds = array_append(src_kinds, 'story')
 where type = 'contains'
   and not ('story' = any(src_kinds));

update public.edge_types
   set src_kinds = array_append(src_kinds, 'story')
 where type = 'attached_to'
   and not ('story' = any(src_kinds));

-- -----------------------------------------------------------------------------
-- 2. Detail table.
--
--    Column names `entity_id` and `updated_at` are load-bearing:
--    snapshot_entity_version() reads both unqualified, which is also what
--    gives a story history-as-a-unit — every saved revision of the premise
--    and stage is an `entities.versions` snapshot of this whole row.
--
--    `premise` is the idea in prose. Capped like a channel topic, not like a
--    doc body: a story's long-form thinking belongs in a tracked doc, and the
--    premise is the paragraph that says what the story is FOR.
-- -----------------------------------------------------------------------------
create table public.stories (
  entity_id  uuid primary key references public.entities(id) on delete cascade,
  -- Title lives on the DETAIL row: `public.entities` has no title column at
  -- all (091 precedent).
  title      text not null check (length(btrim(title)) between 1 and 200),
  premise    text not null default '' check (length(premise) <= 20000),
  stage      text not null default 'idea'
             check (stage ~ '^[a-z0-9][a-z0-9_-]{0,48}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger stories_validate_kind
before insert or update of entity_id on public.stories
for each row execute function internal.validate_detail_envelope('story');

create trigger stories_touch_updated_at before update on public.stories
for each row execute function internal.touch_updated_at();

create trigger stories_w2_snapshot_version after update on public.stories
for each row execute function internal.snapshot_entity_version();

alter table public.stories enable row level security;

create policy stories_select on public.stories for select to tm8_app
  using (internal.entity_readable(entity_id));

grant select on public.stories to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. Content hydration. See the SHARED-OBJECT NOTICE above. Body copied from
--    261 verbatim; the `story` arm is the only addition.
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
      -- 277: the story's premise and stage. Its tracked rows are `contains`
      -- edges, read through connections, never embedded here.
      when 'story' then select to_jsonb(st) - 'entity_id' into content from public.stories st where st.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. Create door. Ledger label `entities.create` — a story is an ordinary
--    entity to every client; only its detail row is special (091/135/194).
--
--    `p_parent_id` is the same homogeneous child door every kind takes:
--    `validate_entity_parent` requires parent.kind = child.kind, so a story's
--    parent can only be a story. Tracking a thing is the `contains` edge (D2),
--    never hierarchy.
-- -----------------------------------------------------------------------------
create or replace function public.create_story_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null,
  p_premise text default '', p_stage text default 'idea',
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
  if coalesce(p_stage, '') !~ '^[a-z0-9][a-z0-9_-]{0,48}$' then
    raise exception 'story stage must be a lowercase slug (got %)', p_stage using errcode = '22023';
  end if;
  if length(coalesce(p_premise, '')) > 20000 then
    raise exception 'story premise is too long (% chars; limit 20000)', length(p_premise) using errcode = '22023';
  end if;

  story_id := internal.create_envelope(p_space_id, 'story', actor, p_parent_id, p_position);
  insert into public.stories(entity_id, title, premise, stage)
  values (story_id, btrim(p_title), coalesce(p_premise, ''), p_stage);
  perform internal.record_initial_version(story_id, actor);

  activity_id := internal.record_activity(p_space_id, story_id, actor, 'created',
                   null, jsonb_build_object('kind', 'story'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(story_id, null, activity_id, array[story_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Update door.
--
--    `null` MERGES (the loop/graph/drawing pattern): a patch carries only the
--    members it changes — the stage stepper sends `stage` alone and must not
--    wipe the premise it did not restate. There is no explicit clear: every
--    column has a non-null default and "empty" is '', never null.
-- -----------------------------------------------------------------------------
create or replace function public.update_story_entity(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_premise text default null, p_stage text default null,
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
  if p_stage is not null and p_stage !~ '^[a-z0-9][a-z0-9_-]{0,48}$' then
    raise exception 'story stage must be a lowercase slug (got %)', p_stage using errcode = '22023';
  end if;
  if p_premise is not null and length(p_premise) > 20000 then
    raise exception 'story premise is too long (% chars; limit 20000)', length(p_premise) using errcode = '22023';
  end if;

  update public.stories
     set title      = coalesce(btrim(p_title), title),
         premise    = coalesce(p_premise, premise),
         stage      = coalesce(p_stage, stage),
         updated_at = now()
   where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'story')), array[p_entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 6. The membership doors accept a STORY container (D2).
--
--    Both bodies are 100's VERBATIM with one change each: the container is
--    fetched without a kind pin and then checked against the two kinds that
--    may own a `contains` edge. Everything 100 fixed — self-containment
--    refused, the type-guarded position cast, removal needing only the
--    container live — is kept exactly. Same signatures, so `create or
--    replace` keeps the grants and the handlers' call sites.
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

-- 008's wholesale grant was a one-time statement; functions created afterwards
-- need their own (050/053/056/091/135/194 precedent). Full argument signatures.
revoke all on function public.create_story_entity(uuid,text,uuid,text,text,uuid,double precision,text) from public;
grant execute on function public.create_story_entity(uuid,text,uuid,text,text,uuid,double precision,text) to tm8_app;
revoke all on function public.update_story_entity(uuid,integer,uuid,text,text,text,text) from public;
grant execute on function public.update_story_entity(uuid,integer,uuid,text,text,text,text) to tm8_app;
-- The re-issued membership pair keeps 100's explicit privileges.
revoke all on function public.remove_collection_item(uuid,uuid,uuid,text) from public;
grant execute on function public.remove_collection_item(uuid,uuid,uuid,text) to tm8_app;
revoke all on function public.set_collection_item(uuid,uuid,double precision,uuid,text) from public;
grant execute on function public.set_collection_item(uuid,uuid,double precision,uuid,text) to tm8_app;

reset role;
