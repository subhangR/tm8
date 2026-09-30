-- =============================================================================
-- 276  A CHAT'S MODEL BECOMES SWITCHABLE MID-CONVERSATION, AND EVERY TURN
--      RECORDS THE MODEL THAT ACTUALLY RAN IT.
--
-- THE DEFECT. The chat composer's model picker is dead for the whole life of a
-- thread (`ChatHomeScreen.tsx`: `disabled={pinned}`, "the model is fixed when a
-- thread starts"). The copy was HONEST, not a UI bug: `chats.model` is read once
-- per claim and `claim_next_chat_turn` returned it unconditionally, so a human
-- who wanted to finish a conversation on a stronger model had to abandon the
-- conversation and start a new one, losing the context that made it worth
-- continuing.
--
-- WHY THE LOCK CAN GO. Measured on this host (claude 2.1.280), one native
-- session, two turns:
--     claude -p --session-id <sid> --model claude-haiku-4-5-20251001 "…PLUM-7741…"
--     claude -p --resume     <sid> --model claude-sonnet-5           "…which codeword?"
--   -> "PLUM-7741", and the transcript records per assistant message
--      model='claude-haiku-4-5-20251001' then model='claude-sonnet-5'.
-- A Claude Code session carries turns from DIFFERENT models and keeps the
-- conversation across the switch. The `--model` flag is honoured on resume, not
-- ignored. So the fixed model was tm8 policy, never a transport limit.
--
-- AND THE SWITCH NEVER CROSSES A CLI BOUNDARY. Chat composes exactly one runtime
-- adapter (`chat/compose.ts`: ClaudeHeadlessAdapter) and the composer already
-- lists codex models disabled with "chat runs Claude Code only". Every model
-- selectable as a chat coordinator is agentTool=claude-code, so `--resume` is
-- always valid for a switch. `agent_tool` is therefore the ONE axis this
-- migration refuses to move: see the guard in `set_chat_model`.
--
-- SHAPE. Deliberately NOT the 153/154 message-borne carrier used for per-turn
-- mode. That shape would have to reproduce the ~255-line `w2_post_message_batch`
-- verbatim to add one column write, and it buys per-MESSAGE granularity nobody
-- asked for. What a human means by "switch model" is STICKY — "continue this
-- conversation on Opus" — so the model moves on the CHAT and the turn records
-- what ran:
--
--   1. chat_turns gains `model` and `provider`: what this turn RAN ON, stamped
--      at CLAIM (the single serialization point — the claim already takes
--      `for update` on both rows) and first-claim-wins so a lease retry keeps
--      its original model.
--   2. `set_chat_model` moves the chat's model, refusing to cross agent_tool.
--   3. `claim_next_chat_turn` stamps and returns the resolved model/provider.
--
-- THE RULE, one line: A TURN RUNS ON THE MODEL THE CHAT IS SET TO WHEN THE TURN
-- IS CLAIMED, AND SAYS SO AFTERWARDS. Claim is serialized, so there is no race:
-- a switch while a turn is already running cannot affect that turn (it was
-- stamped at its own claim) and takes effect on the next one.
--
-- INERT FOR EXISTING ROWS. Both new columns are nullable and every read
-- coalesces to the chat's model, so a pre-276 turn projects exactly what it
-- projected before. Nothing backfills: a turn that ran before this migration has
-- no record of which model ran it, and inventing one would forge history.
-- =============================================================================

-- 1. WHAT THIS TURN RAN ON -------------------------------------------------
-- Nullable for the reason above: NULL means "not recorded" (a pre-276 turn), and
-- every reader resolves it against the chat. Not a foreign key and not
-- constrained to a catalog: the launch catalog is a contract-level list that
-- changes with releases, and a turn's record of what ran must survive a model
-- being retired from that list.
alter table public.chat_turns
  add column model text,
  add column provider text;

comment on column public.chat_turns.model is
  'The model that ACTUALLY RAN this turn, stamped at claim time from '
  'chats.model. NULL on a pre-276 row; readers coalesce to chats.model. '
  'First claim wins, so a lease-expiry retry keeps its original model.';

comment on column public.chat_turns.provider is
  'The provider that served this turn''s model, stamped alongside '
  'chat_turns.model. Decides which API-key backend the child was given.';

-- 2. MOVING THE CHAT'S MODEL ------------------------------------------------
-- `tm8_app` holds SELECT and nothing else on public.chats; every write to that
-- table goes through a security-definer door. This is that door.
--
-- THREE GUARDS, and each one is here because dropping it would be silent:
--   (a) the caller must be the chat's configuring identity — the same test
--       `claim_next_chat_turn` makes, so a model switch is exactly as privileged
--       as running a turn;
--   (b) agent_tool may not move. A codex model in a claude-code chat would spawn
--       `claude --model gpt-…`, which fails at the provider rather than here,
--       and a tool change would invalidate the native session the resume
--       depends on. The SERVER resolves agent_tool from the launch catalog and
--       passes it; the database refuses the mismatch.
--   (c) model must be non-blank, because '' reaches the CLI as `--model ''`.
create or replace function public.set_chat_model(
  p_chat_id uuid, p_model text, p_provider text, p_agent_tool text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  chat_row public.chats;
begin
  perform internal.require_identity();
  if p_model is null or btrim(p_model) = '' then
    raise exception 'chat model must be a non-empty string' using errcode = '22023';
  end if;
  if p_provider is null or btrim(p_provider) = '' then
    raise exception 'chat provider must be a non-empty string' using errcode = '22023';
  end if;
  select * into chat_row from public.chats where entity_id = p_chat_id for update;
  if chat_row.entity_id is null
     or chat_row.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat not found for this identity' using errcode = 'P0002';
  end if;
  if p_agent_tool is distinct from chat_row.agent_tool then
    raise exception
      'chat % runs on % and cannot switch to a % model; start a new chat instead',
      p_chat_id, chat_row.agent_tool, p_agent_tool using errcode = '22023';
  end if;
  -- A no-op switch is not an error: the composer may re-send the current model
  -- and must not see a failure for changing nothing.
  update public.chats
     set model = p_model, provider = p_provider
   where entity_id = p_chat_id
  returning * into chat_row;
  return jsonb_build_object(
    'chatId', chat_row.entity_id,
    'model', chat_row.model,
    'provider', chat_row.provider,
    'agentTool', chat_row.agent_tool,
    'updatedAt', chat_row.updated_at
  );
end
$$;

revoke all on function public.set_chat_model(uuid, text, text, text) from public;
grant execute on function public.set_chat_model(uuid, text, text, text) to tm8_app;

-- 3. THE CLAIM STAMPS WHAT IT IS ABOUT TO RUN -------------------------------
-- The live 176 body VERBATIM, with exactly three lines moved:
--   * the claim UPDATE also sets `model` / `provider`, first-claim-wins;
--   * the payload's 'model' and 'provider' resolve from the turn, not the chat.
-- Everything else — the requester coalesce, the R-C provenance block, the
-- chatMode resolution, nextSeq — is unchanged, character for character.
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

-- 4. VERIFY ------------------------------------------------------------------
do $$
declare missing text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='chat_turns' and column_name='model'
  ) then
    raise exception 'VERIFY 276: chat_turns.model was not added';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='chat_turns' and column_name='provider'
  ) then
    raise exception 'VERIFY 276: chat_turns.provider was not added';
  end if;

  select string_agg(needed, ', ') into missing
    from unnest(array[
      'public.set_chat_model(uuid,text,text,text)',
      'public.claim_next_chat_turn(uuid)'
    ]) needed
   where to_regprocedure(needed) is null;
  if missing is not null then
    raise exception 'VERIFY 276: missing door(s) %', missing;
  end if;

  -- A missing `revoke … from public` is invisible in a function diff and reds
  -- every PR that follows (the 156 -> 160 lesson), so it is asserted here.
  select string_agg(needed, ', ') into missing
    from unnest(array[
      'public.set_chat_model(uuid,text,text,text)',
      'public.claim_next_chat_turn(uuid)'
    ]) needed
   where has_function_privilege('public', to_regprocedure(needed), 'EXECUTE')
      or not has_function_privilege('tm8_app', to_regprocedure(needed), 'EXECUTE');
  if missing is not null then
    raise exception 'VERIFY 276: grant/revoke wrong on %', missing;
  end if;

  -- The claim must still resolve the per-turn MODE. 153's coalesce is load
  -- bearing and sits three lines from the ones this migration moved; asserting
  -- it here is what stops a future verbatim-reproduction from dropping it.
  if position('coalesce(turn_row.mode, chat_row.chat_mode)' in
              pg_get_functiondef('public.claim_next_chat_turn(uuid)'::regprocedure)) = 0 then
    raise exception 'VERIFY 276: claim_next_chat_turn lost the per-turn mode resolution';
  end if;
end $$;
