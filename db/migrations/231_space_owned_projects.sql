-- =============================================================================
-- 231 — space-owned projects, the model half (plan 01a0d9eb W11, decision 28).
--
-- THE MODEL. The disk is the gate's; everything else about a project belongs
-- to one space.
--
--   public.projects          keeps its name but now means FOLDER GRANT: path,
--                            trust, repo_url. Readable by gate (node) admins
--                            only: `projects_select` loses its member arm.
--                            unique(working_dir) stays.
--   public.space_projects    the grant: at most ONE space per folder, with
--                            `granted_by` (the gate admin's identity).
--   `project` entity         (015/021's projection) the space-owned project:
--                            its own name from now on (a folder rename no
--                            longer renames it), never a path.
--   chats / work_sessions    gain `project_entity_id`, the space's project
--                            entity, filled on insert. `project_id` (the
--                            folder) stays: it is the launch provenance every
--                            existing reader and guard keys on.
--   worktrees                gain `space_id` and `project_entity_id`, filled on
--                            insert; unique(space_id, project_entity_id,
--                            branch). unique(project_id, branch) stays: one
--                            folder is one git branch namespace on disk.
--
-- Existing rows get the new columns from 232, a separate row-rewriting file.
--
-- ONE SPACE PER FOLDER, WITHOUT BREAKING A NODE THAT HAS TWO (the checkpoint
-- in the phases doc). Postgres has no NOT VALID unique index, so the rule is
-- enforced in two halves:
--   * here: the space_projects insert guard refuses a grant of a folder that
--     is already granted to another space ('this folder belongs to another
--     space', 23505, detail folder_granted_elsewhere). It replaces 015's
--     16-space cap. Existing double grants are untouched and keep working, so
--     a node with the 7 double-linked projects migrates.
--   * W11-migrate, after it splits those: `create unique index
--     space_projects_one_space_per_folder on public.space_projects(project_id)`
--     (see internal.space_project_unique_index_sql() below).
--
-- projects.link IS GONE. `link_project_w2` (021/166/228) and `link_project`
-- (007/228) are dropped, and 228's `project_visible_to_caller` with them (its
-- only callers). A folder reaches a space by a gate admin's grant
-- (`grant_folder`, `register_folder`), and a space admin names the space's
-- project on a folder granted to that space (`create_space_project`).
--
-- MEMBERS NEVER READ A PATH. Everything a member does with a project now goes
-- through three SECURITY DEFINER functions:
--   space_projects_for_caller(space)   the space's projects, no path
--   resolve_project_ref(ref, space)    entity -> grant -> path, for the SERVER
--                                      (spawn, files, git reads); never
--                                      serialized to a client
--   gate_folders_list()                gate admins only
-- Each checks membership through `is_space_member` / `member_space_ids`, which
-- carry 227's inline pin, so a session pinned to A resolves nothing of B's.
--
-- REPLACES WHOLE FUNCTIONS: guard_space_project_link is 228's body with the
-- cap swapped for the one-space rule; materialize_project_projection is 021's
-- body minus the name overwrite on re-materialization; sync_project_projections
-- is 021's body minus the name column. A later file replacing any of them must
-- carry these changes.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Columns.
-- -----------------------------------------------------------------------------
alter table public.space_projects add column granted_by text;
comment on column public.space_projects.granted_by is
  'Identity of the gate admin who granted this folder to the space (231). Null on grants made before 231.';

alter table public.chats
  add column project_entity_id uuid references public.entities(id) on delete set null;
comment on column public.chats.project_entity_id is
  'The space''s project entity this chat is bound to (231). project_id keeps the folder.';
create index chats_project_entity_idx on public.chats(project_entity_id)
  where project_entity_id is not null;

alter table public.work_sessions
  add column project_entity_id uuid references public.entities(id) on delete set null;
comment on column public.work_sessions.project_entity_id is
  'The space''s project entity this session launched from (231). project_id keeps the folder.';
create index work_sessions_project_entity_idx on public.work_sessions(project_entity_id)
  where project_entity_id is not null;

alter table public.worktrees
  add column space_id uuid references public.spaces(id) on delete cascade,
  add column project_entity_id uuid references public.entities(id) on delete set null;
comment on column public.worktrees.space_id is
  'The worktree entity''s space, denormalized for the per-space branch key (231).';
comment on column public.worktrees.project_entity_id is
  'The space''s project entity the worktree was cut from (231).';
-- Rows from before 231 carry nulls until 232 fills them; nulls never conflict.
create unique index worktrees_space_project_entity_branch_key
  on public.worktrees(space_id, project_entity_id, branch);

-- The space's live project entity for a folder, or null. Reads project_links
-- (015), which maps (space, folder) to exactly one projection.
create or replace function internal.project_entity_for(p_space_id uuid, p_folder_id uuid)
returns uuid language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select link.project_entity_id
    from public.project_links link
   where link.space_id = p_space_id and link.project_id = p_folder_id
$$;
revoke all on function internal.project_entity_for(uuid, uuid) from public;

create or replace function internal.fill_project_entity_ref() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare target_space uuid;
begin
  if tg_op = 'UPDATE'
     and (new.project_id is not distinct from old.project_id
          or new.project_entity_id is distinct from old.project_entity_id) then
    return new;
  end if;
  if tg_op = 'INSERT' and new.project_entity_id is not null then
    return new;
  end if;
  if new.project_id is null then
    new.project_entity_id := null;
    return new;
  end if;
  if tg_table_name = 'chats' then
    target_space := new.space_id;
  else
    select e.space_id into target_space from public.entities e where e.id = new.entity_id;
  end if;
  new.project_entity_id := internal.project_entity_for(target_space, new.project_id);
  return new;
end
$$;

create trigger chats_fill_project_entity
before insert or update of project_id on public.chats
for each row execute function internal.fill_project_entity_ref();

create trigger work_sessions_fill_project_entity
before insert on public.work_sessions
for each row execute function internal.fill_project_entity_ref();

create or replace function internal.fill_worktree_space() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if new.space_id is null then
    select e.space_id into new.space_id from public.entities e where e.id = new.entity_id;
  end if;
  if new.project_entity_id is null then
    new.project_entity_id := internal.project_entity_for(new.space_id, new.project_id);
  end if;
  return new;
end
$$;

create trigger worktrees_fill_space
before insert on public.worktrees
for each row execute function internal.fill_worktree_space();

-- -----------------------------------------------------------------------------
-- 2. One space per folder, for every NEW grant (the not-valid half).
-- -----------------------------------------------------------------------------
-- 228's body; one change: the INSERT branch refuses a folder granted to
-- another space instead of counting toward the 16-space cap.
create or replace function internal.guard_space_project_link() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare projection_id uuid; bound_chats integer;
begin
  if tg_op = 'INSERT' then
    perform 1 from public.projects p where p.id = new.project_id for update;
    if not found then
      raise exception 'Project not found' using errcode = 'P0002';
    end if;
    perform 1 from public.spaces where id = new.space_id for update;
    -- W11 (231): a folder is granted to at most one space. Rows that already
    -- break this (double links from before 231) stay until W11-migrate splits
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
      and (ws.project_id = old.project_id
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
     and chat.project_id = old.project_id
     and chat_entity.deleted_at is null;
  if bound_chats > 0 then
    raise exception 'Project is bound to % chat(s) in this Space; delete them to unlink it', bound_chats
      using errcode = '23514', detail = 'project_not_linked',
            hint = format('Delete the %s chat(s) bound to this project in this Space, then unlink it.', bound_chats);
  end if;
  return old;
end
$$;

-- The index W11-migrate creates once no folder is granted twice. Kept here so
-- the job and this file cannot drift on its name or shape.
create or replace function internal.space_project_unique_index_sql()
returns text language sql immutable as $$
  select 'create unique index space_projects_one_space_per_folder on public.space_projects(project_id)'
$$;
revoke all on function internal.space_project_unique_index_sql() from public;

-- -----------------------------------------------------------------------------
-- 3. The project entity owns its name.
-- -----------------------------------------------------------------------------
-- 021's body; one change: re-materializing a live or restored projection no
-- longer copies the folder's name over the entity's. The first
-- materialization still starts from the folder name.
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
       set repo_url = resource.repo_url,
           materialized_version = materialized_version + 1
     where entity_id = projection_id
       and (projection_was_deleted or visibility_changed
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

-- 021's body; one change: the folder's name is no longer pushed onto the
-- space's project entities. repo_url still is (a fact about the folder), and
-- the version still bumps on every folder change, as before.
create or replace function internal.sync_project_projections() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  update public.project_projection_details detail
     set repo_url = new.repo_url,
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

-- -----------------------------------------------------------------------------
-- 4. projects.link is removed.
-- -----------------------------------------------------------------------------
drop function public.link_project_w2(uuid, uuid, uuid, text);
drop function public.link_project(uuid, uuid, uuid, text);
drop function internal.project_visible_to_caller(uuid);

-- -----------------------------------------------------------------------------
-- 5. Folders are the gate's: only a gate admin reads public.projects.
-- -----------------------------------------------------------------------------
-- A session pinned to one space (227) is never a gate admin, whatever its
-- account is: the pin is read inline (A10), never through a helper.
alter policy projects_select on public.projects
  using (internal.is_node_admin()
         and coalesce(current_setting('tm8.session_space_id', true), '') = '');

-- A gate admin: the claim (what this request may see) AND the account (who
-- this person is), on a session that is not pinned to one space (227).
create or replace function internal.require_gate_admin() returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_node_admin();
  if not internal.is_node_admin()
     or coalesce(current_setting('tm8.session_space_id', true), '') <> '' then
    raise exception 'gate admin required' using errcode = '42501';
  end if;
end
$$;
revoke all on function internal.require_gate_admin() from public;

-- -----------------------------------------------------------------------------
-- 6. Gate: grant a folder to a space; register (and grant) a folder.
-- -----------------------------------------------------------------------------
create or replace function internal.grant_folder_row(p_space_id uuid, p_folder_id uuid)
returns uuid language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare projection_id uuid;
begin
  perform 1 from public.projects where id = p_folder_id for update;
  if not found then
    raise exception 'Folder not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.spaces where id = p_space_id) then
    raise exception 'Space not found' using errcode = 'P0002';
  end if;
  -- linked_by is the granter's member row in that space when there is one;
  -- otherwise the projection falls back to the space owner (w1_projection_actor).
  -- The after-insert trigger (015) materializes the projection and recounts
  -- active_link_count; the call below only returns the (idempotent) id.
  insert into public.space_projects(space_id, project_id, linked_by, granted_by)
  values (p_space_id, p_folder_id,
          (select m.entity_id from public.members m
            where m.space_id = p_space_id and m.identity_id = internal.identity_id()),
          internal.identity_id())
  on conflict (space_id, project_id) do nothing;
  projection_id := internal.materialize_project_projection(p_space_id, p_folder_id, true);
  return projection_id;
end
$$;
revoke all on function internal.grant_folder_row(uuid, uuid) from public;

create or replace function public.grant_folder(
  p_space_id uuid, p_folder_id uuid, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; projection_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'gate.folders.grant');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay ->> 'folderId', p_folder_id::text, 'folder');
    return replay;
  end if;
  perform internal.require_gate_admin();
  projection_id := internal.grant_folder_row(p_space_id, p_folder_id);
  return internal.ledger_record(p_client_mutation_id, 'gate.folders.grant', jsonb_build_object(
    'spaceId', p_space_id, 'folderId', p_folder_id, 'projectId', projection_id));
end
$$;
revoke all on function public.grant_folder(uuid, uuid, text) from public;
grant execute on function public.grant_folder(uuid, uuid, text) to tm8_app;

-- Register a folder by path (reusing the row when the path is already
-- registered) and, when a space is named, grant it there. The server has
-- already canonicalized the path and checked it against TM8_PROJECT_ROOTS.
create or replace function public.register_folder(
  p_name text, p_working_dir text, p_repo_url text, p_trust text, p_defaults jsonb,
  p_space_id uuid, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; folder public.projects; projection_id uuid; created boolean := false;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'gate.folders.create');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay ->> 'workingDir', p_working_dir, 'folder');
    return replay;
  end if;
  perform internal.require_gate_admin();
  if coalesce(p_trust, 'untrusted') not in ('trusted','untrusted') then
    raise exception 'invalid trust level' using errcode = '22023';
  end if;
  select * into folder from public.projects where working_dir = p_working_dir for update;
  if folder.id is null then
    insert into public.projects(name, working_dir, repo_url, trust, defaults)
    values (p_name, p_working_dir, p_repo_url, coalesce(p_trust, 'untrusted'),
            coalesce(p_defaults, '{}'::jsonb))
    returning * into folder;
    created := true;
  end if;
  if p_space_id is not null then
    projection_id := internal.grant_folder_row(p_space_id, folder.id);
  end if;
  return internal.ledger_record(p_client_mutation_id, 'gate.folders.create', jsonb_build_object(
    'folderId', folder.id, 'workingDir', folder.working_dir, 'created', created,
    'spaceId', p_space_id, 'projectId', projection_id));
end
$$;
revoke all on function public.register_folder(text, text, text, text, jsonb, uuid, text) from public;
grant execute on function public.register_folder(text, text, text, text, jsonb, uuid, text) to tm8_app;

-- Every folder on the node with the space(s) it is granted to. A folder from
-- before 231 may still list two spaces until W11-migrate runs.
create or replace function public.gate_folders_list()
returns table (
  folder_id uuid, name text, working_dir text, repo_url text, trust text, defaults jsonb,
  created_at timestamptz, updated_at timestamptz, grants jsonb
) language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_gate_admin();
  return query
    select p.id, p.name, p.working_dir, p.repo_url, p.trust, p.defaults, p.created_at, p.updated_at,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'spaceId', sp.space_id, 'spaceName', s.name,
                      'projectId', link.project_entity_id,
                      'grantedBy', sp.granted_by, 'grantedAt', sp.linked_at)
                    order by sp.linked_at, sp.space_id)
               from public.space_projects sp
               join public.spaces s on s.id = sp.space_id
               left join public.project_links link
                 on link.space_id = sp.space_id and link.project_id = sp.project_id
              where sp.project_id = p.id), '[]'::jsonb)
      from public.projects p
     order by p.name, p.id;
end
$$;
revoke all on function public.gate_folders_list() from public;
grant execute on function public.gate_folders_list() to tm8_app;

-- -----------------------------------------------------------------------------
-- 7. Space: name the space's project on a folder granted to it; list them.
-- -----------------------------------------------------------------------------
create or replace function public.create_space_project(
  p_space_id uuid, p_folder_id uuid, p_name text, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  projection_id uuid;
  clean_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.projects.create');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay ->> 'spaceId', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_admin(p_space_id);
  if clean_name is not null and char_length(clean_name) > 200 then
    raise exception 'project name must be 1..200 characters' using errcode = '22023';
  end if;
  perform 1 from public.projects where id = p_folder_id for update;
  if not found then
    raise exception 'Folder not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.space_projects other
              where other.project_id = p_folder_id and other.space_id <> p_space_id) then
    -- T30: the refusal a space admin of B gets for a folder granted to A.
    raise exception 'this folder belongs to another space'
      using errcode = '23505', detail = 'folder_granted_elsewhere';
  end if;
  if not exists (select 1 from public.space_projects
                  where project_id = p_folder_id and space_id = p_space_id) then
    -- Granting is the gate's; a gate admin who is also this space's admin may
    -- do both in one step (the new-space-project flow).
    if not internal.is_node_admin()
       or coalesce(current_setting('tm8.session_space_id', true), '') <> '' then
      raise exception 'this folder is not granted to this space'
        using errcode = '42501', detail = 'folder_not_granted';
    end if;
    perform internal.require_gate_admin();
  end if;
  projection_id := internal.grant_folder_row(p_space_id, p_folder_id);
  if projection_id is null then
    raise exception 'the space''s project could not be materialized' using errcode = '55000';
  end if;
  if clean_name is not null then
    perform internal.w1_set_writer('project_materializer');
    update public.project_projection_details
       set name = clean_name, materialized_version = materialized_version + 1
     where entity_id = projection_id and name is distinct from clean_name;
    perform internal.w1_set_writer(null);
  end if;
  return internal.ledger_record(p_client_mutation_id, 'spaces.projects.create', jsonb_build_object(
    'spaceId', p_space_id, 'folderId', p_folder_id, 'projectId', projection_id));
end
$$;
revoke all on function public.create_space_project(uuid, uuid, text, text) from public;
grant execute on function public.create_space_project(uuid, uuid, text, text) to tm8_app;

-- The space's projects for a member of it. NO PATH: this is the member view.
create or replace function public.space_projects_for_caller(p_space_id uuid)
returns table (
  project_id uuid, folder_id uuid, name text, repo_url text, trust text, defaults jsonb,
  materialized_version integer, created_at timestamptz, updated_at timestamptz
) language sql stable security definer set search_path = public, internal, pg_temp as $$
  select link.project_entity_id, sp.project_id, detail.name, detail.repo_url, folder.trust,
         folder.defaults, detail.materialized_version, projection.created_at, projection.updated_at
    from public.space_projects sp
    join public.project_links link
      on link.space_id = sp.space_id and link.project_id = sp.project_id
    join public.entities projection
      on projection.id = link.project_entity_id and projection.deleted_at is null
    join public.project_projection_details detail on detail.entity_id = link.project_entity_id
    join public.projects folder on folder.id = sp.project_id
   where sp.space_id = p_space_id
     and sp.space_id = any (internal.member_space_ids())
   order by detail.name, link.project_entity_id
$$;
revoke all on function public.space_projects_for_caller(uuid) from public;
grant execute on function public.space_projects_for_caller(uuid) to tm8_app;

-- Entity -> grant -> path, for the SERVER. `p_ref` is the space's project
-- entity id or, until the clients move to entity ids, the folder id.
--   * a project entity: live, in a space the caller is a member of (pinned),
--     with its grant active;
--   * a folder id: granted to a space the caller is a member of (pinned), or
--     any folder for a gate admin (space columns null when ungranted).
-- `p_space_id`, when given, must be that space. Zero rows means not found,
-- whatever the reason, so the answer is not an existence oracle.
create or replace function public.resolve_project_ref(p_ref uuid, p_space_id uuid default null)
returns table (
  folder_id uuid, project_entity_id uuid, space_id uuid, name text, working_dir text,
  trust text, repo_url text, defaults jsonb
) language sql stable security definer set search_path = public, internal, pg_temp as $$
  with mine as (select internal.member_space_ids() ids),
  by_entity as (
    select folder.id folder_id, link.project_entity_id, link.space_id, detail.name,
           folder.working_dir, folder.trust, folder.repo_url, folder.defaults, 0 rank
      from public.project_links link
      join public.space_projects sp
        on sp.space_id = link.space_id and sp.project_id = link.project_id
      join public.entities projection
        on projection.id = link.project_entity_id and projection.deleted_at is null
      join public.project_projection_details detail on detail.entity_id = link.project_entity_id
      join public.projects folder on folder.id = link.project_id
     where link.project_entity_id = p_ref
       and link.space_id = any ((select ids from mine)::uuid[])
       and (p_space_id is null or link.space_id = p_space_id)
  ),
  by_folder as (
    select folder.id, link.project_entity_id, sp.space_id, detail.name,
           folder.working_dir, folder.trust, folder.repo_url, folder.defaults, 1
      from public.projects folder
      join public.space_projects sp on sp.project_id = folder.id
      join public.project_links link
        on link.space_id = sp.space_id and link.project_id = sp.project_id
      join public.project_projection_details detail on detail.entity_id = link.project_entity_id
     where folder.id = p_ref
       and sp.space_id = any ((select ids from mine)::uuid[])
       and (p_space_id is null or sp.space_id = p_space_id)
  ),
  gate as (
    select folder.id, null::uuid, null::uuid, folder.name,
           folder.working_dir, folder.trust, folder.repo_url, folder.defaults, 2
      from public.projects folder
     where folder.id = p_ref and p_space_id is null and internal.is_node_admin()
       and coalesce(current_setting('tm8.session_space_id', true), '') = ''
  )
  select folder_id, project_entity_id, space_id, name, working_dir, trust, repo_url, defaults
    from (select * from by_entity union all select * from by_folder union all select * from gate) hit
   order by rank, space_id
   limit 1
$$;
revoke all on function public.resolve_project_ref(uuid, uuid) from public;
grant execute on function public.resolve_project_ref(uuid, uuid) to tm8_app;

-- Every folder granted to one space, for the server's skill scan (roots and
-- project boundaries). Member of the space (pinned) or nothing.
create or replace function public.space_folders_for_caller(p_space_id uuid)
returns table (folder_id uuid, working_dir text, trust text, defaults jsonb)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select folder.id, folder.working_dir, folder.trust, folder.defaults
    from public.space_projects sp
    join public.projects folder on folder.id = sp.project_id
   where sp.space_id = p_space_id
     and sp.space_id = any (internal.member_space_ids())
   order by folder.id
$$;
revoke all on function public.space_folders_for_caller(uuid) from public;
grant execute on function public.space_folders_for_caller(uuid) to tm8_app;

-- start_chat (176) reads public.projects inside SECURITY DEFINER, so it keeps
-- resolving the folder for a member; it now also accepts the project entity id
-- through the server, which maps it to the folder before calling.

reset role;
