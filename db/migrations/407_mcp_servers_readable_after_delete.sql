-- =============================================================================
-- 407  A DELETED CONNECTOR'S DEFINITION STAYS READABLE TO ITS SPACE.
--
-- 296's `mcp_servers_select` hid a row the moment its entity was soft-deleted.
-- The generic delete (`entities.delete` -> delete_entity) then builds its
-- command result in the SAME transaction, reads the now-deleted entity's
-- summary, finds `mcp_definition` NULL, and `McpServerDefinitionSchema.parse`
-- throws -- so the whole delete answered 500 and rolled back. No connector
-- could be deleted that way.
--
-- A definition holds no secrets (literal env/header maps are refused by
-- validate_mcp_definition), and every app query that must not see a deleted
-- connector already filters `e.deleted_at is null` itself, as do the
-- credential RPCs. So the policy now admits any active member of the
-- connector's space, deleted or not.
-- =============================================================================
drop policy if exists mcp_servers_select on public.mcp_servers;
create policy mcp_servers_select on public.mcp_servers for select to tm8_app using (
  exists(select 1 from public.entities e where e.id=entity_id and internal.is_space_member(e.space_id) offset 0));
