-- =============================================================================
-- 168  A TEAMMATE THAT IS NOT SPEAKING FROM A SESSION MAY STILL REACH A
--      TERMINAL -- IT IS ATTRIBUTED `recorded_only`, NOT DROPPED.
--
-- THE DEFECT, reproduced on the live node (tm8_prod, 2026-08-21). A message
-- anchored to a running work session is stored, routed, shown in the graph --
-- and never reaches the agent. `messages.post` answers 200 with a durable
-- message entity. `session_followup` answers the same. Zero delivery rows are
-- written and nothing enters the PTY. A human reads the 200 and believes they
-- steered a worker; they did not.
--
-- WHERE THE COPY IS DROPPED, proven by invoking the function rather than by
-- reading it. As `tm8_delivery_worker`, with a valid delivery principal, for
-- the exact message a human posted at 17:38 UTC:
--
--     select public.reserve_session_message_delivery(
--       'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',   -- fresh delivery id
--       '01a02566-e1a1-7ea2-9fd3-03e6ef898399',   -- the stored steer
--       '01a02564-e84c-77a6-b081-e196ac7c50bc',   -- the running worker
--       1);
--     ERROR:  Teammate delivery requires immutable source-session provenance
--     CONTEXT:  PL/pgSQL function reserve_session_message_delivery(...) line 28
--
-- The same call for a message that DOES carry an `authored_from` edge, same
-- target, same principal, inserts its row. So the drop is this branch, at
-- reservation time, before any row exists -- which is why the symptom is zero
-- delivery rows rather than a failed one.
--
-- WHY THE BRANCH FIRES. `authored_from` has exactly one writer: 019's message
-- batch RPC, and only when the author IS a work session. When 019 was written
-- that covered every Teammate that could speak, so a Teammate with no edge
-- meant provenance had been LOST, and refusing was a data-integrity assertion.
--
-- It is no longer. TM8 Chat teammates (104/105) are authenticated `team_member`
-- actors that speak from a chat thread, and a chat thread is not a work
-- session -- so they never have the edge, and every message they address to a
-- session is refused here. 103's forge watcher is a second such writer;
-- main.ts documents it posting with `sourceWorkSessionId: null` and
-- `senderAttribution: 'recorded_only'` -- "the same value 019 derives for any
-- writer that is not an agent" -- a mode this branch makes unreachable for the
-- Teammate author it is written for.
--
-- MEASURED, not reasoned. Every route ever recorded on this node, split by
-- author kind and by whether the message carries the edge, against whether a
-- delivery row was ever written for that (message, target) pair:
--
--     author_kind   has_provenance   routes   delivery rows   missing
--     member        f                    54              54         0
--     team_member   f                    19               0        19   <-- 100%
--     team_member   t                  3437            3274       163
--
-- The 19 are total, not partial: no Teammate message without the edge has EVER
-- been delivered, since the class first appeared on 2026-08-14. The 163 in the
-- bottom row are ordinary later-stage outcomes -- `session_not_live`,
-- `no_live_terminal` -- and every one of them HAS a durable row saying so. That
-- is the difference this file is about: a settled failure is visible, and this
-- branch is not.
--
-- Note the top row. A human `member` posting the identical message to the
-- identical session already reserves with `source_work_session_id` null and
-- always has -- 54 for 54. The column is nullable, the trigger
-- (`internal.guard_session_message_delivery`) already special-cases null, and
-- the envelope already renders the null case as `attribution="recorded_only"`
-- (packages/prompt/src/templates.ts). Nothing downstream needed the edge. Only
-- this one predicate did.
--
-- WHAT CHANGES, AND WHAT DOES NOT. A Teammate WITH an authoring session still
-- reserves with it, unchanged -- that provenance is still immutable and still
-- rendered `verified`. A Teammate WITHOUT one now reserves with null and is
-- rendered `recorded_only`, which is the true statement about it, and the same
-- statement a Member author already gets. Every other check is untouched:
-- self-contact, same-Space endpoints, target liveness, the reservation-identity
-- match, and the delivery principal itself.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO: make the drop invisible in the other
-- direction. Refusing at reservation time was never the bug on its own -- the
-- bug was refusing SILENTLY, because `dispatchSessionMessages` logs the throw
-- and `messages.post` returns 200 regardless. That half is fixed in the server
-- (message-dispatch.ts / messages-handoffs.ts), which now reports a per-target
-- delivery outcome on the post result the way `execution.dispatch` has always
-- reported `delivery: 'undelivered'`. Both halves are required: this file makes
-- the legitimate case land, and that one makes any future case that cannot land
-- say so out loud.
-- =============================================================================

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
  -- 168: the refusal that used to stand here is gone. `source_session` stays
  -- NULL for a Teammate that is not speaking from a session -- a Chat teammate,
  -- the forge watcher -- and null is carried into the row below exactly as it
  -- already is for a Member author. The envelope reads that null and says
  -- `attribution="recorded_only"`; it never claims a session that did not
  -- speak. What remains immutable is the edge WHEN IT EXISTS: it is written
  -- once by 019 and only for a real authoring session, so a `verified`
  -- attribution still cannot be manufactured here.
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
