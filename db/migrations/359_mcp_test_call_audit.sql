-- =============================================================================
-- 359: connector TEST calls are audited too (via='test'). Plan §5.6, §7.5, B51.
--
-- `mcp.servers.test` decrypts a stored credential and calls the provider under
-- a HUMAN session, but 346's writer accepts only an agent runtime bearer for a
-- work session, so a test call left no row and §7.5 ("every use of a tm8-held
-- credential is recorded") was false for it.
--
-- The table already admits a test row: 357 states the whole via/session rule
-- for every shape (via admits 'test'; session_id is null exactly for 'test' and
-- 'external_token'). This migration changes NO constraint (B65): restating one
-- here would replace 357's union on a deployed database, where a newly added
-- file runs after the ones already applied. It adds only the writer.
--
-- `record_mcp_test_audit` is for human (browser / cli, no link) callers only.
-- It derives everything it can: the Space from the connector entity, the root
-- from the caller's own ACTIVE member row there (honouring the session-Space
-- pin), the credential scope from the stored credential. It writes via='test',
-- no session, no chain, no token. A caller can write only rows naming
-- themselves, about a connector in a Space they belong to.
-- =============================================================================
set local lock_timeout = '5s';

set role tm8_graph_owner;

create function public.record_mcp_test_audit(
  p_server uuid, p_credential uuid, p_outcome text, p_deny_reason text,
  p_latency_ms integer, p_request_bytes integer, p_response_bytes integer)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_space uuid;
  v_root uuid;
  v_scope text;
begin
  perform internal.require_human_auth_kind();
  if coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'MCP test audit is unavailable to a space link' using errcode = '42501';
  end if;
  select e.space_id into v_space from public.entities e where e.id = p_server and e.kind = 'mcp_server';
  if v_space is null then
    raise exception 'MCP test audit connector unavailable' using errcode = '22023';
  end if;
  perform internal.require_space_member(v_space);
  -- The root is the caller, as their own active member row in the connector's
  -- Space; a session pinned elsewhere finds none.
  select m.entity_id into v_root from public.members m
   where m.space_id = v_space and m.identity_id = internal.identity_id() and m.status = 'active'
     and (internal.session_space_id() is null or internal.session_space_id() = v_space);
  if v_root is null then
    raise exception 'not a member of this space' using errcode = '42501';
  end if;
  if p_credential is not null then
    select case when c.owner_account_id is null then 'space' else 'member' end into v_scope
      from public.space_credentials c
     where c.id = p_credential and c.space_id = v_space and c.provider = 'mcp';
    if v_scope is null then
      raise exception 'MCP audit credential is not one of this space''s MCP connections' using errcode = '22023';
    end if;
  end if;

  insert into public.mcp_call_audit(space_id, session_id, server_id, credential_id, method, outcome,
    tool, root_member_id, chain, via, chat_id, credential_scope, deny_reason,
    latency_ms, request_bytes, response_bytes)
  values (v_space, null, p_server, p_credential, 'tools/list', p_outcome,
    null, v_root, null, 'test', null, v_scope, p_deny_reason, p_latency_ms, p_request_bytes, p_response_bytes);
end
$$;
revoke all on function public.record_mcp_test_audit(uuid, uuid, text, text, integer, integer, integer) from public;
grant execute on function public.record_mcp_test_audit(uuid, uuid, text, text, integer, integer, integer) to tm8_app;

reset role;
