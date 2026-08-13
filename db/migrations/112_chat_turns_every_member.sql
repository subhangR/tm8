-- =============================================================================
-- 112 — a chat thread answers every human member of its Space, not only the
-- human who configured it.
--
-- 104 queued a turn only when the reply author was `configured_by_member_id`.
-- The stated reason was authorization: the runtime credential (105) carries
-- the CONFIGURING human's account authority, so a second member prompting the
-- teammate spends somebody else's authority. The measured product effect was
-- worse than the risk it avoided — a chat thread in a shared channel answers
-- its creator and silently ignores every other member, with no refusal, no
-- badge and no trace. Storage kept the message; the queue dropped it.
--
-- What changes: any HUMAN MEMBER of the thread's Space whose message lands in
-- the thread queues a turn. What does not change:
--
--   * authority stays frozen to the configuring human. `claim_next_chat_turn`
--     still returns `requesterIdentityId = configured_by_identity_id`, still
--     refuses any other caller, and 105's mint is untouched. The new requester
--     columns are PROVENANCE — who asked — and are never claims.
--   * only a human queues. A team_member author (the teammate's own reply, or
--     any other persona in the Space) has no `members` row, and that lookup —
--     not an author-id comparison — is what stops a reply re-triggering
--     itself. 104 got self-trigger suppression for free from the equality
--     check; it is now explicit, because equality is gone.
--   * membership is the same predicate the rest of the graph uses (002:
--     `members` row in that Space). Readability is already enforced upstream:
--     `w2_post_message_batch` refuses an unreadable anchor, so a row reaching
--     this trigger was authorized to be in the thread.
--
-- Escalation note, recorded rather than hidden: a member who can post in the
-- thread can now spend the configuring human's authority through the teammate.
-- That is the same trust level as being in the thread's Space today, but it is
-- NOT bounded to the Space — the configurer's account may reach others. A
-- per-turn credential minted for the requesting member is the real fix and is
-- deliberately out of scope here; this migration makes the surface honest and
-- attributable so that work has provenance to build on.
-- =============================================================================

set role tm8_graph_owner;

alter table public.chat_turns
  add column requested_by_member_id uuid
    references public.members(entity_id) on delete restrict;

comment on column public.chat_turns.requested_by_member_id is
  'The human member whose message queued this turn. NULL means the configuring '
  'human: the thread-start turn writes no requester, and pre-112 rows could not '
  'have had another one. Read it through claim_next_chat_turn, which coalesces. '
  'Provenance only — the turn still runs on configured_by_identity_id authority.';

create index chat_turns_requested_by_idx
  on public.chat_turns(requested_by_member_id)
  where requested_by_member_id is not null;

-- 104 body, with the author test replaced. Re-issued whole rather than patched
-- (shared-body hazard: a later migration editing this trigger must start from
-- THIS copy).
create or replace function internal.queue_chat_human_reply() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  binding public.chat_threads;
  author_member public.members;
begin
  if new.root_message_id is null then return new; end if;
  select * into binding from public.chat_threads
   where root_message_id = new.root_message_id;
  if binding.root_message_id is null then return new; end if;
  -- The one gate: the author is a human member of the thread's Space. A
  -- team_member author finds no row here and the message stays inert context.
  select * into author_member from public.members
   where entity_id = new.author_id and space_id = binding.space_id;
  if author_member.entity_id is null then return new; end if;
  insert into public.chat_turns(
    root_message_id, user_message_id, requested_by_member_id,
    pricing_provider, pricing_model, queued_at
  ) values (
    binding.root_message_id, new.entity_id, author_member.entity_id,
    binding.provider, binding.model, new.created_at
  ) on conflict (user_message_id) do nothing;
  return new;
end
$$;

-- 106 body, plus the three requester fields. Nothing about who may claim a
-- turn changes: the caller must still be the configuring identity.
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
  select * into turn_row
    from public.chat_turns
   where root_message_id = p_root_message_id
     and (state = 'queued' or (state = 'running' and lease_expires_at < now()))
   order by queued_at, user_message_id
   for update skip locked
   limit 1;
  if turn_row.turn_id is null then return null; end if;
  update public.chat_turns
     set state = 'running', attempt_no = attempt_no + 1,
         started_at = coalesce(started_at, now()), lease_expires_at = now() + interval '10 minutes',
         updated_at = now()
   where turn_id = turn_row.turn_id
   returning * into turn_row;
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
    'anchorId', binding.anchor_id,
    'requesterIdentityId', binding.configured_by_identity_id,
    'requesterAuthKind', binding.requester_auth_kind,
    -- Who asked for THIS turn. Equal to the configuring human on a
    -- single-member thread; different, and load-bearing for attribution, the
    -- moment a second member speaks.
    'requestedByMemberId', requester.entity_id,
    'requestedByIdentityId', requester.identity_id,
    'requestedByDisplayName', requester.display_name,
    'teammateId', binding.teammate_id,
    'model', binding.model,
    'provider', binding.provider,
    'agentTool', binding.agent_tool,
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

reset role;
