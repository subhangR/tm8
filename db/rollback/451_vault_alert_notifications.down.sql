-- =============================================================================
-- ROLLBACK for 451_vault_alert_notifications.sql — NOT a migration
-- (db/migrate.mjs never reads this directory). Run by hand, as the migration
-- owner, only to undo 451, with the vault relay off (TM8_VAULT_MODE=off):
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/451_vault_alert_notifications.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '451_vault_alert_notifications.sql'"
--
-- Drops the one function 451 adds. Inbox rows it already wrote (kind
-- 'vault_*') are KEPT: they are the owner's record of what the vault alerted,
-- notifications.kind is open text, and the inbox renders them without the
-- function. Delete them only on an explicit owner decision:
--   delete from public.notifications where kind like 'vault\_%' escape '\';
--
-- A relay left running with the function gone logs each failed notify and
-- keeps serving vault requests; the broker's audit chain stays the durable
-- record of every alerted event.
-- =============================================================================

drop function if exists internal.vault_notify(uuid, uuid, text, uuid, jsonb, timestamptz);
