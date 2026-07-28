-- =============================================================================
-- 021 — W2.G06 ProjectResources, stable restricted projections and correction.
--
-- ProjectResource rows are node-local configuration truth. A `project` entity
-- is only the stable, restricted per-Space projection of an active M:N link.
-- Every path below follows the universal lock order ProjectResource -> Space.
-- =============================================================================
set role tm8_graph_owner;

-- The W1 projection table carried identity/version only. W2 materializes the
-- fields that are safe on the Space graph; working_dir, trust and spawn
-- defaults deliberately remain node-local ProjectResource configuration.
alter table public.project_projection_details
  add column name text,
  add column repo_url text;

update public.project_projection_details detail
   set name = resource.name,
       repo_url = resource.repo_url
  from public.projects resource
 where resource.id = detail.project_id;

alter table public.project_projection_details
  alter column name set not null,
  add constraint project_projection_name_check
    check (char_length(btrim(name)) between 1 and 200);

-- A restricted Project projection is readable only while its stable mapping is
-- actively linked to the caller's Space. This is narrower than ordinary
-- `visibility='space'` and keeps inactive/tombstoned projections hidden while
-- allowing their live in_project edges to render through the generic read seam.
create or replace function internal.entity_readable(target uuid) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select exists (
    select 1 from public.entities entity_row
     where entity_row.id = target
       and entity_row.deleted_at is null
       and internal.is_space_member(entity_row.space_id)
       and (
         entity_row.visibility = 'space'
         or (
           entity_row.visibility = 'restricted'
           and entity_row.kind = 'project'
           and exists (
             select 1
               from public.project_links link
               join public.space_projects active_link
                 on active_link.space_id = link.space_id
                and active_link.project_id = link.project_id
              where link.project_entity_id = entity_row.id
                and link.space_id = entity_row.space_id
           )
         )
       )
  )
$$;

-- Detail changes are ProjectResource fan-out, not generic entity mutation. One
-- materialized revision advances the envelope version and records one snapshot.
create or replace function internal.snapshot_project_projection() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  actor uuid;
  next_version integer;
begin
  if new.name is not distinct from old.name
     and new.repo_url is not distinct from old.repo_url
     and new.materialized_version = old.materialized_version then
    return new;
  end if;
  select coalesce(internal.actor_id(), entity_row.created_by), entity_row.version + 1
    into actor, next_version
    from public.entities entity_row
   where entity_row.id = new.entity_id
   for update;
  update public.entities
     set version = next_version, activity_at = now(), updated_at = now()
   where id = new.entity_id;
  insert into public.entity_versions(entity_id, version, snapshot, changed_by)
  values (new.entity_id, next_version, internal.entity_snapshot(new.entity_id), actor);
  return new;
end
$$;

create trigger project_projection_details_snapshot_version
after update of name, repo_url, materialized_version
on public.project_projection_details
for each row execute function internal.snapshot_project_projection();

-- Upgrade W1 projections in place. Their ids and mapping history are immutable.
select internal.w1_set_writer('project_materializer');
update public.entities entity_row
   set visibility = 'restricted', updated_at = now()
 where entity_row.kind = 'project' and entity_row.visibility <> 'restricted';
select internal.w1_set_writer(null);

insert into public.entity_versions(entity_id, version, snapshot, changed_by)
select entity_row.id, entity_row.version, internal.entity_snapshot(entity_row.id), entity_row.created_by
  from public.entities entity_row
 where entity_row.kind = 'project'
on conflict (entity_id, version) do nothing;

-- Restore/create exactly one stable projection for one active link. Live replay
-- is a no-op; relink restores the same id and advances materializedVersion.
create or replace function internal.materialize_project_projection(
  target_space uuid, target_project uuid, audit_mutation boolean default true
) returns uuid language plpgsql set search_path = public, internal, pg_temp as $$
declare
  resource public.projects;
  actor uuid;
  projection_id uuid;
  projection_was_deleted boolean := false;
  visibility_changed boolean := false;
  detail_changed boolean := false;
  changed boolean := false;
begin
  select * into resource from public.projects where id = target_project for update;
  if resource.id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  perform 1 from public.spaces where id = target_space for update;
  if not exists (
    select 1 from public.space_projects
     where space_id = target_space and project_id = target_project
  ) then
    return null;
  end if;

  actor := internal.w1_projection_actor(target_space, target_project);
  if actor is null then
    if audit_mutation then
      perform internal.w1_audit(target_space, 'project_projection_skipped_no_actor',
        jsonb_build_object('projectId', target_project));
    end if;
    return null;
  end if;

  select link.project_entity_id, entity_row.deleted_at is not null
    into projection_id, projection_was_deleted
    from public.project_links link
    join public.entities entity_row on entity_row.id = link.project_entity_id
   where link.space_id = target_space and link.project_id = target_project;

  perform internal.w1_set_writer('project_materializer');
  if projection_id is null then
    projection_id := internal.new_id();
    insert into public.entities(
      id, space_id, kind, parent_id, position, visibility, created_by
    ) values (
      projection_id, target_space, 'project', null, null, 'restricted', actor
    );
    insert into public.project_projection_details(
      entity_id, project_id, materialized_version, name, repo_url
    ) values (
      projection_id, target_project, 1, resource.name, resource.repo_url
    );
    insert into public.project_links(space_id, project_id, project_entity_id)
    values (target_space, target_project, projection_id);
    perform internal.record_initial_version(projection_id, actor);
    changed := true;
  else
    update public.entities
       set deleted_at = null,
           visibility = 'restricted',
           activity_at = case when deleted_at is not null or visibility <> 'restricted' then now() else activity_at end,
           updated_at = case when deleted_at is not null or visibility <> 'restricted' then now() else updated_at end
     where id = projection_id
       and (deleted_at is not null or visibility <> 'restricted');
    visibility_changed := found;
    update public.project_projection_details
       set name = resource.name,
           repo_url = resource.repo_url,
           materialized_version = materialized_version + 1
     where entity_id = projection_id
       and (projection_was_deleted or visibility_changed
         or name is distinct from resource.name
         or repo_url is distinct from resource.repo_url);
    detail_changed := found;
    changed := visibility_changed or detail_changed;
  end if;
  perform internal.w1_set_writer(null);

  if audit_mutation and changed then
    perform internal.w1_audit(target_space, 'project_projection_materialized',
      jsonb_build_object('projectId', target_project, 'projectEntityId', projection_id));
  end if;
  return projection_id;
end
$$;

-- Every node-level resource update fans to all ACTIVE projections in this one
-- transaction. Inactive stable mappings catch up only when relink restores them.
create or replace function internal.sync_project_projections() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  update public.project_projection_details detail
     set name = new.name,
         repo_url = new.repo_url,
         materialized_version = detail.materialized_version + 1
    from public.project_links link
   where link.project_id = new.id
     and link.project_entity_id = detail.entity_id
     and exists (
       select 1 from public.space_projects active_link
        where active_link.space_id = link.space_id
          and active_link.project_id = link.project_id
     );
  return new;
end
$$;

-- Nullable values remain distinguishable from absent keys, in particular
-- repoUrl:null, which the W1 positional/coalesce RPC could not express.
create or replace function public.update_project_w2(
  p_project_id uuid, p_patch jsonb, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  patch jsonb := coalesce(p_patch, '{}'::jsonb);
  project public.projects;
  next_name text;
  next_working_dir text;
  next_repo_url text;
  next_trust text;
  next_defaults jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.update');
  if replay is not null then return replay; end if;
  perform internal.require_node_admin();
  if jsonb_typeof(patch) <> 'object'
     or patch - array['name','workingDir','repoUrl','trust','defaults']::text[] <> '{}'::jsonb then
    raise exception 'invalid Project update patch' using errcode = '22023';
  end if;

  select * into project from public.projects where id = p_project_id for update;
  if project.id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  if project.link_frozen then
    raise exception 'Project is frozen above the active-link cap'
      using errcode = '53400', detail = 'project_over_cap';
  end if;

  if patch ? 'name' and jsonb_typeof(patch->'name') <> 'string' then
    raise exception 'name must be a string' using errcode = '22023';
  end if;
  if patch ? 'workingDir' and jsonb_typeof(patch->'workingDir') <> 'string' then
    raise exception 'workingDir must be a string' using errcode = '22023';
  end if;
  if patch ? 'repoUrl' and jsonb_typeof(patch->'repoUrl') not in ('string','null') then
    raise exception 'repoUrl must be a string or null' using errcode = '22023';
  end if;
  if patch ? 'trust' and (jsonb_typeof(patch->'trust') <> 'string'
      or patch->>'trust' not in ('trusted','untrusted')) then
    raise exception 'invalid trust level' using errcode = '22023';
  end if;
  if patch ? 'defaults' and jsonb_typeof(patch->'defaults') <> 'object' then
    raise exception 'defaults must be an object' using errcode = '22023';
  end if;

  next_name := case when patch ? 'name' then patch->>'name' else project.name end;
  next_working_dir := case when patch ? 'workingDir' then patch->>'workingDir' else project.working_dir end;
  next_repo_url := case when patch ? 'repoUrl' then patch->>'repoUrl' else project.repo_url end;
  next_trust := case when patch ? 'trust' then patch->>'trust' else project.trust end;
  next_defaults := case when patch ? 'defaults' then patch->'defaults' else project.defaults end;

  update public.projects
     set name = next_name,
         working_dir = next_working_dir,
         repo_url = next_repo_url,
         trust = next_trust,
         defaults = next_defaults
   where id = p_project_id
     and (name, working_dir, repo_url, trust, defaults)
       is distinct from (next_name, next_working_dir, next_repo_url, next_trust, next_defaults)
  returning * into project;
  if project.id is null then
    select * into project from public.projects where id = p_project_id;
  end if;
  return internal.ledger_record(p_client_mutation_id, 'projects.update',
    jsonb_build_object('project', to_jsonb(project), 'patches', '[]'::jsonb));
end
$$;

create or replace function public.link_project_w2(
  p_space_id uuid, p_project_id uuid, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  resource public.projects;
  actor uuid;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.link');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  select * into resource from public.projects where id = p_project_id for update;
  if resource.id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  perform 1 from public.spaces where id = p_space_id for update;
  if resource.link_frozen then
    raise exception 'Project is frozen above the active-link cap'
      using errcode = '53400', detail = 'project_over_cap';
  end if;
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  insert into public.space_projects(space_id, project_id, linked_by)
  values (p_space_id, p_project_id, actor)
  on conflict (space_id, project_id) do nothing;
  perform internal.materialize_project_projection(p_space_id, p_project_id, true);
  update public.projects resource_row
     set active_link_count = (
       select count(*)::integer from public.space_projects
        where project_id = p_project_id
     )
   where resource_row.id = p_project_id
     and resource_row.active_link_count is distinct from (
       select count(*)::integer from public.space_projects
        where project_id = p_project_id
     );

  result := jsonb_build_object(
    'spaceId', p_space_id, 'projectId', p_project_id, 'patches', '[]'::jsonb
  );
  return internal.ledger_record(p_client_mutation_id, 'projects.link', result);
end
$$;

create or replace function public.unlink_project_w2(
  p_space_id uuid, p_project_id uuid, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  resource public.projects;
  projection_id uuid;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.unlink');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  select * into resource from public.projects where id = p_project_id for update;
  if resource.id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  perform 1 from public.spaces where id = p_space_id for update;
  select project_entity_id into projection_id
    from public.project_links
   where space_id = p_space_id and project_id = p_project_id;

  delete from public.space_projects
   where space_id = p_space_id and project_id = p_project_id;

  -- Idempotent repair: an inactive stable mapping must stay tombstoned even if
  -- an older interrupted maintenance path left the envelope live.
  if not found and projection_id is not null then
    perform internal.w1_set_writer('project_materializer');
    update public.entities
       set deleted_at = coalesce(deleted_at, now()), activity_at = now(), updated_at = now()
     where id = projection_id and deleted_at is null;
    perform internal.w1_set_writer(null);
  end if;
  update public.projects
     set active_link_count = (
       select count(*)::integer from public.space_projects where project_id = p_project_id
     ),
         link_frozen = case
           when (select count(*) from public.space_projects where project_id = p_project_id) <= 16
             then false else link_frozen end
   where id = p_project_id;

  result := jsonb_build_object(
    'spaceId', p_space_id, 'projectId', p_project_id, 'patches', '[]'::jsonb
  );
  return internal.ledger_record(p_client_mutation_id, 'projects.unlink', result);
end
$$;

-- Owner/admin-only inverse for PR/commit materialization. Pure materialized
-- associations are removed; promoted user associations are demoted to their
-- frozen prior origin. It is intentionally not a generic edge-repair command.
create or replace function public.correct_project_association(
  p_artifact_id uuid, p_project_id uuid, p_expected_artifact_version integer,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  resource public.projects;
  artifact public.entities;
  projection_id uuid;
  association public.edges;
  prior_origin text;
  actor uuid;
  outcome text := 'unchanged';
  result_edge_id uuid;
  activity_id uuid;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.associations.correct');
  if replay is not null then return replay; end if;

  -- Resource first, before any Space/entity/edge row lock.
  select * into resource from public.projects where id = p_project_id for update;
  if resource.id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  select * into artifact from public.entities where id = p_artifact_id;
  if artifact.id is null or artifact.deleted_at is not null
     or artifact.kind not in ('pull_request','commit') then
    raise exception 'artifact must be a live pull_request or commit' using errcode = 'P0002';
  end if;
  perform internal.require_space_admin(artifact.space_id);
  perform 1 from public.spaces where id = artifact.space_id for update;
  select * into artifact from public.entities where id = p_artifact_id for update;
  if artifact.deleted_at is not null or artifact.kind not in ('pull_request','commit') then
    raise exception 'artifact must be a live pull_request or commit' using errcode = 'P0002';
  end if;
  perform internal.assert_version(p_artifact_id, p_expected_artifact_version);

  select link.project_entity_id into projection_id
    from public.project_links link
    join public.space_projects active_link
      on active_link.space_id = link.space_id and active_link.project_id = link.project_id
    join public.entities projection
      on projection.id = link.project_entity_id and projection.deleted_at is null
    join public.project_projection_details detail
      on detail.entity_id = projection.id and detail.project_id = link.project_id
   where link.space_id = artifact.space_id and link.project_id = p_project_id;
  if projection_id is null then
    raise exception 'Project is not actively linked to this Space'
      using errcode = '23514', detail = 'project_not_linked';
  end if;

  select * into association from public.edges
   where src_id = p_artifact_id and dst_id = projection_id and type = 'in_project'
   for update;
  actor := internal.resolve_actor(null, artifact.space_id);
  perform internal.bind_actor(actor);
  if association.id is not null and association.props->>'origin' = 'materialized' then
    prior_origin := nullif(association.props->>'promotedFromOrigin', '');
    perform internal.w1_set_writer('project_correction');
    if prior_origin is null then
      delete from public.edges where id = association.id;
      outcome := 'removed';
      result_edge_id := null;
    else
      update public.edges
         set props = (props - 'promotedFromOrigin') || jsonb_build_object('origin', prior_origin),
             updated_at = now()
       where id = association.id;
      outcome := 'demoted';
      result_edge_id := association.id;
    end if;
    perform internal.w1_set_writer(null);
    activity_id := internal.record_activity(
      artifact.space_id, artifact.id, actor, 'unlinked', association.id,
      jsonb_build_object('projectId', p_project_id, 'outcome', outcome)
    );
  elsif association.id is not null then
    result_edge_id := association.id;
  end if;

  result := jsonb_build_object(
    'artifactId', p_artifact_id,
    'projectId', p_project_id,
    'outcome', outcome,
    'edgeId', result_edge_id
  );
  insert into public.workspace_events(
    space_id, seq, event_type, payload, client_mutation_id
  ) values (
    artifact.space_id,
    internal.next_event_seq(artifact.space_id),
    'project.association.corrected',
    result || jsonb_build_object('activityId', activity_id),
    internal.claim_cmid()
  );
  return internal.ledger_record(
    p_client_mutation_id, 'projects.associations.correct', result
  );
end
$$;

-- Conditional legacy launch backfill. Provenance never activates a link: only
-- an already-active stable mapping is eligible, and every skip is auditable.
do $w2_project_backfill$
declare
  session_row record;
  projection_id uuid;
  association_count integer;
begin
  for session_row in
    select session_entity.id entity_id, session_entity.space_id,
           session_entity.created_by, session.project_id
      from public.work_sessions session
      join public.entities session_entity on session_entity.id = session.entity_id
     where session.project_id is not null
     order by session.project_id, session_entity.space_id, session_entity.id
  loop
    perform 1 from public.projects where id = session_row.project_id for update;
    perform 1 from public.spaces where id = session_row.space_id for update;
    select link.project_entity_id into projection_id
      from public.project_links link
      join public.space_projects active_link
        on active_link.space_id = link.space_id and active_link.project_id = link.project_id
      join public.entities projection
        on projection.id = link.project_entity_id and projection.deleted_at is null
     where link.space_id = session_row.space_id
       and link.project_id = session_row.project_id;

    if projection_id is null then
      perform internal.w1_audit(session_row.space_id, 'w2_project_launch_unmatched',
        jsonb_build_object('workSessionId', session_row.entity_id,
                           'projectId', session_row.project_id));
    elsif not exists (
      select 1 from public.edges
       where src_id = session_row.entity_id and dst_id = projection_id and type = 'in_project'
    ) then
      select count(*) into association_count
        from public.edges edge
        join public.entities projection on projection.id = edge.dst_id
       where edge.src_id = session_row.entity_id and edge.type = 'in_project'
         and projection.deleted_at is null;
      if association_count >= 16 then
        perform internal.w1_audit(session_row.space_id, 'w2_project_launch_cap_skipped',
          jsonb_build_object('workSessionId', session_row.entity_id,
                             'projectId', session_row.project_id));
      else
        perform internal.w1_set_writer('backfill');
        insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
        values (session_row.space_id, session_row.entity_id, projection_id,
                'in_project', '{}'::jsonb, session_row.created_by)
        on conflict (src_id, dst_id, type) do nothing;
        perform internal.w1_set_writer(null);
        perform internal.w1_audit(session_row.space_id, 'w2_project_launch_backfilled',
          jsonb_build_object('workSessionId', session_row.entity_id,
                             'projectId', session_row.project_id,
                             'projectEntityId', projection_id));
      end if;
    end if;
  end loop;
end
$w2_project_backfill$;

-- New functions are not covered by the earlier closed allowlist. Grant only
-- the four application RPCs; all helpers remain internal/owner-only.
revoke all on function public.update_project_w2(uuid, jsonb, text) from public;
revoke all on function public.link_project_w2(uuid, uuid, uuid, text) from public;
revoke all on function public.unlink_project_w2(uuid, uuid, text) from public;
revoke all on function public.correct_project_association(uuid, uuid, integer, text) from public;
grant execute on function
  public.update_project_w2(uuid, jsonb, text),
  public.link_project_w2(uuid, uuid, uuid, text),
  public.unlink_project_w2(uuid, uuid, text),
  public.correct_project_association(uuid, uuid, integer, text)
to tm8_app;

revoke all on all functions in schema internal from public;
reset role;
