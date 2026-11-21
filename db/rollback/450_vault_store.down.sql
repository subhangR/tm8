-- Additive vault-only rollback; no graph data is changed.
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
