-- =============================================================================
-- ROLLBACK for 382_loop_run_claim.sql — NOT a migration (db/migrate.mjs never
-- reads this directory). Run by hand, as the migration owner, only to undo 382:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/382_loop_run_claim.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '382_loop_run_claim.sql'"
--
-- Destroys no data: 382 added functions only. `loop_runs` rows written through
-- the claim door stay (they are ordinary 378 rows), and `loops.last_error`
-- values the orphan sweep wrote stay as text. 378's `loops_due_for_executor`,
-- `loop_run_record` and `loop_run_settle` are untouched by 382 and remain.
-- =============================================================================

set role tm8_graph_owner;

drop function if exists public.loop_runs_open_for_executor(timestamptz);
drop function if exists public.loop_run_launch_failed(uuid,text,timestamptz);
drop function if exists public.loop_run_launched(uuid,uuid,uuid);
drop function if exists public.loop_run_claim(uuid,timestamptz,text,uuid[],timestamptz,text,text,uuid,boolean,text);
drop function if exists public.loops_park_orphans(timestamptz);
drop function if exists public.loops_claimable(integer,timestamptz);
drop function if exists public.loop_acting_as(uuid);
drop function if exists internal.loop_acting_identity(uuid);

reset role;
