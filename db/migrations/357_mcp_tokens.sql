-- =============================================================================
-- 357: member-owned MCP tokens and the external-token audit. Plan §5.5/§5.6/§7.1,
-- decision D9, gaps G9/G14, open questions Q4/Q5.
--
-- D9: ONE kind of token, minted on the node BY A MEMBER, acting as that member,
-- with an OPTIONAL Space list (null = every Space I belong to now or join
-- later). It exists so Claude Desktop, Cursor or another MCP client can reach
-- the connectors tm8 holds for that member, over the new `/mcp` endpoint, and
-- NOWHERE ELSE (§5.5: "Accepted only on the new /mcp endpoint. It is refused on
-- the REST facade and the CLI API" — identity/mcp-token.ts is that refusal).
--
-- WHY A TABLE OF ITS OWN AND NOT A NEW `auth_sessions.kind`.
-- An auth session is minted for one Space or for none: 226's
-- `auth_sessions_pinned_kinds_have_space` and every helper that intersects with
-- `tm8.session_space_id` are built on that. An MCP token is node-level and
-- carries a Space ARRAY, so it does not fit the column — and a new kind in that
-- table would silently inherit every door written as `kind <> 'link'`. Keeping
-- it here means the only thing that ever resolves one is the `/mcp` route.
--
-- WHY `internal`, WITH NO RLS AND NO GRANT TO tm8_app.
-- Same reason as `internal.mcp_oauth_pending` (342) and
-- `internal.mcp_session_bindings` (343): the rows are a credential store. There
-- is no read path but the five security-definer functions below, so there is no
-- policy to get wrong. `token_hash` is never returned by any of them.
--
-- Designed and signed off as decision B63 (backend advisor, 2026-10-21).
--
-- `resolve_mcp_token` IS A THIRD CLAIM-FREE READ, and it is the same bootstrap
-- hole as `resolve_auth_session` and `resolve_account_credential` (007:105-124):
-- a caller presenting a bearer has no identity until it is verified. It takes a
-- token HASH, never a token, and returns only what the server needs to build
-- claims. Nothing else here is claim-free.
--
-- THE NARROWING IS PER CALL, NOT PER TOKEN (§5.5). Every `/mcp` call names a
-- `spaceId`; `mcp_token_space_member` answers only when the token is live, owned
-- by the identity in force, that Space is in `space_ids` (or the list is null),
-- AND the identity still has an ACTIVE member row there. The server then binds
-- `tm8.session_space_id` to that Space for the rest of the call, so 227's pin —
-- not a tool-list bug — is what keeps the boundary. A listed Space the member is
-- no longer in gives nothing, and a membership removed between two calls stops
-- the second one.
--
-- `connector_ids` and `read_only` ship as COLUMNS ONLY (§5.5: "optional, later
-- in the UI"). `create_mcp_token` always writes null/false, so nothing reads a
-- half-built allow-list as if it were enforced.
--
-- AUDIT (§5.6, carry-over from #1321). `mcp_call_audit.via` is widened with
-- `'external_token'`, `mcp_token_id` is added and `session_id` becomes nullable,
-- because an external call has no session. 346's writer is UNTOUCHED — it admits
-- only an agent bearer whose auth session IS the audited session — and external
-- calls go through the sibling `record_mcp_token_call_audit`.
-- §5.6's other new value, `'test'`, belongs to 353 (#1327), which lands first and
-- writes it; this migration restates the widened CHECKs so both values and both
-- null-session shapes survive, whichever order the two apply in.
-- =============================================================================
set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The tokens.
-- -----------------------------------------------------------------------------
create table internal.mcp_tokens (
  id uuid primary key default internal.new_id(),
  identity_id text not null references public.user_profiles(identity_id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80 and label !~ '[[:cntrl:]]'),
  -- sha256 hex of the token secret, exactly as `auth_sessions.token_hash`. The
  -- plaintext is returned once by the create handler and never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- null = every Space this member belongs to now or joins later (§5.5).
  space_ids uuid[] check (space_ids is null or (array_length(space_ids, 1) between 1 and 32
    and array_position(space_ids, null) is null)),
  -- §5.5 "optional, later in the UI": `create_mcp_token` always writes null and
  -- false, and the `/mcp` endpoint HONOURS both if a row ever carries them, so
  -- the day something starts setting one it is already enforced.
  connector_ids uuid[] check (connector_ids is null or (array_length(connector_ids, 1) between 1 and 32
    and array_position(connector_ids, null) is null)),
  -- RESERVED by §5.5 and enforced by nothing, so it may not hold the value that
  -- would matter. The CHECK is the point: whoever implements read-only has to
  -- remove it, and therefore has to read this. (`connector_ids`, by contrast, IS
  -- enforced — `mcp_token_space_member` applies it on every call.)
  read_only boolean not null default false check (read_only = false),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  last_used_ip text check (last_used_ip is null or char_length(last_used_ip) <= 45),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
-- §10.7: "Label (required, unique among my tokens)". Among my LIVE ones, so a
-- revoked token never blocks reusing its label.
create unique index mcp_tokens_live_label on internal.mcp_tokens (identity_id, lower(label))
  where revoked_at is null;
create index mcp_tokens_identity on internal.mcp_tokens (identity_id, created_at desc);
revoke all on internal.mcp_tokens from public, tm8_app;

-- -----------------------------------------------------------------------------
-- 2. Mint. Human session only: a token that acts as a member is minted by that
-- member at a keyboard, never by their agent carrying their identity.
-- -----------------------------------------------------------------------------
create function public.create_mcp_token(p_label text, p_space_ids uuid[], p_token_hash text,
  p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_identity text; v_expires timestamptz; v_space uuid; v_id uuid;
begin
  perform internal.require_human_auth_kind();
  if coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'MCP tokens are unavailable to a space link' using errcode = '42501';
  end if;
  v_identity := internal.identity_id();
  if v_identity is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if coalesce(btrim(p_label), '') = '' then
    raise exception 'An MCP token needs a label' using errcode = '22023';
  end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'MCP token hash is malformed' using errcode = '22023';
  end if;
  -- §10.7: 30/90/365 days or custom, and NO "never" (B63.1) — `expires_at` is
  -- not null and 365 days is the ceiling. The floor stops a token that is dead
  -- before it has been copied out of the one response that shows it.
  v_expires := coalesce(p_expires_at, now() + interval '90 days');
  if v_expires <= now() + interval '1 minute' or v_expires > now() + interval '365 days' then
    raise exception 'An MCP token expires between a minute and 365 days from now' using errcode = '22023';
  end if;
  -- A SPACE-PINNED session (233's `auth.space.enter`) must name the Spaces: a
  -- pin only ever narrows, and "all my Spaces" from inside one Space would hand
  -- back a credential wider than the session that asked for it.
  if p_space_ids is null and internal.session_space_id() is not null then
    raise exception 'A space-pinned session must name the spaces an MCP token may use' using errcode = '42501';
  end if;
  if p_space_ids is not null then
    if array_length(p_space_ids, 1) is null or array_length(p_space_ids, 1) > 32 then
      raise exception 'An MCP token lists between one and 32 spaces, or none for all of them' using errcode = '22023';
    end if;
    -- Every listed Space must be one the minter is in NOW. Later losses are not
    -- an error — the list is re-intersected with live membership on every call.
    foreach v_space in array p_space_ids loop
      if not internal.is_space_member(v_space) then
        raise exception 'An MCP token cannot list a space you are not a member of' using errcode = '42501';
      end if;
    end loop;
  end if;
  -- One lock per MINTER, so the cap below counts a consistent set while two
  -- `create` calls race. The single-argument form: the two-argument overload is
  -- (int, int), and `hashtextextended` returns bigint (342 takes the same shape).
  perform pg_advisory_xact_lock(hashtextextended('mcp_tokens:' || v_identity, 357));
  if (select count(*) from internal.mcp_tokens
       where identity_id = v_identity and revoked_at is null and expires_at > now()) >= 20 then
    raise exception 'Too many live MCP tokens; revoke one first' using errcode = '53400';
  end if;
  insert into internal.mcp_tokens (identity_id, label, token_hash, space_ids, expires_at)
  values (v_identity, btrim(p_label), p_token_hash,
    case when p_space_ids is null then null else (select array_agg(distinct s) from unnest(p_space_ids) s) end,
    v_expires)
  returning id into v_id;
  return (select row_json from internal.mcp_token_rows(v_identity) where token_id = v_id);
exception when unique_violation then
  raise exception 'You already have an MCP token with that label' using errcode = '23505';
end $$;

-- -----------------------------------------------------------------------------
-- 3. List and revoke. One projection, shared by all three, so no caller can
-- accidentally return `token_hash`.
--
-- `missingSpaceIds` is §10.7's "Some listed Spaces you're no longer in" info
-- row, computed here because only the database knows the current memberships.
-- -----------------------------------------------------------------------------
create function internal.mcp_token_rows(p_identity text)
returns table (token_id uuid, created_at timestamptz, row_json jsonb)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select t.id, t.created_at, jsonb_build_object(
    'id', t.id, 'label', t.label,
    'spaceIds', case when t.space_ids is null then null else to_jsonb(t.space_ids) end,
    'missingSpaceIds', coalesce((select jsonb_agg(s) from unnest(coalesce(t.space_ids, '{}'::uuid[])) s
      where not exists (select 1 from public.members m
        where m.space_id = s and m.identity_id = t.identity_id and m.status = 'active')), '[]'::jsonb),
    'readOnly', t.read_only,
    'connectorIds', case when t.connector_ids is null then null else to_jsonb(t.connector_ids) end,
    'expiresAt', t.expires_at, 'lastUsedAt', t.last_used_at, 'lastUsedIp', t.last_used_ip,
    'createdAt', t.created_at, 'revokedAt', t.revoked_at)
    from internal.mcp_tokens t
   where t.identity_id = p_identity
$$;

create function public.list_mcp_tokens()
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v_identity text;
begin
  perform internal.require_human_auth_kind();
  if coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'MCP tokens are unavailable to a space link' using errcode = '42501';
  end if;
  v_identity := internal.identity_id();
  if v_identity is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  -- §10.7: a revoked row shows as "Revoked" and drops off the list after a day.
  return (select coalesce(jsonb_agg(row_json order by created_at desc), '[]'::jsonb)
    from internal.mcp_token_rows(v_identity) r
    join internal.mcp_tokens t on t.id = r.token_id
   where t.revoked_at is null or t.revoked_at > now() - interval '1 day');
end $$;

create function public.revoke_mcp_token(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_identity text;
begin
  perform internal.require_human_auth_kind();
  if coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'MCP tokens are unavailable to a space link' using errcode = '42501';
  end if;
  v_identity := internal.identity_id();
  if v_identity is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  -- §5.5: "Space admins can't revoke a member's token. Their lever is the
  -- membership." Node admin does not widen this either: the owner clause is the
  -- whole rule, and there is no admin branch to be read as one.
  update internal.mcp_tokens set revoked_at = coalesce(revoked_at, now())
   where id = p_id and identity_id = v_identity;
  if not found then
    raise exception 'MCP token not found' using errcode = 'P0002';
  end if;
  return (select row_json from internal.mcp_token_rows(v_identity) where token_id = p_id);
end $$;

-- -----------------------------------------------------------------------------
-- 4. Verification. THE CLAIM-FREE READ (see the header) and its stamp.
-- -----------------------------------------------------------------------------
/*
 * B63.3. FOUR FIELDS, and nothing else: the claim-free read returns exactly what
 * the server needs to build claims. No account id, no label — a bootstrap hole
 * that answers questions nobody asked is a bootstrap hole somebody will use.
 *
 * It also STAMPS the use, which is why it is volatile plpgsql and not the `sql
 * stable` one-liner it looks like. `last_used_at` / `last_used_ip` are §10.7's
 * "Last used" column and its "Unused for 60 days" hint, and resolution is the
 * one place every call passes through.
 *
 * THE STAMP IS RATE-LIMITED TO ONE A MINUTE PER TOKEN, and that is not a
 * micro-optimisation — it is the lesson `AUTH_TOUCH_INTERVAL_MS` was written
 * from (identity/pg-auth.ts:236-246): stamping every request made auth the one
 * WRITE on the read path, so requests queued behind a row lock on their own
 * session row and `touch_auth_session` became three quarters of all row updates
 * on the node. A tool-calling client is exactly that shape of traffic.
 *
 * ONE INDISTINGUISHABLE ANSWER for a bad hash, a revoked token, an expired one
 * and a disabled account: null. The caller learns "not a credential", never
 * which of the four it is.
 */
create function public.resolve_mcp_token(p_token_hash text, p_ip text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare t internal.mcp_tokens;
begin
  select tok.* into t from internal.mcp_tokens tok
    join public.accounts a on a.identity_id = tok.identity_id and a.status = 'active'
   where tok.token_hash = p_token_hash
     and tok.revoked_at is null
     and tok.expires_at > now();
  if t.id is null then return null; end if;
  if t.last_used_at is null or t.last_used_at < now() - interval '1 minute' then
    update internal.mcp_tokens set last_used_at = now(),
      last_used_ip = left(nullif(btrim(coalesce(p_ip, '')), ''), 45)
     where id = t.id;
  end if;
  return jsonb_build_object('tokenId', t.id, 'identityId', t.identity_id,
    'spaceIds', case when t.space_ids is null then null else to_jsonb(t.space_ids) end,
    'expiresAt', t.expires_at);
end $$;

-- -----------------------------------------------------------------------------
-- 5. THE NARROWING (§5.5, §6.6). The member this token acts as IN ONE SPACE, or
-- null. Everything the `/mcp` route does afterwards runs pinned to that Space.
--
-- All four conditions are re-read here on EVERY call, which is the point: a
-- revoke, an expiry, a removed membership or a Space dropped from the list stops
-- the next call without anything having to invalidate a cache.
-- -----------------------------------------------------------------------------
create function internal.mcp_token_admitted(p_token uuid)
returns table (space_id uuid, member_id uuid)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select m.space_id, m.entity_id
    from internal.mcp_tokens t
    -- B63.3: the ACCOUNT must still be active here too, not only at resolution.
    -- A disabled account's live tokens die on the next call, not at expiry (R6).
    join public.accounts a on a.identity_id = t.identity_id and a.status = 'active'
    join public.members m on m.identity_id = t.identity_id and m.status = 'active'
   where t.id = p_token
     -- The token is this caller's. The claim came off the token hash, so the
     -- identity is a server fact; a stranger holding an id matches nothing.
     and t.identity_id = internal.identity_id()
     and t.revoked_at is null
     and t.expires_at > now()
     and (t.space_ids is null or m.space_id = any(t.space_ids))
   order by m.space_id
$$;

-- The gate both public shapes run first. The claim is server-resolved from the
-- token hash, so this is "the caller really is an MCP token", not a hint; it
-- fails closed on anything else, the empty claim included.
create function internal.require_mcp_token_kind() returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') <> 'mcp'
     or coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'MCP token access is unavailable' using errcode = '42501';
  end if;
end $$;

/*
 * The member this token acts as IN ONE SPACE — what every call resolves first.
 *
 * `p_server`, when given, also applies §5.5's per-token connector allow-list.
 * It is applied HERE rather than in the endpoint because this function runs on
 * every `authorize`, which is every re-check inside a call: a connector dropped
 * from the list then stops a call already in flight, and no TypeScript field
 * has to be remembered for the rule to hold.
 */
create function public.mcp_token_space_member(p_token uuid, p_space uuid, p_server uuid default null)
returns uuid language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v_member uuid;
begin
  perform internal.require_mcp_token_kind();
  if p_server is not null and not exists (select 1 from internal.mcp_tokens t
      where t.id = p_token and (t.connector_ids is null or p_server = any(t.connector_ids))) then
    return null;
  end if;
  select member_id into v_member from internal.mcp_token_admitted(p_token) where space_id = p_space;
  return v_member;
end $$;

/*
 * EVERY Space this token may act in right now, for `tools/list` (§7.1). The
 * same four conditions as above, through the same helper, so the list a caller
 * is shown and the Space a call is allowed in can never disagree.
 */
create function public.mcp_token_spaces(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_mcp_token_kind();
  return (select coalesce(jsonb_agg(jsonb_build_object('spaceId', space_id, 'memberId', member_id)
    order by space_id), '[]'::jsonb) from internal.mcp_token_admitted(p_token));
end $$;

-- -----------------------------------------------------------------------------
-- 6. The audit, widened for callers that have no session.
-- -----------------------------------------------------------------------------
alter table public.mcp_call_audit
  -- B63.5: `on delete restrict`. A token is never hard-deleted (revoke writes
  -- `revoked_at`), so the constraint costs nothing and makes that irreversible:
  -- an audit row can never be orphaned by someone tidying up the tokens table.
  add column mcp_token_id uuid references internal.mcp_tokens(id) on delete restrict,
  -- Already nullable once 353 has run; `drop not null` is idempotent, so this
  -- line is correct in either order.
  alter column session_id drop not null;

/*
 * ONE REPLACEMENT OF BOTH CHECKS, carrying BOTH RULES (lead ruling, 2026-10-21).
 *
 * 353 (#1327) widens the same two constraints for connector TEST calls: `via`
 * gains 'test', and `session_id` may be null exactly when `via = 'test'`. That
 * second rule would REFUSE every external-token row, which is null-session too.
 * So this does not add a third constraint beside it — it restates the whole rule
 * for all four shapes, so neither migration can silently drop the other's half.
 *
 * `if exists` because 353 and this one may land in either order: both names are
 * 353's and 346's, and what matters is that the rule BELOW is what ends up on
 * the table. Nothing is dropped that is not immediately re-stated.
 *
 * `coalesce(via, 'session')` and not `via in (...)`: a CHECK admits NULL, so a
 * pre-346 row (via null, session named) would otherwise pass by accident rather
 * than by rule. Written out so all four shapes are decided, none inferred.
 */
alter table public.mcp_call_audit drop constraint if exists mcp_call_audit_via_check;
alter table public.mcp_call_audit drop constraint if exists mcp_call_audit_session_unless_test;
alter table public.mcp_call_audit drop constraint if exists mcp_call_audit_session_or_token;
alter table public.mcp_call_audit add constraint mcp_call_audit_via_check
  check (via is null or via in ('session', 'chat', 'test', 'external_token'));
-- A session or chat call names its session; a test and an external-token call
-- have none. (353's `mcp_call_audit_session_unless_test`, widened by one value.)
alter table public.mcp_call_audit add constraint mcp_call_audit_session_unless_test
  check ((session_id is null) = (coalesce(via, 'session') in ('test', 'external_token')));
-- And the token is named by exactly the external-token rows.
alter table public.mcp_call_audit add constraint mcp_call_audit_external_token_shape
  check ((coalesce(via, 'session') = 'external_token') = (mcp_token_id is not null));
create index mcp_call_audit_token on public.mcp_call_audit(mcp_token_id, id desc)
  where mcp_token_id is not null;

-- 346's writer, for a session. This one, for an external token. They share the
-- table and nothing else: each proves its own caller.
--
-- WHAT IS NOT CHECKED HERE, AND WHY: the token need not still be LIVE. A call
-- refused because the token was revoked or the member was removed mid-flight is
-- exactly the denial worth recording, and demanding a live token would lose it.
-- What IS demanded is ownership and the Space list, so a row can only ever land
-- in a Space the token itself names. A call naming a Space OUTSIDE that list
-- records nothing — writing "someone tried" into a Space the caller has no
-- relation to would be a write into a stranger's audit — and the route logs it
-- server-side instead.
create function public.record_mcp_token_call_audit(
  p_token uuid, p_space uuid, p_server uuid, p_credential uuid, p_method text, p_tool text,
  p_outcome text, p_root_member uuid, p_deny_reason text,
  p_latency_ms integer, p_request_bytes integer, p_response_bytes integer)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_identity text; v_scope text; v_root uuid;
begin
  perform internal.require_mcp_token_kind();
  v_identity := internal.identity_id();
  if not exists (select 1 from internal.mcp_tokens t
      where t.id = p_token and t.identity_id = v_identity
        and (t.space_ids is null or p_space = any(t.space_ids))) then
    raise exception 'MCP audit writer unavailable' using errcode = '42501';
  end if;
  -- The connector must be one of THIS Space's, as in 346: a row can never name
  -- another Space's connector.
  if not exists (select 1 from public.entities e
      where e.id = p_server and e.space_id = p_space and e.kind = 'mcp_server') then
    raise exception 'MCP audit connector is not one of this space''s' using errcode = '22023';
  end if;
  if p_credential is not null then
    select case when c.owner_account_id is null then 'space' else 'member' end into v_scope
      from public.space_credentials c
     where c.id = p_credential and c.space_id = p_space and c.provider = 'mcp';
    if v_scope is null then
      raise exception 'MCP audit credential is not one of this space''s MCP connections' using errcode = '22023';
    end if;
  end if;
  -- §6.6: the root IS the token's member. A supplied one must be this identity's
  -- member row in this Space, whatever its status — a removed root is the denial
  -- worth naming — so the row can never be attributed to anyone else.
  if p_root_member is not null then
    if not exists (select 1 from public.members m
        where m.entity_id = p_root_member and m.space_id = p_space and m.identity_id = v_identity) then
      raise exception 'MCP audit root is not the token''s member' using errcode = '22023';
    end if;
    v_root := p_root_member;
  else
    select m.entity_id into v_root from public.members m
     where m.space_id = p_space and m.identity_id = v_identity;
  end if;
  insert into public.mcp_call_audit(space_id, session_id, server_id, credential_id, method, outcome,
    tool, root_member_id, chain, via, chat_id, credential_scope, deny_reason,
    latency_ms, request_bytes, response_bytes, mcp_token_id)
  values (p_space, null, p_server, p_credential, p_method, p_outcome,
    left(nullif(btrim(p_tool), ''), 200), v_root, null, 'external_token', null,
    v_scope, p_deny_reason, p_latency_ms, p_request_bytes, p_response_bytes, p_token);
end $$;

-- -----------------------------------------------------------------------------
-- 7. `mcp.audit.list` reports the token and tolerates a null session. 346's body
-- otherwise unchanged (same signature, so its allow-list line still matches).
-- -----------------------------------------------------------------------------
create or replace function public.list_mcp_call_audit(
  p_space uuid, p_session uuid, p_chat uuid, p_server uuid, p_member uuid, p_outcome text,
  p_before bigint, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v_admin boolean; v_self uuid; v_items jsonb;
begin
  perform internal.require_human_auth_kind();
  if coalesce(internal.claim_text('tm8.via_link'), '') <> '' then
    raise exception 'MCP audit is unavailable to a space link' using errcode = '42501';
  end if;
  perform internal.require_space_member(p_space);
  v_admin := internal.is_space_admin(p_space);
  select m.entity_id into v_self from public.members m
   where m.space_id = p_space and m.identity_id = internal.identity_id() and m.status = 'active'
     and (internal.session_space_id() is null or internal.session_space_id() = p_space);
  select coalesce(jsonb_agg(row_json order by id desc), '[]'::jsonb) into v_items from (
    select a.id, jsonb_build_object(
      'id', a.id::text, 'spaceId', a.space_id, 'sessionId', a.session_id, 'chatId', a.chat_id,
      'serverId', a.server_id, 'credentialId', a.credential_id, 'credentialScope', a.credential_scope,
      'method', a.method, 'tool', a.tool, 'outcome', a.outcome, 'denyReason', a.deny_reason,
      'rootMemberId', a.root_member_id, 'chain', to_jsonb(coalesce(a.chain, '{}'::uuid[])), 'via', a.via,
      'mcpTokenId', a.mcp_token_id,
      'latencyMs', a.latency_ms, 'requestBytes', a.request_bytes, 'responseBytes', a.response_bytes,
      'occurredAt', a.occurred_at) as row_json
      from public.mcp_call_audit a
     where a.space_id = p_space
       and (v_admin or (v_self is not null and a.root_member_id = v_self))
       and (p_session is null or a.session_id = p_session)
       and (p_chat is null or a.chat_id = p_chat)
       and (p_server is null or a.server_id = p_server)
       and (p_member is null or a.root_member_id = p_member)
       and (p_outcome is null or a.outcome = p_outcome)
       and (p_before is null or a.id < p_before)
     order by a.id desc
     limit greatest(1, least(coalesce(p_limit, 50), 201))) page;
  return jsonb_build_object('items', v_items, 'scope', case when v_admin then 'space' else 'own' end);
end
$$;

-- -----------------------------------------------------------------------------
-- 8. Grants. `internal.mcp_token_rows` is granted to NOBODY: its only callers
-- are the definer functions above (079's control 4, as 083 applies it).
-- -----------------------------------------------------------------------------
revoke all on function internal.mcp_token_rows(text) from public;
revoke all on function internal.mcp_token_admitted(uuid) from public;
revoke all on function internal.require_mcp_token_kind() from public;
revoke all on function public.create_mcp_token(text, uuid[], text, timestamptz) from public;
revoke all on function public.list_mcp_tokens() from public;
revoke all on function public.revoke_mcp_token(uuid) from public;
revoke all on function public.resolve_mcp_token(text, text) from public;
revoke all on function public.mcp_token_space_member(uuid, uuid, uuid) from public;
revoke all on function public.mcp_token_spaces(uuid) from public;
revoke all on function public.record_mcp_token_call_audit(uuid, uuid, uuid, uuid, text, text, text, uuid, text, integer, integer, integer) from public;
grant execute on function public.create_mcp_token(text, uuid[], text, timestamptz) to tm8_app;
grant execute on function public.list_mcp_tokens() to tm8_app;
grant execute on function public.revoke_mcp_token(uuid) to tm8_app;
grant execute on function public.resolve_mcp_token(text, text) to tm8_app;
grant execute on function public.mcp_token_space_member(uuid, uuid, uuid) to tm8_app;
grant execute on function public.mcp_token_spaces(uuid) to tm8_app;
grant execute on function public.record_mcp_token_call_audit(uuid, uuid, uuid, uuid, text, text, text, uuid, text, integer, integer, integer) to tm8_app;

analyze internal.mcp_tokens;
analyze public.mcp_call_audit;

reset role;
