-- =============================================================================
-- 169  A STOPPED CHAT TURN IS NOT A FAILED ONE.
--
-- THE DEFECT. `chat_turns.state` has been ('queued','running','completed',
-- 'error') since 104, and the orchestrator maps its runtime's terminal reasons
-- onto it with a two-way branch: success/closed -> 'completed', EVERYTHING ELSE
-- -> 'error'. `interrupted` is one of those four reasons. So the moment a person
-- stops their own turn, the row records a failure and
-- `complete_chat_turn` stamps the agent message with the literal body
-- 'Agent turn failed.'
--
-- That is the wrong fact, not merely the wrong word. A person who stopped a run
-- deliberately is told the run broke, and the transcript keeps that claim
-- forever. The design of record (doc 01a02907 section 3) rules the opposite:
-- a stopped run reads "You stopped this", is attributed to the person, and
-- "deliberately never reads as a failure".
--
-- WHAT THIS CHANGES.
--   1. `chat_turns.state` gains 'stopped' — a THIRD terminal state, beside
--      'completed' and 'error' rather than inside either. A stopped turn is not
--      a completed one either: nothing was finished, and counting it as success
--      would be the same class of lie in the other direction.
--   2. `complete_chat_turn` accepts it, and its placeholder body for an empty
--      stopped turn is the design's own sentence.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE. `chat_threads.runtime_state` still
-- has exactly ('cold','live','stopped') from 104 and is untouched: that column
-- describes the PROCESS, this one describes the TURN, and they were already
-- correct about the process. `mark_chat_runtime_state(root,'stopped')` after an
-- interrupt is existing, correct behaviour — it is what routes the next turn
-- through the lazy resume path (R8) so the conversation continues rather than
-- restarting.
--
-- INERT UNTIL THE SERVER USES IT. Nothing writes 'stopped' before the
-- orchestrator change that ships with this migration; every existing row and
-- every existing caller is unaffected. Rolling this file forward alone changes
-- no behaviour.
-- =============================================================================

-- 1. The third terminal state. The 104 constraint was created inline and so
--    carries Postgres's derived name; it is dropped by that name and replaced
--    with an explicitly named one, so the next migration to touch this does not
--    have to guess again.
alter table public.chat_turns drop constraint if exists chat_turns_state_check;
alter table public.chat_turns add constraint chat_turns_state_check
  check (state in ('queued', 'running', 'completed', 'stopped', 'error'));

comment on column public.chat_turns.state is
  'Turn lifecycle. Three terminal values, not two: `completed` (the agent '
  'finished), `stopped` (a person stopped it — never a failure), `error` (it '
  'broke). Stopping and failing are different news and are stored apart.';

-- 2. 104''s body VERBATIM save two lines: 'stopped' joins the accepted states,
--    and the placeholder body for a stopped turn with no text is the design''s
--    own sentence rather than 'Agent turn failed.'
--
--    The placeholder is the AGENT MESSAGE BODY, which a person reads in the
--    transcript — so it is written here in plain English and in the second
--    person, exactly as principle P1 of the design requires. It is only ever
--    used when the turn produced no text at all; a turn stopped mid-sentence
--    keeps whatever it had already said, which is the more useful record.
create or replace function public.complete_chat_turn(
  p_turn_id uuid,
  p_state text,
  p_body text,
  p_usage jsonb default null,
  p_total_cost_usd numeric default null,
  p_failure jsonb default null
) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare turn_row public.chat_turns; binding public.chat_threads; final_body text;
begin
  perform internal.require_identity();
  if p_state not in ('completed', 'stopped', 'error')
     or (p_usage is not null and jsonb_typeof(p_usage) <> 'object')
     or (p_failure is not null and jsonb_typeof(p_failure) <> 'object')
     or p_total_cost_usd < 0 then
    raise exception 'invalid chat turn completion' using errcode = '22023';
  end if;
  select * into turn_row from public.chat_turns where turn_id = p_turn_id for update;
  select * into binding from public.chat_threads where root_message_id = turn_row.root_message_id;
  if turn_row.turn_id is null or binding.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat turn not found for this identity' using errcode = 'P0002';
  end if;
  final_body := left(coalesce(nullif(btrim(p_body), ''),
    case p_state
      when 'completed' then 'Agent turn completed.'
      when 'stopped'   then 'You stopped this.'
      else 'Agent turn failed.'
    end), 10000);
  if turn_row.agent_message_id is not null then
    update public.messages set body = final_body where entity_id = turn_row.agent_message_id;
  end if;
  update public.chat_turns
     set state = p_state, usage = p_usage,
         usage_source = case when p_usage is null then null else 'c1_usage_item' end,
         total_cost_usd = p_total_cost_usd,
         failure = p_failure, completed_at = now(), lease_expires_at = null, updated_at = now()
   where turn_id = p_turn_id;
end
$$;

revoke all on function public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb) from public;
grant execute on function public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb) to tm8_app;
