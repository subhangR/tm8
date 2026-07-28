-- =============================================================================
-- 022 — W2.G07 authorized file slots, atomic graph finalization, and raw-PUT
--       transport state.
--
-- Bytes remain outside Postgres at <dataDir>/blobs/<storage_path>. This file
-- stores only immutable metadata and the small lease/staging facts required to
-- make a bounded raw PUT verifiable before the existing file entity is born.
-- tm8_app keeps SELECT-only table access; these five SECURITY DEFINER functions
-- are the complete file write surface.
-- =============================================================================
set role tm8_graph_owner;

alter table public.file_upload_slots
  add column actor_id uuid references public.entities(id) on delete restrict,
  add column max_size_bytes bigint,
  add column request_hash text,
  add column staged_size_bytes bigint,
  add column staged_checksum_sha256 text,
  add column staged_at timestamptz,
  add column upload_lease_id uuid,
  add column upload_lease_at timestamptz,
  add column completion_targets uuid[] not null default '{}'::uuid[];

update public.file_upload_slots
  set actor_id = created_by,
       max_size_bytes = greatest(size_bytes,536870912),
       request_hash = encode(sha256(convert_to(
         id::text || ':' || space_id::text || ':' || storage_path,
         'UTF8'
       )), 'hex')
 where actor_id is null;

alter table public.file_upload_slots
  alter column actor_id set not null,
  alter column max_size_bytes set not null,
  alter column request_hash set not null,
  add constraint file_upload_slots_max_size_check
    check (max_size_bytes >= 1 and size_bytes <= max_size_bytes),
  add constraint file_upload_slots_request_hash_check
    check (request_hash ~ '^[a-f0-9]{64}$'),
  add constraint file_upload_slots_staged_shape_check check (
    (staged_size_bytes is null and staged_checksum_sha256 is null and staged_at is null)
    or
    (staged_size_bytes is not null and staged_size_bytes >= 0
      and staged_checksum_sha256 ~ '^[a-f0-9]{64}$' and staged_at is not null)
  ),
  add constraint file_upload_slots_lease_shape_check check (
    (upload_lease_id is null) = (upload_lease_at is null)
  ),
  add constraint file_upload_slots_completion_targets_check
    check (cardinality(completion_targets) <= 16);

create or replace function internal.w2_validate_file_upload_slot() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare actor public.entities; anchor public.entities;
begin
  select * into actor from public.entities where id=new.actor_id;
  if actor.id is null or actor.space_id <> new.space_id
     or actor.kind not in ('member','team_member') then
    raise exception 'file upload actor must be a same-Space Member or Teammate'
      using errcode='23514';
  end if;
  if new.anchor_entity_id is not null then
    select * into anchor from public.entities where id=new.anchor_entity_id;
    if anchor.id is null or anchor.space_id <> new.space_id then
      raise exception 'file upload anchor must belong to the upload Space'
        using errcode='23514';
    end if;
  end if;
  if cardinality(new.completion_targets) <>
     (select count(distinct value)::integer from unnest(new.completion_targets) value) then
    raise exception 'file completion targets must be unique' using errcode='23514';
  end if;
  return new;
end
$$;
create trigger file_upload_slots_w2_validate
before insert or update of space_id,actor_id,anchor_entity_id,completion_targets
on public.file_upload_slots
for each row execute function internal.w2_validate_file_upload_slot();

create or replace function internal.w2_file_slot_for_identity(
  p_upload_id uuid,
  p_token_hash text default null
) returns public.file_upload_slots
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare slot public.file_upload_slots; current_member uuid;
begin
  select * into slot from public.file_upload_slots where id=p_upload_id for update;
  if slot.id is null then
    raise exception 'file upload slot not found' using errcode='P0002';
  end if;
  perform internal.require_space_member(slot.space_id);
  current_member := internal.current_member_id(slot.space_id);
  if current_member is distinct from slot.created_by then
    raise exception 'file upload slot belongs to another identity' using errcode='42501';
  end if;
  if p_token_hash is not null and
     (p_token_hash !~ '^[a-f0-9]{64}$' or slot.token_hash is distinct from p_token_hash) then
    raise exception 'invalid file upload grant' using errcode='42501';
  end if;
  return slot;
end
$$;

create or replace function internal.w2_file_transport_result(
  slot public.file_upload_slots,
  outcome text
) returns jsonb
language sql stable set search_path=public,internal,pg_temp as $$
  select jsonb_build_object(
    'outcome', outcome,
    'uploadId', slot.id,
    'spaceId', slot.space_id,
    'storagePath', slot.storage_path,
    'sizeBytes', slot.size_bytes,
    'checksumSha256', slot.checksum_sha256
  )
$$;

create or replace function public.w2_init_file_upload(
  p_upload_id uuid,
  p_space_id uuid,
  p_actor_id uuid,
  p_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_checksum_sha256 text,
  p_storage_blob_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_anchor_entity_id uuid,
  p_max_size_bytes bigint,
  p_client_mutation_id text,
  p_request_hash text
) returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare
  replay jsonb;
  slot public.file_upload_slots;
  actor uuid;
  creator uuid;
  anchor public.entities;
  result jsonb;
begin
  if p_upload_id is null or p_storage_blob_id is null then
    raise exception 'upload and storage ids are required' using errcode='22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 500 then
    raise exception 'file name must contain 1..500 characters' using errcode='22023';
  end if;
  if p_mime_type is null or char_length(p_mime_type) not between 1 and 255 then
    raise exception 'file MIME type must contain 1..255 characters' using errcode='22023';
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 then
    raise exception 'file size must be positive' using errcode='22023';
  end if;
  if p_max_size_bytes is null or p_max_size_bytes < 1
     or p_size_bytes > p_max_size_bytes then
    raise exception 'file exceeds the effective upload limit' using errcode='54000';
  end if;
  if p_checksum_sha256 !~ '^[a-f0-9]{64}$'
     or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid checksum, token hash, or request hash' using errcode='22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'upload grant expiry must be in the future' using errcode='22023';
  end if;

  if p_client_mutation_id is not null and btrim(p_client_mutation_id) <> '' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_client_mutation_id, 0)
    );
  end if;

  replay := internal.ledger_replay(p_client_mutation_id, 'files.uploadInit');
  if replay is not null then
    select * into slot from public.file_upload_slots
     where id=(replay->>'uploadId')::uuid for update;
    if slot.id is null then
      raise exception 'replayed file upload slot is missing' using errcode='P0002';
    end if;
    perform internal.require_space_member(slot.space_id);
    if internal.current_member_id(slot.space_id) is distinct from slot.created_by then
      raise exception 'file upload replay belongs to another identity' using errcode='42501';
    end if;
    if slot.request_hash <> p_request_hash then
      raise exception 'file upload mutation id was reused with different input'
        using errcode='23514';
    end if;
    return replay;
  end if;

  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  creator := internal.current_member_id(p_space_id);
  if p_anchor_entity_id is not null then
    select * into anchor from public.entities where id=p_anchor_entity_id;
    if anchor.id is null or anchor.deleted_at is not null
       or anchor.space_id <> p_space_id or not internal.entity_readable(anchor.id) then
      raise exception 'file upload anchor not found' using errcode='P0002';
    end if;
  end if;

  insert into public.file_upload_slots(
    id,space_id,created_by,actor_id,name,mime_type,size_bytes,
    checksum_sha256,storage_path,anchor_entity_id,token_hash,status,
    expires_at,max_size_bytes,request_hash
  ) values (
    p_upload_id,p_space_id,creator,actor,p_name,p_mime_type,p_size_bytes,
    p_checksum_sha256,format('spaces/%s/%s',p_space_id,p_storage_blob_id),
    p_anchor_entity_id,p_token_hash,'pending',p_expires_at,p_max_size_bytes,p_request_hash
  ) returning * into slot;

  result := jsonb_build_object(
    'uploadId',slot.id,
    'storagePath',slot.storage_path,
    'expiresAt',slot.expires_at,
    'maxSizeBytes',slot.max_size_bytes,
    'requestHash',slot.request_hash
  );
  return internal.ledger_record(p_client_mutation_id,'files.uploadInit',result);
end
$$;

create or replace function public.w2_authorize_file_upload(
  p_upload_id uuid,
  p_token_hash text,
  p_lease_id uuid
) returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare slot public.file_upload_slots;
begin
  if p_lease_id is null then
    raise exception 'upload lease id is required' using errcode='22023';
  end if;
  slot := internal.w2_file_slot_for_identity(p_upload_id,p_token_hash);
  if slot.status='pending' and slot.expires_at <= now() then
    update public.file_upload_slots
       set status='expired',upload_lease_id=null,upload_lease_at=null
     where id=slot.id returning * into slot;
    return internal.w2_file_transport_result(slot,'expired');
  end if;
  if slot.status <> 'pending' then
    return internal.w2_file_transport_result(slot,slot.status);
  end if;
  if slot.staged_at is not null then
    return internal.w2_file_transport_result(slot,'staged');
  end if;
  if slot.upload_lease_id is not null and slot.upload_lease_at > now()-interval '5 minutes' then
    raise exception 'file upload already has an active writer' using errcode='23514';
  end if;
  update public.file_upload_slots
     set upload_lease_id=p_lease_id,upload_lease_at=now()
   where id=slot.id returning * into slot;
  return internal.w2_file_transport_result(slot,'authorized');
end
$$;

create or replace function public.w2_settle_file_upload_write(
  p_upload_id uuid,
  p_token_hash text,
  p_lease_id uuid,
  p_success boolean,
  p_actual_size_bytes bigint,
  p_actual_checksum_sha256 text
) returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare slot public.file_upload_slots;
begin
  slot := internal.w2_file_slot_for_identity(p_upload_id,p_token_hash);
  if slot.status='pending' and slot.expires_at <= now() then
    update public.file_upload_slots
       set status='expired',upload_lease_id=null,upload_lease_at=null
     where id=slot.id returning * into slot;
    return internal.w2_file_transport_result(slot,'expired');
  end if;
  if slot.status <> 'pending' then
    return internal.w2_file_transport_result(slot,slot.status);
  end if;
  if slot.upload_lease_id is distinct from p_lease_id then
    raise exception 'file upload writer does not own the active lease' using errcode='42501';
  end if;
  if not coalesce(p_success,false) then
    update public.file_upload_slots
       set upload_lease_id=null,upload_lease_at=null
     where id=slot.id returning * into slot;
    return internal.w2_file_transport_result(slot,'pending');
  end if;
  if p_actual_size_bytes is distinct from slot.size_bytes
     or p_actual_checksum_sha256 is distinct from slot.checksum_sha256 then
    raise exception 'staged bytes do not match the frozen declaration' using errcode='23514';
  end if;
  update public.file_upload_slots
     set staged_size_bytes=p_actual_size_bytes,
         staged_checksum_sha256=p_actual_checksum_sha256,
         staged_at=now(),upload_lease_id=null,upload_lease_at=null
   where id=slot.id returning * into slot;
  return internal.w2_file_transport_result(slot,'staged');
end
$$;

create or replace function public.w2_complete_file_upload(
  p_upload_id uuid,
  p_actual_size_bytes bigint,
  p_actual_checksum_sha256 text,
  p_client_mutation_id text,
  p_targets uuid[]
) returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare
  slot public.file_upload_slots;
  replay jsonb;
  requested_targets uuid[];
  target uuid;
  target_entity public.entities;
  file_id uuid;
  activity_id uuid;
  result jsonb;
begin
  if p_client_mutation_id is not null and btrim(p_client_mutation_id) <> '' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_client_mutation_id, 0)
    );
  end if;
  slot := internal.w2_file_slot_for_identity(p_upload_id,null);
  if slot.status='pending' and slot.expires_at <= now() then
    update public.file_upload_slots
       set status='expired',upload_lease_id=null,upload_lease_at=null
     where id=slot.id returning * into slot;
    return internal.w2_file_transport_result(slot,'expired');
  end if;

  if cardinality(coalesce(p_targets,'{}'::uuid[])) > 16 or
     cardinality(coalesce(p_targets,'{}'::uuid[])) <>
       (select count(distinct value)::integer from unnest(coalesce(p_targets,'{}'::uuid[])) value) then
    raise exception 'file completion targets must contain 0..16 unique ids'
      using errcode='22023';
  end if;
  select coalesce(array_agg(value order by value),'{}'::uuid[])
    into requested_targets
    from (
      select distinct value
        from unnest(
          coalesce(p_targets,'{}'::uuid[]) ||
          case when slot.anchor_entity_id is null then '{}'::uuid[]
               else array[slot.anchor_entity_id] end
        ) value
    ) requested;
  if cardinality(requested_targets) > 16 then
    raise exception 'legacy anchor plus targets exceeds the 16 attachment limit'
      using errcode='53400';
  end if;

  if slot.status in ('aborted','expired') then
    return internal.w2_file_transport_result(slot,slot.status);
  end if;

  replay := internal.ledger_replay(p_client_mutation_id,'files.uploadComplete');
  if replay is not null then
    if replay->>'uploadId' is distinct from slot.id::text then
      raise exception 'file completion mutation id belongs to another upload'
        using errcode='23514';
    end if;
    if requested_targets is distinct from slot.completion_targets then
      raise exception 'file completion mutation id was reused with different targets'
        using errcode='23514';
    end if;
    return replay;
  end if;

  if slot.status='completed' then
    if requested_targets is distinct from slot.completion_targets then
      raise exception 'a completed upload has a frozen attachment set'
        using errcode='23514';
    end if;
    result := internal.command_result(
      slot.file_entity_id,null,null,array[slot.file_entity_id] || slot.completion_targets
    ) || internal.w2_file_transport_result(slot,'completed');
    return internal.ledger_record(p_client_mutation_id,'files.uploadComplete',result);
  end if;

  if slot.upload_lease_id is not null or slot.staged_at is null
     or slot.staged_size_bytes is distinct from slot.size_bytes
     or slot.staged_checksum_sha256 is distinct from slot.checksum_sha256
     or p_actual_size_bytes is distinct from slot.size_bytes
     or p_actual_checksum_sha256 is distinct from slot.checksum_sha256 then
    raise exception 'uploaded bytes are incomplete or do not match the frozen declaration'
      using errcode='23514';
  end if;

  perform 1 from public.entities
   where id=any(requested_targets) order by id for update;
  foreach target in array requested_targets loop
    select * into target_entity from public.entities where id=target;
    if target_entity.id is null or target_entity.deleted_at is not null
       or not internal.entity_readable(target) then
      raise exception 'file attachment target not found' using errcode='P0002';
    end if;
    if target_entity.space_id <> slot.space_id then
      raise exception 'file attachment targets must share the upload Space'
        using errcode='23514';
    end if;
  end loop;

  perform internal.bind_actor(slot.actor_id);
  file_id := internal.create_envelope(slot.space_id,'file',slot.actor_id,null,null);
  insert into public.files(
    entity_id,name,mime_type,size_bytes,storage_path,checksum_sha256
  ) values (
    file_id,slot.name,slot.mime_type,slot.size_bytes,slot.storage_path,slot.checksum_sha256
  );
  perform internal.record_initial_version(file_id,slot.actor_id);

  perform internal.w1_set_writer('message_attachment');
  foreach target in array requested_targets loop
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
    values (slot.space_id,file_id,target,'attached_to',slot.actor_id);
  end loop;
  perform internal.w1_set_writer('');

  activity_id := internal.record_activity(
    slot.space_id,file_id,slot.actor_id,'created',null,jsonb_build_object('kind','file')
  );
  update public.file_upload_slots
     set status='completed',file_entity_id=file_id,completed_at=now(),
         completion_targets=requested_targets,upload_lease_id=null,upload_lease_at=null
   where id=slot.id returning * into slot;

  result := internal.command_result(
    file_id,null,activity_id,array[file_id] || requested_targets
  ) || internal.w2_file_transport_result(slot,'completed');
  return internal.ledger_record(p_client_mutation_id,'files.uploadComplete',result);
end
$$;

create or replace function public.w2_abort_file_upload(
  p_upload_id uuid,
  p_client_mutation_id text
) returns jsonb
language plpgsql security definer set search_path=public,internal,pg_temp as $$
declare slot public.file_upload_slots; replay jsonb; result jsonb;
begin
  if p_client_mutation_id is not null and btrim(p_client_mutation_id) <> '' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_client_mutation_id, 0)
    );
  end if;
  slot := internal.w2_file_slot_for_identity(p_upload_id,null);
  if slot.status='pending' and slot.expires_at <= now() then
    update public.file_upload_slots
       set status='expired',upload_lease_id=null,upload_lease_at=null
     where id=slot.id returning * into slot;
  end if;

  replay := internal.ledger_replay(p_client_mutation_id,'files.uploadAbort');
  if replay is not null then
    if replay->>'uploadId' is distinct from slot.id::text then
      raise exception 'file abort mutation id belongs to another upload'
        using errcode='23514';
    end if;
    return replay;
  end if;

  if slot.status='pending' then
    update public.file_upload_slots
       set status='aborted',upload_lease_id=null,upload_lease_at=null
     where id=slot.id returning * into slot;
  end if;
  result := internal.w2_file_transport_result(slot,slot.status);
  return internal.ledger_record(p_client_mutation_id,'files.uploadAbort',result);
end
$$;

-- Internal helpers are implementation details, not an alternate callable
-- surface. Public SECURITY DEFINER RPCs invoke them as tm8_graph_owner.
revoke all on function
  internal.w2_validate_file_upload_slot(),
  internal.w2_file_slot_for_identity(uuid,text),
  internal.w2_file_transport_result(public.file_upload_slots,text)
from public;

revoke all on function
  public.w2_init_file_upload(uuid,uuid,uuid,text,text,bigint,text,uuid,text,timestamptz,uuid,bigint,text,text),
  public.w2_authorize_file_upload(uuid,text,uuid),
  public.w2_settle_file_upload_write(uuid,text,uuid,boolean,bigint,text),
  public.w2_complete_file_upload(uuid,bigint,text,text,uuid[]),
  public.w2_abort_file_upload(uuid,text)
from public;

grant execute on function
  public.w2_init_file_upload(uuid,uuid,uuid,text,text,bigint,text,uuid,text,timestamptz,uuid,bigint,text,text),
  public.w2_authorize_file_upload(uuid,text,uuid),
  public.w2_settle_file_upload_write(uuid,text,uuid,boolean,bigint,text),
  public.w2_complete_file_upload(uuid,bigint,text,text,uuid[]),
  public.w2_abort_file_upload(uuid,text)
to tm8_app;

reset role;
