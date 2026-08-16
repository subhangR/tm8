-- =============================================================================
-- 139  RESTORE THE DELIVERY PAIR-BUDGET PIN ON NODES THAT TOOK THE ORPHAN 083.
--
-- WHAT THIS REPAIRS. `session_message_deliveries.pair_budget_version` is the
-- optimistic pin threaded through reserve -> claim -> settle and asserted by
-- `internal.require_delivery_principal`. 015:191 declares the column, 015:202-208
-- makes it load-bearing in `session_message_deliveries_pair_shape`, and 019/039/
-- 040/120 each carry it through every function that touches the ledger. Main has
-- never dropped it and no migration here drops it: on a database built from this
-- chain the whole block below is a no-op.
--
-- Some nodes are not built from this chain. A file numbered 083 that never
-- reached main -- `083_remove_session_wake_budgets.sql` -- dropped the column,
-- rewrote the pair_shape check without it, and stripped the pin out of all five
-- functions below. Main shipped the same feature (removing the WAKE CAP, and only the
-- cap) later, as 120. The runner keys the ledger on filename, so a node that took
-- both has TWO rows numbered 083 and a delivery ledger that disagrees with this
-- chain. The duplicate-number guard in db/migrate.mjs (:143-148) stops a new
-- collision; it cannot retroactively undo one that already applied.
--
-- WHY THIS PRESENTS AS "PTY INJECTION IS DEAD" AND NOTHING ELSE. plpgsql is
-- late-bound: `create or replace` of 120's reserve body against the drifted table
-- SUCCEEDS, and the missing column only raises 42703 when the function is first
-- CALLED. So the deploy is green, routes are still written, messages.post still
-- answers 200 with a message id -- and `session_message_deliveries` gets zero
-- rows, so no message is ever injected into any agent's PTY. Diagnose from that
-- table being empty, never from the PTY, which is innocent and never receives a
-- byte. This is what happened on the :7778 node on 2026-08-16; it was repaired by
-- hand, live, with no record here, which is exactly why the next `create or
-- replace` of any of these functions would have re-broken it identically.
--
-- THE BACKFILL. Restoring the pair_shape check requires a non-null pin on every
-- row that has a source session. The real version is recoverable only where the
-- pair row still exists; everywhere else this writes 1, and the floor is 1 rather
-- than 0 because 0 is a SENTINEL one layer up and a row holding it could never be
-- settled -- see the long note at the update itself. On a node whose
-- `session_wake_budgets` stub is empty, EVERY backfilled row takes the fallback.
--
-- What the backfilled value is NOT relied upon to do: it is never compared against
-- a version the server computed for that same delivery, because every row it
-- touches was reserved before this migration ran. Rows still sitting in
-- `dispatching` from a dead session are settled by
-- `internal.w1_prune_operational_state` through a direct owner UPDATE rather than
-- through `settle_session_message_delivery`, so the pin check never applies to
-- them either. Both of those are properties of the population, though, not of the
-- migration -- which is exactly why the value must be outside the sentinel range
-- rather than merely unread today.
--
-- THE GUARD IS PART OF THE REPAIR, NOT AN EXTRA. `internal.guard_session_message_delivery`
-- is the BEFORE trigger behind `session_message_deliveries_guard`, and the orphan
-- stripped exactly one line from it:
--     or new.pair_budget_version is distinct from old.pair_budget_version
-- (verified by diffing the live body against a chain-built one -- that line is the
-- ONLY difference, so re-asserting it re-arms pin immutability and changes nothing
-- else). Without it this migration restores the pin as DATA and leaves it as
-- DECORATION: `update ... set pair_budget_version = 999` is accepted on a node
-- repaired without the guard and refused once the guard is back. Restoring an
-- optimistic-concurrency pin while leaving its enforcement stripped would be the
-- weakest possible version of this change. The trigger itself still exists on the
-- drifted node, so replacing the function is sufficient.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT FIX. The orphan demolished the whole
-- wake-budget area, and the drift is WIDER than what is repaired here. Do not read
-- a clean run of this file as "the node is converged" -- that false confidence is
-- what produced the original outage. Still divergent afterwards, all in the
-- wake-budget area and none of them on the delivery hot path:
--   * `internal.w1_prune_operational_state` -- body still drifted (lost the wake-budget
--     retention sweep and the `budgetsDeleted` key). Its delivery-settling loops are
--     intact, which is why the reaper still settles rows.
--   * `internal.validate_wake_budget` and
--     `public.reset_session_wake_budget_for_member_reply` -- missing entirely.
--   * `public.session_wake_budgets` -- present but a BARE STUB: RLS disabled, zero
--     grants, no select policy, no validate trigger. Fails CLOSED (with no grants at
--     all `tm8_app` cannot read it regardless of RLS), so this is a consistency defect
--     rather than an exposure. Its COLUMNS do match the chain, which is the only
--     reason the backfill subquery above works on such a node.
--   * `tm8_app=X` on reserve_/claim_session_message_delivery -- an EXTRA grant the
--     chain does not make, which CREATE OR REPLACE preserves. Inert, because
--     `require_delivery_principal` gates on `session_user = 'tm8_delivery_worker'`.
--
-- HOW SUCH A NODE CAME TO EXIST AT ALL, since it matters for anyone repeating this:
-- the drift is NOT reachable by running this chain. On a database built as
-- chain-to-082 + the orphan + the rest, migration 120 ABORTS at its opening
-- `alter table public.session_wake_budgets` because the orphan dropped that table.
-- So the affected node cannot have reached 120 through the runner -- the stub was
-- created BY HAND to get past it, which is precisely why it carries no RLS, no
-- grants, no policy and no trigger.
--
-- The five function bodies below are reproduced verbatim from a database built
-- from this chain (pg_get_functiondef), so re-asserting them cannot introduce a
-- variant definition. CREATE OR REPLACE preserves existing EXECUTE grants; a
-- DROP + CREATE would not, which is why this file never drops.
-- =============================================================================

set role tm8_graph_owner;

do $repair$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'session_message_deliveries'
       and column_name  = 'pair_budget_version'
  ) then
    raise notice '139: pair_budget_version already present; schema half is a no-op';
  else
    raise notice '139: pair_budget_version missing -- restoring column, backfill and check';

    alter table public.session_message_deliveries add column pair_budget_version integer;

    -- The fallback is 1, NOT 0, and that is not cosmetic. 0 is already spoken
    -- for as a sentinel one layer up: `execution.ts:737-739` reads a null pin
    -- out as `reservationVersion: 0`, and `:763-766` maps
    -- `reservationVersion === 0` back to a NULL `pairBudgetVersion`. So a row
    -- storing a literal 0 can never round-trip -- settle sends NULL, the
    -- function's `delivery.pair_budget_version is distinct from
    -- p_pair_budget_version` sees `0 is distinct from null` = true, and the
    -- delivery is refused with `delivery reservation not found`. Any value >= 1
    -- is outside the sentinel and survives the trip.
    update public.session_message_deliveries d
       set pair_budget_version = greatest(coalesce(
             (select b.version
                from public.session_wake_budgets b
               where b.low_work_session_id  = d.pair_low_session_id
                 and b.high_work_session_id = d.pair_high_session_id),
             1), 1)
     where d.source_work_session_id is not null
       and d.pair_budget_version is null;

    alter table public.session_message_deliveries
      drop constraint if exists session_message_deliveries_pair_shape;

    alter table public.session_message_deliveries
      add constraint session_message_deliveries_pair_shape check (
        (source_work_session_id is null and pair_low_session_id is null
          and pair_high_session_id is null and pair_budget_version is null)
        or (source_work_session_id is not null and pair_low_session_id is not null
          and pair_high_session_id is not null and pair_budget_version is not null
          and pair_low_session_id < pair_high_session_id)
      );
  end if;
end
$repair$;

-- The canonical bodies. Identical to what this chain already produces, so this
-- half is a no-op on a healthy node and the convergence step on a drifted one.

CREATE OR REPLACE FUNCTION internal.require_delivery_principal(expected_delivery uuid, expected_message uuid, expected_target uuid, expected_budget_version integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare expires_at timestamptz;
begin
  -- TIGHTENED (039). Was an AND with current_setting('role'), which a superuser
  -- satisfied by assuming the role. session_user survives SET ROLE; that is the
  -- entire point.
  if session_user <> 'tm8_delivery_worker' then
    raise exception 'system delivery adapter database role required' using errcode = '42501';
  end if;
  if internal.claim_text('tm8.principal_type') <> 'system_delivery_adapter'
     or nullif(internal.claim_text('tm8.delivery_id'), '')::uuid is distinct from expected_delivery
     or nullif(internal.claim_text('tm8.delivery_message_id'), '')::uuid is distinct from expected_message
     or nullif(internal.claim_text('tm8.delivery_target_work_session_id'), '')::uuid
          is distinct from expected_target then
    raise exception 'delivery principal tuple mismatch' using errcode = '42501';
  end if;
  if expected_budget_version is not null
     and nullif(internal.claim_text('tm8.delivery_pair_budget_version'), '')::integer
          is distinct from expected_budget_version then
    raise exception 'delivery reservation version mismatch' using errcode = '42501';
  end if;
  expires_at := nullif(internal.claim_text('tm8.delivery_expires_at'), '')::timestamptz;
  if expires_at is null or expires_at <= now() then
    raise exception 'delivery principal expired' using errcode = '42501';
  end if;
  if internal.actor_id() is not null or internal.acting_as() is not null then
    raise exception 'delivery principal cannot carry actor claims' using errcode = '42501';
  end if;
end
$function$
;

CREATE OR REPLACE FUNCTION public.claim_session_message_delivery(p_delivery_id uuid, p_message_id uuid, p_target_work_session_id uuid, p_pair_budget_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare delivery public.session_message_deliveries;
begin
  perform internal.require_delivery_principal(
    p_delivery_id,p_message_id,p_target_work_session_id,p_pair_budget_version);
  select * into delivery from public.session_message_deliveries
   where delivery_id=p_delivery_id for update;
  if delivery.delivery_id is null or delivery.message_id<>p_message_id
     or delivery.target_work_session_id<>p_target_work_session_id
     or delivery.pair_budget_version is distinct from p_pair_budget_version then
    raise exception 'delivery reservation not found' using errcode='P0002';
  end if;
  if delivery.status='pending' then
    update public.session_message_deliveries set status='dispatching',claimed_at=now()
     where delivery_id=p_delivery_id returning * into delivery;
  end if;
  -- dispatching is an idempotent same-process replay. Terminal rows are returned
  -- verbatim so a durable consumer never turns replay into a second byte write.
  return to_jsonb(delivery);
end
$function$
;

CREATE OR REPLACE FUNCTION public.reserve_session_message_delivery(p_delivery_id uuid, p_message_id uuid, p_target_work_session_id uuid, p_attempt_no integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  source_session uuid; message_space uuid; author_kind text; target_status text;
  low_session uuid; high_session uuid; budget public.session_wake_budgets;
  delivery public.session_message_deliveries;
begin
  perform internal.require_delivery_principal(
    p_delivery_id,p_message_id,p_target_work_session_id,null);
  select * into delivery from public.session_message_deliveries
   where delivery_id=p_delivery_id for update;
  if delivery.delivery_id is not null then
    if delivery.message_id<>p_message_id
       or delivery.target_work_session_id<>p_target_work_session_id
       or delivery.attempt_no<>p_attempt_no then
      raise exception 'delivery reservation identity mismatch' using errcode='23514';
    end if;
    return to_jsonb(delivery);
  end if;

  select author.kind,message_envelope.space_id into author_kind,message_space
    from public.messages m
    join public.entities author on author.id=m.author_id
    join public.entities message_envelope on message_envelope.id=m.entity_id
   where m.entity_id=p_message_id and m.redacted_at is null;
  if author_kind is null then raise exception 'message not found' using errcode='P0002'; end if;
  select edge.dst_id into source_session from public.edges edge
   where edge.src_id=p_message_id and edge.type='authored_from';
  if author_kind='team_member' and source_session is null then
    raise exception 'Teammate delivery requires immutable source-session provenance'
      using errcode='23514';
  end if;
  if source_session=p_target_work_session_id then
    raise exception 'self-contact is forbidden' using errcode='42501',
      detail='session_contact_forbidden';
  end if;
  select status into target_status from public.work_sessions
   where entity_id=p_target_work_session_id;
  if target_status is null then raise exception 'target work session not found' using errcode='P0002'; end if;
  if target_status in ('exited','failed') then
    -- 040 REPAIR. A TEAMMATE-authored message carries an authored_from edge,
    -- so source_session is NON-NULL here, and pair_shape (015:202-208) then
    -- REQUIRES all three pair_ columns. The original branch left them NULL, so
    -- this insert raised 23514 and wrote ZERO ROWS for every Teammate-authored
    -- wake at an exited or failed target -- and w2_delivery_fallback, which
    -- sits BELOW this statement, was unreachable for the entire class it was
    -- written to serve. A Member could always get a record of a dead target; a
    -- Teammate never could, and Teammate-to-Teammate is the only path B2 exists
    -- to govern.
    --
    -- Establish the pair identity exactly as the automated_wake_limit branch
    -- already does. DELIBERATELY WITHOUT incrementing consecutive_agent_wakes:
    -- nothing was delivered, so nothing was woken, and charging a wake for an
    -- undeliverable message would let a dead target exhaust a live pair's
    -- budget. The row is locked FOR UPDATE so the version recorded is the
    -- version that was current under the lock.
    if source_session is not null then
      low_session:=least(source_session,p_target_work_session_id);
      high_session:=greatest(source_session,p_target_work_session_id);
      insert into public.session_wake_budgets(low_work_session_id,high_work_session_id)
        values(low_session,high_session) on conflict do nothing;
      select * into budget from public.session_wake_budgets
       where low_work_session_id=low_session and high_work_session_id=high_session for update;
    end if;
    insert into public.session_message_deliveries(
      delivery_id,message_id,source_work_session_id,target_work_session_id,
      pair_low_session_id,pair_high_session_id,pair_budget_version,
      status,attempt_no,failure_reason,settled_at
    ) values(
      p_delivery_id,p_message_id,source_session,p_target_work_session_id,
      low_session,high_session,
      case when source_session is null then null else budget.version end,
      'failed_permanent',p_attempt_no,'session_not_live',now()
    ) returning * into delivery;
    insert into public.workspace_events(space_id,seq,event_type,payload)
    values(message_space,internal.next_event_seq(message_space),'message.delivery_reserved',
      jsonb_build_object('deliveryId',p_delivery_id,'messageId',p_message_id,
        'targetWorkSessionId',p_target_work_session_id,'status',delivery.status,
        'attemptNo',p_attempt_no));
    insert into public.workspace_events(space_id,seq,event_type,payload)
    values(message_space,internal.next_event_seq(message_space),'message.delivery_settled',
      jsonb_build_object('deliveryId',p_delivery_id,'messageId',p_message_id,
        'targetWorkSessionId',p_target_work_session_id,'status',delivery.status,
        'reason',delivery.failure_reason,'attemptNo',p_attempt_no));
    perform internal.w2_delivery_fallback(p_message_id,delivery.status,delivery.failure_reason);
    return to_jsonb(delivery);
  end if;

  if source_session is not null then
    low_session:=least(source_session,p_target_work_session_id);
    high_session:=greatest(source_session,p_target_work_session_id);
    insert into public.session_wake_budgets(low_work_session_id,high_work_session_id)
      values(low_session,high_session) on conflict do nothing;
    select * into budget from public.session_wake_budgets
     where low_work_session_id=low_session and high_work_session_id=high_session for update;
    -- 120: the `automated_wake_limit` branch stood HERE, between the pair lock
    -- above and the increment below. The pair row is still created and still
    -- locked FOR UPDATE -- that lock is what serialises two concurrent
    -- reservations onto one `version`, and it is load-bearing for claim/settle
    -- whether or not anything is being capped.
    update public.session_wake_budgets
       set consecutive_agent_wakes=consecutive_agent_wakes+1,
           version=version+1,eligible_for_cleanup_at=null
     where low_work_session_id=low_session and high_work_session_id=high_session
     returning * into budget;
  end if;

  insert into public.session_message_deliveries(
    delivery_id,message_id,source_work_session_id,target_work_session_id,
    pair_low_session_id,pair_high_session_id,pair_budget_version,status,attempt_no
  ) values(
    p_delivery_id,p_message_id,source_session,p_target_work_session_id,
    low_session,high_session,case when source_session is null then null else budget.version end,
    'pending',p_attempt_no
  ) returning * into delivery;
  insert into public.workspace_events(space_id,seq,event_type,payload)
  values(message_space,internal.next_event_seq(message_space),'message.delivery_reserved',
    jsonb_build_object('deliveryId',p_delivery_id,'messageId',p_message_id,
      'targetWorkSessionId',p_target_work_session_id,'status',delivery.status,
      'attemptNo',p_attempt_no));
  return to_jsonb(delivery);
end
$function$
;

CREATE OR REPLACE FUNCTION public.settle_session_message_delivery(p_delivery_id uuid, p_message_id uuid, p_target_work_session_id uuid, p_pair_budget_version integer, p_status text, p_failure_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare delivery public.session_message_deliveries; message_space uuid;
begin
  perform internal.require_delivery_principal(
    p_delivery_id,p_message_id,p_target_work_session_id,p_pair_budget_version);
  if p_status not in ('delivered','failed_retryable','failed_permanent','unknown') then
    raise exception 'invalid delivery settlement status' using errcode='22023';
  end if;
  select * into delivery from public.session_message_deliveries
   where delivery_id=p_delivery_id for update;
  if delivery.delivery_id is null or delivery.message_id<>p_message_id
     or delivery.target_work_session_id<>p_target_work_session_id
     or delivery.pair_budget_version is distinct from p_pair_budget_version then
    raise exception 'delivery reservation not found' using errcode='P0002';
  end if;
  if delivery.status='dispatching' then
    update public.session_message_deliveries
       set status=p_status,failure_reason=p_failure_reason,settled_at=now()
     where delivery_id=p_delivery_id returning * into delivery;
    select e.space_id into message_space from public.entities e where e.id=p_message_id;
    insert into public.workspace_events(space_id,seq,event_type,payload)
    values(message_space,internal.next_event_seq(message_space),'message.delivery_settled',
      jsonb_build_object('deliveryId',p_delivery_id,'messageId',p_message_id,
        'targetWorkSessionId',p_target_work_session_id,'status',p_status,
        'reason',p_failure_reason,'attemptNo',delivery.attempt_no));
    if p_status<>'delivered' then
      perform internal.w2_delivery_fallback(p_message_id,p_status,p_failure_reason);
    end if;
  elsif delivery.status<>p_status then
    raise exception 'delivery cannot settle from status %',delivery.status using errcode='23514';
  end if;
  return to_jsonb(delivery);
end
$function$
;

CREATE OR REPLACE FUNCTION internal.guard_session_message_delivery()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare message_space uuid; source_space uuid; target_space uuid;
begin
  if tg_op = 'UPDATE' then
    if new.delivery_id <> old.delivery_id or new.message_id <> old.message_id
       or new.source_work_session_id is distinct from old.source_work_session_id
       or new.target_work_session_id <> old.target_work_session_id
       or new.pair_low_session_id is distinct from old.pair_low_session_id
       or new.pair_high_session_id is distinct from old.pair_high_session_id
       or new.pair_budget_version is distinct from old.pair_budget_version
       or new.attempt_no <> old.attempt_no or new.reserved_at <> old.reserved_at then
      raise exception 'delivery reservation identity is immutable' using errcode = '23514';
    end if;
    if not (
      new.status = old.status
      or (old.status = 'pending' and new.status in
        ('dispatching','failed_permanent','expired','cancelled'))
      or (old.status = 'dispatching' and new.status in
        ('delivered','failed_retryable','failed_permanent','unknown'))
    ) then
      raise exception 'illegal delivery transition % -> %', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  select e.space_id into message_space from public.messages m
    join public.entities e on e.id = m.entity_id where m.entity_id = new.message_id;
  select e.space_id into target_space from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id where ws.entity_id = new.target_work_session_id;
  if new.source_work_session_id is not null then
    select e.space_id into source_space from public.work_sessions ws
      join public.entities e on e.id = ws.entity_id where ws.entity_id = new.source_work_session_id;
  end if;
  if message_space is null or target_space is null or message_space <> target_space
     or (new.source_work_session_id is not null and source_space <> target_space)
     or new.source_work_session_id = new.target_work_session_id then
    raise exception 'delivery message and sessions must be distinct same-Space endpoints'
      using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end
$function$
;

reset role;
