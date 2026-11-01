-- Every entity context can supply MCP defaults; account authority stays at launch.
update public.edge_types set src_kinds=array['*'], description='This entity supplies MCP connection defaults to its work; tasks, teammates and sessions can also equip skills and spells.' where type='equips';

create or replace function internal.guard_mcp_equips() returns trigger language plpgsql set search_path=public,internal,pg_temp as $$
declare edge public.edges; source public.entities; target public.entities; d jsonb;
begin
 if TG_OP='DELETE' then edge:=old; else edge:=new; end if;
 if TG_OP='UPDATE' and (old.src_id<>new.src_id or old.dst_id<>new.dst_id or old.type<>new.type) and exists(select 1 from public.entities where id=old.dst_id and kind='mcp_server') then raise exception 'MCP attachment endpoints are immutable' using errcode='42501'; end if;
 if edge.type<>'equips' then return coalesce(new,old); end if;
 select * into target from public.entities where id=edge.dst_id;
 if target.kind<>'mcp_server' then
   if TG_OP<>'DELETE' and exists(select 1 from public.entities where id=edge.src_id and kind not in ('task','team_member','work_session')) then
     raise exception 'invalid skill or spell equipment source' using errcode='42501';
   end if;
   return coalesce(new,old);
 end if;
 source:=internal.live_entity(edge.src_id,null);
 perform internal.require_space_member(source.space_id);
 if source.space_id<>target.space_id then raise exception 'invalid MCP attachment target' using errcode='42501'; end if;
 if not internal.entity_readable(target.id) then raise exception 'MCP connector is not accessible' using errcode='42501'; end if;
 if not internal.entity_readable(source.id) then raise exception 'MCP attachment target is not accessible' using errcode='42501'; end if;
 if TG_OP<>'DELETE' then
   select definition into d from public.mcp_servers where entity_id=target.id;
   if target.deleted_at is not null or (not (d->>'approved')::boolean or coalesce((d->>'enabled')::boolean,true)=false) then raise exception 'MCP attachment requires an approved connector' using errcode='42501'; end if;
   if edge.props<>'{}'::jsonb then raise exception 'MCP attachment cannot carry credentials or options' using errcode='22023'; end if;
 end if;
 return coalesce(new,old);
end $$;
