-- =============================================================================
-- 046 — local CRUD-test mode for command idempotency.
--
-- `TM8_IDEMPOTENCY_ENABLED=false` is supplied by the server's database pool as
-- the per-connection PostgreSQL setting `tm8.idempotency_enabled=off`. In that
-- mode command RPCs execute normally but neither replay nor record a
-- clientMutationId. The default is strictly enabled, including for direct psql
-- use and every pre-existing deployment.
--
-- This is intentionally an additive migration: applied migrations are
-- checksum-locked. It replaces only shared ledger helpers, so every RPC that
-- calls them follows the same switch.
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.idempotency_enabled()
returns boolean language sql stable
set search_path = public, internal, pg_temp as $$
  select case lower(coalesce(nullif(current_setting('tm8.idempotency_enabled', true), ''), 'on'))
    when '0' then false
    when 'false' then false
    when 'off' then false
    else true
  end
$$;

-- Event capture uses this setting for `WorkspaceEvent.clientMutationId`. With
-- idempotency off, do not publish a caller-supplied, non-unique correlation id.
create or replace function internal.bind_cmid(p_cmid text) returns void
language sql set search_path = public, internal, pg_temp as $$
  select set_config(
    'tm8.client_mutation_id',
    case when internal.idempotency_enabled() then coalesce(p_cmid, '') else '' end,
    true
  )
$$;

create or replace function internal.ledger_replay(p_cmid text, p_operation text)
returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare
  ledger_row public.command_ledger;
  caller_identity text;
begin
  if not internal.idempotency_enabled() then
    perform internal.bind_cmid(null);
    return null;
  end if;

  perform internal.bind_cmid(p_cmid);
  if p_cmid is null or btrim(p_cmid) = '' then
    return null;
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(p_cmid, 0));

  select * into ledger_row
    from public.command_ledger
   where client_mutation_id = p_cmid;
  if ledger_row.client_mutation_id is null then
    return null;
  end if;

  caller_identity := internal.identity_id();
  if ledger_row.identity_id is null
     or caller_identity is null
     or ledger_row.identity_id <> caller_identity then
    raise exception 'clientMutationId belongs to another principal'
      using errcode = '23514',
            detail = 'a replay may not be returned to a principal other than the one that recorded it (W2.SEC-1)';
  end if;

  if ledger_row.operation <> p_operation then
    raise exception 'client mutation id already used for operation other than the one requested'
      using errcode = '23514',
            detail = 'one clientMutationId belongs to one operation (DEV-9)';
  end if;
  return coalesce(ledger_row.result, '{}'::jsonb);
end
$$;

create or replace function internal.ledger_record(p_cmid text, p_operation text, p_result jsonb)
returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare
  stored_operation text;
  stored_result jsonb;
begin
  if not internal.idempotency_enabled() then
    return p_result;
  end if;
  if p_cmid is null or btrim(p_cmid) = '' then
    return p_result;
  end if;

  insert into public.command_ledger(client_mutation_id, identity_id, actor_id, operation, result)
  values (p_cmid, internal.identity_id(), internal.actor_id(), p_operation, p_result)
  on conflict (client_mutation_id) do update
    set result = coalesce(command_ledger.result, excluded.result)
  returning operation, result into stored_operation, stored_result;

  if stored_operation <> p_operation then
    raise exception 'client mutation id % already used for operation %', p_cmid, stored_operation
      using errcode = '23514';
  end if;
  return coalesce(stored_result, p_result);
end
$$;

create or replace function internal.require_replay_principal(p_cmid text)
returns void language plpgsql
set search_path = public, internal, pg_temp as $$
declare ledger_identity text;
begin
  if not internal.idempotency_enabled()
     or p_cmid is null
     or btrim(p_cmid) = '' then
    return;
  end if;

  select identity_id into ledger_identity
    from public.command_ledger
   where client_mutation_id = p_cmid;
  if not found then
    return;
  end if;

  if ledger_identity is distinct from internal.identity_id() then
    raise exception 'clientMutationId belongs to another principal'
      using errcode = '23514',
            detail = 'a replay may not be returned to a principal other than the one that recorded it (W2.SEC-1)';
  end if;
end
$$;

create or replace function internal.require_replay_subject(
  p_stored text, p_addressed text, p_subject text
) returns void language plpgsql
set search_path = public, internal, pg_temp as $$
begin
  if not internal.idempotency_enabled() then
    return;
  end if;
  if p_stored is distinct from p_addressed then
    raise exception 'clientMutationId belongs to another %', p_subject
      using errcode = '23514',
            detail = 'a replay may not be returned to a request that addresses a different resource than the one it was recorded against (W2.SEC-1)';
  end if;
end
$$;

comment on function internal.idempotency_enabled() is
  'Default-on command-ledger switch. The tm8-server pool supplies off only in local CRUD-test mode.';

reset role;
