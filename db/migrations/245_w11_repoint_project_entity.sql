-- =============================================================================
-- 245 — W11-repoint: chats, work_sessions and worktrees point at the space's
-- project ENTITY; the folder column project_id is dropped (plan 01a0d9eb W11).
--
-- OWNER STEP. IRREVERSIBLE: the three project_id columns are DROPPED. GATE:
-- 235 applied, its row counts verified against this file's dry run (residue
-- 0/0/0, 0 CHECK violators: the CHECKs below validate EXISTING rows), then
-- 245. Read internal.node_policy first: 'shared' skips the sharing refusal.
-- Run it only after W11-migrate's real run (#856), and dry-run it first with
--   node packages/server/dist/projects/w11-repoint-cli.js --dry-run
-- which applies this file inside a transaction, prints before/after counts and
-- rolls back. The RUNBOOK is in the PR that carries this file.
--
-- WHAT KEEPS ITS MEANING. The folder id stays the API's project id (Q4, option
-- i): execution_spawn / start_shell_session / start_chat / create_worktree /
-- unlink_project still TAKE a folder id, and every reader that used to return
-- project_id returns the folder again. Both directions resolve through ONE
-- resolver, internal.project_link_resolve(space, ref), over project_links in
-- the ROW's space. A folder mapped to more than one entity in one space is
-- refused there with 22023 (invalid_input), never guessed.
--
-- REFUSES (one error naming every failing check, 23514) unless, at run time:
--   * every row with a folder has its entity, and the entity's folder IS that
--     folder (no residue, no mismatch);
--   * every worktree has space_id and project_entity_id;
--   * no folder is granted to more than one space (the W11-migrate real run
--     ends sharing; the message names each folder and its space count) —
--     skipped only where internal.project_folders_shared() (234, decision 29)
--     is true: a loopback-only node the server booted with 'shared';
--   * no (project_entity_id, branch) pair repeats among worktrees;
--   * no (space, folder) maps to two entities;
--   * no row violates the CHECKs added below (ids listed).
--
-- BEHAVIOUR CHANGES (flagged in the PR):
--   * worktrees_project_id_branch_key unique(project_id, branch) goes with the
--     column. 234's unique(space_id, project_entity_id, branch) stays, so what
--     is lost is only the cross-space-per-folder key; git's own one-worktree-
--     per-branch rule still refuses a second checkout of one branch in one
--     repository before create_worktree is called.
--   * the three project_entity_id FKs become ON DELETE RESTRICT (234 declared
--     SET NULL): a project entity with rows pointing at it cannot be hard-
--     deleted. Nothing in the product hard-deletes entities or spaces; a
--     hard delete of a space would now have to delete its worktrees first.
--   * worktrees.project_entity_id is NOT NULL.
--
-- NOT CHANGED: work_sessions.workdir_mode keeps its default 'project'
-- (001:700); the credential writers (183, 206) still rely on it, and so the
-- CHECK exempts session_kind 'credential' (follow-up 01a0db65: drop the
-- default and the exemption together).
-- =============================================================================

set local lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 0. Preflight. Nothing below runs unless every check is zero.
-- -----------------------------------------------------------------------------
do $preflight$
declare
  problems text[] := '{}';
  n integer;
  ids text;
begin
  -- Residue: a folder with no entity, or an entity whose folder is another.
  select count(*) into n from public.chats c
   where c.project_id is not null
     and not exists (select 1 from public.project_links l
                      where l.project_entity_id = c.project_entity_id
                        and l.space_id = c.space_id and l.project_id = c.project_id);
  if n > 0 then problems := problems || format('chats: %s row(s) whose folder has no matching entity', n); end if;

  select count(*) into n from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where ws.project_id is not null
     and not exists (select 1 from public.project_links l
                      where l.project_entity_id = ws.project_entity_id
                        and l.space_id = e.space_id and l.project_id = ws.project_id);
  if n > 0 then problems := problems || format('work_sessions: %s row(s) whose folder has no matching entity', n); end if;

  select count(*) into n from public.worktrees w
   where not exists (select 1 from public.project_links l
                      where l.project_entity_id = w.project_entity_id
                        and l.space_id = w.space_id and l.project_id = w.project_id);
  if n > 0 then problems := problems || format('worktrees: %s row(s) whose folder has no matching entity (or no space/entity)', n); end if;

  -- Sharing: the W11-migrate real run must have ended it — unless this node's
  -- decision-29 policy (234) says 'shared'. That value is a boot-time posture
  -- written only by the server (src/projects/node-policy.ts writeNodePolicy);
  -- no row, or any other value, refuses (fail-closed, 234:181-182).
  if not internal.project_folders_shared() then
    select count(*), string_agg(format('%s "%s" in %s spaces', s.project_id, p.name, s.spaces), '; ' order by s.project_id)
      into n, ids
      from (select project_id, count(*) spaces from public.space_projects
             group by project_id having count(*) > 1) s
      join public.projects p on p.id = s.project_id;
    if n > 0 then problems := problems || format('%s folder(s) granted to more than one space: %s', n, ids); end if;
  end if;

  select count(*) into n from (
    select 1 from public.worktrees group by project_entity_id, branch having count(*) > 1) d;
  if n > 0 then problems := problems || format('worktrees: %s (project_entity_id, branch) collision(s)', n); end if;

  select count(*) into n from (
    select 1 from public.project_links group by space_id, project_id having count(*) > 1) d;
  if n > 0 then problems := problems || format('project_links: %s (space, folder) pair(s) with more than one entity', n); end if;

  -- The CHECKs below, before they are added.
  select count(*), string_agg(ws.entity_id::text || ' (' || ws.session_kind || '/' || ws.workdir_mode || ')', ', ' order by ws.entity_id)
    into n, ids
    from public.work_sessions ws
   where not (ws.session_kind = 'credential'
              or ws.workdir_mode in ('scratch', 'container')
              or ws.project_entity_id is not null);
  if n > 0 then problems := problems || format('work_sessions: %s row(s) violate work_sessions_project_entity_check: %s', n, ids); end if;

  select count(*), string_agg(c.entity_id::text, ', ' order by c.entity_id) into n, ids
    from public.chats c
   where not ((c.workdir_mode = 'scratch' and c.project_entity_id is null)
              or (c.workdir_mode <> 'scratch' and c.project_entity_id is not null));
  if n > 0 then problems := problems || format('chats: %s row(s) violate the chats project CHECKs: %s', n, ids); end if;

  if cardinality(problems) > 0 then
    raise exception E'W11-repoint (245) refused:\n  - %', array_to_string(problems, E'\n  - ')
      using errcode = '23514', detail = 'w11_repoint_preflight',
            hint = 'Run the W11-migrate real run and the RUNBOOK steps first; the dry run lists every row.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- 1. The resolver. One path, both directions, in the row's space.
-- -----------------------------------------------------------------------------
set role tm8_graph_owner;

create or replace function internal.project_link_resolve(p_space_id uuid, p_ref uuid)
returns table (folder_id uuid, project_entity_id uuid)
language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare hits integer;
begin
  return query
    select link.project_id, link.project_entity_id
      from public.project_links link
     where link.space_id = p_space_id
       and (link.project_id = p_ref or link.project_entity_id = p_ref);
  get diagnostics hits = row_count;
  if hits > 1 then
    raise exception 'project reference % is ambiguous in space %', p_ref, p_space_id
      using errcode = '22023', detail = 'project_ref_ambiguous';
  end if;
end
$$;
revoke all on function internal.project_link_resolve(uuid, uuid) from public;

-- 234's name, now through the resolver: the entity for a folder, or null.
create or replace function internal.project_entity_for(p_space_id uuid, p_folder_id uuid)
returns uuid language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select r.project_entity_id from internal.project_link_resolve(p_space_id, p_folder_id) r
$$;
revoke all on function internal.project_entity_for(uuid, uuid) from public;

-- The folder a row's project entity stands for — what every reader that used
-- to select project_id returns now (launchProjectId, chat/worktree projectId).
create or replace function internal.project_folder_for(p_space_id uuid, p_project_entity_id uuid)
returns uuid language sql stable strict security definer
set search_path = public, internal, pg_temp as $$
  select r.folder_id from internal.project_link_resolve(p_space_id, p_project_entity_id) r
$$;
revoke all on function internal.project_folder_for(uuid, uuid) from public;
grant execute on function internal.project_folder_for(uuid, uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- 2. The fill triggers go: every writer names the entity itself.
-- -----------------------------------------------------------------------------
drop trigger chats_fill_project_entity on public.chats;
drop trigger work_sessions_fill_project_entity on public.work_sessions;
drop function internal.fill_project_entity_ref();
drop trigger work_sessions_launch_project_immutable on public.work_sessions;

-- -----------------------------------------------------------------------------
-- 3. Writers and readers, whole bodies. Each is the live body with project_id
--    replaced by project_entity_id (writers resolve the folder argument once,
--    readers map the entity back to its folder). A later file replacing any
--    of them must carry these changes.
-- -----------------------------------------------------------------------------
reset role;

-- execution_spawn and start_shell_session are owned by the migration role, not
-- tm8_graph_owner (live catalog); re-created without switching role so they
-- keep their owner.

create or replace function public.execution_spawn(p_space_id uuid, p_team_member_id uuid, p_task_ids uuid[] DEFAULT '{}'::uuid[], p_project_id uuid DEFAULT NULL::uuid, p_workdir_mode text DEFAULT 'project'::text, p_workdir_path text DEFAULT NULL::text, p_base_ref text DEFAULT NULL::text, p_mode text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_agent_tool text DEFAULT NULL::text, p_title text DEFAULT NULL::text, p_node_id text DEFAULT NULL::text, p_confirm_untrusted boolean DEFAULT false, p_session_cap integer DEFAULT 8, p_actor_id uuid DEFAULT NULL::uuid, p_client_mutation_id text DEFAULT NULL::text, p_parent_session_id uuid DEFAULT NULL::uuid)
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
  project_entity uuid;
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
    -- 245: the row stores the space's project ENTITY; the folder id stays the
    -- argument (Q4 option i) and is resolved in this space, once.
    project_entity := internal.project_entity_for(p_space_id, p_project_id);
    if project_entity is null then
      raise exception 'project has no project entity in this space' using errcode = 'P0002',
        detail = 'project_not_projected';
    end if;
  elsif coalesce(p_workdir_mode, 'project') = 'worktree' then
    raise exception 'worktree mode requires a project' using errcode = '22023';
  end if;

  session_id := internal.create_envelope(
    p_space_id, 'work_session', actor, p_parent_session_id, null
  );
  insert into public.work_sessions(entity_id, title, node_id, project_entity_id, workdir_mode,
                                   workdir_path, base_ref, status, agent_tool, model, mode)
  values (session_id, coalesce(p_title, ''), p_node_id, project_entity,
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
$function$;

create or replace function public.start_shell_session(p_space_id uuid, p_project_id uuid DEFAULT NULL::uuid, p_title text DEFAULT NULL::text, p_node_id text DEFAULT NULL::text, p_workdir_path text DEFAULT NULL::text, p_confirm_untrusted boolean DEFAULT false, p_session_cap integer DEFAULT 4, p_actor_id uuid DEFAULT NULL::uuid, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  replay jsonb;
  actor uuid;
  project public.projects;
  session_id uuid;
  project_entity uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.terminal.start');
  if replay is not null then
    return replay || jsonb_build_object('__tm8_replayed', true);
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  if internal.shell_session_count(null) >= greatest(coalesce(p_session_cap, 4), 1) then
    raise exception 'terminal concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_session_cap,
                                  'live', internal.shell_session_count(null))::text;
  end if;

  -- The same three project gates spawn applies, in the same order. A terminal
  -- is a shell prompt in that directory: if the project is not trusted, the
  -- consent it needs is the same consent, not a lesser one.
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
      raise exception 'opening a terminal in an untrusted project requires explicit confirmation'
        using errcode = '42501',
              detail = jsonb_build_object('projectId', p_project_id, 'trust', project.trust)::text;
    end if;
    -- 245: resolved in this space through the one resolver, as spawn does.
    project_entity := internal.project_entity_for(p_space_id, p_project_id);
    if project_entity is null then
      raise exception 'project has no project entity in this space' using errcode = 'P0002',
        detail = 'project_not_projected';
    end if;
  end if;

  -- A ROOT, ALWAYS. `execution_spawn` takes `p_parent_session_id` so an agent
  -- can record the session it spawned; a vanilla terminal is started by a human
  -- from the UI and has no spawning session to descend from.
  session_id := internal.create_envelope(p_space_id, 'work_session', actor, null, null);
  -- `workdir_path` IS RECORDED, and NULL when it genuinely cannot be. A
  -- projectless terminal's directory is named for the session id, which does
  -- not exist until the line above runs — the same chicken-and-egg
  -- `execution_spawn` has, and it resolves it by writing the scratch ROOT with
  -- a literal `pending` on the end. A row saying `.../pending` is a path no
  -- process ever had; NULL says "not recorded", which is true and which a
  -- reader can act on. The project case has a real answer and gets it.
  insert into public.work_sessions(entity_id, title, node_id, project_entity_id, workdir_mode,
                                   workdir_path, status, session_kind)
  values (session_id, coalesce(nullif(btrim(p_title), ''), 'Terminal'), p_node_id,
          project_entity,
          -- DERIVED, never 'project' unconditionally. A projectless terminal
          -- that claimed `workdir_mode = 'project'` with a NULL project and
          -- a NULL workdir_path renders in the UI as a project working
          -- directory with no directory, and is the exact combination
          -- `bootstrap-manifest.ts` rejects.
          case when p_project_id is null then 'scratch' else 'project' end,
          p_workdir_path, 'spawning', 'shell');

  return internal.ledger_record(p_client_mutation_id, 'execution.terminal.start',
           internal.command_result(session_id, null,
             internal.record_activity(p_space_id, session_id, actor, 'created', null,
               jsonb_build_object(
                 'kind', 'work_session',
                 'sessionKind', 'shell'
               )),
             array[session_id])) || jsonb_build_object('__tm8_replayed', false);
end
$function$;

set role tm8_graph_owner;

create or replace function public.start_container_exec_session(p_container_id uuid, p_title text DEFAULT NULL::text, p_actor_id uuid DEFAULT NULL::uuid, p_cols integer DEFAULT NULL::integer, p_rows integer DEFAULT NULL::integer, p_cap integer DEFAULT 8, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  replay        jsonb;
  e             public.entities;
  container_row public.containers;
  actor         uuid;
  session_id    uuid;
  live_count    integer;
  exec_workdir  text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'containers.terminal.start');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    -- Bound to the CONTAINER, not to the session: the session id is minted by
    -- this call, so it cannot be the thing a replay is checked against. The
    -- container is the resource the caller addressed.
    perform internal.require_replay_subject(
      replay #>> '{containerId}', p_container_id::text, 'container');
    return replay;
  end if;

  if p_cols is not null and p_cols not between 1 and 1000 then
    raise exception 'terminal columns must be in 1..1000' using errcode = '22023';
  end if;
  if p_rows is not null and p_rows not between 1 and 1000 then
    raise exception 'terminal rows must be in 1..1000' using errcode = '22023';
  end if;

  e := internal.live_entity(p_container_id, 'container');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  select * into container_row from public.containers where entity_id = p_container_id;
  if container_row.status <> 'running' then
    raise exception 'a container must be running to exec into it (status %)', container_row.status
      using errcode = '23514';
  end if;

  -- Exec is control (Design §12.4): the creator, or an actor named by a
  -- `controls` edge the creator wrote.
  if not internal.can_act_as(e.created_by, e.space_id)
     and not exists (
       select 1 from public.edges edge
        where edge.dst_id = p_container_id
          and edge.type = 'controls'
          and edge.src_id = internal.current_member_id(e.space_id)) then
    raise exception 'exec access is limited to the machine''s owner and its controllers'
      using errcode = '42501';
  end if;

  live_count := internal.container_exec_session_count(container_row.node_id);
  if live_count >= greatest(coalesce(p_cap, 8), 1) then
    raise exception 'container exec concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_cap, 'live', live_count,
                                  'nodeId', container_row.node_id)::text;
  end if;

  -- `spec.workdir` is guest-side and already validated absolute by the create
  -- door's mount rules; the column CHECK (absolute, no `..`) is the backstop.
  exec_workdir := coalesce(nullif(btrim(coalesce(container_row.spec->>'workdir', '')), ''),
                           '/workspace');

  -- A ROOT, ALWAYS — 101's reasoning: the exec terminal is opened by a person
  -- or an agent against a machine, not descended from a spawning session.
  session_id := internal.create_envelope(e.space_id, 'work_session', actor, null, null);
  insert into public.work_sessions(entity_id, title, node_id, workdir_mode,
                                   workdir_path, status, session_kind)
  values (session_id, coalesce(nullif(btrim(p_title), ''), 'Terminal'),
          container_row.node_id, 'container',
          exec_workdir, 'spawning', 'container_exec');

  -- The binding edge. `runs_in` is the claim that this session's process tree
  -- executes INSIDE that machine — which is what lets the container reconciler
  -- end the session when the runtime goes (Design §8.3).
  insert into public.edges(space_id, src_id, dst_id, type, created_by, props)
  values (e.space_id, session_id, p_container_id, 'runs_in', actor,
          jsonb_build_object('launcher', 'container_exec'))
  on conflict (src_id, dst_id, type) do nothing;

  return internal.ledger_record(p_client_mutation_id, 'containers.terminal.start',
           jsonb_build_object(
             'sessionId', session_id,
             'containerId', p_container_id,
             'cols', p_cols,
             'rows', p_rows,
             'commandResult', internal.command_result(session_id, null,
               internal.record_activity(e.space_id, session_id, actor, 'created', null,
                 jsonb_build_object('kind', 'work_session',
                                    'sessionKind', 'container_exec',
                                    'containerId', p_container_id)),
               array[session_id, p_container_id])));
end
$function$;

create or replace function public.start_chat(p_chat_id uuid, p_space_id uuid, p_teammate_id uuid, p_model text, p_provider text, p_agent_tool text, p_chat_mode text, p_workdir_mode text, p_project_id uuid, p_native_session_id uuid, p_cwd text, p_title text, p_body text, p_attachment_ids uuid[], p_about_id uuid, p_client_mutation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  replay jsonb;
  member_id uuid;
  request_hash text;
  stored_hash text;
  resolved_cwd text;
  resolved_title text;
  about_entity public.entities;
  posted jsonb;
  message_id uuid;
  result jsonb;
  project_entity uuid;
begin
  perform internal.require_identity();
  perform internal.require_human_auth_kind();
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;
  if p_chat_id is null then
    raise exception 'chat id is required' using errcode = '22023';
  end if;
  if p_model is null or btrim(p_model) = ''
     or p_provider is null or btrim(p_provider) = ''
     or p_agent_tool is null or btrim(p_agent_tool) = '' then
    raise exception 'model, provider, and agent tool are required' using errcode = '22023';
  end if;
  if p_chat_mode not in ('ask', 'explain', 'plan', 'build', 'orchestrate', 'craft') then
    raise exception 'invalid chat mode' using errcode = '22023';
  end if;
  if p_workdir_mode is null or p_workdir_mode not in ('project', 'scratch') then
    raise exception 'workdir mode must be project or scratch' using errcode = '22023';
  end if;
  if p_native_session_id is null then
    raise exception 'native session id is required' using errcode = '22023';
  end if;
  if p_body is null or char_length(p_body) not between 1 and 10000 then
    raise exception 'the opening message must contain 1..10000 characters' using errcode = '22023';
  end if;

  -- WHAT IS *NOT* IN THE HASH: `p_chat_id`.
  --
  -- The hash answers "is this the same logical request", and the chat id is not
  -- part of one — it is minted per ATTEMPT by the handler, because the scratch
  -- directory has to be named before this function runs. Including it would
  -- make every genuine retry of the same clientMutationId hash DIFFERENTLY and
  -- come back as `23514 chat start replay does not match the original request`,
  -- for a request that is logically identical to the one that succeeded. That
  -- is the trap 167's deploy-window fallback was written to escape, and this is
  -- the version of it that would ship broken from day one rather than for one
  -- release. Measured: the storage suite caught it on the first run.
  --
  -- The ledger returns the ORIGINAL result, so a retry gets the chat that
  -- exists and quietly discards its throwaway candidate id. The candidate's
  -- empty scratch directory is the only residue, and an empty directory is a
  -- better outcome than a caller that can never learn its own chat's id.
  request_hash := internal.w2_sha256(jsonb_build_object(
    'identityId', internal.identity_id(),
    'spaceId', p_space_id,
    'teammateId', p_teammate_id,
    'model', p_model,
    'provider', p_provider,
    'agentTool', p_agent_tool,
    'mode', p_chat_mode,
    'projectId', p_project_id,
    'workdirMode', p_workdir_mode,
    'aboutId', p_about_id
  ));
  replay := internal.ledger_replay(p_client_mutation_id, 'chat.start');
  if replay is not null then
    stored_hash := replay ->> '_requestHash';
    if stored_hash is distinct from request_hash then
      raise exception 'chat start replay does not match the original request'
        using errcode = '23514', detail = 'chat_start_identity_mismatch';
    end if;
    return replay;
  end if;

  perform internal.require_space_member(p_space_id);
  member_id := internal.current_member_id(p_space_id);
  if member_id is null then
    raise exception 'requesting identity is not a member of this space' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.team_members tm
    join public.entities teammate on teammate.id = tm.entity_id
    where tm.entity_id = p_teammate_id
      and teammate.space_id = p_space_id
      and teammate.deleted_at is null
  ) then
    raise exception 'chat teammate not found in this space' using errcode = 'P0002';
  end if;

  -- 167's resolution rule, unchanged: for `project` the path is READ from the
  -- linked project inside this function and `p_cwd` is ignored, so a caller can
  -- never pair a linked project id with somebody else's directory. The Space
  -- link is checked explicitly because SECURITY DEFINER does not evaluate RLS
  -- on `space_projects`.
  if p_workdir_mode = 'project' then
    if p_project_id is null then
      raise exception 'project mode requires a project id' using errcode = '22023';
    end if;
    select p.working_dir into resolved_cwd
      from public.projects p
      join public.space_projects sp on sp.project_id = p.id
     where p.id = p_project_id and sp.space_id = p_space_id;
    if resolved_cwd is null then
      raise exception 'project is not linked to this space' using errcode = 'P0002';
    end if;
    -- 245: the chat row stores the space's project ENTITY; p_project_id stays
    -- the folder (it is in the request hash and in every stored replay).
    project_entity := internal.project_entity_for(p_space_id, p_project_id);
    if project_entity is null then
      raise exception 'project has no project entity in this space' using errcode = 'P0002',
        detail = 'project_not_projected';
    end if;
  else
    if p_project_id is not null then
      raise exception 'scratch mode does not take a project id' using errcode = '22023';
    end if;
    if p_cwd is null or left(p_cwd, 1) <> '/' then
      raise exception 'scratch mode requires an absolute cwd' using errcode = '22023';
    end if;
    resolved_cwd := p_cwd;
  end if;

  if p_about_id is not null then
    about_entity := internal.live_entity(p_about_id);
    if about_entity.space_id <> p_space_id then
      raise exception 'the subject of a chat must live in the same space' using errcode = '22023';
    end if;
  end if;

  resolved_title := left(coalesce(nullif(btrim(coalesce(p_title, '')), ''), p_body), 240);

  perform internal.bind_actor(member_id);
  insert into public.entities(id, space_id, kind, parent_id, position, created_by)
  values (p_chat_id, p_space_id, 'chat', null, null, member_id);

  insert into public.chats(
    entity_id, space_id, title, teammate_id, model, provider, agent_tool,
    chat_mode, workdir_mode, project_entity_id, cwd, native_session_id,
    configured_by_identity_id, configured_by_member_id, requester_auth_kind,
    client_mutation_id
  ) values (
    p_chat_id, p_space_id, resolved_title, p_teammate_id, p_model, p_provider, p_agent_tool,
    p_chat_mode, p_workdir_mode, project_entity, resolved_cwd, p_native_session_id,
    internal.identity_id(), member_id, internal.claim_text('tm8.auth_kind'),
    p_client_mutation_id
  );

  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (p_space_id, p_chat_id, p_teammate_id, 'relates_to', member_id);

  if p_about_id is not null then
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, p_chat_id, p_about_id, 'about', member_id);
  end if;

  perform internal.record_activity(p_space_id, p_chat_id, member_id, 'created',
            null, jsonb_build_object('kind', 'chat'));

  posted := public.w2_post_message_batch(
    array[p_chat_id], p_body, null, '{}'::uuid[],
    coalesce(p_attachment_ids, '{}'::uuid[]), null, null,
    p_client_mutation_id || ':m0', p_chat_mode, null);
  message_id := (posted -> 'messageIds' ->> 0)::uuid;
  if message_id is null then
    raise exception 'chat opening message was not stored' using errcode = 'P0002';
  end if;

  result := jsonb_build_object(
    'chatId', p_chat_id,
    'messageId', message_id,
    '_requestHash', request_hash
  );
  return internal.ledger_record(p_client_mutation_id, 'chat.start', result);
end
$function$;

create or replace function public.create_worktree(p_space_id uuid, p_project_id uuid, p_path text, p_branch text, p_base_ref text, p_base_commit_oid text, p_actor_id uuid DEFAULT NULL::uuid, p_client_mutation_id text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  replay jsonb;
  actor uuid;
  worktree_id uuid;
  activity_id uuid;
  project_entity uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.spawn');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);
  if not exists (select 1 from public.space_projects
                  where space_id = p_space_id and project_id = p_project_id) then
    raise exception 'project is not linked to this space' using errcode = '42501';
  end if;
  -- 245: the worktree row stores the space's project ENTITY. The branch key is
  -- now (space, project entity, branch) alone: git's own one-worktree-per-branch
  -- rule refuses a second checkout of a branch in one repository before this
  -- door is ever called, so no row is written for a refused checkout.
  project_entity := internal.project_entity_for(p_space_id, p_project_id);
  if project_entity is null then
    raise exception 'project has no project entity in this space' using errcode = 'P0002',
      detail = 'project_not_projected';
  end if;

  if p_entity_id is null then
    worktree_id := internal.create_envelope(p_space_id, 'worktree', actor, null, null);
  else
    -- The node-generated id, adopted verbatim. `create_envelope`'s insert,
    -- with `new_id()` replaced by the reservation's id and nothing else
    -- changed; the entities PK makes a collision a 23505, never a reuse.
    worktree_id := p_entity_id;
    insert into public.entities(id, space_id, kind, parent_id, position, created_by)
    values (worktree_id, p_space_id, 'worktree', null, null, actor);
  end if;

  insert into public.worktrees(entity_id, space_id, project_entity_id, path, branch, base_ref, base_commit_oid)
  values (worktree_id, p_space_id, project_entity, p_path, btrim(p_branch), p_base_ref, lower(p_base_commit_oid));
  perform internal.record_initial_version(worktree_id, actor);
  activity_id := internal.record_activity(p_space_id, worktree_id, actor, 'created',
                   null, jsonb_build_object('kind', 'worktree', 'branch', btrim(p_branch)));
  return internal.ledger_record(p_client_mutation_id, 'execution.spawn',
           internal.command_result(worktree_id, null, activity_id, array[worktree_id]));
end
$function$;

create or replace function public.begin_form_delivery_spawn(p_response_id uuid, p_work_session_id uuid, p_attempt integer, p_hold_seconds integer DEFAULT 900)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  d public.form_deliveries;
  fr public.form_responses;
  ws public.work_sessions;
  se public.entities;
  launch jsonb;
  m public.messages;
  source_message uuid;
  teammate uuid;
  tasks uuid[];
begin
  perform internal.require_identity();
  select * into fr from public.form_responses where id = p_response_id;
  if fr.id is null or not internal.is_space_member(fr.space_id) then return null; end if;

  update public.form_deliveries
     set spawn_mutation_id = coalesce(spawn_mutation_id,
           'form-delivery-spawn:' || p_response_id || ':' || p_work_session_id || ':' || p_attempt),
         claimed_at = now() + make_interval(secs => greatest(coalesce(p_hold_seconds, 900), 60))
   where response_id = p_response_id and work_session_id = p_work_session_id
     and status = 'pending' and delivery_id is null and claimed_at is not null
  returning * into d;
  if d.response_id is null then return null; end if;

  select * into se from public.entities where id = p_work_session_id;
  select * into ws from public.work_sessions where entity_id = p_work_session_id;
  select e.dst_id into teammate
    from public.edges e
    join public.entities t on t.id = e.dst_id and t.kind = 'team_member' and t.deleted_at is null
   where e.src_id = p_work_session_id and e.type = 'relates_to'
   limit 1;
  -- The requester's tasks; failing that, the tasks the form is attached to
  -- (§7.3: "the teammate and tasks are known from the form's edges").
  select coalesce(array_agg(e.dst_id order by e.created_at), '{}') into tasks
    from public.edges e
    join public.entities t on t.id = e.dst_id and t.kind = 'task' and t.deleted_at is null
   where e.src_id = p_work_session_id and e.type = 'working_on';
  if cardinality(tasks) = 0 then
    select coalesce(array_agg(e.dst_id order by e.created_at), '{}') into tasks
      from public.edges e
      join public.entities t on t.id = e.dst_id and t.kind = 'task' and t.deleted_at is null
     where e.src_id = fr.form_id and e.type = 'attached_to';
  end if;

  -- The requester's RECORDED posture (the spawned session must never exceed
  -- it). Null when no manifest was recorded: the caller refuses to spawn.
  select sm.manifest -> 'launch' into launch
    from public.session_manifests sm where sm.work_session_id = p_work_session_id;

  -- The session copy the envelope renders, and the form's copy a reply
  -- threads under (214 G reads them the same way).
  select * into m from public.messages where entity_id = fr.message_id;
  select s.entity_id into source_message
    from public.messages s
   where s.message_batch_id = m.message_batch_id and s.anchor_id = fr.form_id
   limit 1;

  return jsonb_build_object(
    'mutationId', d.spawn_mutation_id,
    'message', jsonb_build_object(
      'id', m.entity_id,
      'batchId', m.message_batch_id,
      'body', m.body,
      'senderActorId', m.author_id,
      'senderActorKind', (select e.kind from public.entities e where e.id = m.author_id),
      'sourceMessageId', coalesce(source_message, m.entity_id)),
    'posture', case when launch is null then null else jsonb_build_object(
      'access_mode', launch ->> 'accessMode',
      'permission_mode', launch ->> 'permissionMode',
      'credential_source', launch ->> 'credentialSource',
      'credential_sources', launch -> 'credentialSources',
      'space_credential_ids', launch -> 'spaceCredentialIds',
      'harness_choice', launch -> 'harnessChoice') end,
    'spaceId', fr.space_id,
    'sessionDeleted', se.deleted_at is not null,
    'teamMemberId', teammate,
    'parentSessionId', se.parent_id,
    'projectId', internal.project_folder_for(se.space_id, ws.project_entity_id),
    'taskIds', to_jsonb(tasks),
    'workdirMode', ws.workdir_mode,
    'baseRef', ws.base_ref,
    'mode', ws.mode,
    'model', ws.model,
    'agentTool', ws.agent_tool,
    'title', coalesce(ws.title, ''));
end
$function$;

create or replace function public.unlink_project(p_space_id uuid, p_project_id uuid, p_client_mutation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare replay jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.unlink');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  -- A live session is running out of this project's directory right now; pulling
  -- the link would leave it unattributable.
  if exists (
    select 1 from public.work_sessions ws
      join public.entities e on e.id = ws.entity_id
     where ws.project_entity_id = internal.project_entity_for(p_space_id, p_project_id)
       and e.space_id = p_space_id
       and ws.status in ('spawning','running','idle')
  ) then
    raise exception 'project has live work sessions in this space' using errcode = '23514';
  end if;
  delete from public.space_projects where space_id = p_space_id and project_id = p_project_id;
  return internal.ledger_record(p_client_mutation_id, 'projects.unlink',
           jsonb_build_object('spaceId', p_space_id, 'projectId', p_project_id, 'patches', '[]'::jsonb));
end
$function$;

create or replace function internal.pr_owning_session(p_pr_entity_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
  with pr as (
    select * from public.pull_requests where entity_id = p_pr_entity_id
  ), candidates as (
    select e.dst_id as session_id, 1 as confidence, pr.space_id
      from pr
      join public.edges e
        on e.src_id = p_pr_entity_id and e.type = 'created_in'
    union all
    select e.dst_id, 2, pr.space_id
      from pr
      join public.commits c
        on c.space_id = pr.space_id and c.repo = pr.repo and c.sha = lower(pr.head_sha)
      join public.edges e on e.src_id = c.entity_id and e.type = 'created_in'
     where pr.head_sha is not null
    union all
    -- D2: the branch-name fallback, now inside the PR's Space and its repo.
    select e.src_id, 3, pr.space_id
      from pr
      join public.worktrees w on w.branch = pr.head_ref
      join public.entities we
        on we.id = w.entity_id
       and we.space_id = pr.space_id
       and we.deleted_at is null
      join public.projects wp on wp.id = internal.project_folder_for(w.space_id, w.project_entity_id)
      join public.edges e on e.dst_id = w.entity_id and e.type = 'in_worktree'
     where pr.head_ref is not null
       and (internal.repo_slug_from_url(wp.repo_url) is null
            or lower(internal.repo_slug_from_url(wp.repo_url)) = lower(pr.repo))
  )
  select c.session_id
    from candidates c
    join public.entities se
      on se.id = c.session_id and se.kind = 'work_session' and se.deleted_at is null
     and se.space_id = c.space_id
    join public.work_sessions ws on ws.entity_id = se.id
    -- F0: a credential login terminal is not an addressee. Filtered rather than
    -- de-ranked — there is no circumstance in which nudging one is right.
   where internal.is_agent_session(se.id)
   order by (ws.status in ('spawning','running','idle')) desc, c.confidence, ws.status_changed_at desc
   limit 1
$function$;

create or replace function internal.guard_space_project_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare projection_id uuid; bound_chats integer; active_count integer; frozen boolean;
begin
  if tg_op = 'INSERT' then
    select p.active_link_count, p.link_frozen into active_count, frozen
      from public.projects p where p.id = new.project_id for update;
    if active_count is null then
      raise exception 'Project not found' using errcode = 'P0002';
    end if;
    perform 1 from public.spaces where id = new.space_id for update;
    if internal.project_folders_shared() then
      if frozen or active_count >= 16 then
        raise exception 'Project active-link cap reached'
          using errcode = '53400', detail = 'project_over_cap';
      end if;
      return new;
    end if;
    -- W11 (234): a folder is granted to at most one space. Rows that already
    -- break this (double links from before 234) stay until W11-migrate splits
    -- them; no new one can be made.
    if exists (select 1 from public.space_projects other
                where other.project_id = new.project_id
                  and other.space_id <> new.space_id) then
      raise exception 'this folder belongs to another space'
        using errcode = '23505', detail = 'folder_granted_elsewhere';
    end if;
    return new;
  end if;

  perform 1 from public.projects where id = old.project_id for update;
  perform 1 from public.spaces where id = old.space_id for update;
  select project_entity_id into projection_id from public.project_links
   where space_id = old.space_id and project_id = old.project_id;
  if exists (
    select 1 from public.work_sessions ws
    join public.entities session_entity on session_entity.id = ws.entity_id
    where session_entity.space_id = old.space_id
      and session_entity.deleted_at is null
      and ws.status in ('spawning','running','idle')
      and (ws.project_entity_id = projection_id
        or exists (select 1 from public.edges edge
                    where edge.src_id = ws.entity_id and edge.dst_id = projection_id
                      and edge.type = 'in_project'))
  ) then
    raise exception 'Project has a live launch root or association in this Space'
      using errcode = '23514', detail = 'project_not_linked';
  end if;
  -- B3 (228): a chat bound to this project in this space still resumes into
  -- its folder, so it blocks the unlink like a live session does.
  select count(*)::integer into bound_chats
    from public.chats chat
    join public.entities chat_entity on chat_entity.id = chat.entity_id
   where chat.space_id = old.space_id
     and chat.project_entity_id = projection_id
     and chat_entity.deleted_at is null;
  if bound_chats > 0 then
    raise exception 'Project is bound to % chat(s) in this Space; delete them to unlink it', bound_chats
      using errcode = '23514', detail = 'project_not_linked',
            hint = format('Delete the %s chat(s) bound to this project in this Space, then unlink it.', bound_chats);
  end if;
  return old;
end
$function$;

create or replace function internal.fill_worktree_space()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
begin
  if new.space_id is null then
    select e.space_id into new.space_id from public.entities e where e.id = new.entity_id;
  end if;
  return new;
end
$function$;

create or replace function internal.guard_launch_project()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
begin
  if new.project_entity_id is distinct from old.project_entity_id then
    raise exception 'work_session launch project is immutable provenance'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

create or replace function internal.after_work_session_insert_w1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare projection_id uuid; session_space uuid; actor uuid;
begin
  perform internal.ensure_core_interaction_pin(new.entity_id);
  if new.project_entity_id is not null then
    select e.space_id, e.created_by into session_space, actor
      from public.entities e where e.id = new.entity_id;
    select l.project_entity_id into projection_id from public.project_links l
      join public.entities projection on projection.id = l.project_entity_id
     where l.space_id = session_space and l.project_entity_id = new.project_entity_id
       and projection.deleted_at is null
       and exists (select 1 from public.space_projects sp
                    where sp.space_id = l.space_id and sp.project_id = l.project_id);
    if projection_id is not null then
      perform internal.w1_set_writer('spawn');
      insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
      values (session_space, new.entity_id, projection_id, 'in_project', '{}'::jsonb, actor)
      on conflict (src_id, dst_id, type) do nothing;
      perform internal.w1_set_writer(null);
    end if;
  end if;
  return new;
end
$function$;

create or replace function internal.capture_git_worktree_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare space uuid;
begin
  select space_id into space from public.entities where id = new.entity_id;
  if space is not null then
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (
      space,
      internal.next_event_seq(space),
      'git.worktree_status_changed',
      jsonb_build_object(
        'type', 'git.worktree_status_changed',
        'worktreeEntityId', new.entity_id,
        'projectId', internal.project_folder_for(space, new.project_entity_id),
        'branch', new.branch,
        'previousStatus', old.status,
        'status', new.status),
      internal.claim_cmid()
    );
  end if;
  return new;
end
$function$;


create trigger work_sessions_launch_project_immutable
before update of project_entity_id on public.work_sessions
for each row execute function internal.guard_launch_project();

-- -----------------------------------------------------------------------------
-- 4. Constraints.
-- -----------------------------------------------------------------------------
-- The FKs: RESTRICT replaces 234's ON DELETE SET NULL. Idempotent — a no-op
-- where the FK already restricts (D2 may declare it so in 234 itself).
do $fk$
declare t text;
begin
  foreach t in array array['chats', 'work_sessions', 'worktrees'] loop
    if not exists (select 1 from pg_constraint
                    where conrelid = format('public.%I', t)::regclass
                      and conname = t || '_project_entity_id_fkey' and confdeltype = 'r') then
      execute format('alter table public.%I drop constraint if exists %I', t, t || '_project_entity_id_fkey');
      execute format('alter table public.%I add constraint %I foreign key (project_entity_id)
                        references public.entities(id) on delete restrict', t, t || '_project_entity_id_fkey');
    end if;
  end loop;
end
$fk$;

alter table public.worktrees
  alter column space_id set not null,
  alter column project_entity_id set not null;

-- Fail-closed ON PURPOSE: a session names its project entity unless it is one
-- of the modes that never runs in a project folder. The exemptions, each
-- deliberate:
--   * workdir_mode 'scratch'    runs in a server-owned scratch directory;
--   * workdir_mode 'container'  runs inside a machine, not a folder;
--   * session_kind 'credential' a provider login terminal; its writers (183,
--                               206) insert no workdir_mode and take 001's
--                               default 'project'. Transitional: follow-up
--                               01a0db65 drops the default and this term.
-- A new mode or kind joins this list only on purpose, by editing this CHECK;
-- a mode not listed here must carry a project entity.
alter table public.work_sessions
  add constraint work_sessions_project_entity_check
  check (session_kind = 'credential'
         or workdir_mode in ('scratch', 'container')
         or project_entity_id is not null);

-- Chats: the same fail-closed rule against the chat's two modes, and 176's
-- other half kept (a scratch chat names no project).
alter table public.chats drop constraint chats_project_binding_check;
alter table public.chats
  add constraint chats_project_entity_check
  check (workdir_mode = 'scratch' or project_entity_id is not null),
  add constraint chats_scratch_has_no_project_check
  check (workdir_mode <> 'scratch' or project_entity_id is null);

-- -----------------------------------------------------------------------------
-- 5. The drop. Takes with it: chats_project_id_fkey, work_sessions_project_id_fkey,
--    work_sessions_project_idx, worktrees_project_id_fkey and
--    worktrees_project_id_branch_key.
-- -----------------------------------------------------------------------------
alter table public.chats drop column project_id;
alter table public.work_sessions drop column project_id;
alter table public.worktrees drop column project_id;

comment on column public.chats.project_entity_id is
  'The space''s project entity this chat is bound to (234; the only project column since 245).';
comment on column public.work_sessions.project_entity_id is
  'The space''s project entity this session launched from (234; the only project column since 245). Immutable.';
comment on column public.worktrees.project_entity_id is
  'The space''s project entity the worktree was cut from (234; NOT NULL and the only project column since 245).';

reset role;
