-- =============================================================================
-- ordinal: placeholder 99x; the merge coordinator assigns the real number at merge (merge order, after 269)
-- server_only_space_credentials — typesafe as a server-only space credential
-- (credentials release 1, stage S6 storage half; task 01a0e268, spec doc
-- 01a0e248 §10.10, §11 row S6, gate 8's reader half).
--
-- `typesafe` (the key behind ✦ Ask Jev) becomes a space credential of a
-- SERVER-ONLY provider class, shape `api_key`. The server spends it on a
-- member's behalf; it is never handed to a spawned session. That is made
-- structural rather than conventional:
--
--   * the spawn reader refuses a server-only provider before anything else;
--   * session_space_credentials can never hold one (its 206 provider CHECK
--     already excludes it, and a named CHECK below keeps that true if the
--     provider list is ever widened again);
--   * the one reader that opens a server-only key, read_space_service_key,
--     refuses every spawn provider, so neither reader can stand in for the
--     other.
--
-- RELEASE 1 IS ADDITIVE: 203's account_service_keys and the node's
-- TYPESAFE_API_KEY stay as Ask Jev's fallback rungs; their removal is release 2
-- (S6-removal, S8).
--
-- SHARED OBJECTS THIS MIGRATION REDEFINES OR ALTERS (coordinator register,
-- doc 01a0e26b). Each base is the LATEST migration defining the object:
--   1. public.read_space_credential_for_spawn(uuid, text, uuid)
--        base 256_space_link_provenance.sql. Delta: first statement refuses a
--        server-only provider (42501, reason server_only); 256's body follows
--        verbatim.
--   2. CHECK space_credentials_provider_check        base 206. Delta: + 'typesafe'.
--   3. CHECK space_credentials_provider_shape_check  base 206. Delta: + (typesafe, api_key).
--   4. CHECK member_defaults_provider_check          base 239. Delta: + 'typesafe'.
--   5. NEW CHECK session_space_credentials_not_server_only (additive).
-- New: internal.is_server_only_credential_provider(text) — immutable, reads
--      nothing, EXECUTE granted to nobody (only the CHECK and the definer
--      readers call it);
--      public.read_space_service_key(uuid, text) — see WHO READS A SERVICE KEY.
--
-- WHO READS A SERVICE KEY. EXECUTE on read_space_service_key is revoked from
-- public and granted to tm8_app only: the server's own database role. It runs
-- under the REQUESTING caller's claims (the server binds them per request), and
-- its one caller is the server's Ask Jev resolver (launch.suggest). No catalog
-- operation, CLI command or agent tool binds it; a session never holds tm8_app.
-- Behaviour, stated as a choice: my_default is read for HUMAN auth kinds only
-- (browser, cli), so an agent-driven Ask Jev falls to the space default and
-- never spends its owner's private key.
-- Not touched: space_credentials_shape_check (api_key is already in it),
-- session_space_credentials_provider_check, create_space_credential (255; its
-- provider is validated only by the CHECKs above), record_session_manifest.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The server-only class. A CHECK cannot hold a subquery, so it is an
--    immutable function, as 206's is_credential_source_set is.
-- -----------------------------------------------------------------------------
create or replace function internal.is_server_only_credential_provider(p_provider text)
returns boolean
language sql immutable parallel safe as $$
  select coalesce(p_provider in ('typesafe'), false)
$$;


-- -----------------------------------------------------------------------------
-- 2. Widen only the checks that must hold typesafe.
-- -----------------------------------------------------------------------------
alter table public.space_credentials
  drop constraint space_credentials_provider_check,
  add constraint space_credentials_provider_check
    check (provider in ('anthropic', 'openai', 'github', 'typesafe')),
  drop constraint space_credentials_provider_shape_check,
  -- GitHub is a PAT (D10); the agent vendors are a login or an API key (D2);
  -- a server-only service key is a pasted API key, never a login.
  add constraint space_credentials_provider_shape_check
    check ((provider = 'github' and shape = 'token')
        or (provider in ('anthropic', 'openai') and shape in ('login', 'api_key'))
        or (provider = 'typesafe' and shape = 'api_key'));

-- my_default(typesafe) is Ask Jev's first rung.
alter table public.member_defaults
  drop constraint member_defaults_provider_check,
  add constraint member_defaults_provider_check
    check (provider in ('anthropic', 'openai', 'github', 'typesafe'));

-- A session can never bind a server-only credential. 206's provider CHECK
-- already refuses typesafe; this one says why, and survives a later widening.
alter table public.session_space_credentials
  add constraint session_space_credentials_not_server_only
    check (not internal.is_server_only_credential_provider(provider));

-- -----------------------------------------------------------------------------
-- 3. read_space_credential_for_spawn — 256's body, with the server-only
--    refusal as its first statement (gate 8, reader half).
-- -----------------------------------------------------------------------------
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

  -- W7p (ruling A'): a link session's own claims read no spawn credential at
  -- all. Its children (auth kind 'agent', via_link set) take the link
  -- admission below. #884's spaceLinks.invoke owns the only exception.
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
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
  -- pinned id; it is checked for both anyway.
  if not (stored.visibility = 'public' or stored.owner_account_id is null
          or stored.owner_account_id = v_launcher) then
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

-- -----------------------------------------------------------------------------
-- 4. read_space_service_key — the ONLY reader of a server-only key's sealed
--    bytes. The server opens them and spends the key itself (Ask Jev); it is
--    never a catalog operation and never on the spawn path.
--
--    my_default → space default → null. my_default is read only under a HUMAN
--    session: an agent token carries its owner's identity and must not spend
--    the owner's private key (the rule 203's reader and advisor.ts keep). The
--    space default is space-scoped and usable by any member of the space.
--    Null (not an error) is "this space holds no key", so the caller can fall
--    to its release-1 rungs.
-- -----------------------------------------------------------------------------
create or replace function public.read_space_service_key(p_space_id uuid, p_provider text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials; v_account uuid; v_source text;
begin
  if not internal.is_server_only_credential_provider(p_provider) then
    raise exception '% is not a server-only credential; a launch reads it with read_space_credential_for_spawn', p_provider
      using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_server_only', 'provider', p_provider)::text;
  end if;
  if coalesce(internal.claim_text('tm8.auth_kind'), '') = 'link' then
    raise exception 'a space link session cannot read a service key' using errcode = '42501';
  end if;
  perform internal.require_space_member(p_space_id);

  if coalesce(internal.claim_text('tm8.auth_kind'), '') in ('browser', 'cli') then
    v_account := internal.current_account_id();
    select sc.* into stored
      from public.member_defaults md
      join public.space_credentials sc on sc.id = md.credential_id and sc.space_id = md.space_id
     where md.space_id = p_space_id and md.account_id = v_account
       and md.provider = p_provider and sc.provider = p_provider
       and sc.status = 'active' and sc.owner_account_id = v_account;
    if stored.id is not null then v_source := 'my_default'; end if;
  end if;

  if stored.id is null then
    select * into stored from public.space_credentials
     where space_id = p_space_id and provider = p_provider
       and is_default and status = 'active';
    if stored.id is null then return null; end if;
    v_source := 'space_default';
  end if;

  update public.space_credentials set last_used_at = now()
   where id = stored.id;

  return jsonb_build_object(
    'credentialId', stored.id,
    'spaceId', stored.space_id,
    'provider', stored.provider,
    'source', v_source,
    'secretCiphertext', encode(stored.secret_ciphertext, 'base64'),
    'secretNonce', encode(stored.secret_nonce, 'base64')
  );
end
$$;

revoke all on function public.read_space_credential_for_spawn(uuid, text, uuid) from public;
grant execute on function public.read_space_credential_for_spawn(uuid, text, uuid) to tm8_app;
revoke all on function public.read_space_service_key(uuid, text) from public;
grant execute on function public.read_space_service_key(uuid, text) to tm8_app;

reset role;
