-- =============================================================================
-- 012 — a CONCURRENT double-submit of one clientMutationId applied the mutation
--       TWICE while telling both callers it had happened once.
--
-- THE BUG (found by db/test/ledger_replay.test.mjs, 'CONCURRENT double-submit'):
--
--   004's protocol was replay-at-the-top / record-at-the-bottom, where "record"
--   was the first time the cmid touched the table:
--
--     ledger_replay:  select from command_ledger where cmid = ...  -> miss, proceed
--     ...do the work...
--     ledger_record:  insert ... on conflict do nothing; if it conflicted, return
--                     the stored result instead of ours
--
--   Two transactions submitting the same cmid at the same instant BOTH miss the
--   replay check, because neither has written anything yet. Both then do the full
--   body — two entities, two activity rows, two event streams. At the end one wins
--   the insert and the other reads the winner's result and returns it. 004's
--   comment says this makes the loser "return the winner's stored result instead of
--   double-applying", but the loser's OWN inserts are still in its transaction and
--   still commit. So:
--
--     command_ledger rows: 1        tasks created: 2        callers told: "1 task"
--
--   Measured on the applied 001-011 sequence: two simultaneous create_task calls
--   with an identical cmid produced 2 rows in public.tasks, 1 ledger row, and the
--   same entity id returned to both callers. The ledger HID the duplicate rather
--   than preventing it. On the G1A loop the same race in execution.spawn means two
--   work_sessions and two PTYs for one spawn.
--
-- THE FIX: reserve the cmid at the TOP instead of recording it at the bottom.
--
--   ledger_replay now INSERTs the cmid with a NULL result before returning "miss".
--   That insert is the mutual exclusion:
--     * winner inserts, gets NULL back, and proceeds to do the work
--     * loser's insert blocks on the primary key until the winner commits or
--       aborts. If the winner COMMITTED, the loser's insert no-ops, it reads the
--       committed row and returns the winner's result WITHOUT running the body. If
--       the winner ABORTED, its reservation disappeared, the loser's insert
--       succeeds, and the loser legitimately becomes the writer.
--   ledger_record then fills in the result on the row it already reserved.
--
--   Sequential replay behaviour is UNCHANGED — same return value, same 23514 on a
--   cmid reused for a different operation, same "no cmid means no idempotency".
--   What changes is that duplicate submission is now serialised on the cmid
--   instead of racing. A caller with no cmid still reserves nothing and is
--   unaffected.
--
--   Cost: one extra INSERT per ledgered mutation, on a primary-key-only table.
--   The reservation is transaction-scoped, so a failed RPC (a refused guard, a
--   version conflict) rolls its reservation back and does not poison the cmid.
--
-- BLAST RADIUS: internal.ledger_replay / internal.ledger_record are the top and
-- tail of all 40-odd write RPCs, so this touches every mutation in the catalog.
-- It is behaviour-preserving on the sequential path, which is the path every lane
-- exercises; the full db suite is green against it.
--
-- Forward-only: 004 is applied and checksum-locked elsewhere.
-- =============================================================================
set role tm8_graph_owner;

-- Called at the TOP of a write RPC. Returns the stored result on a replay, or NULL
-- when this caller is the one that gets to do the work. Reserving here (rather
-- than recording at the end) is what makes a simultaneous duplicate submission
-- wait instead of racing.
create or replace function internal.ledger_replay(p_cmid text, p_operation text) returns jsonb
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  row public.command_ledger;
  reserved boolean;
  attempt integer := 0;
begin
  perform internal.bind_cmid(p_cmid);
  if p_cmid is null or btrim(p_cmid) = '' then
    return null;
  end if;

  loop
    attempt := attempt + 1;

    -- The reservation IS the lock. A concurrent submitter of the same cmid blocks
    -- here on the primary key until we commit or abort.
    insert into public.command_ledger(client_mutation_id, identity_id, actor_id, operation)
    values (p_cmid, internal.identity_id(), internal.actor_id(), p_operation)
    on conflict (client_mutation_id) do nothing;
    reserved := found;
    if reserved then
      return null;                       -- ours: run the body
    end if;

    select * into row from public.command_ledger where client_mutation_id = p_cmid;
    if row.client_mutation_id is not null then
      if row.operation <> p_operation then
        raise exception 'client mutation id % already used for operation %', p_cmid, row.operation
          using errcode = '23514',
                detail = 'one clientMutationId belongs to one operation (DEV-9)';
      end if;
      -- A committed reservation always carries its result, because the RPC records
      -- it before committing. The coalesce covers the pathological case of a
      -- committed reservation with none, and keeps the old contract: a replay
      -- returns a non-null jsonb so the caller's `if replay is not null` fires.
      return coalesce(row.result, '{}'::jsonb);
    end if;

    -- Neither reserved nor found: the holder aborted between our INSERT and our
    -- SELECT. Go round once more and claim it. Bounded so a pathological
    -- interleaving cannot spin forever.
    if attempt >= 5 then
      raise exception 'could not settle the command ledger for %', p_cmid
        using errcode = '40001', detail = 'repeated contention on the cmid reservation';
    end if;
  end loop;
end
$$;

-- Called just BEFORE returning: fills in the result on the row ledger_replay
-- reserved. The upsert also covers a caller that reached here without a
-- reservation (nothing in the catalog does, but the function should not depend on
-- that), and never overwrites a result that is already stored.
create or replace function internal.ledger_record(p_cmid text, p_operation text, p_result jsonb)
returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare
  stored_operation text;
  stored_result jsonb;
begin
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

comment on table public.command_ledger is
  'Universal idempotency envelope AND the execution audit trail: every mutation, '
  'including every execution.* command, records here (DEV-9, S10). 24h TTL. '
  'A row is RESERVED with a NULL result at the top of the RPC (012) and filled in '
  'before it returns, so a simultaneous duplicate submission waits on the primary '
  'key rather than running the body twice.';

reset role;
