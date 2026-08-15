-- 131 — spawning a session on a task MOVES that task to `working`.
--
-- THE OBSERVATION THIS FIXES. A task with a live session on it still reads
-- `open` on the board. The task this migration was written for is itself the
-- example: `entity context` returned `state.workStatus: "open"` and, in the
-- same payload, a `badges.workingActors` entry naming the session that was at
-- that moment editing this file. Two answers to "is anyone on this?" in one
-- response, disagreeing.
--
-- WHY THE BADGE WAS NOT ALREADY ENOUGH. `badges.workingActors` is DERIVED, and
-- deliberately so: entity-read.ts:804-839 recomputes it per read and keeps a
-- session-sourced `working_on` edge only while `work_sessions.status` is
-- spawning/running/idle. That is the right rule for a live badge and the wrong
-- one for a board. The moment the session exits, the badge evaporates and the
-- task returns to reading `open` — as though the work had never started. The
-- durable statement of the same fact is `tasks.work_status`, which nothing on
-- the spawn path has ever written.
--
-- THIS IS 111's SIBLING, and the reasoning there transfers verbatim. 111 added
-- the durable ASSIGNMENT (`assigned_to`) next to the live one (`working_on`)
-- for exactly this reason: "`working_on` hangs off a work_session, so it says
-- 'this PROCESS is on it' and it is only as meaningful as that process is
-- alive." Assignment answered "whose is it"; this answers "has it started".
--
-- WHY IN THE RPC. Same as 111: the session row, the `working_on` edge, the
-- assignment and now the status are four statements of one act, and 048 already
-- binds the first two to a single transaction. A spawn that half-lands must not
-- leave a task claiming to be in progress for a session that was never created.
--
-- WHY ONLY `open` AND `pulled` (owner ruling, 2026-08-16). The other five
-- statuses are deliberate human statements and a spawn is not entitled to
-- overwrite them:
--   - `done` / `cancelled` are terminal. entity-read.ts:1417 ALREADY suppresses
--     the workingActors badge on them, so promoting them here would make this
--     door contradict the read model it is trying to agree with.
--   - `blocked` names an obstacle. Clearing it because someone launched an
--     agent to LOOK at the obstacle destroys the only record of it.
--   - `in_review` is downstream of working. A session spawned to address review
--     feedback must not walk the task backwards.
--   - `working` is already the answer; the `where` clause makes the write a
--     no-op rather than a version bump and a feed row on every re-spawn.
--
-- WHY NOTHING MOVES IT BACK (owner ruling). The status is durable by design —
-- it outlives the session, which is the entire point of writing it. A crashed
-- session therefore leaves a task reading `working` with nobody on it; that is
-- accepted, and it is exactly the state a human already reaches by pressing
-- Start and closing their laptop. The live half stays derived and self-clearing.
--
-- WHY IT RECORDS `work.changed` (owner ruling). Identical verb and summary
-- shape to `set_work_state` (060:71), so a reader of the task's feed sees the
-- same event whether a human pressed Start or a spawn did it for them. `via`
-- distinguishes the two, mirroring 111's `props.via = 'spawn'` on the
-- assignment. A status that changes with no trace is the worse failure.
--
-- The `if found` gate is what keeps the feed honest: `FOUND` after an UPDATE
-- reflects the `where` clause, so a task that was already `working`, or was
-- `blocked`, records nothing at all.
--
-- The body below is 111's, unchanged except for the marked block.
--
-- ⚠ MERGE HAZARD. `origin/feat/assigned-by-provenance` (unmerged as of
-- 2026-08-16) ALSO issues `create or replace function public.execution_spawn`,
-- in its own `129_task_assignment_provenance.sql`. Whichever of the two lands
-- second silently reverts the first — there is no conflict marker for this,
-- because the two files never touch. Whoever merges second must union the two
-- bodies rather than take either whole.

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
    -- ADDED IN 131. The task has started. The `where` is the whole rule: only a
    -- task that has not started yet can be started, so the five other statuses
    -- pass through untouched and a re-spawn of an already-`working` task is a
    -- silent no-op rather than a version bump. `tasks_snapshot_version`
    -- (001:1179) carries the entities.version bump, so this door does not.
    update public.tasks
       set work_status = 'working', updated_at = now()
     where entity_id = task_id
       and work_status in ('open', 'pulled');
    if found then
      perform internal.record_activity(p_space_id, task_id, actor, 'work.changed', null,
        jsonb_build_object('status', 'working', 'via', 'spawn'));
    end if;
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
