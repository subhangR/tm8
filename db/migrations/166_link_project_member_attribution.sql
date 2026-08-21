-- Project linking from an agent session.
--
-- `space_projects.linked_by` FKs to `public.members(entity_id)` (002_identity.sql:109),
-- but `link_project_w2` wrote `internal.resolve_actor(...)` straight into it. For a
-- spawned agent session `resolve_actor` returns the **team_member** id, and a teammate
-- is never a member row — so the insert always failed with
--
--   insert or update on table "space_projects" violates foreign key constraint
--   "space_projects_linked_by_fkey"
--
-- and `tm8 project link` was structurally impossible for every agent session. `--as`
-- is no escape hatch (a session-bound credential may not override its actor, by
-- design), and `projects.folderUploads.complete` plus the launch bootstrap route
-- through the same RPC, so there was no path at all. Two ProjectResources sat
-- orphaned at `active_link_count = 0` because of it.
--
-- The fix separates two things that were conflated: WHO IS ACTING (the actor, which
-- still drives `can_act_as` and `bind_actor` exactly as before) and WHO IS RECORDED
-- IN A MEMBERS COLUMN. `linked_by` is the latter, so it now stores the member the
-- actor belongs to. Authorization is untouched — a teammate that could not link
-- before still cannot; it simply no longer trips a foreign key on its way through.

-- Map an effective actor onto the member row that column-level FKs to
-- `public.members` require. A member maps to itself; a teammate maps to its owner.
--
-- `team_members.owner_member_id` is `not null` and FKs to `members(entity_id)`, so the
-- lookup cannot yield a dangling id. It is also the right member: `internal.can_act_as`
-- (002_identity.sql) admits a teammate only when `owner.space_id = target_space`, so any
-- actor that reached this point has its owner in the space being written to. The
-- `target_space` argument is kept for that reason — it is the scope the caller has
-- already authorized, and re-stating it here keeps this function honest if `can_act_as`
-- ever loosens.
--
-- Returns null only if the actor is neither a member nor a teammate, which
-- `resolve_actor` cannot produce; callers still treat null as "record nothing"
-- because `linked_by` is nullable (`on delete set null`).
create or replace function internal.member_for_actor(actor uuid, target_space uuid)
returns uuid language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select coalesce(
    (select m.entity_id from public.members m
      where m.entity_id = actor and m.space_id = target_space),
    (select tm.owner_member_id from public.team_members tm
      where tm.entity_id = actor)
  )
$$;

comment on function internal.member_for_actor(uuid, uuid) is
  'The member row an effective actor is recorded as, for columns that FK to public.members. '
  'A member maps to itself; a teammate maps to its owner_member_id. Attribution only — '
  'authorization stays with the actor via can_act_as/bind_actor.';

-- Unchanged from 021_w2_projects.sql except for the `linked_by` value.
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
