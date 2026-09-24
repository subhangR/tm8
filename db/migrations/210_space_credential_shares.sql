-- =============================================================================
-- 210 — SHARE A PERSONAL CREDENTIAL TO A SPACE (SC-8). Design addendum
-- 01a0d38e v4 on design 01a0cfa8, with the dated human amendment to D11/D12
-- (2026-09-24): "D11/D12 apply to space-owned credentials. A share
-- (share_kind not null) is removable by space admins but not edited by them,
-- and dies with its sharer's membership or account."
--
-- A SHARE IS A space_credentials ROW, so the launch contract (a space
-- credential id, never an account id: I1), the D8 record, resume re-pointing,
-- SC-3's delete-and-kill and the picker all work on it unchanged. Two kinds:
--
--   * personal_token — the sharer's GitHub token, by REFERENCE. The row holds
--     no secret at all; the spawn reader returns 093's sealed bytes and the
--     sharer's account id, and the TS store opens them under 093's own AAD
--     (<account>|github). A rotation by the owner follows automatically; a
--     disconnect leaves nothing to leak.
--   * personal_login — a member-owned SPACE LOGIN (SC-4's home and terminal):
--     the owner signs in again with the same vendor account and the share gets
--     its own grant. Pointing at the personal home is rejected (addendum §5).
--
-- RULES, all enforced here:
--   * A share is never the space default (CHECK; default_space_credential_if_none
--     skips it), so auto never lands on someone's bill (addendum §3).
--   * Only the sharer creates, renames, re-logs in or probes a share
--     (lock_managed_space_credential); a space admin may only REMOVE it
--     (delete_space_credential, via internal.lock_removable_space_credential).
--   * Lifecycle (addendum §6, §10.2) — each revokes; the TS caller kills:
--       - un-share / admin remove: delete_space_credential (206 path);
--       - owner disconnects GitHub: AFTER DELETE on account_git_credentials;
--       - owner disconnects a login: AFTER DELETE on account_agent_credentials;
--       - owner leaves a space: revoke_member_shares BEFORE the members row
--         goes, and an AFTER DELETE trigger on members as the belt;
--       - owner disabled: AFTER UPDATE OF status on accounts;
--       - owner deleted: the FK SETs shared_by_account_id NULL, and the BEFORE
--         UPDATE trigger space_credential_share_orphan_revoke revokes the row
--         in that same UPDATE (MF1) — the CHECK is only the backstop, so an
--         account delete is never aborted by it.
--   * Identity -> account is 1:1 (accounts.identity_id is NOT NULL UNIQUE and
--     immutable, 002), so one helper, internal.account_id_for_identity, maps a
--     members row to its sharer for both the RPC and the trigger.
--
-- WHAT A LATER MIGRATION MUST NOT DO:
--   * Re-create internal.default_space_credential_if_none without its
--     `share_kind is null` guard, or lock_managed_space_credential without its
--     sharer-only arm, or delete_space_credential without the removable lock.
--   * Everything 206's header forbids still stands. This file re-creates only
--     the functions named above plus read_space_credential_for_spawn.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Columns and constraints
-- -----------------------------------------------------------------------------
alter table public.space_credentials
  add column shared_by_account_id uuid references public.accounts(id) on delete set null,
  add column share_kind text;

comment on column public.space_credentials.shared_by_account_id is
  'SC-8: the member whose personal credential this share points at. NULL for a '
  'space-owned credential. Set NULL only by account delete, which revokes (210).';

alter table public.space_credentials
  add constraint space_credentials_share_kind_check
    check (share_kind is null or share_kind in ('personal_token', 'personal_login')),
  add constraint space_credentials_share_shape_check
    check (share_kind is null
        or (share_kind = 'personal_token' and provider = 'github' and shape = 'token')
        or (share_kind = 'personal_login' and provider in ('anthropic', 'openai') and shape = 'login')),
  -- The backstop for MF1. The BEFORE UPDATE trigger below is the enforcer.
  add constraint space_credentials_share_owner_check
    check ((share_kind is null and shared_by_account_id is null)
        or (share_kind is not null and (shared_by_account_id is not null or status = 'revoked'))),
  -- The sharer is the creator. Either column may be nulled first by an account
  -- delete's FK actions, so a null on either side passes.
  add constraint space_credentials_share_creator_check
    check (share_kind is null or created_by_account_id is null or shared_by_account_id is null
        or created_by_account_id = shared_by_account_id),
  add constraint space_credentials_share_never_default_check
    check (share_kind is null or not is_default);

-- 206's secret shape, plus: a personal_token share never holds a secret.
alter table public.space_credentials drop constraint space_credentials_secret_shape_check;
alter table public.space_credentials add constraint space_credentials_secret_shape_check
  check (case
    when shape = 'login' then
      secret_ciphertext is null and secret_nonce is null and key_hint is null
    when share_kind = 'personal_token' then
      secret_ciphertext is null and secret_nonce is null and key_hint is null
    when status = 'revoked' then
      secret_ciphertext is null and secret_nonce is null
    else
      secret_ciphertext is not null and secret_nonce is not null and key_hint is not null
  end);

-- One live share per (space, provider, sharer).
create unique index space_credentials_one_live_share
  on public.space_credentials(space_id, provider, shared_by_account_id)
  where share_kind is not null and status in ('active', 'stale');

create index space_credentials_shared_by_idx
  on public.space_credentials(shared_by_account_id)
  where shared_by_account_id is not null;

grant select (shared_by_account_id, share_kind) on public.space_credentials to tm8_app;

-- -----------------------------------------------------------------------------
-- 2. Helpers
-- -----------------------------------------------------------------------------

-- 1:1 (002: accounts.identity_id not null unique, immutable). No status
-- filter: a disabled sharer's shares must still be found.
create or replace function internal.account_id_for_identity(p_identity text)
returns uuid
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select a.id from public.accounts a where a.identity_id = p_identity
$$;

-- Revoke an account's live shares, in one space or all, of one provider or
-- all. Returns the ids it revoked. No authority check: callers are the
-- triggers below and revoke_member_shares, which checks.
create or replace function internal.revoke_account_shares(
  p_account_id uuid,
  p_space_id uuid default null,
  p_provider text default null,
  p_share_kind text default null
) returns uuid[]
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare revoked uuid[];
begin
  with gone as (
    update public.space_credentials
       set status = 'revoked', is_default = false, pending_expires_at = null
     where shared_by_account_id = p_account_id
       and share_kind is not null
       and status <> 'revoked'
       and (p_space_id is null or space_id = p_space_id)
       and (p_provider is null or provider = p_provider)
       and (p_share_kind is null or share_kind = p_share_kind)
    returning id)
  select coalesce(array_agg(id order by id), '{}') into revoked from gone;
  return revoked;
end
$$;

-- Metadata only (I5). 206's json plus the two share fields and the sharer's
-- display name in THIS space, read at call time from their members row (for a
-- share, created_by_identity_id is the sharer's identity). The store's list()
-- builds the same object inline under the caller's RLS.
create or replace function internal.space_credential_json(p public.space_credentials)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'spaceId', p.space_id, 'provider', p.provider, 'shape', p.shape,
    'label', p.label, 'isDefault', p.is_default, 'status', p.status,
    'createdByAccountId', p.created_by_account_id,
    'displayLogin', p.display_login, 'keyHint', p.key_hint,
    'pendingExpiresAt', p.pending_expires_at,
    'createdAt', p.created_at, 'updatedAt', p.updated_at,
    'lastUsedAt', p.last_used_at, 'lastProbeAt', p.last_probe_at,
    'shareKind', p.share_kind,
    'sharedBy', case when p.shared_by_account_id is null then null else jsonb_build_object(
      'accountId', p.shared_by_account_id,
      'displayName', (select coalesce(m.display_name, m.identity_id) from public.members m
                       where m.space_id = p.space_id and m.identity_id = p.created_by_identity_id)) end)
$$;

-- 206's, plus: a share is never made the default.
create or replace function internal.default_space_credential_if_none(p_credential_id uuid)
returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare target public.space_credentials;
begin
  select * into target from public.space_credentials where id = p_credential_id;
  if target.status <> 'active' or target.share_kind is not null then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(target.space_id::text || '|' || target.provider, 206));
  if not exists (select 1 from public.space_credentials
                  where space_id = target.space_id and provider = target.provider
                    and is_default and status = 'active') then
    update public.space_credentials set is_default = true where id = p_credential_id;
  end if;
end
$$;

-- 206's lock for REMOVAL: the creator (the sharer, for a share) or a space
-- admin — D11's delete right, which the amendment keeps for shares.
create or replace function internal.lock_removable_space_credential(p_credential_id uuid)
returns public.space_credentials
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  select * into stored from public.space_credentials
   where id = p_credential_id for update;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if not internal.can_manage_space_credential(stored) then
    raise exception 'only the credential''s creator or a space admin can change it'
      using errcode = '42501';
  end if;
  return stored;
end
$$;

-- 206's lock for every EDIT (rekey, rename, set default, probe, re-login).
-- Amended D11: a share is edited by its sharer only; an admin may remove it
-- (lock_removable_space_credential) but not edit it.
create or replace function internal.lock_managed_space_credential(p_credential_id uuid)
returns public.space_credentials
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  stored := internal.lock_removable_space_credential(p_credential_id);
  if stored.share_kind is not null
     and stored.shared_by_account_id is distinct from internal.current_account_id() then
    raise exception 'a shared credential is changed only by the member who shared it; a space admin can remove it'
      using errcode = '42501';
  end if;
  return stored;
end
$$;

revoke all on function internal.account_id_for_identity(text) from public;
revoke all on function internal.revoke_account_shares(uuid, uuid, text, text) from public;
revoke all on function internal.space_credential_json(public.space_credentials) from public;
revoke all on function internal.default_space_credential_if_none(uuid) from public;
revoke all on function internal.lock_removable_space_credential(uuid) from public;
revoke all on function internal.lock_managed_space_credential(uuid) from public;

-- -----------------------------------------------------------------------------
-- 3. Lifecycle triggers (addendum §6, §10.2). Each only REVOKES: SQL cannot
--    kill a PTY. The TS caller of each path kills (killSharesOf).
-- -----------------------------------------------------------------------------

-- MF1: the account delete's FK action nulls shared_by_account_id. Revoke the
-- row in that same UPDATE, so the backstop CHECK never sees a live orphan and
-- the account delete is never aborted by it.
create or replace function internal.space_credential_share_orphan_revoke()
returns trigger
language plpgsql as $$
begin
  if new.share_kind is not null and new.shared_by_account_id is null
     and old.shared_by_account_id is not null then
    new.status := 'revoked';
    new.is_default := false;
    new.pending_expires_at := null;
  end if;
  return new;
end
$$;

create trigger space_credential_share_orphan_revoke
before update of shared_by_account_id on public.space_credentials
for each row execute function internal.space_credential_share_orphan_revoke();

-- The owner disconnects GitHub: every personal_token share, every space.
create or replace function internal.revoke_token_shares_on_disconnect()
returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.revoke_account_shares(old.account_id, null, old.provider, 'personal_token');
  return null;
end
$$;

create trigger account_git_credentials_revoke_shares
after delete on public.account_git_credentials
for each row execute function internal.revoke_token_shares_on_disconnect();

-- The owner disconnects a personal login: that provider's login shares.
create or replace function internal.revoke_login_shares_on_disconnect()
returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if old.provider in ('anthropic', 'openai') then
    perform internal.revoke_account_shares(old.account_id, null, old.provider, 'personal_login');
  end if;
  return null;
end
$$;

create trigger account_agent_credentials_revoke_shares
after delete on public.account_agent_credentials
for each row execute function internal.revoke_login_shares_on_disconnect();

-- The owner is disabled: every share, every space (amended D12).
create or replace function internal.revoke_shares_on_account_disable()
returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if new.status = 'disabled' and old.status is distinct from 'disabled' then
    perform internal.revoke_account_shares(new.id);
  end if;
  return null;
end
$$;

create trigger accounts_revoke_shares_on_disable
after update of status on public.accounts
for each row execute function internal.revoke_shares_on_account_disable();

-- The BELT for member removal (advisory B: contain BEFORE the members row goes
-- — revoke_member_shares + the TS kill do that). A removal path that forgets
-- them still leaves nothing usable. Space-scoped, and only when no members row
-- still makes the account a member (a no-op guard while the mapping is 1:1).
create or replace function internal.revoke_shares_on_member_delete()
returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_account uuid;
begin
  v_account := internal.account_id_for_identity(old.identity_id);
  if v_account is not null and not exists (
       select 1 from public.members m join public.accounts a on a.identity_id = m.identity_id
        where m.space_id = old.space_id and a.id = v_account) then
    perform internal.revoke_account_shares(v_account, old.space_id);
  end if;
  return null;
end
$$;

create trigger members_revoke_shares
after delete on public.members
for each row execute function internal.revoke_shares_on_member_delete();

revoke all on function internal.space_credential_share_orphan_revoke() from public;
revoke all on function internal.revoke_token_shares_on_disconnect() from public;
revoke all on function internal.revoke_login_shares_on_disconnect() from public;
revoke all on function internal.revoke_shares_on_account_disable() from public;
revoke all on function internal.revoke_shares_on_member_delete() from public;

-- -----------------------------------------------------------------------------
-- 4. RPCs
-- -----------------------------------------------------------------------------

-- Share the caller's personal GitHub token into a space they belong to. The
-- row holds no secret. The TS caller has already opened the token and
-- refused a classic or OAuth one (T1); SQL cannot see the prefix.
create or replace function public.share_personal_token(p_space_id uuid, p_label text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  v_login text;
  stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  select login into v_login from public.account_git_credentials
   where account_id = v_account_id and provider = 'github';
  if v_login is null then
    raise exception 'connect a GitHub token under your credentials before sharing it'
      using errcode = '23514', detail = jsonb_build_object('reason', 'not_connected')::text;
  end if;
  begin
    insert into public.space_credentials(
      space_id, provider, shape, label, status,
      created_by_account_id, created_by_identity_id, shared_by_account_id, share_kind,
      display_login, last_probe_at
    ) values (
      p_space_id, 'github', 'token', internal.require_space_credential_label(p_label), 'active',
      v_account_id, internal.identity_id(), v_account_id, 'personal_token',
      v_login, now()
    ) returning * into stored;
  exception when unique_violation then
    raise exception 'you already share a GitHub token to this space, or the label is taken'
      using errcode = '23505', detail = jsonb_build_object('reason', 'already_shared')::text;
  end;
  return internal.space_credential_json(stored);
end
$$;

-- Open a login terminal whose credential will be a personal_login share
-- (SC-4's flow, flagged). The caller must have that provider connected
-- personally: the share is offered from the personal card.
create or replace function public.start_space_credential_share_login(
  p_space_id uuid,
  p_provider text,
  p_label text,
  p_ttl_seconds integer default 900,
  p_session_cap integer default 2
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  started jsonb;
  stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.account_agent_credentials
                  where account_id = v_account_id and provider = p_provider
                    and status in ('active', 'stale')) then
    raise exception 'connect % under your credentials before sharing it', p_provider
      using errcode = '23514', detail = jsonb_build_object('reason', 'not_connected')::text;
  end if;
  if exists (select 1 from public.space_credentials
              where space_id = p_space_id and provider = p_provider
                and shared_by_account_id = v_account_id and share_kind is not null
                and status in ('active', 'stale')) then
    raise exception 'you already share % to this space', p_provider
      using errcode = '23505', detail = jsonb_build_object('reason', 'already_shared')::text;
  end if;

  started := public.start_space_credential_login(p_space_id, p_provider, p_label, null,
                                                  p_ttl_seconds, p_session_cap);
  update public.space_credentials
     set shared_by_account_id = v_account_id, share_kind = 'personal_login'
   where id = (started -> 'credential' ->> 'id')::uuid
  returning * into stored;
  return started || jsonb_build_object('credential', internal.space_credential_json(stored));
end
$$;

-- 206's delete, with the REMOVAL lock: a space admin may remove a share
-- (amended D11), the sharer may un-share it. Everything else is 206's.
create or replace function public.delete_space_credential(p_credential_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  stored public.space_credentials;
  was_revoked boolean;
begin
  perform internal.require_human_auth_kind();
  stored := internal.lock_removable_space_credential(p_credential_id);
  was_revoked := stored.status = 'revoked';
  if not was_revoked then
    update public.space_credentials
       set status = 'revoked',
           is_default = false,
           pending_expires_at = null,
           secret_ciphertext = null,
           secret_nonce = null
     where id = stored.id returning * into stored;
  end if;
  return internal.space_credential_json(stored) || jsonb_build_object('revoked', not was_revoked);
end
$$;

-- Step 1 of member removal (advisory B) and of killSharesOf: revoke the
-- account's shares — in p_space_id, or every space when null — and answer
-- every live session and open login terminal on ANY of its revoked shares in
-- that scope, whoever launched it (a retry after a failed kill still finds
-- them). Authority is HERE, not only in TS: a node admin; a space admin of
-- p_space_id; or the account itself.
create or replace function public.revoke_member_shares(
  p_space_id uuid,
  p_account_id uuid,
  p_provider text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  revoked uuid[];
  sessions jsonb;
  logins jsonb;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_identity();
  if p_account_id is null then
    raise exception 'an account id is required' using errcode = '22023';
  end if;
  if not (internal.is_node_admin()
          or (p_space_id is not null and internal.is_space_admin(p_space_id))
          or p_account_id = internal.current_account_id()) then
    raise exception 'space admin required' using errcode = '42501';
  end if;

  revoked := internal.revoke_account_shares(p_account_id, p_space_id, p_provider);

  select coalesce(jsonb_agg(jsonb_build_object(
           'workSessionId', ssc.work_session_id, 'provider', ssc.provider,
           'spaceId', ssc.space_id, 'spaceCredentialId', ssc.space_credential_id,
           'launcherAccountId', ssc.launcher_account_id, 'status', ws.status)
           order by ssc.work_session_id, ssc.provider), '[]'::jsonb)
    into sessions
    from public.session_space_credentials ssc
    join public.space_credentials sc on sc.id = ssc.space_credential_id
    join public.work_sessions ws on ws.entity_id = ssc.work_session_id
   where sc.shared_by_account_id = p_account_id
     and sc.share_kind is not null
     and sc.status = 'revoked'
     and (p_space_id is null or sc.space_id = p_space_id)
     and (p_provider is null or sc.provider = p_provider)
     and ws.status in ('spawning', 'running', 'idle');

  select coalesce(jsonb_agg(jsonb_build_object(
           'workSessionId', cs.work_session_id, 'spaceCredentialId', cs.space_credential_id,
           'accountId', cs.account_id, 'expiresAt', cs.expires_at)
           order by cs.work_session_id), '[]'::jsonb)
    into logins
    from public.credential_sessions cs
    join public.space_credentials sc on sc.id = cs.space_credential_id
   where sc.shared_by_account_id = p_account_id
     and sc.share_kind is not null
     and sc.status = 'revoked'
     and (p_space_id is null or sc.space_id = p_space_id)
     and (p_provider is null or sc.provider = p_provider)
     and cs.finished_at is null;

  return jsonb_build_object('spaceId', p_space_id, 'accountId', p_account_id,
                            'revokedCredentialIds', to_jsonb(revoked),
                            'sessions', sessions, 'loginTerminals', logins);
end
$$;

-- The caller's own shares across every space it belongs to (the personal card).
create or replace function public.list_my_credential_shares()
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v_account_id uuid;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  return coalesce((
    select jsonb_agg(internal.space_credential_json(sc) || jsonb_build_object('spaceName', s.name)
                     order by s.name, sc.provider)
      from public.space_credentials sc
      join public.spaces s on s.id = sc.space_id
     where sc.shared_by_account_id = v_account_id
       and sc.share_kind is not null
       and sc.status <> 'revoked'
       and internal.is_space_member(sc.space_id)), '[]'::jsonb);
end
$$;

-- 206's spawn reader, plus the share arms. For a personal_token share it
-- returns 093's SEALED bytes and the sharer's account id for the AAD — never
-- plaintext; the TS store opens them. A share whose owner has left the space
-- or disconnected refuses with a reason naming it (I3). The account id is
-- produced here, server-side, and never accepted from a client (I1).
create or replace function public.read_space_credential_for_spawn(
  p_launch_space_id uuid,
  p_provider text,
  p_credential_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  stored public.space_credentials;
  git public.account_git_credentials;
begin
  perform internal.require_space_member(p_launch_space_id);

  if p_credential_id is null then
    select * into stored from public.space_credentials
     where space_id = p_launch_space_id and provider = p_provider
       and is_default and status = 'active';
    if stored.id is null then
      raise exception 'this space has no default % credential', p_provider using errcode = 'P0002',
        detail = jsonb_build_object('reason', 'no_default', 'provider', p_provider)::text;
    end if;
  else
    select * into stored from public.space_credentials
     where id = p_credential_id and space_id = p_launch_space_id;
    if stored.id is null or stored.provider is distinct from p_provider then
      raise exception 'space credential not found in this space' using errcode = 'P0002',
        detail = jsonb_build_object('reason', 'not_found', 'provider', p_provider)::text;
    end if;
    if stored.status <> 'active' then
      raise exception 'space credential "%" is %', stored.label, stored.status using errcode = '23514',
        detail = jsonb_build_object('reason', stored.status, 'provider', p_provider)::text;
    end if;
  end if;

  if stored.share_kind is not null then
    -- Belt behind the lifecycle triggers: the sharer must still be an active
    -- member of this space.
    if not exists (select 1 from public.accounts a
                     join public.members m on m.identity_id = a.identity_id
                    where a.id = stored.shared_by_account_id and a.status = 'active'
                      and m.space_id = stored.space_id) then
      raise exception 'space credential "%" was shared by a member who has left', stored.label
        using errcode = '23514',
              detail = jsonb_build_object('reason', 'share_owner_gone', 'provider', p_provider)::text;
    end if;
    if stored.share_kind = 'personal_token' then
      select * into git from public.account_git_credentials
       where account_id = stored.shared_by_account_id and provider = 'github';
      if git.id is null then
        raise exception 'space credential "%" was disconnected by the member who shared it', stored.label
          using errcode = '23514',
                detail = jsonb_build_object('reason', 'share_source_disconnected', 'provider', p_provider)::text;
      end if;
    end if;
  end if;

  update public.space_credentials set last_used_at = now()
   where id = stored.id;

  return jsonb_build_object(
    'credentialId', stored.id,
    'spaceId', stored.space_id,
    'provider', stored.provider,
    'shape', stored.shape,
    'label', stored.label,
    'displayLogin', case when git.id is not null then git.login else stored.display_login end,
    'shareKind', stored.share_kind,
    'aadAccountId', case when git.id is not null then git.account_id else null end,
    'secretCiphertext', case
      when git.id is not null then encode(git.token_ciphertext, 'base64')
      when stored.shape = 'login' then null
      else encode(stored.secret_ciphertext, 'base64') end,
    'secretNonce', case
      when git.id is not null then encode(git.token_nonce, 'base64')
      when stored.shape = 'login' then null
      else encode(stored.secret_nonce, 'base64') end
  );
end
$$;

revoke all on function public.share_personal_token(uuid, text) from public;
revoke all on function public.start_space_credential_share_login(uuid, text, text, integer, integer) from public;
revoke all on function public.delete_space_credential(uuid) from public;
revoke all on function public.revoke_member_shares(uuid, uuid, text) from public;
revoke all on function public.list_my_credential_shares() from public;
revoke all on function public.read_space_credential_for_spawn(uuid, text, uuid) from public;

grant execute on function public.share_personal_token(uuid, text) to tm8_app;
grant execute on function public.start_space_credential_share_login(uuid, text, text, integer, integer) to tm8_app;
grant execute on function public.delete_space_credential(uuid) to tm8_app;
grant execute on function public.revoke_member_shares(uuid, uuid, text) to tm8_app;
grant execute on function public.list_my_credential_shares() to tm8_app;
grant execute on function public.read_space_credential_for_spawn(uuid, text, uuid) to tm8_app;

reset role;
