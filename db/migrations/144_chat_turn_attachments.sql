-- =============================================================================
-- 144  A CHAT TURN NOW CARRIES THE FILES THE HUMAN ATTACHED TO IT.
--
-- RENUMBERED FROM 133. This file was merged as `133_chat_turn_attachments.sql`
-- while `133_chat_turns_select.sql` already held 133 on main, so the chain had a
-- duplicate prefix and db/migrate.mjs (:146) refused to run any of it. 133 stays
-- with `chat_turns_select`, which is the copy already recorded in the
-- `applied_migrations` ledger on the deployed nodes; the ledger keys on
-- FILENAME, so renaming the applied one would re-apply it and desynchronise
-- prod. This unapplied file takes the next free prefix instead. It replaces
-- `public.claim_next_chat_turn`, which nothing in 134..143 touches, so moving it
-- after them changes no definition but its own.
--
-- THE DEFECT, measured on the applied chain. `messages.post` validates a
-- message's attachments (019's `w2_validate_attachment_files`), writes them to
-- `public.messages.attachments`, and every reader returns them: the API answers
-- `content.attachments`, and Chat draws a chip per file on the human's own
-- message. `claim_next_chat_turn` — the one read that turns that message into a
-- prompt for the teammate — selects the whole row into `user_message` and then
-- builds its result object from `user_message.body` ALONE.
--
-- So the file is stored, authorized, counted and DRAWN, and the teammate is
-- handed a turn in which it does not exist. Not even its id: there is no
-- reference the agent could follow with `tm8_read` or `explain_asset`, so the
-- honest answer it can give to "have a look at the attached spec" is that no
-- spec arrived, and the answer it actually gives is a guess. The failure is
-- silent on both sides — the human sees their chip, the agent sees a bare
-- sentence, and nothing in between logs a drop.
--
-- THE FIX is one field. The attachment json is already on the row this function
-- already locked and read; it now travels with the body it belongs to.
--
--     'attachments', coalesce(user_message.attachments, '[]'::jsonb)
--
-- WHY IDS AND NAMES, NOT BYTES. This is the turn CLAIM, not a download: the
-- teammate reaches a file the way every other actor does, through the graph and
-- the files API, under its own credential and its own audience checks. Handing
-- content down this path would make one RPC the exception to that, and would
-- put an unbounded blob inside a prompt row.
--
-- `coalesce` because `messages.attachments` is only kept current by 019's edge
-- triggers; a row written before an attachment edge lands reads NULL, and a
-- prompt-shaped null is a crash in the composer rather than an empty list.
--
-- Everything else is 123's body verbatim (which is 115's, which is 106's), so
-- the mode, tool-audit and multi-member-attribution behaviour is unchanged.
-- =============================================================================

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
    -- 133: the files that arrived WITH this body. `[{fileEntityId,name,mime}]`,
    -- the same shape 019 writes and the API returns.
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
    'chatMode', binding.chat_mode,
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
