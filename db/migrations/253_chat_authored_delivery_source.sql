-- =============================================================================
-- 253  A CHAT-AUTHORED MESSAGE REACHES A WORK SESSION.
--
-- THE DEFECT, on the live node (tm8_stable, 2026-09-26). Every message a TM8
-- Chat agent addressed to a work session was stored and routed, and then
-- answered `delivery_reserve_refused`. The server log names the throw:
--
--     insert or update on table "session_message_deliveries" violates
--     foreign key constraint "session_message_deliveries_source_work_session_id_fkey"
--
-- WHY. 176 widened `authored_from` to accept a CHAT destination and made
-- `w2_post_message_batch` write `authored_from(message -> chat)` for every
-- chat-authored post. `reserve_session_message_delivery` (last defined in 168)
-- still read ANY `authored_from` destination as the authoring work session and
-- inserted it into `source_work_session_id`, which references
-- `work_sessions(entity_id)`. A chat id is not one, so the insert failed, before
-- any delivery row existed.
--
-- Measured on the live node's current server log: 19 distinct messages hit
-- `delivery reserve or rejection failed`, all 19 on this FK, and all 19 carry
-- `authored_from` to a chat. No other reserve failure appears.
--
-- THE FIX. Resolve the source session only when the `authored_from`
-- destination is a `work_sessions` row. A chat author reserves with NULL, is
-- rendered `attribution="recorded_only"`, and is otherwise treated exactly as
-- 168 treats a Teammate with no authoring session. Nothing else in the body
-- changes: self-contact, target liveness, the reservation-identity match and
-- the delivery principal are as 168 left them. A chat is never a work session,
-- so a chat author can never be self-contact with the target.
--
-- Messages already stored and refused are NOT redelivered by this file. They
-- have no delivery row; resend them after it applies.
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
  -- 253: only a WORK SESSION destination is a source session. Since 176 a
  -- chat-authored message carries `authored_from(message -> chat)`, and that
  -- chat id is not a `work_sessions` row: carried into
  -- `source_work_session_id` it failed the FK and refused every chat -> session
  -- delivery. A chat author reserves with NULL and renders `recorded_only`,
  -- exactly as 168 settled for a Teammate with no authoring session.
  select edge.dst_id into source_session from public.edges edge
    join public.work_sessions ws on ws.entity_id=edge.dst_id
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
