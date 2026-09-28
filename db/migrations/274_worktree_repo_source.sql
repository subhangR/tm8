-- =============================================================================
-- 274 — worktree_repo_source(worktree): the commit recorder's folder key,
-- read past 234's gate-only projects_select (R845-F4, task 01a0dc15-c10b).
--
-- THE BUG. The commit recorder (packages/server/src/tracking/commit-recorder.ts)
-- runs as the node's loopback owner and joined `public.projects` to get the
-- lane's repo_url and folder name. 234 narrowed `projects_select` to an
-- unpinned gate (node) admin, so on a node whose loopback owner is a space
-- owner but NOT a node admin the join dropped every lane and the tick recorded
-- nothing, silently.
--
-- THE KEY STAYS THE FOLDER NAME. `laneRepo` writes `local:<folder name>` into
-- `commits.repo` for a folder with no remote, and `record_session_commit`
-- dedupes on space+provider+repo+sha. Reading the name from the space's
-- project entity (project_projection_details.name, which 234 lets a space admin
-- rename) instead would re-key every existing local commit row and mint a
-- duplicate mirror per sha. So this returns `projects.name`, exactly the value
-- the join read, and nothing re-keys.
--
-- THE CONTRACT, NARROW. One worktree in, its folder's repo_url and name out,
-- and only when the caller can read that worktree entity:
-- `internal.entity_readable` (227) is the pinned membership check that
-- `worktrees_select` (218) already applies, so the rows the recorder sees are
-- unchanged and a session pinned to space A resolves nothing of B's. No path,
-- no trust, no defaults: a member who can read a lane learns the name and
-- remote of the folder it was cut from, which the space's project entity
-- (space_projects_for_caller, 234) already shows them. Server-only; never
-- mounted as an operation.
--
-- 234 IS NOT LOOSENED: projects_select is untouched.
--
-- NOT AN identity_id() READER. The body names no root of
-- tools/ci/identity-id-gate.sh; it reaches the caller only through
-- internal.entity_readable, which is on the allow-list as a PIN-HELPER.
--
-- A NOTE ON 234's HEADER (R845-F7's deferred comment fixes). 234:26 and :105
-- say "235" fills the new columns on existing rows. There is no 235: that
-- backfill landed as 259. 234 is not edited to say so, because it is applied
-- and migrate.mjs would report checksum drift.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function public.worktree_repo_source(p_worktree_id uuid)
returns table (repo_url text, folder_name text)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select folder.repo_url, folder.name
    from public.worktrees w
    join public.projects folder on folder.id = w.project_id
   where w.entity_id = p_worktree_id
     and internal.entity_readable(w.entity_id)
$$;

comment on function public.worktree_repo_source(uuid) is
  'R845-F4 (274): the repo_url and FOLDER name (projects.name, the laneRepo local:<name> key) of a '
  'worktree the caller can read (internal.entity_readable, pinned). Server-only, for the commit recorder.';

revoke all on function public.worktree_repo_source(uuid) from public;
grant execute on function public.worktree_repo_source(uuid) to tm8_app;

reset role;
