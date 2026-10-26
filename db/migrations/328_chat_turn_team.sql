-- =============================================================================
-- 328 — chat_turn_team: the Coordinator's team rides a turn as a FIELD, not as
-- text in the message body (composer redesign, task 01a14a32).
--
-- The composer's 👥 picker names who a Coordinator may hand work to. It used to
-- travel as a `[team: …]` line appended to the body, which put it in every
-- transcript. Now `messages.post` carries a structured `team` and the server
-- writes it beside the TURN; the orchestrator renders the `[team: …]` line into
-- the agent prompt next to `[mode: …]`, so the body stays the human's words.
--
-- WHAT IS HERE
--   1. `public.chat_turns.team` jsonb — `{members:[{name,teammateId?,model?,effort?}]}`,
--      NULL for a turn sent with the default team (the composer sends none).
--   2. `public.set_chat_turn_team(message, team)` — the post handler's write,
--      in the SAME transaction as `w2_post_message_batch`. It may only stamp a
--      message created in the caller's own transaction (`created_at = now()`,
--      the column default, is the transaction start) whose turn is still
--      queued — so it cannot rewrite anybody's turn after the fact, and it is
--      race-free against the claim, which only sees committed rows. A message
--      that enqueued no turn (not a chat anchor) is a no-op.
--   3. `public.chat_turn_team(turn)` — the orchestrator's read, gated like
--      `set_chat_context` (231): the identity that configured the chat.
--
-- WHY NOT THROUGH THE CLAIM: `claim_next_chat_turn` is the queue's critical
-- path; the team is context, read separately and best-effort like the
-- `[about …]` line, so a failed read costs a line, never a turn.
-- =============================================================================

set role tm8_graph_owner;

alter table public.chat_turns add column team jsonb
  check (team is null or (jsonb_typeof(team) = 'object'
                          and jsonb_typeof(team->'members') = 'array'
                          and octet_length(team::text) <= 8192));

comment on column public.chat_turns.team is
  'Optional Coordinator team chosen at send time ({members:[{name,teammateId?,model?,effort?}]}). '
  'NULL => no team line. Rendered into the agent prompt only, never into the message body.';

create function public.set_chat_turn_team(p_message_id uuid, p_team jsonb)
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
    from public.messages m
   where t.user_message_id = p_message_id
     and t.state = 'queued'
     and m.entity_id = t.user_message_id
     and m.created_at = now();
  get diagnostics stamped = row_count;
  return stamped > 0;
end
$$;

create function public.chat_turn_team(p_turn_id uuid)
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
     and c.configured_by_identity_id = internal.identity_id();
  return found;
end
$$;

revoke all on function public.set_chat_turn_team(uuid, jsonb) from public;
revoke all on function public.chat_turn_team(uuid) from public;
grant execute on function public.set_chat_turn_team(uuid, jsonb) to tm8_app;
grant execute on function public.chat_turn_team(uuid) to tm8_app;

reset role;

do $verify$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'chat_turns' and column_name = 'team'
       and data_type = 'jsonb' and is_nullable = 'YES'
  ) then
    raise exception 'VERIFY 328: public.chat_turns.team was not created';
  end if;
  if to_regprocedure('public.set_chat_turn_team(uuid,jsonb)') is null
     or to_regprocedure('public.chat_turn_team(uuid)') is null then
    raise exception 'VERIFY 328: the chat turn team functions were not created';
  end if;
end
$verify$;
