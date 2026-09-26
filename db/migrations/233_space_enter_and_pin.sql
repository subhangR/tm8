-- =============================================================================
-- 233 — a human enters a space; a pinned session loses node power (plan
-- 01a0d9eb W3).
--
-- 226 gave `auth_sessions` a space and 227 made every membership helper honour
-- `tm8.session_space_id`. Until now only agent kinds carried a space. This
-- migration lets a HUMAN session be pinned, and closes the paths that bypass
-- membership, so that a pinned session can reach nothing outside its space:
--
--   1. `public.enter_space` — a gate session (`space_id` null, `browser`/`cli`)
--      plus membership of the target mints a session pinned to it. Same kind,
--      same account, and never outlives the gate session it came from.
--   2. `public.issue_auth_session` refuses a pinned caller. Otherwise a pinned
--      token could mint its own UNPINNED session and walk out of its space.
--   3. K6. `internal.is_node_admin()` is false and `internal.require_node_admin()`
--      refuses under a pin. The server also binds `tm8.node_admin = false` for
--      a pinned session; `require_node_admin` reads `accounts`, not the claim,
--      so it needs its own check. Node admin is gate admin.
--   4. K7 REJECTED (owner decision 32, design doc 01a0da94 v2): nobody reads
--      a public space without joining it. spaces_select loses its public arm
--      (218:291, W0a known gap a5) and is membership only, so the pin (227's
--      `member_space_ids`) admits exactly the pinned space, and `spaces.list`
--      stops listing unjoined public spaces. `join_public_space` stays and
--      joins BY ID (it reads the target as the definer, which the tm8_app
--      policy does not bind); it now refuses a pinned caller unless the
--      target is the pinned space. How a public space is discovered for
--      joining is an open question for the owner.
--   5. `public.consume_stream_attach` (PTY attach) refuses a work session
--      outside the pinned space.
--
-- INLINE PIN (plan A10). Every predicate here reads
-- `nullif(current_setting('tm8.session_space_id', true), '')` directly, never
-- `internal.session_space_id()`. The VERIFY block at the end rejects the call
-- form on `is_node_admin`, which RLS evaluates.
--
-- Unset claim ⇒ every FUNCTION body below is exactly its previous text. The one
-- change that reaches unpinned sessions too is 4: an unjoined public space is no
-- longer readable by anyone, in every mode.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 3. K6 — a pinned session never holds node-admin power.
-- -----------------------------------------------------------------------------
create or replace function internal.is_node_admin() returns boolean
language sql stable as $$
  select coalesce(lower(internal.claim_text('tm8.node_admin')) = 'true', false)
     and nullif(current_setting('tm8.session_space_id', true), '') is null
$$;

create or replace function internal.require_node_admin() returns void
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_identity();
  if nullif(current_setting('tm8.session_space_id', true), '') is not null then
    raise exception 'node admin required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.accounts a
     where a.identity_id = internal.identity_id()
       and a.status = 'active'
       and (a.is_node_admin or a.is_owner)
  ) then
    raise exception 'node admin required' using errcode = '42501';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 2. A pinned session cannot mint a session. 007's body plus the first check.
-- -----------------------------------------------------------------------------
create or replace function public.issue_auth_session(
  p_account_id uuid, p_token_hash text, p_kind text, p_expires_at timestamptz,
  p_acting_as_team_member_id uuid default null, p_label text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  s public.auth_sessions;
  a public.accounts;
begin
  -- A pinned session minting an unpinned one would leave its space. Entering
  -- another space goes back through the gate session (`enter_space`).
  if nullif(current_setting('tm8.session_space_id', true), '') is not null then
    raise exception 'a space-pinned session cannot issue sessions' using errcode = '42501';
  end if;
  select * into a from public.accounts where id = p_account_id and status = 'active';
  if a.id is null then
    raise exception 'account not found or disabled' using errcode = 'P0002';
  end if;
  -- Minting a token for somebody else is node administration. Minting your own
  -- (login, a CLI token, an agent session for your own persona) is not.
  if internal.identity_id() is distinct from a.identity_id then
    perform internal.require_node_admin();
  end if;
  insert into public.auth_sessions(account_id, kind, acting_as_team_member_id, token_hash, label, expires_at)
  values (p_account_id, p_kind, p_acting_as_team_member_id, p_token_hash, p_label, p_expires_at)
  returning * into s;
  return to_jsonb(s) - 'token_hash';
end
$$;

-- -----------------------------------------------------------------------------
-- 1. enter_space — gate session + membership ⇒ a session pinned to the space.
--
-- `p_parent_session_id` is the VERIFIED session the server resolved from the
-- presented token (never request input). Null means the loopback auto-owner,
-- which has no session row; that caller gets a `browser` session capped at
-- `p_expires_at`. With a parent, the new row inherits its kind and cannot
-- outlive it. Sessions carry no parent link, so revoking the gate does not
-- revoke its children; the expiry cap bounds them instead.
-- -----------------------------------------------------------------------------
create or replace function public.enter_space(
  p_space_id uuid,
  p_parent_session_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_label text default null
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
  ) then
    raise exception 'not a member of that space' using errcode = '42501';
  end if;

  insert into public.auth_sessions(account_id, kind, token_hash, label, expires_at, space_id)
  values (acct.id, new_kind, p_token_hash, p_label, new_expiry, p_space_id)
  returning * into s;
  return to_jsonb(s) - 'token_hash';
end
$$;

revoke all on function public.enter_space(uuid, uuid, text, timestamptz, text) from public;
grant execute on function public.enter_space(uuid, uuid, text, timestamptz, text) to tm8_app;

comment on function public.enter_space(uuid, uuid, text, timestamptz, text) is
  'auth.space.enter (233, plan W3): a gate session plus membership mints a '
  'session pinned to one space. Refuses a pinned caller and agent kinds.';

-- -----------------------------------------------------------------------------
-- 4. K7 rejected — no reading a public space without joining it.
--
-- Membership only. `member_space_ids()` already honours the pin (227), so a
-- pinned session sees its one space and a gate session its memberships. The
-- policy binds tm8_app only: security-definer functions (join_public_space)
-- still read the target row by id.
-- -----------------------------------------------------------------------------
alter policy spaces_select on public.spaces
  using ((id = any ((select internal.member_space_ids())::uuid[])));

-- 031's join_public_space plus one check: joining is a write into the public
-- space, so a pinned caller may only "join" the space it is pinned to (where
-- it is already a member, making the call a no-op).
create or replace function public.join_public_space(p_space_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text;
  replay jsonb;
  target public.spaces;
  member_id uuid;
  existed boolean;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.redeem');
  if replay is not null then
    -- THE SECURITY BOUNDARY. internal.ledger_replay takes
    -- pg_advisory_xact_lock on the cmid and only then selects, so this call
    -- runs with that lock HELD and the recorded row guaranteed visible. The
    -- identical call before ledger_replay is a fast path, NOT the boundary:
    -- it runs unlocked and reads "not found" against a victim's still
    -- uncommitted row. See the TOCTOU note in 031's header.
    perform internal.require_replay_principal(p_client_mutation_id);
    -- Also closes the shared-operation-string crossing: a redeem_invite cmid
    -- carries the invite's Space, which will not match the Space addressed here
    -- unless it is genuinely the same Space.
    perform internal.require_replay_subject(
      replay ->> 'spaceId', p_space_id::text, 'space');
    return replay;
  end if;
  identity := internal.require_identity();
  if nullif(current_setting('tm8.session_space_id', true), '')::uuid is distinct from p_space_id
     and nullif(current_setting('tm8.session_space_id', true), '') is not null then
    raise exception 'a space-pinned session cannot join another space' using errcode = '42501';
  end if;
  select * into target from public.spaces where id = p_space_id;
  if target.id is null then
    raise exception 'space not found' using errcode = 'P0002';
  end if;
  select entity_id into member_id from public.members
   where space_id = p_space_id and identity_id = identity;
  existed := member_id is not null;
  if not existed then
    if target.visibility <> 'public' then
      raise exception 'space is not public' using errcode = '42501';
    end if;
    member_id := internal.attach_member(p_space_id, identity, 'member');
  end if;
  result := jsonb_build_object('spaceId', p_space_id, 'memberId', member_id, 'joined', not existed,
                               'patches', jsonb_build_array(internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.invites.redeem', result);
end
$$;

-- VERIFY: is_node_admin carries the pin inline (A10), and spaces_select has
-- no public arm (K7 rejected).
do $verify$
begin
  if exists (
    select 1 from pg_proc p
     where p.oid = 'internal.is_node_admin()'::regprocedure
       and (p.prosrc not like '%current_setting(''tm8.session_space_id'', true)%'
            or p.prosrc like '%session_space_id()%')
  ) then
    raise exception 'VERIFY 233: is_node_admin is not pinned inline';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'spaces' and policyname = 'spaces_select'
       and qual like '%member_space_ids()%'
       and qual not like '%visibility%'
  ) then
    raise exception 'VERIFY 233: spaces_select still admits an unjoined public space';
  end if;
end
$verify$;

reset role;

-- -----------------------------------------------------------------------------
-- 5. PTY attach honours the pin. 087 created consume_stream_attach as the
-- migrating role, so it is replaced after `reset role` to keep that owner (as
-- 226 did for 072's issuer). 087's body plus the pin conjunct.
-- -----------------------------------------------------------------------------
create or replace function public.consume_stream_attach(
  p_session_id uuid,
  p_mode text,
  p_token_hash text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  claim_identity text := nullif(current_setting('tm8.identity_id', true), '');
  consumed public.stream_grants;
begin
  -- All credential failures deliberately converge on the same branch. In
  -- particular, do not report whether a session, mode, hash, identity, expiry,
  -- pin, or already-consumed row was the part that failed to match.
  if p_mode not in ('view','drive')
     or p_token_hash is null
     or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'stream attach refused' using errcode = '42501';
  end if;

  update public.stream_grants
     set revoked_at = now()
   where work_session_id = p_session_id
     and mode = p_mode
     and token_hash = p_token_hash
     and revoked_at is null
     and expires_at > now()
     and (claim_identity is null or subject_identity = claim_identity)
     and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
          or exists (select 1 from public.entities e
                      where e.id = p_session_id
                        and e.space_id = nullif(current_setting('tm8.session_space_id', true), '')::uuid))
  returning * into consumed;

  if consumed.id is null then
    raise exception 'stream attach refused' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'subjectIdentity', consumed.subject_identity,
    'mode', consumed.mode,
    'grantId', consumed.id
  );
end
$$;
