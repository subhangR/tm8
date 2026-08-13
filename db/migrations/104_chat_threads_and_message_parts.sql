-- =============================================================================
-- 104 — TM8 Chat durable bindings, turn queue, and structured message parts.
--
-- A chat conversation remains an ordinary message thread. This migration adds
-- only the server/runtime facts a message thread does not already carry:
--
--   * chat_threads: a write-once root -> human/teammate/model/runtime binding;
--   * chat_turns: the durable, ordered per-thread work queue and per-turn cost;
--   * message_parts: C1 items, append-only and ordered by (message_id, seq).
--
-- The root is always posted first through messages.post by a human. The sole
-- new catalog operation configures that existing root and queues turn one.
-- Later replies are queued by the trigger below only when their author is the
-- configuring human. Other humans remain visible participants but cannot run
-- tools under somebody else's frozen authorization (R3/C5).
-- =============================================================================

set role tm8_graph_owner;

create table public.chat_threads (
  root_message_id          uuid primary key references public.messages(entity_id) on delete cascade,
  space_id                 uuid not null references public.spaces(id) on delete cascade,
  anchor_id                uuid not null references public.entities(id) on delete restrict,
  configured_by_identity_id text not null references public.user_profiles(identity_id) on delete restrict,
  configured_by_member_id  uuid not null references public.members(entity_id) on delete restrict,
  teammate_id              uuid not null references public.team_members(entity_id) on delete restrict,
  model                    text not null check (char_length(btrim(model)) between 1 and 200),
  provider                 text not null check (char_length(btrim(provider)) between 1 and 100),
  agent_tool               text not null check (char_length(btrim(agent_tool)) between 1 and 100),
  native_session_id        uuid not null unique,
  cwd                      text not null check (char_length(cwd) between 1 and 4096 and left(cwd, 1) = '/'),
  runtime_state            text not null default 'cold'
    check (runtime_state in ('cold', 'live', 'stopped')),
  client_mutation_id       text not null unique check (char_length(btrim(client_mutation_id)) between 1 and 200),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (root_message_id, space_id),
  unique (root_message_id, configured_by_identity_id)
);

create index chat_threads_space_created_idx
  on public.chat_threads(space_id, created_at desc, root_message_id desc);

create table public.chat_turns (
  turn_id            uuid primary key default internal.new_id(),
  root_message_id    uuid not null references public.chat_threads(root_message_id) on delete cascade,
  user_message_id    uuid not null unique references public.messages(entity_id) on delete cascade,
  agent_message_id   uuid unique references public.messages(entity_id) on delete set null,
  state              text not null default 'queued'
    check (state in ('queued', 'running', 'completed', 'error')),
  attempt_no         integer not null default 0 check (attempt_no >= 0),
  pricing_provider   text not null,
  pricing_model      text not null,
  usage              jsonb check (usage is null or jsonb_typeof(usage) = 'object'),
  usage_source       text check (usage_source is null or usage_source = 'c1_usage_item'),
  total_cost_usd     numeric check (total_cost_usd is null or total_cost_usd >= 0),
  failure            jsonb check (failure is null or jsonb_typeof(failure) = 'object'),
  queued_at          timestamptz not null,
  started_at         timestamptz,
  completed_at       timestamptz,
  lease_expires_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index chat_turns_root_queue_idx
  on public.chat_turns(root_message_id, state, queued_at, user_message_id);

create table public.message_parts (
  message_id  uuid not null references public.messages(entity_id) on delete cascade,
  seq         integer not null check (seq >= 0),
  kind        text not null check (kind in (
                'thinking', 'text', 'tool_call', 'tool_result', 'usage', 'error', 'done'
              )),
  payload     jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (message_id, seq)
);

comment on table public.message_parts is
  'TM8 Chat C2: append-only C1 items, durable before their matching WebSocket delta.';
comment on column public.chat_turns.total_cost_usd is
  'NULL means the provider did not report cost; it must never be coerced to zero.';

-- The app may read only the two UI projections. All writes, queue claims and
-- cost records stay behind the SECURITY DEFINER doors below.
alter table public.chat_threads enable row level security;
alter table public.chat_turns enable row level security;
alter table public.message_parts enable row level security;

create policy chat_threads_select on public.chat_threads for select to tm8_app
  using (internal.entity_readable(root_message_id) and internal.entity_readable(anchor_id));

create policy message_parts_select on public.message_parts for select to tm8_app
  using (internal.entity_readable(message_id));

grant select on public.chat_threads to tm8_app;
grant select on public.message_parts to tm8_app;

-- ---------------------------------------------------------------------------
-- Configure an existing human root. The binding is write-once, and turn one
-- is queued in the same transaction so no configured thread can lose its root
-- prompt between the command response and a process wake-up.
-- ---------------------------------------------------------------------------
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
    model, provider, agent_tool, native_session_id, cwd, client_mutation_id
  ) values (
    p_root_message_id, root_entity.space_id, root.anchor_id,
    internal.identity_id(), member_id, p_teammate_id,
    p_model, p_provider, p_agent_tool, p_native_session_id, p_cwd, p_client_mutation_id
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
create or replace function internal.queue_chat_human_reply() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare binding public.chat_threads;
begin
  if new.root_message_id is null then return new; end if;
  select * into binding from public.chat_threads
   where root_message_id = new.root_message_id;
  if binding.root_message_id is null or new.author_id <> binding.configured_by_member_id then
    return new;
  end if;
  insert into public.chat_turns(
    root_message_id, user_message_id, pricing_provider, pricing_model, queued_at
  ) values (
    binding.root_message_id, new.entity_id, binding.provider, binding.model, new.created_at
  ) on conflict (user_message_id) do nothing;
  return new;
end
$$;

create trigger messages_queue_chat_human_reply
after insert on public.messages
for each row execute function internal.queue_chat_human_reply();

-- Claim one turn in durable message order. Expired leases are reclaimable; an
-- already-bound agent message is returned so a retry appends idempotently to
-- the same durable response rather than minting a duplicate reply.
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
    'nextSeq', case when turn_row.agent_message_id is null then 0 else
      (select coalesce(max(seq) + 1, 0) from public.message_parts
        where message_id = turn_row.agent_message_id) end
  );
end
$$;

create or replace function public.mark_chat_runtime_state(
  p_root_message_id uuid, p_state text
) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare binding public.chat_threads;
begin
  perform internal.require_identity();
  if p_state not in ('live', 'stopped') then
    raise exception 'invalid chat runtime state' using errcode = '22023';
  end if;
  select * into binding from public.chat_threads
   where root_message_id = p_root_message_id for update;
  if binding.root_message_id is null or binding.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat thread not found for this identity' using errcode = 'P0002';
  end if;
  update public.chat_threads
     set runtime_state = p_state, updated_at = now()
   where root_message_id = p_root_message_id;
end
$$;

create or replace function public.bind_chat_agent_message(
  p_turn_id uuid, p_agent_message_id uuid
) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare turn_row public.chat_turns; binding public.chat_threads; agent_message public.messages;
begin
  perform internal.require_identity();
  select * into turn_row from public.chat_turns where turn_id = p_turn_id for update;
  select * into binding from public.chat_threads where root_message_id = turn_row.root_message_id;
  if turn_row.turn_id is null or binding.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat turn not found for this identity' using errcode = 'P0002';
  end if;
  select * into agent_message from public.messages where entity_id = p_agent_message_id;
  if agent_message.entity_id is null
     or agent_message.root_message_id <> binding.root_message_id
     or agent_message.author_id <> binding.teammate_id then
    raise exception 'agent message does not belong to this chat turn' using errcode = '23514';
  end if;
  if turn_row.agent_message_id is not null and turn_row.agent_message_id <> p_agent_message_id then
    raise exception 'chat turn already has a different agent message' using errcode = '23505';
  end if;
  update public.chat_turns set agent_message_id = p_agent_message_id, updated_at = now()
   where turn_id = p_turn_id;
end
$$;

create or replace function public.append_chat_message_part(
  p_message_id uuid, p_seq integer, p_kind text, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare turn_row public.chat_turns; binding public.chat_threads; stored public.message_parts;
begin
  perform internal.require_identity();
  if p_seq < 0 or p_kind not in ('thinking','text','tool_call','tool_result','usage','error','done')
     or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid chat message part' using errcode = '22023';
  end if;
  select * into turn_row from public.chat_turns where agent_message_id = p_message_id;
  select * into binding from public.chat_threads where root_message_id = turn_row.root_message_id;
  if turn_row.turn_id is null or binding.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat agent message not found for this identity' using errcode = 'P0002';
  end if;
  insert into public.message_parts(message_id, seq, kind, payload)
  values (p_message_id, p_seq, p_kind, p_payload)
  on conflict (message_id, seq) do nothing;
  select * into stored from public.message_parts where message_id = p_message_id and seq = p_seq;
  if stored.kind <> p_kind or stored.payload is distinct from p_payload then
    raise exception 'chat message part sequence already has different content' using errcode = '23514';
  end if;
  return jsonb_build_object(
    'seq', stored.seq,
    'kind', stored.kind,
    'payload', stored.payload,
    'createdAt', internal.w2_iso(stored.created_at)
  );
end
$$;

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
  if p_state not in ('completed', 'error')
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
    case when p_state = 'completed' then 'Agent turn completed.' else 'Agent turn failed.' end), 10000);
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

revoke all on function public.start_chat_thread(uuid,uuid,text,text,text,uuid,text,text) from public;
revoke all on function public.claim_next_chat_turn(uuid) from public;
revoke all on function public.mark_chat_runtime_state(uuid,text) from public;
revoke all on function public.bind_chat_agent_message(uuid,uuid) from public;
revoke all on function public.append_chat_message_part(uuid,integer,text,jsonb) from public;
revoke all on function public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb) from public;

grant execute on function public.start_chat_thread(uuid,uuid,text,text,text,uuid,text,text) to tm8_app;
grant execute on function public.claim_next_chat_turn(uuid) to tm8_app;
grant execute on function public.mark_chat_runtime_state(uuid,text) to tm8_app;
grant execute on function public.bind_chat_agent_message(uuid,uuid) to tm8_app;
grant execute on function public.append_chat_message_part(uuid,integer,text,jsonb) to tm8_app;
grant execute on function public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb) to tm8_app;

reset role;
