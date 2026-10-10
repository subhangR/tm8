-- 315: Chat continuity primitives. Existing turns/messages/parts remain history.
-- Desired configuration is atomic; attempts and native bindings fence runtime work.
set role tm8_graph_owner;

alter table public.chats
  add column configured_auth_session_id uuid,
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
  add column requester_auth_session_id uuid,
  add column input_snapshot jsonb, -- immutable original body/attachments/source
  add column input_history_seq bigint,
  add column settlement_history_seq bigint,
  add column claimed_auth_session_id uuid,
  add column claimed_authority jsonb,
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


create function internal.chat_stamp_config_authority() returns trigger language plpgsql as $$
begin
  new.configured_auth_session_id:=nullif(internal.claim_text('tm8.auth_session_id'),'')::uuid;
  return new;
end $$;
create trigger chat_stamp_config_authority before insert or update of model,provider,agent_tool,reasoning_effort,credential_selection
  on public.chats for each row execute function internal.chat_stamp_config_authority();

-- Assign durable logical order and capture the original input in its queue tx.
create function internal.chat_assign_turn_order() returns trigger
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare chat public.chats; msg public.messages;
begin
  select * into chat from public.chats where entity_id=new.chat_id for update;
  select * into msg from public.messages where entity_id=new.user_message_id;
  new.turn_ordinal := chat.next_turn_ordinal;
  new.input_history_seq := chat.history_seq + 1;
  new.requester_auth_session_id:=nullif(internal.claim_text('tm8.auth_session_id'),'')::uuid;
  new.input_snapshot := jsonb_build_object(
    'body',msg.body,'attachments',coalesce(msg.attachments,'[]'::jsonb),
    'actorId',msg.author_id,'authSessionId',new.requester_auth_session_id,'sourceSessionId',new.requested_by_session_id,
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
       and (jsonb_typeof(p_resolved_target->'reasoningEffort') not in ('string','null')
         or (jsonb_typeof(p_resolved_target->'reasoningEffort')='string' and p_resolved_target->>'reasoningEffort' not in ('low','medium','high','xhigh','max','ultra')))) then
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
    if entry.key not in ('anthropic','openai','kimi','groq') then
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
-- Immutable source and attempt fields: lifecycle receipts can advance only.
create function internal.chat_immutable_turn() returns trigger language plpgsql as $$
begin
  if old.input_snapshot is not null and (new.input_snapshot is distinct from old.input_snapshot
    or new.requester_auth_session_id is distinct from old.requester_auth_session_id
    or new.turn_ordinal is distinct from old.turn_ordinal or new.input_history_seq is distinct from old.input_history_seq)
    or old.claimed_configuration is not null and (new.claimed_configuration is distinct from old.claimed_configuration
      or new.claimed_config_revision is distinct from old.claimed_config_revision
      or new.claimed_auth_session_id is distinct from old.claimed_auth_session_id
      or new.claimed_authority is distinct from old.claimed_authority) then
    raise exception 'chat turn snapshot is immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger chat_turn_immutable before update on public.chat_turns
  for each row execute function internal.chat_immutable_turn();
create function internal.chat_immutable_attempt() returns trigger language plpgsql as $$
begin
  if row(new.chat_id,new.turn_id,new.attempt_no,new.snapshot_id,new.config_revision,new.runtime_epoch,
    new.native_generation,new.configuration_snapshot,new.bootstrap_context,new.input_digest)
    is distinct from row(old.chat_id,old.turn_id,old.attempt_no,old.snapshot_id,old.config_revision,old.runtime_epoch,
    old.native_generation,old.configuration_snapshot,old.bootstrap_context,old.input_digest) then
    raise exception 'chat attempt snapshot is immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger chat_attempt_immutable before update on public.chat_turn_attempts
  for each row execute function internal.chat_immutable_attempt();

-- One shared owner check for all lifecycle mutations. Lease token never persists in DTOs.
create function internal.chat_lock_owned(p_chat_id uuid,p_fence jsonb) returns public.chats
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare c public.chats; t public.chat_turns;
begin
  perform internal.require_identity();
  select * into c from public.chats where entity_id=p_chat_id for update;
  if c.entity_id is null or c.configured_by_identity_id<>internal.identity_id() then
    raise exception 'chat not found' using errcode='P0002';
  end if;
  perform internal.require_space_member(c.space_id);
  select * into t from public.chat_turns where chat_id=p_chat_id and turn_id=(p_fence->>'turnId')::uuid;
  if c.runtime_epoch is distinct from (p_fence->>'runtimeEpoch')::bigint
    or c.runtime_lease_token_hash is distinct from encode(sha256(convert_to(coalesce(p_fence->>'leaseToken',''),'UTF8')),'hex')
    or c.runtime_lease_expires_at is null or c.runtime_lease_expires_at<=clock_timestamp()
    or t.turn_id is null or t.state<>'running' or t.attempt_no is distinct from (p_fence->>'attemptNo')::integer then
    raise exception 'stale chat execution fence' using errcode='42501';
  end if;
  if p_fence ? 'nativeGeneration' and not exists(select 1 from public.chat_native_bindings b
    where b.chat_id=p_chat_id and b.generation=(p_fence->>'nativeGeneration')::bigint
      and b.runtime_epoch=c.runtime_epoch and b.status in ('reserved','prepared','ready')) then
    raise exception 'stale native generation' using errcode='42501';
  end if;
  return c;
end $$;
revoke all on function internal.chat_lock_owned(uuid,jsonb) from public;

-- Keep the historical rich claim projection internally; its unsafe expiry reclaim
-- path is unreachable from the new worker protocol.
alter function public.claim_next_chat_turn(uuid) rename to chat_claim_legacy_314;
alter function public.chat_claim_legacy_314(uuid) set schema internal;
revoke all on function internal.chat_claim_legacy_314(uuid) from public,tm8_app;
create function public.claim_next_chat_turn(p_chat_id uuid) returns jsonb language plpgsql
security definer set search_path=public,internal,pg_temp as $$
begin
  perform internal.require_identity();
  if exists(select 1 from public.chats where entity_id=p_chat_id and runtime_epoch>0) then
    raise exception 'chat worker protocol 2 required' using errcode='42501';
  end if;
  -- Legacy callers may claim queued work, but cannot retry expired delivery.
  if exists(select 1 from public.chat_turns where chat_id=p_chat_id and state='running') then return null; end if;
  perform internal.require_space_member((select space_id from public.chats where entity_id=p_chat_id));
  return internal.chat_claim_legacy_314(p_chat_id);
end $$;
create function public.claim_next_chat_turn(p_chat_id uuid,p_worker_protocol integer,p_owner jsonb)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare c public.chats; t public.chat_turns; result jsonb; desired jsonb; authority jsonb; requester public.members;
begin
  perform internal.require_identity();
  select * into c from public.chats where entity_id=p_chat_id for update;
  if c.entity_id is null or c.configured_by_identity_id<>internal.identity_id() then
    raise exception 'chat not found' using errcode='P0002';
  end if;
  perform internal.require_space_member(c.space_id);
  if p_worker_protocol<>2 or coalesce(p_owner->>'nodeId','')='' or coalesce(p_owner->>'bootId','')=''
    or coalesce(p_owner->>'leaseTokenHash','')!~'^[a-f0-9]{64}$' then
    raise exception 'invalid chat owner protocol' using errcode='22023';
  end if;
  if c.runtime_lease_expires_at>clock_timestamp() or exists(
    select 1 from public.chat_turns where chat_id=p_chat_id and state='running') then return null; end if;
  select * into t from public.chat_turns where chat_id=p_chat_id and state='queued'
    order by turn_ordinal for update limit 1;
  if t.turn_id is null then return null; end if;
  desired:=coalesce(t.claimed_configuration,jsonb_build_object('model',c.model,'provider',c.provider,
    'agentTool',c.agent_tool,'reasoningEffort',c.reasoning_effort,'credentialSelection',c.credential_selection,
    'credentialIntent',coalesce(c.credential_intent,jsonb_build_object('defaultChoice',
      case when c.credential_selection ? 'credentialId' then '{"source":"auto"}'::jsonb else c.credential_selection end,
      'byProvider',case when c.credential_selection ? 'credentialId' then jsonb_build_object(case when c.provider='moonshot' then 'kimi' else c.provider end,c.credential_selection) else '{}'::jsonb end))));
  select * into requester from public.members where entity_id=t.requested_by_member_id and status='active';
  authority:=coalesce(t.claimed_authority,jsonb_build_object(
    'identityId',coalesce(requester.identity_id,c.configured_by_identity_id),
    'authKind',case when requester.entity_id is not null then coalesce(t.requested_by_auth_kind,c.requester_auth_kind) else c.requester_auth_kind end,
    'authSessionId',case when requester.entity_id is not null then t.requester_auth_session_id else c.configured_auth_session_id end,
    'memberId',coalesce(requester.entity_id,c.configured_by_member_id)));
  update public.chat_turns set claimed_configuration=desired,
    claimed_authority=authority,
    claimed_config_revision=coalesce(claimed_config_revision,c.config_revision),
    claimed_auth_session_id=coalesce(claimed_auth_session_id,(authority->>'authSessionId')::uuid),
    model=desired->>'model',provider=desired->>'provider',credential_selection=desired->'credentialSelection'
    where turn_id=t.turn_id;
  result:=internal.chat_claim_legacy_314(p_chat_id);
  update public.chats set runtime_epoch=runtime_epoch+1,node_id=p_owner->>'nodeId',
    runtime_owner_boot_id=p_owner->>'bootId',runtime_lease_token_hash=p_owner->>'leaseTokenHash',
    runtime_lease_expires_at=clock_timestamp()+interval '10 minutes',runtime_phase='preparing',
    active_execution_snapshot_id=null where entity_id=p_chat_id returning * into c;
  select * into t from public.chat_turns where turn_id=t.turn_id;
  return result||desired||jsonb_build_object('body',t.input_snapshot->>'body','attachments',t.input_snapshot->'attachments',
    'turnOrdinal',t.turn_ordinal,'configRevision',t.claimed_config_revision,'claimedConfiguration',desired,
    'requesterAuthSessionId',t.claimed_auth_session_id,'claimedAuthority',t.claimed_authority,
    'attemptNo',t.attempt_no,'runtimeEpoch',c.runtime_epoch,'leaseExpiresAt',c.runtime_lease_expires_at,
    'captureHighWater',c.history_seq,'nodeId',c.node_id);
end $$;

-- Phase one deliberately bootstraps on every uncertain/cold native tail. Exact
-- native proof can optimize this later without changing portable identity.
create function public.reserve_chat_continuity(p_chat_id uuid,p_fence jsonb,p_plan jsonb)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare c public.chats; g bigint; target jsonb:=p_plan->'targetBinding';
begin
  c:=internal.chat_lock_owned(p_chat_id,p_fence);
  if c.runtime_phase<>'preparing' or coalesce(target->>'storageScopeId','')=''
    or coalesce(target->>'protocolRevision','')='' or coalesce(target->>'compatibilityDigest','')='' then
    raise exception 'invalid continuity reservation' using errcode='22023';
  end if;
  g:=c.next_native_generation;
  update public.chat_native_bindings set status='retired' where chat_id=p_chat_id and status in ('reserved','prepared','ready');
  insert into public.chat_native_bindings(chat_id,generation,agent_tool,adapter_protocol_revision,node_id,
    workdir_binding,storage_scope_ref,compatibility_digest,status,runtime_epoch)
    values(p_chat_id,g,target->>'agentTool',target->>'protocolRevision',c.node_id,c.cwd,
      target->>'storageScopeId',target->>'compatibilityDigest','reserved',c.runtime_epoch);
  update public.chats set next_native_generation=g+1,runtime_phase='opening' where entity_id=p_chat_id;
  return jsonb_build_object('runtimeEpoch',c.runtime_epoch,'nativeGeneration',g,'continuityMode','bootstrap',
    'bindingId',(select binding_id from public.chat_native_bindings where chat_id=p_chat_id and generation=g),
    'nativeRef',null,'leaseExpiresAt',c.runtime_lease_expires_at);
end $$;
create function public.seal_chat_turn_snapshot(p_chat_id uuid,p_fence jsonb,p_snapshot_id uuid,
  p_configuration jsonb,p_bootstrap jsonb) returns jsonb language plpgsql security definer
set search_path=public,internal,pg_temp as $$
declare c public.chats; t public.chat_turns; digest text;
begin
  c:=internal.chat_lock_owned(p_chat_id,p_fence);
  select * into t from public.chat_turns where turn_id=(p_fence->>'turnId')::uuid;
  if c.runtime_phase<>'opening' or p_configuration->'desired' is distinct from t.claimed_configuration
    or p_configuration->'authority' is distinct from t.claimed_authority
    or jsonb_typeof(p_configuration)<>'object' or p_bootstrap is null
    or p_bootstrap->>'snapshotId' is distinct from p_snapshot_id::text
    or (p_bootstrap->'coverage'->>'throughTurnOrdinal')::bigint is distinct from t.turn_ordinal-1
    or (p_bootstrap->'coverage'->>'captureHighWater')::bigint>c.history_seq
    or p_bootstrap->>'contentHash' is distinct from encode(sha256(convert_to(p_bootstrap->>'renderedContext','UTF8')),'hex') then
    raise exception 'invalid immutable chat snapshot' using errcode='23514';
  end if;
  digest:=internal.w2_sha256(t.input_snapshot);
  insert into public.chat_turn_attempts(chat_id,turn_id,attempt_no,snapshot_id,config_revision,runtime_epoch,
    native_generation,configuration_snapshot,bootstrap_context,input_digest,phase)
    values(p_chat_id,t.turn_id,t.attempt_no,p_snapshot_id,t.claimed_config_revision,c.runtime_epoch,
      (p_fence->>'nativeGeneration')::bigint,p_configuration,p_bootstrap,digest,'prepared');
  update public.chat_turns set execution_snapshot_id=p_snapshot_id where turn_id=t.turn_id;
  update public.chats set active_execution_snapshot_id=p_snapshot_id,runtime_phase='prepared' where entity_id=p_chat_id;
  update public.chat_native_bindings set seed_snapshot_id=p_snapshot_id,status='prepared'
    where chat_id=p_chat_id and generation=(p_fence->>'nativeGeneration')::bigint;
  return jsonb_build_object('snapshotId',p_snapshot_id,'phase','prepared','runtimeEpoch',c.runtime_epoch,
    'nativeGeneration',(p_fence->>'nativeGeneration')::bigint,'inputDigest',digest);
end $$;
create function public.record_chat_open(p_chat_id uuid,p_fence jsonb,p_snapshot_id uuid,p_open_receipt jsonb)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare c public.chats; a public.chat_turn_attempts; seed jsonb:=p_open_receipt->'seed';
begin
  c:=internal.chat_lock_owned(p_chat_id,p_fence);
  select * into a from public.chat_turn_attempts where snapshot_id=p_snapshot_id;
  if c.active_execution_snapshot_id is distinct from p_snapshot_id or a.phase<>'prepared' or a.open_receipt is not null
    or coalesce(p_open_receipt->'native'->>'nativeId','')='' then
    raise exception 'invalid chat open receipt' using errcode='23514';
  end if;
  if seed is not null and seed<>'null'::jsonb and (seed->>'snapshotId' is distinct from p_snapshot_id::text
    or seed->>'contentHash' is distinct from a.bootstrap_context->>'contentHash'
    or seed->'coverage' is distinct from a.bootstrap_context->'coverage') then
    raise exception 'seed receipt mismatch' using errcode='23514';
  end if;
  update public.chat_turn_attempts set open_receipt=p_open_receipt where snapshot_id=p_snapshot_id;
  update public.chat_native_bindings set native_id=p_open_receipt->'native'->>'nativeId',
    seed_transport=seed->>'transport',seed_ack_digest=case when seed->>'acknowledgement' in ('protocol_echo','turn_accepted')
      then seed->>'contentHash' else null end where chat_id=p_chat_id and generation=a.native_generation;
  update public.chats set runtime_phase='ready',runtime_state='live' where entity_id=p_chat_id;
  return jsonb_build_object('snapshotId',p_snapshot_id,'nativeRef',p_open_receipt->'native',
    'contextReady',seed->>'acknowledgement' in ('protocol_echo','turn_accepted'),
    'effectiveConfiguration',p_open_receipt->'execution');
end $$;
create function public.begin_chat_dispatch(p_chat_id uuid,p_fence jsonb,p_snapshot_id uuid,p_input_digest text)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare c public.chats; a public.chat_turn_attempts;
begin
  c:=internal.chat_lock_owned(p_chat_id,p_fence);
  select * into a from public.chat_turn_attempts where snapshot_id=p_snapshot_id;
  if c.active_execution_snapshot_id is distinct from p_snapshot_id or c.runtime_phase<>'ready'
    or a.phase<>'prepared' or a.input_digest is distinct from p_input_digest or a.open_receipt is null then
    raise exception 'chat dispatch barrier refused' using errcode='23514';
  end if;
  update public.chat_turn_attempts set phase='dispatching',dispatch_started_at=clock_timestamp()
    where snapshot_id=p_snapshot_id returning * into a;
  update public.chats set runtime_phase='dispatching' where entity_id=p_chat_id;
  return jsonb_build_object('snapshotId',p_snapshot_id,'phase',a.phase,'dispatchStartedAt',a.dispatch_started_at);
end $$;
create function public.record_chat_acceptance(p_chat_id uuid,p_fence jsonb,p_snapshot_id uuid,p_acceptance jsonb)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare c public.chats; a public.chat_turn_attempts; seed jsonb:=p_acceptance->'seed';
begin
  c:=internal.chat_lock_owned(p_chat_id,p_fence);
  select * into a from public.chat_turn_attempts where snapshot_id=p_snapshot_id;
  if c.active_execution_snapshot_id is distinct from p_snapshot_id or a.phase not in ('dispatching','accepted') then
    raise exception 'stale chat acceptance' using errcode='42501';
  end if;
  if seed is not null and seed<>'null'::jsonb and (seed->>'contentHash' is distinct from a.bootstrap_context->>'contentHash'
    or seed->>'snapshotId' is distinct from p_snapshot_id::text) then
    raise exception 'seed acknowledgement mismatch' using errcode='23514';
  end if;
  update public.chat_turn_attempts set phase='accepted',accepted_at=coalesce(accepted_at,clock_timestamp()),
    provider_turn_id=coalesce(p_acceptance->>'nativeTurnId',provider_turn_id) where snapshot_id=p_snapshot_id;
  if seed->>'acknowledgement' in ('protocol_echo','turn_accepted') then
    update public.chat_native_bindings set seed_ack_digest=seed->>'contentHash'
      where chat_id=p_chat_id and generation=a.native_generation;
  end if;
  update public.chats set runtime_phase='running' where entity_id=p_chat_id;
  return jsonb_build_object('snapshotId',p_snapshot_id,'phase','accepted');
end $$;

alter table public.chat_native_bindings add column binding_id uuid not null default internal.new_id() unique;
-- Every new capture advances the existing chat's monotonic read bound.
create function internal.chat_capture_part() returns trigger language plpgsql security definer
set search_path=public,internal,pg_temp as $$
declare target uuid;
begin
  select chat_id into target from public.chat_turns where agent_message_id=new.message_id;
  if target is not null then
    update public.chats set history_seq=history_seq+1 where entity_id=target returning history_seq into new.chat_capture_seq;
  end if;
  return new;
end $$;
create trigger chat_capture_part before insert on public.message_parts for each row execute function internal.chat_capture_part();

alter function public.append_chat_message_part(uuid,integer,text,jsonb) rename to chat_append_legacy_314;
alter function public.chat_append_legacy_314(uuid,integer,text,jsonb) set schema internal;
revoke all on function internal.chat_append_legacy_314(uuid,integer,text,jsonb) from public,tm8_app;
create function public.append_chat_message_part(p_message_id uuid,p_seq integer,p_kind text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
begin
  if exists(select 1 from public.chat_turns where agent_message_id=p_message_id and claimed_configuration is not null) then
    raise exception 'execution fence required' using errcode='42501';
  end if;
  perform internal.require_space_member((select c.space_id from public.chats c join public.chat_turns t on t.chat_id=c.entity_id where t.agent_message_id=p_message_id));
  return internal.chat_append_legacy_314(p_message_id,p_seq,p_kind,p_payload);
end $$;
create function public.append_chat_message_part(p_message_id uuid,p_seq integer,p_kind text,p_payload jsonb,
  p_fence jsonb,p_snapshot_id uuid,p_event_id text) returns jsonb language plpgsql security definer
set search_path=public,internal,pg_temp as $$
declare c public.chats; t public.chat_turns; stored public.message_parts; result jsonb;
begin
  select * into t from public.chat_turns where agent_message_id=p_message_id;
  c:=internal.chat_lock_owned(t.chat_id,p_fence);
  if t.execution_snapshot_id is distinct from p_snapshot_id or t.turn_id is distinct from (p_fence->>'turnId')::uuid
    or c.active_execution_snapshot_id is distinct from p_snapshot_id or c.runtime_phase not in ('dispatching','running')
    or coalesce(p_event_id,'')='' then raise exception 'stale chat output' using errcode='42501'; end if;
  select * into stored from public.message_parts where message_id=p_message_id
    and execution_snapshot_id=p_snapshot_id and normalized_event_id=p_event_id;
  if stored.message_id is not null then
    if stored.kind is distinct from p_kind or stored.payload is distinct from p_payload then
      raise exception 'normalized event replay mismatch' using errcode='23514';
    end if;
    return jsonb_build_object('seq',stored.seq,'kind',stored.kind,'payload',stored.payload,'createdAt',internal.w2_iso(stored.created_at));
  end if;
  result:=internal.chat_append_legacy_314(p_message_id,p_seq,p_kind,p_payload);
  update public.message_parts set execution_snapshot_id=p_snapshot_id,normalized_event_id=p_event_id
    where message_id=p_message_id and seq=p_seq;
  return result;
end $$;

alter function public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb) rename to chat_complete_legacy_314;
alter function public.chat_complete_legacy_314(uuid,text,text,jsonb,numeric,jsonb) set schema internal;
revoke all on function internal.chat_complete_legacy_314(uuid,text,text,jsonb,numeric,jsonb) from public,tm8_app;
create function public.complete_chat_turn(p_turn_id uuid,p_state text,p_body text,p_usage jsonb default null,
 p_total_cost_usd numeric default null,p_failure jsonb default null) returns void language plpgsql security definer
set search_path=public,internal,pg_temp as $$
begin
  if exists(select 1 from public.chat_turns where turn_id=p_turn_id and claimed_configuration is not null) then
    raise exception 'execution fence required' using errcode='42501';
  end if;
  perform internal.require_space_member((select c.space_id from public.chats c join public.chat_turns t on t.chat_id=c.entity_id where t.turn_id=p_turn_id));
  perform internal.chat_complete_legacy_314(p_turn_id,p_state,p_body,p_usage,p_total_cost_usd,p_failure);
end $$;
create function public.record_chat_terminal(p_chat_id uuid,p_fence jsonb,p_snapshot_id uuid,p_terminal jsonb)
returns void language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare c public.chats;
begin
  c:=internal.chat_lock_owned(p_chat_id,p_fence);
  if c.active_execution_snapshot_id is distinct from p_snapshot_id or c.runtime_phase not in ('dispatching','running')
    or p_terminal->>'outcome' not in ('completed','failed','interrupted','runtime_lost')
    or (p_terminal->>'outcome'='completed' and p_terminal->>'evidence'<>'provider_terminal') then
    raise exception 'invalid chat terminal proof' using errcode='23514';
  end if;
  update public.chat_turn_attempts set provider_terminal=p_terminal where snapshot_id=p_snapshot_id;
end $$;
create function public.complete_chat_turn(p_turn_id uuid,p_state text,p_body text,p_usage jsonb,p_total_cost_usd numeric,
  p_failure jsonb,p_fence jsonb,p_snapshot_id uuid,p_terminal jsonb,p_native_checkpoint jsonb)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare c public.chats; t public.chat_turns; a public.chat_turn_attempts; settled bigint; receipt jsonb;
begin
  select * into t from public.chat_turns where turn_id=p_turn_id;
  c:=internal.chat_lock_owned(t.chat_id,p_fence);
  select * into a from public.chat_turn_attempts where snapshot_id=p_snapshot_id;
  if c.active_execution_snapshot_id is distinct from p_snapshot_id or t.execution_snapshot_id is distinct from p_snapshot_id
    or p_turn_id is distinct from (p_fence->>'turnId')::uuid or a.phase not in ('prepared','dispatching','accepted')
    or (p_state='completed' and (p_terminal->>'outcome' is distinct from 'completed'
      or p_terminal->>'evidence' is distinct from 'provider_terminal')) then
    raise exception 'stale or unproved chat completion' using errcode='42501';
  end if;
  perform internal.chat_complete_legacy_314(p_turn_id,p_state,p_body,p_usage,p_total_cost_usd,p_failure);
  update public.chats set history_seq=history_seq+1,runtime_phase='closing',runtime_state='stopped'
    where entity_id=t.chat_id returning history_seq into settled;
  update public.chat_turns set settlement_history_seq=settled where turn_id=p_turn_id;
  update public.chat_turn_attempts set phase='settled',settled_at=clock_timestamp(),provider_terminal=p_terminal
    where snapshot_id=p_snapshot_id;
  -- Unknown native checkpoint => never invent resumability. Native scope is
  -- retained for audit but retired; the next real input seeds portable history.
  update public.chat_native_bindings set status='retired',native_checkpoint=p_native_checkpoint
    where chat_id=t.chat_id and generation=a.native_generation;
  update public.auth_sessions set revoked_at=now() where runtime_chat_id=t.chat_id
    and runtime_epoch=c.runtime_epoch and runtime_native_generation=a.native_generation and revoked_at is null;
  receipt:=jsonb_build_object('snapshotId',p_snapshot_id,'configRevision',a.config_revision,
    'runtimeEpoch',c.runtime_epoch,'nativeGeneration',a.native_generation,'mode','bootstrap',
    'priorCursor',a.bootstrap_context->'coverage','seedEnvelopeDigest',a.bootstrap_context->>'contentHash',
    'nativeResumable',false,'reason','native_checkpoint_unknown','omissions',a.bootstrap_context->'manifest');
  return jsonb_build_object('turnId',p_turn_id,'state',p_state,'terminalReason',p_terminal->>'outcome','continuityReceipt',receipt);
end $$;
create function public.release_chat_runtime(p_chat_id uuid,p_runtime_epoch bigint,p_lease_token text) returns void
language plpgsql security definer set search_path=public,internal,pg_temp as $$
begin
  perform internal.require_identity();
  update public.chats set runtime_phase='idle',runtime_lease_expires_at=null,runtime_lease_token_hash=null,
    active_execution_snapshot_id=null,runtime_state='stopped'
  where entity_id=p_chat_id and configured_by_identity_id=internal.identity_id()
    and internal.is_space_member(space_id) and runtime_epoch=p_runtime_epoch
    and runtime_lease_token_hash=encode(sha256(convert_to(p_lease_token,'UTF8')),'hex')
    and runtime_phase='closing';
end $$;
create function public.heartbeat_chat_runtime(p_chat_id uuid,p_fence jsonb) returns void
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare c public.chats;
begin
  c:=internal.chat_lock_owned(p_chat_id,p_fence);
  update public.chats set runtime_lease_expires_at=clock_timestamp()+interval '10 minutes' where entity_id=p_chat_id;
  update public.chat_turns set lease_expires_at=clock_timestamp()+interval '10 minutes' where turn_id=(p_fence->>'turnId')::uuid;
end $$;
create function public.recover_chat_attempt(p_chat_id uuid,p_turn_id uuid,p_expected_attempt integer,p_recovery_owner jsonb)
returns jsonb language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare c public.chats; t public.chat_turns; a public.chat_turn_attempts; disposition text; seq bigint; terminal jsonb;
begin
  perform internal.require_identity();
  select * into c from public.chats where entity_id=p_chat_id for update;
  if c.entity_id is null or c.configured_by_identity_id<>internal.identity_id() then
    raise exception 'chat not found' using errcode='P0002';
  end if;
  perform internal.require_space_member(c.space_id);
  select * into t from public.chat_turns where chat_id=p_chat_id and turn_id=p_turn_id for update;
  if t.state<>'running' or t.attempt_no is distinct from p_expected_attempt then
    return jsonb_build_object('disposition','wait_owner','turnId',p_turn_id);
  end if;
  -- Reboot may recover its own old boot; another node must wait for expiry.
  if c.runtime_lease_expires_at>clock_timestamp() and not(c.node_id=p_recovery_owner->>'nodeId'
    and c.runtime_owner_boot_id is distinct from p_recovery_owner->>'bootId') then
    return jsonb_build_object('disposition','wait_owner','turnId',p_turn_id);
  end if;
  select * into a from public.chat_turn_attempts where snapshot_id=t.execution_snapshot_id;
  if a.phase='prepared' or (a.snapshot_id is null and t.claimed_configuration is not null) then
    disposition:='retry_prepared';
    update public.chat_turns set state='queued',lease_expires_at=null,execution_snapshot_id=null where turn_id=p_turn_id;
    update public.chat_turn_attempts set phase='settled',settled_at=clock_timestamp(),
      provider_terminal='{"outcome":"not_sent","evidence":"durable_prepared"}'::jsonb where snapshot_id=a.snapshot_id;
  else
    terminal:=a.provider_terminal;
    disposition:=case when terminal->>'evidence'='provider_terminal' then 'finalized_terminal' else 'settled_unknown' end;
    perform internal.chat_complete_legacy_314(p_turn_id,
      case when disposition='finalized_terminal' and terminal->>'outcome'='completed' then 'completed' else 'error' end,
      coalesce(terminal->>'body','Runtime interrupted; delivery or effects may be unknown.'),
      terminal->'usage',null,case when disposition='settled_unknown' then
        '{"code":"delivery_unknown","message":"Runtime ended after possible dispatch; this input will not be replayed."}'::jsonb
        else terminal->'failure' end);
    update public.chats set history_seq=history_seq+1 where entity_id=p_chat_id returning history_seq into seq;
    update public.chat_turns set settlement_history_seq=seq where turn_id=p_turn_id;
    update public.chat_turn_attempts set phase=case when disposition='settled_unknown' then 'delivery_unknown' else 'settled' end,
      settled_at=clock_timestamp() where snapshot_id=a.snapshot_id;
  end if;
  update public.chat_native_bindings set status='retired' where chat_id=p_chat_id and runtime_epoch=c.runtime_epoch
    and status in ('reserved','prepared','ready');
  update public.auth_sessions set revoked_at=now() where runtime_chat_id=p_chat_id and revoked_at is null;
  update public.chats set runtime_epoch=runtime_epoch+1,runtime_phase='idle',runtime_state='stopped',
    runtime_lease_token_hash=null,runtime_lease_expires_at=null,active_execution_snapshot_id=null where entity_id=p_chat_id;
  return jsonb_build_object('disposition',disposition,'turnId',p_turn_id,'nextEligibleTurnOrdinal',
    case when disposition='retry_prepared' then t.turn_ordinal else t.turn_ordinal+1 end);
end $$;

-- Narrow, chat-specific authority proof. Holding a SHARE lock until the effect
-- commits serializes graph effects with a competing generation replacement.
create function internal.assert_chat_runtime_authority() returns void language plpgsql volatile
security definer set search_path=public,internal,pg_temp as $$
declare s public.auth_sessions; c public.chats; a public.chat_turn_attempts; identity text:=internal.claim_text('tm8.identity_id');
begin
  select x.* into s from public.auth_sessions x join public.accounts account on account.id=x.account_id
    where x.id=nullif(internal.claim_text('tm8.auth_session_id'),'')::uuid and x.kind='agent_runtime'
      and x.revoked_at is null and x.expires_at>clock_timestamp() and account.status='active'
      and account.identity_id=identity;
  select * into c from public.chats where entity_id=s.runtime_chat_id for share;
  select * into a from public.chat_turn_attempts where snapshot_id=c.active_execution_snapshot_id;
  if s.id is null or c.entity_id is null or s.runtime_epoch is distinct from c.runtime_epoch
    or s.runtime_native_generation is distinct from a.native_generation or a.runtime_epoch is distinct from c.runtime_epoch
    or c.runtime_lease_expires_at is null or c.runtime_lease_expires_at<=clock_timestamp()
    or not exists(select 1 from public.members m where m.entity_id=s.runtime_member_id and m.identity_id=identity and m.space_id=c.space_id and m.status='active')
    or c.runtime_phase not in ('dispatching','running') or a.phase not in ('dispatching','accepted')
    or (internal.session_space_id() is not null and c.space_id<>internal.session_space_id()) then
    raise exception 'runtime authority is no longer current' using errcode='42501';
  end if;
end $$;
revoke all on function internal.assert_chat_runtime_authority() from public;
-- Gate the primitive as well as require_identity: a mutation whose authority
-- path uses identity_id directly cannot bypass the runtime proof. Human paths
-- retain their immutable identity claim and incur no runtime row reads.
create or replace function internal.identity_id() returns text language plpgsql volatile
set search_path=public,internal,pg_temp as $$
begin
  if internal.claim_text('tm8.auth_kind')='agent_runtime' then
    perform internal.assert_chat_runtime_authority();
  end if;
  return internal.claim_text('tm8.identity_id');
end $$;
-- Only this wrapper may invoke the private guard with definer privileges.
alter function internal.identity_id() security definer;

alter function public.issue_agent_runtime_session(uuid,uuid,text,timestamptz,text) rename to chat_mint_legacy_314;
alter function public.chat_mint_legacy_314(uuid,uuid,text,timestamptz,text) set schema internal;
revoke all on function internal.chat_mint_legacy_314(uuid,uuid,text,timestamptz,text) from public,tm8_app;
create function public.issue_agent_runtime_session(p_chat_id uuid,p_team_member_id uuid,p_token_hash text,
 p_expires_at timestamptz,p_label text default null) returns jsonb language plpgsql security definer
set search_path=public,internal,pg_temp as $$
begin
  perform internal.require_identity();
  if exists(select 1 from public.chats where entity_id=p_chat_id and runtime_epoch>0) then
    raise exception 'generation runtime grant required' using errcode='42501';
  end if;
  return internal.chat_mint_legacy_314(p_chat_id,p_team_member_id,p_token_hash,p_expires_at,p_label);
end $$;
create function public.issue_agent_runtime_session(p_chat_id uuid,p_team_member_id uuid,p_token_hash text,
 p_expires_at timestamptz,p_label text,p_fence jsonb) returns jsonb language plpgsql security definer
set search_path=public,internal,pg_temp as $$
declare c public.chats; a public.chat_turn_attempts; b public.chat_native_bindings; result jsonb;
begin
  perform internal.require_identity(); perform internal.require_human_auth_kind();
  select * into c from public.chats where entity_id=p_chat_id for update;
  if c.entity_id is null then
    raise exception 'chat not found' using errcode='P0002';
  end if;
  perform internal.require_space_member(c.space_id);
  select * into a from public.chat_turn_attempts where snapshot_id=c.active_execution_snapshot_id;
  select * into b from public.chat_native_bindings where chat_id=p_chat_id and generation=a.native_generation;
  if a.configuration_snapshot->'authority'->>'identityId' is distinct from internal.identity_id()
    or a.configuration_snapshot->'authority'->>'authKind' is distinct from internal.claim_text('tm8.auth_kind')
    or ((a.configuration_snapshot->'authority'->>'authSessionId') is not null and not exists(
      select 1 from public.auth_sessions session join public.accounts account on account.id=session.account_id
      where session.id=(a.configuration_snapshot->'authority'->>'authSessionId')::uuid
        and session.id=nullif(internal.claim_text('tm8.auth_session_id'),'')::uuid
        and session.revoked_at is null and session.expires_at>clock_timestamp()
        and account.status='active' and account.identity_id=internal.identity_id()))
    or p_fence->>'chatId' is distinct from p_chat_id::text or p_team_member_id is distinct from c.teammate_id
    or c.runtime_epoch is distinct from (p_fence->>'leaseEpoch')::bigint
    or b.generation is distinct from (p_fence->>'generation')::bigint
    or b.binding_id::text is distinct from p_fence->>'bindingId'
    or a.config_revision is distinct from (p_fence->>'configRevision')::bigint
    or a.runtime_epoch is distinct from c.runtime_epoch or b.runtime_epoch is distinct from c.runtime_epoch
    or a.snapshot_id is null or a.phase<>'prepared' or c.runtime_phase<>'prepared'
    or c.runtime_lease_expires_at is null or c.runtime_lease_expires_at<=clock_timestamp() then
    raise exception 'stale runtime grant mint' using errcode='42501';
  end if;
  result:=internal.chat_mint_legacy_314(p_chat_id,p_team_member_id,p_token_hash,p_expires_at,p_label);
  update public.auth_sessions set runtime_epoch=c.runtime_epoch,runtime_native_generation=b.generation
    where id=(result->>'id')::uuid returning to_jsonb(auth_sessions)-'token_hash' into result;
  return result;
end $$;
alter function public.revoke_agent_runtime_session(uuid) rename to chat_revoke_legacy_314;
alter function public.chat_revoke_legacy_314(uuid) set schema internal;
revoke all on function internal.chat_revoke_legacy_314(uuid) from public,tm8_app;
create function public.revoke_agent_runtime_session(p_chat_id uuid) returns void language plpgsql security definer
set search_path=public,internal,pg_temp as $$
begin
  perform internal.require_identity();
  if exists(select 1 from public.chats where entity_id=p_chat_id and runtime_epoch>0) then
    raise exception 'generation runtime revoke required' using errcode='42501';
  end if;
  perform internal.chat_revoke_legacy_314(p_chat_id);
end $$;
create function public.revoke_agent_runtime_session(p_chat_id uuid,p_expected_epoch bigint,p_expected_generation bigint,p_session_id uuid)
returns void language plpgsql security definer set search_path=public,internal,pg_temp as $$
begin
  perform internal.require_identity(); perform internal.require_human_auth_kind();
  if not exists(select 1 from public.chats c where c.entity_id=p_chat_id and c.configured_by_identity_id=internal.identity_id()
    and internal.is_space_member(c.space_id)) and not exists(select 1 from public.auth_sessions s join public.accounts account on account.id=s.account_id
      join public.chats c on c.entity_id=s.runtime_chat_id where s.id=p_session_id and c.entity_id=p_chat_id
        and account.identity_id=internal.identity_id() and internal.is_space_member(c.space_id)) then raise exception 'chat not found' using errcode='P0002'; end if;
  update public.auth_sessions set revoked_at=now() where id=p_session_id and runtime_chat_id=p_chat_id
    and runtime_epoch=p_expected_epoch and runtime_native_generation=p_expected_generation and revoked_at is null;
end $$;
create or replace function public.resolve_auth_session(p_token_hash text) returns jsonb language sql stable
security definer set search_path=public,internal,pg_temp as $$
  select jsonb_build_object('sessionId',s.id,'accountId',a.id,'identityId',a.identity_id,
    'username',a.username,'displayName',a.display_name,'isNodeAdmin',a.is_node_admin,'isOwner',a.is_owner,
    'kind',s.kind,'actingAsTeamMemberId',s.acting_as_team_member_id,'workSessionId',s.work_session_id,
    'runtimeMemberId',s.runtime_member_id,'runtimeThreadRootId',s.runtime_thread_root_id,'runtimeChatId',s.runtime_chat_id,
    'runtimeEpoch',s.runtime_epoch,'runtimeNativeGeneration',s.runtime_native_generation,
    'spaceId',s.space_id,'viaLinkId',s.via_link_id,'expiresAt',s.expires_at,'label',s.label)
  from public.auth_sessions s join public.accounts a on a.id=s.account_id
  where s.token_hash=p_token_hash and s.revoked_at is null and s.expires_at>now() and a.status='active'
    and (s.kind<>'agent_runtime' or exists(select 1 from public.chats c
      join public.chat_turn_attempts t on t.snapshot_id=c.active_execution_snapshot_id
      where c.entity_id=s.runtime_chat_id and c.runtime_epoch=s.runtime_epoch
        and t.native_generation=s.runtime_native_generation and t.runtime_epoch=c.runtime_epoch
        and c.runtime_lease_expires_at>now() and c.runtime_phase in ('prepared','ready','dispatching','running')
        and t.phase in ('prepared','dispatching','accepted')));
$$;

-- Grant the bounded, guarded entry points, not their compatibility internals.

revoke all on function public.set_chat_configuration(uuid,bigint,jsonb,text) from public;
grant execute on function public.set_chat_configuration(uuid,bigint,jsonb,text) to tm8_app;
revoke all on function public.claim_next_chat_turn(uuid) from public;
grant execute on function public.claim_next_chat_turn(uuid) to tm8_app;
revoke all on function public.claim_next_chat_turn(uuid,integer,jsonb) from public;
grant execute on function public.claim_next_chat_turn(uuid,integer,jsonb) to tm8_app;
revoke all on function public.reserve_chat_continuity(uuid,jsonb,jsonb) from public;
grant execute on function public.reserve_chat_continuity(uuid,jsonb,jsonb) to tm8_app;
revoke all on function public.seal_chat_turn_snapshot(uuid,jsonb,uuid,jsonb,jsonb) from public;
grant execute on function public.seal_chat_turn_snapshot(uuid,jsonb,uuid,jsonb,jsonb) to tm8_app;
revoke all on function public.record_chat_open(uuid,jsonb,uuid,jsonb) from public;
grant execute on function public.record_chat_open(uuid,jsonb,uuid,jsonb) to tm8_app;
revoke all on function public.begin_chat_dispatch(uuid,jsonb,uuid,text) from public;
grant execute on function public.begin_chat_dispatch(uuid,jsonb,uuid,text) to tm8_app;
revoke all on function public.record_chat_acceptance(uuid,jsonb,uuid,jsonb) from public;
grant execute on function public.record_chat_acceptance(uuid,jsonb,uuid,jsonb) to tm8_app;
revoke all on function public.append_chat_message_part(uuid,integer,text,jsonb) from public;
grant execute on function public.append_chat_message_part(uuid,integer,text,jsonb) to tm8_app;
revoke all on function public.append_chat_message_part(uuid,integer,text,jsonb,jsonb,uuid,text) from public;
grant execute on function public.append_chat_message_part(uuid,integer,text,jsonb,jsonb,uuid,text) to tm8_app;
revoke all on function public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb) from public;
grant execute on function public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb) to tm8_app;
revoke all on function public.record_chat_terminal(uuid,jsonb,uuid,jsonb) from public;
grant execute on function public.record_chat_terminal(uuid,jsonb,uuid,jsonb) to tm8_app;
revoke all on function public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb,jsonb,uuid,jsonb,jsonb) from public;
grant execute on function public.complete_chat_turn(uuid,text,text,jsonb,numeric,jsonb,jsonb,uuid,jsonb,jsonb) to tm8_app;
revoke all on function public.release_chat_runtime(uuid,bigint,text) from public;
grant execute on function public.release_chat_runtime(uuid,bigint,text) to tm8_app;
revoke all on function public.heartbeat_chat_runtime(uuid,jsonb) from public;
grant execute on function public.heartbeat_chat_runtime(uuid,jsonb) to tm8_app;
revoke all on function public.recover_chat_attempt(uuid,uuid,integer,jsonb) from public;
grant execute on function public.recover_chat_attempt(uuid,uuid,integer,jsonb) to tm8_app;
revoke all on function public.issue_agent_runtime_session(uuid,uuid,text,timestamptz,text) from public;
grant execute on function public.issue_agent_runtime_session(uuid,uuid,text,timestamptz,text) to tm8_app;
revoke all on function public.issue_agent_runtime_session(uuid,uuid,text,timestamptz,text,jsonb) from public;
grant execute on function public.issue_agent_runtime_session(uuid,uuid,text,timestamptz,text,jsonb) to tm8_app;
revoke all on function public.revoke_agent_runtime_session(uuid) from public;
grant execute on function public.revoke_agent_runtime_session(uuid) to tm8_app;
revoke all on function public.revoke_agent_runtime_session(uuid,bigint,bigint,uuid) from public;
grant execute on function public.revoke_agent_runtime_session(uuid,bigint,bigint,uuid) to tm8_app;
revoke all on function public.resolve_auth_session(text) from public;
grant execute on function public.resolve_auth_session(text) to tm8_app;

create function public.fail_chat_preparation(p_chat_id uuid,p_fence jsonb,p_failure jsonb) returns void
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare c public.chats; t public.chat_turns; seq bigint;
begin
  c:=internal.chat_lock_owned(p_chat_id,p_fence);
  if c.runtime_phase not in ('preparing','opening','prepared','ready') then
    raise exception 'preparation failure cannot settle possible dispatch' using errcode='42501';
  end if;
  select * into t from public.chat_turns where turn_id=(p_fence->>'turnId')::uuid;
  perform internal.chat_complete_legacy_314(t.turn_id,'error',p_failure->>'message',null,null,p_failure);
  update public.chat_turn_attempts set phase='settled',settled_at=clock_timestamp(),
    provider_terminal='{"outcome":"not_sent","evidence":"preparation_failure"}' where snapshot_id=t.execution_snapshot_id;
  update public.chats set history_seq=history_seq+1,runtime_phase='closing',runtime_state='stopped'
    where entity_id=p_chat_id returning history_seq into seq;
  update public.chat_turns set settlement_history_seq=seq where turn_id=t.turn_id;
  update public.chat_native_bindings set status='retired' where chat_id=p_chat_id and runtime_epoch=c.runtime_epoch;
  update public.auth_sessions set revoked_at=now() where runtime_chat_id=p_chat_id and runtime_epoch=c.runtime_epoch and revoked_at is null;
end $$;
revoke all on function public.fail_chat_preparation(uuid,jsonb,jsonb) from public;
grant execute on function public.fail_chat_preparation(uuid,jsonb,jsonb) to tm8_app;

reset role;
