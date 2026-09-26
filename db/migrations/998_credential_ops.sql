-- =============================================================================
-- 998 (PLACEHOLDER NUMBER) — credential operations, W10b (task 01a0da8c,
-- doc 13 01a0da24 §3b-§3e, §3g, §5, §6c, §8; threat review 01a0db1c Part 2).
--
-- Runs after 996_credential_entities (W10a) and 997 (W10c). The merge
-- coordinator assigns the real number (order a, c, b) and the sweep.test.ts
-- pin is re-measured at that merge position.
--
-- Builds on 996; nothing there is duplicated. What lands here:
--
--   1. R12 / §3c: `can_manage_space_credential` narrows. An OWNED credential
--      (private or public) is edited by its owner alone; a space-owned one by
--      its creator or a space admin (D11, as today). Every 206 writer that
--      goes through `lock_managed_space_credential` — rekey, rename, probe,
--      relogin, set the space default — follows. Revoke is wider: the manager
--      or ANY space admin (§3c), and so is the live-session list revoke's
--      step 2 reads.
--   2. §3b / E1: create takes a visibility, or space-owned. A create that
--      names neither keeps 206's contract (space-owned, public) and stays
--      claimable by its creator, exactly like a migrated row.
--   3. §3e / T9: the space default is only ever an eligible credential —
--      public and (space-owned, or owned with the owner's consent). The
--      automatic first-credential default skips an ineligible one.
--   4. New writers, each human-only: claim, the space-default consent, my
--      default (member_defaults, 996's table), usage.
--   5. §6c: `session_space_credentials.source` — how the launch picked the
--      credential (pinned, my_default, space_default) — stamped from the
--      manifest by a trigger, so 996's recorder body is not copied.
--   6. R8: a node-admin sweep reader listing every live session whose recorded
--      credential is revoked, or private and launched by someone else. The
--      server's post-boot re-check and periodic job kill what it lists.
--   7. R13: repoint takes the providers the resume resolved and drops the
--      rows of every other one, in the same transaction as the re-point.
--   8. The narrow login-home scrub's reader: the non-owner launches on a
--      PRIVATE login credential whose data can be attributed to that launch
--      alone. The server deletes those files; SQL only names the sessions.
--
-- ADDITIVE ONLY: no statement here rewrites or deletes an existing row. The
-- two new columns arrive through their defaults (false / null).
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Columns.
-- -----------------------------------------------------------------------------

-- True only when a creator CHOSE space-owned (E1) at create. A space-owned row
-- without the choice — every migrated row, and any create that named neither
-- visibility nor spaceOwned — may be claimed by its creator (§8).
alter table public.space_credentials
  add column space_owned_chosen boolean not null default false;
grant select (space_owned_chosen) on public.space_credentials to tm8_app;

alter table public.session_space_credentials
  add column source text,
  add constraint session_space_credentials_source_check
    check (source is null or source in ('pinned', 'my_default', 'space_default'));
grant select (source) on public.session_space_credentials to tm8_app;

-- -----------------------------------------------------------------------------
-- 2. Who manages, who revokes (R12, §3c).
-- -----------------------------------------------------------------------------

-- Owned: the owner alone. Space-owned: the creator (while a member) or a
-- space admin (D11). An admin never edits an owned credential, so cannot
-- re-key it to their own secret under the owner's name (T12).
create or replace function internal.can_manage_space_credential(p_credential public.space_credentials)
returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.is_space_member(p_credential.space_id)
     and case
           when p_credential.owner_account_id is not null
             then p_credential.owner_account_id = internal.current_account_id()
           else internal.is_space_admin(p_credential.space_id)
                or (p_credential.created_by_account_id is not null
                    and p_credential.created_by_account_id = internal.current_account_id())
         end
$$;

-- Revoke: the manager, or any space admin — private included (§3c).
create or replace function internal.can_revoke_space_credential(p_credential public.space_credentials)
returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.is_space_member(p_credential.space_id)
     and (internal.is_space_admin(p_credential.space_id)
          or internal.can_manage_space_credential(p_credential))
$$;

-- 206 body; the refusal now says which rule refused.
create or replace function internal.lock_managed_space_credential(p_credential_id uuid)
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
    if stored.owner_account_id is not null then
      raise exception 'only the credential''s owner can change it; a space admin can revoke it'
        using errcode = '42501';
    end if;
    raise exception 'only the credential''s creator or a space admin can change it'
      using errcode = '42501';
  end if;
  return stored;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. Revoke (206 body): FOR UPDATE, then the revoke-wide check. The member
--    defaults naming it go in the same statement's transaction.
-- -----------------------------------------------------------------------------
create or replace function public.delete_space_credential(p_credential_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  stored public.space_credentials;
  was_revoked boolean;
begin
  perform internal.require_human_auth_kind();
  select * into stored from public.space_credentials
   where id = p_credential_id for update;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if not internal.can_revoke_space_credential(stored) then
    raise exception 'only the credential''s owner or a space admin can revoke it'
      using errcode = '42501';
  end if;
  was_revoked := stored.status = 'revoked';
  if not was_revoked then
    update public.space_credentials
       set status = 'revoked',
           is_default = false,
           may_be_space_default = false,
           pending_expires_at = null,
           secret_ciphertext = null,
           secret_nonce = null
     where id = stored.id returning * into stored;
    delete from public.member_defaults where credential_id = stored.id;
  end if;
  return internal.space_credential_json(stored) || jsonb_build_object('revoked', not was_revoked);
end
$$;

-- 206 body; readable by whoever may revoke (revoke's step 2).
create or replace function public.space_credential_live_sessions(p_credential_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  stored public.space_credentials;
  sessions jsonb;
  logins jsonb;
begin
  perform internal.require_human_auth_kind();
  select * into stored from public.space_credentials where id = p_credential_id;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if not internal.can_revoke_space_credential(stored) then
    raise exception 'only the credential''s owner or a space admin can revoke it'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'workSessionId', ssc.work_session_id, 'provider', ssc.provider,
           'launcherAccountId', ssc.launcher_account_id, 'status', ws.status)
           order by ssc.work_session_id), '[]'::jsonb)
    into sessions
    from public.session_space_credentials ssc
    join public.work_sessions ws on ws.entity_id = ssc.work_session_id
   where ssc.space_credential_id = p_credential_id
     and ws.status in ('spawning', 'running', 'idle');

  select coalesce(jsonb_agg(jsonb_build_object(
           'workSessionId', cs.work_session_id, 'accountId', cs.account_id,
           'expiresAt', cs.expires_at)
           order by cs.work_session_id), '[]'::jsonb)
    into logins
    from public.credential_sessions cs
   where cs.space_credential_id = p_credential_id
     and cs.finished_at is null;

  return jsonb_build_object('credentialId', p_credential_id,
                            'sessions', sessions, 'loginTerminals', logins);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. The space default (§3e, T9).
-- -----------------------------------------------------------------------------

-- 206 body, plus eligibility: an owned credential without its owner's consent,
-- or a private one, never becomes the default by being first.
create or replace function internal.default_space_credential_if_none(p_credential_id uuid)
returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare target public.space_credentials;
begin
  select * into target from public.space_credentials where id = p_credential_id;
  if target.status <> 'active' then return; end if;
  if not (target.visibility = 'public'
          and (target.owner_account_id is null or target.may_be_space_default)) then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target.space_id::text || '|' || target.provider, 206));
  if not exists (select 1 from public.space_credentials
                  where space_id = target.space_id and provider = target.provider
                    and is_default and status = 'active') then
    update public.space_credentials set is_default = true where id = p_credential_id;
  end if;
end
$$;

-- setSpaceDefault (§8): a space-owned credential by its managers; an owned
-- one only once its owner opted in, then by the owner or any admin. The
-- default slot is taken before the row (B1).
create or replace function public.set_space_credential_default(p_credential_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  perform internal.lock_space_credential_default_slot(p_credential_id);
  select * into stored from public.space_credentials where id = p_credential_id for update;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if stored.owner_account_id is null then
    if not internal.can_manage_space_credential(stored) then
      raise exception 'only the credential''s creator or a space admin can change it'
        using errcode = '42501';
    end if;
  else
    if stored.visibility <> 'public' or not stored.may_be_space_default then
      raise exception 'only a public credential whose owner allowed it can be the space default'
        using errcode = '23514',
              detail = jsonb_build_object('reason', 'not_eligible')::text;
    end if;
    if not (stored.owner_account_id = internal.current_account_id()
            or internal.is_space_admin(stored.space_id)) then
      raise exception 'only the credential''s owner or a space admin can make it the space default'
        using errcode = '42501';
    end if;
  end if;
  if stored.status <> 'active' then
    raise exception 'only an active credential can be the default' using errcode = '23514';
  end if;
  update public.space_credentials set is_default = false
   where space_id = stored.space_id and provider = stored.provider
     and is_default and id <> stored.id;
  update public.space_credentials set is_default = true
   where id = stored.id returning * into stored;
  return internal.space_credential_json(stored);
end
$$;

-- The owner's consent (§3e). Withdrawing it while the credential IS the space
-- default clears the default in the same statement. FOR UPDATE, after the
-- default slot (B1).
create or replace function public.set_space_credential_default_consent(p_credential_id uuid, p_allowed boolean)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  if p_allowed is null then
    raise exception 'allowed is true or false' using errcode = '22023';
  end if;
  perform internal.lock_space_credential_default_slot(p_credential_id);
  select * into stored from public.space_credentials where id = p_credential_id for update;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if stored.owner_account_id is null then
    raise exception 'a space-owned credential needs no consent to be the space default' using errcode = '22023';
  end if;
  if stored.owner_account_id is distinct from internal.current_account_id() then
    raise exception 'only the credential''s owner can allow it to be the space default' using errcode = '42501';
  end if;
  if stored.status = 'revoked' then
    raise exception 'space credential is revoked' using errcode = '23514';
  end if;
  if p_allowed and stored.visibility <> 'public' then
    raise exception 'only a public credential can be the space default; make it public first'
      using errcode = '23514', detail = jsonb_build_object('reason', 'not_eligible')::text;
  end if;
  update public.space_credentials
     set may_be_space_default = p_allowed,
         is_default = case when p_allowed then is_default else false end
   where id = stored.id
  returning * into stored;
  return internal.space_credential_json(stored);
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Create (§3b, E1, E2). 206/996 body, plus who owns it. Exactly one of
--    p_visibility and p_space_owned; neither keeps 206's space-owned public
--    contract, claimable by its creator.
-- -----------------------------------------------------------------------------
drop function public.create_space_credential(uuid, uuid, text, text, text, text, bytea, bytea, text);

create function public.create_space_credential(
  p_credential_id uuid,
  p_space_id uuid,
  p_provider text,
  p_shape text,
  p_label text,
  p_key_hint text,
  p_secret_ciphertext bytea,
  p_secret_nonce bytea,
  p_display_login text default null,
  p_visibility text default null,
  p_space_owned boolean default null,
  p_may_be_space_default boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_account_id uuid;
  v_owner uuid;
  v_visibility text;
  v_chosen boolean;
  stored public.space_credentials;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);
  v_account_id := internal.current_account_id();
  if v_account_id is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_credential_id is null then
    raise exception 'a credential id is required: the seal is bound to it' using errcode = '22023';
  end if;
  if p_shape is null or p_shape not in ('api_key', 'token') then
    raise exception 'create_space_credential takes an api_key or token; a login starts with start_space_credential_login'
      using errcode = '22023';
  end if;
  if p_visibility is not null and p_visibility not in ('private', 'public') then
    raise exception 'visibility is private or public' using errcode = '22023';
  end if;
  if coalesce(p_space_owned, false) and p_visibility is not null then
    raise exception 'a credential is either space-owned or has a visibility, not both' using errcode = '22023';
  end if;

  if coalesce(p_space_owned, false) then
    v_owner := null; v_visibility := 'public'; v_chosen := true;
  elsif p_visibility is not null then
    v_owner := v_account_id; v_visibility := p_visibility; v_chosen := false;
  else
    v_owner := null; v_visibility := 'public'; v_chosen := false;
  end if;
  if coalesce(p_may_be_space_default, false) and (v_owner is null or v_visibility <> 'public') then
    raise exception 'only an owned public credential takes the space-default consent' using errcode = '22023';
  end if;

  if exists (select 1 from public.entities where id = p_credential_id) then
    raise exception 'credential id is already in use' using errcode = '23505';
  end if;
  perform internal.insert_credential_entity(p_credential_id, p_space_id,
                                            internal.current_member_id(p_space_id));

  insert into public.space_credentials(
    id, space_id, provider, shape, label, status,
    created_by_account_id, created_by_identity_id, display_login,
    key_hint, secret_ciphertext, secret_nonce, last_probe_at,
    owner_account_id, visibility, may_be_space_default, space_owned_chosen
  ) values (
    p_credential_id, p_space_id, p_provider, p_shape, internal.require_space_credential_label(p_label), 'active',
    v_account_id, internal.identity_id(), nullif(btrim(p_display_login), ''),
    p_key_hint, p_secret_ciphertext, p_secret_nonce, now(),
    v_owner, v_visibility, coalesce(p_may_be_space_default, false), v_chosen
  ) returning * into stored;

  perform internal.default_space_credential_if_none(stored.id);
  select * into stored from public.space_credentials where id = stored.id;
  return internal.space_credential_json(stored);
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Claim (§8): the creator of a space-owned row nobody chose to make
--    space-owned (a migrated row) takes ownership. Visibility is unchanged; a
--    row that is the space default keeps it, with the claimant's consent
--    recorded, so nobody's automatic launch moves bill by the claim.
-- -----------------------------------------------------------------------------
create or replace function public.claim_space_credential(p_credential_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; v_account_id uuid;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  select * into stored from public.space_credentials where id = p_credential_id for update;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if stored.owner_account_id is not null then
    raise exception 'space credential already has an owner' using errcode = '23514',
      detail = jsonb_build_object('reason', 'owned')::text;
  end if;
  if stored.space_owned_chosen then
    raise exception 'a credential created as space-owned cannot be claimed' using errcode = '23514',
      detail = jsonb_build_object('reason', 'space_owned')::text;
  end if;
  if v_account_id is null or stored.created_by_account_id is distinct from v_account_id then
    raise exception 'only the credential''s creator can claim it' using errcode = '42501';
  end if;
  if stored.status = 'revoked' then
    raise exception 'space credential is revoked' using errcode = '23514';
  end if;
  update public.space_credentials
     set owner_account_id = v_account_id,
         may_be_space_default = is_default
   where id = stored.id
  returning * into stored;
  return internal.space_credential_json(stored);
end
$$;

-- -----------------------------------------------------------------------------
-- 7. My default (§3e): one per (space, account, provider), chosen from the
--    caller's own credentials (996's trigger enforces owned and live).
-- -----------------------------------------------------------------------------
create or replace function public.set_my_space_credential_default(p_credential_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; v_account_id uuid;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  select * into stored from public.space_credentials where id = p_credential_id for share;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if v_account_id is null or stored.owner_account_id is distinct from v_account_id then
    raise exception 'your default must be a credential you own' using errcode = '42501';
  end if;
  if stored.status <> 'active' then
    raise exception 'only an active credential can be your default' using errcode = '23514';
  end if;
  insert into public.member_defaults(space_id, account_id, provider, credential_id)
  values (stored.space_id, v_account_id, stored.provider, stored.id)
  on conflict (space_id, account_id, provider)
  do update set credential_id = excluded.credential_id, updated_at = now();
  return jsonb_build_object('spaceId', stored.space_id, 'provider', stored.provider,
                            'credentialId', stored.id);
end
$$;

create or replace function public.clear_my_space_credential_default(p_space_id uuid, p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_account_id uuid; removed integer;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);
  v_account_id := internal.current_account_id();
  delete from public.member_defaults
   where space_id = p_space_id and account_id = v_account_id and provider = p_provider;
  get diagnostics removed = row_count;
  return jsonb_build_object('spaceId', p_space_id, 'provider', p_provider,
                            'credentialId', null, 'cleared', removed > 0);
end
$$;

-- The auto rung's lookup (§3e): the launcher's own default, if it is active.
-- Not human-only: an agent's claims are its root human launcher's, so its
-- auto launch finds that human's default. The reader then reads it as a
-- pinned id, so every reader check runs again.
create or replace function public.my_space_credential_default_id(p_space_id uuid, p_provider text)
returns uuid
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v_id uuid;
begin
  perform internal.require_space_member(p_space_id);
  select md.credential_id into v_id
    from public.member_defaults md
    join public.space_credentials sc on sc.id = md.credential_id
   where md.space_id = p_space_id
     and md.account_id = internal.current_account_id()
     and md.provider = p_provider
     and sc.status = 'active';
  return v_id;
end
$$;

-- -----------------------------------------------------------------------------
-- 8. Usage (§6c): the owner; admins too for public and space-owned.
-- -----------------------------------------------------------------------------
create or replace function public.space_credential_usage(p_credential_id uuid, p_limit integer default 100)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; rows jsonb;
begin
  perform internal.require_human_auth_kind();
  select * into stored from public.space_credentials where id = p_credential_id;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if not (stored.owner_account_id = internal.current_account_id()
          or ((stored.visibility = 'public' or stored.owner_account_id is null)
              and internal.is_space_admin(stored.space_id))) then
    raise exception 'only the credential''s owner can see its usage' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(u.row order by u.recorded_at desc, u.work_session_id), '[]'::jsonb) into rows
    from (
      select ssc.recorded_at, ssc.work_session_id,
             jsonb_build_object(
               'workSessionId', ssc.work_session_id, 'provider', ssc.provider,
               'source', ssc.source, 'credentialId', ssc.space_credential_id,
               'ownerAccountId', ssc.owner_account_id,
               'launcherAccountId', ssc.launcher_account_id,
               'agentSessionId', ssc.agent_session_id, 'status', ws.status,
               'recordedAt', ssc.recorded_at, 'updatedAt', ssc.updated_at) as row
        from public.session_space_credentials ssc
        join public.work_sessions ws on ws.entity_id = ssc.work_session_id
       where ssc.space_credential_id = stored.id
       order by ssc.recorded_at desc, ssc.work_session_id
       limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) u;
  return jsonb_build_object('credentialId', stored.id, 'sessions', rows);
end
$$;

-- -----------------------------------------------------------------------------
-- 9. §6c source: stamped from the manifest the recorder is writing (206's
--    record_session_manifest stores the manifest before it records). An
--    unknown value is left null rather than failing a launch over an audit.
-- -----------------------------------------------------------------------------
create or replace function internal.stamp_session_space_credential_source() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_pick text;
begin
  if new.source is null then
    select m.manifest #>> array['launch', 'spaceCredentialPicks', new.provider] into v_pick
      from public.session_manifests m where m.work_session_id = new.work_session_id;
    if v_pick in ('pinned', 'my_default', 'space_default') then
      new.source := v_pick;
    end if;
  end if;
  return new;
end
$$;

create trigger session_space_credentials_stamp_source
before insert on public.session_space_credentials
for each row execute function internal.stamp_session_space_credential_source();

-- -----------------------------------------------------------------------------
-- 10. R8: the sweep reader. Node admin only (the server's own sweep claims).
--     Every live session whose recorded credential is revoked, or private and
--     launched by anyone but its owner. The kill is the server's; SQL cannot
--     reach a PTY.
-- -----------------------------------------------------------------------------
create or replace function public.sweep_unusable_space_credential_sessions(p_limit integer default 200)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare rows jsonb;
begin
  if not internal.is_node_admin() then
    raise exception 'node admin required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(u.row order by u.work_session_id), '[]'::jsonb) into rows
    from (
      select distinct on (ssc.work_session_id) ssc.work_session_id,
             jsonb_build_object(
               'workSessionId', ssc.work_session_id, 'provider', ssc.provider,
               'credentialId', sc.id, 'status', ws.status,
               'reason', case when sc.status = 'revoked' then 'revoked' else 'private' end) as row
        from public.session_space_credentials ssc
        join public.space_credentials sc on sc.id = ssc.space_credential_id
        join public.work_sessions ws on ws.entity_id = ssc.work_session_id
       where ws.status in ('spawning', 'running', 'idle')
         and (sc.status = 'revoked'
              or (sc.visibility = 'private'
                  and ssc.launcher_account_id is distinct from sc.owner_account_id))
       order by ssc.work_session_id, ssc.provider
       limit least(greatest(coalesce(p_limit, 200), 1), 1000)
    ) u;
  return rows;
end
$$;

-- -----------------------------------------------------------------------------
-- 11. R13: repoint with the providers this resume resolved. Rows for any other
--     provider are dropped first — the session no longer runs on them, and a
--     stale row would keep naming the old launcher and credential — then 996's
--     re-point runs over what is left, in the same transaction.
-- -----------------------------------------------------------------------------
create or replace function public.repoint_session_space_credentials(p_work_session_id uuid, p_providers text[])
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare e public.entities;
begin
  e := internal.live_entity(p_work_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  if internal.current_account_id() is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  delete from public.session_space_credentials
   where work_session_id = p_work_session_id
     and provider <> all (coalesce(p_providers, array[]::text[]));
  return public.repoint_session_space_credentials(p_work_session_id);
end
$$;

-- -----------------------------------------------------------------------------
-- 11b. The narrow login-home scrub (lead ruling on R1/R17, 2026-09-26). A
--     login credential's home is shared and is the only store of the login,
--     so it is never removed; what goes on switch-to-private is only a
--     NON-OWNER launch's own transcript. The owner reads this list for their
--     own private login credential and nothing else.
--
--     ATTRIBUTION IS CONSERVATIVE: a row counts only when it was never
--     re-pointed (updated_at = recorded_at). 996's recorder inserts once at
--     spawn and every resume re-points with updated_at = now(), so an
--     untouched row names the ONE human who ever ran the session. A session
--     the owner launched and someone else resumed (or the reverse) was
--     re-pointed and is left alone: its transcript is not attributable to a
--     non-owner launch. Live sessions are left too; the file is still open.
-- -----------------------------------------------------------------------------
create or replace function public.space_credential_foreign_launches(p_credential_id uuid, p_limit integer default 500)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; rows jsonb;
begin
  perform internal.require_human_auth_kind();
  select * into stored from public.space_credentials where id = p_credential_id;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if stored.owner_account_id is distinct from internal.current_account_id() then
    raise exception 'only the credential''s owner can scrub its login home' using errcode = '42501';
  end if;
  if stored.shape <> 'login' or stored.visibility <> 'private' or stored.status <> 'active' then
    return '[]'::jsonb;
  end if;
  select coalesce(jsonb_agg(u.row order by u.work_session_id), '[]'::jsonb) into rows
    from (
      select ssc.work_session_id,
             jsonb_build_object(
               'workSessionId', ssc.work_session_id, 'provider', ssc.provider,
               'nativeSessionId', ws.native_session_id) as row
        from public.session_space_credentials ssc
        join public.work_sessions ws on ws.entity_id = ssc.work_session_id
       where ssc.space_credential_id = stored.id
         and ssc.launcher_account_id is not null
         and ssc.launcher_account_id <> stored.owner_account_id
         and ssc.updated_at = ssc.recorded_at
         and ws.status in ('exited', 'failed')
       order by ssc.work_session_id
       limit least(greatest(coalesce(p_limit, 500), 1), 500)
    ) u;
  return rows;
end
$$;

-- -----------------------------------------------------------------------------
-- 12. Grants.
-- -----------------------------------------------------------------------------
revoke all on function internal.can_revoke_space_credential(public.space_credentials) from public;
revoke all on function internal.stamp_session_space_credential_source() from public;

revoke all on function public.create_space_credential(uuid, uuid, text, text, text, text, bytea, bytea, text, text, boolean, boolean) from public;
revoke all on function public.set_space_credential_default_consent(uuid, boolean) from public;
revoke all on function public.claim_space_credential(uuid) from public;
revoke all on function public.set_my_space_credential_default(uuid) from public;
revoke all on function public.clear_my_space_credential_default(uuid, text) from public;
revoke all on function public.my_space_credential_default_id(uuid, text) from public;
revoke all on function public.space_credential_usage(uuid, integer) from public;
revoke all on function public.sweep_unusable_space_credential_sessions(integer) from public;
revoke all on function public.repoint_session_space_credentials(uuid, text[]) from public;
revoke all on function public.space_credential_foreign_launches(uuid, integer) from public;

grant execute on function public.create_space_credential(uuid, uuid, text, text, text, text, bytea, bytea, text, text, boolean, boolean) to tm8_app;
grant execute on function public.set_space_credential_default_consent(uuid, boolean) to tm8_app;
grant execute on function public.claim_space_credential(uuid) to tm8_app;
grant execute on function public.set_my_space_credential_default(uuid) to tm8_app;
grant execute on function public.clear_my_space_credential_default(uuid, text) to tm8_app;
grant execute on function public.my_space_credential_default_id(uuid, text) to tm8_app;
grant execute on function public.space_credential_usage(uuid, integer) to tm8_app;
grant execute on function public.sweep_unusable_space_credential_sessions(integer) to tm8_app;
grant execute on function public.repoint_session_space_credentials(uuid, text[]) to tm8_app;
grant execute on function public.space_credential_foreign_launches(uuid, integer) to tm8_app;

reset role;
