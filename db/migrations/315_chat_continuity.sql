-- 315: Chat continuity primitives. Existing turns/messages/parts remain history.
-- Desired configuration is atomic; attempts and native bindings fence runtime work.
set role tm8_graph_owner;

alter table public.chats
  add column config_revision bigint not null default 1,
  add column credential_intent jsonb,
  add column reasoning_effort text,
  add column history_seq bigint not null default 0,
  add column next_turn_ordinal bigint not null default 1,
  add column runtime_epoch bigint not null default 0,
  add column next_native_generation bigint not null default 1,
  add column history_visibility_revision bigint not null default 1;

-- Runtime lane shares these ownership columns on the existing chat row.
alter table public.chats
  add column runtime_owner_boot_id text,
  add column runtime_lease_token_hash text,
  add column runtime_lease_expires_at timestamptz,
  add column runtime_phase text not null default 'idle' check (runtime_phase in ('idle','preparing','opening','prepared','ready','dispatching','running','recovering','closing')),
  add column active_execution_snapshot_id uuid;

alter table public.chat_turns
  add column turn_ordinal bigint,
  add column input_snapshot jsonb, -- immutable original body/attachments/source
  add column input_history_seq bigint,
  add column settlement_history_seq bigint,
  add column claimed_config_revision bigint,
  add column claimed_configuration jsonb, -- first-claim settings; refs only
  add column execution_snapshot_id uuid;
create unique index chat_turns_ordinal_uq
  on public.chat_turns(chat_id, turn_ordinal);
alter table public.chat_turns add constraint chat_turn_chat_uq
  unique (chat_id, turn_id);

alter table public.message_parts
  add column chat_capture_seq bigint,
  add column execution_snapshot_id uuid,
  add column normalized_event_id text;
create unique index chat_part_normalized_event_uq on public.message_parts
  (message_id, execution_snapshot_id, normalized_event_id)
  where normalized_event_id is not null;

create table public.chat_context_checkpoints (
  chat_id uuid not null references public.chats(entity_id) on delete cascade,
  checkpoint_id uuid not null default internal.new_id(),
  cursor jsonb not null,
  summary_text text not null,
  source_citations jsonb not null,
  uncertainty_manifest jsonb not null,
  reducer_revision text not null,
  summarizer_model text,
  created_at timestamptz not null default now(),
  primary key (chat_id, checkpoint_id)
);

create table public.chat_native_bindings (
  chat_id uuid not null references public.chats(entity_id) on delete cascade,
  generation bigint not null check (generation > 0),
  agent_tool text not null,
  adapter_protocol_revision text not null,
  native_id text, -- null only while reserved; provider may allocate at open
  node_id text not null,
  workdir_binding text not null,
  storage_scope_ref text not null,
  compatibility_digest text not null,
  status text not null check (status in
    ('reserved','prepared','ready','retired','failed','legacy_unverified')),
  seed_snapshot_id uuid,
  seed_transport text,
  seed_ack_digest text,
  covered_cursor jsonb,
  native_checkpoint jsonb,
  runtime_epoch bigint not null,
  created_at timestamptz not null default now(),
  primary key (chat_id, generation),
  check (status <> 'ready' or native_id is not null)
);
create unique index chat_native_current_uq on public.chat_native_bindings(chat_id)
  where status in ('reserved','prepared','ready');
create unique index chat_native_scoped_id_uq on public.chat_native_bindings
  (agent_tool, node_id, storage_scope_ref, native_id) where native_id is not null;

create table public.chat_turn_attempts (
  chat_id uuid not null,
  turn_id uuid not null,
  attempt_no integer not null check (attempt_no > 0),
  snapshot_id uuid not null unique default internal.new_id(),
  config_revision bigint not null,
  runtime_epoch bigint not null,
  native_generation bigint not null,
  -- Immutable, validated DTO: target, authority, credential refs/revisions,
  -- prompt/tool hashes, current input, budget, prior cursor, continuity mode.
  configuration_snapshot jsonb not null,
  -- Immutable BootstrapContext including exact rendered bytes/hash/manifest;
  -- null for live reuse/resume/create. snapshotId identifies this attempt.
  bootstrap_context jsonb,
  input_digest text not null,
  -- Only lifecycle/receipt fields below may change, under epoch/attempt CAS.
  phase text not null check (phase in
    ('prepared','dispatching','accepted','settled','delivery_unknown')),
  provider_turn_id text,
  open_receipt jsonb,
  provider_terminal jsonb,
  dispatch_started_at timestamptz,
  accepted_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (chat_id, turn_id, attempt_no),
  unique (chat_id, snapshot_id),
  foreign key (chat_id, turn_id)
    references public.chat_turns(chat_id, turn_id) on delete cascade,
  foreign key (chat_id, native_generation)
    references public.chat_native_bindings(chat_id, generation)
);
alter table public.chat_turns add constraint chat_turn_snapshot_fk
  foreign key (chat_id, execution_snapshot_id)
  references public.chat_turn_attempts(chat_id, snapshot_id);
alter table public.message_parts add constraint chat_part_snapshot_fk
  foreign key (execution_snapshot_id)
  references public.chat_turn_attempts(snapshot_id);
alter table public.chat_native_bindings add constraint chat_native_seed_fk
  foreign key (chat_id, seed_snapshot_id)
  references public.chat_turn_attempts(chat_id, snapshot_id);
alter table public.chats add constraint chat_active_snapshot_fk
  foreign key (entity_id, active_execution_snapshot_id)
  references public.chat_turn_attempts(chat_id, snapshot_id);

alter table public.auth_sessions
  add column runtime_epoch bigint,
  add column runtime_native_generation bigint;

-- Assign durable logical order and capture the original input in its queue tx.
create function internal.chat_assign_turn_order() returns trigger
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare chat public.chats; msg public.messages;
begin
  select * into chat from public.chats where entity_id=new.chat_id for update;
  select * into msg from public.messages where entity_id=new.user_message_id;
  new.turn_ordinal := chat.next_turn_ordinal;
  new.input_history_seq := chat.history_seq + 1;
  new.input_snapshot := jsonb_build_object(
    'body',msg.body,'attachments',coalesce(msg.attachments,'[]'::jsonb),
    'actorId',msg.author_id,'sourceSessionId',new.requested_by_session_id,
    'sourceChatId',new.requested_by_chat_id,'requestedByMemberId',new.requested_by_member_id);
  update public.chats set next_turn_ordinal=next_turn_ordinal+1, history_seq=history_seq+1
    where entity_id=new.chat_id;
  return new;
end $$;

-- Legacy order is reconstructed once; no historical execution facts are invented.
with ordered as (
  select turn_id, row_number() over(partition by chat_id order by queued_at,user_message_id) ordinal
  from public.chat_turns
)
update public.chat_turns t set turn_ordinal=o.ordinal,input_history_seq=o.ordinal,
  input_snapshot=jsonb_build_object('body',m.body,'attachments',coalesce(m.attachments,'[]'::jsonb),
    'actorId',m.author_id,'sourceSessionId',t.requested_by_session_id,
    'sourceChatId',t.requested_by_chat_id,'attribution','legacy_reconstructed')
from ordered o, public.messages m where t.turn_id=o.turn_id and m.entity_id=t.user_message_id;
update public.chats c set next_turn_ordinal=coalesce((select max(turn_ordinal)+1 from public.chat_turns where chat_id=c.entity_id),1),
  history_seq=coalesce((select max(turn_ordinal) from public.chat_turns where chat_id=c.entity_id),0);
alter table public.chat_turns alter column turn_ordinal set not null;
create trigger chat_turns_assign_order before insert on public.chat_turns
  for each row execute function internal.chat_assign_turn_order();

create function internal.chat_validate_selection(p_selection jsonb) returns void
language plpgsql immutable as $$
begin
  if p_selection is null or jsonb_typeof(p_selection)<>'object'
     or coalesce(p_selection->>'source','') not in ('auto','member','space','node')
     or exists(select 1 from jsonb_object_keys(p_selection) k where k not in ('source','credentialId'))
     or (p_selection ? 'credentialId' and (p_selection->>'source'<>'space'
       or coalesce(p_selection->>'credentialId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) then
    raise exception 'invalid chat credential selection' using errcode='22023';
  end if;
end $$;

create function public.set_chat_configuration(p_chat_id uuid,p_expected_revision bigint,
  p_resolved_target jsonb,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare chat public.chats; replay jsonb; result jsonb; request_hash text;
  intent jsonb := p_resolved_target->'credentialIntent'; entry record;
begin
  perform internal.require_identity();
  perform internal.require_human_auth_kind();
  if p_mutation_id is null or btrim(p_mutation_id)='' then
    raise exception 'clientMutationId is required' using errcode='22023';
  end if;
  request_hash := internal.w2_sha256(jsonb_build_object('chatId',p_chat_id,
    'identityId',internal.identity_id(),'expectedRevision',p_expected_revision,'target',p_resolved_target));
  replay := internal.ledger_replay(p_mutation_id,'chat.configuration.set');
  if replay is not null then
    if replay->>'_requestHash' is distinct from request_hash then
      raise exception 'configuration mutation replay mismatch' using errcode='23514';
    end if;
    return replay;
  end if;
  select c.* into chat from public.chats c join public.entities e on e.id=c.entity_id
    where c.entity_id=p_chat_id and e.deleted_at is null for update of c;
  if chat.entity_id is null or chat.configured_by_identity_id<>internal.identity_id()
     or (nullif(current_setting('tm8.session_space_id',true),'')::uuid is not null
       and chat.space_id<>nullif(current_setting('tm8.session_space_id',true),'')::uuid) then
    raise exception 'chat not found for this identity' using errcode='P0002';
  end if;
  perform internal.require_space_member(chat.space_id);
  if p_expected_revision is distinct from chat.config_revision then
    raise exception 'chat configuration revision conflict' using errcode='40001',
      detail=jsonb_build_object('currentVersion',chat.config_revision)::text;
  end if;
  if coalesce(jsonb_typeof(p_resolved_target),'null')<>'object'
     or exists(select 1 from jsonb_object_keys(p_resolved_target) k where k not in
       ('model','provider','agentTool','reasoningEffort','credentialIntent','credentialSelection'))
     or coalesce(btrim(p_resolved_target->>'model'),'')=''
     or coalesce(btrim(p_resolved_target->>'provider'),'')=''
     or coalesce(p_resolved_target->>'agentTool','') not in ('claude-code','codex')
     or (p_resolved_target->'reasoningEffort' is not null
       and jsonb_typeof(p_resolved_target->'reasoningEffort') not in ('string','null')) then
    raise exception 'invalid resolved chat configuration' using errcode='22023';
  end if;
  perform internal.chat_validate_selection(p_resolved_target->'credentialSelection');
  if intent is null or jsonb_typeof(intent)<>'object'
    or exists(select 1 from jsonb_object_keys(intent) k where k not in ('defaultChoice','byProvider'))
    or coalesce(jsonb_typeof(intent->'byProvider'),'null')<>'object' then
    raise exception 'invalid chat credential intent' using errcode='22023';
  end if;
  perform internal.chat_validate_selection(intent->'defaultChoice');
  if intent->'defaultChoice' ? 'credentialId' then
    raise exception 'default credential choice cannot be pinned' using errcode='22023';
  end if;
  for entry in select key,value from jsonb_each(intent->'byProvider') loop
    if char_length(entry.key) not between 1 and 100 then
      raise exception 'invalid credential provider key' using errcode='22023';
    end if;
    perform internal.chat_validate_selection(entry.value);
  end loop;
  update public.chats set model=p_resolved_target->>'model',provider=p_resolved_target->>'provider',
    agent_tool=p_resolved_target->>'agentTool',reasoning_effort=p_resolved_target->>'reasoningEffort',
    credential_intent=intent,credential_selection=p_resolved_target->'credentialSelection',
    config_revision=config_revision+1 where entity_id=p_chat_id returning * into chat;
  result := p_resolved_target || jsonb_build_object('chatId',p_chat_id,
    'configRevision',chat.config_revision,'appliesAt','next_claim','_requestHash',request_hash);
  return internal.ledger_record(p_mutation_id,'chat.configuration.set',result);
end $$;
revoke all on function public.set_chat_configuration(uuid,bigint,jsonb,text) from public;
grant execute on function public.set_chat_configuration(uuid,bigint,jsonb,text) to tm8_app;

alter table public.chat_native_bindings enable row level security;
alter table public.chat_turn_attempts enable row level security;
alter table public.chat_context_checkpoints enable row level security;
create policy chat_native_bindings_read on public.chat_native_bindings for select to tm8_app
  using (internal.entity_readable(chat_id));
create policy chat_turn_attempts_read on public.chat_turn_attempts for select to tm8_app
  using (internal.entity_readable(chat_id));
create policy chat_context_checkpoints_read on public.chat_context_checkpoints for select to tm8_app
  using (internal.entity_readable(chat_id));
grant select on public.chat_native_bindings, public.chat_turn_attempts, public.chat_context_checkpoints to tm8_app;
reset role;
