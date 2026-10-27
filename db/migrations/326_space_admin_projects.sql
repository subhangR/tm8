-- =============================================================================
-- 326 — SPACE ADMINS ADD PROJECTS (task 01a13574-960a, audit doc 01a13570).
--
-- Before this, every path that put a folder on the node behind a space's
-- project was the gate's: `register_folder`, `grant_folder` and
-- `create_project` require a node (gate) admin, and `create_space_project`
-- only names a folder ALREADY granted to the space. A space admin could not
-- add a project at all.
--
-- `register_space_folder` is the space admin's door. It registers a folder by
-- path (or reuses the one already registered there when this space holds it),
-- grants it to the space and names the space's project, in one step.
--
-- WHERE THE PATH IS CHECKED. The database cannot see the filesystem, so — as
-- with `register_folder` (234) — the server has already canonicalized the path
-- and confined it to the caller's allowed roots before it calls this. For a
-- space admin who is not a node admin, those roots are TM8_PROJECT_ROOTS and
-- only when the node sets it explicitly (the unset default is the filesystem
-- root, which no space admin may register into).
--
-- WHAT A SPACE ADMIN STILL CANNOT DO:
--   * trust a folder — trust is the gate's (an untrusted project still runs
--     sessions after a per-launch confirmation);
--   * take a folder the gate already registered and has not granted to this
--     space (that is `gate.folders.grant`, a node admin's call).
--
-- `projects.default_branch` records the branch a clone checked out from the
-- remote's HEAD. Neither layer stored it before; nullable, because a local
-- folder or an upload has no remote to ask.
-- =============================================================================

set role tm8_graph_owner;

alter table public.projects add column if not exists default_branch text;
alter table public.projects drop constraint if exists projects_default_branch_check;
alter table public.projects add constraint projects_default_branch_check
  check (default_branch is null or char_length(default_branch) between 1 and 255);

create or replace function public.register_space_folder(
  p_space_id uuid,
  p_name text,
  p_working_dir text,
  p_repo_url text,
  p_default_branch text,
  p_trust text,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  folder public.projects;
  projection_id uuid;
  created boolean := false;
  gate boolean := internal.is_node_admin()
    and coalesce(current_setting('tm8.session_space_id', true), '') = '';
  clean_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.projects.register');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay ->> 'spaceId', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_admin(p_space_id);
  if clean_name is null or char_length(clean_name) > 200 then
    raise exception 'project name must be 1..200 characters' using errcode = '22023';
  end if;
  if p_working_dir is null or left(p_working_dir, 1) <> '/' and p_working_dir !~ '^[A-Za-z]:[\\/]' then
    raise exception 'project working directory must be absolute' using errcode = '22023';
  end if;
  if coalesce(p_trust, 'untrusted') not in ('trusted', 'untrusted') then
    raise exception 'invalid trust level' using errcode = '22023';
  end if;
  if coalesce(p_trust, 'untrusted') = 'trusted' and not gate then
    raise exception 'only a node admin can trust a folder; add it untrusted and ask a node admin to trust it'
      using errcode = '42501', detail = 'trust_requires_node_admin';
  end if;

  select * into folder from public.projects where working_dir = p_working_dir for update;
  if folder.id is null then
    insert into public.projects(name, working_dir, repo_url, trust, defaults, default_branch)
    values (clean_name, p_working_dir, nullif(btrim(coalesce(p_repo_url, '')), ''),
            coalesce(p_trust, 'untrusted'), '{}'::jsonb,
            nullif(btrim(coalesce(p_default_branch, '')), ''))
    returning * into folder;
    created := true;
  elsif not gate and not exists (
    select 1 from public.space_projects same
     where same.project_id = folder.id and same.space_id = p_space_id
  ) then
    -- The same refusal `create_space_project` gives, so a space admin cannot
    -- tell "registered and granted elsewhere" from "registered, ungranted".
    raise exception 'this folder is already registered on the node and is not granted to this space; ask a node admin to grant it'
      using errcode = '42501', detail = 'folder_not_granted';
  end if;

  projection_id := internal.grant_folder_row(p_space_id, folder.id);
  if projection_id is null then
    raise exception 'the space''s project could not be materialized' using errcode = '23514';
  end if;
  perform internal.w1_set_writer('project_materializer');
  update public.project_projection_details
     set name = clean_name, materialized_version = materialized_version + 1
   where entity_id = projection_id and name is distinct from clean_name;
  perform internal.w1_set_writer(null);

  return internal.ledger_record(p_client_mutation_id, 'spaces.projects.register', jsonb_build_object(
    'spaceId', p_space_id, 'folderId', folder.id, 'projectId', projection_id, 'created', created));
end
$$;
revoke all on function public.register_space_folder(uuid, text, text, text, text, text, text) from public;
grant execute on function public.register_space_folder(uuid, text, text, text, text, text, text) to tm8_app;

reset role;
