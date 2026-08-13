-- 106_chat_thread_requester_auth_kind.sql
--
-- Composition ruling R9 (advisor, 2026-08-13), option B: the C5 mint
-- (105.issue_agent_runtime_session) demands a HUMAN tm8.auth_kind, but the
-- orchestrator's async turn loop has no bearer to resolve one from, so the
-- mint failed closed ('credentials are human-only', measured live 13ms).
--
-- Fix = truthful replay, never assertion: record the SERVER-RESOLVED auth
-- kind at the one human-gated write that configures a thread, and let the
-- launch-config resolver replay the recorded literal. R11's invariant (auth
-- kind is resolved from auth_sessions, never client-asserted) survives:
--   * written EXACTLY ONCE, inside start_chat_thread's guarded insert, after
--     require_human_auth_kind() has already refused any non-human caller —
--     so the CHECK below cannot admit 'agent'/'agent_runtime' by construction;
--   * no UPDATE path exists anywhere; the binding row is write-once (104);
--   * pre-106 rows read NULL, the resolver then omits authKind, and 105's
--     guard keeps failing closed — old threads are restarted, never forged.
-- 105 itself is deliberately untouched (R9 condition 4).

alter table public.chat_threads add column requester_auth_kind text
  check (requester_auth_kind is null or requester_auth_kind in ('browser', 'cli'));

comment on column public.chat_threads.requester_auth_kind is
  'Server-resolved tm8.auth_kind of the human who configured the thread, '
  'recorded once by start_chat_thread for R9 truthful replay at mint time. '
  'NULL (pre-106) means the resolver fails closed; never backfilled.';

-- Re-issued whole from 104 with only the insert extended (shared-body hazard:
-- if a later migration edits start_chat_thread, it must start from THIS copy).
create or replace function public.start_chat_thread(
  p_root_message_id uuid,
  p_teammate_id uuid,
  p_model text,
  p_provider text,
  p_agent_tool text,
  p_native_session_id uuid,
  p_cwd text,
  p_client_mutation_id text
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  root public.messages;
  root_entity public.entities;
  member_id uuid;
  request_hash text;
  stored_hash text;
  last_reply timestamptz;
  configured_at timestamptz;
  result jsonb;
begin
  perform internal.require_identity();
  perform internal.require_human_auth_kind();
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;
  if p_model is null or btrim(p_model) = ''
     or p_provider is null or btrim(p_provider) = ''
     or p_agent_tool is null or btrim(p_agent_tool) = '' then
    raise exception 'model, provider, and agent tool are required' using errcode = '22023';
  end if;
  if p_native_session_id is null or p_cwd is null or left(p_cwd, 1) <> '/' then
    raise exception 'native session id and absolute cwd are required' using errcode = '22023';
  end if;

  request_hash := internal.w2_sha256(jsonb_build_object(
    'identityId', internal.identity_id(),
    'rootMessageId', p_root_message_id,
    'teammateId', p_teammate_id,
    'model', p_model,
    'provider', p_provider,
    'agentTool', p_agent_tool
  ));
  replay := internal.ledger_replay(p_client_mutation_id, 'chat.threads.start');
  if replay is not null then
    stored_hash := replay ->> '_requestHash';
    if stored_hash is distinct from request_hash then
      raise exception 'chat thread start replay does not match the original request'
        using errcode = '23514', detail = 'chat_thread_start_identity_mismatch';
    end if;
    return replay;
  end if;

  select * into root
    from public.messages
   where entity_id = p_root_message_id
   for update;
  if root.entity_id is not null then
    select * into root_entity
      from public.entities
     where id = root.entity_id
     for update;
  end if;
  if root.entity_id is null or root_entity.deleted_at is not null
     or not internal.entity_readable(root.entity_id)
     or not internal.entity_readable(root.anchor_id) then
    raise exception 'chat root message not found' using errcode = 'P0002';
  end if;
  if root_entity.parent_id is not null or root.root_message_id is not null then
    raise exception 'chat must be configured on a root message' using errcode = '22023';
  end if;
  perform internal.require_space_member(root_entity.space_id);
  member_id := internal.current_member_id(root_entity.space_id);
  if member_id is null or root.author_id <> member_id then
    raise exception 'only the human root author may configure this chat thread'
      using errcode = '42501';
  end if;
  if not exists (
    select 1
      from public.team_members tm
      join public.entities teammate on teammate.id = tm.entity_id
     where tm.entity_id = p_teammate_id
       and teammate.space_id = root_entity.space_id
       and teammate.deleted_at is null
  ) then
    raise exception 'chat teammate not found in the root space' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.chat_threads where root_message_id = p_root_message_id) then
    raise exception 'chat thread configuration is write-once' using errcode = '23505';
  end if;

  insert into public.chat_threads(
    root_message_id, space_id, anchor_id,
    configured_by_identity_id, configured_by_member_id, teammate_id,
    model, provider, agent_tool, native_session_id, cwd, client_mutation_id,
    requester_auth_kind
  ) values (
    p_root_message_id, root_entity.space_id, root.anchor_id,
    internal.identity_id(), member_id, p_teammate_id,
    p_model, p_provider, p_agent_tool, p_native_session_id, p_cwd, p_client_mutation_id,
    internal.claim_text('tm8.auth_kind')
  ) returning created_at into configured_at;

  insert into public.chat_turns(
    root_message_id, user_message_id, pricing_provider, pricing_model, queued_at
  ) values (
    p_root_message_id, p_root_message_id, p_provider, p_model, root.created_at
  );

  select max(created_at) into last_reply
    from public.messages where root_message_id = p_root_message_id;
  result := jsonb_build_object(
    'thread', jsonb_build_object(
      'rootMessageId', p_root_message_id,
      'anchorId', root.anchor_id,
      'teammateId', p_teammate_id,
      'model', p_model,
      'createdAt', internal.w2_iso(configured_at),
      'lastReplyAt', internal.w2_iso(last_reply)
    ),
    '_requestHash', request_hash
  );
  return internal.ledger_record(p_client_mutation_id, 'chat.threads.start', result);
end
$$;

-- Queue only the configuring human's later replies. This is deliberately a DB
-- trigger rather than an after-commit callback: a stored message and its turn
-- intent either both commit or neither does.

-- claim_next_chat_turn: same body as 104 plus the requesterAuthKind field.
create or replace function public.claim_next_chat_turn(p_root_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare binding public.chat_threads; turn_row public.chat_turns; user_message public.messages;
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
  return jsonb_build_object(
    'turnId', turn_row.turn_id,
    'rootMessageId', binding.root_message_id,
    'spaceId', binding.space_id,
    'userMessageId', turn_row.user_message_id,
    'agentMessageId', turn_row.agent_message_id,
    'body', user_message.body,
    'anchorId', binding.anchor_id,
    'requesterIdentityId', binding.configured_by_identity_id,
    'teammateId', binding.teammate_id,
    'model', binding.model,
    'provider', binding.provider,
    'agentTool', binding.agent_tool,
    'nativeSessionId', binding.native_session_id,
    'cwd', binding.cwd,
    'runtimeState', binding.runtime_state,
    'requesterAuthKind', binding.requester_auth_kind,
    'nextSeq', case when turn_row.agent_message_id is null then 0 else
      (select coalesce(max(seq) + 1, 0) from public.message_parts
        where message_id = turn_row.agent_message_id) end
  );
end
$$;
