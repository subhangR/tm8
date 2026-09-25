-- =============================================================================
-- 226 — doc 15 B3 + B4: the project unlink guard counts chats, and linking a
-- project requires being able to SEE it.
--
-- B3. `internal.guard_space_project_link` (015) refuses to delete a
-- `space_projects` row while a live work session in that space launched from,
-- or is associated with, the project. A CHAT bound to the project was not
-- counted: `chats.project_id` references `public.projects(id)` (176), not the
-- link, so unlinking succeeded and left every project-mode chat in the space
-- pointing at a folder the space no longer has — `chat_start` would refuse the
-- same binding ("project is not linked to this space"), but a chat that already
-- holds it kept resuming there. The guard now also refuses while a
-- non-deleted chat in the space is bound to the project. A chat is a durable,
-- resumable conversation, so "live" is its existence, not its runtime state:
-- delete (or never create) the chat, then unlink.
--
-- B4. `public.link_project_w2` (021, last replaced by 166) checked only
-- `require_space_admin(p_space_id)`. Any space admin could therefore link ANY
-- project on the node into their own space by id — including one linked only
-- into a space they are not in — and then spawn into its folder. The caller
-- must now be able to see the project under the SAME rule `projects_select`
-- applies (008, restated by 218): a node admin, or a member of some space the
-- project is already linked into. A project the caller cannot see answers
-- exactly like one that does not exist (P0002 'Project not found'), so the
-- refusal is not an existence oracle. The legacy `public.link_project` (007)
-- had the same hole; nothing in the server calls it, but 008's blanket grant
-- still lets tm8_app execute it, so it carries the same check.
--
-- Every caller that links a project it just CREATED is a node admin
-- (`create_project` requires it: launch bootstrap, `projects.create`, folder
-- upload), so none of them is affected. W11 later removes `projects.link`.
--
-- REPLACES WHOLE FUNCTIONS: guard_space_project_link is 015's body plus the
-- chat clause; link_project_w2 is 166's body plus the visibility check;
-- link_project is 007's body plus the same check. A later file replacing any of
-- them must carry these changes too.
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.guard_space_project_link() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare active_count integer; frozen boolean; projection_id uuid;
begin
  if tg_op = 'INSERT' then
    select p.active_link_count, p.link_frozen into active_count, frozen
      from public.projects p where p.id = new.project_id for update;
    if active_count is null then
      raise exception 'Project not found' using errcode = 'P0002';
    end if;
    perform 1 from public.spaces where id = new.space_id for update;
    if frozen or active_count >= 16 then
      raise exception 'Project active-link cap reached'
        using errcode = '53400', detail = 'project_over_cap';
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
  -- B3 (226): a chat bound to this project in this space is a launch root
  -- that outlives any one runtime. Same code and detail as the session case,
  -- so every caller's existing mapping of this refusal still applies.
  if exists (
    select 1 from public.chats chat
    join public.entities chat_entity on chat_entity.id = chat.entity_id
    where chat.space_id = old.space_id
      and chat.project_id = old.project_id
      and chat_entity.deleted_at is null
  ) then
    raise exception 'Project is bound to a chat in this Space'
      using errcode = '23514', detail = 'project_not_linked';
  end if;
  return old;
end
$$;

-- B4 (226): `projects_select`'s rule, callable from a SECURITY DEFINER body
-- (where RLS does not apply). Reads the caller's claims, never an argument.
create or replace function internal.project_visible_to_caller(p_project_id uuid)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select internal.is_node_admin()
      or exists (select 1 from public.space_projects sp
                  where sp.project_id = p_project_id
                    and sp.space_id = any (internal.member_space_ids()))
$$;

comment on function internal.project_visible_to_caller(uuid) is
  'True when the caller may see the project under projects_select''s rule: node admin, '
  'or a member of a space it is linked into (226, doc 15 B4).';

revoke all on function internal.project_visible_to_caller(uuid) from public;

-- 166's body; one change: the visibility check after the row is locked.
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
  if resource.id is null or not internal.project_visible_to_caller(p_project_id) then
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
  values (p_space_id, p_project_id, internal.member_for_actor(actor, p_space_id))
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

-- 007's body; one change: the same visibility check.
create or replace function public.link_project(
  p_space_id uuid, p_project_id uuid, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.link');
  if replay is not null then return replay; end if;
  perform internal.require_space_admin(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  if not exists (select 1 from public.projects where id = p_project_id)
     or not internal.project_visible_to_caller(p_project_id) then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  insert into public.space_projects(space_id, project_id, linked_by)
  values (p_space_id, p_project_id, actor)
  on conflict (space_id, project_id) do nothing;
  return internal.ledger_record(p_client_mutation_id, 'projects.link',
           jsonb_build_object('spaceId', p_space_id, 'projectId', p_project_id, 'patches', '[]'::jsonb));
end
$$;

reset role;
