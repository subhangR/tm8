-- =============================================================================
-- 179 — THE TOOL-AUDIT EVENT NAMES WHO SPENT THE AUTHORITY.
--
-- Ruling R-C, from design doc `01a0632a-e64e-701b-a13e-43ad8dbcc276`:
--
--   "An agent-triggered turn runs under the chat's configuring human, exactly
--    as second-member turns do today. The speaker line names the source session
--    or chat and the tool-audit event records it."
--
-- Half of that shipped in 176. `chat/orchestrator.ts` writes the speaker line —
-- `[from session <id> · team_member <id>]` — into the prompt, so the AGENT is
-- told who is talking. `internal.audit_chat_tool_call` was re-keyed onto the
-- chat and otherwise left as 123 wrote it: `{chatId, toolCallId, tool, state,
-- mode}`. Every one of those describes the CALL. None of them describes who
-- caused it.
--
-- That gap is only visible now because of what 176 changed underneath it. Until
-- 176, `internal.queue_chat_human_reply` fired for HUMAN authors only, so the
-- answer to "who triggered this tool call" was always "the human named on the
-- turn", and recording it would have been recording a constant. 176 deleted
-- that trigger: `w2_post_message_batch` now queues a turn for EVERY author, so a
-- work session or another chat can spend a human's authority — under that
-- human's claims, by ruling — and `requested_by_member_id` is NULL for exactly
-- those turns. The audit row for the most interesting case is the one that
-- names nobody.
--
-- What this file changes: three fields, read off the `chat_turns` row the
-- function ALREADY joins to find the chat.
--
--   requestedByActorId    the actor — member or team_member — on whose behalf
--                         the turn was queued. Null on legacy rows.
--   requestedBySessionId  the work session that posted the message, when one did
--   requestedByChatId     the chat that posted the message, when one did
--
-- The names match `claim_next_chat_turn`'s payload (176 §2) and the fields on
-- `ClaimedTurn`, deliberately: an operator reading an activity row and an agent
-- reading its own turn payload should not have to translate between two
-- vocabularies for one fact. At most one of the two id fields is ever non-null —
-- a message has ONE source (176 raises 22023 on both) — and both are null for a
-- turn a human typed, which is the honest encoding of "a person did this
-- directly".
--
-- WHY THE FIELDS ARE ALWAYS PRESENT, INCLUDING WHEN NULL. `jsonb_build_object`
-- with a null value emits the key. A consumer can then distinguish "this event
-- was written before 179 and has no opinion" (key absent) from "179 looked and
-- there was no source session" (key present, null). Omitting nulls would make
-- those two indistinguishable and quietly re-create the gap this file closes.
--
-- NUMBERED 179: main carries 176 and 178; `177_container_kind.sql` is the
-- Containers program's open lane (PR #574) and was swept on 2026-09-03 — it
-- writes 22 functions, `internal.entity_content` and
-- `public.work_session_transition` among them, and `audit_chat_tool_call` is
-- not one of them. There is no shared body between 177 and this file, so the
-- numeric-apply-order hazard that governs a shared body does not apply here.
--
-- NOT A SCHEMA CHANGE. No table, column, policy, grant or trigger is touched:
-- the trigger created by 123 (`chat_message_parts_tool_audit`) still points at
-- this function name, and `create or replace` keeps it pointing there.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The audit trigger, with provenance.
--
--    176's body verbatim except for the three added keys and the widened
--    `select`. Two properties of the original are load-bearing and preserved:
--
--    * THE IDEMPOTENCE GUARD stays keyed on (message, toolCallId, state) and
--      NOT on the new fields. A part is re-delivered with the same call id and
--      state; the provenance of the turn cannot change between deliveries, so
--      adding it to the guard could only ever make a duplicate slip through.
--
--    * THE EARLY RETURNS stay. `new.kind <> 'tool_call'` skips text and usage
--      parts, and a part whose message belongs to no chat turn returns
--      untouched rather than raising — this is a trigger on the streaming write
--      path, and a chat's transcript must not fail to store because its audit
--      trail could not be written.
-- -----------------------------------------------------------------------------
create or replace function internal.audit_chat_tool_call() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  chat_row  public.chats;
  turn_row  public.chat_turns;
  call_id   text;
begin
  if new.kind <> 'tool_call' then return new; end if;
  call_id := coalesce(new.payload ->> 'id', 'unknown');
  -- TWO SELECTS, NOT 176's ONE JOIN, and that is not a style choice. plpgsql's
  -- `select ... into a, b` assigns COLUMN by column across the target list, so
  -- `into turn_row, chat_row` over a joined `t.*, c.*` would put the turn's
  -- first column in the turn record and its SECOND column in the chat record —
  -- silently, and with the row types still nominally satisfied. The turn is
  -- what this file needs; the chat is reached from it by primary key.
  select t.* into turn_row
    from public.chat_turns t
   where t.agent_message_id = new.message_id
   limit 1;
  if turn_row.chat_id is null then return new; end if;
  select c.* into chat_row from public.chats c where c.entity_id = turn_row.chat_id;
  if chat_row.entity_id is null then return new; end if;
  if exists (
    select 1 from public.activity a
     where a.entity_id = new.message_id and a.verb = 'chat.tool_called'
       and a.summary ->> 'toolCallId' = call_id
       and a.summary ->> 'state' = coalesce(new.payload ->> 'state', 'unknown')
  ) then return new; end if;
  perform internal.record_activity(
    chat_row.space_id, new.message_id, chat_row.teammate_id, 'chat.tool_called',
    chat_row.entity_id,
    jsonb_build_object(
      'chatId', chat_row.entity_id,
      'toolCallId', call_id,
      'tool', coalesce(new.payload ->> 'name', 'unknown'),
      'state', coalesce(new.payload ->> 'state', 'unknown'),
      'mode', chat_row.chat_mode,
      -- R-C. Who spent the configuring human's authority on this call.
      'requestedByActorId', turn_row.requested_by_actor_id,
      'requestedBySessionId', turn_row.requested_by_session_id,
      'requestedByChatId', turn_row.requested_by_chat_id
    )
  );
  return new;
end
$$;

-- `create or replace` preserves grants; restated so a reader of this file alone
-- does not have to go and check that it did. 123's pair, verbatim.
revoke all on function internal.audit_chat_tool_call() from public;

-- -----------------------------------------------------------------------------
-- 2. VERIFY — only what THIS file creates.
--
--    The chain-wide assertions belong to 176 and stay there: a tranche suite
--    replaying this file mid-chain must not be asked about a table it has not
--    reached. What 179 creates is one function body, so that is what is checked
--    — that the three keys are in it and that the trigger still resolves to it.
-- -----------------------------------------------------------------------------
do $$
declare
  body     text;
  guard    text;
  guard_at integer;
  write_at integer;
  missing  text[] := '{}';
  key      text;
begin
  select p.prosrc into body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'internal' and p.proname = 'audit_chat_tool_call';
  if body is null then
    raise exception 'VERIFY 179: internal.audit_chat_tool_call does not exist';
  end if;

  -- SPANS FIRST, BECAUSE THE WHOLE BODY IS THE WRONG HAYSTACK. The first
  -- version of this block searched `body` and a negative control caught it:
  -- deleting `'toolCallId', call_id` from the WRITE still passed, because
  -- `a.summary ->> 'toolCallId'` in the idempotence guard satisfied the search.
  -- The two spans mean opposite things — one describes what is written, the
  -- other what makes a write a duplicate — so each is checked against its own.
  guard_at := position('if exists (' in body);
  write_at := position('perform internal.record_activity' in body);
  if guard_at = 0 or write_at = 0 or write_at <= guard_at then
    raise exception 'VERIFY 179: the audit guard and its write are not in the expected order';
  end if;
  guard := substring(body from guard_at for write_at - guard_at);
  body  := substring(body from write_at);

  -- Every key of the written summary, enumerated, and searched WITH ITS QUOTES
  -- so a key name cannot be satisfied by a column or a longer key that happens
  -- to contain it. A loop over the exact set rather than one `if` per key, so
  -- the failure names ALL of what is missing instead of the first thing it
  -- tripped over — the difference between one fix and eight.
  foreach key in array array[
    '''requestedByActorId''', '''requestedBySessionId''', '''requestedByChatId''',
    -- The keys 176 wrote. This file ADDS provenance to the audit summary; a
    -- body that REPLACED the call description with it would satisfy a check
    -- that only looked for the new three.
    '''chatId''', '''toolCallId''', '''tool''', '''state''', '''mode'''
  ] loop
    if position(key in body) = 0 then missing := missing || key; end if;
  end loop;
  if array_length(missing, 1) is not null then
    raise exception 'VERIFY 179: audit summary is missing key(s) %', missing;
  end if;

  -- THE IDEMPOTENCE GUARD MUST STAY KEYED ON THE CALL, NOT ON PROVENANCE.
  -- A part is re-delivered with the same call id and state, and the provenance
  -- of its turn cannot change between deliveries — so adding a provenance
  -- column to the guard could only ever let a duplicate audit row through,
  -- which is a silent defect no functional test would show.
  if position('requested_by' in guard) > 0 then
    raise exception 'VERIFY 179: provenance leaked into the idempotence guard';
  end if;

  if not exists (
    select 1 from pg_trigger t
     where not t.tgisinternal
       and t.tgfoid = 'internal.audit_chat_tool_call()'::regprocedure
  ) then
    raise exception 'VERIFY 179: no trigger resolves to internal.audit_chat_tool_call';
  end if;
end $$;
