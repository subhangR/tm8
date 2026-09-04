-- =============================================================================
-- 153  A CHAT TURN CARRIES THE MODE IT WAS SENT IN (per-turn mode switching).
--
-- (Claimed 147 originally; the migration-number race landed 147..151, then
-- 152_universal_status (#377), on main first, so this took the next free
-- prefix, 153.)
--
-- Until now a thread's mode was fixed for its whole life: chat_threads.chat_mode
-- is write-once (123/136) and every turn ran under it. The ruled design makes
-- mode a per-MESSAGE choice — the composer may flip ask/plan/build/… on any
-- send — WITHOUT touching the write-once thread invariant. The thread mode stays
-- the DEFAULT; a turn may override it.
--
-- SHAPE A (ruled): the requested mode rides on the human's MESSAGE, exactly as
-- attachments do (144). Enqueue is a trigger off the message row (115), so a
-- per-turn fact has to arrive on that row:
--
--   1. public.messages gains a nullable `requested_chat_mode` (this file).
--   2. messages.post passes an optional mode through to it — the ONE piece NOT
--      in this migration: it modifies the ~1000-line core RPC
--      public.w2_post_message_batch (019), which the messages surface owns and
--      which cannot be reproduced/altered safely without running the migration
--      apply + message tests. It lands in a companion change, reviewed by that
--      lane. Until it does, requested_chat_mode is always NULL and every turn
--      resolves to the thread default — i.e. this migration is INERT-SAFE on its
--      own: it changes no existing behaviour, it only makes room for the mode.
--   3. the enqueue trigger copies messages.requested_chat_mode onto
--      chat_turns.mode (this file).
--   4. claim_next_chat_turn resolves the effective mode as
--      coalesce(turn.mode, thread.chat_mode) and also returns the raw per-turn
--      mode for the read projection (this file).
--
-- The six-value vocabulary matches chat_threads.chat_mode's current constraint
-- (136): ask, explain, plan, build, orchestrate, craft.
-- =============================================================================

-- 1. The carrier on the message. Nullable: an omitted mode means "use the
--    thread default", which is every pre-147 message and every client that does
--    not send one.
alter table public.messages
  add column requested_chat_mode text
  check (requested_chat_mode is null
         or requested_chat_mode in ('ask', 'explain', 'plan', 'build', 'orchestrate', 'craft'));

comment on column public.messages.requested_chat_mode is
  'Optional per-turn chat mode chosen at send time. NULL ⇒ the thread default '
  '(chat_threads.chat_mode). Consumed by the chat enqueue trigger; ignored for '
  'non-chat messages.';

-- 2. The per-turn mode on the queue row. Nullable for the same reason, and the
--    thread mode remains the write-once default it always was.
alter table public.chat_turns
  add column mode text
  check (mode is null
         or mode in ('ask', 'explain', 'plan', 'build', 'orchestrate', 'craft'));

comment on column public.chat_turns.mode is
  'The mode this specific turn runs under, copied from the sending message. '
  'NULL ⇒ resolve to the thread default at claim time.';

-- 3. The enqueue trigger: 123''s body VERBATIM (the current definition — it
--    carries the auth_kind capture and the browser/cli fail-closed gate that
--    115 did not have), plus one column — the requested mode travels from the
--    message row onto the turn it queues, exactly as requester identity and
--    auth kind already do. Everything else is unchanged.
create or replace function internal.queue_chat_human_reply() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  binding public.chat_threads;
  author_member public.members;
  auth_kind text;
begin
  if new.root_message_id is null then return new; end if;
  select * into binding from public.chat_threads where root_message_id = new.root_message_id;
  if binding.root_message_id is null then return new; end if;
  select * into author_member from public.members
   where entity_id = new.author_id and space_id = binding.space_id;
  if author_member.entity_id is null then return new; end if;
  auth_kind := internal.claim_text('tm8.auth_kind');
  if auth_kind not in ('browser', 'cli') then return new; end if;
  insert into public.chat_turns(
    root_message_id, user_message_id, requested_by_member_id, requested_by_auth_kind,
    mode, pricing_provider, pricing_model, queued_at
  ) values (
    binding.root_message_id, new.entity_id, author_member.entity_id, auth_kind,
    new.requested_chat_mode, binding.provider, binding.model, new.created_at
  ) on conflict (user_message_id) do nothing;
  return new;
end
$$;

-- 4. The claim projection: 144''s body verbatim, with two changes to the
--    returned object — `chatMode` now resolves the per-turn override against the
--    thread default, and the raw per-turn `mode` is exposed for the read model.
create or replace function public.claim_next_chat_turn(p_root_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  binding public.chat_threads;
  turn_row public.chat_turns;
  user_message public.messages;
  requester public.members;
begin
  perform internal.require_identity();
  select * into binding from public.chat_threads
   where root_message_id = p_root_message_id for update;
  if binding.root_message_id is null or binding.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat thread not found for this identity' using errcode = 'P0002';
  end if;
  select * into turn_row from public.chat_turns
   where root_message_id = p_root_message_id
     and (state = 'queued' or (state = 'running' and lease_expires_at < now()))
   order by queued_at, user_message_id for update skip locked limit 1;
  if turn_row.turn_id is null then return null; end if;
  update public.chat_turns
     set state = 'running', attempt_no = attempt_no + 1,
         started_at = coalesce(started_at, now()), lease_expires_at = now() + interval '10 minutes',
         updated_at = now()
   where turn_id = turn_row.turn_id returning * into turn_row;
  select * into user_message from public.messages where entity_id = turn_row.user_message_id;
  select * into requester from public.members
   where entity_id = coalesce(turn_row.requested_by_member_id, binding.configured_by_member_id);
  return jsonb_build_object(
    'turnId', turn_row.turn_id,
    'rootMessageId', binding.root_message_id,
    'spaceId', binding.space_id,
    'userMessageId', turn_row.user_message_id,
    'agentMessageId', turn_row.agent_message_id,
    'body', user_message.body,
    'attachments', coalesce(user_message.attachments, '[]'::jsonb),
    'anchorId', binding.anchor_id,
    'requesterIdentityId', binding.configured_by_identity_id,
    'requesterAuthKind', binding.requester_auth_kind,
    'requestedByMemberId', requester.entity_id,
    'requestedByIdentityId', requester.identity_id,
    'requestedByAuthKind', case
      when turn_row.requested_by_auth_kind is not null then turn_row.requested_by_auth_kind
      when requester.entity_id = binding.configured_by_member_id then binding.requester_auth_kind
      else null
    end,
    'requestedByDisplayName', requester.display_name,
    'teammateId', binding.teammate_id,
    'model', binding.model,
    'provider', binding.provider,
    'agentTool', binding.agent_tool,
    -- The effective mode this turn runs under: the per-turn override if the
    -- sender chose one, else the thread's write-once default.
    'chatMode', coalesce(turn_row.mode, binding.chat_mode),
    -- The raw per-turn choice (NULL ⇒ inherited), for the turn read model.
    'mode', turn_row.mode,
    'nativeSessionId', binding.native_session_id,
    'cwd', binding.cwd,
    'runtimeState', binding.runtime_state,
    'nextSeq', case when turn_row.agent_message_id is null then 0 else
      (select coalesce(max(seq) + 1, 0) from public.message_parts
        where message_id = turn_row.agent_message_id) end
  );
end
$$;

revoke all on function public.claim_next_chat_turn(uuid) from public;
grant execute on function public.claim_next_chat_turn(uuid) to tm8_app;
