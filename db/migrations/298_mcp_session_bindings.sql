-- Durable launch references are server-owned, outside generic graph writers.
set role tm8_graph_owner;
create table internal.mcp_launch_selections (
  session_id uuid primary key references public.entities(id) on delete cascade,
  selections jsonb not null check (jsonb_typeof(selections)='array'),
  launcher_identity_id text not null,
  launcher_auth_kind text not null
);
create table internal.mcp_session_bindings (
  session_id uuid primary key references public.entities(id) on delete cascade,
  space_id uuid not null references public.spaces(id) on delete cascade,
  auth_session_id uuid not null references public.auth_sessions(id) on delete cascade,
  runtime_identity_id text not null,
  launcher_identity_id text not null,
  launcher_auth_kind text not null,
  selections jsonb not null check (jsonb_typeof(selections)='array')
);
revoke all on internal.mcp_launch_selections, internal.mcp_session_bindings from public, tm8_app;

-- Called only by the chat creation handler in the same transaction as start_chat.
create function public.save_chat_mcp_selections(p_chat uuid,p_selections jsonb)
returns void language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare target_space uuid;
begin
  perform internal.require_human_auth_kind();
  select c.space_id into target_space from public.chats c join public.entities e on e.id=c.entity_id
    where c.entity_id=p_chat and c.configured_by_identity_id=internal.identity_id() and e.deleted_at is null;
  if target_space is null then
    raise exception 'MCP chat unavailable' using errcode='42501';
  end if;
  perform internal.require_space_member(target_space);
  if jsonb_typeof(p_selections) <> 'array' or jsonb_array_length(p_selections)>32 then
    raise exception 'Invalid MCP selections' using errcode='22023';
  end if;
  insert into internal.mcp_launch_selections values(p_chat,p_selections,internal.identity_id(),internal.claim_text('tm8.auth_kind')) on conflict do nothing;
end $$;

create function public.read_mcp_launch_selections(p_session uuid)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare result jsonb;
begin
  if not internal.entity_readable(p_session) then raise exception 'MCP session unavailable' using errcode='42501'; end if;
  select selections into result from internal.mcp_launch_selections where session_id=p_session;
  return result;
end $$;

-- The freshly minted bearer hash proves the runtime association. Callers cannot
-- name a different launcher: it always comes from the authenticated DB claims.
create function public.bind_mcp_session(p_session uuid,p_token_hash text,p_selections jsonb)
returns void language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare s public.auth_sessions; runtime_identity text; target_space uuid; pick jsonb; definition jsonb; launcher text:=internal.identity_id();
begin
  if launcher is null or coalesce(internal.claim_text('tm8.via_link'),'')<>'' then raise exception 'MCP session unavailable' using errcode='42501'; end if;
  select * into s from public.auth_sessions where token_hash=p_token_hash and revoked_at is null and expires_at>now() and via_link_id is null;
  if s.id is null or not ((s.kind='agent' and s.work_session_id=p_session) or (s.kind='agent_runtime' and s.runtime_chat_id=p_session)) then
    raise exception 'MCP runtime unavailable' using errcode='42501';
  end if;
  select identity_id into runtime_identity from public.accounts where id=s.account_id and status='active';
  select space_id into target_space from public.entities where id=p_session and deleted_at is null;
  perform internal.require_space_member(target_space);
  if runtime_identity is null or s.space_id is distinct from target_space or not internal.entity_readable(p_session) then
    raise exception 'MCP session unavailable' using errcode='42501';
  end if;
  if jsonb_typeof(p_selections) <> 'array' or jsonb_array_length(p_selections)>32 then raise exception 'Invalid MCP selections' using errcode='22023'; end if;
  for pick in select value from jsonb_array_elements(p_selections) loop
    select m.definition into definition from public.mcp_servers m join public.entities e on e.id=m.entity_id
      where e.id=(pick->>'serverId')::uuid and e.space_id=target_space and e.deleted_at is null;
    if definition is null or definition->>'approved'<>'true' or definition->>'enabled'='false'
      or (definition->>'transport'='stdio' and coalesce(definition->>'stdioTrusted','false')<>'true') then
      raise exception 'MCP connector unavailable' using errcode='42501';
    end if;
    if definition->'auth'->>'type'<>'none' then
      if pick->>'credentialId' is null then raise exception 'Select an MCP account' using errcode='42501'; end if;
      perform public.read_mcp_credential(target_space,(pick->>'serverId')::uuid,(pick->>'credentialId')::uuid);
    elsif pick->>'credentialId' is not null then raise exception 'Unexpected MCP account' using errcode='42501'; end if;
  end loop;
  insert into internal.mcp_session_bindings values(p_session,target_space,s.id,runtime_identity,launcher,coalesce(internal.claim_text('tm8.auth_kind'),''),p_selections)
    on conflict(session_id) do update set auth_session_id=excluded.auth_session_id,runtime_identity_id=excluded.runtime_identity_id,
      launcher_identity_id=excluded.launcher_identity_id,launcher_auth_kind=excluded.launcher_auth_kind,selections=excluded.selections;
  insert into internal.mcp_launch_selections values(p_session,p_selections,launcher,coalesce(internal.claim_text('tm8.auth_kind'),''))
    on conflict(session_id) do update set selections=excluded.selections,launcher_identity_id=excluded.launcher_identity_id,launcher_auth_kind=excluded.launcher_auth_kind;
end $$;

-- auth session id is supplied from verified bearer provenance, never the body.
create function public.read_mcp_session_binding(p_session uuid,p_auth_session uuid)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare b internal.mcp_session_bindings;
begin
  select * into b from internal.mcp_session_bindings where session_id=p_session and auth_session_id=p_auth_session;
  if b.session_id is null or b.runtime_identity_id is distinct from internal.identity_id()
    or coalesce(internal.claim_text('tm8.via_link'),'')<>'' then raise exception 'MCP session unavailable' using errcode='42501'; end if;
  perform internal.require_space_member(b.space_id);
  if not exists(select 1 from public.auth_sessions s join public.accounts a on a.id=s.account_id
      where s.id=b.auth_session_id and s.revoked_at is null and s.expires_at>now() and s.via_link_id is null and a.status='active')
    or not exists(select 1 from public.members m join public.accounts a on a.identity_id=m.identity_id where m.space_id=b.space_id and m.identity_id=b.launcher_identity_id and a.status='active')
    or not exists(select 1 from public.entities e where e.id=p_session and e.deleted_at is null and
      (exists(select 1 from public.work_sessions w where w.entity_id=e.id and w.status in ('spawning','running','idle'))
       or exists(select 1 from public.chats c where c.entity_id=e.id and c.runtime_state='live'))) then
    raise exception 'MCP session unavailable' using errcode='42501';
  end if;
  return jsonb_build_object('sessionId',b.session_id,'spaceId',b.space_id,'identityId',b.runtime_identity_id,
    'launcherIdentityId',b.launcher_identity_id,'launcherAuthKind',b.launcher_auth_kind,'selections',b.selections);
end $$;
revoke all on function public.save_chat_mcp_selections(uuid,jsonb),public.read_mcp_launch_selections(uuid),public.bind_mcp_session(uuid,text,jsonb),public.read_mcp_session_binding(uuid,uuid) from public;
grant execute on function public.save_chat_mcp_selections(uuid,jsonb),public.read_mcp_launch_selections(uuid),public.bind_mcp_session(uuid,text,jsonb),public.read_mcp_session_binding(uuid,uuid) to tm8_app;
reset role;
