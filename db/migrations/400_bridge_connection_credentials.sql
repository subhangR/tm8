-- =============================================================================
-- 400 — Bridges B1b-5: a connection is offered to a space as a credential.
-- (Provisional number; the bridges merger assigns the final one.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md (FINAL v4)
-- §2.5 (connections are credentials), §3.4 (bridges.connections.* rows), D28,
-- D32. Task 01a18acb-bc91-79cb-ae6b-cea56a581e4f.
--
-- Predecessor: 395_bridge_schema.sql (B0a). Nothing here touches 396's
-- authored_from index.
--
-- WHAT THIS FILE DOES
--   §1  space_credentials learns the server-only provider `whatsapp` with the
--       shape `connection`: no secret bytes in any column (the device keys are
--       sealed on the node, §2.5), metadata `bridge_connection_id`, one live
--       offer per (connection, space), never a default. The spawn reader
--       already refuses every server-only provider (271/290), so adding it to
--       internal.is_server_only_credential_provider is what keeps a connection
--       out of every session;
--   §2  the doors: begin (a new connection, or relinking one), offer and
--       withdraw, and the owner's list;
--   §3  withdrawing (or revoking through credentials.space.*) pauses every
--       live bridge on that credential in that space, and a bridge on a
--       withdrawn credential cannot be resumed;
--   §4  bridges.credential_id is filled from the offered credential at
--       bridges.create (D32), backfilled for B0a's rows, and becomes NOT NULL.
--
-- REFUSALS. TBC01 -> `conflict` with details.reason (395): `already_offered`,
-- `not_offered`, `connection_not_offered`, `connection_withdrawn`. Ownership
-- and membership are 42501 with reason `not_connection_owner` /
-- `not_space_member`.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. The credential.
-- -----------------------------------------------------------------------------

-- Server-only (271): never handed to a launch, refused by the spawn reader in
-- SQL before anything is read, and session_space_credentials cannot hold one.
create or replace function internal.is_server_only_credential_provider(p_provider text)
returns boolean language sql immutable as $$ select coalesce(p_provider in ('typesafe','mcp','tool','whatsapp'),false) $$;

alter table public.space_credentials
  add column bridge_connection_id uuid references public.bridge_connections(id) on delete restrict,
  drop constraint space_credentials_provider_check,
  add constraint space_credentials_provider_check
    check (provider in ('anthropic','openai','github','typesafe','mcp','tool','whatsapp')),
  drop constraint space_credentials_shape_check,
  add constraint space_credentials_shape_check
    check (shape in ('login','api_key','token','connection')),
  drop constraint space_credentials_provider_shape_check,
  add constraint space_credentials_provider_shape_check check (
    (provider='github' and shape='token') or (provider in ('anthropic','openai') and shape in ('login','api_key'))
    or (provider='typesafe' and shape='api_key') or (provider='mcp' and shape in ('api_key','token'))
    or (provider='tool' and shape='api_key') or (provider='whatsapp' and shape='connection')),
  -- A connection's bytes are a node-sealed directory, never a column (§2.5),
  -- exactly like a login's.
  drop constraint space_credentials_secret_shape_check,
  add constraint space_credentials_secret_shape_check
    check (case
      when shape in ('login','connection') then
        secret_ciphertext is null and secret_nonce is null and key_hint is null
      when status = 'revoked' then
        secret_ciphertext is null and secret_nonce is null
      else
        secret_ciphertext is not null and secret_nonce is not null and key_hint is not null
    end),
  -- The metadata is the connection, and only a connection carries it.
  add constraint space_credentials_connection_check
    check ((shape = 'connection') = (bridge_connection_id is not null)),
  -- A connection is chosen per bridge by its owner (D28), never by default.
  add constraint space_credentials_connection_never_default
    check (shape <> 'connection' or not is_default);

-- §2.6: one offered credential per (connection, space).
create unique index space_credentials_one_live_offer
  on public.space_credentials(bridge_connection_id, space_id)
  where bridge_connection_id is not null and status <> 'revoked';

comment on column public.space_credentials.bridge_connection_id is
  '400 (Bridges §2.5): the node-level connection this space credential offers. '
  'Set exactly when shape = connection; the bytes stay sealed on the node.';

-- -----------------------------------------------------------------------------
-- §2. The doors.
-- -----------------------------------------------------------------------------

-- The connection as its owner sees it, with the spaces it is offered to.
-- state_ref is never in it.
create or replace function internal.bridge_connection_json(c public.bridge_connections)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', c.id, 'provider', c.provider, 'ownerAccountId', c.owner_account_id, 'label', c.label,
    'externalAccountId', c.external_account_id, 'status', c.status, 'runtimeId', c.runtime_id,
    'createdAt', c.created_at, 'lastSeenAt', c.last_seen_at,
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'credentialId', sc.id, 'spaceId', sc.space_id, 'visibility', sc.visibility,
               'status', sc.status, 'createdAt', sc.created_at,
               'bridges', (select count(*) from public.bridges b
                            where b.credential_id = sc.id and b.ended_at is null))
             order by sc.created_at, sc.id)
        from public.space_credentials sc
       where sc.bridge_connection_id = c.id and sc.status <> 'revoked'), '[]'::jsonb))
$$;
revoke all on function internal.bridge_connection_json(public.bridge_connections) from public;

-- The caller's own connection, for a door that changes it.
create or replace function internal.bridge_own_connection(p_connection_id uuid)
returns public.bridge_connections language plpgsql set search_path = public, internal, pg_temp as $$
declare conn public.bridge_connections;
begin
  select * into conn from public.bridge_connections where id = p_connection_id for update;
  if conn.id is null then
    raise exception 'bridge connection not found' using errcode = 'P0002';
  end if;
  if conn.owner_account_id is distinct from internal.current_account_id() then
    raise exception 'only the connection''s owner can do this' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_connection_owner')::text;
  end if;
  if conn.status = 'removed' then
    raise exception 'this connection was removed' using errcode = '22023';
  end if;
  return conn;
end
$$;
revoke all on function internal.bridge_own_connection(uuid) from public;

-- bridges.connections.list: the owner's connections; node admins see all (§3.4).
create or replace function public.list_bridge_connections(p_provider text default null)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare account uuid;
begin
  perform internal.require_identity();
  account := internal.current_account_id();
  return coalesce((
    select jsonb_agg(internal.bridge_connection_json(c) order by c.created_at, c.id)
      from public.bridge_connections c
     where (c.owner_account_id = account or internal.is_node_admin())
       and (p_provider is null or c.provider = p_provider)
       and c.status <> 'removed'), '[]'::jsonb);
end
$$;
revoke all on function public.list_bridge_connections(text) from public;
grant execute on function public.list_bridge_connections(text) to tm8_app;

-- bridges.connections.begin (human-only): a new connection owned by the caller,
-- or (p_connection_id) relinking one of the caller's own. The row only; the
-- server then asks the runtime to connect, and the QR or pairing code goes to
-- the caller's own sockets and is never stored (§2.5, §7.3 item 8).
create or replace function public.begin_bridge_connection(
  p_provider text,
  p_label text default null,
  p_connection_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; account uuid; conn public.bridge_connections;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.connections.begin');
  if replay is not null then return replay; end if;
  account := internal.current_account_id();
  if account is null then
    raise exception 'no active account for this identity' using errcode = 'P0002';
  end if;
  if p_provider is distinct from 'whatsapp' then
    raise exception 'no connector runtime for % yet; whatsapp is the one provider today', coalesce(p_provider, 'null')
      using errcode = '22023';
  end if;
  if p_connection_id is null then
    insert into public.bridge_connections(provider, owner_account_id, label, status)
    values (p_provider, account, coalesce(nullif(btrim(p_label), ''), 'WhatsApp'), 'connecting')
    returning * into conn;
  else
    conn := internal.bridge_own_connection(p_connection_id);
    if conn.provider <> p_provider then
      raise exception 'this connection is a % connection', conn.provider using errcode = '22023';
    end if;
    update public.bridge_connections
       set status = 'connecting', label = coalesce(nullif(btrim(p_label), ''), label)
     where id = conn.id
    returning * into conn;
  end if;
  return internal.ledger_record(p_client_mutation_id, 'bridges.connections.begin',
    internal.bridge_connection_json(conn));
end
$$;
revoke all on function public.begin_bridge_connection(text, text, uuid, text) from public;
grant execute on function public.begin_bridge_connection(text, text, uuid, text) to tm8_app;

-- bridges.connections.offer (the owner, human-only, an active member of the
-- space): the `credential` entity provider whatsapp, shape connection (§2.5).
create or replace function public.offer_bridge_connection(
  p_connection_id uuid,
  p_space_id uuid,
  p_visibility text default 'public',
  p_label text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; conn public.bridge_connections; member uuid; existing uuid; new_id uuid;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.connections.offer');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  conn := internal.bridge_own_connection(p_connection_id);
  -- Numbers belong to the member who links them (§2.5): only into a space
  -- the owner is an active member of.
  member := internal.current_member_id(p_space_id);
  if member is null then
    raise exception 'you can offer a connection only to a space you are a member of' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_space_member')::text;
  end if;
  if p_visibility is null or p_visibility not in ('private', 'public') then
    raise exception 'visibility is private or public' using errcode = '22023';
  end if;
  select id into existing from public.space_credentials
   where bridge_connection_id = conn.id and space_id = p_space_id and status <> 'revoked';
  if existing is not null then
    perform internal.bridge_refuse('already_offered', 'this connection is already offered to this space',
      jsonb_build_object('credentialId', existing));
  end if;

  -- Offered again after a withdraw: the same credential comes back, so the
  -- bridges that ride it (paused by the withdraw) can be resumed. It holds no
  -- bytes, so nothing revoked is revived.
  select id into new_id from public.space_credentials
   where bridge_connection_id = conn.id and space_id = p_space_id and status = 'revoked'
   order by updated_at desc, id limit 1
   for update;
  if new_id is not null then
    update public.space_credentials
       set status = 'active', status_reason = null, visibility = p_visibility, last_probe_at = now(),
           label = internal.require_space_credential_label(coalesce(nullif(btrim(p_label), ''), conn.label)),
           display_login = conn.external_account_id
     where id = new_id;
    return internal.ledger_record(p_client_mutation_id, 'bridges.connections.offer',
      internal.command_result(new_id, null,
        internal.record_activity(p_space_id, new_id, member, 'updated', null,
          jsonb_build_object('kind', 'credential', 'op', 'bridges.connections.offer', 'connectionId', conn.id)),
        array[new_id]));
  end if;

  new_id := internal.new_id();
  perform internal.insert_credential_entity(new_id, p_space_id, member);
  insert into public.space_credentials(
    id, space_id, provider, shape, label, status,
    created_by_account_id, created_by_identity_id, display_login, last_probe_at,
    owner_account_id, visibility, may_be_space_default, space_owned_chosen, bridge_connection_id
  ) values (
    new_id, p_space_id, conn.provider, 'connection',
    internal.require_space_credential_label(coalesce(nullif(btrim(p_label), ''), conn.label)), 'active',
    conn.owner_account_id, internal.identity_id(), conn.external_account_id, now(),
    conn.owner_account_id, p_visibility, false, false, conn.id);
  return internal.ledger_record(p_client_mutation_id, 'bridges.connections.offer',
    internal.command_result(new_id, null,
      internal.record_activity(p_space_id, new_id, member, 'created', null,
        jsonb_build_object('kind', 'credential', 'provider', conn.provider, 'connectionId', conn.id)),
      array[new_id]));
end
$$;
revoke all on function public.offer_bridge_connection(uuid, uuid, text, text, text) from public;
grant execute on function public.offer_bridge_connection(uuid, uuid, text, text, text) to tm8_app;

-- bridges.connections.withdraw (the owner, human-only): revokes the space's
-- credential; §3's trigger pauses every bridge on it. The owner need not be a
-- member any more: withdrawing after leaving is how they take their number back.
create or replace function public.withdraw_bridge_connection(
  p_connection_id uuid,
  p_space_id uuid,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; conn public.bridge_connections; cred uuid; paused uuid[]; actor uuid;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.connections.withdraw');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  select * into conn from public.bridge_connections where id = p_connection_id for update;
  if conn.id is null then
    raise exception 'bridge connection not found' using errcode = 'P0002';
  end if;
  if conn.owner_account_id is distinct from internal.current_account_id() then
    raise exception 'only the connection''s owner can withdraw it' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_connection_owner')::text;
  end if;
  select id into cred from public.space_credentials
   where bridge_connection_id = conn.id and space_id = p_space_id and status <> 'revoked'
   for update;
  if cred is null then
    perform internal.bridge_refuse('not_offered', 'this connection is not offered to this space');
  end if;
  select coalesce(array_agg(entity_id order by entity_id), '{}') into paused from public.bridges
   where credential_id = cred and ended_at is null and paused_at is null;
  update public.space_credentials set status = 'revoked', status_reason = null where id = cred;
  actor := coalesce(internal.current_member_id(p_space_id),
                    (select created_by from public.entities where id = cred));
  return internal.ledger_record(p_client_mutation_id, 'bridges.connections.withdraw',
    internal.command_result(cred, null,
      internal.record_activity(p_space_id, cred, actor, 'updated', null,
        jsonb_build_object('kind', 'credential', 'op', 'bridges.connections.withdraw', 'connectionId', conn.id,
                           'pausedBridges', to_jsonb(paused))),
      array[cred] || paused));
end
$$;
revoke all on function public.withdraw_bridge_connection(uuid, uuid, text) from public;
grant execute on function public.withdraw_bridge_connection(uuid, uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §3. Withdrawn means paused, by every path that revokes the credential.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_credential_revoked() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  update public.bridges set paused_at = now()
   where credential_id = new.id and ended_at is null and paused_at is null;
  return null;
end
$$;
revoke all on function internal.bridge_credential_revoked() from public;
create trigger space_credentials_bridge_pause
  after update of status on public.space_credentials
  for each row when (new.shape = 'connection' and new.status = 'revoked' and old.status is distinct from 'revoked')
  execute function internal.bridge_credential_revoked();

-- -----------------------------------------------------------------------------
-- §4. The bridge rides its offered credential (D32).
-- -----------------------------------------------------------------------------

-- Backfill B0a's rows before the guard below fixes credential_id: one offer
-- per (connection, space) a bridge already rides,
-- owned by the connection's owner and created as the first bridge's creator.
-- A withdrawn-looking state does not exist yet, so each is active.
do $$
declare r record; new_id uuid;
begin
  for r in
    select b.connection_id, b.space_id, c.owner_account_id, c.provider, c.label, c.external_account_id,
           (array_agg(e.created_by order by b.created_at))[1] as creator,
           (select a.identity_id from public.accounts a where a.id = c.owner_account_id) as owner_identity
      from public.bridges b
      join public.bridge_connections c on c.id = b.connection_id
      join public.entities e on e.id = b.entity_id
     where b.credential_id is null
     group by b.connection_id, b.space_id, c.owner_account_id, c.provider, c.label, c.external_account_id
  loop
    select id into new_id from public.space_credentials
     where bridge_connection_id = r.connection_id and space_id = r.space_id and status <> 'revoked';
    if new_id is null then
      new_id := internal.new_id();
      perform internal.insert_credential_entity(new_id, r.space_id, r.creator);
      insert into public.space_credentials(
        id, space_id, provider, shape, label, status, created_by_account_id, created_by_identity_id,
        display_login, last_probe_at, owner_account_id, visibility, may_be_space_default, space_owned_chosen,
        bridge_connection_id)
      values (new_id, r.space_id, r.provider, 'connection', left(btrim(r.label), 80), 'active',
              r.owner_account_id, r.owner_identity, r.external_account_id, now(), r.owner_account_id,
              'public', false, false, r.connection_id);
    end if;
    -- A tombstone is filled too: none of the bridge's fixed fields change.
    update public.bridges set credential_id = new_id
     where connection_id = r.connection_id and space_id = r.space_id and credential_id is null;
  end loop;
end
$$;

-- Insert: fill credential_id from the live offer for (connection, space);
-- refuse a connection that is not offered there. Update: the credential is
-- fixed, and a bridge on a withdrawn credential stays paused. Named to sort
-- before bridges_guard, so the guard sees the filled row.
create or replace function internal.bridge_credential_guard() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare cred public.space_credentials;
begin
  if tg_op = 'INSERT' then
    if new.credential_id is null then
      select * into cred from public.space_credentials
       where bridge_connection_id = new.connection_id and space_id = new.space_id and status <> 'revoked';
      if cred.id is null then
        perform internal.bridge_refuse('connection_not_offered',
          'offer this connection to the space first: tm8 bridge connection offer <connection-id> --space <space-id>',
          jsonb_build_object('connectionId', new.connection_id));
      end if;
      new.credential_id := cred.id;
    else
      select * into cred from public.space_credentials where id = new.credential_id;
      if cred.id is null or cred.bridge_connection_id is distinct from new.connection_id
         or cred.space_id <> new.space_id or cred.status = 'revoked' then
        raise exception 'a bridge rides the credential offered for its connection in its space' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  if new.credential_id is distinct from old.credential_id then
    raise exception 'a bridge''s credential is fixed' using errcode = '42501';
  end if;
  if old.paused_at is not null and new.paused_at is null and new.ended_at is null
     and exists (select 1 from public.space_credentials sc where sc.id = new.credential_id and sc.status = 'revoked') then
    perform internal.bridge_refuse('connection_withdrawn',
      'this bridge''s connection was withdrawn from the space; its owner can offer it again, then resume');
  end if;
  return new;
end
$$;
revoke all on function internal.bridge_credential_guard() from public;
create trigger bridges_credential before insert or update on public.bridges
  for each row execute function internal.bridge_credential_guard();

alter table public.bridges alter column credential_id set not null;

comment on column public.bridges.credential_id is
  '400 (D32): the space credential (shape connection) offered for this bridge''s connection in its space; '
  'filled at bridges.create, fixed after.';

reset role;

analyze public.space_credentials, public.bridges;
