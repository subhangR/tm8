-- =============================================================================
-- ROLLBACK for 326_space_admin_projects.sql — NOT a migration (db/migrate.mjs
-- never reads this directory). Run by hand, as the migration owner, only to
-- undo 326:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/326_space_admin_projects.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '326_space_admin_projects.sql'"
--
-- Folders and space projects a space admin already registered through
-- `register_space_folder` stay: they are ordinary `projects` / `space_projects`
-- rows (untrusted unless a node admin trusted them). Only the door and the
-- `default_branch` column go. packages/server/test/db/space-admin-projects.pg.test.ts
-- runs down -> up.
-- =============================================================================

set role tm8_graph_owner;

drop function if exists public.register_space_folder(uuid, text, text, text, text, text, text);

alter table public.projects drop constraint if exists projects_default_branch_check;
alter table public.projects drop column if exists default_branch;

reset role;
