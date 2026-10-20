-- =============================================================================
-- 341: MCP connections — Space scope, status reason, key id, and the account
-- resolver for defaults. Plan §5.2, §3, §7.3; gaps G2, G12, G15.
--
-- WHAT CHANGES, AND THE RULE BEHIND EACH
--
-- 1. SCOPE (G2). `space_credentials.owner_account_id` has been nullable since
--    239, where null means Space-owned, but the MCP path always set an owner, so
--    "shared with Space" was a member-owned row with visibility='public': it
--    died with its creator and only its creator could rotate it.
--    create_mcp_credential now takes p_scope member|space. `space` creates a
--    genuinely Space-owned row (owner null, visibility public) and REQUIRES a
--    space admin (§5.2 "Only Space admins may create, rotate or delete
--    Space-owned ones"). Nothing is converted automatically: today's
--    member-owned public rows stay valid and keep resolving (§5.2, Q14).
--
-- 2. key_id (G12). Which key sealed the row, and part of the AAD, so a key id
--    cannot be swapped on a row to make the server open a ciphertext under a key
--    the owner never consented to. NULL means "sealed before 341, under the
--    node-local key with the legacy unkeyed AAD"; the server chooses its AAD
--    form from this column and never tries one form then the other. Every
--    re-seal below writes key_id in the SAME statement as the ciphertext, so the
--    two can never drift, and a legacy row upgrades the first time it refreshes.
--    The allowlist is one value, 'local:v1' (§9.4: KeyProvider, local only).
--
-- 3. status / status_reason. 'needs_reconnect' is a fourth terminal-ish state:
--    the row is intact but the provider will not honour it (invalid_grant, a
--    reduced scope, a bumped security revision, suspected token reuse).
--    read_mcp_credential already refuses any status <> 'active', so a
--    needs_reconnect row stops being usable the moment it is marked, without a
--    second predicate anywhere.
--
-- 4. account_label / granted_scopes / last_refresh_at. Plain text, never
--    secrets. account_label is the provider's own name for the account
--    ("subhang@gmail.com"), distinct from the free-text label a user types.
--
-- 5. resolve_mcp_account (G15, §3, §7.3). Today resolution "never infers an
--    account", so a connector switched on by default has no credentialId, reads
--    as credential_required, and FAILS the whole launch. This RPC implements
--    §3's order below the pin: the root member's own connection, then the
--    Space's shared one. The pin itself stays in the caller, which is the only
--    place that knows whether the user chose the account.
--
--    SECURITY. The root member is a parameter so that t-provenance can supply
--    the provenance root (§6) without this RPC changing, but the root's account
--    must equal the claims in force. bind and authorize already run resolution
--    under the LAUNCHER's claims, and §6 makes the launcher the root, so the
--    guard holds in every path; a mismatch is a bug, and a loud refusal beats
--    resolving one member's personal connection while running as another.
--    Nothing resolves a connection merely SHARED with the root
--    (visibility='selected'): that needs an explicit pin.
-- =============================================================================
set role tm8_graph_owner;

-- --- 1. columns and constraints ---------------------------------------------
alter table public.space_credentials
  add column if not exists key_id text,
  add column if not exists status_reason text,
  add column if not exists account_label text,
  add column if not exists granted_scopes text[],
  add column if not exists last_refresh_at timestamptz;

alter table public.space_credentials
  drop constraint space_credentials_status_check,
  add constraint space_credentials_status_check
    check (status in ('pending', 'active', 'stale', 'revoked', 'needs_reconnect')),
  -- One value today. A new key backend adds its id here and in KeyProvider at
  -- the same time, so an unknown id can never reach the opener.
  add constraint space_credentials_key_id_check
    check (key_id is null or key_id in ('local:v1')),
  add constraint space_credentials_status_reason_check
    check (status_reason is null or status_reason in
      ('invalid_grant', 'security_revision_changed', 'scope_reduced', 'possible_reuse')),
  add constraint space_credentials_account_label_check
    check (account_label is null or char_length(btrim(account_label)) between 1 and 200),
  -- A count cap only: a CHECK admits no subquery and no non-immutable function,
  -- so the per-scope length cap lives in the contract (McpCredentialCreate /
  -- the OAuth callback), which is the only writer.
  add constraint space_credentials_granted_scopes_check
    check (granted_scopes is null or array_length(granted_scopes, 1) <= 64);

-- §5.2: one connection per (connector, owner-or-Space, account_label). Partial
-- on a present label on purpose — account_label arrives with this migration, so
-- no row can already violate it, and two API keys a member deliberately created
-- for one connector (no provider account behind them) stay legal.
create unique index if not exists mcp_credentials_account_unique
  on public.space_credentials
     (mcp_server_id, coalesce(owner_account_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(account_label)))
  where provider = 'mcp' and account_label is not null and status <> 'revoked';

create index if not exists space_credentials_mcp_server_idx
  on public.space_credentials (mcp_server_id, provider) where provider = 'mcp';

-- --- 2. the usability predicate, named once ---------------------------------
-- 297 spelled this out three times (read, list, readiness) and the resolver
-- needs it a fourth; one definition keeps the four from drifting apart.
create or replace function internal.mcp_credential_usable(c public.space_credentials)
returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select c.provider = 'mcp' and c.mcp_server_id is not null and c.status = 'active'
     and c.mcp_definition_fingerprint = internal.mcp_security_fingerprint(c.mcp_server_id)
     and c.mcp_definition_version = (select mcp_security_revision from public.mcp_servers where entity_id = c.mcp_server_id)
     and (c.mcp_expires_at is null or c.mcp_expires_at > now() or c.mcp_refreshable)
$$;

create or replace function internal.mcp_credential_reason(c public.space_credentials)
returns text
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select case
    when c.id is null then 'credential_unavailable'
    when c.status = 'revoked' then 'credential_revoked'
    when c.status = 'needs_reconnect' then 'needs_reconnect'
    when c.status <> 'active' then 'credential_unavailable'
    when c.mcp_definition_fingerprint <> internal.mcp_security_fingerprint(c.mcp_server_id)
      or c.mcp_definition_version <> (select mcp_security_revision from public.mcp_servers where entity_id = c.mcp_server_id)
      then 'credential_definition_changed'
    when c.mcp_expires_at <= now() and not c.mcp_refreshable then 'credential_expired'
    else 'ready' end
$$;

-- --- 3. create: scope, key id, account label, granted scopes ----------------
drop function public.create_mcp_credential(uuid, uuid, uuid, text, bytea, bytea, text, timestamptz, boolean, integer);

create function public.create_mcp_credential(p_id uuid, p_space uuid, p_server uuid,
  p_label text, p_ciphertext bytea, p_nonce bytea, p_shape text default 'api_key',
  p_expires_at timestamptz default null, p_refreshable boolean default false,
  p_expected_revision integer default null, p_scope text default 'member',
  p_key_id text default null, p_account_label text default null,
  p_granted_scopes text[] default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space);
  if coalesce(p_scope, 'member') not in ('member', 'space') then
    raise exception 'MCP credential scope is member or space' using errcode = '22023';
  end if;
  -- §5.2. A Space connection outlives its creator and any admin can rotate it,
  -- so only an admin may put one there in the first place.
  if p_scope = 'space' then perform internal.require_space_admin(p_space); end if;
  -- Serialize consent stamping with definition edits using the same transaction
  -- advisory lock acquired by the definition update trigger.
  perform pg_advisory_xact_lock(hashtextextended(p_server::text, 297));
  if p_server is null or p_expected_revision is null or not exists (select 1 from public.entities e join public.mcp_servers s on s.entity_id = e.id where e.id = p_server and e.space_id = p_space and e.kind = 'mcp_server' and e.deleted_at is null and s.definition->>'approved' = 'true' and coalesce(s.definition->>'enabled', 'true') = 'true' and s.mcp_security_revision = p_expected_revision) then
    raise exception 'MCP server not found' using errcode = 'P0002';
  end if;
  result := case when p_scope = 'space'
    then public.create_space_credential(p_id, p_space, 'mcp', p_shape, p_label, 'mcp', p_ciphertext, p_nonce, null, null, true, false)
    else public.create_space_credential(p_id, p_space, 'mcp', p_shape, p_label, 'mcp', p_ciphertext, p_nonce, null, 'private', false, false)
  end;
  update public.space_credentials
     set mcp_server_id = p_server,
         mcp_definition_fingerprint = internal.mcp_security_fingerprint(p_server),
         mcp_definition_version = (select mcp_security_revision from public.mcp_servers where entity_id = p_server),
         mcp_expires_at = p_expires_at, mcp_refreshable = p_refreshable,
         key_id = p_key_id, account_label = nullif(btrim(p_account_label), ''),
         granted_scopes = p_granted_scopes
   where id = p_id;
  return result || jsonb_build_object('serverId', p_server, 'scope', p_scope,
    'keyId', p_key_id, 'accountLabel', nullif(btrim(p_account_label), ''));
end $$;

-- --- 4. read: hand the key id back so the opener can pick its AAD form ------
-- 297's body plus keyId. Space-owned rows (owner null, visibility public) were
-- already readable here through the visibility branch.
create or replace function public.read_mcp_credential(p_space uuid, p_server uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare c public.space_credentials; a uuid;
begin
  perform internal.require_space_member(p_space);
  if coalesce(internal.claim_text('tm8.via_link'), '') <> '' or coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    raise exception 'linked MCP credentials are unavailable' using errcode = '42501';
  end if;
  a := internal.current_account_id();
  select sc.* into c from public.space_credentials sc join public.mcp_servers ms on ms.entity_id = sc.mcp_server_id
    where sc.id = p_id and sc.space_id = p_space and sc.provider = 'mcp' and sc.mcp_server_id = p_server
    and sc.mcp_definition_fingerprint = internal.mcp_security_fingerprint(p_server) and sc.mcp_definition_version = ms.mcp_security_revision;
  if c.id is null or c.status <> 'active' or a is null or not (
    c.owner_account_id = a or c.visibility = 'public' or internal.space_credential_shared_with(c.id, a)) then
    raise exception 'MCP credential unavailable' using errcode = '42501';
  end if;
  return jsonb_build_object('credentialId', c.id, 'spaceId', c.space_id, 'serverId', c.mcp_server_id,
    'definitionVersion', c.mcp_definition_version, 'keyId', c.key_id,
    'ciphertext', encode(c.secret_ciphertext, 'base64'), 'nonce', encode(c.secret_nonce, 'base64'));
end $$;

-- --- 5. re-seal paths: ciphertext and key id in one statement ---------------
drop function public.refresh_mcp_credential(uuid, uuid, uuid, bytea, bytea, bytea, timestamptz, boolean);

create function public.refresh_mcp_credential(p_space uuid, p_server uuid, p_id uuid,
  p_old_nonce bytea, p_ciphertext bytea, p_nonce bytea, p_expires_at timestamptz default null,
  p_refreshable boolean default false, p_key_id text default null)
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform public.read_mcp_credential(p_space, p_server, p_id);
  update public.space_credentials
     set secret_ciphertext = p_ciphertext, secret_nonce = p_nonce, key_id = p_key_id,
         mcp_expires_at = p_expires_at, mcp_refreshable = p_refreshable,
         last_refresh_at = now(), status_reason = null
   where id = p_id and status = 'active' and secret_nonce = p_old_nonce;
  return found;
end $$;

-- Rotation of an API key. rekey_space_credential cannot carry a key id, and
-- splitting the two writes would let them drift, so MCP gets its own: the same
-- manager rule, plus §5.2's admin-only rule for a Space connection.
create function public.rekey_mcp_credential(p_space uuid, p_server uuid, p_id uuid,
  p_ciphertext bytea, p_nonce bytea, p_key_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  stored := internal.lock_managed_space_credential(p_id);
  if stored.provider <> 'mcp' or stored.space_id <> p_space or stored.mcp_server_id is distinct from p_server then
    raise exception 'MCP credential unavailable' using errcode = '42501';
  end if;
  if stored.owner_account_id is null and not internal.is_space_admin(stored.space_id) then
    raise exception 'only a space admin can rotate a Space connection' using errcode = '42501';
  end if;
  if stored.status not in ('active', 'stale', 'needs_reconnect') then
    raise exception 'space credential is %', stored.status using errcode = '23514';
  end if;
  update public.space_credentials
     set secret_ciphertext = p_ciphertext, secret_nonce = p_nonce, key_id = p_key_id,
         status = 'active', status_reason = null, last_probe_at = now()
   where id = stored.id returning * into stored;
  return internal.space_credential_json(stored) || jsonb_build_object('keyId', stored.key_id);
end $$;

-- §7.2's writer, so the column added above is reachable. t-refresh-hardening
-- owns the caller (invalid_grant detection, the reuse heuristic, the notice).
create function public.set_mcp_credential_status(p_space uuid, p_server uuid, p_id uuid,
  p_status text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  if p_status not in ('active', 'needs_reconnect') then
    raise exception 'MCP status is active or needs_reconnect; revoke uses delete_space_credential' using errcode = '22023';
  end if;
  select * into stored from public.space_credentials
   where id = p_id and space_id = p_space and provider = 'mcp' and mcp_server_id = p_server for update;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'MCP credential unavailable' using errcode = 'P0002';
  end if;
  if stored.status = 'revoked' then
    raise exception 'space credential is revoked' using errcode = '23514';
  end if;
  update public.space_credentials set status = p_status, status_reason = p_reason
   where id = stored.id returning * into stored;
  return jsonb_build_object('credentialId', stored.id, 'status', stored.status, 'statusReason', stored.status_reason);
end $$;

-- §5.2 "Make the proxy write it". Separate from read_mcp_credential because
-- mcp_credential_readiness is STABLE and calls that one.
create function public.touch_mcp_credential(p_space uuid, p_server uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform public.read_mcp_credential(p_space, p_server, p_id);
  update public.space_credentials set last_used_at = now() where id = p_id;
end $$;

-- --- 6. metadata views ------------------------------------------------------
-- 297's body plus scope, status, statusReason, accountLabel, grantedScopes,
-- lastUsedAt, lastRefreshAt; ownerId is now null for a Space connection, and a
-- space admin manages one.
create or replace function public.list_mcp_credentials(p_server uuid, p_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object(
  'id', sc.id, 'serverId', sc.mcp_server_id, 'label', sc.label,
  'authType', case when sc.shape = 'token' then 'oauth2' else 'api_key' end,
  'scope', case when sc.owner_account_id is null then 'space' else 'member' end,
  'visibility', case when sc.visibility = 'public' then 'space' when exists(select 1 from public.space_credential_shares s where s.credential_id = sc.id) then 'selected' else 'private' end,
  'ownerId', sc.owner_account_id, 'sharedMemberIds', coalesce((select jsonb_agg(m.entity_id) from public.space_credential_shares s join public.accounts a on a.id = s.grantee_account_id join public.members m on m.identity_id = a.identity_id and m.space_id = sc.space_id where s.credential_id = sc.id and (sc.owner_account_id = internal.current_account_id() or s.grantee_account_id = internal.current_account_id())), '[]'::jsonb),
  'usable', internal.mcp_credential_usable(sc) and (sc.visibility = 'public' or sc.owner_account_id = internal.current_account_id() or internal.space_credential_shared_with(sc.id, internal.current_account_id())),
  -- §5.2 exactly: the owner of a personal row, a space admin for a Space one.
  -- Deliberately NOT can_manage_space_credential, which also admits the creator
  -- of an owner-null row — rekey_mcp_credential refuses that case.
  'manageable', case when sc.owner_account_id is null then internal.is_space_admin(sc.space_id)
                     else sc.owner_account_id = internal.current_account_id() end,
  'revoked', sc.status = 'revoked',
  'status', sc.status, 'statusReason', sc.status_reason,
  'accountLabel', sc.account_label,
  'grantedScopes', coalesce(to_jsonb(sc.granted_scopes), '[]'::jsonb),
  'lastUsedAt', sc.last_used_at, 'lastRefreshAt', sc.last_refresh_at,
  'reason', case when internal.mcp_credential_reason(sc) <> 'ready' then internal.mcp_credential_reason(sc)
                 when sc.visibility = 'public' or sc.owner_account_id = internal.current_account_id() or internal.space_credential_shared_with(sc.id, internal.current_account_id()) then 'ready'
                 else 'access_denied' end
 ) order by sc.created_at), '[]'::jsonb) into result
 from public.space_credentials sc where sc.provider = 'mcp' and sc.mcp_server_id is not null
 and (p_server is null or sc.mcp_server_id = p_server) and (p_id is null or sc.id = p_id)
 and internal.is_space_member(sc.space_id);
 return result;
end $$;

create or replace function public.mcp_credential_readiness(p_server uuid, p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare c public.space_credentials; v_reason text;
begin
 if p_id is null then return jsonb_build_object('ready', false, 'reason', 'credential_required'); end if;
 select * into c from public.space_credentials where id = p_id and provider = 'mcp' and mcp_server_id = p_server;
 if c.id is null or not internal.is_space_member(c.space_id) then return jsonb_build_object('ready', false, 'reason', 'credential_unavailable'); end if;
 v_reason := internal.mcp_credential_reason(c);
 if v_reason <> 'ready' then return jsonb_build_object('ready', false, 'reason', v_reason); end if;
 begin
  perform public.read_mcp_credential(c.space_id, p_server, p_id);
 exception when others then return jsonb_build_object('ready', false, 'reason', 'credential_unavailable'); end;
 return jsonb_build_object('ready', true, 'reason', 'ready');
end $$;

-- --- 7. the account resolver (§3 below the pin) -----------------------------
-- Answers {credentialId, scope, source} for the best connection the ROOT member
-- can use, or null. `unusable` carries a root-owned row that exists but is not
-- usable, so mcp.resolve can show ⚠ "needs reconnect" even when the Space's
-- shared connection carried the launch (any member's session could use the
-- shared row anyway, so falling through grants nothing new).
create function public.resolve_mcp_account(p_server uuid, p_root_member uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v_space uuid; v_account uuid; v_caller uuid; c public.space_credentials; u public.space_credentials;
begin
  select space_id into v_space from public.mcp_servers where entity_id = p_server;
  if v_space is null then raise exception 'MCP connector is unavailable' using errcode = 'P0002'; end if;
  perform internal.require_space_member(v_space);
  v_caller := internal.current_account_id();
  if p_root_member is null then
    v_account := v_caller;
  else
    select a.id into v_account from public.members m
      join public.accounts a on a.identity_id = m.identity_id and a.status = 'active'
     where m.entity_id = p_root_member and m.space_id = v_space;
    if v_account is null then
      raise exception 'MCP root member is not a member of this space' using errcode = 'P0002';
    end if;
  end if;
  -- See SECURITY in this migration's header. A NAMED root must be the claims in
  -- force; an absent one needs no check, because it IS the claims in force. A
  -- caller with no account at all is not refused — it simply has no tier 1, and
  -- the Space's shared connection never depended on an account.
  if p_root_member is not null and v_account is distinct from v_caller then
    raise exception 'MCP account resolution runs under the root member''s claims' using errcode = '42501';
  end if;

  if v_account is not null then
    -- Tier 1: the root's OWN connection, whatever its visibility.
    select sc.* into c from public.space_credentials sc
     where sc.provider = 'mcp' and sc.mcp_server_id = p_server and sc.space_id = v_space
       and sc.owner_account_id = v_account and internal.mcp_credential_usable(sc)
     order by sc.created_at asc, sc.id asc limit 1;
    if c.id is not null then
      return jsonb_build_object('credentialId', c.id, 'scope', 'member', 'source', 'personal',
        'accountLabel', c.account_label);
    end if;
    -- A root-owned row that is NOT usable is still worth reporting.
    select sc.* into u from public.space_credentials sc
     where sc.provider = 'mcp' and sc.mcp_server_id = p_server and sc.space_id = v_space
       and sc.owner_account_id = v_account and sc.status <> 'revoked'
     order by sc.created_at asc, sc.id asc limit 1;
  end if;

  -- Tier 2: the Space's shared connection. Genuinely Space-owned rows first,
  -- then today's member-owned public rows (§5.2: nothing auto-converts).
  -- visibility='selected' is deliberately absent: a share needs an explicit pin.
  select sc.* into c from public.space_credentials sc
   where sc.provider = 'mcp' and sc.mcp_server_id = p_server and sc.space_id = v_space
     and sc.visibility = 'public' and internal.mcp_credential_usable(sc)
   order by (sc.owner_account_id is not null), sc.created_at asc, sc.id asc limit 1;
  if c.id is not null then
    return jsonb_build_object('credentialId', c.id,
      'scope', case when c.owner_account_id is null then 'space' else 'member' end,
      'source', 'space_shared', 'accountLabel', c.account_label)
      || case when u.id is null then '{}'::jsonb
         else jsonb_build_object('unusable', jsonb_build_object('credentialId', u.id, 'reason', internal.mcp_credential_reason(u))) end;
  end if;
  if u.id is not null then
    return jsonb_build_object('unusable', jsonb_build_object('credentialId', u.id, 'reason', internal.mcp_credential_reason(u)));
  end if;
  return null;
end $$;

-- --- 8. grants --------------------------------------------------------------
revoke all on function internal.mcp_credential_usable(public.space_credentials) from public;
revoke all on function internal.mcp_credential_reason(public.space_credentials) from public;
revoke all on function public.create_mcp_credential(uuid,uuid,uuid,text,bytea,bytea,text,timestamptz,boolean,integer,text,text,text,text[]) from public;
revoke all on function public.read_mcp_credential(uuid,uuid,uuid) from public;
revoke all on function public.refresh_mcp_credential(uuid,uuid,uuid,bytea,bytea,bytea,timestamptz,boolean,text) from public;
revoke all on function public.rekey_mcp_credential(uuid,uuid,uuid,bytea,bytea,text) from public;
revoke all on function public.set_mcp_credential_status(uuid,uuid,uuid,text,text) from public;
revoke all on function public.touch_mcp_credential(uuid,uuid,uuid) from public;
revoke all on function public.resolve_mcp_account(uuid,uuid) from public;
grant execute on function internal.mcp_credential_usable(public.space_credentials) to tm8_app;
grant execute on function internal.mcp_credential_reason(public.space_credentials) to tm8_app;
grant execute on function public.create_mcp_credential(uuid,uuid,uuid,text,bytea,bytea,text,timestamptz,boolean,integer,text,text,text,text[]) to tm8_app;
grant execute on function public.read_mcp_credential(uuid,uuid,uuid) to tm8_app;
grant execute on function public.refresh_mcp_credential(uuid,uuid,uuid,bytea,bytea,bytea,timestamptz,boolean,text) to tm8_app;
grant execute on function public.rekey_mcp_credential(uuid,uuid,uuid,bytea,bytea,text) to tm8_app;
grant execute on function public.set_mcp_credential_status(uuid,uuid,uuid,text,text) to tm8_app;
grant execute on function public.touch_mcp_credential(uuid,uuid,uuid) to tm8_app;
grant execute on function public.resolve_mcp_account(uuid,uuid) to tm8_app;

analyze public.space_credentials;
reset role;
