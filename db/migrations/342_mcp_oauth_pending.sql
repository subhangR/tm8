-- =============================================================================
-- 342: pending MCP OAuth sign-ins live in Postgres. Plan §5.4, gap G1, §9.3(1).
--
-- Until now `McpOAuth` kept every begun-but-unfinished sign-in in a process
-- Map, so a restart between "Connect" and the provider's redirect failed with
-- "OAuth state invalid or expired", and two server instances could never share
-- a connect. This table is that Map, made durable, with the same rules:
--
-- * ONLY THE HASH OF `state` IS STORED (sha256, 32 bytes). `state` is the
--   bearer that finishes a sign-in; a DB dump must not be able to replay one.
-- * THE SECRETS ARE SEALED by the server with the KeyProvider (§9.4) before they
--   reach the database: the PKCE verifier, the OAuth client (including any
--   secret a DCR provider issued) and everything the code exchange trusts
--   (authorization-server metadata — the token endpoint is in it — resource,
--   redirect URI, private-network flag). One AES-GCM envelope, not the plan's
--   separate verifier/client columns: under one key every ciphertext needs its
--   own nonce anyway, and putting the token endpoint inside the envelope means
--   a writer of this table cannot point the code exchange somewhere else. The
--   AAD (server-side, `mcp-oauth|<key_id>|<state_hash>|<identity>|<space>|
--   <server>|<scope>|<definition_version>|<return_to>`) binds the envelope to its
--   row, so a rewritten definition_version cannot slip past the "connector
--   changed" guard and a rewritten return_to cannot redirect the user.
-- * SINGLE USE: take_mcp_oauth_pending consumes with DELETE … RETURNING, so a
--   state is spent even when the provider then fails, and two concurrent
--   callbacks cannot both get it. A callback by a DIFFERENT identity deletes
--   nothing (today's rule: someone else's state is not burned by a stranger).
-- * TTL 10 minutes and a node-wide cap of 1,000 live sign-ins, as before, plus
--   20 per identity so one member cannot exhaust the node's. The sweep runs
--   inside every begin, under one advisory lock, so the caps count only live
--   rows and stay exact across instances.
-- * scope_kind is the "Just me / Shared with this Space" choice made at begin
--   (§10.2). It must survive the redirect, which is why §11's `scope` lands with
--   this table. A Space scope needs a Space admin HERE, before the user is sent
--   to a consent screen, and create_mcp_credential checks it again at callback.
-- * return_to is where a same-tab (popup-blocked) sign-in lands afterwards. The
--   contract admits only a same-origin path; the CHECK repeats the essentials.
-- =============================================================================
set role tm8_graph_owner;

create table internal.mcp_oauth_pending (
  state_hash bytea primary key check (octet_length(state_hash) = 32),
  identity_id text not null,
  space_id uuid not null references public.spaces(id) on delete cascade,
  server_id uuid not null references public.entities(id) on delete cascade,
  definition_version integer,
  scope_kind text not null check (scope_kind in ('member', 'space')),
  key_id text not null check (key_id in ('local:v1')),
  secret_ciphertext bytea not null,
  secret_nonce bytea not null check (octet_length(secret_nonce) = 12),
  label text not null check (char_length(label) between 1 and 120),
  return_to text check (return_to is null or (char_length(return_to) <= 2048
    and left(return_to, 1) = '/' and left(return_to, 2) <> '//' and position('\' in return_to) = 0
    -- Browsers strip tab/CR/LF from URLs, so '/\t/evil' would become '//evil'.
    and return_to !~ E'[\\x01-\\x1f\\x7f]')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index mcp_oauth_pending_expires_at on internal.mcp_oauth_pending (expires_at);
revoke all on internal.mcp_oauth_pending from public, tm8_app;

-- Called by mcp.oauth.begin after discovery and client registration, just
-- before the user is redirected. Returns the stored expiry (database clock).
create function public.create_mcp_oauth_pending(p_state_hash bytea, p_space uuid, p_server uuid,
  p_definition_version integer, p_scope text, p_key_id text, p_ciphertext bytea, p_nonce bytea,
  p_label text, p_return_to text default null, p_expires_at timestamptz default null)
returns timestamptz language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_expires timestamptz;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space);
  if coalesce(p_scope, '') not in ('member', 'space') then
    raise exception 'MCP credential scope is member or space' using errcode = '22023';
  end if;
  -- §5.2: only an admin may create a Space connection. Refuse before consent.
  if p_scope = 'space' then perform internal.require_space_admin(p_space); end if;
  if not exists (select 1 from public.entities e join public.mcp_servers s on s.entity_id = e.id
                 where e.id = p_server and e.space_id = p_space and e.kind = 'mcp_server' and e.deleted_at is null) then
    raise exception 'MCP server not found' using errcode = 'P0002';
  end if;
  -- One node-wide lock: the sweep and the cap below must see one consistent set.
  perform pg_advisory_xact_lock(hashtextextended('mcp_oauth_pending', 342));
  delete from internal.mcp_oauth_pending where expires_at <= now();
  if (select count(*) from internal.mcp_oauth_pending) >= 1000 then
    raise exception 'Too many pending MCP connections' using errcode = '53400';
  end if;
  -- Per identity too, so one member scripting begins cannot use up the node's
  -- 1,000 and block every other connect for ten minutes.
  if (select count(*) from internal.mcp_oauth_pending where identity_id = internal.identity_id()) >= 20 then
    raise exception 'Too many pending MCP connections' using errcode = '53400';
  end if;
  v_expires := least(coalesce(p_expires_at, now() + interval '10 minutes'), now() + interval '10 minutes');
  insert into internal.mcp_oauth_pending (state_hash, identity_id, space_id, server_id, definition_version,
    scope_kind, key_id, secret_ciphertext, secret_nonce, label, return_to, expires_at)
  values (p_state_hash, internal.identity_id(), p_space, p_server, p_definition_version,
    p_scope, p_key_id, p_ciphertext, p_nonce, p_label, p_return_to, v_expires);
  return v_expires;
end $$;

-- Called by mcp.oauth.callback. Consumes the caller's own pending row and hands
-- back what the server needs to open the envelope; null when there is none, it
-- is another identity's, or it has expired (an expired row is consumed too).
create function public.take_mcp_oauth_pending(p_state_hash bytea)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare r internal.mcp_oauth_pending;
begin
  perform internal.require_human_auth_kind();
  delete from internal.mcp_oauth_pending
   where state_hash = p_state_hash and identity_id = internal.identity_id()
  returning * into r;
  -- Spent either way: a sign-in whose member has since left its Space ends here.
  if r.state_hash is null or r.expires_at <= now() or not internal.is_space_member(r.space_id) then
    return null;
  end if;
  return jsonb_build_object('identityId', r.identity_id, 'spaceId', r.space_id, 'serverId', r.server_id,
    'definitionVersion', r.definition_version, 'scope', r.scope_kind, 'keyId', r.key_id,
    'ciphertext', encode(r.secret_ciphertext, 'base64'), 'nonce', encode(r.secret_nonce, 'base64'),
    'label', r.label, 'returnTo', r.return_to, 'expiresAt', r.expires_at);
end $$;

revoke all on function public.create_mcp_oauth_pending(bytea,uuid,uuid,integer,text,text,bytea,bytea,text,text,timestamptz) from public;
revoke all on function public.take_mcp_oauth_pending(bytea) from public;
grant execute on function public.create_mcp_oauth_pending(bytea,uuid,uuid,integer,text,text,bytea,bytea,text,text,timestamptz) to tm8_app;
grant execute on function public.take_mcp_oauth_pending(bytea) to tm8_app;

reset role;
