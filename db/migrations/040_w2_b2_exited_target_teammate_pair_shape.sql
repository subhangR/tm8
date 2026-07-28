-- =============================================================================
-- 040  W2 B2 — a TEAMMATE-authored delivery to an EXITED or FAILED target
--              wrote ZERO rows and made its own fallback unreachable.
--
-- THE DEFECT, measured on the applied 34-file chain (a799b7ef1b20a9b0):
--
--   MEMBER-authored   -> exited target: ROW WRITTEN failed_permanent/session_not_live
--   TEAMMATE-authored -> exited target: RAISED 23514 pair_shape, ZERO ROWS
--
--   The discriminator is source_work_session_id. A Member-authored message has
--   no authored_from edge, so source is NULL and all three pair_ columns are
--   NULL -- which SATISFIES pair_shape's first arm. A Teammate-authored message
--   carries an authored_from edge, so source is NON-NULL while the pair_ columns
--   were left NULL -- which VIOLATES it. One branch, both arms of the
--   constraint, and only one arm ever executed correctly.
--
-- WHY THE BROKEN HALF IS THE WORSE HALF. Teammate-to-Teammate is the only path
--   B2 exists to govern. A Member can always get a record of a dead target; a
--   TEAMMATE NEVER CAN. And internal.w2_delivery_fallback is called BELOW the
--   failing insert, so the fallback written to catch an undeliverable Teammate
--   message was unreachable FOR THE ENTIRE CLASS IT WAS WRITTEN FOR. Repairing
--   the insert makes the existing fallback call reachable; no reordering needed.
--
-- SCOPE, stated narrowly on purpose. This defect was RESCOPED BY ITS OWN FILER
--   (handoff 24.3) after a cross-wave contradiction: the original filing --
--   "every wake aimed at an exited or failed session returns an invariant
--   violation" -- is FALSE, because the Member half works as designed. Do not
--   re-widen it. This migration changes the exited/failed branch ONLY, and the
--   Member path through it is byte-for-byte unchanged in behaviour.
--
-- WHAT THIS DOES NOT DO. It does not increment consecutive_agent_wakes. The
--   automated_wake_limit branch does not either, and for the same reason:
--   nothing was delivered. Charging a wake for an undeliverable message would
--   let a dead target drain a live pair's budget.
--
-- GENERATED from pg_get_functiondef, not transcribed. 015 defines this function
--   and 019 REDEFINES it; only 019's carries the exited/failed branch, so a
--   reader working from 015 would conclude this failure is impossible. The
--   generator refuses to emit unless the branch matches the expected shape.
-- =============================================================================

set role tm8_graph_owner;

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
    if budget.consecutive_agent_wakes=4 then
      insert into public.session_message_deliveries(
        delivery_id,message_id,source_work_session_id,target_work_session_id,
        pair_low_session_id,pair_high_session_id,pair_budget_version,
        status,attempt_no,failure_reason,settled_at
      ) values(
        p_delivery_id,p_message_id,source_session,p_target_work_session_id,
        low_session,high_session,budget.version,
        'failed_permanent',p_attempt_no,'automated_wake_limit',now()
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
