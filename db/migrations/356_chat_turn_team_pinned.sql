-- =============================================================================
-- 356: chat_turn_team and set_chat_turn_team honour the session pin (227).
--
-- 328 gated the read only by chats.configured_by_identity_id = identity_id(),
-- the set_chat_context pattern. That reaches every space the identity
-- configured a chat in: a session pinned to space A could read the team
-- (teammate ids, models) of a turn in a chat in space B. The identity-id gate
-- review (task 01a15ba8) flagged it; the read now carries the same inline
-- session_space_id conjunct as set_chat_model (276/332), so a pinned session
-- reaches only turns of chats in its own space and gets NULL for any other.
-- The orchestrator reads with unpinned requester claims, so it is unchanged.
--
-- set_chat_turn_team was already confined to a message created in the
-- caller's own transaction (by w2_post_message_batch, pinned); it gets the
-- same conjunct as a second lock. Bodies otherwise 328's, verbatim.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function public.set_chat_turn_team(p_message_id uuid, p_team jsonb)
returns boolean
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  stamped integer;
begin
  perform internal.require_identity();
  if p_team is null or jsonb_typeof(p_team) <> 'object'
     or jsonb_typeof(p_team->'members') <> 'array'
     or jsonb_array_length(p_team->'members') = 0
     or octet_length(p_team::text) > 8192 then
    raise exception 'invalid chat turn team' using errcode = '22023';
  end if;
  update public.chat_turns t
     set team = p_team
    from public.messages m, public.chats c
   where t.user_message_id = p_message_id
     and t.state = 'queued'
     and m.entity_id = t.user_message_id
     and m.created_at = now()
     and c.entity_id = t.chat_id
     and (internal.session_space_id() is null or c.space_id = internal.session_space_id());
  get diagnostics stamped = row_count;
  return stamped > 0;
end
$$;

create or replace function public.chat_turn_team(p_turn_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  found jsonb;
begin
  perform internal.require_identity();
  select t.team into found
    from public.chat_turns t
    join public.chats c on c.entity_id = t.chat_id
   where t.turn_id = p_turn_id
     and c.configured_by_identity_id = internal.identity_id()
     and (internal.session_space_id() is null or c.space_id = internal.session_space_id());
  return found;
end
$$;

revoke all on function public.set_chat_turn_team(uuid, jsonb) from public;
revoke all on function public.chat_turn_team(uuid) from public;
grant execute on function public.set_chat_turn_team(uuid, jsonb) to tm8_app;
grant execute on function public.chat_turn_team(uuid) to tm8_app;

reset role;
