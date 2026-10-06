-- =============================================================================
-- 309 — Canonical edges, part C: the session's teammate is participates_in
-- only (P0b, task 01a10c66; owner decision Q2 on form 01a111b8-e840).
--
-- Spawn wrote the session's teammate twice: participates_in (teammate ->
-- session, 303) and the legacy relates_to (session -> teammate) that 065's
-- trigger derived participates_in from. Every reader has moved:
-- execution_resume (#1056/302), the server's teammate readers (#1071/303), and
-- here the last SQL reader, repoint_session_space_credentials, whose resume
-- authorization would otherwise silently stop checking the persona.
--
--   1. repoint_session_space_credentials reads participates_in.
--   2. execution_spawn stops writing the relates_to duplicate.
--   3. 065's derive trigger goes: nothing derives participates_in from a
--      relates_to any more (a hand-drawn see-also is just a see-also).
--   4. Every relates_to work_session -> team_member row moves through
--      internal.migrate_edge (batch 'p0b-309', logged, reversible): deleted
--      when the matching participates_in exists, otherwise rewritten into it.
--      The story subgraph cannot change (neither type is walked); checked.
-- =============================================================================

create temp table p0b_309_before as
  select s.id as story_id, t.entity_id, t.root_id
    from public.entities s
    cross join lateral internal.story_trail(s.id) t
   where s.kind = 'story' and s.deleted_at is null;

-- -----------------------------------------------------------------------------
-- 1. Resume authorization reads the session's teammate from participates_in.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.repoint_session_space_credentials(p_work_session_id uuid, p_providers text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  e public.entities;
  v_status text;
  v_persona uuid;
begin
  e := internal.live_entity(p_work_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  if internal.current_account_id() is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  -- F-R13a: the resume window only, under the row lock execution_resume (062)
  -- takes. 'spawning' is entered by the spawn insert and by execution_resume
  -- alone (work_session_transition refuses it), and a fresh spawn never
  -- re-points, so 'spawning' with a resume on record IS the resume window.
  select status into v_status from public.work_sessions
   where entity_id = p_work_session_id for update;
  if v_status is distinct from 'spawning'
     or not exists (select 1 from public.activity a
                     where a.entity_id = p_work_session_id and a.verb = 'restored'
                       and a.summary ->> 'action' = 'resumed') then
    raise exception 'only a session being resumed can be re-pointed' using errcode = '55000';
  end if;
  -- Resume's authorization, not bare membership: the caller may act as the
  -- session's persona, exactly as execution_resume requires.
  -- 309: the session's teammate is `participates_in` (teammate -> session);
  -- the legacy relates_to duplicate it used to read is gone.
  select src_id into v_persona from public.edges
   where dst_id = p_work_session_id and type = 'participates_in'
   limit 1;
  if v_persona is not null and not internal.can_act_as(v_persona, e.space_id) then
    raise exception 'not permitted to resume this persona' using errcode = '42501';
  end if;
  delete from public.session_space_credentials
   where work_session_id = p_work_session_id
     and provider <> all (coalesce(p_providers, array[]::text[]));
  return public.repoint_session_space_credentials(p_work_session_id);
end
$function$
;

-- -----------------------------------------------------------------------------
-- 2. Spawn writes participates_in only.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 3. Nothing derives participates_in from relates_to any more.
-- -----------------------------------------------------------------------------
-- The function stays (the chain-catalog pin expects every declared object);
-- with no trigger it is never called.
drop trigger if exists edges_derive_participant on public.edges;

-- -----------------------------------------------------------------------------
-- 4. The rows.
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
  deleted integer := 0;
  rewritten integer := 0;
begin
  for r in
    select e.id, e.src_id, e.dst_id
      from public.edges e
      join public.entities s on s.id = e.src_id and s.kind = 'work_session'
      join public.entities t on t.id = e.dst_id and t.kind = 'team_member'
     where e.type = 'relates_to'
     order by e.id
  loop
    if exists (select 1 from public.edges p
                where p.type = 'participates_in' and p.src_id = r.dst_id and p.dst_id = r.src_id) then
      perform internal.migrate_edge('p0b-309', 'Q2 duplicate of participates_in', r.id, null, null, null, 'owner');
      deleted := deleted + 1;
    else
      perform internal.migrate_edge('p0b-309', 'Q2 session teammate, only recorded as relates_to',
                                    r.id, 'participates_in', r.dst_id, r.src_id, 'owner');
      rewritten := rewritten + 1;
    end if;
  end loop;
  raise notice '309: % duplicate relates_to rows deleted, % rewritten to participates_in', deleted, rewritten;
end
$$;

do $$
declare
  lost integer;
begin
  select count(*) into lost
    from p0b_309_before b
   where not exists (select 1 from public.entities s
                       cross join lateral internal.story_trail(s.id) t
                      where s.id = b.story_id and t.entity_id = b.entity_id and t.root_id = b.root_id);
  if lost > 0 then
    raise exception '309 would remove % entity/root pairs from story subgraphs; nothing was changed', lost
      using errcode = '23514';
  end if;
end
$$;

-- Plain temp tables (not ON COMMIT DROP): a runner that applies this file
-- statement by statement must still see them; dropped here.
drop table if exists p0b_309_before;
