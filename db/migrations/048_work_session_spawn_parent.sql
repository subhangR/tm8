-- 048 — persist the work-session spawn chain on the entity hierarchy.
--
-- An agent process already knows the work_session it is running in through
-- TM8_SESSION_ID. execution.spawn carries that id as p_parent_session_id, and
-- the new session is born beneath it atomically. Human launches omit the value
-- and remain roots. The entities_validate_parent trigger remains the authority
-- for same-space, same-kind, acyclic hierarchy.

drop function if exists public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text
);

create function public.execution_spawn(
  p_space_id uuid, p_team_member_id uuid, p_task_ids uuid[] default '{}'::uuid[],
  p_project_id uuid default null, p_workdir_mode text default 'project',
  p_workdir_path text default null, p_base_ref text default null,
  p_mode text default null, p_model text default null, p_agent_tool text default null,
  p_title text default null, p_node_id text default null,
  p_confirm_untrusted boolean default false, p_session_cap integer default 8,
  p_actor_id uuid default null, p_client_mutation_id text default null,
  p_parent_session_id uuid default null
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
    parent_session := internal.live_entity(p_parent_session_id, 'work_session');
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

  patches := array[session_id];
  foreach task_id in array coalesce(p_task_ids, '{}'::uuid[]) loop
    perform internal.live_entity(task_id, 'task');
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, session_id, task_id, 'working_on', actor)
    on conflict (src_id, dst_id, type) do nothing;
    patches := patches || task_id;
  end loop;
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (p_space_id, session_id, p_team_member_id, 'relates_to', actor)
  on conflict (src_id, dst_id, type) do nothing;

  return internal.ledger_record(p_client_mutation_id, 'execution.spawn',
           internal.command_result(session_id, null,
             internal.record_activity(p_space_id, session_id, actor, 'created', null,
               jsonb_build_object(
                 'kind', 'work_session',
                 'teamMemberId', p_team_member_id,
                 'parentSessionId', p_parent_session_id
               )),
             patches)) || jsonb_build_object('__tm8_replayed', false);
end
$$;

revoke all on function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid
) from public;
grant execute on function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid
) to tm8_app;
