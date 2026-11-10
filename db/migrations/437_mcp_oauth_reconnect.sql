-- Reconsenting the same provider account preserves its selections and shares.
create function public.reconnect_mcp_credential(p_id uuid, p_space uuid, p_server uuid,
  p_label text, p_ciphertext bytea, p_nonce bytea, p_shape text,
  p_expires_at timestamptz, p_refreshable boolean, p_expected_revision integer,
  p_scope text, p_key_id text, p_account_label text, p_granted_scopes text[])
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space);
  perform pg_advisory_xact_lock(hashtextextended(p_server::text, 297));
  stored := internal.lock_managed_space_credential(p_id);
  if stored.provider <> 'mcp' or stored.shape <> 'token' or p_shape is distinct from 'token'
    or stored.space_id <> p_space or stored.mcp_server_id is distinct from p_server
    or stored.status not in ('active', 'stale', 'needs_reconnect')
    or nullif(lower(btrim(p_account_label)), '') is null
    or lower(btrim(stored.account_label)) is distinct from lower(btrim(p_account_label))
    or p_scope is null or p_scope not in ('member', 'space')
    or (stored.owner_account_id is null) <> (p_scope = 'space') then
    raise exception 'MCP credential unavailable' using errcode = '42501';
  end if;
  if stored.owner_account_id is null then
    perform internal.require_space_admin(p_space);
  elsif stored.owner_account_id is distinct from internal.current_account_id() then
    raise exception 'MCP credential unavailable' using errcode = '42501';
  end if;
  if p_expected_revision is null or not exists (
    select 1 from public.entities e join public.mcp_servers s on s.entity_id = e.id
    where e.id = p_server and e.space_id = p_space and e.deleted_at is null
      and s.definition->>'approved' = 'true' and coalesce(s.definition->>'enabled', 'true') = 'true'
      and s.definition->'auth'->>'type' = 'oauth2'
      and s.mcp_security_revision = p_expected_revision
  ) then raise exception 'MCP server not found' using errcode = 'P0002'; end if;
  if p_ciphertext is null or octet_length(p_ciphertext) not between 16 and 1048576
    or p_nonce is null or octet_length(p_nonce) <> 12 then
    raise exception 'Invalid sealed credential' using errcode = '22023';
  end if;
  update public.space_credentials set
    secret_ciphertext = p_ciphertext, secret_nonce = p_nonce, key_id = p_key_id,
    mcp_definition_fingerprint = internal.mcp_security_fingerprint(p_server),
    mcp_definition_version = p_expected_revision, mcp_expires_at = p_expires_at,
    mcp_refreshable = p_refreshable, granted_scopes = p_granted_scopes,
    status = 'active', status_reason = null, last_probe_at = now()
  where id = stored.id;
  return jsonb_build_object('id', stored.id, 'serverId', p_server, 'scope', p_scope);
end $$;
revoke all on function public.reconnect_mcp_credential(uuid,uuid,uuid,text,bytea,bytea,text,timestamptz,boolean,integer,text,text,text,text[]) from public;
grant execute on function public.reconnect_mcp_credential(uuid,uuid,uuid,text,bytea,bytea,text,timestamptz,boolean,integer,text,text,text,text[]) to tm8_app;
