-- =============================================================================
-- 143 — invite signup must REFUSE on an unclaimed node (§7.1 turned into a guard).
--
-- THE DEFECT THIS CLOSES (review finding on 141). `signup_via_invite` (141) is
-- claim-free and creates an account WITH a credential. `node_is_claimed` is
-- "any active account has a password_hash" (116 §2.1, deliberately — so nodes
-- already provisioned through PROVISION-SECOND-ACCOUNT.md read as claimed and
-- never mint a claim token). Put those two together and a person who redeems an
-- invite BEFORE the operator has claimed the node flips it to claimed: the owner
-- row still has no credential, and `claim_node` re-asserts unclaimed before it
-- writes (116), so the operator's claim ceremony is now refused forever. The
-- owner row is stranded passwordless — the exact irreversible dead end
-- FIRST-RUN-CLAIM-DESIGN.md §7.1 forbids IN WORDS ("the second human must not
-- use the node before it is claimed … recorded as the first person's,
-- irreversibly") but that nothing enforced.
--
-- THE FIX IS THE ORDERING THE DESIGN ALREADY STATES, not a redefinition of
-- "claimed". Redefining claimed to look only at the owner row was considered and
-- REJECTED: it would make any node provisioned through PROVISION-SECOND-ACCOUNT
-- (accounts in active use, owner row still passwordless) read as UNCLAIMED and
-- start printing a claim URL for a live node — trading a lockout for a takeover.
-- Instead `signup_via_invite` now refuses on an unclaimed node, claim-free, with
-- an actionable message, BEFORE the invite's use_count is touched — same
-- atomicity discipline the username-collision path already had. The whole body
-- is otherwise byte-for-byte 141's; only the guard block is new.
--
-- WHY THIS IS UNIVERSALLY CORRECT (never blocks a legitimate flow). In every
-- supported install the owner CLAIMS FIRST — single-player over loopback, or
-- multiplayer via the token-authorized `auth.claim` (which works in multi mode,
-- §3.2) — and claiming sets the owner credential, so the node is claimed before
-- any invite can be created and redeemed. An unclaimed node with a live invite
-- is only ever the §7.1 mistake.
--
-- WHY `set role tm8_graph_owner` / CREATE OR REPLACE. `create or replace` may
-- only be run by the function's owner, which 141 made `tm8_graph_owner`; the
-- role is re-entered here for the same reason. Privileges survive a replace, but
-- the grant is re-affirmed explicitly, matching 141/118's discipline.
-- =============================================================================

set role tm8_graph_owner;

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

  -- §7.1 GUARD (143). An invite must not be redeemable before the node is
  -- claimed: the first invited signup would otherwise flip node_is_claimed and
  -- permanently close the owner's own claim ceremony. Refuse claim-free, with a
  -- message the operator can act on, BEFORE the invite is locked or consumed —
  -- so a refused attempt burns nothing. `forbidden` (42501), not the raw
  -- constraint error, because this is a node-state refusal the caller can read
  -- (claim status is already public via auth.claim.status).
  --
  -- The claimed test is INLINED rather than delegated to
  -- `internal.node_is_claimed_unsafe()`: that helper revoked EXECUTE from public
  -- (116), and this function runs as its definer `tm8_graph_owner`, which is not
  -- the helper's owner and so cannot call it. `tm8_graph_owner` DOES own
  -- `public.accounts` (this function already writes it), so the same
  -- RLS-bypassing read the helper performs is available directly here. The
  -- predicate is byte-for-byte 116 §2.1: "any account has a password_hash".
  if not exists (select 1 from public.accounts where password_hash is not null) then
    raise exception
      'this node has not been claimed yet; the operator must claim it (tm8 auth claim) before an invite can create an account'
      using errcode = '42501';
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
  'Invite-bound self-signup (141; 143 adds the §7.1 unclaimed-node guard). '
  'Claim-free — the invite is the authorization. REFUSES on an unclaimed node so '
  'an invitee cannot flip node_is_claimed and strand the owner''s claim ceremony. '
  'Creates the account, profile, membership and consumes the invite in one '
  'transaction. Hard-codes is_owner=false and is_node_admin=false: no input can '
  'mint an admin.';

reset role;

-- Grants survive a create-or-replace, but re-affirmed explicitly (008:251-253:
-- a post-008 function inherits no EXECUTE; the discipline is to name the grant).
revoke all on function public.signup_via_invite(text, text, text, text, text, text, text) from public;
grant execute on function public.signup_via_invite(text, text, text, text, text, text, text) to tm8_app;
