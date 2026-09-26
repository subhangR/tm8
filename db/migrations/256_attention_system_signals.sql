-- =============================================================================
-- 256 · ATTENTION v2 SYSTEM SIGNALS (slice S6; spec chapter 2 "Writers &
-- auto-signals", chapter 6 "S6"). Needs 255's columns.
--
-- tm8 raises its own requests (origin = 'system') and CLEARS them itself when
-- the condition ends (Q2): status 'cleared', resolved_by null, no delivery
-- (note_deliver_after stays null). System rows are deduped by signal_key only,
-- never by reason, and are unassigned (R1).
--
--   1. internal.raise_attention_signal / internal.clear_attention_signal: the
--      one writer pair every system signal goes through.
--   2. Forms: form_raise_attention / form_resolve_attention (211) move onto
--      the pair. signal_key = form:<form-id>; answered, closed or cancelled
--      clears.
--   3. Merge conflicts: public.raise_system_attention /
--      public.clear_system_attention, the CLI's door (ops attentionSignals.raise
--      / attentionSignals.clear). A CLOSED vocabulary (spec-owner ruling on S6):
--      the caller names {kind:'conflict', worktreeId}, never a key; level and
--      type are fixed by the kind (high / review); the target must be the
--      worktree, a session in it, or a task linked to either.
--   4. Blocked dependency (R6): a task with an unresolved hard depends_on AND
--      work waiting (an assignee or a live working_on session) raises
--      depends_on:<edge-id> (normal / unblock). Raised from an edge trigger on
--      depends_on / assigned_to / working_on insert; cleared in
--      internal.announce_unblocked, on edge delete and when the edge stops
--      being hard.
--   5. announce_unblocked is ALSO driven from entities.status_category. The
--      003 trigger on tasks.work_status fires BEFORE tasks_category_bridge
--      (alphabetical AFTER-trigger order, 147/150), so is_resolved(target) --
--      which reads status_category since 152 -- was still false there and a
--      completed task announced nothing. See section 5.
-- =============================================================================

-- The whole file runs as the graph owner, like 211: the 211 form RPCs are its
-- definers and call the pair below, so the pair must be the graph owner's too.
set role tm8_graph_owner;

-- A system clear looks a row up by key within its space, without knowing the
-- entity (a conflict clears from the worktree, whatever anchor it was raised on).
create index attention_requests_open_signal_space_idx
  on public.attention_requests(space_id, signal_key)
  where signal_key is not null and status in ('open', 'acknowledged');

-- -----------------------------------------------------------------------------
-- 1. The writer pair.
-- -----------------------------------------------------------------------------

-- Raise: return the open row with this key on this entity, or insert one.
-- Points derive from the level (ATTENTION_LEVEL_POINTS in the contract) unless
-- the caller passes an override (a form's settings.attentionPoints).
create or replace function internal.raise_attention_signal(
  p_space_id uuid,
  p_entity_id uuid,
  p_signal_key text,
  p_reason text,
  p_level text,
  p_action_type text,
  p_requested_by uuid,
  p_points integer default null,
  p_source_session_id uuid default null,
  out request_id uuid,
  out created boolean
) language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if p_signal_key is null then
    raise exception 'a system attention signal needs a signal_key' using errcode = '22023';
  end if;
  select ar.id into request_id from public.attention_requests ar
   where ar.entity_id = p_entity_id and ar.signal_key = p_signal_key
     and ar.status in ('open', 'acknowledged')
   limit 1;
  if request_id is not null then
    created := false;
    return;
  end if;

  insert into public.attention_requests(
    space_id, entity_id, reason, points, requested_by, origin, signal_key,
    level, action_type, source_session_id)
  values (
    p_space_id, p_entity_id, left(btrim(p_reason), 500),
    coalesce(p_points, case p_level when 'fyi' then 10 when 'high' then 70 when 'urgent' then 95 else 40 end),
    p_requested_by, 'system', p_signal_key, p_level, p_action_type, p_source_session_id)
  on conflict (entity_id, signal_key) where status = 'open' and signal_key is not null do nothing
  returning id into request_id;

  if request_id is null then
    -- A concurrent raise won the partial unique index.
    select ar.id into request_id from public.attention_requests ar
     where ar.entity_id = p_entity_id and ar.signal_key = p_signal_key and ar.status = 'open';
    created := false;
    return;
  end if;
  created := true;
  -- clock_timestamp(): a row written earlier in this transaction already has
  -- updated_at = now(), and an identical touch emits no entity.upsert (165).
  update public.entities set activity_at = now(), updated_at = clock_timestamp()
   where id = p_entity_id and deleted_at is null;
end
$$;

-- Clear: settle every open row with this key in the space (optionally only on
-- one entity) as 'cleared'. Idempotent; returns how many rows it settled.
create or replace function internal.clear_attention_signal(
  p_space_id uuid,
  p_signal_key text,
  p_entity_id uuid default null,
  p_note text default null
) returns integer
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  touched uuid[];
begin
  with settled as (
    update public.attention_requests
       set status = 'cleared', resolved_by = null, resolved_at = now(),
           resolution_note = coalesce(left(p_note, 1000), resolution_note), version = version + 1
     where space_id = p_space_id and signal_key = p_signal_key
       and status in ('open', 'acknowledged')
       and (p_entity_id is null or entity_id = p_entity_id)
    returning entity_id
  )
  select coalesce(array_agg(distinct entity_id), '{}') into touched from settled;
  if cardinality(touched) > 0 then
    update public.entities set activity_at = now(), updated_at = clock_timestamp()
     where id = any(touched) and deleted_at is null;
  end if;
  return cardinality(touched);
end
$$;

-- -----------------------------------------------------------------------------
-- 2. Forms (G4). Same signatures and callers as 211; the settle is 'cleared'.
-- -----------------------------------------------------------------------------
create or replace function internal.form_raise_attention(p_form public.forms, p_actor uuid)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
begin
  perform internal.raise_attention_signal(
    (select space_id from public.entities where id = p_form.entity_id),
    p_form.entity_id,
    'form:' || p_form.entity_id,
    'Form: ' || p_form.title,
    'normal', 'decide', p_actor,
    (internal.form_settings_effective(p_form.settings)->>'attentionPoints')::int);
end
$$;

-- p_actor is kept for 211's callers; a system clear has no resolver.
create or replace function internal.form_resolve_attention(p_form_id uuid, p_actor uuid, p_note text)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
begin
  perform internal.clear_attention_signal(
    (select space_id from public.entities where id = p_form_id),
    'form:' || p_form_id, p_form_id, p_note);
end
$$;

-- -----------------------------------------------------------------------------
-- 3. The CLI's door for merge conflicts. The key is built HERE from a closed
-- vocabulary; a caller can never name a free-form key, a level or a type.
-- -----------------------------------------------------------------------------

-- The worktree must be a live worktree in :entityId's space, and :entityId the
-- worktree itself, an entity with an edge into it (a session or task), or a task
-- a session in that worktree is working on. That is surfaceConflict's anchor
-- chain (explicit --task, the worktree's tasks, its session, the worktree).
create or replace function internal.system_signal_key(p_entity public.entities, p_signal jsonb)
returns text language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  worktree uuid;
begin
  if jsonb_typeof(p_signal) is distinct from 'object' or p_signal->>'kind' is distinct from 'conflict' then
    raise exception 'unknown system attention signal kind' using errcode = '22023';
  end if;
  begin
    worktree := (p_signal->>'worktreeId')::uuid;
  exception when invalid_text_representation then
    worktree := null;
  end;
  if worktree is null or not exists (
    select 1 from public.entities w
     where w.id = worktree and w.kind = 'worktree' and w.space_id = p_entity.space_id and w.deleted_at is null
  ) then
    raise exception 'conflict signal needs a worktree in this space' using errcode = '22023';
  end if;
  if not (
    p_entity.id = worktree
    or exists (select 1 from public.edges e where e.src_id = p_entity.id and e.dst_id = worktree)
    or (p_entity.kind = 'task' and exists (
          select 1 from public.edges into_wt
            join public.entities s on s.id = into_wt.src_id and s.kind = 'work_session'
            join public.edges w on w.src_id = s.id and w.type = 'working_on' and w.dst_id = p_entity.id
           where into_wt.dst_id = worktree))
  ) then
    raise exception 'the conflict signal target is not linked to that worktree' using errcode = '42501';
  end if;
  return 'conflict:' || worktree;
end
$$;

create or replace function public.raise_system_attention(
  p_entity_id uuid,
  p_signal jsonb,
  p_reason text,
  p_actor_id uuid default null,
  p_client_mutation_id text default null,
  p_source_session_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  key text;
  raised record;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'attentionSignals.raise');
  if replay is not null then
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
  key := internal.system_signal_key(e, p_signal);

  -- Only 'conflict' exists: high / review (R4).
  select * into raised from internal.raise_attention_signal(
    e.space_id, p_entity_id, key, p_reason, 'high', 'review', actor, null, p_source_session_id);

  result := jsonb_build_object(
    'attentionRequestId', raised.request_id,
    'entityId', p_entity_id,
    'affectedCount', case when raised.created then 1 else 0 end
  );
  return internal.ledger_record(p_client_mutation_id, 'attentionSignals.raise', result);
end
$$;

create or replace function public.clear_system_attention(
  p_entity_id uuid,
  p_signal jsonb,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  key text;
  changed integer;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'attentionSignals.clear');
  if replay is not null then
    perform internal.require_replay_subject(replay->>'entityId', p_entity_id::text, 'entity');
    return replay;
  end if;

  e := internal.live_entity(p_entity_id);
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  key := internal.system_signal_key(e, p_signal);

  changed := internal.clear_attention_signal(e.space_id, key);

  result := jsonb_build_object(
    'attentionRequestId', null,
    'entityId', p_entity_id,
    'affectedCount', changed
  );
  return internal.ledger_record(p_client_mutation_id, 'attentionSignals.clear', result);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. Blocked dependency (R6).
-- -----------------------------------------------------------------------------

-- Raise depends_on:<edge-id> for every unresolved hard dependency of the task,
-- when the task itself is unresolved and has work waiting on it: an assignee,
-- or a live work session working on it. Idempotent.
create or replace function internal.raise_blocked_dependencies(p_task_id uuid)
returns integer language plpgsql set search_path = public, internal, pg_temp as $$
declare
  dep record;
  raised integer := 0;
begin
  if not exists (select 1 from public.entities
                  where id = p_task_id and kind = 'task' and deleted_at is null)
     or internal.is_resolved(p_task_id)
     or not (
       exists (select 1 from public.edges a where a.src_id = p_task_id and a.type = 'assigned_to')
       or exists (select 1 from public.edges w
                    join public.work_sessions ws on ws.entity_id = w.src_id
                   where w.dst_id = p_task_id and w.type = 'working_on'
                     and ws.status in ('spawning', 'running', 'idle'))
     ) then
    return 0;
  end if;
  for dep in
    select e.id, e.space_id, e.dst_id, e.created_by,
           coalesce(nullif(btrim(t.title), ''), b.kind) as blocker
      from public.edges e
      join public.entities b on b.id = e.dst_id
      left join public.tasks t on t.entity_id = e.dst_id
     where e.src_id = p_task_id and e.type = 'depends_on'
       and coalesce((e.props ->> 'hard')::boolean, true)
       and not internal.is_resolved(e.dst_id)
  loop
    perform internal.raise_attention_signal(
      dep.space_id, p_task_id, 'depends_on:' || dep.id, 'Blocked by: ' || dep.blocker,
      'normal', 'unblock', coalesce(internal.actor_id(), dep.created_by));
    raised := raised + 1;
  end loop;
  return raised;
end
$$;

-- SECURITY DEFINER, like both triggers here: an edge or status write can come
-- from any role (a definer RPC, the graph owner), and the signal pair writes
-- attention_requests whoever the writer is. Trigger functions need no EXECUTE
-- grant, so nothing below is granted to tm8_app or the graph owner.
create or replace function internal.edges_blocked_dependency_signal() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    perform internal.clear_attention_signal(old.space_id, 'depends_on:' || old.id, old.src_id);
    return null;
  end if;
  if new.type = 'depends_on' then
    if coalesce((new.props ->> 'hard')::boolean, true) then
      perform internal.raise_blocked_dependencies(new.src_id);
    else
      perform internal.clear_attention_signal(new.space_id, 'depends_on:' || new.id, new.src_id);
    end if;
  elsif new.type = 'assigned_to' then
    perform internal.raise_blocked_dependencies(new.src_id);
  elsif new.type = 'working_on'
        and exists (select 1 from public.entities where id = new.src_id and kind = 'work_session') then
    perform internal.raise_blocked_dependencies(new.dst_id);
  end if;
  return null;
end
$$;

create trigger edges_blocked_dependency_signal
after insert or update of props on public.edges
for each row when (new.type in ('depends_on', 'assigned_to', 'working_on'))
execute function internal.edges_blocked_dependency_signal();

create trigger edges_blocked_dependency_signal_delete
after delete on public.edges
for each row when (old.type = 'depends_on')
execute function internal.edges_blocked_dependency_signal();

-- The clear. 003's body, plus: every dependency edge onto the resolved target
-- clears its signal (whether or not the waiter has other blockers -- each edge
-- is its own request), and the target's OWN dependency signals clear, since a
-- resolved task has no work waiting on it.
create or replace function internal.announce_unblocked(target uuid)
returns integer language plpgsql set search_path = public, internal, pg_temp as $$
declare
  waiter record;
  space uuid;
  announced integer := 0;
  activity_id uuid;
begin
  if not internal.is_resolved(target) then
    return 0;
  end if;
  select space_id into space from public.entities where id = target;

  perform internal.clear_attention_signal(space, 'depends_on:' || e.id, e.src_id)
     from public.edges e
    where (e.dst_id = target or e.src_id = target) and e.type = 'depends_on';

  for waiter in
    select e.src_id as waiting_id
      from public.edges e
     where e.dst_id = target
       and e.type = 'depends_on'
       and coalesce((e.props ->> 'hard')::boolean, true)
  loop
    -- Still blocked by something else? Then it is not unblocked yet.
    if not exists (
      select 1 from public.edges e2
       where e2.src_id = waiter.waiting_id
         and e2.type = 'depends_on'
         and coalesce((e2.props ->> 'hard')::boolean, true)
         and not internal.is_resolved(e2.dst_id)
    ) then
      activity_id := internal.record_activity(space, waiter.waiting_id, internal.actor_id(), 'unblocked',
                       target, jsonb_build_object('resolvedId', target));
      announced := announced + 1;
      -- Whoever is assigned to / working on the waiter wants to know.
      perform internal.notify(space, internal.recipient_member(e.dst_id), 'unblock',
                              waiter.waiting_id, internal.actor_id(),
                              jsonb_build_object('resolvedId', target), activity_id)
        from public.edges e
       where e.src_id = waiter.waiting_id and e.type in ('assigned_to');
    end if;
  end loop;
  return announced;
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Drive announce_unblocked from the category, not only from work_status.
-- tasks_announce_unblocked (003) fires before tasks_category_bridge writes
-- status_category, so on the task path is_resolved(target) is still false and
-- it announces nothing; a status_id move (149) never touches work_status at
-- all. This trigger fires once status_category actually becomes 'done', for
-- every kind. The 003 task trigger is dropped so a path where the category was
-- already 'done' (status_id first, work_status bridged after) cannot announce
-- twice. pull_requests keep theirs and are excluded here: a merged PR resolves
-- by its forge state (152), not by category, so one path announces it.
-- -----------------------------------------------------------------------------
drop trigger tasks_announce_unblocked on public.tasks;

create or replace function internal.on_status_category_done() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.announce_unblocked(new.id);
  return null;
end
$$;

-- NOT `update of status_category`: a column-list trigger fires only when the
-- column is in the UPDATE's SET list, and the task bridge sets status_id while
-- a BEFORE trigger (149) derives the category. The WHEN is a plain column
-- comparison, so the cost on other entity updates is one row test.
create trigger entities_announce_unblocked
after update on public.entities
for each row when (new.status_category = 'done' and old.status_category is distinct from 'done'
                   and new.kind <> 'pull_request')
execute function internal.on_status_category_done();

-- -----------------------------------------------------------------------------
-- Grants. Nothing new is callable by PUBLIC; only the two CLI doors go to
-- tm8_app. Every internal function is reached from a definer (an RPC or one of
-- the two definer triggers), so none is granted.
-- -----------------------------------------------------------------------------
revoke all on function internal.raise_attention_signal(uuid, uuid, text, text, text, text, uuid, integer, uuid) from public;
revoke all on function internal.clear_attention_signal(uuid, text, uuid, text) from public;
revoke all on function internal.system_signal_key(public.entities, jsonb) from public;
revoke all on function internal.raise_blocked_dependencies(uuid) from public;
revoke all on function internal.edges_blocked_dependency_signal() from public;
revoke all on function internal.on_status_category_done() from public;
revoke all on function public.raise_system_attention(uuid, jsonb, text, uuid, text, uuid) from public;
revoke all on function public.clear_system_attention(uuid, jsonb, uuid, text) from public;
grant execute on function public.raise_system_attention(uuid, jsonb, text, uuid, text, uuid) to tm8_app;
grant execute on function public.clear_system_attention(uuid, jsonb, uuid, text) to tm8_app;

reset role;

-- -----------------------------------------------------------------------------
-- VERIFY. Asserts only what THIS FILE creates.
-- -----------------------------------------------------------------------------
do $verify$
begin
  if (select count(*) from pg_trigger
       where tgname in ('edges_blocked_dependency_signal', 'edges_blocked_dependency_signal_delete',
                        'entities_announce_unblocked')) <> 3 then
    raise exception '256: the three signal triggers must exist';
  end if;
  if exists (select 1 from pg_trigger where tgname = 'tasks_announce_unblocked') then
    raise exception '256: tasks_announce_unblocked must be gone (entities_announce_unblocked replaces it)';
  end if;
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'internal' and p.proname in ('form_raise_attention', 'form_resolve_attention')
         and p.prosrc like '%_attention_signal(%') <> 2 then
    raise exception '256: forms must raise and clear through the signal pair';
  end if;
end
$verify$;
