-- =============================================================================
-- 991 (PLACEHOLDER ORDINAL — the coordinator assigns the real one at merge) —
-- remote servers (plan 01a0d9eb §3 W8; phases doc 01a0d9fb §3 W8; T25, T27).
--
-- WHAT THIS FILE DOES
--
--   1. `public.servers`: the detail row of the `server` entity (kind registered
--      by 250). A server lives in a home space; every member of that space can
--      see it. It holds no secret.
--   2. `public.server_gate_tokens`: one member's SEALED gate session on that
--      server. 251's posture exactly: RLS shows a row to its member only (no
--      node-admin or space-admin arm), tm8_app's column grant leaves out
--      ciphertext and nonce, and every write is a SECURITY DEFINER RPC behind
--      the strict internal.require_human_auth_kind(). AES-256-GCM under the
--      node key, AAD `server-gate|<home_space_id>|<server_id>|<member_id>`,
--      recomputed from the columns on open.
--      The gate token only mints and refreshes a link session on the remote
--      (its auth.space.enter). A forwarded call presents that link session
--      alone: ingress takes ONE credential (http/identity-resolver.ts:54-69).
--   3. NOT HERE: remote link sessions on 251's table. Lead ruling 09:12Z: they
--      land with kind `link` minting on auth.space.enter, after the re-stack
--      onto main. Until then forwarding refuses (remote/forwarder.ts).
--   4. 044 STAYS AS IT IS AND BECOMES READ-ONLY (O12, owner-confirmed). No row
--      is rewritten or copied (owner ruling 05:04Z). create/delete raise 42501.
--      `servers.adopt` lazily makes a server entity for a 044 row on first use.
--   5. `public.server_directory`: the one list every reader uses (Recent
--      Spaces, the server rail, the relay, the CLI) — server entities the
--      caller can read, plus 044 rows (node admins only, as before) that no
--      server entity has EVER adopted (live or soft-deleted: adoption shadows
--      the 044 row permanently; delete means gone). security_invoker, so both
--      halves keep their own RLS; the adoption test alone is a definer helper
--      so it does not depend on the reader's view of `servers`.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. servers
-- -----------------------------------------------------------------------------
create table public.servers (
  entity_id            uuid primary key references public.entities(id) on delete cascade,
  home_space_id        uuid not null references public.spaces(id) on delete cascade,
  name                 text not null,
  base_url             text not null,
  username             text,
  reach_status         text not null default 'unknown'
    check (reach_status in ('unknown', 'reachable', 'unreachable', 'offline')),
  reach_checked_at     timestamptz,
  legacy_connection_id uuid references public.server_connections(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- 044's own shape, so an adopted row always fits.
  constraint servers_name_check check (name ~ '^[a-z][a-z0-9-]{0,62}$'),
  constraint servers_base_url_check check (length(base_url) <= 2048 and base_url ~ '^https?://'),
  constraint servers_username_check check (username is null or (length(username) between 1 and 100))
);

create unique index servers_name_per_space on public.servers(home_space_id, lower(name));
create unique index servers_legacy_per_space on public.servers(home_space_id, legacy_connection_id)
  where legacy_connection_id is not null;

create trigger servers_touch_updated_at
before update on public.servers
for each row execute function internal.touch_updated_at();

alter table public.servers enable row level security;

-- 250's space_links shape (218 §4): readable when the entity is.
create policy servers_select on public.servers for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = servers.entity_id and readable_entity.deleted_at is null offset 0)));

grant select on public.servers to tm8_app;

comment on table public.servers is
  'W8: the server entity''s detail row. No secret: a member''s sealed gate '
  'session is public.server_gate_tokens.';

-- -----------------------------------------------------------------------------
-- 2. server_gate_tokens
-- -----------------------------------------------------------------------------
create table public.server_gate_tokens (
  id               uuid primary key default internal.new_id(),
  server_id        uuid not null references public.servers(entity_id) on delete cascade,
  home_space_id    uuid not null references public.spaces(id) on delete cascade,
  member_id        uuid not null references public.members(entity_id) on delete cascade,
  ciphertext       bytea,
  nonce            bytea,
  aad              text not null,
  status           text not null default 'signed_out'
    check (status in ('signed_in', 'signed_out')),
  expires_at       timestamptz,
  last_used_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (server_id, member_id),
  constraint server_gate_tokens_aad_binds_row check (
    aad = 'server-gate|' || home_space_id::text || '|' || server_id::text || '|' || member_id::text),
  constraint server_gate_tokens_sealed_shape check (
    (ciphertext is null and nonce is null)
    or (ciphertext is not null and nonce is not null
        and octet_length(nonce) = 12 and octet_length(ciphertext) between 17 and 4096)),
  constraint server_gate_tokens_signed_in_has_token check (
    status <> 'signed_in' or ciphertext is not null)
);

create index server_gate_tokens_member_idx on public.server_gate_tokens(member_id);

create trigger server_gate_tokens_touch_updated_at
before update on public.server_gate_tokens
for each row execute function internal.touch_updated_at();

alter table public.server_gate_tokens enable row level security;

-- The row's member only: no node-admin arm, no space-admin arm (251's policy).
create policy server_gate_tokens_select on public.server_gate_tokens for select to tm8_app
  using (exists (
    select 1 from public.members m
     where m.entity_id = server_gate_tokens.member_id
       and m.identity_id = internal.identity_id()
       and m.status = 'active'
       and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
            or m.space_id = nullif(current_setting('tm8.session_space_id', true), '')::uuid)));

-- Column grant WITHOUT ciphertext and nonce.
grant select (id, server_id, home_space_id, member_id, aad, status, expires_at,
              last_used_at, created_at, updated_at)
  on public.server_gate_tokens to tm8_app;

comment on table public.server_gate_tokens is
  'W8: one member''s sealed gate session on a remote server. AES-256-GCM under '
  'the node key, AAD server-gate|home_space_id|server_id|member_id. tm8_app '
  'cannot select ciphertext or nonce; RLS shows a row to its member only.';

-- -----------------------------------------------------------------------------
-- 3. Helpers.
-- -----------------------------------------------------------------------------

-- A live server the caller may act on: its home member id, or P0002 (the same
-- answer for "no such server" and "not a member", so nothing is probed).
create or replace function internal.server_member(p_server_id uuid)
returns uuid language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  srv public.servers;
  me uuid;
begin
  select s.* into srv from public.servers s
    join public.entities e on e.id = s.entity_id and e.deleted_at is null
   where s.entity_id = p_server_id;
  if srv.entity_id is null then
    raise exception 'server not found' using errcode = 'P0002';
  end if;
  me := internal.current_member_id(srv.home_space_id);
  if me is null then
    raise exception 'server not found' using errcode = 'P0002';
  end if;
  return me;
end
$$;

revoke all on function internal.server_member(uuid) from public;

-- The caller's own gate row, created signed_out on first touch, locked.
create or replace function internal.server_gate_own_row(p_server_id uuid)
returns public.server_gate_tokens language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  me uuid;
  home uuid;
  row public.server_gate_tokens;
begin
  me := internal.server_member(p_server_id);
  select home_space_id into home from public.servers where entity_id = p_server_id;
  insert into public.server_gate_tokens(server_id, home_space_id, member_id, aad)
  values (p_server_id, home, me,
          'server-gate|' || home::text || '|' || p_server_id::text || '|' || me::text)
  on conflict (server_id, member_id) do nothing;
  select * into row from public.server_gate_tokens
   where server_id = p_server_id and member_id = me
   for update;
  return row;
end
$$;

revoke all on function internal.server_gate_own_row(uuid) from public;

-- One server as a home member sees it. Never ciphertext, nonce or aad.
create or replace function internal.server_json(p_server_id uuid, p_member_id uuid)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', s.entity_id,
    'homeSpaceId', s.home_space_id,
    'name', s.name,
    'baseUrl', s.base_url,
    'username', s.username,
    'reachStatus', s.reach_status,
    'reachCheckedAt', s.reach_checked_at,
    'legacyConnectionId', s.legacy_connection_id,
    'createdAt', s.created_at,
    'updatedAt', s.updated_at,
    'mine', (select jsonb_build_object('status', t.status, 'expiresAt', t.expires_at,
                                       'lastUsedAt', t.last_used_at)
               from public.server_gate_tokens t
              where t.server_id = s.entity_id and t.member_id = p_member_id))
    from public.servers s
   where s.entity_id = p_server_id
$$;

revoke all on function internal.server_json(uuid, uuid) from public;

-- The caller's first active space, for a gate-level add with no space given
-- (the server rail sits above spaces). Oldest membership first: the personal
-- or first space (K9's rule for where a member's link entities live).
create or replace function internal.default_home_space()
returns uuid language sql stable security definer set search_path = public, internal, pg_temp as $$
  select m.space_id from public.members m
   where m.identity_id = internal.identity_id()
     and m.status = 'active'
     and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
          or m.space_id = nullif(current_setting('tm8.session_space_id', true), '')::uuid)
   order by m.joined_at, m.space_id
   limit 1
$$;

revoke all on function internal.default_home_space() from public;

-- Insert a server entity + row. Shared by add and adopt.
create or replace function internal.insert_server(
  p_space_id uuid, p_me uuid, p_name text, p_base_url text, p_username text, p_legacy uuid
) returns uuid language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_id uuid := internal.new_id();
begin
  insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
  values (v_id, p_space_id, 'server', null, null, p_me, 'space');
  insert into public.servers(entity_id, home_space_id, name, base_url, username, legacy_connection_id)
  values (v_id, p_space_id, lower(p_name), p_base_url, p_username, p_legacy);
  perform internal.record_initial_version(v_id, p_me);
  perform internal.record_activity(p_space_id, v_id, p_me, 'created', null,
            jsonb_build_object('kind', 'server'));
  return v_id;
end
$$;

revoke all on function internal.insert_server(uuid, uuid, text, text, text, uuid) from public;

-- -----------------------------------------------------------------------------
-- 4. servers.add / adopt / remove / list — human-only writes.
-- -----------------------------------------------------------------------------
create or replace function public.add_server(
  p_space_id uuid,
  p_name text,
  p_base_url text,
  p_username text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  space uuid;
  me uuid;
  v_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'servers.add');
  if replay is not null then
    if replay ->> 'name' is distinct from lower(p_name) then
      raise exception 'clientMutationId is already bound to another server' using errcode = '23514';
    end if;
    return replay;
  end if;

  perform internal.require_human_auth_kind();
  space := coalesce(p_space_id, internal.default_home_space());
  if space is null then
    raise exception 'you are not a member of any space' using errcode = '42501';
  end if;
  perform internal.require_space_member(space);
  me := internal.current_member_id(space);
  perform internal.bind_actor(me);

  v_id := internal.insert_server(space, me, p_name, p_base_url, nullif(btrim(p_username), ''), null);
  return internal.ledger_record(p_client_mutation_id, 'servers.add', internal.server_json(v_id, me));
end
$$;

-- A 044 row gets its server entity on first use. Only a node admin can read
-- 044 (its policy), so only a node admin can adopt; the entity then belongs to
-- a space and its members see it. Idempotent per (space, connection).
create or replace function public.adopt_server_connection(
  p_space_id uuid,
  p_name text,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  space uuid;
  me uuid;
  conn public.server_connections;
  v_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'servers.adopt');
  if replay is not null then
    if replay ->> 'name' is distinct from lower(p_name) then
      raise exception 'clientMutationId is already bound to another server' using errcode = '23514';
    end if;
    return replay;
  end if;

  perform internal.require_human_auth_kind();
  perform internal.require_node_admin();
  space := coalesce(p_space_id, internal.default_home_space());
  if space is null then
    raise exception 'you are not a member of any space' using errcode = '42501';
  end if;
  perform internal.require_space_member(space);
  me := internal.current_member_id(space);
  perform internal.bind_actor(me);

  select * into conn from public.server_connections where name = lower(p_name);
  if conn.id is null then
    raise exception 'server connection not found' using errcode = 'P0002';
  end if;

  select s.entity_id into v_id from public.servers s
    join public.entities e on e.id = s.entity_id and e.deleted_at is null
   where s.home_space_id = space and s.legacy_connection_id = conn.id;
  if v_id is null then
    v_id := internal.insert_server(space, me, conn.name, conn.base_url, conn.username, conn.id);
  end if;
  return internal.ledger_record(p_client_mutation_id, 'servers.adopt', internal.server_json(v_id, me));
end
$$;

-- Removes the server for everyone in the home space: its creator or a space
-- admin. Every member's sealed gate row goes with it. A link still pointing at
-- it refuses (space_links.target_server_id is `on delete restrict`, and a
-- soft delete is checked here the same way).
create or replace function public.remove_server(
  p_server_id uuid,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  me uuid;
  srv public.servers;
  creator uuid;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'servers.remove');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'id', p_server_id::text, 'entity');
    return replay;
  end if;

  perform internal.require_human_auth_kind();
  me := internal.server_member(p_server_id);
  select * into srv from public.servers where entity_id = p_server_id for update;
  select created_by into creator from public.entities where id = p_server_id;
  if creator is distinct from me and not internal.is_space_admin(srv.home_space_id) then
    raise exception 'only the server''s creator or a space admin can remove it' using errcode = '42501';
  end if;
  if exists (select 1 from public.space_links l
               join public.entities e on e.id = l.entity_id and e.deleted_at is null
              where l.target_server_id = p_server_id) then
    raise exception 'a space link still targets this server; remove the link first' using errcode = '23503';
  end if;
  perform internal.bind_actor(me);

  result := internal.server_json(p_server_id, me);
  delete from public.server_gate_tokens where server_id = p_server_id;
  -- The server's lifecycle is command-owned (§8b): this is its one writer.
  perform set_config('tm8.server_lifecycle', 'on', true);
  update public.entities set deleted_at = now(), updated_at = now() where id = p_server_id;
  perform set_config('tm8.server_lifecycle', 'off', true);
  perform internal.record_activity(srv.home_space_id, p_server_id, me, 'deleted', null,
            jsonb_build_object('kind', 'server'));
  return internal.ledger_record(p_client_mutation_id, 'servers.remove', result);
end
$$;

-- Every live server in a space, with the caller's own gate row. No gate: an
-- agent may list. No secret in the answer.
create or replace function public.list_servers(p_space_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  me uuid;
begin
  perform internal.require_space_member(p_space_id);
  me := internal.current_member_id(p_space_id);
  return coalesce((
    select jsonb_agg(internal.server_json(s.entity_id, me) order by s.name, s.entity_id)
      from public.servers s
      join public.entities e on e.id = s.entity_id and e.deleted_at is null
     where s.home_space_id = p_space_id
  ), '[]'::jsonb);
end
$$;

-- One server, for a home member (the probe reads its URL here). P0002 for
-- "no such server" and "not a member" alike.
create or replace function public.get_server(p_server_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  return internal.server_json(p_server_id, internal.server_member(p_server_id));
end
$$;

-- -----------------------------------------------------------------------------
-- 5. The gate token: seal context, store, open, sign out. Human-only, own row.
-- -----------------------------------------------------------------------------
create or replace function public.server_gate_seal_context(p_server_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.server_gate_tokens;
begin
  perform internal.require_human_auth_kind();
  row := internal.server_gate_own_row(p_server_id);
  return jsonb_build_object('homeSpaceId', row.home_space_id, 'serverId', row.server_id,
                            'memberId', row.member_id);
end
$$;

create or replace function public.store_server_gate_token(
  p_server_id uuid,
  p_expires_at timestamptz,
  p_ciphertext bytea,
  p_nonce bytea,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  row public.server_gate_tokens;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'servers.signIn');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'id', p_server_id::text, 'entity');
    return replay;
  end if;
  perform internal.require_human_auth_kind();
  row := internal.server_gate_own_row(p_server_id);
  perform internal.bind_actor(row.member_id);
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'the gate session has already expired' using errcode = '22023';
  end if;
  update public.server_gate_tokens
     set ciphertext = p_ciphertext, nonce = p_nonce, status = 'signed_in', expires_at = p_expires_at
   where id = row.id;
  return internal.ledger_record(p_client_mutation_id, 'servers.signIn',
           internal.server_json(p_server_id, row.member_id));
end
$$;

-- The server process opens this in memory to mint a link session on the
-- remote. HUMAN KINDS ONLY: an agent never holds a member's gate session, it
-- only ever presents a link session a human minted.
create or replace function public.open_server_gate_token(p_server_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.server_gate_tokens;
begin
  perform internal.require_human_auth_kind();
  row := internal.server_gate_own_row(p_server_id);
  if row.status <> 'signed_in' or row.ciphertext is null then
    raise exception 'you are not signed in to this server' using errcode = '23514',
      detail = jsonb_build_object('status', row.status)::text;
  end if;
  if row.expires_at is not null and row.expires_at <= now() then
    update public.server_gate_tokens set status = 'signed_out', ciphertext = null, nonce = null
     where id = row.id;
    raise exception 'your session on this server has expired' using errcode = '23514',
      detail = jsonb_build_object('status', 'signed_out')::text;
  end if;
  update public.server_gate_tokens set last_used_at = now() where id = row.id;
  return jsonb_build_object(
    'serverId', row.server_id, 'homeSpaceId', row.home_space_id, 'memberId', row.member_id,
    'ciphertext', encode(row.ciphertext, 'base64'), 'nonce', encode(row.nonce, 'base64'));
end
$$;

create or replace function public.sign_out_server(p_server_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  row public.server_gate_tokens;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'servers.signOut');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'id', p_server_id::text, 'entity');
    return replay;
  end if;
  perform internal.require_human_auth_kind();
  row := internal.server_gate_own_row(p_server_id);
  perform internal.bind_actor(row.member_id);
  update public.server_gate_tokens
     set status = 'signed_out', ciphertext = null, nonce = null, expires_at = null
   where id = row.id;
  return internal.ledger_record(p_client_mutation_id, 'servers.signOut',
           internal.server_json(p_server_id, row.member_id));
end
$$;

-- Reachability, from a probe or a forward. Any home member on a human or agent
-- session (the forward runs as the agent); link, agent_runtime, null refuse.
-- Only the shared status column changes; no secret is touched.
create or replace function public.mark_server_reach(p_server_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me uuid;
begin
  if p_status not in ('reachable', 'unreachable', 'offline') then
    raise exception 'unknown reach status' using errcode = '22023';
  end if;
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli', 'agent') then
    raise exception 'this session kind cannot probe a server' using errcode = '42501';
  end if;
  me := internal.server_member(p_server_id);
  update public.servers set reach_status = p_status, reach_checked_at = now()
   where entity_id = p_server_id;
  return internal.server_json(p_server_id, me);
end
$$;

-- -----------------------------------------------------------------------------
-- 6. 044 is read-only. The functions stay (their grants and callers' error
--    paths are unchanged); every call refuses. The rows are not touched.
-- -----------------------------------------------------------------------------
create or replace function public.create_server_connection(
  p_name text,
  p_base_url text,
  p_username text default null,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  raise exception 'server_connections is read-only (044); add a server with servers.add'
    using errcode = '42501';
end
$$;

create or replace function public.delete_server_connection(
  p_name text,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  raise exception 'server_connections is read-only (044); remove a server with servers.remove'
    using errcode = '42501';
end
$$;

-- -----------------------------------------------------------------------------
-- 7. server_directory — Recent Spaces, the rail, the relay and the CLI read
--    this. security_invoker: each half keeps its own RLS (servers: readable
--    entity; server_connections: node admin).
-- -----------------------------------------------------------------------------

-- Has ANY server entity (live or soft-deleted, in any space) adopted this 044
-- row? Definer, so the answer does not depend on the reader's RLS on `servers`
-- (which hides soft-deleted rows and other spaces' servers). It takes only the
-- connection id and returns only a boolean, and it answers only callers who
-- pass 044's own read predicate (`internal.is_node_admin()`, 044's
-- server_connections_node_admin_select): anyone else gets false.
create or replace function internal.server_connection_adopted(p_connection_id uuid)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select internal.is_node_admin()
     and exists (select 1 from public.servers s where s.legacy_connection_id = p_connection_id)
$$;
revoke all on function internal.server_connection_adopted(uuid) from public;
grant execute on function internal.server_connection_adopted(uuid) to tm8_app;

create view public.server_directory with (security_invoker = true) as
  select s.entity_id as id, s.name, s.base_url, s.username, s.home_space_id,
         s.reach_status, false as legacy, s.created_at, s.updated_at
    from public.servers s
    join public.entities e on e.id = s.entity_id and e.deleted_at is null
  union all
  select sc.id, sc.name, sc.base_url, sc.username, null::uuid as home_space_id,
         'unknown'::text as reach_status, true as legacy, sc.created_at, sc.updated_at
    from public.server_connections sc
   where not internal.server_connection_adopted(sc.id);

grant select on public.server_directory to tm8_app;

-- -----------------------------------------------------------------------------
-- 8. Content hydration. SHARED OBJECT: 250's body verbatim (the composed
--     definer: 239's credential arm + 250's space_link arm); the `server` arm
--     is the only addition.
-- -----------------------------------------------------------------------------
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then return null; end if;
  if e.kind like 'c:%' then
    select jsonb_build_object('title', c.title, 'fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case e.kind
      when 'task' then select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'voice_channel' then select to_jsonb(v) - 'entity_id' into content from public.voice_channels v where v.entity_id = target;
      when 'artifact' then select to_jsonb(a) - 'entity_id' into content from public.artifacts a where a.entity_id = target;
      when 'memory' then select to_jsonb(m) - 'entity_id' into content from public.memories m where m.entity_id = target;
      when 'worktree' then select to_jsonb(w) - 'entity_id' into content from public.worktrees w where w.entity_id = target;
      when 'loop' then select to_jsonb(l) - 'entity_id' into content from public.loops l where l.entity_id = target;
      when 'graph' then select to_jsonb(g) - 'entity_id' into content from public.graphs g where g.entity_id = target;
      when 'chat' then select to_jsonb(c) - 'entity_id' - 'cwd' - 'native_session_id' - 'client_mutation_id'
                       into content from public.chats c where c.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      when 'container' then select to_jsonb(c) - 'entity_id' - 'runtime_ref' - 'host_spec'
                              into content from public.containers c where c.entity_id = target;
      when 'drawing' then select to_jsonb(d) - 'entity_id' into content from public.drawings d where d.entity_id = target;
      -- `-` binds tighter than `||`: the entity_id is dropped, THEN the
      -- ordered sections and questions are merged in.
      when 'form' then select to_jsonb(fm) - 'entity_id'
                              || jsonb_build_object('sections', internal.form_sections_json(target),
                                                    'questions', internal.form_questions_json(target))
                         into content from public.forms fm where fm.entity_id = target;
      -- An allow-list, never to_jsonb(sc): the row holds the sealed secret,
      -- the hint and the vendor login (§3a).
      when 'credential' then select to_jsonb(cc) - 'entity_id' into content from public.credential_cards cc where cc.entity_id = target;
      -- 250 (W6): the shared link's metadata. `space_links` holds no secret; the
      -- sealed per-member token is `space_link_tokens` (251) and has no arm.
      when 'space_link' then select to_jsonb(sl) - 'entity_id' into content from public.space_links sl where sl.entity_id = target;
      -- W8: the server's metadata. `servers` holds no secret; the sealed
      -- per-member gate session is `server_gate_tokens` and has no arm.
      when 'server' then select to_jsonb(sv) - 'entity_id' into content from public.servers sv where sv.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 8b. A server's lifecycle is command-owned, like a space link's (251 §10b).
--     A generic delete/restore/move of the `server` entity would end, revive
--     or re-home it without its gate rows, its link check or its ledger entry.
--     So 251's guard trigger is re-created here on 251's own definition with
--     'server' added to its kind list; the TS gate RESTRICTED_LIFECYCLE_KINDS
--     refuses it (and patch) before SQL. The trigger covers delete/restore/
--     move only; a generic patch or create of a `server` is already refused in
--     SQL by update_custom_entity/create_entity's kind check (22023), not by
--     this trigger. The trigger's list is {space_link, server}. The
--     third shared-object kind, credential, is refused in SQL by 239 instead
--     (its envelope guard trigger and the kind lists in 239's move/delete/
--     restore bodies), so it is not in this list; all three are in the TS set.
--
--     ONE ADDITION BEYOND THE KIND: servers.remove soft-deletes the entity
--     itself (space links never do; their envelope ends by cascade), so the
--     trigger lets a `server` row through while `tm8.server_lifecycle` is 'on'
--     — set only inside remove_server around its one UPDATE, the pattern of
--     239's tm8.credential_write and 057's worktree_transition. The
--     conjunct is scoped to kind 'server': the space_link path is unchanged.
--     No client can bind the setting (the claim bindings are a fixed set).
--
--     251's function internal.refuse_generic_link_lifecycle() is not redefined.
--     Adds-only: re-creating a trigger touches no row.
-- -----------------------------------------------------------------------------
drop trigger if exists entities_link_lifecycle_command_owned on public.entities;
create trigger entities_link_lifecycle_command_owned
before update of deleted_at, parent_id, position, space_id on public.entities
for each row
when (old.kind in ('space_link', 'server')
      and (new.deleted_at is distinct from old.deleted_at
           or new.parent_id is distinct from old.parent_id
           or new.position is distinct from old.position
           or new.space_id is distinct from old.space_id)
      and not (old.kind = 'server'
               and coalesce(internal.claim_text('tm8.server_lifecycle'), '') = 'on'))
execute function internal.refuse_generic_link_lifecycle();

-- -----------------------------------------------------------------------------
-- 9. Grants — full signatures.
-- -----------------------------------------------------------------------------
revoke all on function public.add_server(uuid, text, text, text, text) from public;
grant execute on function public.add_server(uuid, text, text, text, text) to tm8_app;
revoke all on function public.adopt_server_connection(uuid, text, text) from public;
grant execute on function public.adopt_server_connection(uuid, text, text) to tm8_app;
revoke all on function public.remove_server(uuid, text) from public;
grant execute on function public.remove_server(uuid, text) to tm8_app;
revoke all on function public.list_servers(uuid) from public;
revoke all on function public.get_server(uuid) from public;
grant execute on function public.get_server(uuid) to tm8_app;
grant execute on function public.list_servers(uuid) to tm8_app;
revoke all on function public.server_gate_seal_context(uuid) from public;
grant execute on function public.server_gate_seal_context(uuid) to tm8_app;
revoke all on function public.store_server_gate_token(uuid, timestamptz, bytea, bytea, text) from public;
grant execute on function public.store_server_gate_token(uuid, timestamptz, bytea, bytea, text) to tm8_app;
revoke all on function public.open_server_gate_token(uuid) from public;
grant execute on function public.open_server_gate_token(uuid) to tm8_app;
revoke all on function public.sign_out_server(uuid, text) from public;
grant execute on function public.sign_out_server(uuid, text) to tm8_app;
revoke all on function public.mark_server_reach(uuid, text) from public;
grant execute on function public.mark_server_reach(uuid, text) to tm8_app;

reset role;

-- Never-analyzed tables are estimated at 10 pages (225); 229's precedent.
analyze public.servers;
analyze public.server_gate_tokens;
