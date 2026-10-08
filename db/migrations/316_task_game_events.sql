-- Game P0c: committed criterion changes and task status from/to.
-- Capture at the authoritative row so tick, patch, completion and spawn agree.
-- Generic entity.upsert remains the snapshot; these events describe deltas.
set local lock_timeout = '5s';
set role tm8_graph_owner;

-- A cold reader needs the same status time as the durable event. Old rows are
-- deliberately unknown: updated_at/activity rows do not prove a status move.
alter table public.tasks add column status_changed_at timestamptz;

create or replace function internal.stamp_task_status_change()
returns trigger language plpgsql
set search_path = public, internal, pg_temp as $$
begin
  new.status_changed_at := case
    -- Transaction start times can arrive out of order after waiting on a row
    -- lock. Capture the actual row transition and never regress its time.
    when new.work_status is distinct from old.work_status
      then greatest(clock_timestamp(), old.status_changed_at)
    else old.status_changed_at
  end;
  return new;
end
$$;
revoke all on function internal.stamp_task_status_change() from public;
create trigger tasks_stamp_status_change
  before update of work_status on public.tasks
  for each row execute function internal.stamp_task_status_change();

create or replace function internal.emit_task_game_events()
returns trigger language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  space uuid;
  criterion jsonb;
  previous jsonb;
  completed integer;
  total integer;
begin
  select e.space_id into space from public.entities e where e.id = new.entity_id;
  if space is null then return new; end if;

  if new.work_status is distinct from old.work_status then
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id, occurred_at)
    values (space, internal.next_event_seq(space), 'task.status_changed',
            jsonb_build_object('id', new.entity_id, 'from', old.work_status, 'to', new.work_status),
            internal.claim_cmid(), new.status_changed_at);
  end if;

  if new.acceptance_criteria is distinct from old.acceptance_criteria then
    select count(*)::integer,
           count(*) filter (where coalesce((c ->> 'done')::boolean, false))::integer
      into total, completed from jsonb_array_elements(new.acceptance_criteria) c;
    -- Array order makes multi-criterion events deterministic. All carry the
    -- final counts from this update, not artificial intermediate progress.
    for criterion in select value from jsonb_array_elements(new.acceptance_criteria)
    loop
      select value into previous from jsonb_array_elements(old.acceptance_criteria)
        where value ->> 'id' = criterion ->> 'id' limit 1;
      if coalesce((criterion ->> 'done')::boolean, false)
           is distinct from coalesce((previous ->> 'done')::boolean, false) then
        insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
        values (space, internal.next_event_seq(space), 'task.criterion_changed',
                jsonb_build_object('id', new.entity_id,
                  'criterionId', criterion ->> 'id', 'criterionText', criterion ->> 'text',
                  'isDone', coalesce((criterion ->> 'done')::boolean, false),
                  'done', completed, 'total', total), internal.claim_cmid());
      end if;
    end loop;
  end if;
  return new;
end
$$;
revoke all on function internal.emit_task_game_events() from public;

create trigger tasks_emit_game_events
  after update of work_status, acceptance_criteria on public.tasks
  for each row execute function internal.emit_task_game_events();

-- The classifier is owned by the migration role (208/302/313).
reset role;

create or replace function internal.event_subject_ids(p_event_type text, p_payload jsonb)
returns uuid[] language sql immutable parallel safe
set search_path = pg_catalog, pg_temp as $$
  select array(
    select distinct candidate::uuid
      from unnest(case
        when p_event_type in ('entity.upsert', 'entity.deleted', 'entity.activity_touched',
                              'session.outcome_changed', 'session.process_changed',
                              'task.criterion_changed', 'task.status_changed')
          then array[p_payload ->> 'id']
        when p_event_type in ('edge.upsert', 'edge.deleted', 'edge.ended')
          then array[p_payload ->> 'src_id', p_payload ->> 'dst_id']
        when p_event_type in ('message.created', 'message.updated', 'message.deleted')
          then array[p_payload ->> 'entity_id', p_payload ->> 'anchor_id']
        when p_event_type = 'entity.seen'
          then array[p_payload ->> 'entityId']
        when p_event_type = 'counter.changed'
          then array[p_payload ->> 'entity_id']
        when p_event_type = 'activity.created'
          then array[p_payload ->> 'entity_id']
        when p_event_type in ('notification.created', 'notification.read')
          then array[p_payload ->> 'target_entity_id']
        when p_event_type = 'git.commit_recorded'
          then array[p_payload ->> 'commitEntityId']
        when p_event_type = 'git.pr_state_changed'
          then array[p_payload ->> 'prEntityId']
        when p_event_type = 'git.worktree_status_changed'
          then array[p_payload ->> 'worktreeEntityId']
        else array[]::text[]
      end) as candidate
     where candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     order by 1)
$$;
