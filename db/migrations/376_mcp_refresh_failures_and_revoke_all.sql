-- =============================================================================
-- 376: refresh failures, the revoke-all kill switch, and the pending sweep.
-- Plan §7.2, §9.3(3)(4), gap G11; decisions B8, B39, B41.
--
-- * report_mcp_credential_failure: the proxy's one door for "this connection
--   cannot be used until its owner reconnects". It marks the row through 341's
--   mark_mcp_credential_needs_reconnect (one-way, B8: only a rekey or a fresh
--   connect clears it) and, ONLY when that mark changed the row, puts an inbox
--   item in front of the people who can fix it: the owner of a member
--   connection, the Space admins of a Space connection.
--
--   The possible-reuse heuristic (§7.2) is decided HERE, from the database's
--   own clock and last_refresh_at, never from the caller: an invalid_grant
--   within 10 minutes of a successful refresh is escalated to possible_reuse,
--   and for a shared connection (Space-owned, public, or shared with members)
--   the Space admins are told as well. The notice is written when the reuse is
--   DETECTED, because status_reason is cleared by the next rekey/refresh and
--   would otherwise leave no trace.
--
--   A Google refresh that leaves no tool covered reports scope_reduced (B41); a
--   partial grant is never reported and stays active with its covered tools.
--
-- * revoke_all_mcp_credentials: the §9.3(4) kill switch. With a Space it needs
--   a Space admin and revokes every MCP connection in that Space; with NULL it
--   needs the node admin and revokes every MCP connection on the node. Local
--   revocation happens HERE, first, in one transaction (status revoked, sealed
--   bytes dropped), so nothing can use a row after this returns. The rows the
--   caller may then revoke AT THE PROVIDER come back with their sealed bytes:
--     - node scope: every row;
--     - Space scope: Space-owned rows only. A member's connection gets a LOCAL
--       revoke (B39): for Google, one revoke ends the member's whole grant on
--       tm8's client, including connections in other Spaces the admin has no
--       say over.
--   Provider revoke is best-effort and runs after commit, in the server.
--
-- * sweep_mcp_oauth_pending: node admin. Deletes expired pending sign-ins.
--   342 already sweeps inside every begin; this covers a node where nobody
--   begins a connect for a long time, so abandoned sealed rows do not linger.
--
-- Nothing here replaces mcp_provenance, bind_mcp_session or
-- validate_mcp_definition.
-- =============================================================================
set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Refresh failures.
-- -----------------------------------------------------------------------------
create function public.report_mcp_credential_failure(p_space uuid, p_server uuid, p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  stored public.space_credentials;
  v_reason text := p_reason;
  v_marked jsonb;
  v_shared boolean;
  v_recipient uuid;
  v_notified integer := 0;
begin
  if p_reason is null or p_reason not in ('invalid_grant', 'scope_reduced') then
    raise exception 'a refresh failure is invalid_grant or scope_reduced' using errcode = '22023';
  end if;
  select * into stored from public.space_credentials
   where id = p_id and space_id = p_space and provider = 'mcp' and mcp_server_id = p_server;
  -- §7.2's heuristic. last_refresh_at is stamped only by a successful refresh
  -- (refresh_mcp_credential), so a refresh token refused soon after one worked
  -- suggests someone else holds and used it. A signal, not a proof: providers
  -- differ on rotation (Google rarely rotates, Slack only when opted in).
  if p_reason = 'invalid_grant' and stored.last_refresh_at is not null
     and stored.last_refresh_at > now() - interval '10 minutes' then
    v_reason := 'possible_reuse';
  end if;
  -- Every authority check (membership, link refusal, the caller can use this
  -- row, its status) is mark_mcp_credential_needs_reconnect's own.
  v_marked := public.mark_mcp_credential_needs_reconnect(p_space, p_server, p_id, v_reason);
  if not coalesce((v_marked->>'changed')::boolean, false) then
    return v_marked || jsonb_build_object('notified', 0);
  end if;

  v_shared := stored.owner_account_id is null or stored.visibility = 'public'
    or exists(select 1 from public.space_credential_shares s where s.credential_id = stored.id);
  for v_recipient in
    -- The owner of a member connection.
    select m.entity_id from public.accounts a
      join public.members m on m.identity_id = a.identity_id and m.space_id = p_space and m.status = 'active'
     where stored.owner_account_id is not null and a.id = stored.owner_account_id
    union
    -- The admins of a Space connection, and of any shared one that may be reused.
    select m.entity_id from public.members m
     where m.space_id = p_space and m.status = 'active' and m.role in ('owner', 'admin')
       and (stored.owner_account_id is null or (v_reason = 'possible_reuse' and v_shared))
  loop
    if internal.notify(p_space, v_recipient, 'mcp.credential.needs_reconnect', p_server, null,
         jsonb_build_object('credentialId', stored.id, 'serverId', p_server, 'reason', v_reason,
           'label', stored.label, 'accountLabel', stored.account_label,
           'scope', case when stored.owner_account_id is null then 'space' else 'member' end)) is not null then
      v_notified := v_notified + 1;
    end if;
  end loop;
  return v_marked || jsonb_build_object('notified', v_notified);
end $$;
revoke all on function public.report_mcp_credential_failure(uuid, uuid, uuid, text) from public;
grant execute on function public.report_mcp_credential_failure(uuid, uuid, uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 2. Revoke all (§9.3(4)).
-- -----------------------------------------------------------------------------
create function public.revoke_all_mcp_credentials(p_space uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  c public.space_credentials;
  v_provider boolean;
  v_items jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  perform internal.require_human_auth_kind();
  if coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'revoking every MCP connection is unavailable to a space link' using errcode = '42501';
  end if;
  if p_space is null then
    perform internal.require_node_admin();
  else
    perform internal.require_space_admin(p_space);
  end if;
  for c in
    select * from public.space_credentials
     where provider = 'mcp' and status <> 'revoked' and (p_space is null or space_id = p_space)
     order by space_id, id
     for update
  loop
    -- B39: a Space admin revokes at the provider only what the Space owns.
    v_provider := (p_space is null or c.owner_account_id is null) and c.secret_ciphertext is not null;
    if v_provider then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'credentialId', c.id, 'spaceId', c.space_id, 'serverId', c.mcp_server_id, 'keyId', c.key_id,
        'ciphertext', encode(c.secret_ciphertext, 'base64'), 'nonce', encode(c.secret_nonce, 'base64')));
    end if;
    update public.space_credentials
       set status = 'revoked', is_default = false, pending_expires_at = null,
           secret_ciphertext = null, secret_nonce = null
     where id = c.id;
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('scope', case when p_space is null then 'node' else 'space' end,
    'revoked', v_count, 'providerRevoke', v_items);
end $$;
revoke all on function public.revoke_all_mcp_credentials(uuid) from public;
grant execute on function public.revoke_all_mcp_credentials(uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. The pending sign-in sweep.
-- -----------------------------------------------------------------------------
create function public.sweep_mcp_oauth_pending()
returns bigint language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare removed bigint;
begin
  perform internal.require_node_admin();
  delete from internal.mcp_oauth_pending where expires_at <= now();
  get diagnostics removed = row_count;
  return removed;
end $$;
revoke all on function public.sweep_mcp_oauth_pending() from public;
grant execute on function public.sweep_mcp_oauth_pending() to tm8_app;

reset role;
