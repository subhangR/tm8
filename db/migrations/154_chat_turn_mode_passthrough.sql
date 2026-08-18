-- =============================================================================
-- 154  MESSAGES.POST STAMPS THE PER-TURN CHAT MODE (shape A, step 2).
--
-- Migration 153 added messages.requested_chat_mode and made the enqueue trigger
-- copy it onto chat_turns.mode; 395 made the runtime honour the effective mode.
-- This is the missing piece: getting the mode a human chose at send time ONTO
-- the message, so it flows message → chat_turns.mode → the turn envelope.
--
-- MECHANISM, and why it is NOT a change to w2_post_message_batch. The obvious
-- shape A step is "add a p_chat_turn_mode param to w2_post_message_batch". That
-- is the messages lane's ~157-line core RPC, used by every message post; adding
-- a param there means reproducing the whole body in a chat migration and giving
-- the chat lane a permanent copy of another lane's core function. Instead the
-- messages.post handler sets a TRANSACTION-LOCAL `tm8.chat_turn_mode`, and a
-- BEFORE INSERT trigger on public.messages stamps requested_chat_mode from it.
-- Same result — requested_chat_mode is populated by the messages.post path —
-- with no reproduction and no cross-lane coupling. (Unification: this is the
-- passthrough hunk you review; flagged as the deviation from the literal param.)
--
-- The stamp is inert unless the setting is present: a plain non-chat insert, or
-- a chat send with no mode, leaves the setting unset, claim_text returns NULL,
-- and requested_chat_mode stays NULL (→ the thread default resolves at claim).
-- An explicit requested_chat_mode already on the row (belt-and-suspenders) wins.
-- =============================================================================

create or replace function internal.stamp_chat_turn_mode() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare requested text;
begin
  -- An explicitly-provided value is authoritative; never overwrite it.
  if new.requested_chat_mode is not null then return new; end if;
  requested := internal.claim_text('tm8.chat_turn_mode');
  if requested in ('ask', 'explain', 'plan', 'build', 'orchestrate', 'craft') then
    new.requested_chat_mode := requested;
  end if;
  return new;
end
$$;

comment on function internal.stamp_chat_turn_mode() is
  'BEFORE INSERT on messages: stamps requested_chat_mode from the transaction-'
  'local tm8.chat_turn_mode setting the messages.post handler sets for a chat '
  'send. Inert (leaves NULL) when the setting is absent or not one of the six '
  'modes.';

create trigger messages_stamp_chat_turn_mode
before insert on public.messages
for each row execute function internal.stamp_chat_turn_mode();
