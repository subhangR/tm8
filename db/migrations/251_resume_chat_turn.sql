-- 251 — resume_chat_turn: pick a running chat turn back up after a server
-- restart (task 01a0db31, design doc 01a0db5e D7 + §4 R1).
--
-- With session hosts, a chat's claude child outlives the server that claimed
-- its turn. The next server adopts the child and continues the SAME turn from
-- the stdout offset the old server last committed — instead of leaving it
-- `running` under a 10-minute lease and then re-running it from scratch.
--
-- Ownership is the attempt number, not the state: claim_next_chat_turn
-- re-claims a running turn whose lease expired and bumps attempt_no while the
-- state stays `running` (176_chat_entity.sql), so `state = 'running'` alone
-- cannot say the caller still owns it. A caller resumes only the attempt it
-- wrote to the child; any other answer is null and the caller abandons the
-- child's output.
--
-- Returns the claim_next_chat_turn shape plus:
--   attemptNo      the attempt resumed (unchanged)
--   committedText  the text parts already stored, in seq order — the body
--                  complete_chat_turn writes is the whole turn's text, and the
--                  resumed server only sees the parts after its restart.

set role tm8_graph_owner;

create function public.resume_chat_turn(p_turn_id uuid, p_attempt_no integer)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  chat_row public.chats;
  turn_row public.chat_turns;
  user_message public.messages;
  requester public.members;
  requested_kind text;
begin
  perform internal.require_identity();
  select t.* into turn_row from public.chat_turns t where t.turn_id = p_turn_id;
  if turn_row.turn_id is null then return null; end if;
  -- Same lock order as claim_next_chat_turn: the chat row, then the turn.
  select * into chat_row from public.chats where entity_id = turn_row.chat_id for update;
  if chat_row.entity_id is null or chat_row.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat not found for this identity' using errcode = 'P0002';
  end if;
  select * into turn_row from public.chat_turns
   where turn_id = p_turn_id and state = 'running' and attempt_no = p_attempt_no
   for update;
  if turn_row.turn_id is null then return null; end if;
  update public.chat_turns
     set lease_expires_at = now() + interval '10 minutes', updated_at = now()
   where turn_id = turn_row.turn_id returning * into turn_row;
  select * into user_message from public.messages where entity_id = turn_row.user_message_id;
  select * into requester from public.members
   where entity_id = coalesce(
     turn_row.requested_by_member_id,
     case when turn_row.requested_by_actor_id is null
          then chat_row.configured_by_member_id end);
  select e.kind into requested_kind from public.entities e
   where e.id = turn_row.requested_by_actor_id;
  return jsonb_build_object(
    'turnId', turn_row.turn_id,
    'chatId', chat_row.entity_id,
    'spaceId', chat_row.space_id,
    'userMessageId', turn_row.user_message_id,
    'agentMessageId', turn_row.agent_message_id,
    'body', user_message.body,
    'attachments', coalesce(user_message.attachments, '[]'::jsonb),
    'requesterIdentityId', chat_row.configured_by_identity_id,
    'requesterAuthKind', chat_row.requester_auth_kind,
    'requestedByMemberId', requester.entity_id,
    'requestedByIdentityId', requester.identity_id,
    'requestedByAuthKind', case
      when turn_row.requested_by_auth_kind is not null then turn_row.requested_by_auth_kind
      when requester.entity_id = chat_row.configured_by_member_id then chat_row.requester_auth_kind
      else null
    end,
    'requestedByDisplayName', requester.display_name,
    'requestedByActorId', turn_row.requested_by_actor_id,
    'requestedByActorKind', requested_kind,
    'requestedBySessionId', turn_row.requested_by_session_id,
    'requestedByChatId', turn_row.requested_by_chat_id,
    'teammateId', chat_row.teammate_id,
    'model', chat_row.model,
    'provider', chat_row.provider,
    'agentTool', chat_row.agent_tool,
    'chatMode', coalesce(turn_row.mode, chat_row.chat_mode),
    'mode', turn_row.mode,
    'nativeSessionId', chat_row.native_session_id,
    'cwd', chat_row.cwd,
    'runtimeState', chat_row.runtime_state,
    'nextSeq', case when turn_row.agent_message_id is null then 0 else
      (select coalesce(max(seq) + 1, 0) from public.message_parts
        where message_id = turn_row.agent_message_id) end,
    'attemptNo', turn_row.attempt_no,
    'committedText', case when turn_row.agent_message_id is null then '' else
      (select coalesce(string_agg(p.payload->>'text', '' order by p.seq), '')
         from public.message_parts p
        where p.message_id = turn_row.agent_message_id and p.kind = 'text') end
  );
end
$$;
revoke all on function public.resume_chat_turn(uuid, integer) from public;
grant execute on function public.resume_chat_turn(uuid, integer) to tm8_app;

reset role;

do $verify$
begin
  if to_regprocedure('public.resume_chat_turn(uuid,integer)') is null then
    raise exception 'VERIFY 251: resume_chat_turn was not created';
  end if;
  if has_function_privilege('public', 'public.resume_chat_turn(uuid,integer)', 'EXECUTE')
     or not has_function_privilege('tm8_app', 'public.resume_chat_turn(uuid,integer)', 'EXECUTE') then
    raise exception 'VERIFY 251: grant/revoke wrong on resume_chat_turn';
  end if;
end
$verify$;
