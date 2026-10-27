-- =============================================================================
-- 307 — task and story PROGRESS, points-weighted (task 01a111b4, "Game v1 P0i";
-- spec doc 01a111ba, owner answers on form 01a111b7, Design Rules 01a10c5d §9).
--
-- One calculation, read by the task list, the story list, the story page and
-- (later) the story-game map:
--
--   w(t)   = pointsEstimate if > 0, else 1        (0 and NULL read as missing:
--                                                  weight 1 plus a surveyor tent)
--   own(t) = 1                  if t is done      (status wins over criteria)
--          = ticked / total     if t has criteria
--          = 0                  otherwise         (owner, form 01a111fd: a task
--                                                  without criteria is counted,
--                                                  with no progress until done —
--                                                  containers included)
--   over a set S: earned = Σ w·own, total = size = Σ w
--   percent = floor(100 · earned / total), NULL when total = 0 (no work)
--
-- A task's progress is over its SUBTREE (itself included), so a done root with
-- an open 8-point child reads 1/9 — 11% — and its own completion stays 1 (D3).
-- Cancelled tasks and everything under them are out (counted_floor: done
-- children keep counting). A story's progress is over the DISTINCT set of
-- tasks its rollup already counts (289's family set), so a task reachable
-- twice counts once.
--
-- Computed on read (owner: cache only if it measures slow). Live: a deferred
-- trigger re-emits `entity.upsert` for the ancestors and containing stories of
-- a task whose criteria, estimate, status, parent or existence changed, marked
-- `derived: progress` so the change feed does not read it as an edit.
-- =============================================================================
set local lock_timeout = '5s';
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The tally over a set of task ids. Callers prune cancelled subtrees; this
--    drops only rows that are themselves cancelled, deleted or not tasks.
-- -----------------------------------------------------------------------------
create or replace function internal.progress_tally(p_ids uuid[])
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  with facts as (
    select e.id,
           e.status_category = 'done' as done,
           case when coalesce(t.points_estimate, 0) > 0 then t.points_estimate else 1 end::numeric as w,
           coalesce(t.points_estimate, 0) = 0 as tent,
           case
             when e.status_category = 'done' then 1::numeric
             when jsonb_array_length(coalesce(t.acceptance_criteria, '[]'::jsonb)) > 0 then
               (select count(*) filter (where coalesce((c ->> 'done')::boolean, false))::numeric / count(*)
                  from jsonb_array_elements(t.acceptance_criteria) c)
             -- No criteria: counted, with no progress until done. A container
             -- too (owner, form 01a111fd), replacing §9's weight-0 exclusion.
             else 0::numeric
           end as own
      from public.entities e
      join public.tasks t on t.entity_id = e.id
     where e.id = any(coalesce(p_ids, '{}'::uuid[]))
       and e.kind = 'task' and e.deleted_at is null and e.status_category <> 'cancelled'
  ),
  sums as (
    select coalesce(sum(w * own), 0) as earned,
           coalesce(sum(w), 0) as total,
           coalesce(sum(w), 0) as size,
           count(*) as tasks,
           count(*) filter (where not done) as open,
           count(*) filter (where tent) as tents
      from facts
  )
  select jsonb_build_object(
    -- Rounded to 6 places before the floor, so 1/3 + 2/3 is 100%, not 99%.
    'percent', case when total > 0 then floor(round(100 * earned / total, 6))::int end,
    'earned', round(earned, 2),
    'total', total,
    'size', size,
    'tasks', tasks,
    'open', open,
    'tents', tents)
  from sums
$$;

comment on function internal.progress_tally(uuid[]) is
  '307: points-weighted progress over a set of tasks (spec doc 01a111ba). '
  'percent is floor(100·earned/total), NULL when nothing is countable. '
  'Cancelled and deleted ids are skipped; pruning their subtrees is the caller''s job.';

-- -----------------------------------------------------------------------------
-- 2. One task: its subtree (itself included, cancelled children pruned with
--    everything under them) plus its OWN completion, kept separate (D3).
-- -----------------------------------------------------------------------------
create or replace function internal.task_progress(p_task_id uuid)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  with recursive tree(id, depth, path) as (
    select p_task_id, 0, array[p_task_id]
    union all
    select ch.id, tr.depth + 1, tr.path || ch.id
      from tree tr
      join public.entities ch on ch.parent_id = tr.id
     where ch.kind = 'task' and ch.deleted_at is null and ch.status_category <> 'cancelled'
       and tr.depth < 32 and not ch.id = any(tr.path)
  ),
  ids as (select array_agg(distinct id) as ids from tree),
  me as (
    select coalesce(t.points_estimate, 0) = 0 as tent,
           internal.progress_tally(array[p_task_id]) as tally
      from public.tasks t
     where t.entity_id = p_task_id
  )
  -- own: the task alone, as the tally weighs it.
  select internal.progress_tally(ids.ids) || jsonb_build_object(
    'own', case when (me.tally ->> 'total')::numeric > 0
                then round((me.tally ->> 'earned')::numeric / (me.tally ->> 'total')::numeric, 4) end,
    'tent', me.tent,
    'openSubtasks', (select count(*) from tree tr join public.entities e on e.id = tr.id
                      where tr.depth > 0 and e.status_category <> 'done'))
  from ids cross join me
$$;

comment on function internal.task_progress(uuid) is
  '307: a task''s progress over its subtree (itself included, cancelled subtrees '
  'pruned) with its own completion separate: own = 1 when done, else the criteria '
  'ratio, else 0.';

-- -----------------------------------------------------------------------------
-- 3. A story: the distinct tasks its rollup counts — its own work plus its
--    child stories' (289's family set), with cancelled subtrees pruned.
-- -----------------------------------------------------------------------------
create or replace function internal.task_withdrawn(p_task_id uuid)
returns boolean language sql stable set search_path = public, internal, pg_temp as $$
  with recursive up(id, depth) as (
    select p_task_id, 0
    union all
    select e.parent_id, up.depth + 1
      from up join public.entities e on e.id = up.id
     where e.parent_id is not null and up.depth < 32
  )
  select exists (
    select 1 from up join public.entities e on e.id = up.id
     where e.kind = 'task' and (e.status_category = 'cancelled' or e.deleted_at is not null))
$$;

create or replace function internal.story_progress(p_task_ids uuid[])
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select internal.progress_tally(array(
    select x from unnest(coalesce(p_task_ids, '{}'::uuid[])) x where not internal.task_withdrawn(x)))
$$;

comment on function internal.story_progress(uuid[]) is
  '307: a story''s weighted progress over the distinct task set it counts, '
  'minus tasks under a cancelled ancestor (spec doc 01a111ba, story_dedupe=once).';

-- -----------------------------------------------------------------------------
-- 4. story_summary — 289's body unchanged except the new `weighted` key.
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
    -- 307: points-weighted, over the same family set the rollup counts.
    'weighted', internal.story_progress(family_task_ids),
    'liveSessionCount', live_sessions,
    'pendingAttentionCount', pending,
    -- UTC ISO-8601 with Z, whatever the session TimeZone: both twins pass
    -- this string through untouched, so it must already be the wire form.
    'lastActivityAt', to_char(last_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'childStoryCount', child_count);
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Live fan-out. A row's progress depends on rows below it, so a change to a
--    task re-emits `entity.upsert` for its ancestors and for the stories that
--    contain it or an ancestor (and their parent stories). The projector
--    re-reads each summary, so the event carries the current numbers.
--
--    DEFERRED to commit and deduplicated per transaction through the
--    transaction-local setting `tm8.progress_emitted` (254's pattern), so a
--    tick that writes the task row and its version bump, or a bulk move,
--    emits each ancestor once.
-- -----------------------------------------------------------------------------
create or replace function internal.progress_emit(p_ids uuid[], p_skip uuid[])
returns void language plpgsql set search_path = public, internal, pg_temp as $$
declare
  emitted text[] := coalesce(string_to_array(
    nullif(current_setting('tm8.progress_emitted', true), ''), ','), '{}');
  target record;
begin
  for target in
    with recursive chain(id, depth) as (
      select x, 0 from unnest(p_ids) x where x is not null
      union
      select e.parent_id, c.depth + 1
        from chain c join public.entities e on e.id = c.id
       where e.parent_id is not null and c.depth < 32
    ),
    stories(id, depth) as (
      select g.src_id, 0
        from public.edges g
       where g.type = 'contains' and g.dst_id in (select id from chain)
      union
      select e.parent_id, s.depth + 1
        from stories s join public.entities e on e.id = s.id
       where e.parent_id is not null and e.kind = 'story' and s.depth < 8
    )
    select e.*
      from public.entities e
     where e.id in (select id from chain union select id from stories)
       and e.kind in ('task', 'story') and e.deleted_at is null
       and not e.id = any(coalesce(p_skip, '{}'::uuid[]))
  loop
    continue when target.id::text = any(emitted);
    emitted := emitted || target.id::text;
    insert into public.workspace_events(space_id, seq, event_type, payload)
    values (target.space_id, internal.next_event_seq(target.space_id), 'entity.upsert',
            to_jsonb(target) || jsonb_build_object('derived', 'progress'));
  end loop;
  perform set_config('tm8.progress_emitted', array_to_string(emitted, ','), true);
end
$$;

comment on function internal.progress_emit(uuid[], uuid[]) is
  '307: re-emits entity.upsert (payload.derived = progress) for the given ids, '
  'their ancestors and the stories containing any of them, once per transaction.';

-- SECURITY DEFINER: a deferred trigger fires at COMMIT, outside the definer
-- RPC that made the change, as the session role — which may not write
-- workspace_events. Running as the graph owner also sees every ancestor and
-- story, not just the ones the mutator can read; the mapper still hydrates
-- each event under the subscriber's RLS.
create or replace function internal.progress_fanout() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if tg_table_name = 'tasks' then
    -- Criteria or estimate: the task's own row too — a content write may not
    -- bump the envelope.
    perform internal.progress_emit(array[new.entity_id], '{}');
  elsif tg_table_name = 'entities' then
    if tg_op = 'INSERT' then
      perform internal.progress_emit(array[new.id], array[new.id]);
    elsif tg_op = 'UPDATE' then
      -- The task's own upsert is already captured; its old parent lost it.
      perform internal.progress_emit(array[new.id, old.parent_id], array[new.id]);
    else
      perform internal.progress_emit(array[old.parent_id], '{}');
    end if;
  elsif tg_table_name = 'edges' then
    if tg_op = 'DELETE' then
      perform internal.progress_emit(array[old.src_id], '{}');
    else
      perform internal.progress_emit(array[new.src_id], '{}');
    end if;
  end if;
  return null;
end
$$;

drop trigger if exists tasks_progress_fanout on public.tasks;
create constraint trigger tasks_progress_fanout
after update on public.tasks deferrable initially deferred
for each row
when (old.acceptance_criteria is distinct from new.acceptance_criteria
   or old.points_estimate is distinct from new.points_estimate)
execute function internal.progress_fanout();

drop trigger if exists entities_progress_fanout_insert on public.entities;
create constraint trigger entities_progress_fanout_insert
after insert on public.entities deferrable initially deferred
for each row when (new.kind = 'task' and new.parent_id is not null)
execute function internal.progress_fanout();

drop trigger if exists entities_progress_fanout_update on public.entities;
create constraint trigger entities_progress_fanout_update
after update on public.entities deferrable initially deferred
for each row
when (new.kind = 'task' and (old.status_category is distinct from new.status_category
   or old.parent_id is distinct from new.parent_id
   or old.deleted_at is distinct from new.deleted_at))
execute function internal.progress_fanout();

drop trigger if exists entities_progress_fanout_delete on public.entities;
create constraint trigger entities_progress_fanout_delete
after delete on public.entities deferrable initially deferred
for each row when (old.kind = 'task' and old.parent_id is not null)
execute function internal.progress_fanout();

-- A story gaining or losing a root.
drop trigger if exists edges_progress_fanout_insert on public.edges;
create constraint trigger edges_progress_fanout_insert
after insert on public.edges deferrable initially deferred
for each row when (new.type = 'contains')
execute function internal.progress_fanout();

drop trigger if exists edges_progress_fanout_delete on public.edges;
create constraint trigger edges_progress_fanout_delete
after delete on public.edges deferrable initially deferred
for each row when (old.type = 'contains')
execute function internal.progress_fanout();

revoke all on function internal.progress_tally(uuid[]) from public;
grant execute on function internal.progress_tally(uuid[]) to tm8_app, tm8_graph_owner;
revoke all on function internal.task_progress(uuid) from public;
grant execute on function internal.task_progress(uuid) to tm8_app, tm8_graph_owner;
revoke all on function internal.task_withdrawn(uuid) from public;
grant execute on function internal.task_withdrawn(uuid) to tm8_app, tm8_graph_owner;
revoke all on function internal.story_progress(uuid[]) from public;
grant execute on function internal.story_progress(uuid[]) to tm8_app, tm8_graph_owner;
revoke all on function internal.story_summary(uuid) from public;
grant execute on function internal.story_summary(uuid) to tm8_app, tm8_graph_owner;
revoke all on function internal.progress_emit(uuid[], uuid[]) from public;
grant execute on function internal.progress_emit(uuid[], uuid[]) to tm8_app, tm8_graph_owner;
revoke all on function internal.progress_fanout() from public;

reset role;
