-- =============================================================================
-- 083  THE WAKE BUDGET IS REMOVED. Not relaxed, not raised, not kept as
--      telemetry — removed. A pair of sessions talks until the work is done.
--
-- WHAT WAS THERE. 015 §7 gave every unordered pair of work sessions a budget of
-- 4 consecutive teammate-authored wakes. The fifth reservation settled itself
-- `failed_permanent` / `automated_wake_limit` and returned. Only
-- `public.reset_session_wake_budget_for_member_reply` zeroed the counter.
--
-- WHY IT GOES. Measured on this node 2026-08-07, on the database behind the
-- live server: of 39 budgeted pairs, 15 sat AT the cap; 16 deliveries in three
-- hours settled `automated_wake_limit`. A coordinator and its worker are
-- exactly a long agent-to-agent exchange with no human inside the pair —
-- assign, ack, "baseline recorded", "red", "green", "lane complete" is already
-- six wakes — so the guard fires on precisely the traffic the system exists to
-- carry. It fires SILENTLY: `messages.post` answers with a message id and the
-- refusal lands only in `session_message_deliveries`, so the sender believes it
-- was heard. And the documented remedy never ran: the member-reset RPC has
-- ZERO production callers anywhere in `packages/**` — a human replying in the
-- UI cleared nothing. A loop guard that cannot tell a working hierarchy from a
-- runaway, silences the former, and offers a reset nothing calls, is not a
-- guard. Runaway cost is bounded here the way everything else is: by the
-- humans watching the space.
--
-- WHAT SURVIVES. `pair_low_session_id` / `pair_high_session_id` stay on
-- `session_message_deliveries`. They are honest provenance — which two sessions
-- an attempt joined — and 040 depends on their shape. Only the budget VERSION
-- goes, because there is no longer a budget to version.
--
-- WIRE COMPATIBILITY, deliberate. `claim_` / `settle_session_message_delivery`
-- and `internal.require_delivery_principal` KEEP their budget-version
-- parameter and simply ignore it. The server binary serving :7778 is a frozen
-- snapshot that calls these with four and six arguments; dropping a parameter
-- here would break every delivery on the node the moment this applied. The
-- parameter is removed in the same change that rebuilds that binary.
--
-- Bases: `reserve_` from 040 (NOT 019 — 040 repaired the exited-target branch
-- that wrote zero rows for teammate messages, and that repair is preserved
-- below), `w1_prune_operational_state` from 019, the rest from 015.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The delivery row loses its budget version. pair_shape no longer ties the
--    pair columns to a version; it still requires the pair to be present and
--    ordered exactly when there is a source session.
-- -----------------------------------------------------------------------------
alter table public.session_message_deliveries
  drop constraint session_message_deliveries_pair_shape;

create or replace function internal.guard_session_message_delivery() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare message_space uuid; source_space uuid; target_space uuid;
begin
  if tg_op = 'UPDATE' then
    if new.delivery_id <> old.delivery_id or new.message_id <> old.message_id
       or new.source_work_session_id is distinct from old.source_work_session_id
       or new.target_work_session_id <> old.target_work_session_id
       or new.pair_low_session_id is distinct from old.pair_low_session_id
       or new.pair_high_session_id is distinct from old.pair_high_session_id
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
$$;

alter table public.session_message_deliveries drop column pair_budget_version;

alter table public.session_message_deliveries
  add constraint session_message_deliveries_pair_shape check (
    (source_work_session_id is null and pair_low_session_id is null
      and pair_high_session_id is null)
    or (source_work_session_id is not null and pair_low_session_id is not null
      and pair_high_session_id is not null
      and pair_low_session_id < pair_high_session_id)
  );

-- -----------------------------------------------------------------------------
-- 2. Reservation with no budget at all. This is 040's body with every
--    `session_wake_budgets` statement and the `consecutive_agent_wakes = 4`
--    refusal removed. Everything else stands verbatim: idempotent replay, the
--    teammate provenance requirement, the self-contact refusal, and 040's
--    exited-target settlement WITH its pair columns.
-- -----------------------------------------------------------------------------
create or replace function public.reserve_session_message_delivery(
  p_delivery_id uuid,p_message_id uuid,p_target_work_session_id uuid,
  p_attempt_no integer default 1
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  source_session uuid; message_space uuid; author_kind text; target_status text;
  low_session uuid; high_session uuid;
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
  if source_session is not null then
    low_session:=least(source_session,p_target_work_session_id);
    high_session:=greatest(source_session,p_target_work_session_id);
  end if;
  select status into target_status from public.work_sessions
   where entity_id=p_target_work_session_id;
  if target_status is null then raise exception 'target work session not found' using errcode='P0002'; end if;
  if target_status in ('exited','failed') then
    -- 040's repair, preserved. A teammate-authored message carries an
    -- authored_from edge, so pair_shape REQUIRES both pair columns here; the
    -- original branch left them NULL, raised 23514, wrote zero rows, and made
    -- w2_delivery_fallback unreachable for the whole class it serves.
    insert into public.session_message_deliveries(
      delivery_id,message_id,source_work_session_id,target_work_session_id,
      pair_low_session_id,pair_high_session_id,
      status,attempt_no,failure_reason,settled_at
    ) values(
      p_delivery_id,p_message_id,source_session,p_target_work_session_id,
      low_session,high_session,
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

  insert into public.session_message_deliveries(
    delivery_id,message_id,source_work_session_id,target_work_session_id,
    pair_low_session_id,pair_high_session_id,status,attempt_no
  ) values(
    p_delivery_id,p_message_id,source_session,p_target_work_session_id,
    low_session,high_session,'pending',p_attempt_no
  ) returning * into delivery;
  insert into public.workspace_events(space_id,seq,event_type,payload)
  values(message_space,internal.next_event_seq(message_space),'message.delivery_reserved',
    jsonb_build_object('deliveryId',p_delivery_id,'messageId',p_message_id,
      'targetWorkSessionId',p_target_work_session_id,'status',delivery.status,
      'attemptNo',p_attempt_no));
  return to_jsonb(delivery);
end
$$;

-- -----------------------------------------------------------------------------
-- 3. The principal tuple no longer carries a budget version. The parameter and
--    the `tm8.delivery_pair_budget_version` claim are accepted and ignored so
--    the frozen server binary keeps authenticating; the identity that matters
--    — delivery, message, target, expiry, no actor claims — is unchanged.
-- -----------------------------------------------------------------------------
create or replace function internal.require_delivery_principal(
  expected_delivery uuid, expected_message uuid, expected_target uuid,
  expected_budget_version integer default null
) returns void language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare expires_at timestamptz;
begin
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
  expires_at := nullif(internal.claim_text('tm8.delivery_expires_at'), '')::timestamptz;
  if expires_at is null or expires_at <= now() then
    raise exception 'delivery principal expired' using errcode = '42501';
  end if;
  if internal.actor_id() is not null or internal.acting_as() is not null then
    raise exception 'delivery principal cannot carry actor claims' using errcode = '42501';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 4. Claim and settle stop comparing a version that no longer exists.
-- -----------------------------------------------------------------------------
create or replace function public.claim_session_message_delivery(
  p_delivery_id uuid,p_message_id uuid,p_target_work_session_id uuid,
  p_pair_budget_version integer default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare delivery public.session_message_deliveries;
begin
  perform internal.require_delivery_principal(
    p_delivery_id,p_message_id,p_target_work_session_id,null);
  select * into delivery from public.session_message_deliveries
   where delivery_id=p_delivery_id for update;
  if delivery.delivery_id is null or delivery.message_id<>p_message_id
     or delivery.target_work_session_id<>p_target_work_session_id then
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
$$;

create or replace function public.settle_session_message_delivery(
  p_delivery_id uuid,p_message_id uuid,p_target_work_session_id uuid,
  p_pair_budget_version integer,p_status text,p_failure_reason text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare delivery public.session_message_deliveries; message_space uuid;
begin
  perform internal.require_delivery_principal(
    p_delivery_id,p_message_id,p_target_work_session_id,null);
  if p_status not in ('delivered','failed_retryable','failed_permanent','unknown') then
    raise exception 'invalid delivery settlement status' using errcode='22023';
  end if;
  select * into delivery from public.session_message_deliveries
   where delivery_id=p_delivery_id for update;
  if delivery.delivery_id is null or delivery.message_id<>p_message_id
     or delivery.target_work_session_id<>p_target_work_session_id then
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
$$;

-- -----------------------------------------------------------------------------
-- 5. Maintenance stops sweeping a table that is about to not exist. 019's body
--    with the eligibility refresh and the budget delete removed; `budgetsDeleted`
--    leaves the result because there are no budgets to delete.
-- -----------------------------------------------------------------------------
create or replace function internal.w1_prune_operational_state(reference_time timestamptz default now())
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare changed record; event_space uuid; cancelled_count integer:=0; expired_count integer:=0;
declare unknown_count integer:=0; handoffs_unknown integer:=0;
declare deliveries_deleted integer;
begin
  for changed in
    update public.session_message_deliveries d
       set status='cancelled',failure_reason=case
             when m.redacted_at is not null then 'message_deleted' else 'session_not_live' end,
           settled_at=reference_time
      from public.messages m,public.work_sessions ws
     where d.message_id=m.entity_id and d.target_work_session_id=ws.entity_id
       and d.status='pending' and (m.redacted_at is not null or ws.status in ('exited','failed'))
     returning d.*
  loop
    cancelled_count:=cancelled_count+1;
    select e.space_id into event_space from public.entities e where e.id=changed.message_id;
    insert into public.workspace_events(space_id,seq,event_type,payload)
    values(event_space,internal.next_event_seq(event_space),'message.delivery_settled',
      jsonb_build_object('deliveryId',changed.delivery_id,'messageId',changed.message_id,
        'targetWorkSessionId',changed.target_work_session_id,'status',changed.status,
        'reason',changed.failure_reason,'attemptNo',changed.attempt_no));
    perform internal.w2_delivery_fallback(changed.message_id,changed.status,changed.failure_reason);
  end loop;
  for changed in
    update public.session_message_deliveries
       set status='expired',failure_reason='pending_ttl_expired',settled_at=reference_time
     where status='pending' and reserved_at<=reference_time-interval '15 minutes'
     returning *
  loop
    expired_count:=expired_count+1;
    select e.space_id into event_space from public.entities e where e.id=changed.message_id;
    insert into public.workspace_events(space_id,seq,event_type,payload)
    values(event_space,internal.next_event_seq(event_space),'message.delivery_settled',
      jsonb_build_object('deliveryId',changed.delivery_id,'messageId',changed.message_id,
        'targetWorkSessionId',changed.target_work_session_id,'status',changed.status,
        'reason',changed.failure_reason,'attemptNo',changed.attempt_no));
    perform internal.w2_delivery_fallback(changed.message_id,changed.status,changed.failure_reason);
  end loop;
  for changed in
    update public.session_message_deliveries
       set status='unknown',failure_reason='restart_during_dispatch',settled_at=reference_time
     where status='dispatching' and claimed_at<=reference_time-interval '15 minutes'
     returning *
  loop
    unknown_count:=unknown_count+1;
    select e.space_id into event_space from public.entities e where e.id=changed.message_id;
    insert into public.workspace_events(space_id,seq,event_type,payload)
    values(event_space,internal.next_event_seq(event_space),'message.delivery_settled',
      jsonb_build_object('deliveryId',changed.delivery_id,'messageId',changed.message_id,
        'targetWorkSessionId',changed.target_work_session_id,'status',changed.status,
        'reason',changed.failure_reason,'attemptNo',changed.attempt_no));
    perform internal.w2_delivery_fallback(changed.message_id,changed.status,changed.failure_reason);
  end loop;
  for changed in
    select h.handoff_id,h.source_space_id from public.session_handoffs h
     where h.delivery_status='dispatching'
       and h.updated_at<=reference_time-interval '15 minutes'
     order by h.handoff_id for update skip locked
  loop
    handoffs_unknown:=handoffs_unknown+1;
    insert into public.workspace_events(space_id,seq,event_type,payload)
    values(changed.source_space_id,internal.next_event_seq(changed.source_space_id),
      'handoff.delivery_settled',jsonb_build_object(
        'handoffId',changed.handoff_id,'deliveryStatus','unknown',
        'reason','restart_during_dispatch'));
    perform internal.w2_record_handoff(
      changed.handoff_id,'unknown','restart_during_dispatch');
  end loop;
  delete from public.session_message_deliveries
   where settled_at<reference_time-interval '30 days'
     and status in ('delivered','failed_retryable','failed_permanent','unknown','expired','cancelled');
  get diagnostics deliveries_deleted=row_count;
  return jsonb_build_object(
    'cancelled',cancelled_count,'expired',expired_count,'dispatchingUnknown',unknown_count,
    'handoffsUnknown',handoffs_unknown,
    'deliveriesDeleted',deliveries_deleted);
end
$$;

-- -----------------------------------------------------------------------------
-- 6. The budget itself, its reset RPC, its retention sweep, its trigger, its
--    policy and its grants. `drop table` takes the trigger, the RLS policy and
--    the grants with it.
-- -----------------------------------------------------------------------------
drop function if exists public.reset_session_wake_budget_for_member_reply(uuid, text);
drop function if exists internal.w1_refresh_wake_budget_cleanup_eligibility();
drop table if exists public.session_wake_budgets;
drop function if exists internal.validate_wake_budget();

reset role;
