-- =============================================================================
-- 141 — the three account-lifecycle operations the onboarding design named as
-- deliberately-not-delivered (docs/identity/FIRST-RUN-CLAIM-DESIGN.md §10):
--
--   1. public.revoke_account_sessions_except(account, keep)  — GAP §10.3
--        the SQL behind `auth.password.change`. A password change that leaves
--        every other live session valid is not a change; this revokes them all
--        BUT the one making the change, so the caller is not logged out of the
--        shell or browser they just used. The credential write itself is 007's
--        `set_account_credential` (an account may set its OWN credential without
--        node admin) — this file adds only the session half.
--
--   2. public.signup_via_invite(...)                          — GAP §10.0 (D5)
--        the SQL behind `auth.invite.signup`. The last missing piece of D5:
--        an invited person creates their OWN account by redeeming an invite,
--        and the operator never sets or learns their password. It bypasses
--        `ensure_account`'s F1 node-admin gate ON PURPOSE — the INVITE is the
--        authorization — and it hard-codes `is_node_admin = false` and
--        `is_owner = false` with no input that can reach them (§7.3). The
--        account, the profile, the membership and the invite consumption all
--        happen in ONE transaction: a half-state (account created, membership
--        failed) is the exact "can log in and see nothing" failure
--        PROVISION-SECOND-ACCOUNT.md opens by warning about.
--
-- WHY `set role tm8_graph_owner`. Every table these functions write —
-- `accounts`, `auth_sessions`, `entities`, `members`, `user_profiles`,
-- `space_invites` — is owned by `tm8_graph_owner` (002/001). A SECURITY DEFINER
-- runs as its OWNER, so creating these under that role is what lets them write
-- past RLS. This mirrors 118, which added `redeem_invite`/`create_invite` over
-- the same tables the same way.
--
-- WHY GRANTS ARE NAMED EXPLICITLY. 008:251-253 left default privileges
-- untouched, so a function created after 008 inherits no EXECUTE and is
-- unreachable until a migration says otherwise (118:425-439 documents the same
-- trap). Both functions are granted to `tm8_app` at the end.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. revoke_account_sessions_except — the password-change session half.
--
-- Byte-for-byte 007's `revoke_account_sessions` (self-or-node-admin, under the
-- CALLER's claims) except for the `id <> p_keep_session_id` clause. Keeping the
-- current session is what makes `auth.password.change` usable: a caller rotates
-- their credential and stays signed in where they are, while every OTHER live
-- session — a stolen browser pass, an old device — dies immediately.
--
-- p_keep_session_id NULL revokes ALL live sessions, which is the loopback
-- auto-owner case: it carries no session, so there is nothing to spare.
-- -----------------------------------------------------------------------------
create or replace function public.revoke_account_sessions_except(
  p_account_id uuid, p_keep_session_id uuid default null
) returns integer language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  revoked integer;
  owner_identity text;
begin
  perform internal.require_identity();
  select identity_id into owner_identity from public.accounts where id = p_account_id;
  if owner_identity is null then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  -- Self, or a node admin. Revoking a stranger's sessions is node administration.
  if owner_identity is distinct from internal.identity_id() then
    perform internal.require_node_admin();
  end if;
  update public.auth_sessions set revoked_at = now()
   where account_id = p_account_id
     and revoked_at is null
     and (p_keep_session_id is null or id <> p_keep_session_id);
  get diagnostics revoked = row_count;
  return revoked;
end
$$;

comment on function public.revoke_account_sessions_except(uuid, uuid) is
  'Revoke every live session for an account except one (141). Self-or-node-admin, '
  'under the caller''s claims. Backs auth.password.change: rotate the credential '
  'without logging the caller out of the session making the change.';

-- -----------------------------------------------------------------------------
-- 2. signup_via_invite — invite-bound self-signup (D5).
--
-- CLAIM-FREE, and the INVITE is the authorization. There is no bound identity:
-- the caller has no account until this function makes one, which is exactly why
-- `ensure_account`'s F1 node-admin gate had to be bypassed — F1 is claim-free
-- only while the node has zero accounts, and by the time a space has an invite
-- the node is long past that. The gate is replaced, not removed: the invite
-- must validate (present, not revoked, not expired, not exhausted) before a row
-- is written.
--
-- IT CANNOT ESCALATE. `is_owner` and `is_node_admin` are the literals `false`.
-- No parameter reaches them, so no forwarded link — a bearer capability worth
-- exactly what the channel it travelled over is worth — can mint an admin. The
-- role the new member joins AS is the INVITE's role, which 118 already constrains
-- to admin|member (never owner) at the column check.
--
-- ONE TRANSACTION, OR NONE OF IT. The invite is locked FOR UPDATE first, so two
-- concurrent redemptions of a max-uses=1 invite serialize; the account, profile,
-- membership and the use_count bump all commit together. A failure at any step
-- rolls the whole thing back — there is no state in which an account exists but
-- its membership does not.
-- -----------------------------------------------------------------------------
create or replace function public.signup_via_invite(
  p_code text,
  p_identity_id text,
  p_username text,
  p_display_name text,
  p_email text,
  p_password_algorithm text,
  p_password_hash text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  invite public.space_invites;
  handle text := lower(btrim(p_username));
  a public.accounts;
  member_id uuid;
begin
  if handle is null or handle = '' then
    raise exception 'username is required' using errcode = '22023';
  end if;
  if p_password_hash is null or p_password_algorithm is null then
    raise exception 'a credential is required to sign up' using errcode = '22023';
  end if;

  -- Lock and validate the invite, exactly as redeem_invite does. The lock is
  -- taken before the exhaustion check so a max-uses invite cannot be redeemed
  -- past its cap by two callers reading the same use_count.
  select * into invite from public.space_invites where code = p_code for update;
  if invite.id is null then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  if invite.revoked_at is not null then
    raise exception 'invite was revoked' using errcode = '42501';
  end if;
  if invite.expires_at is not null and invite.expires_at < now() then
    raise exception 'invite has expired' using errcode = '42501';
  end if;
  if invite.use_count >= invite.max_uses then
    raise exception 'invite is exhausted' using errcode = '53400';
  end if;

  -- The username must be free. A collision on the unique index is a 23505; we
  -- raise it explicitly so the handler can turn it into a clean 'conflict'
  -- rather than a raw constraint name.
  if exists (select 1 from public.accounts where lower(username) = handle) then
    raise exception 'an account with this username already exists' using errcode = '23505';
  end if;

  -- The profile chat and attribution render. Inserted BEFORE attach_member so
  -- the member row it creates picks up this display name rather than a null.
  insert into public.user_profiles(identity_id, display_name, email)
  values (p_identity_id, coalesce(p_display_name, handle), p_email)
  on conflict (identity_id) do update
    set display_name = coalesce(excluded.display_name, user_profiles.display_name),
        email        = coalesce(excluded.email, user_profiles.email);

  -- The account. is_owner/is_node_admin are HARD-CODED false — §7.3.
  insert into public.accounts(identity_id, username, display_name, email,
                              is_owner, is_node_admin, password_algorithm, password_hash)
  values (p_identity_id, handle, p_display_name, p_email,
          false, false, p_password_algorithm, p_password_hash)
  returning * into a;

  -- The membership, with the INVITE's role (118 constrains it to admin|member),
  -- and consume the invite. attach_member is the helper redeem_invite uses.
  member_id := internal.attach_member(invite.space_id, p_identity_id, invite.role);
  update public.space_invites set use_count = use_count + 1 where id = invite.id;
  perform internal.notify(invite.space_id, invite.created_by, 'join', member_id, member_id,
                          jsonb_build_object('inviteId', invite.id, 'role', invite.role));

  return jsonb_build_object(
    'account',  to_jsonb(a) - 'password_hash',
    'spaceId',  invite.space_id,
    'memberId', member_id
  );
end
$$;

comment on function public.signup_via_invite(text, text, text, text, text, text, text) is
  'Invite-bound self-signup (141, design D5). Claim-free — the invite is the '
  'authorization. Creates the account, profile, membership and consumes the '
  'invite in one transaction. Hard-codes is_owner=false and is_node_admin=false: '
  'no input can mint an admin.';

reset role;

-- -----------------------------------------------------------------------------
-- 3. Grants (008:251-253: a post-008 function inherits no EXECUTE).
-- -----------------------------------------------------------------------------
revoke all on function public.revoke_account_sessions_except(uuid, uuid) from public;
revoke all on function public.signup_via_invite(text, text, text, text, text, text, text) from public;

grant execute on function public.revoke_account_sessions_except(uuid, uuid) to tm8_app;
grant execute on function public.signup_via_invite(text, text, text, text, text, text, text) to tm8_app;
