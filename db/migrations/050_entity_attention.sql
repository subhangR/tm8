-- =============================================================================
-- 050 — generic attention requests.
--
-- Attention is a resource, not an entity flag. Multiple actors can leave
-- independently scored reasons on any entity kind, and the history remains
-- available after an entity no longer needs attention.
-- =============================================================================
set role tm8_graph_owner;

create table public.attention_requests (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  points smallint not null check (points between 1 and 100),
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved', 'dismissed')),
  requested_by uuid not null references public.entities(id),
  acknowledged_by uuid references public.entities(id),
  resolved_by uuid references public.entities(id),
  resolution_note text check (resolution_note is null or char_length(resolution_note) <= 1000),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz
);

create trigger attention_requests_touch_updated_at
before update on public.attention_requests
for each row execute function internal.touch_updated_at();

create index attention_requests_space_queue_idx
  on public.attention_requests(space_id, status, points desc, created_at, id);
create index attention_requests_entity_queue_idx
  on public.attention_requests(entity_id, status, created_at, id);

alter table public.attention_requests enable row level security;
create policy attention_requests_select on public.attention_requests for select to tm8_app
  using (internal.entity_readable(entity_id));
grant select on public.attention_requests to tm8_app;

create or replace function public.create_attention_request(
  p_entity_id uuid,
  p_reason text,
  p_points integer,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  request_id uuid;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'attentionRequests.create');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay->>'entityId', p_entity_id::text, 'entity');
    return replay;
  end if;

  e := internal.live_entity(p_entity_id);
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 500 then
    raise exception 'attention reason must be between 1 and 500 characters' using errcode = '22023';
  end if;
  if p_points not between 1 and 100 then
    raise exception 'attention points must be between 1 and 100' using errcode = '22023';
  end if;

  insert into public.attention_requests(space_id, entity_id, reason, points, requested_by)
  values (e.space_id, p_entity_id, btrim(p_reason), p_points, actor)
  returning id into request_id;

  -- The envelope update publishes the existing entity.upsert event. Its
  -- summary derives the current attention aggregate from this table.
  update public.entities set activity_at = now(), updated_at = now() where id = p_entity_id;
  perform internal.record_activity(e.space_id, p_entity_id, actor, 'updated', request_id,
    jsonb_build_object('change', 'attention_requested', 'attentionRequestId', request_id, 'points', p_points));

  result := jsonb_build_object(
    'attentionRequestId', request_id,
    'entityId', p_entity_id,
    'affectedCount', 1
  );
  return internal.ledger_record(p_client_mutation_id, 'attentionRequests.create', result);
end
$$;

create or replace function public.update_attention_request(
  p_request_id uuid,
  p_expected_version integer,
  p_reason text default null,
  p_points integer default null,
  p_status text default null,
  p_resolution_note text default null,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  current public.attention_requests;
  actor uuid;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'attentionRequests.update');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay->>'attentionRequestId', p_request_id::text, 'attention request');
    return replay;
  end if;

  select * into current from public.attention_requests where id = p_request_id for update;
  if not found then raise exception 'attention request not found' using errcode = 'P0002'; end if;
  perform internal.require_space_member(current.space_id);
  actor := internal.resolve_actor(p_actor_id, current.space_id);
  perform internal.bind_actor(actor);

  if current.version <> p_expected_version then
    raise exception 'version conflict on attention request %', p_request_id
      using errcode = '40001',
            detail = jsonb_build_object('attentionRequestId', p_request_id, 'currentVersion', current.version)::text;
  end if;
  if p_reason is not null and char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'attention reason must be between 1 and 500 characters' using errcode = '22023';
  end if;
  if p_points is not null and p_points not between 1 and 100 then
    raise exception 'attention points must be between 1 and 100' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('open','acknowledged','resolved','dismissed') then
    raise exception 'invalid attention status' using errcode = '22023';
  end if;

  update public.attention_requests
     set reason = coalesce(btrim(p_reason), reason),
         points = coalesce(p_points, points),
         status = coalesce(p_status, status),
         resolution_note = case when p_resolution_note is null then resolution_note else p_resolution_note end,
         acknowledged_by = case
           when p_status = 'open' then null
           when p_status = 'acknowledged' then actor
           else acknowledged_by
         end,
         acknowledged_at = case
           when p_status = 'open' then null
           when p_status = 'acknowledged' then now()
           else acknowledged_at
         end,
         resolved_by = case
           when p_status in ('open','acknowledged') then null
           when p_status in ('resolved','dismissed') then actor
           else resolved_by
         end,
         resolved_at = case
           when p_status in ('open','acknowledged') then null
           when p_status in ('resolved','dismissed') then now()
           else resolved_at
         end,
         version = version + 1
   where id = p_request_id;

  update public.entities set activity_at = now(), updated_at = now() where id = current.entity_id;
  result := jsonb_build_object(
    'attentionRequestId', p_request_id,
    'entityId', current.entity_id,
    'affectedCount', 1
  );
  return internal.ledger_record(p_client_mutation_id, 'attentionRequests.update', result);
end
$$;

create or replace function public.resolve_entity_attention(
  p_entity_id uuid,
  p_resolution_note text default null,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  changed integer;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'attentionRequests.resolveEntity');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay->>'entityId', p_entity_id::text, 'entity');
    return replay;
  end if;

  e := internal.live_entity(p_entity_id);
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  update public.attention_requests
     set status = 'resolved', resolved_by = actor, resolved_at = now(),
         resolution_note = coalesce(p_resolution_note, resolution_note), version = version + 1
   where entity_id = p_entity_id and status in ('open', 'acknowledged');
  get diagnostics changed = row_count;

  if changed > 0 then
    update public.entities set activity_at = now(), updated_at = now() where id = p_entity_id;
    perform internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null,
      jsonb_build_object('change', 'attention_resolved', 'resolvedCount', changed));
  end if;

  result := jsonb_build_object(
    'attentionRequestId', null,
    'entityId', p_entity_id,
    'affectedCount', changed
  );
  return internal.ledger_record(p_client_mutation_id, 'attentionRequests.resolveEntity', result);
end
$$;

revoke all on function public.create_attention_request(uuid,text,integer,uuid,text) from public;
revoke all on function public.update_attention_request(uuid,integer,text,integer,text,text,uuid,text) from public;
revoke all on function public.resolve_entity_attention(uuid,text,uuid,text) from public;
grant execute on function public.create_attention_request(uuid,text,integer,uuid,text) to tm8_app;
grant execute on function public.update_attention_request(uuid,integer,text,integer,text,text,uuid,text) to tm8_app;
grant execute on function public.resolve_entity_attention(uuid,text,uuid,text) to tm8_app;

reset role;
