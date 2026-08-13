-- 111 — spawning a teammate on a task ASSIGNS that task to them.
--
-- THE OBSERVATION THIS FIXES, from prod (tm8_prod, 2026-08-13). Every task the
-- dispatcher had routed carried a `working_on` edge from the new session, and
-- NOT ONE carried an `assigned_to` edge. Across the whole database there were
-- 32 `assigned_to` edges and every one of them had been drawn by a human in the
-- UI. So the routing decision — the single fact the dispatcher exists to
-- produce — was reconstructible only by walking `working_on` back to a session,
-- the session's `relates_to` to a persona, and hoping the session still existed.
--
-- WHY `working_on` WAS NOT ALREADY ENOUGH, since 048 has written it all along.
-- The two edges answer different questions and the registry says so: 001 calls
-- `assigned_to` "Task assignment" and 015 calls `working_on` "Active work".
-- `working_on` hangs off a work_session, so it says "this PROCESS is on it" and
-- it is only as meaningful as that process is alive. `assigned_to` hangs off the
-- task and points at a person, so it survives the session it was born from and
-- is what a human reading the board, and `w2_notify_anchor_watchers` (077:125)
-- reading `anchor_assignee`, both actually look at. Until now a dispatched
-- teammate was not a watcher of the task it had been dispatched to, and so was
-- notified of nothing said on it.
--
-- WHY IN THE RPC AND NOT IN THE SPAWN HANDLER. `dispatched_by` is written in
-- TypeScript after `spawnService.spawn` returns, deliberately and
-- best-effort, because it is provenance about a session that already exists.
-- This is not that. The assignment, the `working_on` edge and the session row
-- are three statements of one fact, and 048's docblock already binds the second
-- and third to a single transaction. A spawn that half-lands must not leave a
-- task claiming an assignee for a session that was never created.
--
-- WHY EVERY SPAWN AND NOT ONLY A DISPATCHED ONE. This function cannot see the
-- caller's mode, and it should not have to: a human pressing Launch on a task
-- has put that teammate on that task by exactly the same act. Scoping the rule
-- to dispatcher spawns would leave the UI path writing no assignment for a
-- reason nobody could state.
--
-- `props.via = 'spawn'` distinguishes a launch-made assignment from a
-- hand-drawn one for anything that later wants to treat them differently.
-- NOT `props.origin`: that key is Server-owned and the 066 edge guard raises
-- 42501 on an insert that sets it without a writer token, which this
-- security-definer path does not hold.
--
-- `on conflict do nothing` — a re-spawn of the same teammate on the same task
-- must not rewrite a human's existing assignment, and `assigned_to` admits
-- several assignees, so this only ever adds the launched teammate to whoever is
-- already named.
--
-- The body below is 048's, unchanged except for the marked insert.

create or replace function public.execution_spawn(
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
    -- ADDED IN 111. The durable half of the same fact. Inside the loop and
    -- inside this transaction, so a task cannot end up naming an assignee for a
    -- session that was rolled back.
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (p_space_id, task_id, p_team_member_id, 'assigned_to',
            jsonb_build_object('via', 'spawn'), actor)
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

-- `create or replace` keeps 048's grants; restated so a reader of this file
-- alone does not have to go and check that it did.
revoke all on function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid
) from public;
grant execute on function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid
) to tm8_app;
