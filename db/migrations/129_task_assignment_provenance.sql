-- 129 — real assignment provenance.
--
-- `assigned_to.created_by` says who first created the edge. It cannot answer
-- who performed the CURRENT assignment because write_edge is an upsert and
-- deliberately keeps edge authorship stable. These two assignment-only
-- columns carry that separate fact. Existing assignments retain their real
-- edge creation time, but their assigner is unknowable and therefore NULL.

alter table public.edges
  add column assigned_by uuid references public.entities(id),
  add column assigned_at timestamptz;

update public.edges
   set assigned_at = created_at
 where type = 'assigned_to';

alter table public.edges
  add constraint edges_assignment_provenance_check check (
    (type = 'assigned_to' and assigned_at is not null)
    or
    (type <> 'assigned_to' and assigned_by is null and assigned_at is null)
  );

create index edges_assigned_by_idx
  on public.edges(assigned_by, src_id)
  where type = 'assigned_to';

-- Every fresh assignment insert, including execution_spawn's transactional
-- direct insert, is stamped from the already-resolved edge author. The generic
-- write_edge upsert below separately refreshes both fields on re-assignment.
create or replace function internal.stamp_assignment_provenance() returns trigger
language plpgsql
set search_path = public, internal, pg_temp
as $$
begin
  if new.type = 'assigned_to' then
    new.assigned_by := coalesce(new.assigned_by, new.created_by);
    new.assigned_at := coalesce(new.assigned_at, now());
  end if;
  return new;
end
$$;

create trigger edges_stamp_assignment_provenance
before insert on public.edges
for each row execute function internal.stamp_assignment_provenance();

-- Shared-object replacement. This is 056's complete live body, including the
-- in_project lock arm, origin preservation, and append-only undo suppression.
-- The only semantic delta is the marked assignment-provenance refresh in the
-- conflict arm; the insert arm is stamped by the trigger above.
create or replace function public.write_edge(
  p_src_id uuid, p_dst_id uuid, p_type text, p_props jsonb default '{}'::jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  replay jsonb;
  src public.entities;
  dst public.entities;
  actor uuid;
  edge_id uuid;
  activity_id uuid;
  project_resource uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.create');
  if replay is not null then return replay; end if;
  if coalesce(p_props, '{}'::jsonb) ? 'origin' then
    raise exception 'edge props.origin is Server-owned' using errcode = '42501';
  end if;
  -- `in_project` has a stricter lock order than generic graph writes. Resolve
  -- the projection mapping even when the envelope was concurrently hidden,
  -- lock ProjectResource first, and keep every unlink race on the frozen
  -- project_not_linked path instead of degrading to a generic not_found.
  if p_type = 'in_project' then
    select project_id into project_resource
      from public.project_projection_details where entity_id = p_dst_id;
    if project_resource is null then
      raise exception 'Project projection has no resource mapping'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
    perform 1 from public.projects where id = project_resource for update;
    select * into dst from public.entities where id = p_dst_id and deleted_at is null;
    if dst.id is null then
      raise exception 'Project is not actively linked to this Space'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
  else
    dst := internal.live_entity(p_dst_id);
  end if;
  src := internal.live_entity(p_src_id);
  if src.space_id <> dst.space_id then
    raise exception 'edge endpoints must be in the same space' using errcode = '23514';
  end if;
  perform internal.require_space_member(src.space_id);
  actor := internal.resolve_actor(p_actor_id, src.space_id);
  perform internal.bind_actor(actor);

  insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
  values (src.space_id, p_src_id, p_dst_id, p_type, coalesce(p_props, '{}'::jsonb), actor)
  on conflict (src_id, dst_id, type) do update
    set props = excluded.props
      || case when public.edges.props ? 'origin'
           then jsonb_build_object('origin', public.edges.props -> 'origin')
           else '{}'::jsonb end,
        updated_at = now(),
        -- 129: the attempted insert has already been stamped by the BEFORE
        -- trigger, so EXCLUDED holds the currently acting member/persona.
        assigned_by = excluded.assigned_by,
        assigned_at = excluded.assigned_at
  returning id into edge_id;

  activity_id := internal.record_activity(
    src.space_id, p_src_id, actor, 'linked', edge_id,
    jsonb_build_object('type', p_type, 'dstId', p_dst_id));
  if coalesce((select t.append_only from public.edge_types t where t.type = p_type), false) then
    return internal.ledger_record(
      p_client_mutation_id,
      'edges.create',
      internal.command_result(null, edge_id, activity_id, array[p_src_id, p_dst_id]));
  end if;
  return internal.ledger_record(
    p_client_mutation_id,
    'edges.create',
    internal.command_result(
      null, edge_id, activity_id, array[p_src_id, p_dst_id],
      internal.issue_undo_token(
        src.space_id, actor, 'Undo link', 'edges.delete',
        jsonb_build_object('edgeId', edge_id))));
end
$$;

revoke all on function public.write_edge(uuid, uuid, text, jsonb, uuid, text) from public;
grant execute on function public.write_edge(uuid, uuid, text, jsonb, uuid, text) to tm8_app;

-- execution_spawn is the other assignment door. This is 111's complete live
-- body; its existing-assignment conflict arm now refreshes provenance without
-- rewriting the human-authored edge props or original created_by value.
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
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (p_space_id, task_id, p_team_member_id, 'assigned_to',
            jsonb_build_object('via', 'spawn'), actor)
    on conflict (src_id, dst_id, type) do update
      set assigned_by = excluded.assigned_by,
          assigned_at = excluded.assigned_at,
          updated_at = now();
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
