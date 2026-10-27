-- =============================================================================
-- 289 — story progress counts the story's OWN work, not the trail
-- (task 01a0fe62, issues #26 #27 #29 #40).
--
-- THE BUG. 283's `internal.story_summary` tallied `progress` / `taskProgress`
-- over every row of `internal.story_trail`. The trail follows working_on,
-- created_in, dispatched_by, ... in both directions for three hops, so a root
-- task reaches the session working on it, that session reaches its
-- coordinator, and the coordinator reaches every task it created — in OTHER
-- stories. Live: each of the five child stories of 01a0fe59 reported
-- taskProgress.work = 37 (nearly the whole parent tree); an audit task with
-- no children reported work = 5; a programme root's totals disagreed with
-- `entity query --subtree`.
--
-- THE RULE (user ruling, carried by the coordinator's brief): a story's
-- progress is the stories it contains and the tasks it contains — nothing
-- else. Docs, forms, sessions, team members, PRs are never counted.
--
-- WHAT A STORY CONTAINS — `internal.story_work`, below:
--   * each ROOT (a live `contains` target, as in 283), and
--   * each root's descendants by HIERARCHY ONLY (parent -> child, the same
--     walk `entity query --subtree` does: `entity_tree`, depth 32), and
--   * each direct child story (same-kind `parent_id`).
--   A story is a LEAF here: a story root or child story counts as one item
--   and its own tasks are not walked into (they reach the parent through
--   `rollup`). No sideways edge is ever followed.
--
-- THE THREE BLOCKS (contract `StoryState`):
--   progress     = tally over the tasks AND stories the story contains;
--   taskProgress = tally over the tasks the story contains;
--   rollup       = taskProgress over the union of this story's tasks and every
--                  descendant story's (parent_id, 4 levels, 50 stories), each
--                  task once.
--   `work` excludes cancelled rows, so `work + cancelled` is the row count:
--   for a root, taskProgress total = (root is a task ? 1 : 0) + the task rows
--   of `entity query --kind task --subtree <root>`.
--
-- UNCHANGED: the trail itself (283's story_trail) still drives itemCount,
-- liveSessionCount, pendingAttentionCount, lastActivityAt and the page's
-- graph — what the story TOUCHES is shown, only what it CONTAINS is counted.
--
-- SECURITY INVOKER, like 283: RLS decides what a viewer counts.
--
-- NUMBERED 289, measured 2026-10-03 against every remote ref: main tops at
-- 287; origin/story-status-settable holds 288_story_status_door (it does not
-- touch story_summary). RE-MEASURE at assembly.
--
-- SHARED-OBJECT NOTICE: REPLACES internal.story_summary (283's body with the
-- three tallies re-pointed at story_work; every other key verbatim).
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. What the story contains. One row per (entity, root); `root_id` is NULL
--    for a direct child story. `depth` is 0 for a root, 1.. below it.
-- -----------------------------------------------------------------------------
create or replace function internal.story_work(p_story_id uuid)
returns table(entity_id uuid, kind text, root_id uuid, depth integer)
language sql stable set search_path = public, internal, pg_temp as $$
  with recursive roots as (
    select c.dst_id as id
      from public.edges c
      join public.entities re on re.id = c.dst_id and re.deleted_at is null
     where c.src_id = p_story_id and c.type = 'contains' and c.dst_id <> p_story_id
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
$$;

comment on function internal.story_work(uuid) is
  '289: what a story CONTAINS for counting — its roots, their hierarchy '
  'descendants (parent->child only, depth 32, never out of a story), and its '
  'direct child stories. Never follows sideways edges.';

-- -----------------------------------------------------------------------------
-- 2. THE SUMMARY — 283's body; progress/taskProgress/rollup re-pointed.
-- -----------------------------------------------------------------------------
create or replace function internal.story_summary(p_story_id uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  trail_rows integer;
  root_count integer;
  item_ids uuid[];
  work_ids uuid[];
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

  -- Counted: the tasks and stories the story contains (289), not the trail.
  select coalesce(array_agg(distinct w.entity_id) filter (where w.kind in ('task', 'story')), '{}'),
         coalesce(array_agg(distinct w.entity_id) filter (where w.kind = 'task'), '{}')
    into work_ids, task_ids
    from internal.story_work(p_story_id) w;

  with recursive kids(id, lvl) as (
    select c.id, 1 from public.entities c
     where c.parent_id = p_story_id and c.kind = 'story' and c.deleted_at is null
    union all
    select c.id, k.lvl + 1 from kids k
      join public.entities c on c.parent_id = k.id and c.kind = 'story' and c.deleted_at is null
     where k.lvl < 4
  )
  select coalesce(array_agg(distinct w.entity_id), '{}') into family_task_ids
    from (select id from kids limit 50) k
    cross join lateral internal.story_work(k.id) w
   where w.kind = 'task';
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
    'progress', internal.story_tally(work_ids),
    'taskProgress', internal.story_tally(task_ids),
    'rollup', internal.story_tally(family_task_ids),
    'liveSessionCount', live_sessions,
    'pendingAttentionCount', pending,
    -- UTC ISO-8601 with Z, whatever the session TimeZone: both twins pass
    -- this string through untouched, so it must already be the wire form.
    'lastActivityAt', to_char(last_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'childStoryCount', child_count);
end
$$;

revoke all on function internal.story_work(uuid) from public;
grant execute on function internal.story_work(uuid) to tm8_app, tm8_graph_owner;
revoke all on function internal.story_summary(uuid) from public;
grant execute on function internal.story_summary(uuid) to tm8_app, tm8_graph_owner;

reset role;
