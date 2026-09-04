-- 123 — Chat modes are write-once thread authority, and every provider tool
-- call gets a small graph audit event without duplicating arguments or output.

set role tm8_graph_owner;

alter table public.chat_threads
  add column chat_mode text not null default 'ask'
  check (chat_mode in ('ask', 'plan', 'build', 'orchestrate'));

comment on column public.chat_threads.chat_mode is
  'Write-once chat authority profile. Persisted with teammate/model so resumes cannot widen it.';

alter table public.chat_turns add column requested_by_auth_kind text
  check (requested_by_auth_kind is null or requested_by_auth_kind in ('browser', 'cli'));

comment on column public.chat_turns.requested_by_auth_kind is
  'Server-resolved human auth kind for the member who queued this turn. Used '
  'with requested_by_member_id to mint per-turn authority; NULL fails closed.';

drop function public.start_chat_thread(uuid,uuid,text,text,text,uuid,text,text);

create function public.start_chat_thread(
  p_root_message_id uuid,
  p_teammate_id uuid,
  p_model text,
  p_provider text,
  p_agent_tool text,
  p_chat_mode text,
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
  if p_chat_mode not in ('ask', 'plan', 'build', 'orchestrate') then
    raise exception 'invalid chat mode' using errcode = '22023';
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
    'agentTool', p_agent_tool,
    'mode', p_chat_mode
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

  select * into root from public.messages
   where entity_id = p_root_message_id for update;
  if root.entity_id is not null then
    select * into root_entity from public.entities
     where id = root.entity_id for update;
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
    select 1 from public.team_members tm
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
    model, provider, agent_tool, chat_mode, native_session_id, cwd,
    client_mutation_id, requester_auth_kind
  ) values (
    p_root_message_id, root_entity.space_id, root.anchor_id,
    internal.identity_id(), member_id, p_teammate_id,
    p_model, p_provider, p_agent_tool, p_chat_mode, p_native_session_id, p_cwd,
    p_client_mutation_id, internal.claim_text('tm8.auth_kind')
  ) returning created_at into configured_at;

  insert into public.chat_turns(
    root_message_id, user_message_id, requested_by_member_id, requested_by_auth_kind,
    pricing_provider, pricing_model, queued_at
  ) values (
    p_root_message_id, p_root_message_id, member_id, internal.claim_text('tm8.auth_kind'),
    p_provider, p_model, root.created_at
  );

  select max(created_at) into last_reply from public.messages
   where root_message_id = p_root_message_id;
  result := jsonb_build_object(
    'thread', jsonb_build_object(
      'rootMessageId', p_root_message_id,
      'anchorId', root.anchor_id,
      'teammateId', p_teammate_id,
      'model', p_model,
      'mode', p_chat_mode,
      'createdAt', internal.w2_iso(configured_at),
      'lastReplyAt', internal.w2_iso(last_reply)
    ),
    '_requestHash', request_hash
  );
  return internal.ledger_record(p_client_mutation_id, 'chat.threads.start', result);
end
$$;

revoke all on function public.start_chat_thread(uuid,uuid,text,text,text,text,uuid,text,text) from public;
grant execute on function public.start_chat_thread(uuid,uuid,text,text,text,text,uuid,text,text) to tm8_app;

-- Latest (115) queue shape, plus the server-resolved auth kind needed to stop
-- a shared chat from borrowing its configurer's authority for later senders.
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
    pricing_provider, pricing_model, queued_at
  ) values (
    binding.root_message_id, new.entity_id, author_member.entity_id, auth_kind,
    binding.provider, binding.model, new.created_at
  ) on conflict (user_message_id) do nothing;
  return new;
end
$$;

-- Latest (115) claim shape, plus stored mode and per-turn authority.
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

alter table public.activity drop constraint activity_verb_check;
alter table public.activity add constraint activity_verb_check check (verb in (
  'created','updated','moved','deleted','restored','linked','unlinked',
  'reacted','awarded','completed','joined','pulled','work.changed',
  'pr.linked','unblocked','chat.tool_called'
));

create or replace function internal.audit_chat_tool_call() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare binding public.chat_threads; call_id text;
begin
  if new.kind <> 'tool_call' then return new; end if;
  call_id := coalesce(new.payload ->> 'id', 'unknown');
  select ct.* into binding
    from public.chat_turns turn_row
    join public.chat_threads ct on ct.root_message_id = turn_row.root_message_id
   where turn_row.agent_message_id = new.message_id
   limit 1;
  if binding.root_message_id is null then return new; end if;
  if exists (
    select 1 from public.activity a
     where a.entity_id = new.message_id and a.verb = 'chat.tool_called'
       and a.summary ->> 'toolCallId' = call_id
       and a.summary ->> 'state' = coalesce(new.payload ->> 'state', 'unknown')
  ) then return new; end if;
  perform internal.record_activity(
    binding.space_id, new.message_id, binding.teammate_id, 'chat.tool_called',
    binding.root_message_id,
    jsonb_build_object(
      'threadRootId', binding.root_message_id,
      'toolCallId', call_id,
      'tool', coalesce(new.payload ->> 'name', 'unknown'),
      'state', coalesce(new.payload ->> 'state', 'unknown'),
      'mode', binding.chat_mode
    )
  );
  return new;
end
$$;

create trigger message_parts_audit_tool_call
after insert on public.message_parts
for each row execute function internal.audit_chat_tool_call();

reset role;
