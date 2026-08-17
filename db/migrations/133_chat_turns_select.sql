-- =============================================================================
-- 133  CHAT TURNS BECOME READABLE — the claimed-turn wire marker.
--
-- 104 locked `chat_turns` behind SECURITY DEFINER doors with no select policy,
-- so no read path could project `agent_message_id` — the server's own record of
-- which message row belongs to an in-flight turn. Clients that needed to know
-- (chat-home's transcript) fell back to string-matching the claim placeholder
-- body 'Agent turn in progress.', a heuristic ChatHomeScreen.tsx documented as
-- fragile the day it was written.
--
-- This grants the app role the same read the sibling projections already have
-- (`chat_threads_select`, `message_parts_select`): a turn is readable exactly
-- when its thread's root message is readable. `messages.list` can then mark an
-- agent message `turnInFlight` while its turn is queued/running, and the
-- transcript suppresses the placeholder by identity instead of by sentence.
-- =============================================================================

create policy chat_turns_select on public.chat_turns for select to tm8_app
  using (internal.entity_readable(root_message_id));

grant select on public.chat_turns to tm8_app;
