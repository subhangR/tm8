-- Provider tool schemas can exceed the original 256 KiB cache cap.
-- Transport still caps upstream responses at 2 MiB; allow JSONB serialization
-- overhead while retaining a bounded 4 MiB persisted health record.
create or replace function public.record_mcp_server_health(p_server_id uuid,p_result jsonb) returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare e public.entities; m uuid;
begin
 e:=internal.live_entity(p_server_id,'mcp_server'); perform internal.require_space_member(e.space_id);
 if not internal.entity_readable(e.id) then raise exception 'MCP connector unavailable' using errcode='42501'; end if;
 m:=internal.current_member_id(e.space_id);
 if jsonb_typeof(p_result)<>'object' or not (p_result ?& array['ready','reason','tools','checkedAt'])
 or jsonb_typeof(p_result->'ready')<>'boolean' or jsonb_typeof(p_result->'tools')<>'array'
 or octet_length(p_result::text)>4194304 then raise exception 'invalid MCP health result' using errcode='22023'; end if;
 insert into public.mcp_server_health(server_id,member_id,definition_version,result) values(e.id,m,e.version,p_result)
 on conflict(server_id,member_id) do update set definition_version=excluded.definition_version,result=excluded.result,checked_at=now();
 return p_result;
end $$;
