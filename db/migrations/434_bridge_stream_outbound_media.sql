-- Outbound media uses an authenticated HTTP stream, not a base64 WS frame.
set local lock_timeout = '5s';
set role tm8_graph_owner;

create index bridge_outbox_active_connection on public.bridge_outbox(connection_id) where status = 'dispatching';

create or replace function public.bridge_runtime_outbound_media(p_outbox uuid, p_connection uuid, p_file uuid) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  perform internal.bridge_runtime_session();
  select jsonb_build_object('storagePath', f.storage_path, 'spaceId', e.space_id)
    into result
    from public.bridge_outbox ob
    join public.bridges b on b.entity_id = ob.bridge_id
    join public.files f on f.entity_id = p_file
    join public.entities e on e.id = f.entity_id and e.deleted_at is null
   where ob.id = p_outbox and ob.connection_id = p_connection
     and ob.kind = 'send' and ob.status = 'dispatching'
     and ob.payload -> 'files' @> jsonb_build_array(jsonb_build_object('fileEntityId', p_file))
     and b.ended_at is null and b.paused_at is null
     and (b.muted_until is null or b.muted_until <= now())
     and b.policy ->> 'direction' <> 'in'
     and b.external_conversation_id = any(internal.bridge_allowlist_ids(p_connection));
  if result is null then
    raise exception 'attachment is not available for this dispatched outbox row' using errcode = '42501';
  end if;
  return result;
end
$$;
revoke all on function public.bridge_runtime_outbound_media(uuid, uuid, uuid) from public;
grant execute on function public.bridge_runtime_outbound_media(uuid, uuid, uuid) to tm8_app;

create or replace function public.bridge_runtime_outbound_progress(p_frame jsonb) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.bridge_runtime_session();
  update public.bridge_outbox set dispatched_at = now()
   where id = (p_frame ->> 'outboxId')::uuid
     and connection_id = (p_frame ->> 'connectionId')::uuid and status = 'dispatching';
  return jsonb_build_object('renewed', found);
end
$$;
revoke all on function public.bridge_runtime_outbound_progress(jsonb) from public;
grant execute on function public.bridge_runtime_outbound_progress(jsonb) to tm8_app;

create or replace function internal.bridge_outbox_take(p_runtime_ids text[], p_limit integer) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare r record; frames jsonb := '[]'::jsonb; reason text;
begin
  perform internal.require_bridges_worker();
  for r in
    select ob.*, c.runtime_id, c.status as conn_status, b.paused_at, b.ended_at, b.muted_until,
           b.policy ->> 'direction' as direction, b.external_conversation_id as conv
      from public.bridge_outbox ob
      join public.bridge_connections c on c.id = ob.connection_id
      join public.bridges b on b.entity_id = ob.bridge_id
     where (ob.status = 'pending' or (ob.status = 'failed_retryable' and coalesce(ob.next_attempt_at, now()) <= now()))
       and c.runtime_id = any(p_runtime_ids) and c.status = 'linked'
       and not exists (select 1 from public.bridge_outbox active
                       where active.connection_id = ob.connection_id and active.status = 'dispatching')
     order by ob.created_at
     limit greatest(least(p_limit, 100), 1)
     for update of ob skip locked
  loop
    -- Do not let queued frames expire behind a long media upload. One active
    -- send per connection; the runtime renews its lease until settlement.
    if exists (select 1 from public.bridge_outbox active
                where active.connection_id = r.connection_id and active.status = 'dispatching') then
      continue;
    end if;
    reason := case
      when r.ended_at is not null then 'bridge_ended'
      when r.paused_at is not null or r.muted_until > now() then 'bridge_paused'
      when r.direction = 'in' then 'direction_in'
      when not (r.conv = any(internal.bridge_allowlist_ids(r.connection_id))) then 'not_connected'
      -- 427: WhatsApp keeps one reaction per sender; a lower one sent now would replace a higher one.
      when r.kind = 'react' and internal.bridge_reaction_rank(r.reaction) < 100 and exists (
             select 1 from public.bridge_outbox x
              where x.message_id = r.message_id and x.kind = 'react' and x.id <> r.id
                and internal.bridge_reaction_rank(x.reaction) > internal.bridge_reaction_rank(r.reaction))
        then 'superseded' end;
    if reason is not null then
      update public.bridge_outbox set status = 'failed_permanent', settled_at = now(), last_error = reason where id = r.id;
      continue;
    end if;
    update public.bridge_outbox set status = 'dispatching', attempts = attempts + 1, dispatched_at = now() where id = r.id;
    frames := frames || jsonb_build_array(jsonb_build_object('runtimeId', r.runtime_id, 'frame',
      case r.kind
        when 'send' then jsonb_strip_nulls(jsonb_build_object('type', 'send', 'outboxId', r.id,
          'connectionId', r.connection_id, 'conversationId', r.conv, 'text', r.payload ->> 'text',
          'replyTo', r.payload -> 'replyTo',
          -- SERVER-ONLY metadata. The hub emits only a file entity reference;
          -- the authenticated HTTP door resolves the storage path when read.
          'files', (select jsonb_agg(jsonb_build_object('fileEntityId', f.entity_id, 'spaceId', e.space_id,
                        'storagePath', f.storage_path, 'name', f.name, 'mime', f.mime_type, 'size', f.size_bytes)
                        order by a.ord)
                      from jsonb_array_elements(r.payload -> 'files') with ordinality a(item, ord)
                      join public.files f on f.entity_id = (a.item ->> 'fileEntityId')::uuid
                      join public.entities e on e.id = f.entity_id and e.deleted_at is null)))
        else jsonb_build_object('type', 'react', 'outboxId', r.id, 'connectionId', r.connection_id,
          'conversationId', r.conv, 'target', r.payload -> 'target', 'emoji', r.payload ->> 'emoji') end));
  end loop;
  return frames;
end
$$;
revoke all on function internal.bridge_outbox_take(text[], integer) from public;
grant execute on function internal.bridge_outbox_take(text[], integer) to tm8_app;



-- Upload grants already enforce the operator-configured file size policy.
-- A second hard-coded 512 MiB check made finalized larger files impossible
-- to attach even when TM8_FILE_MAX_SIZE_BYTES admitted them.
create or replace function internal.w2_validate_attachment_files(
  file_ids uuid[], target_space uuid, require_space_visible boolean default false
) returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare requested uuid[]; result jsonb; invalid_count integer;
begin
  select coalesce(array_agg(value order by value),'{}'::uuid[]) into requested
    from unnest(coalesce(file_ids,'{}'::uuid[])) item(value);
  if cardinality(requested)>16
     or cardinality(requested)<>cardinality(coalesce(file_ids,'{}'::uuid[])) then
    raise exception 'attachments must contain at most 16 unique file ids' using errcode='22023';
  end if;
  select count(*) into invalid_count
    from unnest(requested) item(id)
    left join public.entities e on e.id=item.id
    left join public.files f on f.entity_id=e.id
   where e.id is null or e.kind<>'file' or e.deleted_at is not null
      or e.space_id<>target_space or not internal.entity_readable(e.id)
      or f.entity_id is null or f.checksum_sha256 is null
      or char_length(f.mime_type) not between 1 and 255
      or (require_space_visible and e.visibility<>'space');
  if invalid_count<>0 then
    raise exception 'attachment file is not finalized, live, readable, or audience compatible'
      using errcode='P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'fileEntityId',e.id,'name',f.name,'mime',f.mime_type
    ) order by e.id),'[]'::jsonb)
    into result
    from unnest(requested) item(id)
    join public.entities e on e.id=item.id
    join public.files f on f.entity_id=e.id;
  return result;
end
$$;

reset role;
