-- =============================================================================
-- ROLLBACK for 328_chat_turn_team.sql — NOT a migration (db/migrate.mjs never
-- reads this directory). Run by hand, as the migration owner, only to undo 328:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/328_chat_turn_team.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '328_chat_turn_team.sql'"
--
-- Turns already stamped lose their team; the bodies never carried it, so no
-- transcript changes. The server tolerates the missing functions (the stamp
-- and the read are best-effort), but redeploy the pre-328 server alongside.
-- =============================================================================

set role tm8_graph_owner;

drop function if exists public.chat_turn_team(uuid);
drop function if exists public.set_chat_turn_team(uuid, jsonb);
alter table public.chat_turns drop column if exists team;

reset role;
