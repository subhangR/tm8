-- =============================================================================
-- 008 RLS — SELECT-only policies plus the exact grant set for tm8_app.
--
-- The posture (D8, affirmed in 01 §8.1):
--   * RLS SELECT policies are the read authority. tm8_app is not an owner, so
--     they apply to it — this is why the owner/app role split in 001 exists.
--   * tm8_app has NO insert/update/delete on ANY table. Every write is a
--     SECURITY DEFINER RPC from 007, which makes the write surface enumerable:
--     `\df public.*` IS the list of things that can change data.
--   * There is no bypass role, no flag, and no service credential. The strongest
--     thing tm8-server holds is a connection as tm8_app.
--
-- Read predicates resolve membership from tables via the claim helpers (002).
-- An unset `tm8.identity_id` claim yields zero rows everywhere — a request that
-- forgot to bind identity fails closed, silently and safely.
--
-- Deliberately NOT readable by tm8_app: accounts, auth_sessions (credential
-- material — reached only through the auth RPCs), command_ledger,
-- notification_outbox, undo_tokens, space_event_seq. The server uses RPCs for
-- those, so a read bug cannot leak a token hash.
-- =============================================================================
set role tm8_graph_owner;

-- One predicate for "can the caller see this entity", used by every detail table
-- so the rule lives in one place and cannot drift table by table.
create or replace function internal.entity_readable(target uuid) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select exists (
    select 1 from public.entities e
     where e.id = target
       and e.visibility = 'space'          -- 'restricted' is inert in v1 (01 §S4);
       and internal.is_space_member(e.space_id)
  )
$$;
-- Activation note (01 §S4): restricted visibility becomes reachable by adding
-- `or internal.has_visible_to_edge(target)` above — a policy change, not a
-- migration. The `visible_to` edge type is already registered for exactly that.

-- -----------------------------------------------------------------------------
-- 1. Enable RLS everywhere. Every table, no exceptions — a table without RLS is
--    a table whose access rules live in whatever query happens to touch it.
-- -----------------------------------------------------------------------------
do $enable$
declare t text;
begin
  foreach t in array array[
    'spaces','projects','space_projects','entity_kinds','entities','entity_counters',
    'entity_versions','edge_types','edges','channels','tasks','task_axes','documents',
    'files','pull_requests','commits','spells','skills','collections','work_sessions',
    'messages','user_profiles','accounts','members','team_members','auth_sessions',
    'space_invites','activity','read_marks','notifications','notification_outbox',
    'space_event_seq','workspace_events','saved_views','point_events','command_ledger',
    'undo_tokens','custom_entities','session_manifests','session_modals','stream_grants',
    'file_upload_slots','tracking_refresh_requests'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$enable$;

-- -----------------------------------------------------------------------------
-- 2. SELECT policies.
-- -----------------------------------------------------------------------------

-- A space is visible to its members, and public spaces are visible to any
-- authenticated identity so discovery is a plain query. (The legacy branch hid
-- public spaces from SELECT and needed a definer RPC to list them — a policy
-- doing the honest thing is simpler than an RPC working around it.)
create policy spaces_select on public.spaces for select to tm8_app
  using (internal.is_space_member(id)
         or (visibility = 'public' and internal.identity_id() is not null));

create policy entities_select on public.entities for select to tm8_app
  using (visibility = 'space' and internal.is_space_member(space_id));

create policy entity_counters_select on public.entity_counters for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy entity_versions_select on public.entity_versions for select to tm8_app
  using (internal.entity_readable(entity_id));

-- The registry is reference data for anyone authenticated: knowing that
-- `assigned_to` exists leaks nothing about who is assigned to what.
create policy edge_types_select on public.edge_types for select to tm8_app
  using (internal.identity_id() is not null);

create policy edges_select on public.edges for select to tm8_app
  using (internal.is_space_member(space_id));

-- Detail tables inherit the envelope's visibility, uniformly.
create policy channels_select on public.channels for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy tasks_select on public.tasks for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy documents_select on public.documents for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy files_select on public.files for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy pull_requests_select on public.pull_requests for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy commits_select on public.commits for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy spells_select on public.spells for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy skills_select on public.skills for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy collections_select on public.collections for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy work_sessions_select on public.work_sessions for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy custom_entities_select on public.custom_entities for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy members_select on public.members for select to tm8_app
  using (internal.is_space_member(space_id));
create policy team_members_select on public.team_members for select to tm8_app
  using (internal.entity_readable(entity_id));

-- A message needs BOTH its own envelope and its anchor to be readable: a reply
-- under a channel you cannot see is not yours to read.
create policy messages_select on public.messages for select to tm8_app
  using (internal.entity_readable(entity_id) and internal.entity_readable(anchor_id));

create policy task_axes_select on public.task_axes for select to tm8_app
  using (internal.is_space_member(space_id));

-- Core kinds are global reference data; custom kinds belong to their space.
create policy entity_kinds_select on public.entity_kinds for select to tm8_app
  using ((space_id is null and internal.identity_id() is not null)
         or internal.is_space_member(space_id));

-- Your own profile, plus the profiles of people you share a space with.
create policy user_profiles_select on public.user_profiles for select to tm8_app
  using (identity_id = internal.identity_id()
         or exists (
           select 1 from public.members mine
           join public.members theirs on theirs.space_id = mine.space_id
            where mine.identity_id = internal.identity_id()
              and theirs.identity_id = user_profiles.identity_id));

create policy activity_select on public.activity for select to tm8_app
  using (internal.is_space_member(space_id));
create policy point_events_select on public.point_events for select to tm8_app
  using (internal.is_space_member(space_id));

-- Read marks and notifications are personal: "mine" is the whole rule.
create policy read_marks_select on public.read_marks for select to tm8_app
  using (exists (select 1 from public.members m
                  where m.entity_id = read_marks.member_id
                    and m.identity_id = internal.identity_id()));
create policy notifications_select on public.notifications for select to tm8_app
  using (exists (select 1 from public.members m
                  where m.entity_id = notifications.recipient_member_id
                    and m.identity_id = internal.identity_id()));

-- The event log: the space feed, plus the caller's own personal events. This is
-- the read side of the two-feed split that removed the fan-out amplification.
create policy workspace_events_select on public.workspace_events for select to tm8_app
  using (internal.is_space_member(space_id)
         and (recipient_member_id is null
              or exists (select 1 from public.members m
                          where m.entity_id = workspace_events.recipient_member_id
                            and m.identity_id = internal.identity_id())));

create policy saved_views_select on public.saved_views for select to tm8_app
  using (internal.is_space_member(space_id)
         and (share_mode = 'space'
              or exists (select 1 from public.members m
                          where m.entity_id = saved_views.owner_member_id
                            and m.identity_id = internal.identity_id())));

-- Invite CODES are credentials: admins only. Everyone else sees them through
-- SpaceSettings, which is an admin screen.
create policy space_invites_select on public.space_invites for select to tm8_app
  using (internal.is_space_admin(space_id));

-- A project is visible to members of any space it is linked to (they will spawn
-- into it), and to node admins (they administer the registry).
create policy projects_select on public.projects for select to tm8_app
  using (internal.is_node_admin()
         or exists (select 1 from public.space_projects sp
                     where sp.project_id = projects.id
                       and internal.is_space_member(sp.space_id)));
create policy space_projects_select on public.space_projects for select to tm8_app
  using (internal.is_space_member(space_id));

create policy session_manifests_select on public.session_manifests for select to tm8_app
  using (internal.entity_readable(work_session_id));
create policy session_modals_select on public.session_modals for select to tm8_app
  using (internal.is_space_member(space_id));
-- A stream grant names who may watch a live terminal: you see your own grants,
-- and the session owner sees the ones they issued.
create policy stream_grants_select on public.stream_grants for select to tm8_app
  using (subject_identity = internal.identity_id()
         or internal.entity_readable(work_session_id));

-- An upload slot belongs to whoever opened it.
create policy file_upload_slots_select on public.file_upload_slots for select to tm8_app
  using (exists (select 1 from public.members m
                  where m.entity_id = file_upload_slots.created_by
                    and m.identity_id = internal.identity_id()));

create policy tracking_refresh_select on public.tracking_refresh_requests for select to tm8_app
  using (internal.is_space_member(space_id));

-- accounts, auth_sessions, command_ledger, notification_outbox, undo_tokens and
-- space_event_seq get NO policy on purpose. RLS is enabled with zero policies,
-- which means zero rows for tm8_app — the auth RPCs are the only way in.

-- -----------------------------------------------------------------------------
-- 3. Grants — the whole privilege surface of tm8_app, in one auditable block.
-- -----------------------------------------------------------------------------
grant usage on schema public to tm8_app;

grant select on
  public.spaces, public.projects, public.space_projects, public.entity_kinds,
  public.entities, public.entity_counters, public.entity_versions,
  public.edge_types, public.edges,
  public.channels, public.tasks, public.task_axes, public.documents, public.files,
  public.pull_requests, public.commits, public.spells, public.skills,
  public.collections, public.work_sessions, public.custom_entities,
  public.messages, public.user_profiles, public.members, public.team_members,
  public.space_invites, public.activity, public.read_marks, public.notifications,
  public.workspace_events, public.saved_views, public.point_events,
  public.session_manifests, public.session_modals, public.stream_grants,
  public.file_upload_slots, public.tracking_refresh_requests
to tm8_app;

-- No INSERT/UPDATE/DELETE is granted anywhere, to anyone, ever. If a future
-- migration needs one, that is the moment to ask why the operation is not an RPC.

-- Every function in `public` IS the contract write surface, so EXECUTE is
-- granted wholesale there — and revoked from PUBLIC first so it is a deliberate
-- grant to one role, not the Postgres default of "everybody".
revoke all on all functions in schema public from public;
grant execute on all functions in schema public to tm8_app;

-- `internal` stays closed, with one exception: RLS policy expressions are
-- evaluated as the QUERYING role, so tm8_app must be able to execute the
-- read-only predicates the policies above name. Nothing else in `internal` is
-- reachable — the trigger and helper functions are called from definer contexts.
grant usage on schema internal to tm8_app;
revoke all on all functions in schema internal from public;
grant execute on function
  internal.identity_id(), internal.account_id(), internal.is_node_admin(),
  internal.acting_as(), internal.actor_id(),
  internal.is_space_member(uuid), internal.is_space_admin(uuid),
  internal.can_act_as(uuid, uuid), internal.current_member_id(uuid),
  internal.entity_readable(uuid), internal.is_resolved(uuid), internal.uuid_at(timestamptz)
to tm8_app;

-- Future tables/functions do NOT inherit anything: default privileges are left
-- untouched on purpose, so a new table is unreadable until a migration says
-- otherwise. Failing closed is the point.

reset role;
