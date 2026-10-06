-- =============================================================================
-- 303 — Canonical edges, part A (P0b, task 01a10c66; Design Rules 01a10c5d §2.3;
-- inventory and owner review: doc 01a111b8-74a1).
--
-- One edge type per meaning. This file changes no edge ROW. Rewriting legacy
-- rows is a semantic migration that waits for the owner's review of the
-- classified lists (§4 of the inventory doc), and it is logged by the table
-- created here. What this file does:
--
--   1. internal.edge_migration_log + internal.revert_edge_migration(batch):
--      every later rewrite or delete of an edge row records the old and new row
--      and the rule that moved it, so a batch can be replayed backwards.
--   2. The registry says what each type MEANS, in one plain line, and which
--      types are deprecated. `edge_types.replaced_by` names the canonical type;
--      a deprecated type refuses new rows unless a logged migration is running
--      (`tm8.edge_migration` GUC). `dispatched_by` is deprecated now (0 rows;
--      a spawned session's parentId already names its spawner).
--   3. `follows_up` is registered: a new task (or session) continues the work of
--      an earlier one of the SAME kind (task→task, work_session→work_session),
--      acyclic. Not followed by the story walk (owner review Q5).
--   4. `produces` also targets file and drawing (a task's deliverable).
--   5. The story walk's followed list lives in ONE function,
--      internal.story_followed_edge_types(), read by story_trail and
--      stories_containing (it was two hand-copied constants). dispatched_by
--      leaves it. A deleted story walks and counts nothing (story_trail,
--      story_work); its `contains` rows are kept so a restore is lossless.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The migration log.
-- -----------------------------------------------------------------------------
create table if not exists internal.edge_migration_log (
  id          bigint generated always as identity primary key,
  batch       text not null,
  rule        text not null,
  action      text not null check (action in ('rewrite', 'delete', 'insert')),
  edge_id     uuid not null,
  old_row     jsonb,
  new_row     jsonb,
  confirmed   text not null default 'rule' check (confirmed in ('rule', 'owner')),
  reverted_at timestamptz,
  at          timestamptz not null default now(),
  check ((action = 'insert') = (old_row is null)),
  check ((action = 'delete') = (new_row is null))
);
create index if not exists edge_migration_log_batch_idx on internal.edge_migration_log(batch, id);

comment on table internal.edge_migration_log is
  '303: one row per edge a semantic edge migration rewrote, deleted or inserted, '
  'with the full old and new public.edges rows and the rule that moved it. '
  'internal.revert_edge_migration(batch) replays a batch backwards.';

-- Replays one batch backwards, newest first. Runs with the migration GUC on so
-- deprecated types can be restored. Returns how many log rows it reverted.
create or replace function internal.revert_edge_migration(p_batch text)
returns integer
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  r internal.edge_migration_log;
  n integer := 0;
begin
  perform set_config('tm8.edge_migration', p_batch, true);
  for r in select * from internal.edge_migration_log
            where batch = p_batch and reverted_at is null
            order by id desc
  loop
    if r.action = 'insert' then
      delete from public.edges where id = r.edge_id;
    elsif r.action = 'delete' then
      insert into public.edges
        select * from jsonb_populate_record(null::public.edges, r.old_row)
      on conflict (id) do nothing;
    else
      update public.edges e
         set type = o.type, src_id = o.src_id, dst_id = o.dst_id, props = o.props
        from jsonb_populate_record(null::public.edges, r.old_row) o
       where e.id = r.edge_id;
    end if;
    update internal.edge_migration_log set reverted_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end
$$;
revoke all on function internal.revert_edge_migration(text) from public;

-- -----------------------------------------------------------------------------
-- 2. Deprecation, and refusing new rows of a deprecated type.
-- -----------------------------------------------------------------------------
alter table public.edge_types add column if not exists replaced_by text;

comment on column public.edge_types.replaced_by is
  '303: set on a DEPRECATED type — what replaces it: a canonical edge type, or '
  '`parentId` for dispatched_by. A deprecated type refuses new rows.';

create or replace function internal.refuse_deprecated_edge() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  replacement text;
  deprecated boolean;
begin
  select true, t.replaced_by into deprecated, replacement
    from public.edge_types t where t.type = new.type and t.replaced_by is not null;
  if deprecated and coalesce(current_setting('tm8.edge_migration', true), '') = '' then
    raise exception 'edge type % is deprecated; use %', new.type, replacement
      using errcode = '23514',
            hint = 'tm8 edge type list shows the canonical types and their meanings';
  end if;
  return new;
end
$$;
drop trigger if exists edges_refuse_deprecated on public.edges;
create trigger edges_refuse_deprecated before insert on public.edges
for each row execute function internal.refuse_deprecated_edge();

-- -----------------------------------------------------------------------------
-- 3. follows_up, and same-kind endpoints for it.
-- -----------------------------------------------------------------------------
insert into public.edge_types(type, src_kinds, dst_kinds, description, acyclic, props_schema)
values ('follows_up', array['task', 'work_session'], array['task', 'work_session'],
        'placeholder', true,
        '{"type":"object","properties":{"note":{"type":"string"}},"additionalProperties":false}'::jsonb)
on conflict (type) do nothing;

create or replace function internal.guard_follows_up_same_kind() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if (select kind from public.entities where id = new.src_id)
     is distinct from (select kind from public.entities where id = new.dst_id) then
    raise exception 'follows_up joins two tasks or two work sessions, never one of each'
      using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists edges_follows_up_same_kind on public.edges;
create trigger edges_follows_up_same_kind before insert or update on public.edges
for each row when (new.type = 'follows_up')
execute function internal.guard_follows_up_same_kind();

-- -----------------------------------------------------------------------------
-- 4. produces: a task's deliverable may be a file or a drawing too.
-- -----------------------------------------------------------------------------
update public.edge_types
   set dst_kinds = array['artifact', 'doc', 'drawing', 'file', 'memory']
 where type = 'produces';

-- -----------------------------------------------------------------------------
-- 5. One plain line per type: what it MEANS. `tm8 edge type list` prints it.
--    Canonical (Design Rules §2.3) lines lead with the meaning's name.
-- -----------------------------------------------------------------------------
update public.edge_types t
   set description = d.description
  from (values
    ('assigned_to',      'Responsible for: that member or teammate is responsible for this task.'),
    ('working_on',       'Actively working on: this work session is working on that task now. A claim; it ends (endedAt) when the work stops.'),
    ('participates_in',  'Session''s teammate: this teammate is the one responsible for that work session.'),
    ('authored_from',    'Made during: this entity was recorded by the server as made in that work session or chat.'),
    ('produces',         'Deliverable: this task produced that doc, artifact, file, drawing or memory as its output.'),
    ('attached_to',      'Context or input: this entity gives context to that one (a reference, an input, a message attachment). Not a task''s output: use produces.'),
    ('tracks',           'Ships as code: this task is implemented by that pull request or commit.'),
    ('depends_on',       'Prerequisite: this task cannot be finished before that one.'),
    ('follows_up',       'Follow-up: this task (or session) continues the work of that earlier task (or session).'),
    ('completed_by',     'Completed by: that member or teammate completed this task.'),
    ('contains',         'Story root or collection item: this story or collection holds that entity directly. props.position orders it.'),
    ('relates_to',       'See also: a deliberately vague link. Story walks and maps ignore it; prefer a specific edge.'),
    ('derived_from',     'Launch task: the system created this task to launch or continue that entity (a story or session).'),
    ('created_in',       'Made during (unverified): a client claimed this entity was made in that work session. authored_from is the verified, canonical form.'),
    ('dispatched_by',    'Deprecated: a spawned session''s parentId names the session that spawned it.'),
    ('anchored_to',      'System: this message hangs on that entity (projection of the message''s anchor).'),
    ('messaged',         'System: this work session sent a message to that work session.'),
    ('about',            'Subject: this chat or memory is about that entity.'),
    ('consumes',         'Input (Craft): this task reads that doc, artifact or memory.'),
    ('has_member',       'Channel membership: this channel has that member or teammate.'),
    ('remembers',        'Memory set: that memory belongs to this holder''s working set.'),
    ('based_on',         'This memory depends on that entity at a pinned version.'),
    ('supersedes',       'This memory replaces that earlier memory.'),
    ('disputes',         'This message or memory disputes that entity, with evidence.'),
    ('verifies',         'This message or memory verifies that entity, with evidence.'),
    ('copy_of',          'This entity is a copy of that one.'),
    ('equips',           'This task, teammate or session is equipped with that skill, spell or MCP server.'),
    ('triggered_by',     'This task or session exists because that loop fired.'),
    ('member_of',        'This teammate is also affiliated with that team.'),
    ('defaults_to_profile', 'This teammate''s future sessions default to that interaction profile.'),
    ('selected_profile', 'System: the interaction profile this work session was pinned to at spawn.'),
    ('shared_into',      'System: this entity was handed off into that work session.'),
    ('runs_on',          'System: this work session runs on that credential.'),
    ('runs_in',          'This work session''s processes run inside that container.'),
    ('drives',           'This work session uses that container through tools.'),
    ('controls',         'This person may drive that container''s input (takeover or exec grant).'),
    ('mounts',           'This container mounts that project''s working directory.'),
    ('snapshot_of',      'This container was forked from that snapshot or template.'),
    ('in_project',       'This entity belongs to that project.'),
    ('in_worktree',      'This entity is associated with that worktree.'),
    ('pulled',           'This member or teammate adopted that entity locally.'),
    ('likes',            'Reaction: this member likes that entity.'),
    ('dislikes',         'Reaction: this member dislikes that entity.'),
    ('stars',            'Reaction: this member bookmarked that entity.'),
    ('visible_to',       'Restricted-visibility grant to that member or teammate (inert in v1).'),
    ('approval_requested_from', 'Approval of this task is requested from that member or teammate (inert in v1).'),
    ('approved_by',      'That member or teammate gave a verdict on this task (inert in v1).')
  ) as d(type, description)
 where t.type = d.type;

update public.edge_types set replaced_by = 'parentId' where type = 'dispatched_by';

-- -----------------------------------------------------------------------------
-- 6. The story walk: one followed list, and deleted stories walk nothing.
-- -----------------------------------------------------------------------------
create or replace function internal.story_followed_edge_types()
returns text[]
language sql immutable set search_path = public, internal, pg_temp as $$
  -- Followed in BOTH directions from a root, to depth 3 (283 D1). Hierarchy
  -- (parent -> child) is walked separately. Not followed, on purpose:
  -- relates_to (see-also), depends_on (drawn, not walked), participates_in and
  -- authored_from (a session's messages would flood the 500-row budget),
  -- follows_up (owner review Q5), reactions and access edges.
  -- MIRROR: STORY_FOLLOWED_EDGE_TYPES in packages/contract/src/story.ts
  -- (db/test/canonical_edges.test.mjs asserts they agree).
  select array['attached_to', 'tracks', 'working_on', 'about', 'created_in',
               'assigned_to', 'has_member', 'produces', 'remembers']::text[]
$$;

-- 283's story_trail, with the shared list and the deleted-story guard.
create or replace function internal.story_trail(p_story_id uuid)
returns table(entity_id uuid, root_id uuid, depth integer, via_id uuid,
              edge_type text, edge_id uuid, direction text, root_position double precision)
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  -- 303: one list, shared with stories_containing and mirrored by
  -- STORY_FOLLOWED_EDGE_TYPES in packages/contract/src/story.ts.
  followed constant text[] := internal.story_followed_edge_types();
  -- D1b: a row of one of these kinds is a LEAF — reached, never walked out of.
  leaf_kinds constant text[] := array['team_member', 'member', 'project', 'interaction_profile',
                                      'skill', 'story'];
  max_depth constant integer := 3;
  budget integer := 500;
  a_ids uuid[]; a_roots uuid[]; a_depth integer[]; a_via uuid[];
  a_type text[]; a_edge uuid[]; a_dir text[]; a_pos double precision[];
  f_ids uuid[]; f_roots uuid[];
  n_ids uuid[]; n_roots uuid[]; n_via uuid[]; n_type text[]; n_edge uuid[]; n_dir text[];
  lvl integer;
begin
  -- 303: a deleted story contains nothing. Soft delete leaves its `contains`
  -- edges in place (restore must be lossless), so every reader filters here.
  if exists (select 1 from public.entities s where s.id = p_story_id and s.deleted_at is not null) then
    return;
  end if;
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
          join public.entities fe on fe.id = f.via and not (fe.kind = any(leaf_kinds))
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

create or replace function public.stories_containing(p_entity_id uuid)
returns table(story_id uuid, root_id uuid, depth integer)
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  -- 303: one list, shared with stories_containing and mirrored by
  -- STORY_FOLLOWED_EDGE_TYPES in packages/contract/src/story.ts.
  followed constant text[] := internal.story_followed_edge_types();
  -- D1b in reverse: an intermediate row of a leaf kind is never walked
  -- through (the forward walk could not have left it). The start may be one.
  leaf_kinds constant text[] := array['team_member', 'member', 'project', 'interaction_profile',
                                      'skill', 'story'];
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
          join public.entities fe on fe.id = f.id and (lvl = 1 or not (fe.kind = any(leaf_kinds)))
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

create or replace function internal.story_work(p_story_id uuid)
returns table(entity_id uuid, kind text, root_id uuid, depth integer)
language sql stable set search_path = public, internal, pg_temp as $$
  with recursive roots as (
    select c.dst_id as id
      from public.edges c
      join public.entities re on re.id = c.dst_id and re.deleted_at is null
     where c.src_id = p_story_id and c.type = 'contains' and c.dst_id <> p_story_id
       -- 303: a deleted story's `contains` edges stay (lossless restore) but count for nothing.
       and not exists (select 1 from public.entities s where s.id = p_story_id and s.deleted_at is not null)
  ),
  tree(id, kind, root, depth, path) as (
    select e.id, e.kind, e.id, 0, array[e.id]
      from roots r join public.entities e on e.id = r.id
    union all
    select ch.id, ch.kind, t.root, t.depth + 1, t.path || ch.id
      from tree t
      join public.entities ch on ch.parent_id = t.id and ch.deleted_at is null
     where t.kind <> 'story'            -- a story is a leaf: one item
       and t.depth < 32                 -- entity_tree's cap for --subtree
       and ch.id <> p_story_id
       and not ch.id = any(t.path)
  )
  select t.id, t.kind, t.root, t.depth from tree t
  union all
  select c.id, c.kind, null::uuid, 1
    from public.entities c
   where c.parent_id = p_story_id and c.kind = 'story' and c.deleted_at is null
     and not exists (select 1 from public.entities s where s.id = p_story_id and s.deleted_at is not null)
$$;

comment on function internal.story_trail(uuid) is
  '303: the story''s roots (live contains targets) and everything that follows '
  'from them — parent->child and internal.story_followed_edge_types(), depth 3, '
  '500 rows. A deleted story has no trail.';

-- Functions created after 008 need their own grants (full signatures).
revoke all on function internal.story_followed_edge_types() from public;
grant execute on function internal.story_followed_edge_types() to tm8_app, tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 7. A session's teammate is `participates_in` (teammate -> session), never the
--    legacy relates_to session -> teammate duplicate. Spawn writes it directly,
--    and every reader that found the teammate through relates_to moves to it.
--    The bodies are the current definitions with only those lines changed.
--    execution_resume also reads relates_to, but P0a's 302 redefines it, so it
--    moves there (or in P0b's follow-up stacked on 302), not here.
-- -----------------------------------------------------------------------------

-- execution_spawn: spawn writes participates_in directly
CREATE OR REPLACE FUNCTION public.execution_spawn(p_space_id uuid, p_team_member_id uuid, p_task_ids uuid[] DEFAULT '{}'::uuid[], p_project_id uuid DEFAULT NULL::uuid, p_workdir_mode text DEFAULT 'project'::text, p_workdir_path text DEFAULT NULL::text, p_base_ref text DEFAULT NULL::text, p_mode text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_agent_tool text DEFAULT NULL::text, p_title text DEFAULT NULL::text, p_node_id text DEFAULT NULL::text, p_confirm_untrusted boolean DEFAULT false, p_session_cap integer DEFAULT 8, p_actor_id uuid DEFAULT NULL::uuid, p_client_mutation_id text DEFAULT NULL::text, p_parent_session_id uuid DEFAULT NULL::uuid, p_new_task_title text DEFAULT NULL::text, p_story_id uuid DEFAULT NULL::uuid, p_source_work_session_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  replay jsonb;
  actor uuid;
  persona public.entities;
  project public.projects;
  parent_session public.entities;
  session_id uuid;
  task_id uuid;
  patches uuid[];
  started_status text;
  created_task_id uuid;
  task_ids uuid[];
  new_title text;
  projection_id uuid;
  result jsonb;
  context_story_id uuid;
  story public.entities;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.spawn');
  if replay is not null then
    return replay || jsonb_build_object('__tm8_replayed', true);
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  if p_story_id is not null then
    if cardinality(coalesce(p_task_ids,'{}'::uuid[])) > 0 or p_new_task_title is not null then
      raise exception 'storyId is exclusive with taskIds and newTask'
        using errcode='22023',detail='story_spawn_conflict';
    end if;
    story := internal.live_entity(p_story_id,'story');
    if story.space_id <> p_space_id or not internal.entity_readable(story.id) then
      raise exception 'story must be readable in the spawn Space' using errcode='42501';
    end if;
    context_story_id := story.id;
  elsif p_source_work_session_id is not null and p_source_work_session_id=p_parent_session_id then
    -- Inheritance is only from the bearer-bound parent, checked against live
    -- graph actor/Space facts. A caller-selected hierarchy parent is not proof.
    select c.src_id into context_story_id
      from public.entities parent
      join public.work_sessions ws on ws.entity_id=parent.id
      join public.edges c on c.dst_id=parent.id and c.type='contains'
      join public.entities st on st.id=c.src_id and st.kind='story'
      where parent.id=p_source_work_session_id and parent.space_id=p_space_id
        and parent.deleted_at is null and st.deleted_at is null and st.space_id=p_space_id
        and internal.entity_readable(st.id)
        and exists(select 1 from public.edges participant where participant.src_id=actor
          and participant.dst_id=parent.id and participant.type='participates_in')
      order by c.created_at,c.id limit 1;
  end if;

  persona := internal.live_entity(p_team_member_id, 'team_member');
  if persona.space_id <> p_space_id then
    raise exception 'persona belongs to another space' using errcode = '22023';
  end if;
  if not internal.can_act_as(p_team_member_id, p_space_id) then
    raise exception 'not permitted to spawn this persona' using errcode = '42501';
  end if;

  if p_parent_session_id is not null then
    -- 176: a chat is as legitimate a coordinator as a session (ruling R-B), so
    -- the kind is checked here rather than pinned in the lookup. Anything else
    -- is still refused — this is a two-kind allowance, not an open parent.
    parent_session := internal.live_entity(p_parent_session_id);
    if parent_session.kind not in ('work_session', 'chat') then
      raise exception 'a spawn parent must be a work_session or a chat (got %)',
        parent_session.kind using errcode = '22023';
    end if;
    if parent_session.space_id <> p_space_id then
      raise exception 'parent session belongs to another space' using errcode = '22023';
    end if;
  end if;

  if internal.live_work_session_count(null) >= greatest(coalesce(p_session_cap, 8), 1) then
    raise exception 'session concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_session_cap,
                                  'live', internal.live_work_session_count(null))::text;
  end if;

  if p_project_id is not null then
    select * into project from public.projects where id = p_project_id;
    if project.id is null then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    if not exists (select 1 from public.space_projects
                    where space_id = p_space_id and project_id = p_project_id) then
      raise exception 'project is not linked to this space' using errcode = '42501';
    end if;
    if project.trust = 'untrusted' and not coalesce(p_confirm_untrusted, false) then
      raise exception 'spawning into an untrusted project requires explicit confirmation'
        using errcode = '42501',
              detail = jsonb_build_object('projectId', p_project_id, 'trust', project.trust)::text;
    end if;
  elsif coalesce(p_workdir_mode, 'project') = 'worktree' then
    raise exception 'worktree mode requires a project' using errcode = '22023';
  end if;

  session_id := internal.create_envelope(
    p_space_id, 'work_session', actor, p_parent_session_id, null
  );
  insert into public.work_sessions(entity_id, title, node_id, project_id, workdir_mode,
                                   workdir_path, base_ref, status, agent_tool, model, mode)
  values (session_id, coalesce(p_title, ''), p_node_id, p_project_id,
          coalesce(p_workdir_mode, 'project'), p_workdir_path, p_base_ref,
          'spawning', p_agent_tool, p_model, p_mode);

  -- ADDED IN 267 (launch v3 gap 4). The task `newTask` names is created HERE,
  -- inside the spawn's own transaction and after every refusal above, so a
  -- refused spawn leaves no task and the ledger entry below replays this task
  -- together with this session.
  if p_new_task_title is not null then
    new_title := btrim(p_new_task_title);
    if char_length(new_title) < 1 or char_length(new_title) > 200 then
      raise exception 'newTask.title must be 1..200 characters after trimming'
        using errcode = '22023';
    end if;
    created_task_id := internal.create_envelope(p_space_id, 'task', actor, null, null);
    insert into public.tasks(entity_id, title, description)
    values (created_task_id, new_title, '');
    perform internal.record_initial_version(created_task_id, actor);
    perform internal.record_activity(p_space_id, created_task_id, actor, 'created', null,
      jsonb_build_object('kind', 'task', 'via', 'spawn', 'workSessionId', session_id::text));
    -- Filed under the launch project (filing only). The project was checked
    -- as linked above, so a missing projection is a mapping gap, not a refusal.
    if p_project_id is not null then
      select link.project_entity_id into projection_id
        from public.project_links link
       where link.space_id = p_space_id and link.project_id = p_project_id;
      if projection_id is not null then
        insert into public.edges(space_id, src_id, dst_id, type, created_by)
        values (p_space_id, created_task_id, projection_id, 'in_project', actor)
        on conflict (src_id, dst_id, type) do nothing;
      end if;
    end if;
  end if;
  task_ids := coalesce(p_task_ids, '{}'::uuid[])
    || case when created_task_id is null then '{}'::uuid[] else array[created_task_id] end;

  patches := array[session_id];
  if context_story_id is not null then
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
    values(p_space_id,context_story_id,session_id,'contains',actor);
    patches := patches || context_story_id;
  end if;

  foreach task_id in array task_ids loop
    perform internal.live_entity(task_id, 'task');
    -- ADDED IN 267. A dispatcher launched on a task ROUTES it; it does not work
    -- it. So it is written neither as working on the task nor as its assignee —
    -- the worker it routes to becomes that — and an existing task is not
    -- started on its behalf. A task this spawn created is still started, since
    -- `newTask` is created `working`.
    if p_mode = 'dispatcher' then
      if task_id = created_task_id then
        update public.tasks t
           set work_status = internal.work_status_for_state(
                 internal.workflow_state_for_category(t.entity_id, 'in_progress')),
               updated_at = now()
         where t.entity_id = task_id;
      end if;
      patches := patches || task_id;
      continue;
    end if;
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, session_id, task_id, 'working_on', actor)
    on conflict (src_id, dst_id, type) do nothing;
    -- ADDED IN 111. The durable half of the same fact. Inside the loop and
    -- inside this transaction, so a task cannot end up naming an assignee for a
    -- session that was rolled back.
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (p_space_id, task_id, p_team_member_id, 'assigned_to',
            jsonb_build_object('via', 'spawn'), actor)
    on conflict (src_id, dst_id, type) do nothing;
    -- ADDED IN 131, REKEYED IN 150. The task has started. The `where` is still
    -- the whole rule — only a task that has not started yet can be started — but
    -- "has not started" is now the CATEGORY, not a list of two literals, and the
    -- status written is the workflow's own `in_progress` state.
    update public.tasks t
       set work_status = internal.work_status_for_state(
             internal.workflow_state_for_category(t.entity_id, 'in_progress')),
           updated_at = now()
     where t.entity_id = task_id
       and exists (select 1 from public.entities e
                    where e.id = t.entity_id and e.status_category = 'to_do')
    returning t.work_status into started_status;
    -- ⚠ KEEP THIS ADJACENT TO THE UPDATE ABOVE. `FOUND` reflects the LAST
    -- statement executed, not the last UPDATE. The two edge inserts above both
    -- set it, so a statement inserted between the UPDATE and this `if` turns
    -- the honesty gate into a lie that no test would catch: the cases below
    -- assert the count of `work.changed` rows, and a gate reading a preceding
    -- insert's FOUND would still satisfy most of them.
    if found then
      perform internal.record_activity(p_space_id, task_id, actor, 'work.changed', null,
        jsonb_build_object('status', started_status, 'via', 'spawn'));
    end if;
    patches := patches || task_id;
  end loop;
  -- 303 (Design Rules §2.3): the session's teammate is `participates_in`,
  -- written here by spawn itself (writer `spawn`) instead of being derived
  -- from the relates_to row below by 065's trigger.
  perform internal.w1_set_writer('spawn');
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (p_space_id, p_team_member_id, session_id, 'participates_in', actor)
  on conflict (src_id, dst_id, type) do nothing;
  perform internal.w1_set_writer(null);
  -- Legacy duplicate, still written until the last relates_to reader
  -- (execution_resume, redefined by P0a's 302) has moved; P0b's row
  -- migration stops this write and deletes the old rows together.
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (p_space_id, session_id, p_team_member_id, 'relates_to', actor)
  on conflict (src_id, dst_id, type) do nothing;

  result := internal.command_result(session_id, null,
    internal.record_activity(p_space_id, session_id, actor, 'created', null,
      jsonb_build_object(
        'kind', 'work_session',
        'teamMemberId', p_team_member_id,
        'parentSessionId', p_parent_session_id
      )),
    patches);
  -- ADDED IN 267: recorded IN the ledger row, so a replay answers the same task.
  if created_task_id is not null then
    result := result || jsonb_build_object('createdTaskId', created_task_id);
  end if;
  return internal.ledger_record(p_client_mutation_id, 'execution.spawn', result)
    || jsonb_build_object('__tm8_replayed', false);
end
$function$
;

-- issue_work_session_agent_session: the token goes to the participating teammate
CREATE OR REPLACE FUNCTION public.issue_work_session_agent_session(p_work_session_id uuid, p_team_member_id uuid, p_token_hash text, p_expires_at timestamp with time zone, p_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  account_row public.accounts;
  session_row public.auth_sessions;
  session_space uuid;
  prov record;
begin
  -- 277 (W7b): a `link` session mints here only WITH its link claim, and
  -- only through `internal.link_provenance_for` below, which requires its own
  -- row on that link to be signed in with spawning allowed (256
  -- `live_link_session`). Was 256's unconditional first-statement refusal.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link'
     and internal.claim_text('tm8.via_link') is null then
    raise exception 'a space link session cannot mint an agent session' using errcode = '42501';
  end if;
  perform internal.require_identity();
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at <= now() then
    raise exception 'invalid work-session credential' using errcode = '22023';
  end if;

  select a.* into account_row
    from public.accounts a
   where a.identity_id = internal.identity_id() and a.status = 'active'
   order by a.is_owner desc, a.created_at
   limit 1;
  if account_row.id is null then
    raise exception 'active account not found' using errcode = 'P0002';
  end if;

  select e.space_id into session_space
    from public.entities e
    join public.work_sessions ws on ws.entity_id = e.id
    -- 303: the session's teammate is participates_in (teammate -> session).
    join public.edges relation on relation.dst_id = e.id
      and relation.src_id = p_team_member_id and relation.type = 'participates_in'
   where e.id = p_work_session_id
     and e.deleted_at is null
     and ws.status in ('spawning','running','idle')
   for update of ws;
  if session_space is null then
    raise exception 'live work session/persona relationship not found' using errcode = 'P0002';
  end if;
  if not internal.can_act_as(p_team_member_id, session_space) then
    raise exception 'cannot issue a credential for this session persona' using errcode = '42501';
  end if;

  -- W7p: the link this session descends from, before the revoke below.
  select * into prov from internal.link_provenance_for(p_work_session_id);

  -- 277 (W7b): a link session mints only in its link's TARGET space. The pin
  -- already holds it there (can_act_as); this names the rule.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' and not exists (
    select 1 from public.space_links l
     where l.entity_id = prov.via_link_id and l.target_space_id = session_space
  ) then
    raise exception 'a space link session mints only in its link''s target space' using errcode = '42501';
  end if;

  -- 277 (W7b, review of #993): a link session resumes only a session ITS link
  -- started. A work session that already holds agent sessions none of which
  -- descend from this link was started in B by someone else; minting for it
  -- here would stamp it via_link_id and bind every later resume (the owner's
  -- included) to this link for good. A fresh spawn has no prior rows.
  if internal.link_bound() and exists (
    select 1 from public.auth_sessions s where s.work_session_id = p_work_session_id
  ) and not exists (
    select 1 from public.auth_sessions s
     where s.work_session_id = p_work_session_id and s.via_link_id = prov.via_link_id
  ) then
    raise exception 'a space link resumes only sessions it started' using errcode = '42501';
  end if;

  update public.auth_sessions
     set revoked_at = now()
   where work_session_id = p_work_session_id and revoked_at is null;

  insert into public.auth_sessions(
    account_id, kind, acting_as_team_member_id, work_session_id,
    token_hash, label, expires_at, space_id,
    via_link_id, parent_session_id
  ) values (
    account_row.id, 'agent', p_team_member_id, p_work_session_id,
    p_token_hash, p_label, least(p_expires_at, prov.parent_expires_at), session_space,
    prov.via_link_id, prov.parent_session_id
  ) returning * into session_row;

  return to_jsonb(session_row) - 'token_hash';
end
$function$
;

-- enqueue_task_state_nudges: the nudged teammate
CREATE OR REPLACE FUNCTION internal.enqueue_task_state_nudges(p_task_id uuid, p_cause text, p_status text, p_teammate_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  task_space uuid;
  acting uuid := internal.actor_id();
begin
  -- The task must still exist: an `assigned_to` edge is also deleted by the
  -- cascade from a task (or teammate) being hard-deleted, and the outbox's
  -- foreign key would then fail the delete. A deleted task is not a transition
  -- anybody needs to be told about.
  select e.space_id into task_space
    from public.entities e
   where e.id = p_task_id and e.kind = 'task' and e.deleted_at is null;
  if task_space is null then return; end if;

  insert into public.pending_task_nudges(
    space_id, work_session_id, task_id, loop_kind, cause, status, actor_id, teammate_id)
  select task_space, s.session_id, p_task_id, 'task_state', p_cause, p_status, acting, s.teammate_id
    from (
      select distinct on (se.id) se.id as session_id, tm.id as teammate_id
        from public.edges w
        join public.entities se
          on se.id = w.src_id and se.kind = 'work_session' and se.deleted_at is null
         -- Same Space as the task: the addressee never leaves it (148).
         and se.space_id = task_space
        join public.work_sessions ws on ws.entity_id = se.id
        -- 303: the session's teammate is participates_in (teammate -> session).
        left join public.edges r
          on r.dst_id = se.id and r.type = 'participates_in'
        left join public.entities tm
          on tm.id = r.src_id and tm.kind = 'team_member' and tm.space_id = task_space
       where w.dst_id = p_task_id and w.type = 'working_on'
         and ws.status in ('spawning', 'running', 'idle')
         and internal.is_agent_session(se.id)
       order by se.id, (tm.id is null), r.created_at
    ) s
   where p_teammate_id is null or s.teammate_id = p_teammate_id
  on conflict (work_session_id, task_id, loop_kind) where state = 'pending' do nothing;
end
$function$
;

-- begin_form_delivery_spawn: the requesting session's teammate
CREATE OR REPLACE FUNCTION public.begin_form_delivery_spawn(p_response_id uuid, p_work_session_id uuid, p_attempt integer, p_hold_seconds integer DEFAULT 900)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  d public.form_deliveries;
  fr public.form_responses;
  ws public.work_sessions;
  se public.entities;
  launch jsonb;
  m public.messages;
  source_message uuid;
  teammate uuid;
  tasks uuid[];
begin
  perform internal.require_identity();
  select * into fr from public.form_responses where id = p_response_id;
  if fr.id is null or not internal.is_space_member(fr.space_id) then return null; end if;

  update public.form_deliveries
     set spawn_mutation_id = coalesce(spawn_mutation_id,
           'form-delivery-spawn:' || p_response_id || ':' || p_work_session_id || ':' || p_attempt),
         claimed_at = now() + make_interval(secs => greatest(coalesce(p_hold_seconds, 900), 60))
   where response_id = p_response_id and work_session_id = p_work_session_id
     and status = 'pending' and delivery_id is null and claimed_at is not null
  returning * into d;
  if d.response_id is null then return null; end if;

  select * into se from public.entities where id = p_work_session_id;
  select * into ws from public.work_sessions where entity_id = p_work_session_id;
  -- 303: the session's teammate is participates_in (teammate -> session).
  select e.src_id into teammate
    from public.edges e
    join public.entities t on t.id = e.src_id and t.kind = 'team_member' and t.deleted_at is null
   where e.dst_id = p_work_session_id and e.type = 'participates_in'
   limit 1;
  -- The requester's tasks; failing that, the tasks the form is attached to
  -- (§7.3: "the teammate and tasks are known from the form's edges").
  select coalesce(array_agg(e.dst_id order by e.created_at), '{}') into tasks
    from public.edges e
    join public.entities t on t.id = e.dst_id and t.kind = 'task' and t.deleted_at is null
   where e.src_id = p_work_session_id and e.type = 'working_on';
  if cardinality(tasks) = 0 then
    select coalesce(array_agg(e.dst_id order by e.created_at), '{}') into tasks
      from public.edges e
      join public.entities t on t.id = e.dst_id and t.kind = 'task' and t.deleted_at is null
     where e.src_id = fr.form_id and e.type = 'attached_to';
  end if;

  -- The requester's RECORDED posture (the spawned session must never exceed
  -- it). Null when no manifest was recorded: the caller refuses to spawn.
  select sm.manifest -> 'launch' into launch
    from public.session_manifests sm where sm.work_session_id = p_work_session_id;

  -- The session copy the envelope renders, and the form's copy a reply
  -- threads under (214 G reads them the same way).
  select * into m from public.messages where entity_id = fr.message_id;
  select s.entity_id into source_message
    from public.messages s
   where s.message_batch_id = m.message_batch_id and s.anchor_id = fr.form_id
   limit 1;

  return jsonb_build_object(
    'mutationId', d.spawn_mutation_id,
    'message', jsonb_build_object(
      'id', m.entity_id,
      'batchId', m.message_batch_id,
      'body', m.body,
      'senderActorId', m.author_id,
      'senderActorKind', (select e.kind from public.entities e where e.id = m.author_id),
      'sourceMessageId', coalesce(source_message, m.entity_id)),
    'posture', case when launch is null then null else jsonb_build_object(
      'access_mode', launch ->> 'accessMode',
      'permission_mode', launch ->> 'permissionMode',
      'credential_source', launch ->> 'credentialSource',
      'credential_sources', launch -> 'credentialSources',
      'space_credential_ids', launch -> 'spaceCredentialIds',
      'harness_choice', launch -> 'harnessChoice') end,
    'spaceId', fr.space_id,
    'sessionDeleted', se.deleted_at is not null,
    'teamMemberId', teammate,
    'parentSessionId', se.parent_id,
    'projectId', ws.project_id,
    'taskIds', to_jsonb(tasks),
    'workdirMode', ws.workdir_mode,
    'baseRef', ws.base_ref,
    'mode', ws.mode,
    'model', ws.model,
    'agentTool', ws.agent_tool,
    'title', coalesce(ws.title, ''));
end
$function$
;

-- w2_record_interaction_profile_pin: the teammate whose default profile applies
CREATE OR REPLACE FUNCTION internal.w2_record_interaction_profile_pin(p_work_session_id uuid, p_profile_id uuid, p_profile_version integer, p_source text, p_resolved_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare session_entity public.entities; profile_row public.interaction_profiles;
declare expected_selection jsonb; snapshot jsonb; next_revision integer; created timestamptz;
declare actor uuid;
begin
  if p_source not in ('spawn_override','teammate_default','space_default','core_default')
     or (p_source = 'core_default') <> (p_profile_id is null)
     or (p_profile_id is null) <> (p_profile_version is null) then
    raise exception 'invalid Interaction Profile pin source/identity' using errcode = '22023';
  end if;
  select * into session_entity from public.entities where id = p_work_session_id for update;
  if session_entity.id is null or session_entity.kind <> 'work_session'
     or session_entity.deleted_at is not null then
    raise exception 'work session not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(session_entity.space_id);
  actor := coalesce(internal.actor_id(), internal.current_member_id(session_entity.space_id));
  if p_source = 'core_default' then
    snapshot := internal.w1_core_pin_snapshot()
      || jsonb_build_object('profile', jsonb_build_object('source','core_default'));
    expected_selection := jsonb_build_object(
      'profileId',null,'profileVersion',null,'templateKey','tm8.chat.core','templateVersion',1,
      'resolvedHash',internal.w2g12_hash_json(snapshot),'source','core_default','snapshot',snapshot
    );
  else
    profile_row := internal.w2g12_assert_active_profile(p_profile_id, session_entity.space_id);
    if profile_row.active_version <> p_profile_version then
      raise exception 'profile pin version no longer matches the active version'
        using errcode = '23514', detail = 'profile_not_validated';
    end if;
    if p_source = 'spawn_override' then
      perform internal.require_human_space_admin(session_entity.space_id);
    elsif p_source = 'space_default' and not exists (
      select 1 from public.spaces where id = session_entity.space_id
       and default_interaction_profile_id = p_profile_id
    ) then
      raise exception 'Space profile default changed before pin recording' using errcode = '40001';
    elsif p_source = 'teammate_default' and not exists (
      select 1
        from public.edges session_teammate
        join public.entities teammate on teammate.id = session_teammate.src_id
        join public.edges default_edge on default_edge.src_id = teammate.id
       where session_teammate.dst_id = p_work_session_id  -- 303: participates_in
         and session_teammate.type = 'participates_in'
         and teammate.space_id = session_entity.space_id
         and teammate.kind = 'team_member'
         and default_edge.type = 'defaults_to_profile'
         and default_edge.dst_id = p_profile_id
    ) then
      raise exception 'Teammate profile default changed before pin recording' using errcode = '40001';
    end if;
    expected_selection := internal.w2g12_resolved_profile(p_profile_id, p_source);
    if expected_selection is null then
      raise exception 'Interaction Profile is not launchable'
        using errcode = '23514', detail = 'profile_not_validated';
    end if;
    snapshot := expected_selection -> 'snapshot';
  end if;
  if expected_selection ->> 'resolvedHash' is distinct from p_resolved_hash then
    raise exception 'profile resolution hash changed before pin recording'
      using errcode = '40001', detail = 'profile_pin_hash_conflict';
  end if;
  select coalesce(max(pin_revision),0) + 1 into next_revision
    from public.work_session_interaction_pins where work_session_id = p_work_session_id;
  perform internal.w1_set_writer('profile_pin');
  insert into public.work_session_interaction_pins(
    work_session_id,pin_revision,profile_id,profile_version,template_key,template_version,
    resolved_hash,resolved_snapshot
  ) values (
    p_work_session_id,next_revision,p_profile_id,p_profile_version,
    expected_selection ->> 'templateKey',(expected_selection ->> 'templateVersion')::integer,
    p_resolved_hash,snapshot
  ) returning created_at into created;
  delete from public.edges where src_id = p_work_session_id and type = 'selected_profile';
  if p_profile_id is not null then
    insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
    values (session_entity.space_id,p_work_session_id,p_profile_id,'selected_profile',
      jsonb_build_object('pinRevision',next_revision,'resolvedHash',p_resolved_hash,'source',p_source),actor);
  end if;
  perform internal.w1_set_writer(null);
  return jsonb_build_object(
    'workSessionId',p_work_session_id,
    'pinRevision',next_revision,
    'profileId',p_profile_id,
    'profileVersion',p_profile_version,
    'templateKey',expected_selection ->> 'templateKey',
    'templateVersion',(expected_selection ->> 'templateVersion')::integer,
    'resolvedHash',p_resolved_hash,
    'source',p_source,
    'createdAt',internal.w2g12_iso(created)
  );
end
$function$
;

-- -----------------------------------------------------------------------------
-- 8. internal.migrate_edge: the ONE way a semantic edge migration moves a row.
--    Rewrites edge p_edge_id in place to (p_type, p_src_id, p_dst_id), or
--    deletes it when p_type is null, and logs the old and new rows under
--    p_batch with the rule (and whether the owner confirmed this row). When the
--    target row already exists, the legacy row is deleted instead ('merged'),
--    so a re-run is a no-op. Props are kept. The edge id is kept on a rewrite,
--    so readers that remember edge ids (story trail edge_id) stay valid.
--    Callers: P0b's row migration, with the owner-reviewed lists; tests.
-- -----------------------------------------------------------------------------
create or replace function internal.migrate_edge(
  p_batch text, p_rule text, p_edge_id uuid,
  p_type text, p_src_id uuid, p_dst_id uuid,
  p_confirmed text default 'rule')
returns text
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  old_e public.edges;
  new_e public.edges;
begin
  if coalesce(p_batch, '') = '' or coalesce(p_rule, '') = '' then
    raise exception 'migrate_edge needs a batch and a rule' using errcode = '22023';
  end if;
  select * into old_e from public.edges where id = p_edge_id for update;
  if not found then
    return 'missing';
  end if;
  perform set_config('tm8.edge_migration', p_batch, true);

  if p_type is null
     or exists (select 1 from public.edges
                 where src_id = p_src_id and dst_id = p_dst_id and type = p_type
                   and id <> p_edge_id) then
    delete from public.edges where id = p_edge_id;
    insert into internal.edge_migration_log(batch, rule, action, edge_id, old_row, new_row, confirmed)
    values (p_batch, p_rule, 'delete', p_edge_id, to_jsonb(old_e), null, p_confirmed);
    return case when p_type is null then 'deleted' else 'merged' end;
  end if;

  update public.edges
     set type = p_type, src_id = p_src_id, dst_id = p_dst_id, updated_at = now()
   where id = p_edge_id
  returning * into new_e;
  insert into internal.edge_migration_log(batch, rule, action, edge_id, old_row, new_row, confirmed)
  values (p_batch, p_rule, 'rewrite', p_edge_id, to_jsonb(old_e), to_jsonb(new_e), p_confirmed);
  return 'rewritten';
end
$$;
revoke all on function internal.migrate_edge(text, text, uuid, text, uuid, uuid, text) from public;
