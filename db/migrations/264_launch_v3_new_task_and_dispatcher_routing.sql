-- =============================================================================
-- 264 — launch v3 (lane C): create the task in the spawn/dispatch request, and
-- a dispatcher launched on a task routes it rather than being assigned it.
--
-- NUMBERED 264: main's highest is 263 (#919), and 262 is claimed by several
-- open PRs (#866, #915). Renumber at composition if it collides.
--
-- 1. `public.execution_spawn` gains `p_new_task_title` (contract decision 4):
--    the task is created inside the spawn's own transaction, after every
--    refusal, so a refused spawn leaves no task and the ledger row replays the
--    same task with the same session. It is assigned to the persona, started
--    (`working`) and filed under the launch project — through the same loop
--    every `p_task_ids` entry takes.
--
-- 2. `p_mode = 'dispatcher'` writes no `working_on` / `assigned_to` edge and
--    starts no existing task (amendment to decision 5): a dispatcher launched on
--    a task ROUTES it, and the worker it routes to becomes the assignee.
--
-- 3. `public.execution_dispatch_new_task` — `execution.dispatch.newTask`:
--    creates the task (status `working`, no assignee, filed under the project
--    when named), ledgered under its own client mutation id so a retried
--    dispatch replays the same task.
--
-- The 17-argument `execution_spawn` is DROPPED, not left beside the new one: a
-- positional 17-argument call would otherwise be ambiguous between the two.
-- Every caller keeps working, since the new parameter defaults to null.
--
--    ⚠ NO `set role tm8_graph_owner` around `execution_spawn` — 178's note: the
--    function is owned by the APPLIER, and every migration that wrote it kept
--    that posture.
-- =============================================================================

drop function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid
);

create function public.execution_spawn(
  p_space_id uuid, p_team_member_id uuid, p_task_ids uuid[] default '{}'::uuid[],
  p_project_id uuid default null, p_workdir_mode text default 'project',
  p_workdir_path text default null, p_base_ref text default null,
  p_mode text default null, p_model text default null, p_agent_tool text default null,
  p_title text default null, p_node_id text default null,
  p_confirm_untrusted boolean default false, p_session_cap integer default 8,
  p_actor_id uuid default null, p_client_mutation_id text default null,
  p_parent_session_id uuid default null,
  p_new_task_title text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
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
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.spawn');
  if replay is not null then
    return replay || jsonb_build_object('__tm8_replayed', true);
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

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

  -- ADDED IN 264 (launch v3 gap 4). The task `newTask` names is created HERE,
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
  foreach task_id in array task_ids loop
    perform internal.live_entity(task_id, 'task');
    -- ADDED IN 264. A dispatcher launched on a task ROUTES it; it does not work
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
  -- ADDED IN 264: recorded IN the ledger row, so a replay answers the same task.
  if created_task_id is not null then
    result := result || jsonb_build_object('createdTaskId', created_task_id);
  end if;
  return internal.ledger_record(p_client_mutation_id, 'execution.spawn', result)
    || jsonb_build_object('__tm8_replayed', false);
end
$$;

revoke all on function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid, text
) from public;

grant execute on function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid, text
) to tm8_app;

-- -----------------------------------------------------------------------------
-- execution.dispatch `newTask` (decision 4 + amendment). No assignee: routing is
-- the dispatcher's job. `p_project_ref` files the task (a folder id or project
-- entity id, resolved exactly as spawn resolves one) and never steers routing.
-- -----------------------------------------------------------------------------
set role tm8_graph_owner;

create or replace function public.execution_dispatch_new_task(
  p_space_id uuid, p_title text, p_project_ref uuid default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  new_title text;
  projection_id uuid;
  task_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.dispatch');
  if replay is not null then return replay; end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  new_title := btrim(coalesce(p_title, ''));
  if char_length(new_title) < 1 or char_length(new_title) > 200 then
    raise exception 'newTask.title must be 1..200 characters after trimming'
      using errcode = '22023';
  end if;

  if p_project_ref is not null then
    select ref.project_entity_id into projection_id
      from public.resolve_project_ref(p_project_ref, p_space_id) ref
     where ref.project_entity_id is not null
     limit 1;
    if projection_id is null then
      raise exception 'project % is not linked to this space', p_project_ref
        using errcode = 'P0002';
    end if;
  end if;

  task_id := internal.create_envelope(p_space_id, 'task', actor, null, null);
  insert into public.tasks(entity_id, title, description)
  values (task_id, new_title, '');
  perform internal.record_initial_version(task_id, actor);
  perform internal.record_activity(p_space_id, task_id, actor, 'created', null,
    jsonb_build_object('kind', 'task', 'via', 'dispatch'));
  update public.tasks t
     set work_status = internal.work_status_for_state(
           internal.workflow_state_for_category(t.entity_id, 'in_progress')),
         updated_at = now()
   where t.entity_id = task_id;
  if projection_id is not null then
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, task_id, projection_id, 'in_project', actor)
    on conflict (src_id, dst_id, type) do nothing;
  end if;

  return internal.ledger_record(p_client_mutation_id, 'execution.dispatch',
           jsonb_build_object('taskId', task_id));
end
$$;

revoke all on function public.execution_dispatch_new_task(uuid, text, uuid, uuid, text) from public;
grant execute on function public.execution_dispatch_new_task(uuid, text, uuid, uuid, text) to tm8_app;

reset role;
