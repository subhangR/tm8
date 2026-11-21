-- =============================================================================
-- ROLLBACK for 450_vault_store.sql — NOT a migration (db/migrate.mjs never
-- reads this directory). Run by hand, as the migration owner, only to undo 450,
-- with no vault broker running (TM8_VAULT_MODE=off, or its unit stopped):
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/450_vault_store.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '450_vault_store.sql'"
--
-- Vault-only: drops schema vault and everything in it. No graph table, function
-- or row is touched and tm8_app is not altered. It DESTROYS every vault row
-- (items, sealed secret versions, grants, sessions, passkeys, the audit chain),
-- so a re-apply starts an empty store and a new audit chain at seq 0: archive the
-- checkpoint sink (directory or bucket prefix) and the deletion ledger first.
-- A role this drops takes its memberships with it, so after a re-apply grant
-- tm8_vault_broker to the broker's login role again (production refuses to
-- start until it holds exactly that one membership). Re-running is a no-op.
-- Proven by packages/vault/test/store/postgres-migration.test.ts (up, committed
-- down, up) and postgres-security.test.ts (the down is one transaction).
-- =============================================================================
drop schema if exists vault cascade;
-- Roles are cluster-wide and may be used by another database. Refuse silently
-- dropping a role with dependencies: retain it until the last vault is gone.
do $roles$ declare r text; begin
  foreach r in array array['tm8_vault_audit_writer','tm8_vault_broker','tm8_vault_owner'] loop
    begin execute format('drop role if exists %I', r);
    exception when dependent_objects_still_exist then null;
    end;
  end loop;
end $roles$;
