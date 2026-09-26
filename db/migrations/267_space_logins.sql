-- =============================================================================
-- 267 (set at the merge position after #919's 263; 262 stays a hole; was placeholder 995) — per-space
-- passwords, W5 (plan 01a0d9eb §3 W5, phases 01a0d9fb §2, final design
-- 01a0da94 decision 30 / K2).
--
-- K2 (accepted, decision 30): one identity per person, every session pinned to
-- one space. A separate SPACE PASSWORD is a space setting. It is on for spaces
-- joined through someone else's invite and off for your own spaces on
-- single-user nodes. Isolation is one setting plus one check.
--
-- WHAT LANDS.
--   1. `spaces.require_space_credential boolean not null default false`. Every
--      existing space keeps it off, so nothing changes until an admin turns it
--      on. Only `set_space_require_credential` may change it (trigger guard).
--   2. `public.space_logins(space_id, account_id, verifier, status, ...)`. The
--      verifier is the server's scrypt string (`scrypt$N$r$p$salt$derived`),
--      never a plaintext. tm8_app has NO grant on the table; RLS is on with no
--      policy. Only the SECURITY DEFINER functions below read or write it.
--   3. `enter_space` (249's body EXACTLY, plus the check). The check: when the
--      space requires a password, OR the caller's login for the space is
--      locked, the caller must present the verifier the server just checked the
--      password against, and it must still be the active row's verifier. SQL
--      cannot run scrypt, so as for `auth.login` (pg-auth.ts) the password
--      comparison is TypeScript's; binding the verifier makes a lock or a
--      reset that lands between the read and the mint refuse the mint.
--      A new trailing parameter, default null: a 5-argument call still resolves
--      and is refused whenever a password is required.
--   4. `space_login_for_enter(space)` — the read `auth.space.enter` does first,
--      under the caller's claims, humans and gate sessions only. A non-member
--      reads "not required", and `enter_space` then refuses the membership, so
--      the read is not an oracle.
--   5. `invite_requires_space_password(code)` — claim-free, like
--      `preview_invite`: true only for a live invite into a space that requires
--      a password. The join UI uses it to ask for one.
--   6. `signup_via_invite` (143's body, plus the password) and `redeem_invite`
--      (232's body, plus the password): when the invite's space requires one,
--      the join must set it (the new account's login row is written in the same
--      transaction). An existing login row is never overwritten by an invite.
--   7. Space-admin ops, humans only (P5): `set_space_require_credential`,
--      `reset_space_login`, `set_space_login_locked`. A reset or a lock
--      revokes the member's live sessions pinned to that space and returns
--      their ids so the server closes their sockets.
--
-- ADDITIVE ONLY: one new column with a default, one new table, functions
-- replaced. No existing row is rewritten.
--
-- ROLLBACK: turn the setting off (`update spaces set require_space_credential =
-- false` as the graph owner, or the op) and enter_space is W3's again for every
-- space with no locked login. The table can stay.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The setting.
-- -----------------------------------------------------------------------------
alter table public.spaces
  add column require_space_credential boolean not null default false;

comment on column public.spaces.require_space_credential is
  'K2 (267, W5): when true, auth.space.enter needs the member''s space password '
  'and both invite paths set one. Written only by set_space_require_credential.';

create or replace function internal.guard_space_require_credential()
returns trigger language plpgsql
set search_path = public, internal, pg_temp as $$
begin
  if new.require_space_credential is distinct from old.require_space_credential
     and coalesce(current_setting('tm8.space_password_writer', true), '') <> 'on' then
    raise exception 'require_space_credential is set only by set_space_require_credential'
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function internal.guard_space_require_credential() from public;

create trigger spaces_guard_require_space_credential
before update of require_space_credential on public.spaces
for each row execute function internal.guard_space_require_credential();

-- -----------------------------------------------------------------------------
-- 2. The logins.
-- -----------------------------------------------------------------------------
create table public.space_logins (
  space_id   uuid not null references public.spaces(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  verifier   text not null check (verifier ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'),
  status     text not null default 'active' check (status in ('active', 'locked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (space_id, account_id)
);

create index space_logins_account_idx on public.space_logins(account_id);

create trigger space_logins_touch_updated_at
before update on public.space_logins
for each row execute function internal.touch_updated_at();

alter table public.space_logins enable row level security;
-- No policy and no grant: tm8_app cannot read a verifier. Every read and write
-- goes through the SECURITY DEFINER functions below.
revoke all on public.space_logins from public;

comment on table public.space_logins is
  'W5 (267, K2): one space password per (space, account), as a scrypt verifier. '
  'No plaintext, no grant to tm8_app; only the 267 SECURITY DEFINER functions touch it.';

-- The account a member's identity signs in as: the one enter_space picks.
create or replace function internal.space_login_account(p_identity text)
returns uuid language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select a.id from public.accounts a
   where a.identity_id = p_identity and a.status = 'active'
   order by a.is_owner desc, a.created_at
   limit 1
$$;

revoke all on function internal.space_login_account(text) from public;

create or replace function internal.require_space_verifier(p_verifier text)
returns void language plpgsql immutable
set search_path = public, internal, pg_temp as $$
begin
  if p_verifier is null
     or p_verifier !~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$' then
    raise exception 'invalid space password verifier' using errcode = '22023';
  end if;
end
$$;

revoke all on function internal.require_space_verifier(text) from public;

-- -----------------------------------------------------------------------------
-- 3. enter_space — 249's body exactly, plus the space-password check.
-- -----------------------------------------------------------------------------
drop function public.enter_space(uuid, uuid, text, timestamptz, text);

create function public.enter_space(
  p_space_id uuid,
  p_parent_session_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null,
  p_space_verifier text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  caller text;
  acct public.accounts;
  parent public.auth_sessions;
  new_kind text := 'browser';
  new_expiry timestamptz := p_expires_at;
  s public.auth_sessions;
begin
  caller := internal.require_identity();
  if nullif(current_setting('tm8.session_space_id', true), '') is not null then
    raise exception 'a space-pinned session cannot enter a space; use the gate session'
      using errcode = '42501';
  end if;
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli') then
    raise exception 'only a human session can enter a space' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'invalid space session credential' using errcode = '22023';
  end if;

  select a.* into acct
    from public.accounts a
   where a.identity_id = caller and a.status = 'active'
   order by a.is_owner desc, a.created_at
   limit 1;
  if acct.id is null then
    raise exception 'account not found or disabled' using errcode = 'P0002';
  end if;

  if p_parent_session_id is not null then
    select s0.* into parent
      from public.auth_sessions s0
     where s0.id = p_parent_session_id
       and s0.revoked_at is null
       and s0.expires_at > now()
       and s0.space_id is null
       and s0.kind in ('browser', 'cli');
    if parent.id is null then
      raise exception 'gate session not found' using errcode = '42501';
    end if;
    select a.* into acct from public.accounts a
     where a.id = parent.account_id and a.identity_id = caller and a.status = 'active';
    if acct.id is null then
      raise exception 'gate session not found' using errcode = '42501';
    end if;
    new_kind := parent.kind;
    new_expiry := least(p_expires_at, parent.expires_at);
  end if;

  -- Membership of the target, read directly (the caller is unpinned, so this
  -- is exactly `is_space_member`). Not-a-member and no-such-space answer the
  -- same so the call is not a space-existence oracle.
  if not exists (
    select 1 from public.members m
     where m.space_id = p_space_id and m.identity_id = caller
       and m.status = 'active'
  ) then
    raise exception 'not a member of that space' using errcode = '42501';
  end if;

  -- 267 (W5, K2): the space password. Required when the space says so, and
  -- always when this account's login for the space is locked. The verifier
  -- must be the one the server checked the password against AND the current
  -- active row's; a null never matches.
  if exists (select 1 from public.spaces sp
              where sp.id = p_space_id and sp.require_space_credential)
     or exists (select 1 from public.space_logins l
                 where l.space_id = p_space_id and l.account_id = acct.id
                   and l.status = 'locked') then
    if not exists (
      select 1 from public.space_logins l
       where l.space_id = p_space_id and l.account_id = acct.id
         and l.status = 'active'
         and l.verifier = p_space_verifier
    ) then
      raise exception 'space password required or not accepted' using errcode = '42501';
    end if;
  end if;

  insert into public.auth_sessions(account_id, kind, token_hash, label, expires_at, space_id, parent_session_id)
  values (acct.id, new_kind, p_token_hash, p_label, new_expiry, p_space_id, parent.id)
  returning * into s;
  return to_jsonb(s) - 'token_hash';
end
$$;

revoke all on function public.enter_space(uuid, uuid, text, timestamptz, text, text) from public;
grant execute on function public.enter_space(uuid, uuid, text, timestamptz, text, text) to tm8_app;

comment on function public.enter_space(uuid, uuid, text, timestamptz, text, text) is
  'auth.space.enter (233, plan W3; 267 W5): a gate session plus membership mints a '
  'session pinned to one space. Refuses a pinned caller and agent kinds. When the '
  'space requires a password (or the login is locked) the caller must present the '
  'active space_logins verifier the server checked the password against.';

-- -----------------------------------------------------------------------------
-- 4. What auth.space.enter must check before it mints.
-- -----------------------------------------------------------------------------
create or replace function public.space_login_for_enter(p_space_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  caller text;
  acct uuid;
  login public.space_logins;
  required boolean;
begin
  caller := internal.require_identity();
  if nullif(current_setting('tm8.session_space_id', true), '') is not null then
    raise exception 'a space-pinned session cannot enter a space; use the gate session'
      using errcode = '42501';
  end if;
  perform internal.require_human_auth_kind();
  -- A non-member learns nothing: "not required", then enter_space refuses.
  if not exists (select 1 from public.members m
                  where m.space_id = p_space_id and m.identity_id = caller
                    and m.status = 'active') then
    return jsonb_build_object('required', false, 'locked', false, 'verifier', null);
  end if;
  acct := internal.space_login_account(caller);
  select sp.require_space_credential into required from public.spaces sp where sp.id = p_space_id;
  select l.* into login from public.space_logins l
   where l.space_id = p_space_id and l.account_id = acct;
  return jsonb_build_object(
    'required', coalesce(required, false) or coalesce(login.status = 'locked', false),
    'locked',   coalesce(login.status = 'locked', false),
    'verifier', case when login.status = 'active' then login.verifier end
  );
end
$$;

revoke all on function public.space_login_for_enter(uuid) from public;
grant execute on function public.space_login_for_enter(uuid) to tm8_app;

comment on function public.space_login_for_enter(uuid) is
  'W5 (267): for a human gate session, whether entering p_space_id needs a space '
  'password and the active verifier to check it against. Never a plaintext.';

-- -----------------------------------------------------------------------------
-- 5. Does this invite need a space password? Claim-free, like preview_invite.
--    A dead code (unknown, revoked, expired, exhausted — exactly the codes
--    redeem_invite and signup_via_invite refuse) answers false, the same as an
--    unknown one, so the setting of a space is never readable through a code
--    that can no longer join it.
-- -----------------------------------------------------------------------------
create or replace function public.invite_requires_space_password(p_code text)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select coalesce((
    select sp.require_space_credential
      from public.space_invites i
      join public.spaces sp on sp.id = i.space_id
     where i.code = p_code
       and i.revoked_at is null
       and (i.expires_at is null or i.expires_at >= now())
       and i.use_count < i.max_uses
  ), false)
$$;

revoke all on function public.invite_requires_space_password(text) from public;
grant execute on function public.invite_requires_space_password(text) to tm8_app;

comment on function public.invite_requires_space_password(text) is
  'W5 (267): true when a live invite code joins a space that requires a space '
  'password. Claim-free, like preview_invite: the code is the authorization. A '
  'dead code (unknown, revoked, expired, exhausted) answers false.';

-- -----------------------------------------------------------------------------
-- 6a. signup_via_invite — 143's body, plus the space password.
-- -----------------------------------------------------------------------------
drop function public.signup_via_invite(text, text, text, text, text, text, text);

create function public.signup_via_invite(
  p_code text,
  p_identity_id text,
  p_username text,
  p_display_name text,
  p_email text,
  p_password_algorithm text,
  p_password_hash text,
  p_space_verifier text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  invite public.space_invites;
  handle text := lower(btrim(p_username));
  a public.accounts;
  member_id uuid;
  needs_space_password boolean;
begin
  if handle is null or handle = '' then
    raise exception 'username is required' using errcode = '22023';
  end if;
  if p_password_hash is null or p_password_algorithm is null then
    raise exception 'a credential is required to sign up' using errcode = '22023';
  end if;

  -- §7.1 GUARD (143). See 143 for why this is inlined and claim-free.
  if not exists (select 1 from public.accounts where password_hash is not null) then
    raise exception
      'this node has not been claimed yet; the operator must claim it (tm8 auth claim) before an invite can create an account'
      using errcode = '42501';
  end if;

  -- Lock and validate the invite, exactly as redeem_invite does.
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

  -- 267 (W5, K2): a space that requires a password gets one at join, checked
  -- AFTER the invite so a dead code learns nothing about the space.
  select sp.require_space_credential into needs_space_password
    from public.spaces sp where sp.id = invite.space_id;
  if coalesce(needs_space_password, false) then
    if p_space_verifier is null then
      raise exception 'this space requires a space password' using errcode = '42501';
    end if;
    perform internal.require_space_verifier(p_space_verifier);
  end if;

  if exists (select 1 from public.accounts where lower(username) = handle) then
    raise exception 'an account with this username already exists' using errcode = '23505';
  end if;

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

  member_id := internal.attach_member(invite.space_id, p_identity_id, invite.role);
  update public.space_invites set use_count = use_count + 1 where id = invite.id;
  perform internal.notify(invite.space_id, invite.created_by, 'join', member_id, member_id,
                          jsonb_build_object('inviteId', invite.id, 'role', invite.role));

  if coalesce(needs_space_password, false) then
    insert into public.space_logins(space_id, account_id, verifier)
    values (invite.space_id, a.id, p_space_verifier);
  end if;

  return jsonb_build_object(
    'account',  to_jsonb(a) - 'password_hash',
    'spaceId',  invite.space_id,
    'memberId', member_id
  );
end
$$;

revoke all on function public.signup_via_invite(text, text, text, text, text, text, text, text) from public;
grant execute on function public.signup_via_invite(text, text, text, text, text, text, text, text) to tm8_app;

comment on function public.signup_via_invite(text, text, text, text, text, text, text, text) is
  'D5 (141, 143; 267 W5): redeem an invite that creates the account. Claim-free; '
  'the code is the authorization. When the invite''s space requires a space '
  'password, p_space_verifier (scrypt) is required and stored for the new account.';

-- -----------------------------------------------------------------------------
-- 6b. redeem_invite — 232's body, plus the space password.
-- -----------------------------------------------------------------------------
drop function public.redeem_invite(text, text);

create function public.redeem_invite(
  p_code text,
  p_client_mutation_id text default null::text,
  p_space_verifier text default null::text
)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  identity text;
  replay jsonb;
  invite public.space_invites;
  member_id uuid;
  existed boolean;
  result jsonb;
  addressed_space uuid;
  acct uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.redeem');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    select space_id into addressed_space
      from public.space_invites where code = p_code;
    if addressed_space is not null then
      perform internal.require_replay_subject(
        replay ->> 'spaceId', addressed_space::text, 'space');
    end if;
    return replay;
  end if;
  identity := internal.require_identity();
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

  -- 232: "already a member" means an ACTIVE member. A tombstoned row is
  -- reactivated by attach_member and spends a use, as a first join does.
  select entity_id into member_id from public.members
   where space_id = invite.space_id and identity_id = identity and status = 'active';
  existed := member_id is not null;
  if not existed then
    if invite.use_count >= invite.max_uses then
      raise exception 'invite is exhausted' using errcode = '53400';
    end if;
    -- 267 (W5, K2): joining a space that requires a password sets one, unless
    -- this account already has a login row there (never overwritten here: a
    -- locked or admin-reset row stays as the admin left it). Humans only.
    if exists (select 1 from public.spaces sp
                where sp.id = invite.space_id and sp.require_space_credential) then
      perform internal.require_human_auth_kind();
      acct := internal.space_login_account(identity);
      if acct is null then
        raise exception 'account not found or disabled' using errcode = 'P0002';
      end if;
      if not exists (select 1 from public.space_logins l
                      where l.space_id = invite.space_id and l.account_id = acct) then
        if p_space_verifier is null then
          raise exception 'this space requires a space password' using errcode = '42501';
        end if;
        perform internal.require_space_verifier(p_space_verifier);
        insert into public.space_logins(space_id, account_id, verifier)
        values (invite.space_id, acct, p_space_verifier);
      end if;
    end if;
    member_id := internal.attach_member(invite.space_id, identity, invite.role);
    update public.space_invites set use_count = use_count + 1 where id = invite.id;
    perform internal.notify(invite.space_id, invite.created_by, 'join', member_id, member_id,
                            jsonb_build_object('inviteId', invite.id, 'role', invite.role));
  end if;
  result := jsonb_build_object('spaceId', invite.space_id, 'memberId', member_id, 'joined', not existed,
                               'patches', jsonb_build_array(internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.invites.redeem', result);
end
$$;

revoke all on function public.redeem_invite(text, text, text) from public;
grant execute on function public.redeem_invite(text, text, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 7. Space-admin ops (P5). Humans only, pin-aware space admin.
-- -----------------------------------------------------------------------------

-- The caller must be a human space admin of p_space_id; returns the caller's role.
create or replace function internal.require_space_password_admin(p_space_id uuid)
returns text language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  role text;
begin
  perform internal.require_identity();
  perform internal.require_human_auth_kind();
  if not internal.is_space_admin(p_space_id) then
    raise exception 'space admin required' using errcode = '42501';
  end if;
  select m.role into role from public.members m
   where m.space_id = p_space_id and m.identity_id = internal.identity_id()
     and m.status = 'active';
  return role;
end
$$;

revoke all on function internal.require_space_password_admin(uuid) from public;

-- The target member's account; an admin may not act on an owner's login.
create or replace function internal.space_password_target(p_space_id uuid, p_member_id uuid, p_caller_role text)
returns uuid language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  target public.members;
  acct uuid;
begin
  select m.* into target from public.members m
   where m.entity_id = p_member_id and m.space_id = p_space_id and m.status = 'active';
  if target.entity_id is null then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if target.role = 'owner' and p_caller_role <> 'owner'
     and target.identity_id <> internal.identity_id() then
    raise exception 'only an owner can change an owner''s space password' using errcode = '42501';
  end if;
  acct := internal.space_login_account(target.identity_id);
  if acct is null then
    raise exception 'member has no active account' using errcode = 'P0002';
  end if;
  return acct;
end
$$;

revoke all on function internal.space_password_target(uuid, uuid, text) from public;

-- End the account's live sessions pinned to the space; return their ids.
create or replace function internal.revoke_space_pinned_sessions(p_space_id uuid, p_account_id uuid)
returns uuid[] language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  ids uuid[];
begin
  with ended as (
    update public.auth_sessions s set revoked_at = now()
     where s.account_id = p_account_id and s.space_id = p_space_id
       and s.revoked_at is null
    returning s.id
  )
  select coalesce(array_agg(id), '{}') into ids from ended;
  return ids;
end
$$;

revoke all on function internal.revoke_space_pinned_sessions(uuid, uuid) from public;

create or replace function public.set_space_require_credential(
  p_space_id uuid,
  p_required boolean,
  p_own_verifier text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  acct uuid;
  mine public.space_logins;
  caller_role text;
  unlogged int;
  revoked uuid[] := '{}';
begin
  caller_role := internal.require_space_password_admin(p_space_id);
  if p_required is null then
    raise exception 'required must be true or false' using errcode = '22023';
  end if;
  if p_required then
    -- Turning it on is an owner's act: it changes how every owner gets in.
    if caller_role is distinct from 'owner' then
      raise exception 'only an owner can require a space password' using errcode = '42501';
    end if;
    -- Turning it on must not lock out the admin turning it on.
    acct := internal.space_login_account(internal.identity_id());
    if acct is null then
      raise exception 'account not found or disabled' using errcode = 'P0002';
    end if;
    select l.* into mine from public.space_logins l
     where l.space_id = p_space_id and l.account_id = acct for update;
    if mine.status = 'locked' then
      raise exception 'your space password is locked' using errcode = '42501';
    end if;
    if p_own_verifier is not null then
      perform internal.require_space_verifier(p_own_verifier);
      insert into public.space_logins(space_id, account_id, verifier)
      values (p_space_id, acct, p_own_verifier)
      on conflict (space_id, account_id) do update set verifier = excluded.verifier;
    elsif mine.account_id is null then
      raise exception 'set your own space password to turn this on' using errcode = '22023';
    end if;
    -- ...nor any other owner: every active owner with an active account must
    -- already hold an active login row, or the flip would shut that owner out
    -- of their own space. (An owner identity with no active account cannot
    -- enter any space, password or not, so it has nothing to be shut out of.)
    select count(*) into unlogged
      from (select internal.space_login_account(m.identity_id) as account_id
              from public.members m
             where m.space_id = p_space_id and m.role = 'owner' and m.status = 'active') o
     where o.account_id is not null
       and not exists (
         select 1 from public.space_logins l
          where l.space_id = p_space_id and l.account_id = o.account_id
            and l.status = 'active');
    if unlogged > 0 then
      raise exception 'every owner of this space needs an active space password first'
        using errcode = '42501';
    end if;
    -- Sessions already pinned to this space were entered without a password.
    -- End them (browser and cli only — agent sessions are never pinned by
    -- enter_space), exactly as reset and lock do; the caller's own included,
    -- so every live session in the space has passed the password it now needs.
    with ended as (
      update public.auth_sessions s set revoked_at = now()
       where s.space_id = p_space_id and s.kind in ('browser', 'cli')
         and s.revoked_at is null
      returning s.id
    )
    select coalesce(array_agg(id), '{}') into revoked from ended;
  end if;
  perform set_config('tm8.space_password_writer', 'on', true);
  update public.spaces set require_space_credential = p_required where id = p_space_id;
  perform set_config('tm8.space_password_writer', '', true);
  return jsonb_build_object('spaceId', p_space_id, 'requireSpacePassword', p_required,
    'revokedSessionIds', to_jsonb(revoked));
end
$$;

revoke all on function public.set_space_require_credential(uuid, boolean, text) from public;
grant execute on function public.set_space_require_credential(uuid, boolean, text) to tm8_app;

create or replace function public.reset_space_login(
  p_space_id uuid,
  p_member_id uuid,
  p_verifier text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  caller_role text;
  acct uuid;
  ended uuid[];
begin
  caller_role := internal.require_space_password_admin(p_space_id);
  perform internal.require_space_verifier(p_verifier);
  acct := internal.space_password_target(p_space_id, p_member_id, caller_role);
  insert into public.space_logins(space_id, account_id, verifier, status)
  values (p_space_id, acct, p_verifier, 'active')
  on conflict (space_id, account_id) do update
    set verifier = excluded.verifier, status = 'active';
  ended := internal.revoke_space_pinned_sessions(p_space_id, acct);
  return jsonb_build_object('spaceId', p_space_id, 'memberId', p_member_id,
                            'status', 'active', 'revokedSessionIds', to_jsonb(ended));
end
$$;

revoke all on function public.reset_space_login(uuid, uuid, text) from public;
grant execute on function public.reset_space_login(uuid, uuid, text) to tm8_app;

create or replace function public.set_space_login_locked(
  p_space_id uuid,
  p_member_id uuid,
  p_locked boolean
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  caller_role text;
  acct uuid;
  ended uuid[] := '{}';
  updated int;
begin
  caller_role := internal.require_space_password_admin(p_space_id);
  if p_locked is null then
    raise exception 'locked must be true or false' using errcode = '22023';
  end if;
  acct := internal.space_password_target(p_space_id, p_member_id, caller_role);
  if p_locked and acct = internal.space_login_account(internal.identity_id()) then
    raise exception 'you cannot lock your own space password' using errcode = '22023';
  end if;
  update public.space_logins
     set status = case when p_locked then 'locked' else 'active' end
   where space_id = p_space_id and account_id = acct;
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'member has no space password' using errcode = 'P0002';
  end if;
  if p_locked then
    ended := internal.revoke_space_pinned_sessions(p_space_id, acct);
  end if;
  return jsonb_build_object('spaceId', p_space_id, 'memberId', p_member_id,
                            'status', case when p_locked then 'locked' else 'active' end,
                            'revokedSessionIds', to_jsonb(ended));
end
$$;

revoke all on function public.set_space_login_locked(uuid, uuid, boolean) from public;
grant execute on function public.set_space_login_locked(uuid, uuid, boolean) to tm8_app;

reset role;

-- Never-analyzed tables are estimated at 10 pages (225); 229's precedent.
analyze public.space_logins;
