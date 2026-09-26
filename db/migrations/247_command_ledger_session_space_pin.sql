-- =============================================================================
-- 247 — a replay honours the session's space pin
-- (W3-audit #852 finding F4, follow-up S3, task 01a0db50).
--
-- THE HOLE. command_ledger is keyed by client_mutation_id and checked against
-- the recording identity and operation only (033/046); it has no space. A
-- cmid recorded by a session pinned to B (`tm8.session_space_id`, 226/227)
-- therefore replayed, within the ledger's life, to a session of the same
-- identity pinned to A, and the cached body carried B's content: a member row
-- (display name, role, identity id), grant metadata, chat and message ids, a
-- handoff projection. The pin exists so an agent launched in B cannot read A;
-- sessions of one identity are not equally trusted. A cmid is not a secret
-- (the UI mints set_member_role's as role_<counter36>_<Date.now()36>), so the
-- refusal below does not depend on it being unguessable.
--
-- THE FIX. The replay order at every call site is unchanged: replay still runs
-- before the guards, so retry-after-state-change keeps its semantics and none
-- of the callers is edited. Instead the ledger records the pin and the two exit
-- points that hand a cached row to a caller refuse across pins:
--   1. command_ledger.session_space_id — the recording session's pin, null for
--      an unpinned session. Written by internal.ledger_record, the only writer.
--   2. internal.ledger_replay, the only function that returns a cached body,
--      and internal.require_replay_principal, the early guard about half its
--      callers run first: when the CALLER is pinned and the row's pin is
--      distinct from the caller's, refuse 23514 before any body is returned or
--      any handler runs.
--
-- TWO FACTS THIS RELIES ON.
--   - A NULL ROW PIN REFUSES UNDER A PINNED CALLER. A row recorded by an
--     unpinned session, or before this migration (the column is added null,
--     there is no backfill), is not replayable by a pinned session. A pinned
--     retry of a pre-migration cmid is refused rather than served; a fresh cmid
--     runs normally.
--   - THE 24H PRUNE bounds that window: internal.prune_command_ledger (004,
--     scheduled by the server's retention job) deletes rows past 24 hours, so
--     every pre-migration row is gone 24 hours after this applies.
-- An UNPINNED caller is unchanged: it replays any row its identity recorded,
-- pinned or not, as before.
--
-- Additive: one nullable column; CREATE OR REPLACE of three helpers whose
-- bodies are 046's plus the pin; one new helper and the stream_grants_select
-- subject arm (P6, below). Idempotency-off mode (046) is untouched.
-- =============================================================================

set role tm8_graph_owner;

alter table public.command_ledger add column session_space_id uuid;

comment on column public.command_ledger.session_space_id is
  'The recording session''s space pin (internal.session_space_id(), 227); null when unpinned '
  'or recorded before 247. A pinned caller replays only rows carrying its own pin (247).';

create or replace function internal.ledger_replay(p_cmid text, p_operation text)
returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare
  ledger_row public.command_ledger;
  caller_identity text;
  caller_pin uuid;
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

  -- 247: a pinned caller replays only what a session with the same pin recorded.
  caller_pin := internal.session_space_id();
  if caller_pin is not null and ledger_row.session_space_id is distinct from caller_pin then
    raise exception 'clientMutationId was recorded under another space pin'
      using errcode = '23514',
            detail = 'ledger_replay: a pinned session replays only rows recorded under its own pin (247)';
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

  insert into public.command_ledger(
    client_mutation_id, identity_id, actor_id, operation, result, session_space_id)
  values (p_cmid, internal.identity_id(), internal.actor_id(), p_operation, p_result,
          internal.session_space_id())
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
declare
  ledger_identity text;
  ledger_pin uuid;
  caller_pin uuid;
begin
  if not internal.idempotency_enabled()
     or p_cmid is null
     or btrim(p_cmid) = '' then
    return;
  end if;

  select identity_id, session_space_id into ledger_identity, ledger_pin
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

  -- 247: the same pin rule as ledger_replay, at the early exit point.
  caller_pin := internal.session_space_id();
  if caller_pin is not null and ledger_pin is distinct from caller_pin then
    raise exception 'clientMutationId was recorded under another space pin'
      using errcode = '23514',
            detail = 'require_replay_principal: a pinned session replays only rows recorded under its own pin (247)';
  end if;
end
$$;

-- P6. stream_grants_select (218) lists a row on either of two arms: the grant's
-- subject is the caller, or the caller can read the grant's work session. The
-- second arm reads entities under RLS, so it is already pinned. The first is not:
-- a session pinned to A listed the same identity's grants on B's sessions and
-- containers, token_hash included. The subject arm now also requires the grant's
-- target (work session or container, exactly one is set) to sit in the pinned
-- space. An unpinned caller is unchanged. The helper is a definer so it can read
-- the target's space without the caller's entity visibility deciding for it.
create or replace function internal.stream_grant_in_pin(p_work_session_id uuid, p_container_entity_id uuid)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select internal.session_space_id() is null
      or exists (select 1 from public.entities target
                  where target.id = coalesce(p_work_session_id, p_container_entity_id)
                    and target.space_id = internal.session_space_id())
$$;

revoke all on function internal.stream_grant_in_pin(uuid, uuid) from public;
grant execute on function internal.stream_grant_in_pin(uuid, uuid) to tm8_app;

alter policy stream_grants_select on public.stream_grants
  using (
    (subject_identity = internal.identity_id()
       and internal.stream_grant_in_pin(work_session_id, container_entity_id))
    or exists (
      select 1 from public.entities readable_entity
       where readable_entity.id = stream_grants.work_session_id
         and readable_entity.deleted_at is null
      offset 0));

do $verify$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'command_ledger'
                    and column_name = 'session_space_id') then
    raise exception 'VERIFY 247: command_ledger.session_space_id missing';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'internal'
         and p.proname in ('ledger_replay', 'require_replay_principal', 'ledger_record')
         and p.prosrc like '%session_space_id%') <> 3 then
    raise exception 'VERIFY 247: a ledger helper does not carry the session space pin';
  end if;
  if (select pg_get_expr(polqual, polrelid) from pg_policy
       where polrelid = 'public.stream_grants'::regclass and polname = 'stream_grants_select')
     not like '%stream_grant_in_pin%' then
    raise exception 'VERIFY 247: stream_grants_select subject arm does not honour the pin';
  end if;
end
$verify$;

reset role;
