-- MCP uses the existing sealed credential entity and sharing boundary.
set role tm8_graph_owner;
create or replace function internal.is_server_only_credential_provider(p_provider text)
returns boolean language sql immutable as $$ select coalesce(p_provider in ('typesafe', 'mcp'), false) $$;
alter table public.space_credentials
  drop constraint space_credentials_provider_check,
  add constraint space_credentials_provider_check check (provider in ('anthropic','openai','github','typesafe','mcp')),
  drop constraint space_credentials_provider_shape_check,
  add constraint space_credentials_provider_shape_check check (
    (provider = 'github' and shape = 'token') or
    (provider in ('anthropic','openai') and shape in ('login','api_key')) or
    (provider = 'typesafe' and shape = 'api_key') or
    (provider = 'mcp' and shape in ('api_key','token'))),
  add column mcp_server_id uuid;
-- No cascading definition FK: credential removal never removes a connector.
create function public.create_mcp_credential(p_id uuid, p_space uuid, p_server uuid,
  p_label text, p_ciphertext bytea, p_nonce bytea, p_shape text default 'api_key')
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space);
  if p_server is null or not exists (select 1 from public.entities where id=p_server and space_id=p_space and deleted_at is null) then
    raise exception 'MCP server not found' using errcode='P0002';
  end if;
  result := public.create_space_credential(p_id,p_space,'mcp',p_shape,p_label,null,p_ciphertext,p_nonce,null,'private',false,false);
  update public.space_credentials set mcp_server_id=p_server where id=p_id;
  return result || jsonb_build_object('serverId',p_server);
end $$;
-- Explicit id ONLY. Never consult member_defaults or the space default.
-- This returns ciphertext to the server; no public operation exposes this RPC.
create function public.read_mcp_credential(p_space uuid,p_server uuid,p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare c public.space_credentials; a uuid;
begin
  perform internal.require_space_member(p_space);
  if coalesce(internal.claim_text('tm8.via_link'),'') <> '' or coalesce(internal.claim_text('tm8.auth_kind'),'')='link' then
    raise exception 'linked MCP credentials are unavailable' using errcode='42501';
  end if;
  a := internal.current_account_id();
  select * into c from public.space_credentials where id=p_id and space_id=p_space and provider='mcp' and mcp_server_id=p_server;
  if c.id is null or c.status <> 'active' or a is null or not (
    c.owner_account_id=a or c.visibility='public' or internal.space_credential_shared_with(c.id,a)) then
    raise exception 'MCP credential unavailable' using errcode='42501';
  end if;
  return jsonb_build_object('credentialId',c.id,'spaceId',c.space_id,'serverId',c.mcp_server_id,
    'ciphertext',encode(c.secret_ciphertext,'base64'),'nonce',encode(c.secret_nonce,'base64'));
end $$;
-- Refresh uses compare-and-swap so a concurrent revoke or rotation wins.
create function public.refresh_mcp_credential(p_space uuid,p_server uuid,p_id uuid,p_old_nonce bytea,p_ciphertext bytea,p_nonce bytea)
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform public.read_mcp_credential(p_space,p_server,p_id);
  update public.space_credentials set secret_ciphertext=p_ciphertext,secret_nonce=p_nonce
    where id=p_id and status='active' and secret_nonce=p_old_nonce;
  return found;
end $$;
revoke all on function public.create_mcp_credential(uuid,uuid,uuid,text,bytea,bytea,text) from public;
revoke all on function public.read_mcp_credential(uuid,uuid,uuid) from public;
revoke all on function public.refresh_mcp_credential(uuid,uuid,uuid,bytea,bytea,bytea) from public;
grant execute on function public.create_mcp_credential(uuid,uuid,uuid,text,bytea,bytea,text) to tm8_app;
grant execute on function public.read_mcp_credential(uuid,uuid,uuid) to tm8_app;
grant execute on function public.refresh_mcp_credential(uuid,uuid,uuid,bytea,bytea,bytea) to tm8_app;
reset role;
