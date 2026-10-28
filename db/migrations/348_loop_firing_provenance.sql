-- =============================================================================
-- 348 — A LOOP FIRING REACHES ITS ARMED-BY ROOT (the ordering fix 343 filed).
--
-- 343 made `loops.armed_by_member_id` the provenance root of a schedule firing,
-- and `internal.mcp_provenance` reads it off the firing session's `triggered_by`
-- edge. That branch was UNREACHABLE ON A FIRST FIRING, and 343's own header says
-- why: `createLoopExecutorPort.fire` wrote the session's edge AFTER
-- `spawnService.spawn` returned, and the MCP bind runs INSIDE that spawn. At
-- bind time a firing had no edge to its loop, so every firing fell through to
-- the no-bearer branch and was lent no connector that needs an account. That
-- failed closed (#1316's behaviour), so there was nothing to chase — but it also
-- meant the schedule root 343 built could never actually be used.
--
-- This migration moves the write. Two of the task's three criteria are here; the
-- third is the test that proves the branch is now reachable.
--
-- 1. THE LOOP ID REACHES BIND AS A SERVER FACT.
--
--    It is a new argument to `execution_spawn`, supplied only by the in-process
--    loop executor. It is deliberately NOT a field of `SpawnRequest`: the
--    executor passes it through a separate server-facts parameter on
--    `SpawnService.spawn` that the public facade never fills. And
--    `ExecutionSpawnInputSchema` is `.strict()`, so a client that invents the
--    field on the wire is REFUSED by the schema rather than quietly ignored.
--    Both halves matter — "strips or refuses it" is the acceptance criterion,
--    and a strict schema refuses.
--
-- 2. THE EDGE IS WRITTEN IN THIS TRANSACTION, AND A FAILURE ABORTS THE SPAWN.
--
--    Beside `launched_by` (330), with no exception handler and no
--    `on conflict do nothing`. This is the part that is easy to get wrong by
--    being helpful: the executor's existing `writeTriggeredBy` swallows every
--    failure, and 343's reasoning for giving a schedule NO second tier depends
--    on that not being true here. A swallowed failure would leave a firing that
--    looks successful but has no root — exactly the silent fall-through B21
--    declined to build a fallback for. So it aborts, and the spawn with it.
--
--    The TASK's edge (task -> loop) stays best-effort in the executor. It is run
--    history, not an authority, and a firing that dies mid-spawn should still
--    show up in the loop's history.
--
-- 3. The signature therefore changes, so the 20-argument form is DROPPED rather
--    than left beside this one: two overloads both reachable by twenty
--    arguments is `function is not unique`. 267 and 294 did the same.
--
-- The body below is 330's verbatim, plus the one block marked 348.
-- =============================================================================

drop function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid, text, uuid, uuid
);

CREATE FUNCTION public.execution_spawn(p_space_id uuid, p_team_member_id uuid, p_task_ids uuid[] DEFAULT '{}'::uuid[], p_project_id uuid DEFAULT NULL::uuid, p_workdir_mode text DEFAULT 'project'::text, p_workdir_path text DEFAULT NULL::text, p_base_ref text DEFAULT NULL::text, p_mode text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_agent_tool text DEFAULT NULL::text, p_title text DEFAULT NULL::text, p_node_id text DEFAULT NULL::text, p_confirm_untrusted boolean DEFAULT false, p_session_cap integer DEFAULT 8, p_actor_id uuid DEFAULT NULL::uuid, p_client_mutation_id text DEFAULT NULL::text, p_parent_session_id uuid DEFAULT NULL::uuid, p_new_task_title text DEFAULT NULL::text, p_story_id uuid DEFAULT NULL::uuid, p_source_work_session_id uuid DEFAULT NULL::uuid, p_triggered_by_loop_id uuid DEFAULT NULL::uuid)
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
  loop_entity public.entities;
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
    p_space_id, 'work_session', actor, null, null
  );
  -- 330: WHO LAUNCHED IT is the `launched_by` edge (session -> chat or
  -- session), never parent_id: a parent and its child share one kind, and a
  -- chat is not a session. Written here, in the spawn's transaction, by the
  -- spawn writer (the only writer besides a logged migration).
  if p_parent_session_id is not null then
    perform internal.w1_set_writer('spawn');
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, session_id, p_parent_session_id, 'launched_by', actor);
    perform internal.w1_set_writer(null);
  end if;

  /*
   * 348 — THE FIRING'S PROVENANCE EDGE, written HERE.
   *
   * `bind` runs inside this spawn, and `internal.mcp_provenance` (343) reads
   * the schedule root off exactly this edge. Written after the session envelope
   * and before anything that can be observed outside this transaction, so a
   * firing that reaches bind always has it.
   *
   * NO `on conflict do nothing`, and NO exception handler: ac2. The session id
   * was minted two statements ago, so a conflict is impossible by construction
   * and a failure here means a fact the §6 derivation depends on could not be
   * recorded. A spawn that proceeded anyway would be a rootless firing that
   * looks successful — the silent fall-through B21 declined to build a fallback
   * tier for. It aborts instead, and the whole spawn with it.
   *
   * Only the IN-PROCESS loop executor can reach this argument: it is not a
   * field of `SpawnRequest`, and `ExecutionSpawnInputSchema` is `.strict()`, so
   * a client that sends one is refused by the wire schema.
   */
  if p_triggered_by_loop_id is not null then
    loop_entity := internal.live_entity(p_triggered_by_loop_id, 'loop');
    if loop_entity.space_id <> p_space_id then
      raise exception 'loop belongs to another space' using errcode = '22023';
    end if;
    /*
     * 347's MARKER, and the writer that is allowed to set it.
     *
     * `props.provenance` is what makes this edge an AUTHORITY rather than a
     * claim: 347 narrowed the §6 schedule branch to marked edges only, because
     * `write_edge` authorizes on Space membership alone and any member could
     * otherwise attach their own session to a loop armed by someone else. The
     * marker is refused to every writer but `spawn`, so the writer is set here
     * exactly as `launched_by` does it above.
     */
    perform internal.w1_set_writer('spawn');
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (p_space_id, session_id, p_triggered_by_loop_id, 'triggered_by',
            jsonb_build_object('provenance', true,
                               'firedAt', to_char(now() at time zone 'utc',
                                                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
            actor);
    perform internal.w1_set_writer(null);
  end if;
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
  -- written here by spawn itself (writer `spawn`). 309: the legacy duplicate
  -- `relates_to` session -> teammate is no longer written.
  perform internal.w1_set_writer('spawn');
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (p_space_id, p_team_member_id, session_id, 'participates_in', actor)
  on conflict (src_id, dst_id, type) do nothing;
  perform internal.w1_set_writer(null);

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

revoke all on function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid, text, uuid, uuid, uuid
) from public;

grant execute on function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid, text, uuid, uuid, uuid
) to tm8_app;
