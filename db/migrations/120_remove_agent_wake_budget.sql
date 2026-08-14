-- =============================================================================
-- 120  REMOVE THE AGENT WAKE BUDGET.
--
-- WHAT IS BEING REMOVED, EXACTLY. Not the pair row, not its version, not the
-- delivery ledger -- only the CAP. Since 015 the fifth consecutive
-- Teammate-authored live delivery on an unordered session pair was refused as
-- `failed_permanent`/`automated_wake_limit`, and the pair could only be freed
-- by a Member reply that resolved to exactly one pair. That breaker is gone
-- here. A session may now wake another session as many times as the work needs.
--
-- WHY THIS IS TWO STATEMENTS AND NOT ONE. The cap has two halves and deleting
-- the visible one alone makes things WORSE, not better:
--
--   the refusal branch  `if budget.consecutive_agent_wakes = 4 then ...`
--   the column check    `check (consecutive_agent_wakes between 0 and 4)`
--
-- The branch RETURNS before the increment, so the check never fired in
-- production -- the branch was the only thing keeping the counter inside its
-- own constraint. Drop the branch and leave the check, and the fifth wake stops
-- being a settled `automated_wake_limit` row the caller can read and becomes a
-- raw 23514 out of an UPDATE inside a SECURITY DEFINER function running as the
-- delivery worker: no delivery row, no workspace event, no inbox fallback, and
-- the reservation aborts. That is a strictly worse cap, not the absence of one.
-- So the constraint goes first, in the same transaction.
--
-- WHAT SURVIVES, AND WHY EACH THING SURVIVES.
--
--   * `public.session_wake_budgets` and its rows. `version` is the optimistic
--     pin threaded through reserve -> claim -> settle and asserted by
--     `internal.require_delivery_principal`; the delivery worker's whole
--     principal binding carries it. Retiring the table would be a rewrite of
--     the delivery principal contract, which is a different change with a
--     different blast radius. The row stays, the lock stays, the version stays.
--   * `consecutive_agent_wakes` keeps being counted. It now governs NOTHING and
--     is pure telemetry -- "how many consecutive agent wakes has this pair
--     taken" is still the number you want when a loop is suspected. It is now
--     unbounded, which is why the 0..4 check had to go.
--   * `public.reset_session_wake_budget_for_member_reply` (015) still resets the
--     counter and still bumps `version`. It no longer un-blocks anything
--     because nothing is blocked; it is left callable so the 015 tm8_app RPC
--     allowlist and every caller of it keep working unchanged.
--   * The `automated_wake_limit` value stays in the contract's failure-reason
--     union and in the UI's reason map. Rows written before this migration
--     still carry it and must still render.
--
-- WHAT IS DELIBERATELY NOT REMOVED. The self-contact refusal
-- (`session_contact_forbidden`) stays. It is not a cap -- it is the guard that
-- stops a session being handed its own message, and without it a session that
-- messages its own anchor wakes itself, forever. `rollingControlMaxBytes`
-- (message-dispatch.ts) also stays: it bounds one ENVELOPE against the target's
-- interaction-profile prompt policy, and has nothing to do with how many
-- deliveries a pair may make.
--
-- GENERATED from pg_get_functiondef, not transcribed, and 040's header explains
-- why that matters here: 015 defines this function, 019 redefines it and 040
-- redefines it again, so a reader working from 015 is reading a body that has
-- not run in a long time. The text below is 040's live body with the
-- `automated_wake_limit` branch -- and only that branch -- deleted.
-- =============================================================================

set role tm8_graph_owner;

alter table public.session_wake_budgets
  drop constraint session_wake_budgets_consecutive_agent_wakes_check;

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

reset role;
