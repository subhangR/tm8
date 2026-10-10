-- A chat selection contains references only. The credential resolver enforces
-- current provider policy, ownership, sharing and revocation on every turn.
set role tm8_graph_owner;
alter table public.chats add column credential_selection jsonb not null default '{"source":"auto"}';
alter table public.chat_turns add column credential_selection jsonb;

create function public.set_chat_credentials(p_chat_id uuid, p_selection jsonb)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare chat_row public.chats;
begin
  perform internal.require_identity();
  perform internal.require_human_auth_kind();
  select c.* into chat_row from public.chats c join public.entities e on e.id=c.entity_id
    where c.entity_id=p_chat_id and e.deleted_at is null for update of c;
  if chat_row.entity_id is null
     or chat_row.configured_by_identity_id <> internal.identity_id()
     or (nullif(current_setting('tm8.session_space_id',true),'')::uuid is not null
         and chat_row.space_id <> nullif(current_setting('tm8.session_space_id',true),'')::uuid) then
    raise exception 'chat not found for this identity' using errcode='P0002';
  end if;
  perform internal.require_space_member(chat_row.space_id);
  if p_selection is null or jsonb_typeof(p_selection) <> 'object'
     or coalesce(p_selection->>'source','') not in ('auto','member','space','node')
     or exists (select 1 from jsonb_object_keys(p_selection) k where k not in ('source','credentialId'))
     or (p_selection ? 'credentialId' and (
       p_selection->>'source' <> 'space' or jsonb_typeof(p_selection->'credentialId') <> 'string'
       or coalesce(p_selection->>'credentialId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) then
    raise exception 'invalid chat credential selection' using errcode='22023';
  end if;
  update public.chats set credential_selection=p_selection where entity_id=p_chat_id;
  return jsonb_build_object('chatId',p_chat_id,'credentialSelection',p_selection);
end $$;
revoke all on function public.set_chat_credentials(uuid,jsonb) from public;
grant execute on function public.set_chat_credentials(uuid,jsonb) to tm8_app;

-- Snapshot the selection at claim, just like the model. Reclaimed leases keep
-- the original choice, and a mid-turn edit affects the next claimed turn only.
create or replace function public.claim_next_chat_turn(p_chat_id uuid)
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
  select * into chat_row from public.chats where entity_id = p_chat_id for update;
  if chat_row.entity_id is null or chat_row.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat not found for this identity' using errcode = 'P0002';
  end if;
  select * into turn_row from public.chat_turns
   where chat_id = p_chat_id
     and (state = 'queued' or (state = 'running' and lease_expires_at < now()))
   order by queued_at, user_message_id for update skip locked limit 1;
  if turn_row.turn_id is null then return null; end if;
  update public.chat_turns
     set state = 'running', attempt_no = attempt_no + 1,
         started_at = coalesce(started_at, now()), lease_expires_at = now() + interval '10 minutes',
         -- 276: what this turn runs on, decided HERE and only here. The
         -- self-coalesce is what makes a lease-expiry retry re-run on the model
         -- it started with instead of silently adopting a newer one.
         model = coalesce(chat_turns.model, chat_row.model),
         provider = coalesce(chat_turns.provider, chat_row.provider),
         credential_selection = coalesce(chat_turns.credential_selection, chat_row.credential_selection),
         updated_at = now()
   where turn_id = turn_row.turn_id returning * into turn_row;
  select * into user_message from public.messages where entity_id = turn_row.user_message_id;
  -- The human requester, when there IS one. 153 coalesced an absent requester to
  -- the configuring member; that is right for a legacy row (which could not
  -- record one) and WRONG for an agent-authored turn, where it would name a
  -- human who did not speak. The coalesce therefore applies only when no actor
  -- was recorded at all.
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
    -- R-C provenance: who spent the configurer's authority on this turn, and
    -- from where. Never claims — the turn still runs on requesterIdentityId.
    'requestedByActorId', turn_row.requested_by_actor_id,
    'requestedByActorKind', requested_kind,
    'requestedBySessionId', turn_row.requested_by_session_id,
    'requestedByChatId', turn_row.requested_by_chat_id,
    'teammateId', chat_row.teammate_id,
    -- 276: the turn's own stamp, set by the UPDATE above. The coalesce is for a
    -- pre-276 row that was already `running` when this migration landed and is
    -- being re-claimed after its lease expired: it has no stamp and never will.
    'model', coalesce(turn_row.model, chat_row.model),
    'provider', coalesce(turn_row.provider, chat_row.provider),
    'credentialSelection', coalesce(turn_row.credential_selection, chat_row.credential_selection),
    'agentTool', chat_row.agent_tool,
    'chatMode', coalesce(turn_row.mode, chat_row.chat_mode),
    'mode', turn_row.mode,
    'nativeSessionId', chat_row.native_session_id,
    'cwd', chat_row.cwd,
    'runtimeState', chat_row.runtime_state,
    'nextSeq', case when turn_row.agent_message_id is null then 0 else
      (select coalesce(max(seq) + 1, 0) from public.message_parts
        where message_id = turn_row.agent_message_id) end
  );
end
$$;

revoke all on function public.claim_next_chat_turn(uuid) from public;
grant execute on function public.claim_next_chat_turn(uuid) to tm8_app;


reset role;
