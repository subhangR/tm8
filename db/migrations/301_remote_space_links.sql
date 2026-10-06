-- =============================================================================
-- 301 — W9c: space links across servers (task 01a1108a; design note on it).
--
-- S1 is the HOME server (space A, where the agent runs); S2 is the TARGET
-- server (space B). M is the human, with an account on both.
--
-- WHAT THIS FILE DOES
--
--   1. S2, the TARGET side. An inbound remote link is a real space_links row
--      plus space_link_tokens rows, anchored in B (home_space_id =
--      target_space_id = B) and marked `remote_home_space_id` (A). A real row
--      means everything S2 already enforces for a link applies unchanged:
--      link_provenance_for / live_link_session (spawn mints), B's default
--      credential only, the cascade when M leaves B, and B's admins' inbound
--      list/audit/revoke/restore (278). Those rows are hidden from B's own
--      outgoing view (list_space_links) and from resolve_space_link_invoke,
--      so a local agent in B can never invoke through one, and a trigger
--      refuses sealed bytes on them (S2 keeps only the session HASH).
--        grant_remote_space_link  — M (human, member of B) grants "A on S1 may
--                                   act in B as me"; stores a pairing code's
--                                   sha256, single use, short-lived.
--        claim_remote_space_link  — S1's server-to-server claim: consumes the
--                                   code (burnt on ANY outcome), mints a `link`
--                                   session for M pinned to B and stamped
--                                   via_link_id, records S1's id and URL.
--        remote_space_link_inbound_row / revoke_remote_space_link_session —
--                                   the inbound route's lookups, under the
--                                   link session's own claims.
--   2. S1, the HOME side. A link whose target_server_id is set stores the
--      token S2 minted, sealed under the node key exactly like 251's
--      (same AAD), with NO local auth session:
--        add_remote_space_link / remote_space_link_context /
--        store_remote_space_link_session.
--   3. W9c TODO (261 §5, finding S4): the retained HUMAN gate session is
--      retired. Nothing needs it (sign-in is the pairing code above), so every
--      stored gate token is deleted and store/open now refuse (0A000).
--
-- ADDS ONLY, except: the 251 CHECK `space_link_tokens_signed_in_has_token` and
-- the 250 index `space_links_one_per_target` are replaced by wider versions
-- (every existing row satisfies both), and server_gate_tokens rows are deleted
-- (sealed human sessions; nothing reads them, see §3).
-- Redefinitions (each the latest body plus the remote filter):
--   list_space_links (251), resolve_space_link_invoke (260),
--   internal.space_link_inbound_json (278), store/open_server_gate_token (261).
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Columns.
-- -----------------------------------------------------------------------------
alter table public.space_links
  add column remote_home_space_id  uuid,
  add column remote_home_label     text check (remote_home_label is null or char_length(remote_home_label) between 1 and 200),
  add column remote_home_server_id text check (remote_home_server_id is null or remote_home_server_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  add column remote_home_base_url  text check (remote_home_base_url is null or char_length(remote_home_base_url) <= 500);

alter table public.space_links
  add constraint space_links_remote_home_shape check (
    remote_home_space_id is null
    or (home_space_id = target_space_id and target_server_id is null));

comment on column public.space_links.remote_home_space_id is
  'W9c (301): set on S2 only. The link is INBOUND from space A on another server; '
  'the row is anchored in B (home = target = B).';

drop index public.space_links_one_per_target;
create unique index space_links_one_per_target
  on public.space_links(home_space_id, target_space_id,
                        coalesce(target_server_id, '00000000-0000-0000-0000-000000000000'::uuid),
                        coalesce(remote_home_space_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table public.space_link_tokens
  add column remote_session_id  uuid,
  add column remote_inbound     boolean not null default false,
  add column pairing_hash       text check (pairing_hash is null or pairing_hash ~ '^[0-9a-f]{64}$'),
  add column pairing_expires_at timestamptz;

create unique index space_link_tokens_pairing_hash
  on public.space_link_tokens(pairing_hash) where pairing_hash is not null;

-- S1's remote row holds sealed bytes and S2's session id, no local session.
-- S2's inbound row holds a local session and NO sealed bytes.
alter table public.space_link_tokens drop constraint space_link_tokens_signed_in_has_token;
alter table public.space_link_tokens
  add constraint space_link_tokens_signed_in_has_token check (
    status <> 'signed_in'
    or (ciphertext is not null and auth_session_id is not null)
    or (ciphertext is not null and remote_session_id is not null)
    or (remote_inbound and ciphertext is null and auth_session_id is not null));

-- S2 never holds the bytes of an inbound session: 251's local login on such a
-- row (it would mint a second, usable session) is refused here.
create or replace function internal.space_link_refuse_inbound_bytes()
returns trigger language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.remote_inbound and new.ciphertext is not null then
    raise exception 'an inbound remote space link is signed in from its home server only' using errcode = '42501',
      detail = jsonb_build_object('reason', 'space_link_remote_inbound')::text;
  end if;
  return new;
end
$$;

create trigger space_link_tokens_refuse_inbound_bytes
before insert or update of ciphertext on public.space_link_tokens
for each row
when (new.remote_inbound and new.ciphertext is not null)
execute function internal.space_link_refuse_inbound_bytes();

-- -----------------------------------------------------------------------------
-- 2. Redefinitions that hide inbound rows from B's own outgoing surfaces.
-- -----------------------------------------------------------------------------

-- 251's body plus `remote_home_space_id is null`.
create or replace function public.list_space_links(p_space_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  me uuid;
begin
  perform internal.require_space_member(p_space_id);
  me := internal.current_member_id(p_space_id);
  return coalesce((
    select jsonb_agg(internal.space_link_json(l.entity_id, me) order by l.created_at, l.entity_id)
      from public.space_links l
      join public.entities e on e.id = l.entity_id
     where l.home_space_id = p_space_id
       and l.remote_home_space_id is null
       and e.deleted_at is null
  ), '[]'::jsonb);
end
$$;

-- 260's body plus `not t.remote_inbound`: an inbound row is used by the
-- inbound route under its own session, never by a local invoke.
create or replace function public.resolve_space_link_invoke(p_home_space_id uuid, p_ref text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me uuid;
  row public.space_link_tokens;
  server_id uuid;
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli', 'agent') then
    raise exception 'this session kind cannot use a space link' using errcode = '42501',
      detail = jsonb_build_object('authKind', coalesce(internal.claim_text('tm8.auth_kind'), 'none'))::text;
  end if;
  if internal.claim_text('tm8.via_link') is not null then
    raise exception 'a session minted under a space link cannot use a space link' using errcode = '42501';
  end if;
  me := internal.current_member_id(p_home_space_id);
  if me is null or p_ref is null or btrim(p_ref) = '' then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  select t.* into row from public.space_link_tokens t
   where t.member_id = me and t.home_space_id = p_home_space_id
     and not t.remote_inbound
     and (t.alias = lower(p_ref)
          or (p_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and t.link_id = p_ref::uuid))
   order by (t.alias = lower(p_ref)) desc nulls last
   limit 1;
  if row.id is null then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  select l.target_server_id into server_id from public.space_links l where l.entity_id = row.link_id;
  return jsonb_build_object(
    'linkId', row.link_id,
    'tokenRowId', row.id,
    'memberId', row.member_id,
    'homeSpaceId', row.home_space_id,
    'targetSpaceId', row.target_space_id,
    'targetServerId', server_id,
    'status', row.status,
    'allowSpawn', row.allow_spawn,
    'spawnBudget', row.spawn_budget);
end
$$;

-- 278's body plus `remoteHome`; a remote link's home name is its label (B
-- cannot read a space on another server).
create or replace function internal.space_link_inbound_json(p_link_id uuid)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', l.entity_id,
    'homeSpaceId', coalesce(l.remote_home_space_id, l.home_space_id),
    'homeSpaceName', case when l.remote_home_space_id is null
                          then (select s.name from public.spaces s where s.id = l.home_space_id)
                          else l.remote_home_label end,
    'targetSpaceId', l.target_space_id,
    'createdAt', l.created_at,
    'revokedAt', l.target_revoked_at,
    'revokedByMemberId', l.target_revoked_by,
    'lastCallAt', (select max(a.created_at) from public.cross_space_audit a
                    where a.link_id = l.entity_id and a.target_space_id = l.target_space_id),
    'remoteHome', case when l.remote_home_space_id is null then null else jsonb_build_object(
                    'spaceId', l.remote_home_space_id,
                    'label', l.remote_home_label,
                    'serverId', l.remote_home_server_id,
                    'baseUrl', l.remote_home_base_url) end,
    'holders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'targetMemberId', (internal.space_link_target_member(t.member_id, l.target_space_id)).entity_id,
               'displayName', (internal.space_link_target_member(t.member_id, l.target_space_id)).display_name,
               'status', t.status,
               'allowSpawn', t.allow_spawn,
               'spawnBudget', t.spawn_budget,
               'expiresAt', t.expires_at,
               'lastUsedAt', t.last_used_at) order by t.created_at, t.id)
        from public.space_link_tokens t
       where t.link_id = l.entity_id), '[]'::jsonb))
    from public.space_links l
   where l.entity_id = p_link_id
$$;

-- -----------------------------------------------------------------------------
-- 3. S2: grant. Human, member of B. Returns B's admin view of the link; the
--    pairing code itself is generated in TS and only its sha256 reaches SQL.
--    Not ledgered: a replay must not hand back a code, and a fresh call simply
--    replaces the pending code.
-- -----------------------------------------------------------------------------
create or replace function public.grant_remote_space_link(
  p_space_id uuid,
  p_home_space_id uuid,
  p_home_label text,
  p_allow_spawn boolean,
  p_pairing_hash text,
  p_pairing_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me uuid;
  v_link_id uuid;
  revoked timestamptz;
  label text := nullif(btrim(coalesce(p_home_label, '')), '');
begin
  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);
  me := internal.current_member_id(p_space_id);
  perform internal.bind_actor(me);

  if p_home_space_id is null or p_home_space_id = p_space_id then
    raise exception 'a remote link needs the home space id on the other server' using errcode = '22023';
  end if;
  if p_pairing_hash is null or p_pairing_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'malformed pairing hash' using errcode = '22023';
  end if;
  if p_pairing_expires_at <= now() or p_pairing_expires_at > now() + interval '30 minutes' then
    raise exception 'a pairing code lasts at most 30 minutes' using errcode = '22023';
  end if;

  select l.entity_id, l.target_revoked_at into v_link_id, revoked
    from public.space_links l
    join public.entities e on e.id = l.entity_id
   where l.home_space_id = p_space_id and l.target_space_id = p_space_id
     and l.remote_home_space_id = p_home_space_id and e.deleted_at is null
   for update of l;
  if revoked is not null then
    raise exception 'this space link was revoked by an admin of the target space' using errcode = '42501',
      detail = jsonb_build_object('reason', 'space_link_target_revoked')::text;
  end if;
  if v_link_id is null then
    v_link_id := internal.new_id();
    insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
    values (v_link_id, p_space_id, 'space_link', null, null, me, 'space');
    insert into public.space_links(entity_id, home_space_id, target_space_id, target_server_id,
                                   remote_home_space_id, remote_home_label)
    values (v_link_id, p_space_id, p_space_id, null, p_home_space_id, coalesce(label, 'another server'));
    perform internal.record_initial_version(v_link_id, me);
    perform internal.record_activity(p_space_id, v_link_id, me, 'created', null,
              jsonb_build_object('kind', 'space_link', 'remoteHome', true));
  elsif label is not null then
    update public.space_links set remote_home_label = label, updated_at = now() where entity_id = v_link_id;
  end if;

  insert into public.space_link_tokens(link_id, home_space_id, member_id, target_space_id, aad,
                                       remote_inbound, allow_spawn, pairing_hash, pairing_expires_at)
  values (v_link_id, p_space_id, me, p_space_id,
          p_space_id::text || '|' || v_link_id::text || '|' || me::text || '|' || p_space_id::text,
          true, coalesce(p_allow_spawn, false), p_pairing_hash, p_pairing_expires_at)
  on conflict (link_id, member_id) do update
     set pairing_hash = excluded.pairing_hash,
         pairing_expires_at = excluded.pairing_expires_at,
         allow_spawn = excluded.allow_spawn;

  return internal.space_link_inbound_json(v_link_id);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. S2: claim. Server-to-server, NO caller claims (the pairing code is the
--    credential). Returns { ok:false, reason } instead of raising so the code
--    stays burnt: a raise would roll the burn back and let it be guessed again.
-- -----------------------------------------------------------------------------
create or replace function public.claim_remote_space_link(
  p_pairing_hash text,
  p_home_space_id uuid,
  p_home_server_id text,
  p_home_base_url text,
  p_session_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
  link public.space_links;
  account uuid;
  deleted timestamptz;
begin
  if p_pairing_hash is null or p_pairing_hash !~ '^[0-9a-f]{64}$'
     or p_token_hash is null or p_session_id is null or p_home_space_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;
  if p_home_server_id is not null and p_home_server_id !~ '^[A-Za-z0-9_.:-]{1,100}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '90 days 1 minute' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  select t.* into row from public.space_link_tokens t
   where t.pairing_hash = p_pairing_hash and t.remote_inbound
   for update;
  if row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'pairing_invalid');
  end if;
  -- Burnt whatever happens next: single use.
  update public.space_link_tokens set pairing_hash = null, pairing_expires_at = null where id = row.id;
  if row.pairing_expires_at is null or row.pairing_expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'pairing_expired');
  end if;

  select l.* into link from public.space_links l where l.entity_id = row.link_id for update;
  select e.deleted_at into deleted from public.entities e where e.id = row.link_id;
  if link.entity_id is null or deleted is not null or link.target_revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'link_revoked');
  end if;
  if link.remote_home_space_id is distinct from p_home_space_id then
    return jsonb_build_object('ok', false, 'reason', 'home_mismatch');
  end if;
  select a.id into account
    from public.members m
    join public.accounts a on a.identity_id = m.identity_id and a.status = 'active'
   where m.entity_id = row.member_id and m.status = 'active';
  if account is null then
    return jsonb_build_object('ok', false, 'reason', 'member_inactive');
  end if;

  if row.auth_session_id is not null then
    update public.auth_sessions set revoked_at = now()
     where id = row.auth_session_id and revoked_at is null;
  end if;
  insert into public.auth_sessions(id, account_id, kind, space_id, token_hash, label, expires_at, via_link_id)
  values (p_session_id, account, 'link', row.target_space_id, p_token_hash,
          left('Remote space link from ' || coalesce(link.remote_home_label, 'another server'), 200),
          p_expires_at, row.link_id);
  update public.space_link_tokens
     set auth_session_id = p_session_id, status = 'signed_in', expires_at = p_expires_at
   where id = row.id;
  update public.space_links
     set remote_home_server_id = p_home_server_id,
         remote_home_base_url = left(p_home_base_url, 500),
         updated_at = now()
   where entity_id = link.entity_id;

  return jsonb_build_object(
    'ok', true,
    'linkId', row.link_id,
    'targetSpaceId', row.target_space_id,
    'sessionId', p_session_id,
    'expiresAt', p_expires_at,
    'allowSpawn', row.allow_spawn);
end
$$;

-- -----------------------------------------------------------------------------
-- 5. S2: the inbound route's lookups, under the link session's OWN claims
--    (kind `link`, tm8.via_link set). The session id is the one the route
--    just resolved by token hash; it must be the row's current session.
-- -----------------------------------------------------------------------------
create or replace function internal.remote_inbound_own_row(p_session_id uuid)
returns public.space_link_tokens language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
  link uuid := nullif(internal.claim_text('tm8.via_link'), '')::uuid;
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') <> 'link' or link is null then
    raise exception 'only a remote space link session can use this' using errcode = '42501';
  end if;
  select t.* into row from public.space_link_tokens t
    join public.members m on m.entity_id = t.member_id
   where t.link_id = link and t.remote_inbound
     and t.auth_session_id = p_session_id
     and m.identity_id = internal.identity_id()
   for update of t;
  if row.id is null then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  return row;
end
$$;

create or replace function public.remote_space_link_inbound_row(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
  link public.space_links;
begin
  row := internal.remote_inbound_own_row(p_session_id);
  select l.* into link from public.space_links l
    join public.entities e on e.id = l.entity_id
   where l.entity_id = row.link_id and e.deleted_at is null;
  if link.entity_id is null or link.target_revoked_at is not null or row.status <> 'signed_in' then
    raise exception 'space link is signed_out' using errcode = '23514',
      detail = jsonb_build_object('status', 'signed_out')::text;
  end if;
  update public.space_link_tokens set last_used_at = now() where id = row.id;
  return jsonb_build_object(
    'linkId', row.link_id,
    'tokenRowId', row.id,
    'memberId', row.member_id,
    'targetSpaceId', row.target_space_id,
    'allowSpawn', row.allow_spawn,
    'remoteHomeSpaceId', link.remote_home_space_id);
end
$$;

-- S1's logout/remove tells S2: the session minted here ends with the link.
create or replace function public.revoke_remote_space_link_session(p_session_id uuid)
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
begin
  row := internal.remote_inbound_own_row(p_session_id);
  update public.auth_sessions set revoked_at = now() where id = row.auth_session_id and revoked_at is null;
  update public.space_link_tokens
     set auth_session_id = null, status = case when status = 'left' then 'left' else 'signed_out' end
   where id = row.id;
  return true;
end
$$;

-- -----------------------------------------------------------------------------
-- 6. S1: a link to a space on another server, and its sealed session.
-- -----------------------------------------------------------------------------
create or replace function public.add_remote_space_link(
  p_space_id uuid,
  p_server_id uuid,
  p_target_space_id uuid,
  p_alias text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  me uuid;
  v_link_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaceLinks.add');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'homeSpaceId', p_space_id::text, 'space');
    return replay;
  end if;

  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);
  me := internal.current_member_id(p_space_id);
  perform internal.bind_actor(me);

  if p_target_space_id is null then
    raise exception 'a space link needs a target space' using errcode = '22023';
  end if;
  -- The server must be one of the home space's own server entities.
  if not exists (
    select 1 from public.servers s join public.entities e on e.id = s.entity_id
     where s.entity_id = p_server_id and s.home_space_id = p_space_id and e.deleted_at is null
  ) then
    raise exception 'server not found in this space' using errcode = 'P0002';
  end if;

  select entity_id into v_link_id from public.space_links
   where home_space_id = p_space_id and target_space_id = p_target_space_id
     and target_server_id = p_server_id
   for update;
  if v_link_id is null then
    v_link_id := internal.new_id();
    insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
    values (v_link_id, p_space_id, 'space_link', null, null, me, 'space');
    insert into public.space_links(entity_id, home_space_id, target_space_id, target_server_id)
    values (v_link_id, p_space_id, p_target_space_id, p_server_id);
    perform internal.record_initial_version(v_link_id, me);
    perform internal.record_activity(p_space_id, v_link_id, me, 'created', null,
              jsonb_build_object('kind', 'space_link', 'remote', true));
  end if;

  insert into public.space_link_tokens(link_id, home_space_id, member_id, target_space_id, aad, alias)
  values (v_link_id, p_space_id, me, p_target_space_id,
          p_space_id::text || '|' || v_link_id::text || '|' || me::text || '|' || p_target_space_id::text,
          nullif(btrim(p_alias), ''))
  on conflict (link_id, member_id) do nothing;

  return internal.ledger_record(p_client_mutation_id, 'spaceLinks.add',
           internal.space_link_json(v_link_id, me));
end
$$;

-- What the server needs to sign in (human) or to tell S2 about a logout:
-- the caller's own row, and where the target server is. No sealed bytes.
create or replace function public.remote_space_link_context(p_link_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.space_link_tokens;
  srv public.servers;
begin
  perform internal.require_human_auth_kind();
  row := internal.space_link_own_row(p_link_id);
  select s.* into srv from public.space_links l
    join public.servers s on s.entity_id = l.target_server_id
   where l.entity_id = p_link_id;
  return jsonb_build_object(
    'linkId', row.link_id, 'homeSpaceId', row.home_space_id,
    'memberId', row.member_id, 'targetSpaceId', row.target_space_id,
    'status', row.status,
    'targetServerId', srv.entity_id, 'baseUrl', srv.base_url);
end
$$;

create or replace function public.store_remote_space_link_session(
  p_link_id uuid,
  p_remote_session_id uuid,
  p_expires_at timestamptz,
  p_ciphertext bytea,
  p_nonce bytea,
  p_operation text,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  row public.space_link_tokens;
begin
  if p_operation not in ('spaceLinks.login', 'spaceLinks.relogin') then
    raise exception 'unknown space link operation' using errcode = '22023';
  end if;
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, p_operation);
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'id', p_link_id::text, 'entity');
    return replay;
  end if;

  perform internal.require_human_auth_kind();
  row := internal.space_link_own_row(p_link_id);
  perform internal.bind_actor(row.member_id);
  if not exists (select 1 from public.space_links l where l.entity_id = p_link_id and l.target_server_id is not null) then
    raise exception 'this link targets a space on this server: sign in without a pairing code' using errcode = '22023';
  end if;
  if p_remote_session_id is null then
    raise exception 'the remote session id is required' using errcode = '22023';
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '90 days 1 minute' then
    raise exception 'a link session lasts at most 90 days' using errcode = '22023';
  end if;

  update public.space_link_tokens
     set ciphertext = p_ciphertext,
         nonce = p_nonce,
         auth_session_id = null,
         remote_session_id = p_remote_session_id,
         status = 'signed_in',
         expires_at = p_expires_at
   where id = row.id;

  return internal.ledger_record(p_client_mutation_id, p_operation,
           internal.space_link_json(p_link_id, row.member_id));
end
$$;

-- -----------------------------------------------------------------------------
-- 7. W9c: retire the retained human gate session (261 §5). Nothing reads it:
--    remote sign-in is the pairing code above, and the relay forwards the
--    caller's own bearer. Delete the sealed rows; the two RPCs now refuse.
-- -----------------------------------------------------------------------------
delete from public.server_gate_tokens;

create or replace function public.store_server_gate_token(
  p_server_id uuid,
  p_expires_at timestamptz,
  p_ciphertext bytea,
  p_nonce bytea,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  raise exception 'server gate sessions are retired (W9c): sign in to a remote space link with a pairing code'
    using errcode = '0A000', detail = jsonb_build_object('reason', 'server_gate_retired')::text;
end
$$;

create or replace function public.open_server_gate_token(p_server_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  raise exception 'server gate sessions are retired (W9c)'
    using errcode = '0A000', detail = jsonb_build_object('reason', 'server_gate_retired')::text;
end
$$;

-- -----------------------------------------------------------------------------
-- 8. Grants — full signatures.
-- -----------------------------------------------------------------------------
revoke all on function internal.remote_inbound_own_row(uuid) from public;

revoke all on function public.grant_remote_space_link(uuid, uuid, text, boolean, text, timestamptz) from public;
grant execute on function public.grant_remote_space_link(uuid, uuid, text, boolean, text, timestamptz) to tm8_app;
revoke all on function public.claim_remote_space_link(text, uuid, text, text, uuid, text, timestamptz) from public;
grant execute on function public.claim_remote_space_link(text, uuid, text, text, uuid, text, timestamptz) to tm8_app;
revoke all on function public.remote_space_link_inbound_row(uuid) from public;
grant execute on function public.remote_space_link_inbound_row(uuid) to tm8_app;
revoke all on function public.revoke_remote_space_link_session(uuid) from public;
grant execute on function public.revoke_remote_space_link_session(uuid) to tm8_app;
revoke all on function public.add_remote_space_link(uuid, uuid, uuid, text, text) from public;
grant execute on function public.add_remote_space_link(uuid, uuid, uuid, text, text) to tm8_app;
revoke all on function public.remote_space_link_context(uuid) from public;
grant execute on function public.remote_space_link_context(uuid) to tm8_app;
revoke all on function public.store_remote_space_link_session(uuid, uuid, timestamptz, bytea, bytea, text, text) from public;
grant execute on function public.store_remote_space_link_session(uuid, uuid, timestamptz, bytea, bytea, text, text) to tm8_app;

reset role;
