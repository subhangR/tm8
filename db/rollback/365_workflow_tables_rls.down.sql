-- =============================================================================
-- ROLLBACK for 365_workflow_tables_rls.sql — NOT a migration (db/migrate.mjs
-- never reads this directory). Run by hand, as the migration owner, only to
-- undo 365:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/365_workflow_tables_rls.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '365_workflow_tables_rls.sql'"
--
-- Re-opens the cross-space read 365 closed: every tm8_app caller can read every
-- space's workflows again. No data changes either way.
-- =============================================================================

set role tm8_graph_owner;

drop policy if exists workflows_select on public.workflows;
drop policy if exists workflow_states_select on public.workflow_states;
drop policy if exists workflow_transitions_select on public.workflow_transitions;
drop policy if exists task_workflows_select on public.task_workflows;

alter table public.workflows            disable row level security;
alter table public.workflow_states      disable row level security;
alter table public.workflow_transitions disable row level security;
alter table public.task_workflows       disable row level security;

reset role;
