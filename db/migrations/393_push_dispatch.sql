-- =============================================================================
-- 393 · PUSH DISPATCH: notification.created → the push relay
--       (TM8 Mobile S6, task 01a1867c-d1bf; s-lld §11, decide Q5).
--
-- WHAT THIS ADDS. A notification row for a person with a registered phone is
-- queued once on `public.notification_outbox` (channel 'push', the transport-
-- agnostic queue 003 built for exactly this and left empty), claimed by the
-- in-process push worker, sent to the relay (Expo Push Service, Q5) and settled.
-- The relay's tickets are kept for 24 hours in `public.push_tickets`, so the
-- receipt pass can act on what the relay reports later. A device the relay
-- reports dead (`DeviceNotRegistered`, in a ticket or a receipt) is deleted.
--
-- THE JOIN WITH S1. `public.devices` and its rules belong to 392 (S1). This
-- file reads and writes that table in exactly two functions, §2, and nowhere
-- else:
--   * internal.push_devices_for(identity) — a person's live devices, sealed
--     token included, for the worker to open in-process (the key never reaches
--     SQL). Live means the root auth session that registered the device is
--     neither revoked nor expired: 392 deletes the row on revoke, and expiry
--     writes nothing it could hook.
--   * internal.delete_push_device(id, token_hash) — the dead-token delete.
--     Matching the hash read when the push was sent means a token the phone has
--     since rotated (devices.update) is never deleted by a stale report.
-- Both are plpgsql, so this file applies with or without 392 present; on main
-- 392 always applies first.
--
-- WHO MAY CALL. Only the push worker: `internal.is_push_worker()` is node-admin
-- claims AND `tm8.background_job = 'push.dispatch'` (db/types.ts' closed list,
-- bound by db/client.ts for the in-process scheduler job and never from a
-- request) AND no space pin — the 306/375 pattern. A node admin over HTTP is not
-- the push worker: it gets 42501 from every door here, so no request can read a
-- sealed token or delete a device. The two join functions have no EXECUTE for
-- anyone but their owner; the four doors in §4 are tm8_app's only way in.
--
-- WHAT IT STORES. The outbox row holds ids, a counter and a scrubbed error line;
-- a ticket row holds the relay's ticket id, the device id and the token's
-- sha256. No token, no notification text: the text is built in the worker from
-- the recipient's own inbox read, under the recipient's own claims, and handed
-- to the relay without being stored. Neither table is readable by tm8_app (RLS
-- on, no policy, no grant), like the rest of 003's queue.
--
-- WHICH ROWS. The member's own inbox only: `recipient_team_member_id IS NULL`,
-- the rows `inbox.list` shows by default. Unread, created inside the last
-- `p_window_seconds` (so a node that was down does not fire an hour of stale
-- pushes on boot, and the first boot after this migration does not push the
-- past), for an active member whose identity has a live device. A row read
-- before its turn is settled without a push.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. Who the push worker is.
--
--     `internal.is_node_admin()` already refuses a space-pinned session (233);
--     the pin test is repeated so the predicate reads whole on its own.
-- -----------------------------------------------------------------------------
create or replace function internal.is_push_worker()
returns boolean
language sql stable
set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null
     and internal.is_node_admin()
     and coalesce(internal.claim_text('tm8.background_job') = 'push.dispatch', false)
     and nullif(current_setting('tm8.session_space_id', true), '') is null
$$;

comment on function internal.is_push_worker() is
  '393: true only inside a transaction the in-process push worker opened: node-admin '
  'claims, tm8.background_job = ''push.dispatch'' (bound by db/client.ts from a closed '
  'list, never from a request) and no space pin. A node admin over HTTP is not the '
  'push worker.';

-- -----------------------------------------------------------------------------
-- §2. THE JOIN WITH S1 (392 public.devices): these two functions and no other.
-- -----------------------------------------------------------------------------
create or replace function internal.push_devices_for(p_identity_id text)
returns table (
  device_id        uuid,
  identity_id      text,
  platform         text,
  token_hash       text,
  token_ciphertext bytea,
  token_nonce      bytea,
  previews         text,
  locale           text,
  quiet_until      timestamptz
)
language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
#variable_conflict use_column
begin
  if not internal.is_push_worker() then
    raise exception 'push worker required' using errcode = '42501';
  end if;
  -- NULL is every person with a live device; the enqueue in §4 reads only the
  -- identity column of that.
  return query
    select d.id, d.identity_id, d.platform, d.token_hash, d.token_ciphertext, d.token_nonce,
           d.previews, d.locale, d.quiet_until
      from public.devices d
      join public.auth_sessions s
        on s.id = d.auth_session_id
       and s.revoked_at is null
       and s.expires_at > now()
     where d.relay = 'expo'
       and (p_identity_id is null or d.identity_id = p_identity_id)
     order by d.created_at, d.id;
end
$$;

comment on function internal.push_devices_for(text) is
  '393 (the S6 join with 392, 1 of 2): a person''s devices whose root auth session is '
  'live, sealed token included for in-process opening. Push worker only. NULL = every '
  'person with a live device.';

create or replace function internal.delete_push_device(p_device_id uuid, p_token_hash text)
returns boolean
language plpgsql security definer
set search_path = public, internal, pg_temp as $$
begin
  if not internal.is_push_worker() then
    raise exception 'push worker required' using errcode = '42501';
  end if;
  delete from public.devices d
   where d.id = p_device_id
     and d.token_hash = p_token_hash;
  return found;
end
$$;

comment on function internal.delete_push_device(uuid, text) is
  '393 (the S6 join with 392, 2 of 2): delete a device the relay reported dead, only '
  'while it still holds the token that was sent to (id AND token_hash), so a rotated '
  'token survives a stale report. Push worker only.';

-- -----------------------------------------------------------------------------
-- §3. The queue and the ticket ledger.
--
--     003 left notification_outbox empty and unwritten (grep: no writer in any
--     migration), so the duplicate sweep below finds nothing on a real node; it
--     is there so the unique index cannot fail on one that somehow has some.
-- -----------------------------------------------------------------------------
alter table public.notification_outbox
  add column if not exists available_at timestamptz not null default now();

comment on column public.notification_outbox.available_at is
  '393: not claimable before this instant; the push worker''s retry backoff.';

delete from public.notification_outbox a
 using public.notification_outbox b
 where a.notification_id = b.notification_id
   and a.channel = b.channel
   and a.id > b.id;

create unique index if not exists notification_outbox_notification_channel_key
  on public.notification_outbox(notification_id, channel);

create index if not exists notification_outbox_push_pending_idx
  on public.notification_outbox(available_at, created_at)
  where channel = 'push' and processed_at is null and dead_lettered_at is null;

create table if not exists public.push_tickets (
  ticket_id       text primary key check (char_length(ticket_id) between 1 and 200),
  device_id       uuid not null,
  token_hash      text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  notification_id uuid references public.notifications(id) on delete set null,
  created_at      timestamptz not null default now(),
  claimed_at      timestamptz
);

create index if not exists push_tickets_created_idx on public.push_tickets(created_at);

comment on table public.push_tickets is
  '393: relay tickets awaiting their receipt (Expo keeps receipts 24 hours). Holds the '
  'device id and the token''s sha256, never the token. RLS on with no policy and no '
  'grant: the push worker''s doors are the only way in.';

alter table public.push_tickets enable row level security;
revoke all on public.push_tickets from public;

-- -----------------------------------------------------------------------------
-- §4. The worker's four doors.
-- -----------------------------------------------------------------------------

-- Enqueue what is new, settle what no longer needs a push, and claim a batch.
-- Each item carries the recipient's identity (the worker reads the notification
-- text under it) and that person's live devices with their sealed tokens.
create or replace function public.claim_push_dispatch(
  p_limit integer default 25,
  p_lease_seconds integer default 120,
  p_window_seconds integer default 900,
  p_max_age_seconds integer default 3600
) returns jsonb
language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 10));
  win interval := make_interval(secs => least(greatest(coalesce(p_window_seconds, 900), 60), 86400));
  max_age interval := make_interval(secs => greatest(coalesce(p_max_age_seconds, 3600), 60));
  r record;
  targets jsonb;
  items jsonb := '[]'::jsonb;
  enqueued integer := 0;
  read_first integer := 0;
  expired integer := 0;
  no_device integer := 0;
begin
  if not internal.is_push_worker() then
    raise exception 'push worker required' using errcode = '42501';
  end if;

  -- 1. ENQUEUE. People first (few have a phone), then their recent inbox rows
  --    through the recipient index, so this never scans the notifications table.
  with live as (
    select distinct pd.identity_id from internal.push_devices_for(null) pd
  )
  insert into public.notification_outbox(notification_id, channel)
  select n.id, 'push'
    from live
    join public.members m on m.identity_id = live.identity_id and m.status = 'active'
    join public.notifications n on n.recipient_member_id = m.entity_id
   where n.recipient_team_member_id is null
     and n.read_at is null
     and n.created_at > now() - win
     and not exists (
       select 1 from public.notification_outbox q
        where q.notification_id = n.id and q.channel = 'push')
  on conflict (notification_id, channel) do nothing;
  get diagnostics enqueued = row_count;

  -- 2. Read before its turn: done, without a push.
  update public.notification_outbox o
     set processed_at = now(), claimed_at = null, last_error = 'skipped: read before dispatch'
    from public.notifications n
   where n.id = o.notification_id
     and o.channel = 'push'
     and o.processed_at is null and o.dead_lettered_at is null
     and (o.claimed_at is null or o.claimed_at < now() - lease)
     and n.read_at is not null;
  get diagnostics read_first = row_count;

  -- 3. Still unsent long after it happened (retries ran out of road): no longer
  --    news. Dead-lettered, so it stays visible as a failure.
  update public.notification_outbox o
     set dead_lettered_at = now(), claimed_at = null,
         last_error = left('expired: ' || coalesce(o.last_error, 'never sent'), 500)
    from public.notifications n
   where n.id = o.notification_id
     and o.channel = 'push'
     and o.processed_at is null and o.dead_lettered_at is null
     and (o.claimed_at is null or o.claimed_at < now() - lease)
     and n.created_at < now() - max_age;
  get diagnostics expired = row_count;

  -- 4. CLAIM.
  for r in
    select o.id, o.notification_id, o.attempts, n.space_id, m.identity_id
      from public.notification_outbox o
      join public.notifications n on n.id = o.notification_id
      join public.members m on m.entity_id = n.recipient_member_id
     where o.channel = 'push'
       and o.processed_at is null and o.dead_lettered_at is null
       and o.available_at <= now()
       and (o.claimed_at is null or o.claimed_at < now() - lease)
     order by o.available_at, o.created_at, o.id
     limit lim
     for update of o skip locked
  loop
    select coalesce(jsonb_agg(jsonb_build_object(
             'deviceId', pd.device_id,
             'identityId', pd.identity_id,
             'platform', pd.platform,
             'tokenHash', pd.token_hash,
             'tokenCiphertext', encode(pd.token_ciphertext, 'hex'),
             'tokenNonce', encode(pd.token_nonce, 'hex'),
             'previews', pd.previews,
             'locale', pd.locale,
             'quietUntil', pd.quiet_until)), '[]'::jsonb)
      into targets
      from internal.push_devices_for(r.identity_id) pd;

    if jsonb_array_length(targets) = 0 then
      -- Signed out (or expired) since it was queued.
      update public.notification_outbox
         set processed_at = now(), claimed_at = null, last_error = 'skipped: no live device'
       where id = r.id;
      no_device := no_device + 1;
      continue;
    end if;

    update public.notification_outbox
       set claimed_at = now(), attempts = attempts + 1
     where id = r.id;

    items := items || jsonb_build_array(jsonb_build_object(
      'outboxId', r.id,
      'notificationId', r.notification_id,
      'spaceId', r.space_id,
      'recipientIdentityId', r.identity_id,
      'attempt', r.attempts + 1,
      'devices', targets));
  end loop;

  return jsonb_build_object(
    'items', items,
    'enqueued', enqueued,
    'skippedRead', read_first,
    'skippedNoDevice', no_device,
    'expired', expired);
end
$$;

comment on function public.claim_push_dispatch(integer, integer, integer, integer) is
  '393: enqueue new unread inbox rows of people with a live device, settle the ones read '
  'or expired meanwhile, and claim a batch with each recipient''s devices (sealed tokens, '
  'hex). Push worker only.';

-- One claimed row's outcome. `sent` and `skipped` are done; `retry` frees the
-- row after a backoff; `failed` dead-letters it. Dead devices are deleted first,
-- whatever the outcome, because the relay said so.
create or replace function public.settle_push_dispatch(
  p_outbox_id uuid,
  p_outcome text,
  p_error text default null,
  p_tickets jsonb default '[]'::jsonb,
  p_dead jsonb default '[]'::jsonb,
  p_retry_after_seconds integer default null
) returns jsonb
language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  claimed public.notification_outbox;
  dead jsonb;
  devices_deleted integer := 0;
  tickets_kept integer := 0;
  backoff interval := make_interval(secs => least(greatest(coalesce(p_retry_after_seconds, 30), 1), 86400));
begin
  if not internal.is_push_worker() then
    raise exception 'push worker required' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('sent', 'skipped', 'retry', 'failed') then
    raise exception 'unknown push outcome: %', coalesce(p_outcome, '(null)') using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_tickets, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_dead, '[]'::jsonb)) <> 'array' then
    raise exception 'tickets and dead must be arrays' using errcode = '22023';
  end if;

  select * into claimed
    from public.notification_outbox
   where id = p_outbox_id and channel = 'push'
   for update;
  if not found then
    raise exception 'push outbox row not found' using errcode = 'P0002';
  end if;
  if claimed.processed_at is not null or claimed.dead_lettered_at is not null then
    return jsonb_build_object('settled', false, 'reason', 'already settled');
  end if;

  for dead in select value from jsonb_array_elements(coalesce(p_dead, '[]'::jsonb)) loop
    if internal.delete_push_device((dead ->> 'deviceId')::uuid, dead ->> 'tokenHash') then
      devices_deleted := devices_deleted + 1;
    end if;
  end loop;

  insert into public.push_tickets(ticket_id, device_id, token_hash, notification_id)
  select t ->> 'ticketId', (t ->> 'deviceId')::uuid, t ->> 'tokenHash', claimed.notification_id
    from jsonb_array_elements(coalesce(p_tickets, '[]'::jsonb)) t
  on conflict (ticket_id) do nothing;
  get diagnostics tickets_kept = row_count;

  update public.notification_outbox
     set claimed_at = null,
         available_at = case when p_outcome = 'retry' then now() + backoff else available_at end,
         processed_at = case when p_outcome in ('sent', 'skipped') then now() else null end,
         dead_lettered_at = case when p_outcome = 'failed' then now() else null end,
         last_error = left(p_error, 500)
   where id = p_outbox_id;

  return jsonb_build_object('settled', true, 'devicesDeleted', devices_deleted, 'ticketsKept', tickets_kept);
end
$$;

comment on function public.settle_push_dispatch(uuid, text, text, jsonb, jsonb, integer) is
  '393: settle one claimed push (sent | skipped | retry | failed), keep its relay tickets '
  'for the receipt pass and delete the devices the relay reported dead (id AND token '
  'hash). Push worker only.';

-- Tickets old enough to have a receipt (Expo: check after about 15 minutes),
-- leased so a slow pass is not doubled. Tickets past Expo's 24 hours are
-- forgotten here: their receipts are gone. The queue's retention rides on this
-- slow pass too, so the fast one never scans settled rows.
create or replace function public.claim_push_receipts(
  p_limit integer default 300,
  p_min_age_seconds integer default 900,
  p_lease_seconds integer default 600
) returns jsonb
language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 300), 1), 1000);
  min_age interval := make_interval(secs => greatest(coalesce(p_min_age_seconds, 900), 0));
  lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 10));
  ids jsonb;
  expired integer := 0;
  pruned integer := 0;
begin
  if not internal.is_push_worker() then
    raise exception 'push worker required' using errcode = '42501';
  end if;

  delete from public.push_tickets where created_at < now() - interval '24 hours';
  get diagnostics expired = row_count;

  -- RETENTION: settled queue rows are kept a week for diagnosis, then dropped
  -- in bounded batches (deleting the notification also cascades them away).
  delete from public.notification_outbox o
   where o.id in (
     select x.id from public.notification_outbox x
      where x.channel = 'push'
        and coalesce(x.processed_at, x.dead_lettered_at) < now() - interval '7 days'
      limit 500);
  get diagnostics pruned = row_count;

  with picked as (
    select t.ticket_id
      from public.push_tickets t
     where t.created_at <= now() - min_age
       and (t.claimed_at is null or t.claimed_at < now() - lease)
     order by t.created_at, t.ticket_id
     limit lim
     for update skip locked
  ), claimed as (
    update public.push_tickets t
       set claimed_at = now()
      from picked
     where t.ticket_id = picked.ticket_id
    returning t.ticket_id
  )
  select coalesce(jsonb_agg(claimed.ticket_id order by claimed.ticket_id), '[]'::jsonb) into ids from claimed;

  return jsonb_build_object('ticketIds', ids, 'expired', expired, 'pruned', pruned);
end
$$;

comment on function public.claim_push_receipts(integer, integer, integer) is
  '393: lease relay tickets due a receipt check; forget tickets older than 24 hours and '
  'settled push queue rows older than 7 days. Push worker only.';

-- What the receipts said: `p_done` are tickets that have a receipt (forget them),
-- `p_dead` those whose receipt was DeviceNotRegistered (delete the device the
-- ticket was sent to, by its stored id and token hash, then forget them).
create or replace function public.settle_push_receipts(p_done text[], p_dead text[])
returns jsonb
language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  r record;
  devices_deleted integer := 0;
  forgotten integer := 0;
begin
  if not internal.is_push_worker() then
    raise exception 'push worker required' using errcode = '42501';
  end if;

  for r in
    select t.device_id, t.token_hash
      from public.push_tickets t
     where t.ticket_id = any(coalesce(p_dead, '{}'::text[]))
  loop
    if internal.delete_push_device(r.device_id, r.token_hash) then
      devices_deleted := devices_deleted + 1;
    end if;
  end loop;

  delete from public.push_tickets t
   where t.ticket_id = any(coalesce(p_done, '{}'::text[]) || coalesce(p_dead, '{}'::text[]));
  get diagnostics forgotten = row_count;

  return jsonb_build_object('devicesDeleted', devices_deleted, 'forgotten', forgotten);
end
$$;

comment on function public.settle_push_receipts(text[], text[]) is
  '393: forget tickets whose receipt arrived and delete the devices DeviceNotRegistered '
  'receipts name (stored id AND token hash). Push worker only.';

-- -----------------------------------------------------------------------------
-- §5. Grants. PUBLIC gets EXECUTE on every new function by default (and the
--     delivery role's surface is pinned by w2-execution.pg.test.ts), so every
--     function here starts closed; tm8_app gets the four doors and nothing else.
-- -----------------------------------------------------------------------------
revoke all on function internal.is_push_worker() from public;
revoke all on function internal.push_devices_for(text) from public;
revoke all on function internal.delete_push_device(uuid, text) from public;
revoke all on function public.claim_push_dispatch(integer, integer, integer, integer) from public;
revoke all on function public.settle_push_dispatch(uuid, text, text, jsonb, jsonb, integer) from public;
revoke all on function public.claim_push_receipts(integer, integer, integer) from public;
revoke all on function public.settle_push_receipts(text[], text[]) from public;

grant execute on function
  public.claim_push_dispatch(integer, integer, integer, integer),
  public.settle_push_dispatch(uuid, text, text, jsonb, jsonb, integer),
  public.claim_push_receipts(integer, integer, integer),
  public.settle_push_receipts(text[], text[])
to tm8_app;

-- -----------------------------------------------------------------------------
-- VERIFY. Asserts only what THIS FILE creates.
-- -----------------------------------------------------------------------------
do $verify$
begin
  if to_regclass('public.notification_outbox_notification_channel_key') is null then
    raise exception '393: the (notification_id, channel) unique index must exist';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.push_tickets'::regclass) then
    raise exception '393: push_tickets must have row level security enabled';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.push_tickets'::regclass) then
    raise exception '393: push_tickets must have no policy';
  end if;
  if has_table_privilege('tm8_app', 'public.push_tickets', 'select') then
    raise exception '393: tm8_app must not read push_tickets';
  end if;
  if has_function_privilege('tm8_app', 'internal.push_devices_for(text)', 'execute')
     or has_function_privilege('tm8_app', 'internal.delete_push_device(uuid, text)', 'execute') then
    raise exception '393: tm8_app must not execute the device join functions';
  end if;
  if not has_function_privilege('tm8_app', 'public.claim_push_dispatch(integer, integer, integer, integer)', 'execute') then
    raise exception '393: tm8_app must execute claim_push_dispatch';
  end if;
end
$verify$;

reset role;
