-- =============================================================================
-- 408  DELETING A CONNECTOR REVOKES ITS CONNECTIONS.
--
-- A deleted `mcp_server` left its `space_credentials` rows `active`. Nothing
-- could use them (every credential read joins a live definition), but each one
-- went on holding its label under `space_credentials_unique_label`, which
-- admits one non-revoked row per (space, provider, label) — so re-adding the
-- same connector and connecting "subhang" again failed with a unique
-- violation against the dead connector's row. The UI also told people a
-- delete "revokes every connection", which was not true.
--
-- A trigger rather than a step in `mcp.servers.delete`, because there are two
-- doors that delete a connector — that command and the generic
-- `entities.delete` (delete_entity) — and both set `entities.deleted_at`. It
-- runs in the deleting transaction, so the delete and the revoke land or roll
-- back together.
--
-- The revoke is local, exactly as `revoke_all_mcp_credentials` (377) does it:
-- status `revoked`, not default, sealed secret dropped. It does not call the
-- provider's revocation endpoint (that needs the opened secret, which only the
-- server process holds). Restoring the connector does not bring connections
-- back; the person connects again.
-- =============================================================================

create or replace function internal.mcp_server_delete_revokes_credentials()
returns trigger language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  update public.space_credentials
     set status = 'revoked', is_default = false, pending_expires_at = null,
         secret_ciphertext = null, secret_nonce = null
   where provider = 'mcp'
     and mcp_server_id = new.id
     and space_id = new.space_id
     and status <> 'revoked';
  return null;
end $$;
revoke all on function internal.mcp_server_delete_revokes_credentials() from public;

drop trigger if exists entities_mcp_server_delete_revokes on public.entities;
create trigger entities_mcp_server_delete_revokes
  after update of deleted_at on public.entities
  for each row
  when (new.kind = 'mcp_server' and old.deleted_at is null and new.deleted_at is not null)
  execute function internal.mcp_server_delete_revokes_credentials();

-- Connectors deleted BEFORE this trigger existed left their connections active,
-- holding their labels (the live node's test-mcp credential is one). Revoke
-- them once, here, with the same columns the trigger writes. A function so the
-- pg test can exercise the exact statement this migration runs.
create or replace function internal.revoke_orphaned_mcp_credentials()
returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare n integer;
begin
  update public.space_credentials c
     set status = 'revoked', is_default = false, pending_expires_at = null,
         secret_ciphertext = null, secret_nonce = null
    from public.entities e
   where c.provider = 'mcp' and c.status <> 'revoked'
     and e.id = c.mcp_server_id and e.kind = 'mcp_server' and e.deleted_at is not null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function internal.revoke_orphaned_mcp_credentials() from public;
select internal.revoke_orphaned_mcp_credentials();
