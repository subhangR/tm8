-- Preserve deleted-connector readability while computing membership once per statement.
drop policy mcp_servers_select on public.mcp_servers;
create policy mcp_servers_select on public.mcp_servers for select to tm8_app using (
  exists(select 1 from public.entities e where e.id=entity_id
    and e.space_id = any ((select internal.member_space_ids())::uuid[]) offset 0));
