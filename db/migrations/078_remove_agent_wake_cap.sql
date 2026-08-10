-- THE AGENT WAKE CAP IS REMOVED. A PAIR OF SESSIONS TALKS UNTIL THE WORK IS DONE.
--
-- 015 §7 budgeted every unordered session pair at 4 consecutive teammate wakes,
-- reset only by a member reply (`messages.delivery.memberReset`). The intent was
-- a loop guard: two agents must not ping-pong forever with no human in sight.
--
-- WHAT IT ACTUALLY DID, measured on a live node 2026-08-07: a coordinator and
-- its worker are EXACTLY a long agent-to-agent exchange with no human inside the
-- pair. Assignment, ack, "PR open", "tests green", "merged" is already five
-- wakes. Six of nineteen live pairs sat at the cap; in three days, six of
-- forty-three deliveries settled `failed_permanent`/`automated_wake_limit` — all
-- six were one worker's milestone reports to its coordinator, and the
-- coordinator heard none of them. The sender was never told: `messages.post`
-- answers with a message id and the refusal lands only in the deliveries table.
-- A loop guard that silences a working hierarchy after two round trips is not
-- guarding loops — it is the loop guard that is breaking coordination.
--
-- THE RULING (owner, task 019fd7ec-f1f7-79b6-874d-9b92e72b49ed): no cap. The
-- budget row and its counter SURVIVE AS TELEMETRY — `consecutive_agent_wakes`
-- keeps counting and `memberReset` keeps zeroing it, so a runaway pair is still
-- measurable and a future guard can be tuned on real numbers — but no delivery
-- is ever refused because of it. Runaway cost is bounded the way everything
-- else here is bounded: by the humans watching the space, not by a hard-coded 4
-- that cannot tell a loop from a wave.

-- ---------------------------------------------------------------------------
-- 1. The counter is unbounded telemetry now, so the 0..4 check must go first —
--    otherwise the fifth increment below would violate it.
-- ---------------------------------------------------------------------------
do $$
declare cap_constraint text;
begin
  select conname into cap_constraint
    from pg_constraint
   where conrelid = 'public.session_wake_budgets'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%consecutive_agent_wakes%';
  if cap_constraint is not null then
    execute format(
      'alter table public.session_wake_budgets drop constraint %I', cap_constraint);
  end if;
end $$;

comment on column public.session_wake_budgets.consecutive_agent_wakes is
  'Telemetry since 078: consecutive teammate-authored wakes of this pair, reset by a member reply. No longer enforced — no delivery is refused because of it.';

-- ---------------------------------------------------------------------------
-- 2. Reservation without the refusal branch. This is 019's definition (the
--    latest in the chain — 015 §7 introduced it, 019 redefined it) with the
--    `consecutive_agent_wakes = 4` refusal removed and NOTHING else changed:
--    idempotent replay, provenance requirement, self-contact refusal, the
--    `session_not_live` settlement and the telemetry increment all stand.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_session_message_delivery(
  p_delivery_id uuid,p_message_id uuid,p_target_work_session_id uuid,
  p_attempt_no integer default 1
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
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
    insert into public.session_message_deliveries(
      delivery_id,message_id,source_work_session_id,target_work_session_id,
      status,attempt_no,failure_reason,settled_at
    ) values(
      p_delivery_id,p_message_id,source_session,p_target_work_session_id,
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

  -- The pair budget row is still derived, locked and incremented — 078 removed
  -- only the refusal that used to live here. The count is telemetry.
  if source_session is not null then
    low_session:=least(source_session,p_target_work_session_id);
    high_session:=greatest(source_session,p_target_work_session_id);
    insert into public.session_wake_budgets(low_work_session_id,high_work_session_id)
      values(low_session,high_session) on conflict do nothing;
    select * into budget from public.session_wake_budgets
     where low_work_session_id=low_session and high_work_session_id=high_session for update;
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
$$;
