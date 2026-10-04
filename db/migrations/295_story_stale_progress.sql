-- Story status stays manual. This optional tally field reports a subset of
-- inProgress, not another disjoint band and not evidence of abandonment.
set local lock_timeout = '5s';
set role tm8_graph_owner;

create or replace function internal.story_tally(p_ids uuid[])
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'work',       count(*) filter (where e.status_category in ('to_do', 'in_progress', 'done')),
    'done',       count(*) filter (where e.status_category = 'done'),
    'inProgress', count(*) filter (where e.status_category = 'in_progress' and not b.blocked),
    'toDo',       count(*) filter (where e.status_category = 'to_do' and not b.blocked),
    'blocked',    count(*) filter (where e.status_category in ('to_do', 'in_progress') and b.blocked),
    'cancelled',  count(*) filter (where e.status_category = 'cancelled'),
    'staleInProgress', count(*) filter (
      where e.kind = 'task' and e.status_category = 'in_progress' and not b.blocked
        and not exists (
          select 1 from public.edges w
          join public.entities se on se.id = w.src_id
            and se.kind = 'work_session' and se.deleted_at is null
          join public.work_sessions ws on ws.entity_id = se.id
          where w.dst_id = e.id and w.type = 'working_on'
            and ws.status in ('spawning', 'running', 'idle'))))
  from public.entities e
  left join public.tasks t on t.entity_id = e.id
  cross join lateral (select coalesce(t.work_status = 'blocked', false) or exists (
    select 1 from public.edges dep
    where dep.src_id = e.id and dep.type = 'depends_on'
      and coalesce((dep.props ->> 'hard')::boolean, true)
      and not internal.is_resolved(dep.dst_id)) as blocked) b
  where e.id = any(coalesce(p_ids, '{}'::uuid[])) and e.deleted_at is null
$$;

comment on function internal.story_tally(uuid[]) is
  'Contained-work tally. Disjoint done/inProgress/toDo/blocked bands; cancelled '
  'is outside work. staleInProgress is the subset of unblocked in-progress tasks '
  'without a visible, nondeleted spawning/running/idle session directly working_on it. '
  'Security invoker: visibility determines both counted tasks and live evidence.';

revoke all on function internal.story_tally(uuid[]) from public;
grant execute on function internal.story_tally(uuid[]) to tm8_app, tm8_graph_owner;
reset role;
