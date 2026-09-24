-- =============================================================================
-- 215  FORMS W2 — SPAWN MODES: resume, spawn_new, target=new_session (§7.3).
--
-- 214's claim hands a row out with purpose 'route' once its mode is in
-- `p_route_modes`; facade/services/w2/form-delivery-spawn.ts acts on it. This
-- file is the SQL that action needs and 214 did not have:
--
--   A. `spawn_mutation_id` on form_deliveries — the clientMutationId a spawn
--      for this delivery runs under. Stable until a spawn FAILS, so a re-claim
--      after a crash mid-spawn replays execution.spawn from the command ledger
--      (same session id, no second PTY) instead of spawning twice.
--   B. `begin_form_delivery_spawn` — under the claim: pin that id, stretch the
--      lease over the spawn (first-prompt settlement can outlast 214's 120s
--      lease), and read the requesting session's launch facts. Read here, as
--      the definer, because §7.3 spawns for a DELETED session too, and every
--      RLS read of a deleted entity comes back empty.
--   C. `settle_form_delivery_spawned` — status 'spawned' + spawned_session_id,
--      and the reply route for (session copy, spawned session), so `message
--      reply` works from the new session exactly as from the old one.
--   D. `defer_form_delivery` — a failed resume or spawn keeps the row pending
--      but pushes its lease into the future (backoff), so the 15s tick does not
--      retry it on every pass. attempts is already counted by the claim.
--
-- AUTHORITY (coordinator ruling): the server's claims call these, as they call
-- 214's doors. `claimed_by` already records who acted.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- A. The spawn's idempotency key.
-- -----------------------------------------------------------------------------
alter table public.form_deliveries
  add column if not exists spawn_mutation_id text;

comment on column public.form_deliveries.spawn_mutation_id is
  'clientMutationId of the spawn for this delivery (215). Kept across a crash, cleared by a failed spawn.';

-- -----------------------------------------------------------------------------
-- B. Begin a spawn: pin the key, hold the row, read the launch facts.
--
--    Refuses (returns null) unless the row is still pending and still held by
--    a live claim: a caller whose lease lapsed must not spawn on another's row.
-- -----------------------------------------------------------------------------
create or replace function public.begin_form_delivery_spawn(
  p_response_id uuid, p_work_session_id uuid, p_attempt integer, p_hold_seconds integer default 900
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  d public.form_deliveries;
  fr public.form_responses;
  ws public.work_sessions;
  se public.entities;
  launch jsonb;
  m public.messages;
  source_message uuid;
  teammate uuid;
  tasks uuid[];
begin
  perform internal.require_identity();
  select * into fr from public.form_responses where id = p_response_id;
  if fr.id is null or not internal.is_space_member(fr.space_id) then return null; end if;

  update public.form_deliveries
     set spawn_mutation_id = coalesce(spawn_mutation_id,
           'form-delivery-spawn:' || p_response_id || ':' || p_work_session_id || ':' || p_attempt),
         claimed_at = now() + make_interval(secs => greatest(coalesce(p_hold_seconds, 900), 60))
   where response_id = p_response_id and work_session_id = p_work_session_id
     and status = 'pending' and delivery_id is null and claimed_at is not null
  returning * into d;
  if d.response_id is null then return null; end if;

  select * into se from public.entities where id = p_work_session_id;
  select * into ws from public.work_sessions where entity_id = p_work_session_id;
  select e.dst_id into teammate
    from public.edges e
    join public.entities t on t.id = e.dst_id and t.kind = 'team_member' and t.deleted_at is null
   where e.src_id = p_work_session_id and e.type = 'relates_to'
   limit 1;
  -- The requester's tasks; failing that, the tasks the form is attached to
  -- (§7.3: "the teammate and tasks are known from the form's edges").
  select coalesce(array_agg(e.dst_id order by e.created_at), '{}') into tasks
    from public.edges e
    join public.entities t on t.id = e.dst_id and t.kind = 'task' and t.deleted_at is null
   where e.src_id = p_work_session_id and e.type = 'working_on';
  if cardinality(tasks) = 0 then
    select coalesce(array_agg(e.dst_id order by e.created_at), '{}') into tasks
      from public.edges e
      join public.entities t on t.id = e.dst_id and t.kind = 'task' and t.deleted_at is null
     where e.src_id = fr.form_id and e.type = 'attached_to';
  end if;

  -- The requester's RECORDED posture (the spawned session must never exceed
  -- it). Null when no manifest was recorded: the caller refuses to spawn.
  select sm.manifest -> 'launch' into launch
    from public.session_manifests sm where sm.work_session_id = p_work_session_id;

  -- The session copy the envelope renders, and the form's copy a reply
  -- threads under (214 G reads them the same way).
  select * into m from public.messages where entity_id = fr.message_id;
  select s.entity_id into source_message
    from public.messages s
   where s.message_batch_id = m.message_batch_id and s.anchor_id = fr.form_id
   limit 1;

  return jsonb_build_object(
    'mutationId', d.spawn_mutation_id,
    'message', jsonb_build_object(
      'id', m.entity_id,
      'batchId', m.message_batch_id,
      'body', m.body,
      'senderActorId', m.author_id,
      'senderActorKind', (select e.kind from public.entities e where e.id = m.author_id),
      'sourceMessageId', coalesce(source_message, m.entity_id)),
    'posture', case when launch is null then null else jsonb_build_object(
      'access_mode', launch ->> 'accessMode',
      'permission_mode', launch ->> 'permissionMode',
      'credential_source', launch ->> 'credentialSource',
      'credential_sources', launch -> 'credentialSources',
      'space_credential_ids', launch -> 'spaceCredentialIds',
      'harness_choice', launch -> 'harnessChoice') end,
    'spaceId', fr.space_id,
    'sessionDeleted', se.deleted_at is not null,
    'teamMemberId', teammate,
    'parentSessionId', se.parent_id,
    'projectId', ws.project_id,
    'taskIds', to_jsonb(tasks),
    'workdirMode', ws.workdir_mode,
    'baseRef', ws.base_ref,
    'mode', ws.mode,
    'model', ws.model,
    'agentTool', ws.agent_tool,
    'title', coalesce(ws.title, ''));
end
$$;

-- -----------------------------------------------------------------------------
-- C. The spawn happened: settle, and let the new session reply on the form.
-- -----------------------------------------------------------------------------
create or replace function public.settle_form_delivery_spawned(
  p_response_id uuid, p_work_session_id uuid, p_spawned_session_id uuid
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  fr public.form_responses;
  held integer;
begin
  perform internal.require_identity();
  select * into fr from public.form_responses where id = p_response_id;
  if fr.id is null or not internal.is_space_member(fr.space_id) then
    return jsonb_build_object('settled', false);
  end if;
  update public.form_deliveries
     set status = 'spawned', spawned_session_id = p_spawned_session_id,
         claimed_at = null, last_error = null
   where response_id = p_response_id and work_session_id = p_work_session_id
     and status = 'pending' and delivery_id is null;
  get diagnostics held = row_count;
  if held = 1 and fr.message_id is not null then
    -- 214 G writes the reply route as the default migration role; its attempt
    -- argument only feeds the returned facts, which are not needed here.
    perform internal.form_delivery_route(fr.message_id, p_spawned_session_id, fr.form_id, 1);
  end if;
  return jsonb_build_object('settled', held = 1);
end
$$;

-- -----------------------------------------------------------------------------
-- D. Not now: keep it pending, try again after a backoff. `p_forget_spawn`
--    drops the pinned spawn key — the spawn under it FAILED, so replaying it
--    would only replay the failure.
--
--    WHY A FUTURE claimed_at IS A BACKOFF. 214's claim only takes a row whose
--    `claimed_at < now() - lease`, so a row stamped now()+delay is invisible to
--    every claimer — hook, drain-on-live and tick alike — for delay + lease.
--    The effective wait is therefore p_delay_seconds PLUS the caller's lease.
-- -----------------------------------------------------------------------------
create or replace function public.defer_form_delivery(
  p_response_id uuid, p_work_session_id uuid, p_error text, p_delay_seconds integer,
  p_forget_spawn boolean default false
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare held integer;
begin
  perform internal.require_identity();
  update public.form_deliveries d
     set claimed_at = now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 0), 0)),
         last_error = left(p_error, 200),
         spawn_mutation_id = case when coalesce(p_forget_spawn, false) then null else d.spawn_mutation_id end
    from public.form_responses fr
   where fr.id = d.response_id and d.response_id = p_response_id and d.work_session_id = p_work_session_id
     and d.status = 'pending' and d.delivery_id is null and internal.is_space_member(fr.space_id);
  get diagnostics held = row_count;
  return jsonb_build_object('deferred', held = 1);
end
$$;

revoke all on function public.begin_form_delivery_spawn(uuid, uuid, integer, integer) from public;
grant execute on function public.begin_form_delivery_spawn(uuid, uuid, integer, integer) to tm8_app;
revoke all on function public.settle_form_delivery_spawned(uuid, uuid, uuid) from public;
grant execute on function public.settle_form_delivery_spawned(uuid, uuid, uuid) to tm8_app;
revoke all on function public.defer_form_delivery(uuid, uuid, text, integer, boolean) from public;
grant execute on function public.defer_form_delivery(uuid, uuid, text, integer, boolean) to tm8_app;

reset role;
