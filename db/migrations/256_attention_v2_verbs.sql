-- =============================================================================
-- 256 · ATTENTION v2 VERBS (slice S4; spec chapter 3 "Resolve, Seen &
-- delivery", chapter 2 "Writers", chapter 5 "Database: one aggregate").
--
-- 255 added the columns; this file gives them their writers.
--
--   1. create_attention_request gains trailing p_source_session_id, p_level,
--      p_action_type and p_assignee_id, derives points from the level, and
--      DEDUPES an open (entity, session, reason) instead of inserting (Q10).
--      The session is passed by the server from the caller's BEARER
--      (workSessionId ?? runtimeChatId, F1a), never from request input.
--   2. resolve_attention_root settles every open request on the roll-up root
--      (own + rolled up, Q5) as ONE batch, and schedules the note for
--      now + 8s. resolve_entity_attention stays, as a wrapper for old callers.
--   3. unresolve_attention_batch: Undo, by the resolver, within 8s. Only rows
--      still resolved reopen, and their pending delivery dies with them.
--   4. withdraw_attention_request: the raising agent takes back its own open
--      request (status dismissed, nothing delivered).
--   5. mark_attention_seen: per-person Seen over the root. Never touches
--      status, counts, or anyone else's view (G2, G4).
--   6. update_attention_request: `acknowledged` is legacy, so that transition
--      now writes attention_seen and leaves the row alone; reopening clears
--      the batch and any pending delivery.
--   7. The delivery sweep's two doors: list_due_attention_notes (which batches
--      are past their window) and deliver_attention_batch (post one message
--      per target anchor, as the resolver, and record note_message_id).
--
-- Undo vs. delivery is decided by ROW LOCKS and clock_timestamp(), never by
-- now(): both doors lock the batch's rows first, then compare against the wall
-- clock, so exactly one of them wins a race at the 8s edge.
--
-- NOT HERE: raise_attention_signal / clear_attention_signal (S6).
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- Shared helpers.
-- -----------------------------------------------------------------------------

-- The ids an entity's roll-up can reach in one hop: itself, plus anything with
-- a working_on / attached_to edge INTO it. The caller filters the requests on
-- these entities by attention_root_id, so this only bounds the scan.
create or replace function internal.attention_root_candidates(p_root_id uuid) returns uuid[]
language sql stable set search_path = public, internal, pg_temp as $$
  select array[p_root_id] || coalesce(
    (select array_agg(e.src_id) from public.edges e
      where e.dst_id = p_root_id and e.type in ('working_on', 'attached_to')),
    '{}'::uuid[])
$$;

-- Whether the raising session (or chat) can still be reached. A work session
-- is live while spawning/running/idle (the same set the task-state nudge
-- uses). A chat is reachable while it exists: a chat-anchored message queues a
-- turn whatever its runtime state (176).
create or replace function internal.attention_source_live(p_source_id uuid) returns boolean
language sql stable set search_path = public, internal, pg_temp as $$
  select p_source_id is not null and (
    exists (select 1 from public.work_sessions ws
              join public.entities se on se.id = ws.entity_id and se.deleted_at is null
             where ws.entity_id = p_source_id and ws.status in ('spawning', 'running', 'idle'))
    or exists (select 1 from public.chats c
                 join public.entities ce on ce.id = c.entity_id and ce.deleted_at is null
                where c.entity_id = p_source_id))
$$;

-- A refusal the client can act on: 409 conflict with details.reason.
-- SQLSTATE class TA (tm8 attention); errors.ts maps TAC01 to `conflict`.
create or replace function internal.attention_conflict(p_reason text, p_message text) returns void
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  raise exception '%', p_message
    using errcode = 'TAC01', detail = jsonb_build_object('reason', p_reason)::text;
end
$$;

-- -----------------------------------------------------------------------------
-- 1. Create: stamps the source, derives points from the level, dedupes.
-- The old 5-argument form is DROPPED rather than overloaded: with defaults on
-- the new trailing args a 5-argument call would be ambiguous between the two.
-- -----------------------------------------------------------------------------
drop function public.create_attention_request(uuid, text, integer, uuid, text);

create function public.create_attention_request(
  p_entity_id uuid,
  p_reason text,
  p_points integer default null,
  p_actor_id uuid default null,
  p_client_mutation_id text default null,
  p_source_session_id uuid default null,
  p_level text default null,
  p_action_type text default null,
  p_assignee_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  lvl text := coalesce(p_level, 'normal');
  typ text := coalesce(p_action_type, 'decide');
  pts integer;
  reason_text text := btrim(coalesce(p_reason, ''));
  request_id uuid;
  deduped boolean := false;
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

  if char_length(reason_text) not between 1 and 500 then
    raise exception 'attention reason must be between 1 and 500 characters' using errcode = '22023';
  end if;
  if lvl not in ('fyi', 'normal', 'high', 'urgent') then
    raise exception 'attention level must be fyi, normal, high or urgent' using errcode = '22023';
  end if;
  if typ not in ('decide', 'approve', 'unblock', 'review', 'fyi') then
    raise exception 'attention type must be decide, approve, unblock, review or fyi' using errcode = '22023';
  end if;
  -- Chapter 1: fyi 10, normal 40, high 70, urgent 95 (ATTENTION_LEVEL_POINTS).
  pts := coalesce(p_points, case lvl when 'fyi' then 10 when 'high' then 70 when 'urgent' then 95 else 40 end);
  if pts not between 1 and 100 then
    raise exception 'attention points must be between 1 and 100' using errcode = '22023';
  end if;
  -- The source is server-stamped from the bearer, but a session of ANOTHER
  -- space must still never be written as this request's raiser.
  if p_source_session_id is not null and not exists (
    select 1 from public.entities s
     where s.id = p_source_session_id and s.space_id = e.space_id
       and s.kind in ('work_session', 'chat') and s.deleted_at is null
  ) then
    raise exception 'attention source session is not in this space' using errcode = '42501';
  end if;
  if p_assignee_id is not null and not exists (
    select 1 from public.members m
      join public.entities me on me.id = m.entity_id and me.deleted_at is null
     where m.entity_id = p_assignee_id and m.space_id = e.space_id and m.status = 'active'
  ) then
    raise exception 'attention assignee must be an active member of this space' using errcode = '22023';
  end if;

  -- origin is left to 255's BEFORE trigger: agent for a teammate persona,
  -- human otherwise. The public create never writes `system`.
  insert into public.attention_requests(
    space_id, entity_id, reason, points, requested_by,
    source_session_id, level, action_type, assignee_id)
  values (e.space_id, p_entity_id, reason_text, pts, actor,
          p_source_session_id, lvl, typ, p_assignee_id)
  on conflict (entity_id, source_session_id, md5(reason))
    where status = 'open' and source_session_id is not null
  do nothing
  returning id into request_id;

  if request_id is null then
    -- Q10: the same session asking the same thing again is a no-op that
    -- returns the open row, so its wait clock keeps running.
    select id into request_id from public.attention_requests
     where entity_id = p_entity_id and source_session_id = p_source_session_id
       and md5(reason) = md5(reason_text) and status = 'open';
    deduped := true;
  else
    update public.entities set activity_at = now(), updated_at = now() where id = p_entity_id;
    perform internal.record_activity(e.space_id, p_entity_id, actor, 'updated', request_id,
      jsonb_build_object('change', 'attention_requested', 'attentionRequestId', request_id,
                         'points', pts, 'level', lvl, 'actionType', typ));
  end if;

  result := jsonb_build_object(
    'attentionRequestId', request_id,
    'entityId', p_entity_id,
    'affectedCount', case when deduped then 0 else 1 end,
    'deduped', deduped
  );
  return internal.ledger_record(p_client_mutation_id, 'attentionRequests.create', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 2. Resolve the roll-up root: one batch, delivery in 8s.
-- -----------------------------------------------------------------------------
create or replace function public.resolve_attention_root(
  p_entity_id uuid,
  p_resolution_note text default null,
  p_actor_id uuid default null,
  p_client_mutation_id text default null,
  p_resolution_batch_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  root uuid;
  actor uuid;
  batch uuid := coalesce(p_resolution_batch_id, gen_random_uuid());
  note text := nullif(btrim(coalesce(p_resolution_note, '')), '');
  touched uuid[];
  changed integer;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'attentionRequests.resolveEntity');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    -- Pre-256 ledger rows carry only entityId (then always the requested id).
    perform internal.require_replay_subject(
      coalesce(replay->>'requestedEntityId', replay->>'entityId'), p_entity_id::text, 'entity');
    return replay;
  end if;

  e := internal.live_entity(p_entity_id);
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  root := internal.attention_root_id(p_entity_id);

  if note is not null and char_length(note) > 1000 then
    raise exception 'attention resolution note must be at most 1000 characters' using errcode = '22023';
  end if;
  -- A client batch id names ONE resolve; reusing it would let Undo reopen
  -- somebody else's rows.
  if p_resolution_batch_id is not null
     and exists (select 1 from public.attention_requests where resolution_batch_id = p_resolution_batch_id) then
    perform internal.attention_conflict('batch_id_in_use', 'resolution batch id is already in use');
  end if;

  -- Every open request whose root is this root, and nothing else (invariant 1).
  -- system rows settle with the batch but deliver nothing: their condition,
  -- not a note, is the answer (chapter 3).
  with settled as (
    update public.attention_requests ar
       set status = 'resolved', resolved_by = actor, resolved_at = now(),
           resolution_note = note, resolution_batch_id = batch,
           note_deliver_after = case when ar.origin = 'system' then null
                                     else clock_timestamp() + interval '8 seconds' end,
           note_message_id = null,
           version = version + 1
     where ar.entity_id = any(internal.attention_root_candidates(root))
       and ar.status in ('open', 'acknowledged')
       and internal.attention_root_id(ar.entity_id) = root
    returning ar.entity_id
  )
  select count(*)::int, coalesce(array_agg(distinct entity_id), '{}') into changed, touched from settled;

  if changed > 0 then
    update public.entities set activity_at = now(), updated_at = now()
     where id = any(touched || root) and deleted_at is null;
    perform internal.record_activity(e.space_id, root, actor, 'updated', null,
      jsonb_build_object('change', 'attention_resolved', 'resolvedCount', changed,
                         'resolutionBatchId', batch));
  end if;

  result := jsonb_build_object(
    'attentionRequestId', null,
    'entityId', root,
    'requestedEntityId', p_entity_id,
    'affectedCount', changed,
    'resolutionBatchId', case when changed > 0 then batch::text else null end
  );
  return internal.ledger_record(p_client_mutation_id, 'attentionRequests.resolveEntity', result);
end
$$;

-- Old clients: same signature, now the root behaviour (chapter 5).
create or replace function public.resolve_entity_attention(
  p_entity_id uuid,
  p_resolution_note text default null,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb
language sql security definer set search_path = public, internal, pg_temp as $$
  select public.resolve_attention_root(p_entity_id, p_resolution_note, p_actor_id, p_client_mutation_id, null)
$$;

-- -----------------------------------------------------------------------------
-- 3. Undo: the resolver, within 8s of the resolve.
-- -----------------------------------------------------------------------------
create or replace function public.unresolve_attention_batch(
  p_batch_id uuid,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  space uuid;
  first_entity uuid;
  resolved_first timestamptz;
  actor uuid;
  root uuid;
  touched uuid[];
  changed integer;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'attentionRequests.unresolve');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay->>'resolutionBatchId', p_batch_id::text, 'resolution batch');
    return replay;
  end if;

  -- Lock the batch FIRST: the delivery sweep takes the same locks, so undo and
  -- delivery serialize on these rows.
  perform 1 from public.attention_requests where resolution_batch_id = p_batch_id for update;
  select ar.space_id, ar.entity_id, ar.resolved_at into space, first_entity, resolved_first
    from public.attention_requests ar
   where ar.resolution_batch_id = p_batch_id
   order by ar.resolved_at nulls last, ar.id
   limit 1;
  if space is null then
    raise exception 'resolution batch not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(space);
  actor := internal.resolve_actor(p_actor_id, space);
  perform internal.bind_actor(actor);

  if exists (select 1 from public.attention_requests
              where resolution_batch_id = p_batch_id and resolved_by is distinct from actor) then
    raise exception 'only the resolver can undo a resolve' using errcode = '42501';
  end if;
  if resolved_first is null
     or clock_timestamp() >= resolved_first + interval '8 seconds'
     or exists (select 1 from public.attention_requests
                 where resolution_batch_id = p_batch_id and note_message_id is not null) then
    perform internal.attention_conflict('undo_window_closed', 'the undo window has closed');
  end if;

  -- Only rows still resolved reopen. A row whose (session, reason) or signal
  -- was re-raised meanwhile stays resolved: reopening it would duplicate the
  -- open one (Q10).
  with reopened as (
    update public.attention_requests ar
       set status = 'open', resolved_by = null, resolved_at = null, resolution_note = null,
           resolution_batch_id = null, note_deliver_after = null, version = version + 1
     where ar.resolution_batch_id = p_batch_id and ar.status = 'resolved'
       and not exists (
         select 1 from public.attention_requests o
          where o.status = 'open' and o.entity_id = ar.entity_id and o.id <> ar.id
            and ((ar.source_session_id is not null and o.source_session_id = ar.source_session_id
                  and md5(o.reason) = md5(ar.reason))
              or (ar.signal_key is not null and o.signal_key = ar.signal_key)))
    returning ar.entity_id
  )
  select count(*)::int, coalesce(array_agg(distinct entity_id), '{}') into changed, touched from reopened;

  root := internal.attention_root_id(first_entity);
  if changed > 0 then
    update public.entities set activity_at = now(), updated_at = now()
     where id = any(touched || root) and deleted_at is null;
    perform internal.record_activity(space, root, actor, 'updated', null,
      jsonb_build_object('change', 'attention_unresolved', 'reopenedCount', changed,
                         'resolutionBatchId', p_batch_id));
  end if;

  result := jsonb_build_object(
    'attentionRequestId', null,
    'entityId', root,
    'affectedCount', changed,
    'resolutionBatchId', p_batch_id
  );
  return internal.ledger_record(p_client_mutation_id, 'attentionRequests.unresolve', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. Withdraw: the raising agent, its own open agent row.
-- -----------------------------------------------------------------------------
create or replace function public.withdraw_attention_request(
  p_request_id uuid,
  p_expected_version integer default null,
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
  replay := internal.ledger_replay(p_client_mutation_id, 'attentionRequests.withdraw');
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

  if current.requested_by is distinct from actor then
    raise exception 'only the agent that raised an attention request can withdraw it' using errcode = '42501';
  end if;
  if p_expected_version is not null and current.version <> p_expected_version then
    raise exception 'version conflict on attention request %', p_request_id
      using errcode = '40001',
            detail = jsonb_build_object('attentionRequestId', p_request_id, 'currentVersion', current.version)::text;
  end if;
  if current.origin <> 'agent' or current.status <> 'open' then
    perform internal.attention_conflict('not_withdrawable',
      'only an open attention request raised by an agent can be withdrawn');
  end if;

  update public.attention_requests
     set status = 'dismissed', resolved_by = actor, resolved_at = now(), version = version + 1
   where id = p_request_id;

  update public.entities set activity_at = now(), updated_at = now() where id = current.entity_id;
  perform internal.record_activity(current.space_id, current.entity_id, actor, 'updated', p_request_id,
    jsonb_build_object('change', 'attention_withdrawn', 'attentionRequestId', p_request_id));

  result := jsonb_build_object(
    'attentionRequestId', p_request_id,
    'entityId', current.entity_id,
    'affectedCount', 1
  );
  return internal.ledger_record(p_client_mutation_id, 'attentionRequests.withdraw', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Seen: per person, over the root. No status change, no entity touch, so no
-- event and no badge change for anyone (invariant 6).
-- -----------------------------------------------------------------------------
create or replace function public.mark_attention_seen(
  p_entity_id uuid,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  root uuid;
  me uuid;
  changed integer;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'attentionRequests.markSeen');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay->>'requestedEntityId', p_entity_id::text, 'entity');
    return replay;
  end if;

  e := internal.live_entity(p_entity_id);
  perform internal.require_space_member(e.space_id);
  -- Seen belongs to the PERSON, so it is keyed on the member behind the
  -- credential, never on a persona the call acts as.
  me := internal.current_member_id(e.space_id);
  if me is null then
    raise exception 'no member in this space' using errcode = '42501';
  end if;
  root := internal.attention_root_id(p_entity_id);

  insert into public.attention_seen(request_id, member_id)
  select ar.id, me from public.attention_requests ar
   where ar.entity_id = any(internal.attention_root_candidates(root))
     and ar.status in ('open', 'acknowledged')
     and internal.attention_root_id(ar.entity_id) = root
  on conflict do nothing;
  get diagnostics changed = row_count;

  result := jsonb_build_object(
    'attentionRequestId', null,
    'entityId', root,
    'requestedEntityId', p_entity_id,
    'affectedCount', changed
  );
  return internal.ledger_record(p_client_mutation_id, 'attentionRequests.markSeen', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 6. update_attention_request: `acknowledged` writes Seen instead; `cleared`
-- is tm8's own and not settable here; reopening cancels a pending delivery.
-- -----------------------------------------------------------------------------
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
  me uuid;
  seen_only boolean;
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
  if p_status is not null and p_status not in ('open', 'acknowledged', 'resolved', 'dismissed') then
    raise exception 'invalid attention status' using errcode = '22023';
  end if;

  -- Legacy acknowledge: Seen for the caller, and the row is not written.
  if p_status = 'acknowledged' then
    me := internal.current_member_id(current.space_id);
    if me is not null then
      insert into public.attention_seen(request_id, member_id) values (p_request_id, me)
      on conflict do nothing;
    end if;
  end if;
  seen_only := p_status = 'acknowledged' and p_reason is null and p_points is null and p_resolution_note is null;

  if not seen_only then
    update public.attention_requests
       set reason = coalesce(btrim(p_reason), reason),
           points = coalesce(p_points, points),
           status = case when p_status is null or p_status = 'acknowledged' then status else p_status end,
           resolution_note = case when p_resolution_note is null then resolution_note else p_resolution_note end,
           resolved_by = case
             when p_status = 'open' then null
             when p_status in ('resolved','dismissed') then actor
             else resolved_by
           end,
           resolved_at = case
             when p_status = 'open' then null
             when p_status in ('resolved','dismissed') then now()
             else resolved_at
           end,
           -- Reopening takes the row out of its batch and cancels its note.
           resolution_batch_id = case when p_status = 'open' then null else resolution_batch_id end,
           note_deliver_after = case when p_status = 'open' then null else note_deliver_after end,
           version = version + 1
     where id = p_request_id;
    update public.entities set activity_at = now(), updated_at = now() where id = current.entity_id;
  end if;

  result := jsonb_build_object(
    'attentionRequestId', p_request_id,
    'entityId', current.entity_id,
    'affectedCount', 1
  );
  return internal.ledger_record(p_client_mutation_id, 'attentionRequests.update', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 7. The delivery sweep's doors.
-- -----------------------------------------------------------------------------

-- Batches whose undo window has passed and whose notes are not yet posted.
-- The resolver's identity rides along: the note is posted AS the resolver,
-- under the resolver's own credential (a teammate resolver has none, so the
-- sweep acts as that teammate from the node owner's). A batch still due after
-- an hour is abandoned rather than retried forever.
create or replace function public.list_due_attention_notes(p_limit integer default 50)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  result jsonb;
begin
  perform internal.require_identity();
  select coalesce(jsonb_agg(t.payload order by t.due), '[]'::jsonb) into result
    from (
      select min(ar.note_deliver_after) as due,
             jsonb_build_object(
               'batchId', ar.resolution_batch_id,
               'spaceId', ar.space_id,
               'resolverId', ar.resolved_by,
               'resolverIdentityId', (select m.identity_id from public.members m
                                       where m.entity_id = ar.resolved_by and m.status = 'active')
             ) as payload
        from public.attention_requests ar
       where ar.status = 'resolved'
         and ar.note_message_id is null
         and ar.resolution_batch_id is not null
         and ar.resolved_by is not null
         and ar.note_deliver_after <= clock_timestamp()
         and ar.note_deliver_after > clock_timestamp() - interval '1 hour'
         and (internal.is_node_admin() or internal.is_space_member(ar.space_id))
       group by ar.resolution_batch_id, ar.space_id, ar.resolved_by
       order by min(ar.note_deliver_after)
       limit greatest(coalesce(p_limit, 50), 1)
    ) t;
  return result;
end
$$;

-- Post one batch: one message per TARGET ANCHOR (invariant 4). A live raising
-- session or chat gets its own message; an ended or unknown one is folded
-- into the roll-up root's (Q7, invariant 5). Authored by the resolver through
-- 019's door, so routes, PTY delivery and chat wakes are the ordinary ones.
create or replace function public.deliver_attention_batch(p_batch_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  space uuid;
  resolver uuid;
  resolver_name text;
  target record;
  body text;
  posted jsonb;
  message_id uuid;
  out_rows jsonb := '[]'::jsonb;
begin
  perform internal.require_identity();
  -- The same locks Undo takes, then the wall clock: whichever commits first
  -- wins, and a reopened row is simply no longer due here.
  perform 1 from public.attention_requests where resolution_batch_id = p_batch_id for update;
  select ar.space_id, ar.resolved_by into space, resolver
    from public.attention_requests ar
   where ar.resolution_batch_id = p_batch_id and ar.status = 'resolved'
     and ar.note_message_id is null and ar.note_deliver_after <= clock_timestamp()
   limit 1;
  if space is null then
    return jsonb_build_object('posted', out_rows);
  end if;
  perform internal.require_space_member(space);

  resolver_name := coalesce(
    (select nullif(btrim(m.display_name), '') from public.members m where m.entity_id = resolver),
    (select nullif(btrim(t.name), '') from public.team_members t where t.entity_id = resolver),
    'a teammate');

  for target in
    with due as (
      select ar.id, ar.reason, ar.resolution_note, ar.created_at, ar.source_session_id,
             case when internal.attention_source_live(ar.source_session_id) then ar.source_session_id
                  else internal.attention_root_id(ar.entity_id) end as anchor_id
        from public.attention_requests ar
       where ar.resolution_batch_id = p_batch_id and ar.status = 'resolved'
         and ar.note_message_id is null and ar.note_deliver_after <= clock_timestamp()
    )
    select d.anchor_id,
           ak.kind as anchor_kind,
           array_agg(d.id order by d.created_at, d.id) as ids,
           array_agg(d.reason order by d.created_at, d.id) as reasons,
           max(d.resolution_note) as note
      from due d
      join public.entities ak on ak.id = d.anchor_id
     group by d.anchor_id, ak.kind
     order by d.anchor_id
  loop
    if cardinality(target.reasons) = 1 then
      body := format('Attention resolved by %s: "%s"', resolver_name, target.reasons[1]);
    else
      body := format('Attention resolved by %s (%s requests):', resolver_name, cardinality(target.reasons))
        || (select string_agg(format(E'\n- "%s"', r), '') from unnest(target.reasons) r);
    end if;
    if target.note is not null then
      body := body || E'\n\n' || target.note;
    end if;

    posted := public.w2_post_message_batch(
      array[target.anchor_id], body, null, '{}'::uuid[], '{}'::uuid[], null, resolver,
      format('attention-note:%s:%s', p_batch_id, target.anchor_id));
    message_id := (posted -> 'messageIds' ->> 0)::uuid;

    update public.attention_requests set note_message_id = message_id where id = any(target.ids);

    out_rows := out_rows || jsonb_build_object(
      'messageId', message_id,
      'anchorId', target.anchor_id,
      'anchorKind', target.anchor_kind,
      -- A chat's turn runs as the member who configured it (176), so the
      -- server's post-commit wake needs that identity.
      'chatIdentityId', (select c.configured_by_identity_id from public.chats c
                          where c.entity_id = target.anchor_id),
      'requestIds', to_jsonb(target.ids));
  end loop;

  return jsonb_build_object('posted', out_rows, 'spaceId', space);
end
$$;

-- -----------------------------------------------------------------------------
-- Grants. PUBLIC gets EXECUTE on every new function by default; revoke it
-- everywhere (w2-execution.pg.test.ts pins the delivery role's surface).
-- -----------------------------------------------------------------------------
revoke all on function internal.attention_root_candidates(uuid) from public;
revoke all on function internal.attention_source_live(uuid) from public;
revoke all on function internal.attention_conflict(text, text) from public;
grant execute on function internal.attention_root_candidates(uuid) to tm8_app, tm8_graph_owner;
grant execute on function internal.attention_source_live(uuid) to tm8_app, tm8_graph_owner;

revoke all on function public.create_attention_request(uuid, text, integer, uuid, text, uuid, text, text, uuid) from public;
revoke all on function public.resolve_attention_root(uuid, text, uuid, text, uuid) from public;
revoke all on function public.unresolve_attention_batch(uuid, uuid, text) from public;
revoke all on function public.withdraw_attention_request(uuid, integer, uuid, text) from public;
revoke all on function public.mark_attention_seen(uuid, text) from public;
revoke all on function public.list_due_attention_notes(integer) from public;
revoke all on function public.deliver_attention_batch(uuid) from public;
revoke all on function public.resolve_entity_attention(uuid, text, uuid, text) from public;
revoke all on function public.update_attention_request(uuid, integer, text, integer, text, text, uuid, text) from public;
grant execute on function public.create_attention_request(uuid, text, integer, uuid, text, uuid, text, text, uuid) to tm8_app;
grant execute on function public.resolve_attention_root(uuid, text, uuid, text, uuid) to tm8_app;
grant execute on function public.unresolve_attention_batch(uuid, uuid, text) to tm8_app;
grant execute on function public.withdraw_attention_request(uuid, integer, uuid, text) to tm8_app;
grant execute on function public.mark_attention_seen(uuid, text) to tm8_app;
grant execute on function public.list_due_attention_notes(integer) to tm8_app;
grant execute on function public.deliver_attention_batch(uuid) to tm8_app;
grant execute on function public.resolve_entity_attention(uuid, text, uuid, text) to tm8_app;
grant execute on function public.update_attention_request(uuid, integer, text, integer, text, text, uuid, text) to tm8_app;

reset role;

-- -----------------------------------------------------------------------------
-- VERIFY. Asserts only what THIS FILE creates.
-- -----------------------------------------------------------------------------
do $verify$
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public' and p.proname = 'create_attention_request') <> 1 then
    raise exception '256: exactly one create_attention_request must exist';
  end if;
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public'
         and p.proname in ('resolve_attention_root', 'unresolve_attention_batch', 'withdraw_attention_request',
                           'mark_attention_seen', 'list_due_attention_notes', 'deliver_attention_batch')) <> 6 then
    raise exception '256: the six attention verbs must exist';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname in ('public', 'internal')
       and p.proname in ('resolve_attention_root', 'unresolve_attention_batch', 'withdraw_attention_request',
                         'mark_attention_seen', 'list_due_attention_notes', 'deliver_attention_batch',
                         'create_attention_request', 'attention_root_candidates', 'attention_source_live',
                         'attention_conflict')
       and has_function_privilege('public', p.oid, 'execute')
  ) then
    raise exception '256: an attention function is still executable by PUBLIC';
  end if;
end
$verify$;
