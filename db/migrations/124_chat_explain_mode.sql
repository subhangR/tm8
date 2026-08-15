-- 124 — Explain is a write-once chat authority profile for explanatory
-- outputs such as diagrams and artifacts.

set role tm8_graph_owner;

-- Install and validate the wider constraint before removing the old one, so
-- deployed rows remain protected throughout this forward-only migration.
alter table public.chat_threads
  add constraint chat_threads_chat_mode_check_v2
  check (chat_mode in ('ask', 'explain', 'plan', 'build', 'orchestrate')) not valid;

alter table public.chat_threads
  validate constraint chat_threads_chat_mode_check_v2;

alter table public.chat_threads
  drop constraint chat_threads_chat_mode_check;

alter table public.chat_threads
  rename constraint chat_threads_chat_mode_check_v2 to chat_threads_chat_mode_check;

-- Keep the function-level rejection aligned with the table constraint. This
-- is the latest 122 definition with only the accepted mode set widened.
create or replace function public.start_chat_thread(
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
  if p_chat_mode not in ('ask', 'explain', 'plan', 'build', 'orchestrate') then
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

reset role;
