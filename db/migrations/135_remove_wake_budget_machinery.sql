-- =============================================================================
-- 135  REMOVE THE WAKE-BUDGET MACHINERY, INCLUDING ITS SURROGATE PIN.
--
-- WHAT 120 REMOVED, AND WHAT IT DELIBERATELY LEFT. 120 removed the refusal cap
-- and its 0..4 constraint together. It left `session_wake_budgets`, the
-- unbounded telemetry counter, the member reset RPC, cleanup, three pair
-- columns on each delivery, and the `tm8.delivery_pair_budget_version` claim.
-- Its header was explicit: `version` was still threaded through reserve ->
-- claim -> settle, so deleting the table without reviewing that contract would
-- silently delete a concurrency invariant. This migration is that review.
--
-- WHAT THE PIN ACTUALLY DID. Reserve locked one unordered session-pair row,
-- incremented its shared `version`, and copied that integer onto the new
-- delivery. Claim and settle then compared the caller's integer with the COPY
-- on the delivery row. They never re-read or lock the pair row. The copied
-- integer never changes. Therefore:
--
--   * the pair lock serialized RESERVATIONS only, solely so one shared counter
--     and its version could be incremented without lost updates;
--   * it was not optimistic concurrency for the delivery row. Claim and settle
--     already lock that row `FOR UPDATE` and enforce its status transition;
--   * it added no identity binding beyond the existing exact
--     (delivery_id,message_id,target_work_session_id) tuple. The principal is
--     minted from the reservation and bound to that tuple, its lease expiry,
--     the authenticated `tm8_delivery_worker` role, and no actor claims.
--
-- WHY NO REPLACEMENT PAIR LOCK SURVIVES. Once the counter and version are gone,
-- two different messages on the same unordered pair share no mutable state.
-- Serializing them would protect nothing. Same-delivery concurrency remains
-- serialized by the delivery row lock; same (message,target,attempt) races
-- remain refused by the existing unique constraint. Same-Space and self-contact
-- rules remain in `guard_session_message_delivery` and reserve. Removing the
-- pair lock therefore changes throughput, not legal outcomes or row identity.
-- The real-PG execution tests run concurrent reservations on one pair and
-- concurrent claim/settle transitions on one delivery to pin those statements.
--
-- WHAT GOES, ALL OF IT.
--
--   * `public.session_wake_budgets`, its RLS policy/grant, validation trigger,
--     and `internal.validate_wake_budget`;
--   * `consecutive_agent_wakes`, `version`, cleanup eligibility, the member
--     reset RPC, and `internal.w1_refresh_wake_budget_cleanup_eligibility`;
--   * delivery `pair_low_session_id`, `pair_high_session_id`,
--     `pair_budget_version`, their shape constraint and active-pair index;
--   * the database claim `tm8.delivery_pair_budget_version`, the fourth claim
--     parameter, and the TypeScript reservation-version surrogate;
--   * `budgetsDeleted` from the owner-maintenance result. There are no budget
--     rows left to count.
--
-- WHAT SURVIVES, AND WHAT EACH SURVIVOR IS FOR.
--
--   * `session_message_deliveries`: durable per-attempt identity and outcome.
--   * its unique (message_id,target_work_session_id,attempt_no): prevents two
--     reservation identities for one logical attempt under concurrency.
--   * `guard_session_message_delivery`: immutable identity, legal state
--     transitions, same-Space endpoints, and self-contact refusal.
--   * the three delivery RPCs, still the complete worker allowlist. Their SQL
--     signatures shrink where the deleted pin was an argument; no fourth RPC
--     appears.
--   * `internal.require_delivery_principal`: authenticated worker role, exact
--     delivery/message/target tuple, unexpired lease, and absence of actor
--     claims. Only its deleted budget-version comparison changes.
--   * historical `automated_wake_limit` failure strings in rows/contracts/UI.
--     Old outcomes remain readable even though no new row can produce one.
--
-- FORWARD ONLY. Every earlier migration remains an exact record of what an
-- already-deployed database ran. Live definitions from 039, 120, 019 and 015
-- are copied forward here, with only the removals enumerated above.
-- =============================================================================

set role tm8_graph_owner;

-- Drop the old guard overload first: its fourth parameter has a DEFAULT, so it
-- cannot coexist with the exact three-argument replacement without making a
-- three-argument call ambiguous.
drop function internal.require_delivery_principal(uuid, uuid, uuid, integer);

create function internal.require_delivery_principal(
  expected_delivery uuid, expected_message uuid, expected_target uuid
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

-- 120's live reserve body, minus pair-row creation/locking/versioning and the
-- now-deleted delivery columns. Events, fallback, target liveness and replay
-- identity are unchanged.
create or replace function public.reserve_session_message_delivery(
  p_delivery_id uuid,p_message_id uuid,p_target_work_session_id uuid,
  p_attempt_no integer default 1
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  source_session uuid; message_space uuid; author_kind text; target_status text;
  delivery public.session_message_deliveries;
begin
  perform internal.require_delivery_principal(
    p_delivery_id,p_message_id,p_target_work_session_id);
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

  insert into public.session_message_deliveries(
    delivery_id,message_id,source_work_session_id,target_work_session_id,status,attempt_no
  ) values(
    p_delivery_id,p_message_id,source_session,p_target_work_session_id,'pending',p_attempt_no
  ) returning * into delivery;
  insert into public.workspace_events(space_id,seq,event_type,payload)
  values(message_space,internal.next_event_seq(message_space),'message.delivery_reserved',
    jsonb_build_object('deliveryId',p_delivery_id,'messageId',p_message_id,
      'targetWorkSessionId',p_target_work_session_id,'status',delivery.status,
      'attemptNo',p_attempt_no));
  return to_jsonb(delivery);
end
$$;

-- Signature changes: the deleted fourth argument was only the pair copy.
drop function public.claim_session_message_delivery(uuid, uuid, uuid, integer);
create function public.claim_session_message_delivery(
  p_delivery_id uuid,p_message_id uuid,p_target_work_session_id uuid
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare delivery public.session_message_deliveries;
begin
  perform internal.require_delivery_principal(
    p_delivery_id,p_message_id,p_target_work_session_id);
  select * into delivery from public.session_message_deliveries
   where delivery_id=p_delivery_id for update;
  if delivery.delivery_id is null or delivery.message_id<>p_message_id
     or delivery.target_work_session_id<>p_target_work_session_id then
    raise exception 'delivery reservation not found' using errcode='P0002';
  end if;
  if delivery.status='pending' then
    update public.session_message_deliveries set status='dispatching',claimed_at=now()
     where delivery_id=p_delivery_id returning * into delivery;
  elsif delivery.status<>'dispatching' then
    raise exception 'delivery cannot be claimed from status %',delivery.status
      using errcode='23514';
  end if;
  return to_jsonb(delivery);
end
$$;

drop function public.settle_session_message_delivery(uuid, uuid, uuid, integer, text, text);
create function public.settle_session_message_delivery(
  p_delivery_id uuid,p_message_id uuid,p_target_work_session_id uuid,
  p_status text,p_failure_reason text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare delivery public.session_message_deliveries; message_space uuid;
begin
  perform internal.require_delivery_principal(
    p_delivery_id,p_message_id,p_target_work_session_id);
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

-- The immutable delivery identity no longer includes pair-derived telemetry.
create or replace function internal.guard_session_message_delivery() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare message_space uuid; source_space uuid; target_space uuid;
begin
  if tg_op = 'UPDATE' then
    if new.delivery_id <> old.delivery_id or new.message_id <> old.message_id
       or new.source_work_session_id is distinct from old.source_work_session_id
       or new.target_work_session_id <> old.target_work_session_id
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

-- Owner maintenance keeps delivery/handoff recovery and retention, and loses
-- only budget eligibility/deletion work plus its now-fictional result counter.
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
    'handoffsUnknown',handoffs_unknown,'deliveriesDeleted',deliveries_deleted);
end
$$;

-- Drop application/reset and cleanup doors before their backing relation.
drop function public.reset_session_wake_budget_for_member_reply(uuid, text);
drop function internal.w1_refresh_wake_budget_cleanup_eligibility();

drop index public.session_message_deliveries_pair_active_idx;
alter table public.session_message_deliveries
  drop constraint session_message_deliveries_pair_shape,
  drop column pair_low_session_id,
  drop column pair_high_session_id,
  drop column pair_budget_version;

drop table public.session_wake_budgets;
drop function internal.validate_wake_budget();

-- Reassert the complete delivery-worker allowlist under the smaller signatures.
revoke execute on function public.reserve_session_message_delivery(uuid,uuid,uuid,integer)
  from public,tm8_app;
revoke execute on function public.claim_session_message_delivery(uuid,uuid,uuid)
  from public,tm8_app;
revoke execute on function public.settle_session_message_delivery(uuid,uuid,uuid,text,text)
  from public,tm8_app;
grant execute on function public.reserve_session_message_delivery(uuid,uuid,uuid,integer)
  to tm8_delivery_worker;
grant execute on function public.claim_session_message_delivery(uuid,uuid,uuid)
  to tm8_delivery_worker;
grant execute on function public.settle_session_message_delivery(uuid,uuid,uuid,text,text)
  to tm8_delivery_worker;

reset role;
