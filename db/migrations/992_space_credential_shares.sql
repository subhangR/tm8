-- =============================================================================
-- 992 (PLACEHOLDER NUMBER) — share a private space credential with one member
-- of the same space (task 01a10201, story Space credentials 01a0fe4b; interface
-- docs/credentials/space-credential-share.md). The merge coordinator assigns
-- the real number at its train position.
--
-- Builds on 239 (owner + visibility, the usability gate), 255 (writers, the R8
-- sweep, repoint with providers) and 281 (the spawn reader's current body).
-- What lands here:
--
--   1. public.space_credential_shares: (credential, grantee account) rows on a
--      PRIVATE owned credential, bound to the credential's space by a
--      composite FK. Read and written only through the definers below.
--   2. internal.space_credential_shared_with(credential, account): the share
--      exists AND the grantee is still an active member of the credential's
--      space. A membership that ended leaves an inert row (and section 7
--      deletes it anyway).
--   3. "Usable by the launcher" (239 §9) gains `or shared with the launcher`
--      everywhere it is decided: the spawn reader, usable_space_credential_ids,
--      the recorder, repoint, the R8 sweep and set_space_credential_visibility's
--      kill list. The ladder is unchanged: pinned -> my_default ->
--      space_default -> refuse; no node rung is added, and a share never
--      leaves its space (the reader still requires the credential in the
--      LAUNCH space, and the share row carries that space).
--   4. my_default may name a credential shared with the caller (the grantee's
--      ladder), as well as one they own.
--   5. share / unshare / list RPCs. Share: the owner only, human only, to an
--      ACTIVE member of the credential's space other than the owner. Unshare:
--      the owner or any space admin (revoke is wider, as 255 §2); it drops the
--      grantee's my_default on it and returns the grantee's live sessions on
--      it as `killSessions` — the caller kills them exactly as for
--      set_space_credential_visibility, and the R8 sweep is the backstop.
--   6. The card JSON gains `sharedWithMe`. The hint and the vendor login stay
--      masked for a grantee (may_see_space_credential_detail is unchanged).
--   7. A membership that ends deletes that account's shares in that space,
--      and its my_default on any credential it does not own there.
--
-- WHAT DOES NOT CHANGE. The stream attach gate (257) stays OWNER-only: a
-- grantee's agent runs on the credential, but the grantee cannot attach a
-- terminal to it and read its environment. No secret column is granted.
--
-- ADDITIVE ONLY: a new table and function bodies; no existing row is written.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The table.
-- -----------------------------------------------------------------------------
create table public.space_credential_shares (
  credential_id         uuid not null,
  space_id              uuid not null,
  grantee_account_id    uuid not null references public.accounts(id) on delete cascade,
  granted_by_account_id uuid references public.accounts(id) on delete set null,
  created_at            timestamptz not null default now(),
  primary key (credential_id, grantee_account_id),
  constraint space_credential_shares_credential_fk
    foreign key (credential_id, space_id)
    references public.space_credentials(id, space_id) on delete cascade
);

create index space_credential_shares_grantee_idx
  on public.space_credential_shares(grantee_account_id, space_id);

-- No policy and no grant: tm8_app reaches it only through the definers below.
alter table public.space_credential_shares enable row level security;

-- -----------------------------------------------------------------------------
-- 2. The predicate.
-- -----------------------------------------------------------------------------
create or replace function internal.space_credential_shared_with(p_credential_id uuid, p_account_id uuid)
returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select p_account_id is not null and exists (
    select 1
      from public.space_credential_shares s
      join public.accounts a on a.id = s.grantee_account_id and a.status = 'active'
      join public.members m on m.identity_id = a.identity_id
                           and m.space_id = s.space_id
                           and m.status = 'active'
     where s.credential_id = p_credential_id
       and s.grantee_account_id = p_account_id)
$$;

revoke all on function internal.space_credential_shared_with(uuid, uuid) from public;

-- -----------------------------------------------------------------------------
-- 3. The card: 239's body plus `sharedWithMe`. The hint and login stay masked.
-- -----------------------------------------------------------------------------
create or replace function internal.space_credential_json(p public.space_credentials)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'spaceId', p.space_id, 'provider', p.provider, 'shape', p.shape,
    'label', p.label, 'isDefault', p.is_default, 'status', p.status,
    'createdByAccountId', p.created_by_account_id,
    'ownerAccountId', p.owner_account_id, 'visibility', p.visibility,
    'mayBeSpaceDefault', p.may_be_space_default,
    'sharedWithMe', internal.space_credential_shared_with(p.id, internal.current_account_id()),
    'displayLogin', case when internal.may_see_space_credential_detail(p) then p.display_login end,
    'keyHint', case when internal.may_see_space_credential_detail(p) then p.key_hint end,
    'pendingExpiresAt', p.pending_expires_at,
    'createdAt', p.created_at, 'updatedAt', p.updated_at,
    'lastUsedAt', p.last_used_at, 'lastProbeAt', p.last_probe_at)
$$;

-- -----------------------------------------------------------------------------
-- 4. The gate. Every body is its latest one with the predicate widened.
-- -----------------------------------------------------------------------------

-- 239 body.
create or replace function public.usable_space_credential_ids(p_credential_ids uuid[])
returns uuid[]
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v_launcher uuid; ids uuid[];
begin
  v_launcher := internal.current_account_id();
  if v_launcher is null then
    return array[]::uuid[];
  end if;
  select coalesce(array_agg(sc.id order by sc.id), array[]::uuid[]) into ids
    from public.space_credentials sc
   where sc.id = any(coalesce(p_credential_ids, array[]::uuid[]))
     and sc.space_id = any ((select internal.member_space_ids())::uuid[])
     and sc.status = 'active'
     and (sc.visibility = 'public' or sc.owner_account_id is null or sc.owner_account_id = v_launcher
          or internal.space_credential_shared_with(sc.id, v_launcher));
  return ids;
end
$$;

-- 281 body.
create or replace function public.read_space_credential_for_spawn(
  p_launch_space_id uuid,
  p_provider text,
  p_credential_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; v_launcher uuid;
begin
  -- gate 8: a server-only provider is never handed to a launch, for any
  -- caller, pinned or default. Refused before anything is read.
  if internal.is_server_only_credential_provider(p_provider) then
    raise exception '% is a server-only credential and never reaches a session', p_provider
      using errcode = '42501',
      detail = jsonb_build_object('reason', 'server_only', 'provider', p_provider)::text;
  end if;

  -- 277 (W7b): a link session's own claims read a spawn credential only WITH
  -- its link claim, and then take the link admission below like its children
  -- do: the target's DEFAULT credential only, while its own row is signed in
  -- with spawning allowed. Was 256/271's unconditional refusal.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link'
     and internal.claim_text('tm8.via_link') is null then
    raise exception 'a space link session cannot read a spawn credential' using errcode = '42501';
  end if;
  perform internal.require_space_member(p_launch_space_id);
  v_launcher := internal.current_account_id();

  -- W7p: a link-bound caller gets the target's DEFAULT credential only, and
  -- only while its own row for this link and target is signed in with
  -- spawning allowed. A pinned id, a missing row or a switched-off link: 42501.
  if internal.link_bound() then
    if p_credential_id is not null or not exists (
      select 1
        from public.space_link_tokens t
        join public.members m on m.entity_id = t.member_id
        join public.entities e on e.id = t.link_id
       where t.link_id = internal.claim_text('tm8.via_link')::uuid
         and m.identity_id = internal.identity_id()
         and m.status = 'active'
         and e.deleted_at is null
         and t.target_space_id = p_launch_space_id
         and t.status = 'signed_in'
         and t.allow_spawn
    ) then
      raise exception 'a space link spawn uses only this space''s default credential, while the link is signed in with spawning allowed'
        using errcode = '42501';
    end if;
  end if;

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

  -- The space default is public by constraint, so this only ever refuses a
  -- pinned id; it is checked for both anyway. 992: or shared with the launcher.
  if not (stored.visibility = 'public' or stored.owner_account_id is null
          or stored.owner_account_id = v_launcher
          or internal.space_credential_shared_with(stored.id, v_launcher)) then
    raise exception 'space credential "%" is private to its owner', stored.label using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_usable', 'provider', p_provider)::text;
  end if;

  update public.space_credentials set last_used_at = now()
   where id = stored.id;

  return jsonb_build_object(
    'credentialId', stored.id,
    'spaceId', stored.space_id,
    'provider', stored.provider,
    'shape', stored.shape,
    'label', stored.label,
    'displayLogin', stored.display_login,
    'secretCiphertext', case when stored.shape = 'login' then null else encode(stored.secret_ciphertext, 'base64') end,
    'secretNonce', case when stored.shape = 'login' then null else encode(stored.secret_nonce, 'base64') end
  );
end
$$;

revoke all on function public.read_space_credential_for_spawn(uuid, text, uuid) from public;
grant execute on function public.read_space_credential_for_spawn(uuid, text, uuid) to tm8_app;

-- 239 body. The share is read under the credential's FOR SHARE lock, and
-- unshare takes FOR UPDATE on the credential first, so the two serialise.
create or replace function internal.record_session_space_credential(
  p_work_session_id uuid,
  p_provider text,
  p_credential_id uuid
) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_launcher uuid;
  inserted integer;
  v_session_space uuid;
  v_session_status text;
  v_credential public.space_credentials;
  v_usable uuid;
begin
  v_launcher := internal.current_account_id();
  if v_launcher is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  select sc.id into v_usable
    from public.space_credentials sc
   where sc.id = p_credential_id
     and sc.provider = p_provider
     and sc.status = 'active'
     and (sc.visibility = 'public' or sc.owner_account_id is null or sc.owner_account_id = v_launcher
          or internal.space_credential_shared_with(sc.id, v_launcher))
     for share of sc;
  if v_usable is null then
    select e.space_id into v_session_space
      from public.entities e where e.id = p_work_session_id and e.deleted_at is null;
    select * into v_credential from public.space_credentials where id = p_credential_id;
    if v_credential.id is null or v_credential.space_id is distinct from v_session_space
       or v_credential.provider is distinct from p_provider then
      raise exception 'space credential is not in this session''s space' using errcode = '42501';
    end if;
    if v_credential.status <> 'active' then
      raise exception 'space credential is %', v_credential.status using errcode = '23514';
    end if;
    raise exception 'space credential "%" is private to its owner', v_credential.label
      using errcode = '42501',
            detail = jsonb_build_object('reason', 'not_usable', 'provider', p_provider)::text;
  end if;

  -- A2: a retried manifest write (a timed-out write may have committed)
  -- must not fail a spawn that succeeded. The identical row is a no-op;
  -- a DIFFERENT credential for the provider is refused below.
  if exists (select 1 from public.session_space_credentials
              where work_session_id = p_work_session_id and provider = p_provider
                and space_credential_id = p_credential_id) then
    return;
  end if;

  begin
    insert into public.session_space_credentials(
      work_session_id, provider, space_credential_id, space_id, launcher_account_id,
      owner_account_id, agent_session_id)
    select ws.entity_id, sc.provider, sc.id, sc.space_id, v_launcher,
           sc.owner_account_id,
           (select pws.entity_id from public.work_sessions pws
             where pws.entity_id = e.parent_id)
      from public.space_credentials sc
      join public.entities e on e.space_id = sc.space_id
      join public.work_sessions ws on ws.entity_id = e.id
     where sc.id = p_credential_id
       and sc.provider = p_provider
       and sc.status = 'active'
       and (sc.visibility = 'public' or sc.owner_account_id is null or sc.owner_account_id = v_launcher
            or internal.space_credential_shared_with(sc.id, v_launcher))
       and e.id = p_work_session_id
       and e.kind = 'work_session'
       and e.deleted_at is null
       and ws.status = 'spawning'
       and ws.session_kind = 'agent'
       for share of sc;
    get diagnostics inserted = row_count;
  exception when unique_violation then
    raise exception 'session already records a different % space credential', p_provider
      using errcode = '23505';
  end;

  if inserted = 1 then
    return;
  end if;

  -- Nothing inserted: say which condition failed. These reads only explain a
  -- refusal the insert above already made; they decide nothing.
  select e.space_id, ws.status into v_session_space, v_session_status
    from public.entities e join public.work_sessions ws on ws.entity_id = e.id
   where e.id = p_work_session_id and e.deleted_at is null;
  select * into v_credential from public.space_credentials where id = p_credential_id;
  if v_credential.id is null or v_credential.space_id is distinct from v_session_space
     or v_credential.provider is distinct from p_provider then
    raise exception 'space credential is not in this session''s space' using errcode = '42501';
  end if;
  if v_session_status is distinct from 'spawning' then
    raise exception 'a space credential is recorded only while a session is spawning'
      using errcode = '23514';
  end if;
  -- 992: the insert's own (newer) snapshot no longer saw a share the lock
  -- statement did — it was withdrawn while this launch waited.
  if v_credential.status = 'active' then
    raise exception 'space credential "%" is private to its owner', v_credential.label
      using errcode = '42501',
            detail = jsonb_build_object('reason', 'not_usable', 'provider', p_provider)::text;
  end if;
  raise exception 'space credential is %', v_credential.status using errcode = '23514';
end
$$;

revoke all on function internal.record_session_space_credential(uuid, text, uuid) from public;

-- 239 body (255's two-argument repoint calls this one).
create or replace function public.repoint_session_space_credentials(p_work_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  v_launcher uuid;
  v_recorded integer;
  v_active integer;
  v_usable integer;
  rows jsonb;
begin
  e := internal.live_entity(p_work_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  v_launcher := internal.current_account_id();
  if v_launcher is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;

  select count(*) into v_recorded from public.session_space_credentials
   where work_session_id = p_work_session_id;
  select count(*) into v_active
    from (
    select sc.id from public.space_credentials sc
      join public.session_space_credentials ssc on ssc.space_credential_id = sc.id
     where ssc.work_session_id = p_work_session_id
       and sc.status = 'active'
       and sc.space_id = e.space_id
     order by sc.id
       for share of sc
  ) locked;
  -- 992: usability is read in a NEW statement, after the FOR SHARE locks are
  -- held. unshare takes FOR UPDATE on the credential but rewrites no tuple,
  -- so a statement that waited behind it would still see the withdrawn share
  -- in its own snapshot; this one starts after that commit.
  select count(*) into v_usable
    from public.space_credentials sc
    join public.session_space_credentials ssc on ssc.space_credential_id = sc.id
   where ssc.work_session_id = p_work_session_id
     and sc.status = 'active'
     and sc.space_id = e.space_id
     and (sc.visibility = 'public' or sc.owner_account_id is null
          or sc.owner_account_id = v_launcher
          or internal.space_credential_shared_with(sc.id, v_launcher));
  if v_active <> v_recorded then
    raise exception 'a space credential this session launched on is no longer active'
      using errcode = '23514';
  end if;
  if v_usable <> v_recorded then
    raise exception 'a space credential this session launched on is private to its owner'
      using errcode = '42501',
            detail = jsonb_build_object('reason', 'not_usable')::text;
  end if;

  update public.session_space_credentials
     set launcher_account_id = v_launcher, updated_at = now()
   where work_session_id = p_work_session_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'provider', provider, 'spaceCredentialId', space_credential_id)
           order by provider), '[]'::jsonb)
    into rows
    from public.session_space_credentials where work_session_id = p_work_session_id;
  return jsonb_build_object('workSessionId', p_work_session_id,
                            'launcherAccountId', v_launcher, 'credentials', rows);
end
$$;

-- 255 body. A grantee's session is usable while the share stands; once it is
-- withdrawn (or the grantee leaves the space) the sweep lists it as 'private'.
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
                  and ssc.launcher_account_id is distinct from sc.owner_account_id
                  and not internal.space_credential_shared_with(sc.id, ssc.launcher_account_id)))
       order by ssc.work_session_id, ssc.provider
       limit least(greatest(coalesce(p_limit, 200), 1), 1000)
    ) u;
  return rows;
end
$$;

-- 239 body. Going private kills the sessions of launchers who are neither the
-- owner nor a grantee; a grantee's sessions keep running.
create or replace function public.set_space_credential_visibility(p_credential_id uuid, p_visibility text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  stored public.space_credentials;
  v_account_id uuid;
  kill jsonb;
begin
  perform internal.require_human_auth_kind();
  if p_visibility is null or p_visibility not in ('private', 'public') then
    raise exception 'visibility is private or public' using errcode = '22023';
  end if;
  v_account_id := internal.current_account_id();
  select * into stored from public.space_credentials where id = p_credential_id for update;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if stored.owner_account_id is null then
    raise exception 'a space-owned credential is always public' using errcode = '22023';
  end if;
  if v_account_id is null or stored.owner_account_id <> v_account_id then
    raise exception 'only the credential''s owner can change its visibility' using errcode = '42501';
  end if;
  if stored.status = 'revoked' then
    raise exception 'space credential is revoked' using errcode = '23514';
  end if;

  update public.space_credentials
     set visibility = p_visibility,
         may_be_space_default = case when p_visibility = 'private' then false else may_be_space_default end,
         is_default = case when p_visibility = 'private' then false else is_default end
   where id = stored.id
  returning * into stored;

  select coalesce(jsonb_agg(jsonb_build_object(
           'workSessionId', ssc.work_session_id, 'provider', ssc.provider,
           'launcherAccountId', ssc.launcher_account_id, 'status', ws.status)
           order by ssc.work_session_id), '[]'::jsonb)
    into kill
    from public.session_space_credentials ssc
    join public.work_sessions ws on ws.entity_id = ssc.work_session_id
   where ssc.space_credential_id = stored.id
     and ws.status in ('spawning', 'running', 'idle')
     and stored.visibility = 'private'
     and ssc.launcher_account_id is distinct from stored.owner_account_id
     and not internal.space_credential_shared_with(stored.id, ssc.launcher_account_id);

  return internal.space_credential_json(stored) || jsonb_build_object('killSessions', kill);
end
$$;

-- -----------------------------------------------------------------------------
-- 5. My default: owned, or shared with the member (the grantee's ladder).
-- -----------------------------------------------------------------------------
create or replace function internal.guard_member_default() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if not exists (select 1 from public.space_credentials sc
                  where sc.id = new.credential_id
                    and sc.space_id = new.space_id
                    and sc.provider = new.provider
                    and (sc.owner_account_id = new.account_id
                         or internal.space_credential_shared_with(sc.id, new.account_id))
                    and sc.status <> 'revoked') then
    raise exception 'a member default must be a live credential the member owns or has been shared'
      using errcode = '23514';
  end if;
  return new;
end
$$;

-- 255 body.
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
  -- 992: FOR SHARE on the caller's own member row, as share_space_credential
  -- does for the grantee's: a membership end waits for this default to commit
  -- and its trigger then deletes it; one that committed first is seen here,
  -- and the share check below (a new statement) no longer finds the share.
  perform 1 from public.accounts a
    join public.members m on m.identity_id = a.identity_id
   where a.id = v_account_id and m.space_id = stored.space_id and m.status = 'active'
     for share of m;
  if not found then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if v_account_id is null
     or not (stored.owner_account_id is not distinct from v_account_id
             or internal.space_credential_shared_with(stored.id, v_account_id)) then
    raise exception 'your default must be a credential you own or that is shared with you' using errcode = '42501';
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

-- -----------------------------------------------------------------------------
-- 6. Share, unshare, list.
-- -----------------------------------------------------------------------------
-- The grantee, named by account id or by their member entity id in the
-- credential's space (members expose no account id to tm8_app). A member row
-- is resolved even after the membership ended, so a share can still be
-- withdrawn by the id the UI listed.
create or replace function internal.resolve_space_credential_grantee(p_space_id uuid, p_grantee uuid)
returns uuid
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select coalesce(
    (select a.id from public.accounts a where a.id = p_grantee),
    (select a.id from public.members m
       join public.accounts a on a.identity_id = m.identity_id
      where m.entity_id = p_grantee and m.space_id = p_space_id))
$$;

revoke all on function internal.resolve_space_credential_grantee(uuid, uuid) from public;

create or replace function public.share_space_credential(p_credential_id uuid, p_grantee_account_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  stored public.space_credentials;
  v_account_id uuid;
  share public.space_credential_shares;
  v_shared boolean := false;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  select * into stored from public.space_credentials where id = p_credential_id for update;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if v_account_id is null or stored.owner_account_id is distinct from v_account_id then
    raise exception 'only the credential''s owner can share it' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_owner')::text;
  end if;
  if stored.status <> 'active' then
    raise exception 'only an active credential can be shared' using errcode = '23514',
      detail = jsonb_build_object('reason', stored.status)::text;
  end if;
  if stored.visibility <> 'private' then
    raise exception 'a public credential is already usable by every member' using errcode = '23514',
      detail = jsonb_build_object('reason', 'public')::text;
  end if;
  p_grantee_account_id := internal.resolve_space_credential_grantee(stored.space_id, p_grantee_account_id);
  -- An id that names nobody falls through to not_member below.
  if p_grantee_account_id = v_account_id then
    raise exception 'share with another member of this space' using errcode = '22023',
      detail = jsonb_build_object('reason', 'self')::text;
  end if;
  -- FOR SHARE on the grantee's member row: a membership end (an UPDATE of
  -- that row) waits for this share to commit and its trigger then deletes it;
  -- one that committed first makes this lock re-read the row, now inactive.
  perform 1 from public.accounts a
    join public.members m on m.identity_id = a.identity_id
   where a.id = p_grantee_account_id and a.status = 'active'
     and m.space_id = stored.space_id and m.status = 'active'
     for share of m;
  if not found then
    raise exception 'a credential is shared only with an active member of its space' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_member')::text;
  end if;

  insert into public.space_credential_shares(credential_id, space_id, grantee_account_id, granted_by_account_id)
  values (stored.id, stored.space_id, p_grantee_account_id, v_account_id)
  on conflict (credential_id, grantee_account_id) do nothing
  returning * into share;
  v_shared := share.credential_id is not null;
  if not v_shared then
    select * into share from public.space_credential_shares
     where credential_id = stored.id and grantee_account_id = p_grantee_account_id;
  end if;

  return jsonb_build_object(
    'credentialId', share.credential_id, 'spaceId', share.space_id,
    'granteeAccountId', share.grantee_account_id,
    'grantedByAccountId', share.granted_by_account_id,
    'createdAt', share.created_at, 'shared', v_shared);
end
$$;

-- The owner or any space admin. The credential's FOR UPDATE serialises with
-- the recorder's FOR SHARE, so no grantee launch records after this commits.
create or replace function public.unshare_space_credential(p_credential_id uuid, p_grantee_account_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  stored public.space_credentials;
  v_account_id uuid;
  removed integer;
  kill jsonb;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  select * into stored from public.space_credentials where id = p_credential_id for update;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  if v_account_id is null
     or not (stored.owner_account_id is not distinct from v_account_id
             or internal.is_space_admin(stored.space_id)) then
    raise exception 'only the credential''s owner or a space admin can withdraw a share' using errcode = '42501';
  end if;
  p_grantee_account_id := coalesce(
    internal.resolve_space_credential_grantee(stored.space_id, p_grantee_account_id), p_grantee_account_id);

  delete from public.space_credential_shares
   where credential_id = stored.id and grantee_account_id = p_grantee_account_id;
  get diagnostics removed = row_count;

  delete from public.member_defaults
   where credential_id = stored.id and account_id = p_grantee_account_id
     and account_id is distinct from stored.owner_account_id;

  -- The grantee's live sessions on it, unless the credential is still usable
  -- by them another way (public or space-owned).
  select coalesce(jsonb_agg(jsonb_build_object(
           'workSessionId', ssc.work_session_id, 'provider', ssc.provider,
           'launcherAccountId', ssc.launcher_account_id, 'status', ws.status)
           order by ssc.work_session_id), '[]'::jsonb)
    into kill
    from public.session_space_credentials ssc
    join public.work_sessions ws on ws.entity_id = ssc.work_session_id
   where ssc.space_credential_id = stored.id
     and ssc.launcher_account_id = p_grantee_account_id
     and ssc.launcher_account_id is distinct from stored.owner_account_id
     and stored.visibility = 'private'
     and ws.status in ('spawning', 'running', 'idle');

  return jsonb_build_object('credentialId', stored.id, 'granteeAccountId', p_grantee_account_id,
                            'unshared', removed > 0, 'killSessions', kill);
end
$$;

-- The owner and space admins see every grantee; any other member sees only
-- their own row (whether it is shared with them).
create or replace function public.list_space_credential_shares(p_credential_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; v_account_id uuid; rows jsonb; v_all boolean;
begin
  perform internal.require_human_auth_kind();
  v_account_id := internal.current_account_id();
  select * into stored from public.space_credentials where id = p_credential_id;
  if stored.id is null or not internal.is_space_member(stored.space_id) then
    raise exception 'space credential not found' using errcode = 'P0002';
  end if;
  v_all := stored.owner_account_id is not distinct from v_account_id
           or internal.is_space_admin(stored.space_id);
  select coalesce(jsonb_agg(jsonb_build_object(
           'granteeAccountId', s.grantee_account_id,
           'granteeMemberId', m.entity_id,
           'granteeDisplayName', coalesce(m.display_name, a.display_name),
           'grantedByAccountId', s.granted_by_account_id,
           'createdAt', s.created_at) order by s.created_at, s.grantee_account_id), '[]'::jsonb)
    into rows
    from public.space_credential_shares s
    join public.accounts a on a.id = s.grantee_account_id
    left join public.members m on m.identity_id = a.identity_id
                              and m.space_id = s.space_id and m.status = 'active'
   where s.credential_id = stored.id
     and (v_all or s.grantee_account_id = v_account_id);
  return rows;
end
$$;

-- -----------------------------------------------------------------------------
-- 7. A membership that ends takes that account's shares in the space with it.
-- -----------------------------------------------------------------------------
create or replace function internal.drop_shares_on_membership_end() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if new.status <> 'active' and old.status = 'active' then
    delete from public.space_credential_shares s
     using public.accounts a
     where a.identity_id = new.identity_id
       and s.grantee_account_id = a.id
       and s.space_id = new.space_id;
    -- And the member's default on any credential they do not own in this
    -- space: it could only have been a share, and a stale one would make a
    -- rejoined member's auto launch refuse instead of reaching space_default.
    delete from public.member_defaults md
     using public.accounts a, public.space_credentials sc
     where a.identity_id = new.identity_id
       and md.account_id = a.id
       and md.space_id = new.space_id
       and sc.id = md.credential_id
       and sc.owner_account_id is distinct from a.id;
  end if;
  return new;
end
$$;

create trigger members_drop_credential_shares
after update of status on public.members
for each row execute function internal.drop_shares_on_membership_end();

revoke all on function internal.drop_shares_on_membership_end() from public;

-- -----------------------------------------------------------------------------
-- 8. Grants.
-- -----------------------------------------------------------------------------
revoke all on function public.share_space_credential(uuid, uuid) from public;
revoke all on function public.unshare_space_credential(uuid, uuid) from public;
revoke all on function public.list_space_credential_shares(uuid) from public;
grant execute on function public.share_space_credential(uuid, uuid) to tm8_app;
grant execute on function public.unshare_space_credential(uuid, uuid) to tm8_app;
grant execute on function public.list_space_credential_shares(uuid) to tm8_app;

-- A new table is analyzed at birth (never-analyzed-tables.pg.test.ts).
analyze public.space_credential_shares;

reset role;
