-- =============================================================================
-- 392 — devices: the phones that get a person's push notifications from this
-- node (TM8 Mobile S1, task 01a1867c; design s-lld §11 "Registration" and the
-- §19 "Device registration" row).
--
-- THE MODEL IN ONE BREATH. One row is one SIGN-IN on one phone: the person
-- (identity_id, a node account), the root auth session of that sign-in, and
-- what the relay needs to reach the phone. `devices.register` (POST
-- /v2/devices) creates or refreshes the row of the calling sign-in and answers
-- {deviceId}; `devices.update` (PUT /v2/devices/:deviceId) rotates the token or
-- changes previews, quietUntil, locale, appVersion or label;
-- `devices.unregister` (DELETE /v2/devices/:deviceId) is the first step of the
-- app's sign-out. Not an entity: no space, no edges, no events, so a device is
-- private by construction and appears in no entity list, feed, search or
-- socket. Per server and person, never per space (a pinned session registers
-- for its gate sign-in).
--
-- SECURITY POSTURE (203's, applied to a push token):
--   * WHO. Human sessions only: internal.require_human_auth_kind() here, and
--     requireHumanSession at the facade (catalog humanOnly). An agent carries
--     its human's identity, so a member-scoped door alone would let it bind a
--     token it controls and read that human's notifications off a relay.
--   * WHAT IS STORED. The token is a credential (whoever holds it can put a
--     notification on that phone), so it is never stored as text. The server
--     seals it with AES-256-GCM under the node key (devices/device-token.ts),
--     AAD 'push-device|<identity_id>|<token_hash>', and SQL only ever sees
--     token_hash (sha256 hex), token_ciphertext and token_nonce. tm8_app gets a
--     COLUMN-LEVEL select grant that omits all three, and no DML at all. No
--     result, ledger row or error message carries any of them.
--   * WHO SEES A ROW. RLS shows tm8_app only the caller's own rows. Every write
--     is a SECURITY DEFINER door below that derives the owner from the bound
--     identity and takes no owner parameter; another person's device id is
--     not_found on update and "nothing to unregister" on unregister, so its
--     existence never leaks.
--   * REVOCATION. auth_session_id is the ROOT (gate) session of the sign-in
--     that registered the row: coalesce(parent_session_id, id), so a space
--     admin revoking one pinned session leaves it alone. When that session is
--     revoked (auth.logout, auth.sessions.revoke, a password change, an
--     account disabled: every path sets auth_sessions.revoked_at) the trigger
--     at the end deletes the row, and the FK deletes it with the session. A
--     signed-out or stolen phone therefore stops receiving pushes the moment
--     its sign-in ends, even if the phone never called devices.unregister.
--     Expiry writes nothing, so a reader must also require the session to be
--     live (see "S6" below); register sweeps the caller's expired rows.
--
-- UNIQUENESS. One row per sign-in (auth_session_id) and one per (person,
-- token): the same phone token registered from a newer sign-in of the same
-- person replaces the older row, so nobody gets the same push twice. Across
-- people a token is never matched: no write here touches another person's row.
--
-- S6 (push dispatch, migration 393) reads this table from its own two
-- SECURITY DEFINER functions only: (id, identity_id, platform, token_hash,
-- token_ciphertext, token_nonce, previews, locale, quiet_until) joined to
-- auth_sessions s ON s.id = auth_session_id AND s.revoked_at IS NULL AND
-- s.expires_at > now(); the worker opens the token in-process with
-- openDeviceToken and deletes a dead one WHERE id = $1 AND token_hash = $2.
--
-- NUMBERED 392 by the TM8 Mobile Lead (2026-10-29): main's tip is 389, 390 is
-- the Tools effort's unmerged PR-E, 391 is S4 (mobile auth kind).
-- =============================================================================
set local lock_timeout = '5s';

set role tm8_graph_owner;

create table if not exists public.devices (
  id               uuid primary key default internal.new_id(),
  identity_id      text not null references public.accounts(identity_id) on delete cascade,
  auth_session_id  uuid not null references public.auth_sessions(id) on delete cascade,
  platform         text not null,
  relay            text not null,
  token_hash       text not null,
  token_ciphertext bytea not null,
  token_nonce      bytea not null,
  app_version      text not null,
  locale           text not null,
  previews         text not null default 'sender',
  label            text not null,
  quiet_until      timestamptz,
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint devices_platform_check check (platform in ('ios', 'android')),
  constraint devices_relay_check check (relay in ('expo')),
  constraint devices_token_hash_check check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint devices_token_ciphertext_check check (octet_length(token_ciphertext) between 17 and 4096),
  constraint devices_token_nonce_check check (octet_length(token_nonce) = 12),
  constraint devices_app_version_check check (char_length(btrim(app_version)) between 1 and 64),
  constraint devices_locale_check check (locale ~ '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,6}$'),
  constraint devices_previews_check check (previews in ('full', 'sender', 'none')),
  constraint devices_label_check check (char_length(btrim(label)) between 1 and 200),
  constraint devices_version_check check (version > 0),
  constraint devices_one_per_sign_in unique (auth_session_id),
  constraint devices_one_per_token unique (identity_id, token_hash)
);

comment on table public.devices is
  'Phones that get a person''s push notifications from this node, one row per sign-in '
  '(392, TM8 Mobile S1). The token is AES-256-GCM sealed by the server; token_hash, '
  'token_ciphertext and token_nonce are never granted to tm8_app. Revoking the root '
  'auth session deletes the row. Read the 392 header before changing a column, '
  'policy, grant or door.';

drop trigger if exists devices_touch_updated_at on public.devices;
create trigger devices_touch_updated_at before update on public.devices
for each row execute function internal.touch_updated_at();

alter table public.devices enable row level security;
drop policy if exists devices_owner_select on public.devices;
create policy devices_owner_select on public.devices for select to tm8_app
  using (identity_id = internal.identity_id());

revoke all on public.devices from public;
grant select (id, identity_id, auth_session_id, platform, relay, app_version, locale,
              previews, label, quiet_until, version, created_at, updated_at)
  on public.devices to tm8_app;

-- -----------------------------------------------------------------------------
-- What a door returns about a device: everything but the token.
-- -----------------------------------------------------------------------------
create or replace function internal.device_json(d public.devices)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', d.id,
    'platform', d.platform,
    'relay', d.relay,
    'appVersion', d.app_version,
    'locale', d.locale,
    'previews', d.previews,
    'label', d.label,
    'quietUntil', d.quiet_until,
    'version', d.version,
    'createdAt', d.created_at,
    'updatedAt', d.updated_at)
$$;

revoke all on function internal.device_json(public.devices) from public;

-- -----------------------------------------------------------------------------
-- The live root session of the calling sign-in, or 42501. The claim comes off
-- the verified session row (claims.ts); the loopback owner has none, and a
-- device registration that no sign-out can end is not one this door makes.
-- -----------------------------------------------------------------------------
create or replace function internal.device_sign_in(p_identity text)
returns public.auth_sessions
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  caller public.auth_sessions;
  root public.auth_sessions;
begin
  select s.* into caller from public.auth_sessions s
   where s.id = nullif(internal.claim_text('tm8.auth_session_id'), '')::uuid
     and s.revoked_at is null and s.expires_at > now();
  if caller.id is null then
    raise exception 'a device registers from a signed-in session; this caller has none'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.accounts a
                  where a.id = caller.account_id and a.identity_id = p_identity and a.status = 'active') then
    raise exception 'a device registers from a signed-in session; this caller has none'
      using errcode = '42501';
  end if;
  if caller.parent_session_id is null then
    return caller;
  end if;
  select s.* into root from public.auth_sessions s
   where s.id = caller.parent_session_id and s.account_id = caller.account_id
     and s.revoked_at is null and s.expires_at > now();
  if root.id is null then
    raise exception 'the sign-in this session belongs to has ended' using errcode = '42501';
  end if;
  return root;
end
$$;

revoke all on function internal.device_sign_in(text) from public;

-- -----------------------------------------------------------------------------
-- devices.register. Creates the calling sign-in's row, or refreshes it in
-- place (same deviceId, version + 1). The token arrives sealed.
-- -----------------------------------------------------------------------------
create or replace function public.register_device(
  p_platform text, p_relay text,
  p_token_hash text, p_token_ciphertext bytea, p_token_nonce bytea,
  p_app_version text, p_locale text, p_previews text, p_label text,
  p_quiet_until timestamptz default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  identity text;
  sign_in public.auth_sessions;
  d public.devices;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'devices.register');
  if replay is not null then return replay; end if;
  identity := internal.require_identity();
  sign_in := internal.device_sign_in(identity);

  if p_platform is null or p_relay is null or p_token_hash is null or p_token_ciphertext is null
     or p_token_nonce is null or p_app_version is null or p_locale is null or p_label is null then
    raise exception 'a device needs platform, relay, token, appVersion, locale and label'
      using errcode = '22023';
  end if;

  -- One writer per person at a time, so the cap and the token rule below
  -- cannot be raced by two registrations.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('devices:' || identity, 0));

  -- The caller's own rows whose sign-in expired: they can never be pushed to.
  delete from public.devices d0
   using public.auth_sessions s
   where d0.identity_id = identity and s.id = d0.auth_session_id and s.expires_at <= now();
  -- The same phone token from an older sign-in of this person is superseded.
  delete from public.devices
   where identity_id = identity and token_hash = p_token_hash and auth_session_id <> sign_in.id;

  if not exists (select 1 from public.devices where auth_session_id = sign_in.id)
     and (select count(*) from public.devices where identity_id = identity) >= 50 then
    raise exception 'device limit reached (50 per person): sign out of a phone you no longer use'
      using errcode = '53400';
  end if;

  insert into public.devices as cur (
    identity_id, auth_session_id, platform, relay, token_hash, token_ciphertext, token_nonce,
    app_version, locale, previews, label, quiet_until)
  values (
    identity, sign_in.id, p_platform, p_relay, p_token_hash, p_token_ciphertext, p_token_nonce,
    btrim(p_app_version), p_locale, coalesce(p_previews, 'sender'), btrim(p_label), p_quiet_until)
  on conflict (auth_session_id) do update
     set platform = excluded.platform,
         relay = excluded.relay,
         token_hash = excluded.token_hash,
         token_ciphertext = excluded.token_ciphertext,
         token_nonce = excluded.token_nonce,
         app_version = excluded.app_version,
         locale = excluded.locale,
         previews = excluded.previews,
         label = excluded.label,
         quiet_until = excluded.quiet_until,
         version = cur.version + 1
  returning * into d;

  return internal.ledger_record(p_client_mutation_id, 'devices.register',
           jsonb_build_object('deviceId', d.id, 'device', internal.device_json(d)));
end
$$;

-- -----------------------------------------------------------------------------
-- devices.update. Every argument but the id and the version is optional: null
-- keeps the stored value. The token is all three of hash, ciphertext and nonce
-- or none of them. quiet_until needs its own flag, because null CLEARS it.
-- The row stays bound to the sign-in that registered it, whoever updates it.
-- -----------------------------------------------------------------------------
create or replace function public.update_device(
  p_id uuid, p_expected_version integer,
  p_token_hash text default null, p_token_ciphertext bytea default null, p_token_nonce bytea default null,
  p_app_version text default null, p_locale text default null,
  p_previews text default null, p_label text default null,
  p_set_quiet_until boolean default false, p_quiet_until timestamptz default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  identity text;
  d public.devices;
  token_parts integer;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'devices.update');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'deviceId', p_id::text, 'device');
    return replay;
  end if;
  identity := internal.require_identity();

  if p_expected_version is null then
    raise exception 'devices.update needs expectedVersion' using errcode = '22023';
  end if;
  token_parts := (p_token_hash is not null)::integer + (p_token_ciphertext is not null)::integer
               + (p_token_nonce is not null)::integer;
  if token_parts not in (0, 3) then
    raise exception 'a new token is its hash, ciphertext and nonce together' using errcode = '22023';
  end if;

  select * into d from public.devices
   where id = p_id and identity_id = identity for update;
  if d.id is null then
    raise exception 'device % not found', p_id using errcode = 'P0002';
  end if;
  if d.version <> p_expected_version then
    raise exception 'version conflict on device %', p_id
      using errcode = '40001',
            detail = jsonb_build_object('deviceId', p_id, 'currentVersion', d.version,
                                        'current', internal.device_json(d))::text;
  end if;

  if token_parts = 3 then
    perform pg_advisory_xact_lock(pg_catalog.hashtextextended('devices:' || identity, 0));
    delete from public.devices
     where identity_id = identity and token_hash = p_token_hash and id <> p_id;
  end if;

  update public.devices
     set token_hash = coalesce(p_token_hash, token_hash),
         token_ciphertext = coalesce(p_token_ciphertext, token_ciphertext),
         token_nonce = coalesce(p_token_nonce, token_nonce),
         app_version = coalesce(btrim(p_app_version), app_version),
         locale = coalesce(p_locale, locale),
         previews = coalesce(p_previews, previews),
         label = coalesce(btrim(p_label), label),
         quiet_until = case when p_set_quiet_until then p_quiet_until else quiet_until end,
         version = version + 1
   where id = p_id
  returning * into d;

  return internal.ledger_record(p_client_mutation_id, 'devices.update',
           jsonb_build_object('deviceId', d.id, 'device', internal.device_json(d)));
end
$$;

-- -----------------------------------------------------------------------------
-- devices.unregister. Idempotent, because it is the first step of sign-out and
-- must not fail on a row the revoke trigger or a dead-token report already
-- removed: a missing row, and another person's, both answer unregistered:
-- false. A given expectedVersion is checked; sign-out sends none.
-- -----------------------------------------------------------------------------
create or replace function public.unregister_device(
  p_id uuid, p_expected_version integer default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  identity text;
  d public.devices;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'devices.unregister');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'deviceId', p_id::text, 'device');
    return replay;
  end if;
  identity := internal.require_identity();

  select * into d from public.devices
   where id = p_id and identity_id = identity for update;
  if d.id is not null and p_expected_version is not null and d.version <> p_expected_version then
    raise exception 'version conflict on device %', p_id
      using errcode = '40001',
            detail = jsonb_build_object('deviceId', p_id, 'currentVersion', d.version,
                                        'current', internal.device_json(d))::text;
  end if;
  if d.id is not null then
    delete from public.devices where id = p_id;
  end if;

  return internal.ledger_record(p_client_mutation_id, 'devices.unregister',
           jsonb_build_object('deviceId', p_id, 'unregistered', d.id is not null));
end
$$;

revoke all on function public.register_device(text, text, text, bytea, bytea, text, text, text, text, timestamptz, text) from public;
revoke all on function public.update_device(uuid, integer, text, bytea, bytea, text, text, text, text, boolean, timestamptz, text) from public;
revoke all on function public.unregister_device(uuid, integer, text) from public;
grant execute on function public.register_device(text, text, text, bytea, bytea, text, text, text, text, timestamptz, text) to tm8_app;
grant execute on function public.update_device(uuid, integer, text, bytea, bytea, text, text, text, text, boolean, timestamptz, text) to tm8_app;
grant execute on function public.unregister_device(uuid, integer, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- Revocation. Every way a session ends sets auth_sessions.revoked_at, so one
-- row trigger covers them all; a column trigger with a WHEN clause, so the
-- last_used_at touch on every request never fires it.
-- -----------------------------------------------------------------------------
create or replace function internal.devices_drop_for_revoked_session()
returns trigger language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  delete from public.devices where auth_session_id = new.id;
  return null;
end
$$;

revoke all on function internal.devices_drop_for_revoked_session() from public;

drop trigger if exists auth_sessions_revoke_devices on public.auth_sessions;
create trigger auth_sessions_revoke_devices
after update of revoked_at on public.auth_sessions
for each row when (old.revoked_at is null and new.revoked_at is not null)
execute function internal.devices_drop_for_revoked_session();

comment on function public.register_device(text, text, text, bytea, bytea, text, text, text, text, timestamptz, text) is
  'devices.register (392): the calling human sign-in''s device row, created or refreshed in '
  'place. Takes the token sealed (hash, ciphertext, nonce); returns {deviceId, device} with no token.';
comment on function public.update_device(uuid, integer, text, bytea, bytea, text, text, text, text, boolean, timestamptz, text) is
  'devices.update (392): rotate the token or change previews, quietUntil, locale, appVersion or '
  'label on the caller''s own device. null keeps a value; p_set_quiet_until with null clears quiet_until.';
comment on function public.unregister_device(uuid, integer, text) is
  'devices.unregister (392): idempotent removal of the caller''s own device; another person''s '
  'id answers unregistered: false, exactly like a missing one.';

reset role;
