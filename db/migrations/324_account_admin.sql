-- =============================================================================
-- 324 — node-admin account administration: admin-created accounts with a
-- one-time setup link, reset, enable, node-admin grant/revoke, and a direct
-- add-account-to-space path (task 01a13574, audit doc 01a13570 §1 gaps 1-7).
--
-- THE SHAPE. An admin creates an account WITHOUT a password and gets back a
-- single-use, expiring SETUP TOKEN (`tm8a_…`). The person opens the link,
-- chooses their own password, and is signed in. The operator never sets or
-- learns the password — the same posture as 141's invite signup, and the same
-- token discipline as 116's claim token:
--   * the plaintext exists only in the create/reset response; the database
--     holds its sha256 (`account_setup_tokens.token_hash`) and nothing else;
--   * single use: the burn is the discriminating UPDATE inside
--     `redeem_account_setup`, under a row lock, so two redemptions serialize;
--   * expiring: `expires_at` is required, and the facade bounds it;
--   * at most ONE live token per account: issuing burns the previous one, so a
--     reset invalidates a link that was already sent.
--
-- WHY NOT `IdentityServiceImpl.resetCredentials`. Its repository targets a
-- schema that never landed (server identity/loopback.ts, pg-store.ts). Every
-- function here is a SECURITY DEFINER RPC over the tables that DID land, the
-- way 007/116/141 are.
--
-- AUTHORIZATION, twice, like auth.signup through ensure_account: the facade
-- refuses non-human sessions and non-node-admin claims; every write below
-- re-checks `require_human_auth_kind` + `require_gate_admin` in SQL (node admin
-- on an account that is active, on a session not pinned to a space).
--
-- THE GUARDS (task ac2):
--   * the node owner cannot be reset, demoted or (232 already) disabled by
--     anyone — the owner rotates their own credential with auth.password.change;
--   * you cannot reset your own account here (same reason);
--   * revoking node admin refuses when it would leave the node with no active
--     node admin or owner.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The token store. RLS on, zero policies, no grants — 116's precedent: the
--    SECURITY DEFINER functions below are the only way in or out.
-- -----------------------------------------------------------------------------
create table if not exists public.account_setup_tokens (
  token_hash           text primary key,
  account_id           uuid not null references public.accounts(id) on delete cascade,
  purpose              text not null check (purpose in ('create', 'reset')),
  created_by_identity  text,
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null,
  used_at              timestamptz,
  -- 'redeemed' or 'superseded' once used_at is set.
  used_how             text check (used_how in ('redeemed', 'superseded'))
);
create index if not exists account_setup_tokens_live_idx
  on public.account_setup_tokens(account_id) where used_at is null;

comment on table public.account_setup_tokens is
  'One-time account setup links (324), sha256 hashes only. Single-use and '
  'expiring; at most one live row per account.';

-- ENABLE, not FORCE: the functions below run as the table's owner
-- (tm8_graph_owner, like 141's), and FORCE would hold the owner to the zero
-- policies too. 116 can FORCE because its functions are owned by the
-- migration role.
alter table public.account_setup_tokens enable row level security;

-- Burn every live token for the account and record a new one. Internal: the
-- callers below have already authorized the act.
create or replace function internal.issue_account_setup_token(
  p_account_id uuid, p_token_hash text, p_expires_at timestamptz, p_purpose text
) returns timestamptz language plpgsql security definer
set search_path = public, internal, pg_temp as $$
begin
  if p_token_hash is null or btrim(p_token_hash) = '' then
    raise exception 'setup token hash is required' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'a setup link must expire in the future' using errcode = '22023';
  end if;
  update public.account_setup_tokens
     set used_at = now(), used_how = 'superseded'
   where account_id = p_account_id and used_at is null;
  insert into public.account_setup_tokens(token_hash, account_id, purpose, created_by_identity, expires_at)
  values (p_token_hash, p_account_id, p_purpose, internal.identity_id(), p_expires_at);
  return p_expires_at;
end
$$;
revoke all on function internal.issue_account_setup_token(uuid, text, timestamptz, text) from public, tm8_app;

-- The node-admin gate every write here passes: a human session, node admin on
-- an active account, not pinned to a space (234's require_gate_admin).
create or replace function internal.require_account_admin() returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_human_auth_kind();
  perform internal.require_gate_admin();
end
$$;
revoke all on function internal.require_account_admin() from public, tm8_app;

-- -----------------------------------------------------------------------------
-- 2. admin_create_account — node.accounts.create.
--
-- A passwordless account (null password_hash cannot log in: pg-auth's login
-- refuses a row with no credential), its profile, optionally a membership in
-- one space with admin|member, and a setup token — one transaction. Does NOT
-- go through ensure_account, which is idempotent by lookup and would hand back
-- an existing account under someone else's username.
-- -----------------------------------------------------------------------------
create or replace function public.admin_create_account(
  p_identity_id text,
  p_username text,
  p_display_name text,
  p_email text,
  p_is_node_admin boolean,
  p_token_hash text,
  p_expires_at timestamptz,
  p_space_id uuid default null,
  p_role text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  handle text := lower(btrim(p_username));
  a public.accounts;
  member_id uuid;
  expires timestamptz;
begin
  perform internal.require_account_admin();
  if handle is null or handle = '' then
    raise exception 'username is required' using errcode = '22023';
  end if;
  if (p_space_id is null) <> (p_role is null) then
    raise exception 'a space and a role go together' using errcode = '22023';
  end if;
  if p_role is not null and p_role not in ('admin', 'member') then
    raise exception 'role must be admin or member' using errcode = '22023';
  end if;
  if p_space_id is not null and not exists (select 1 from public.spaces where id = p_space_id) then
    raise exception 'space not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.accounts where lower(username) = handle) then
    raise exception 'an account with this username already exists' using errcode = '23505';
  end if;

  insert into public.user_profiles(identity_id, display_name, email)
  values (p_identity_id, coalesce(nullif(btrim(p_display_name), ''), handle), p_email)
  on conflict (identity_id) do update
    set display_name = coalesce(excluded.display_name, user_profiles.display_name),
        email        = coalesce(excluded.email, user_profiles.email);

  insert into public.accounts(identity_id, username, display_name, email,
                              is_owner, is_node_admin, password_algorithm, password_hash)
  values (p_identity_id, handle, nullif(btrim(p_display_name), ''), p_email,
          false, coalesce(p_is_node_admin, false), null, null)
  returning * into a;

  if p_space_id is not null then
    member_id := internal.attach_member(p_space_id, p_identity_id, p_role);
  end if;

  expires := internal.issue_account_setup_token(a.id, p_token_hash, p_expires_at, 'create');

  return jsonb_strip_nulls(jsonb_build_object(
    'account',  to_jsonb(a) - 'password_hash',
    'expiresAt', expires,
    'spaceId',  p_space_id,
    'memberId', member_id,
    'role',     p_role));
end
$$;
revoke all on function public.admin_create_account(text, text, text, text, boolean, text, timestamptz, uuid, text) from public;
grant execute on function public.admin_create_account(text, text, text, text, boolean, text, timestamptz, uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. admin_reset_account — node.accounts.reset.
--
-- Clears the credential, revokes every live session, and issues a fresh setup
-- token (burning any earlier link). Clearing rather than keeping the old
-- password is the point of a reset: a reset done because a password leaked
-- must not leave the leaked password working until the link is redeemed.
-- Returns the account's identity so the facade can close its sockets.
-- -----------------------------------------------------------------------------
create or replace function public.admin_reset_account(
  p_account_id uuid, p_token_hash text, p_expires_at timestamptz
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  target public.accounts;
  revoked integer;
  expires timestamptz;
begin
  perform internal.require_account_admin();
  select * into target from public.accounts where id = p_account_id for update;
  if target.id is null then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if target.is_owner then
    raise exception 'the node owner''s credential cannot be reset by an admin' using errcode = '42501';
  end if;
  if target.identity_id = internal.identity_id() then
    raise exception 'reset your own password with auth.password.change' using errcode = '42501';
  end if;

  update public.accounts set password_hash = null, password_algorithm = null where id = p_account_id;
  update public.auth_sessions set revoked_at = now()
   where account_id = p_account_id and revoked_at is null;
  get diagnostics revoked = row_count;
  expires := internal.issue_account_setup_token(p_account_id, p_token_hash, p_expires_at, 'reset');

  return jsonb_build_object(
    'accountId', target.id,
    'username', target.username,
    'expiresAt', expires,
    'revokedSessionCount', revoked,
    'identityId', target.identity_id);
end
$$;
revoke all on function public.admin_reset_account(uuid, text, timestamptz) from public;
grant execute on function public.admin_reset_account(uuid, text, timestamptz) to tm8_app;

-- -----------------------------------------------------------------------------
-- 4. preview_account_setup / redeem_account_setup — auth.setup.resolve/redeem.
--
-- CLAIM-FREE, and the TOKEN is the authorization, exactly as for claim_node and
-- signup_via_invite: the person has no credential until this call.
--
-- An unknown, used, expired, or disabled-account token all answer the SAME way
-- (preview: null; redeem: 28000), so a token's state is not enumerable. The
-- preview names the account — the link holder is the person it was made for,
-- and "set a password for @alice" is what lets them notice a wrong link.
-- -----------------------------------------------------------------------------
create or replace function public.preview_account_setup(p_token_hash text)
returns jsonb language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
           'username', a.username,
           'displayName', a.display_name,
           'purpose', t.purpose,
           'expiresAt', t.expires_at))
    from public.account_setup_tokens t
    join public.accounts a on a.id = t.account_id
   where t.token_hash = p_token_hash
     and t.used_at is null
     and t.expires_at > now()
     and a.status = 'active'
$$;
revoke all on function public.preview_account_setup(text) from public;
grant execute on function public.preview_account_setup(text) to tm8_app;

create or replace function public.redeem_account_setup(
  p_token_hash text, p_password_algorithm text, p_password_hash text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  t public.account_setup_tokens;
  a public.accounts;
begin
  if p_password_hash is null or p_password_algorithm is null then
    raise exception 'a credential is required' using errcode = '22023';
  end if;
  select * into t from public.account_setup_tokens where token_hash = p_token_hash for update;
  if t.token_hash is null or t.used_at is not null or t.expires_at <= now() then
    raise exception 'invalid, used or expired setup link' using errcode = '28000';
  end if;
  select * into a from public.accounts where id = t.account_id for update;
  if a.id is null or a.status <> 'active' then
    raise exception 'invalid, used or expired setup link' using errcode = '28000';
  end if;

  update public.account_setup_tokens set used_at = now(), used_how = 'redeemed'
   where token_hash = p_token_hash and used_at is null;
  update public.accounts set password_hash = p_password_hash, password_algorithm = p_password_algorithm
   where id = a.id
  returning * into a;
  -- Nothing should be live (create made none; reset revoked them), but a
  -- credential set by a link must not inherit sessions from before it.
  update public.auth_sessions set revoked_at = now()
   where account_id = a.id and revoked_at is null;

  return to_jsonb(a) - 'password_hash';
end
$$;
revoke all on function public.redeem_account_setup(text, text, text) from public;
grant execute on function public.redeem_account_setup(text, text, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 5. enable_account — accounts.enable, the inverse of 232's disable_account.
--    Same ledger discipline (replays return the recorded result). Re-enabling
--    revives no session: disable revoked them, and they stay revoked.
-- -----------------------------------------------------------------------------
create or replace function public.enable_account(p_account_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  target public.accounts;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'accounts.enable');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'accountId', p_account_id::text, 'account');
    return replay;
  end if;

  perform internal.require_account_admin();
  select * into target from public.accounts where id = p_account_id for update;
  if target.id is null then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  perform public.set_account_disabled(p_account_id, false);
  select * into target from public.accounts where id = p_account_id;

  result := jsonb_build_object('accountId', target.id, 'status', target.status);
  return internal.ledger_record(p_client_mutation_id, 'accounts.enable', result);
end
$$;
revoke all on function public.enable_account(uuid, text) from public;
grant execute on function public.enable_account(uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 6. set_account_node_admin — node.accounts.nodeAdmin.set.
--    The owner is always a node admin and is never changed here. Revoking the
--    last active node admin (owner included in the count) is refused.
-- -----------------------------------------------------------------------------
create or replace function public.set_account_node_admin(p_account_id uuid, p_is_node_admin boolean)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  target public.accounts;
begin
  perform internal.require_account_admin();
  if p_is_node_admin is null then
    raise exception 'isNodeAdmin is required' using errcode = '22023';
  end if;
  -- Every admin row, locked in a stable order, so two concurrent revokes of the
  -- last two admins serialize and the second sees the first.
  perform 1 from public.accounts where is_node_admin or is_owner order by id for update;
  select * into target from public.accounts where id = p_account_id for update;
  if target.id is null then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if target.is_owner then
    raise exception 'the node owner is always a node admin and cannot be changed' using errcode = '42501';
  end if;
  if not p_is_node_admin and target.is_node_admin and not exists (
    select 1 from public.accounts
     where id <> p_account_id and status = 'active' and (is_node_admin or is_owner)
  ) then
    raise exception 'this is the last node admin; grant another account first' using errcode = '42501';
  end if;

  update public.accounts set is_node_admin = p_is_node_admin where id = p_account_id
  returning * into target;
  return jsonb_build_object(
    'accountId', target.id,
    'isNodeAdmin', target.is_node_admin,
    'identityId', target.identity_id);
end
$$;
revoke all on function public.set_account_node_admin(uuid, boolean) from public;
grant execute on function public.set_account_node_admin(uuid, boolean) to tm8_app;

-- -----------------------------------------------------------------------------
-- 7. admin_add_space_member — node.accounts.memberships.add.
--
-- The missing "put this account in that space" path (audit gap 5). Until now
-- membership only came from the person redeeming an invite themselves. Node
-- admin only; a space admin still uses invites. admin|member, like invites —
-- an owner is made with spaces.members.updateRole by the space's own owner.
-- An existing active membership is returned unchanged (its role is not
-- silently rewritten); a tombstoned one comes back with the given role (232).
-- -----------------------------------------------------------------------------
create or replace function public.admin_add_space_member(p_account_id uuid, p_space_id uuid, p_role text)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  target public.accounts;
  existing public.members;
  member_id uuid;
begin
  perform internal.require_account_admin();
  if p_role is null or p_role not in ('admin', 'member') then
    raise exception 'role must be admin or member' using errcode = '22023';
  end if;
  select * into target from public.accounts where id = p_account_id;
  if target.id is null then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.spaces where id = p_space_id) then
    raise exception 'space not found' using errcode = 'P0002';
  end if;
  select * into existing from public.members
   where space_id = p_space_id and identity_id = target.identity_id and status = 'active';
  if existing.entity_id is not null then
    return jsonb_build_object('accountId', target.id, 'spaceId', p_space_id,
      'memberId', existing.entity_id, 'role', existing.role, 'created', false);
  end if;
  member_id := internal.attach_member(p_space_id, target.identity_id, p_role);
  return jsonb_build_object('accountId', target.id, 'spaceId', p_space_id,
    'memberId', member_id, 'role', p_role, 'created', true);
end
$$;
revoke all on function public.admin_add_space_member(uuid, uuid, text) from public;
grant execute on function public.admin_add_space_member(uuid, uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 8. list_node_accounts — 282's, plus what the admin page needs to offer the
--    right action: isOwner on its own, whether a credential is set, and the
--    expiry of a live setup link. `isNodeAdmin` keeps 282's meaning (admin or
--    owner) for the path-grant picker that already reads it.
-- -----------------------------------------------------------------------------
create or replace function public.list_node_accounts()
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_gate_admin();
  return coalesce((
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'accountId', a.id, 'username', a.username, 'displayName', a.display_name,
             'status', a.status, 'isNodeAdmin', (a.is_node_admin or a.is_owner),
             'isOwner', a.is_owner,
             'hasPassword', a.password_hash is not null,
             'setupExpiresAt', (select max(t.expires_at) from public.account_setup_tokens t
                                 where t.account_id = a.id and t.used_at is null
                                   and t.expires_at > now())))
           order by a.username)
      from public.accounts a
  ), '[]'::jsonb);
end
$$;
revoke all on function public.list_node_accounts() from public;
grant execute on function public.list_node_accounts() to tm8_app;

analyze public.account_setup_tokens;

reset role;
