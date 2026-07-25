-- =============================================================================
-- 004 ledgers — the append-only points ledger and the universal command ledger.
--
-- Both are append-only by design. Points are never edited into a balance:
-- `entity_counters.points` is a derived cache that can be rebuilt from these rows
-- at any time. The command ledger is the uniform idempotency envelope (DEV-9)
-- AND the execution audit trail (S10) — every execution.* command lands here.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Points.
-- -----------------------------------------------------------------------------
create table public.point_events (
  id              uuid primary key default internal.new_id(),
  space_id        uuid not null references public.spaces(id) on delete cascade,
  -- Who received the points (a member or team_member entity).
  entity_id       uuid not null references public.entities(id) on delete cascade,
  actor_id        uuid not null references public.entities(id),
  amount          integer not null check (amount <> 0),
  reason          text not null default 'grant' check (reason in ('grant','award','seed')),
  -- What generated it, e.g. the completed task for an award.
  ref_id          uuid,
  client_event_id text unique,
  created_at      timestamptz not null default now()
);
create index point_events_entity_idx on public.point_events(entity_id, created_at desc, id desc);
create index point_events_space_idx on public.point_events(space_id, created_at desc, id desc);

create or replace function internal.maintain_points_counter() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if tg_op in ('DELETE','UPDATE') then
    update public.entity_counters set points = points - old.amount, updated_at = now()
     where entity_id = old.entity_id;
    update public.entities set activity_at = now() where id = old.entity_id and deleted_at is null;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    update public.entity_counters set points = points + new.amount, updated_at = now()
     where entity_id = new.entity_id;
    update public.entities set activity_at = now() where id = new.entity_id and deleted_at is null;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
create trigger point_events_counter after insert or update or delete on public.point_events
for each row execute function internal.maintain_points_counter();

-- An award is news for the person who received it (03/01 §S7 targeting).
create or replace function internal.fan_out_award_notification() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare activity_id uuid;
begin
  activity_id := internal.record_activity(new.space_id, new.ref_id, new.actor_id,
                   case when new.reason = 'award' then 'awarded' else 'awarded' end,
                   new.id, jsonb_build_object('amount', new.amount, 'reason', new.reason,
                                              'recipientId', new.entity_id));
  perform internal.notify(new.space_id, internal.recipient_member(new.entity_id), 'award',
                          coalesce(new.ref_id, new.entity_id), new.actor_id,
                          jsonb_build_object('amount', new.amount, 'reason', new.reason), activity_id);
  return new;
end
$$;
create trigger point_events_fan_out_award after insert on public.point_events
for each row execute function internal.fan_out_award_notification();

-- -----------------------------------------------------------------------------
-- 2. The command ledger (DEV-9, 04 §5.1).
--
-- One row per client mutation id, globally unique. A retry with the same id and
-- the same operation replays the stored CommandResult; the same id with a
-- DIFFERENT operation is an invariant violation, because a client reusing an id
-- across operations has a bug we must not paper over.
--
-- Retention is 24h (01 §10): idempotency protects against retries and crashes,
-- not against history.
-- -----------------------------------------------------------------------------
create table public.command_ledger (
  client_mutation_id text primary key check (char_length(client_mutation_id) between 1 and 200),
  identity_id        text,
  actor_id           uuid,
  operation          text not null,
  result             jsonb,
  created_at         timestamptz not null default now()
);
create index command_ledger_created_idx on public.command_ledger(created_at);
create index command_ledger_identity_idx on public.command_ledger(identity_id, created_at desc);

comment on table public.command_ledger is
  'Universal idempotency envelope AND the execution audit trail: every mutation, '
  'including every execution.* command, records here (DEV-9, S10). 24h TTL.';

-- Bind the cmid for this transaction so the event-capture trigger can stamp it
-- onto every event the mutation produces (AM-2 §3 optimistic reconciliation).
create or replace function internal.bind_cmid(p_cmid text) returns void
language sql set search_path = public, internal, pg_temp as $$
  select set_config('tm8.client_mutation_id', coalesce(p_cmid, ''), true)
$$;

-- Called at the TOP of a write RPC. Returns the stored result on a replay, or
-- NULL when this is the first time we have seen the id.
create or replace function internal.ledger_replay(p_cmid text, p_operation text) returns jsonb
language plpgsql set search_path = public, internal, pg_temp as $$
declare row public.command_ledger;
begin
  perform internal.bind_cmid(p_cmid);
  if p_cmid is null or btrim(p_cmid) = '' then
    return null;
  end if;
  select * into row from public.command_ledger where client_mutation_id = p_cmid;
  if row.client_mutation_id is null then
    return null;
  end if;
  if row.operation <> p_operation then
    raise exception 'client mutation id % already used for operation %', p_cmid, row.operation
      using errcode = '23514',
            detail = 'one clientMutationId belongs to one operation (DEV-9)';
  end if;
  return coalesce(row.result, '{}'::jsonb);
end
$$;

-- Called just BEFORE returning. Records the result, and closes the race where two
-- concurrent retries both passed the replay check: the loser returns the winner's
-- stored result instead of double-applying or failing.
create or replace function internal.ledger_record(p_cmid text, p_operation text, p_result jsonb)
returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare
  inserted boolean := false;
  row public.command_ledger;
begin
  if p_cmid is null or btrim(p_cmid) = '' then
    return p_result;
  end if;
  insert into public.command_ledger(client_mutation_id, identity_id, actor_id, operation, result)
  values (p_cmid, internal.identity_id(), internal.actor_id(), p_operation, p_result)
  on conflict (client_mutation_id) do nothing;
  inserted := found;
  if inserted then
    return p_result;
  end if;
  select * into row from public.command_ledger where client_mutation_id = p_cmid;
  if row.operation <> p_operation then
    raise exception 'client mutation id % already used for operation %', p_cmid, row.operation
      using errcode = '23514';
  end if;
  return coalesce(row.result, p_result);
end
$$;

create or replace function internal.prune_command_ledger(retain interval default interval '24 hours')
returns bigint language plpgsql set search_path = public, internal, pg_temp as $$
declare removed bigint;
begin
  delete from public.command_ledger where created_at < now() - retain;
  get diagnostics removed = row_count;
  return removed;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. Undo tokens (DEV-11, 04 §5.1) — 5 minute TTL, redeemed by commands.undo.
--
-- The token is opaque to the client; the inverse command and its arguments live
-- here so `undo` is a replay of a known inverse, not a client-supplied command.
-- -----------------------------------------------------------------------------
create table public.undo_tokens (
  token       text primary key check (char_length(token) between 8 and 200),
  space_id    uuid not null references public.spaces(id) on delete cascade,
  actor_id    uuid not null references public.entities(id) on delete cascade,
  label       text not null default '',
  operation   text not null,
  arguments   jsonb not null default '{}'::jsonb check (jsonb_typeof(arguments) = 'object'),
  expires_at  timestamptz not null,
  redeemed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index undo_tokens_expiry_idx on public.undo_tokens(expires_at) where redeemed_at is null;

create or replace function internal.issue_undo_token(
  p_space uuid, p_actor uuid, p_label text, p_operation text, p_arguments jsonb
) returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare
  token text := 'undo_' || replace(internal.new_id()::text, '-', '');
  expires timestamptz := now() + interval '5 minutes';
begin
  insert into public.undo_tokens(token, space_id, actor_id, label, operation, arguments, expires_at)
  values (token, p_space, p_actor, coalesce(p_label, ''), p_operation, coalesce(p_arguments, '{}'::jsonb), expires);
  return jsonb_build_object('token', token, 'label', coalesce(p_label, ''), 'expiresAt', expires);
end
$$;

create or replace function internal.prune_undo_tokens() returns bigint
language plpgsql set search_path = public, internal, pg_temp as $$
declare removed bigint;
begin
  delete from public.undo_tokens where expires_at < now() - interval '1 hour';
  get diagnostics removed = row_count;
  return removed;
end
$$;

revoke all on all functions in schema internal from public;
revoke all on all functions in schema public from public;

reset role;
