-- =============================================================================
-- 173  SELF-SERVE PROJECT CREATION FROM A GIT REMOTE.
--
-- THE DEFECT. A space admin who has just created a space cannot attach their
-- own GitHub repository to it. There is no path at all, and the reason is a
-- guard doing a job it was never meant to do:
--
--   * `public.create_project` (007_rpc_catalog.sql:755) calls
--     `internal.require_node_admin()`. Only a node admin may mint a project.
--   * `public.link_project_w2` (166) takes a `p_project_id` that must ALREADY
--     exist, so linking cannot create.
--   * therefore a space admin with no shell on the node has nothing to link,
--     and the space stays projectless.
--
-- WHY NODE-ADMIN IS THE WRONG GUARD FOR THIS CASE, precisely. `create_project`
-- accepts an arbitrary absolute `p_working_dir`. That is the dangerous part,
-- and it is dangerous for a specific, documented reason: `projects.files.list`
-- is member-reachable and scoped to the project's working directory, so a
-- project row pointed at `/` silently exposes every readable file on the node
-- to everyone in the space. `project-directories.ts` says exactly this, and
-- the default browse scope really is the filesystem root when
-- `TM8_PROJECT_ROOTS` is unset. Node-admin is the guard on CHOOSING A PATH.
--
-- This function never lets anyone choose a path. The server derives the
-- working directory itself, underneath a single managed root that is not the
-- browse roots (see `project-clone.ts`), from the space id and a slug of the
-- repository name. The caller supplies a repo URL and nothing else. With the
-- path taken out of the caller's hands, the reason for node-admin is gone,
-- and what remains is the ordinary question of who may attach a project to a
-- space -- which already has an answer, used verbatim here:
-- `internal.require_space_admin`, the same gate `link_project_w2` applies.
--
-- SO THIS FUNCTION IS NOT A LOOSENING OF `create_project`. That function is
-- untouched and still node-admin-only. This is a second, narrower door:
--   * the path is server-derived, never caller-supplied;
--   * `trust` is hardcoded 'untrusted' and is NOT a parameter, so no
--     self-serve path can ever mint a trusted project (001_core_graph.sql:
--     "Trust is an explicit grant, never a default"). This matters beyond the
--     row itself: `channelTags.ts` auto-selects ANY trusted project to spawn a
--     tagged teammate against, so a self-serve trusted project would be
--     reachable from spaces that never asked for it;
--   * authorization is space-admin, identical to linking.
--
-- The clone itself is the server's job and happens BEFORE this call, with the
-- acting member's own stored credential. By the time we are here the working
-- tree exists; this records it and links it in one ledgered step so a failure
-- cannot leave a project row orphaned at active_link_count = 0.
-- =============================================================================

create or replace function public.create_project_from_repo(
  p_space_id uuid, p_name text, p_working_dir text, p_repo_url text,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  project public.projects;
  actor uuid;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.createFromRepo');
  if replay is not null then return replay; end if;

  -- The same gate as linking. Deliberately NOT require_node_admin: see header.
  perform internal.require_space_admin(p_space_id);

  if p_repo_url is null or btrim(p_repo_url) = '' then
    raise exception 'repoUrl is required' using errcode = '22023';
  end if;

  -- Lock the space the way link_project_w2 does, so a concurrent link and a
  -- concurrent create settle in a defined order rather than racing the
  -- active_link_count recount below.
  perform 1 from public.spaces where id = p_space_id for update;

  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  begin
    insert into public.projects(name, working_dir, repo_url, trust, defaults)
    values (p_name, p_working_dir, btrim(p_repo_url), 'untrusted', '{}'::jsonb)
    returning * into project;
  exception when unique_violation then
    -- `projects.working_dir` is unique. The server derives this path from
    -- (space, repo), so this is the honest "you already added that repo here"
    -- case rather than an internal error -- and it must not read as one.
    raise exception 'that repository is already a project on this node'
      using errcode = '23505', detail = 'project_working_dir_taken';
  end;

  insert into public.space_projects(space_id, project_id, linked_by)
  values (p_space_id, project.id, internal.member_for_actor(actor, p_space_id))
  on conflict (space_id, project_id) do nothing;

  perform internal.materialize_project_projection(p_space_id, project.id, true);

  update public.projects resource_row
     set active_link_count = (
       select count(*)::integer from public.space_projects
        where project_id = project.id
     )
   where resource_row.id = project.id
     and resource_row.active_link_count is distinct from (
       select count(*)::integer from public.space_projects
        where project_id = project.id
     );

  -- `spaces.github_repo` is a LABEL on the space (001_core_graph.sql:226), set
  -- at create/update time and never derived from linked projects. Settings
  -- renders it as "the repository for this space", so connecting one and
  -- leaving the label empty would make that line permanently wrong.
  --
  -- COALESCE, never overwrite: the column may already carry a value a human
  -- typed, and a second connected repository must not silently relabel the
  -- space. First one to arrive fills it; after that this is a no-op.
  update public.spaces
     set github_repo = p_repo_url
   where id = p_space_id
     and (github_repo is null or btrim(github_repo) = '');

  select * into project from public.projects where id = project.id;

  result := jsonb_build_object(
    'project', to_jsonb(project),
    'spaceId', p_space_id,
    'projectId', project.id,
    'patches', '[]'::jsonb
  );
  return internal.ledger_record(p_client_mutation_id, 'projects.createFromRepo', result);
end
$$;

comment on function public.create_project_from_repo(uuid, text, text, text, uuid, text) is
  'Create a project from a git remote and link it to a space in one ledgered step. '
  'Space-admin gated, NOT node-admin: the working directory is server-derived under a '
  'managed root, never caller-supplied, which is the only thing require_node_admin was '
  'guarding on create_project. Trust is always untrusted and is not a parameter.';

revoke all on function
  public.create_project_from_repo(uuid, text, text, text, uuid, text) from public;
grant execute on function
  public.create_project_from_repo(uuid, text, text, text, uuid, text)
to tm8_app;

-- Verify the two properties that carry the security argument, so a later edit
-- that quietly reintroduces either one fails the migration instead of shipping.
do $verify$
declare
  raw text;
  src text;
begin
  select p.prosrc into raw
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_project_from_repo';

  if raw is null then
    raise exception '173: create_project_from_repo was not created';
  end if;

  -- Strip `--` comments before asserting anything. The body EXPLAINS that it
  -- deliberately does not call require_node_admin, and a naive substring test
  -- over the raw source reads that explanation as the call it forbids -- which
  -- is exactly how this check failed the first time it ran.
  src := regexp_replace(raw, '--[^\n]*', '', 'g');

  if src like '%require_node_admin%' then
    raise exception '173: create_project_from_repo must not depend on node-admin';
  end if;
  if src not like '%require_space_admin%' then
    raise exception '173: create_project_from_repo must be space-admin gated';
  end if;
  -- `trust` must be a literal, never threaded from an argument.
  if src not like '%''untrusted''%' then
    raise exception '173: create_project_from_repo must hardcode untrusted trust';
  end if;
end
$verify$;
