-- =============================================================================
-- 155  A SESSION'S CATEGORY FOLLOWS ITS LIFECYCLE.
--
-- 152 gave every kind a status, and it seeded them all — `work_session`
-- included — into the default workflow's `to_do` state. For a task, 150's
-- `tasks_category_bridge` then keeps the envelope in step with the detail row:
-- every writer of `tasks.work_status` passes through it and `entities.status_id`
-- moves with the status. NOTHING PLAYED THAT PART FOR A SESSION. A session's
-- lifecycle is `work_sessions.status`, written by exactly one function
-- (`public.work_session_transition`, R29), and that function has never touched
-- the envelope's status.
--
-- So the category was correct for about as long as a spawn takes, and wrong
-- forever after: measured on this node, 420 of 420 work_sessions sat under the
-- To Do tab (In Progress 0 / Done 0 / Cancelled 0) including sessions that had
-- been `exited` or `failed` for over a week. The per-row status glyph was right
-- the whole time — it reads `state.status` — so the tile and the tab above it
-- disagreed about the same row, which is the shape of defect sub-doc 5 (C2/C3)
-- already removed once from `completed`.
--
-- This file is 150's bridge, for sessions. Four pieces:
--
--   1. `internal.session_status_category` — THE mapping, as one function.
--   2. `internal.workflow_state_for_session_status` — the quiet resolver.
--   3. `work_sessions_category_bridge` — the AFTER trigger, on every writer.
--   4. The backfill: every existing session adopts the state its status names.
--
-- ## THE MAPPING, and the two members that are not the obvious guess
--
--     spawning   to_do          running   in_progress     exited   done
--     idle       in_progress    failed    done
--
-- `spawning -> to_do`, NOT in_progress. Two independent reasons, and either
-- alone would settle it:
--
--   * It is 147's `pulled -> to_do` ruling ("claimed is not started") applied to
--     the same shape of fact. A spawning session has been ASKED for; there is no
--     process yet, and on this node twelve of them had been asking for days.
--   * `public.session_resume` (062) moves an `exited` or `failed` session back
--     to `spawning`. Under this mapping that is `done -> to_do`, which 149's
--     `internal.category_transition_allowed` names as THE REOPEN. Under
--     `spawning -> in_progress` it would be `done -> in_progress`, which that
--     function does not allow at all — so the bridge would have turned every
--     resume into a `23514` refusal. The transition algebra is not a detail this
--     mapping gets to disagree with.
--
--   It also costs nothing at BIRTH. 152's `internal.seed_entity_initial_status`
--   seeds a newborn session into the workflow's initial state, which 149 forces
--   to be `to_do`, and a session is born `spawning` on every one of its five
--   insert paths (043/048/101/111/150's spawn, 083's credential terminal). The
--   bridge's INSERT arm therefore resolves the state the row is ALREADY in,
--   writes zero rows, and a spawn stays exactly ONE `entity.upsert` — the
--   one-event law 150's header makes load-bearing for `create_task`, held here
--   by the mapping rather than by a special case.
--
-- `failed -> done`, NOT cancelled. This is the EXISTING product ruling, written
-- down twice in the client and merely mirrored here:
--
--   * `SESSION_STATE_CONTROL` (packages/tm8-ui/src/domain/registry.ts): "failed
--     is done and not cancelled: under this model failure is a RUNTIME FACT that
--     gets a badge (design invariant 4), and the run itself did reach its end —
--     nobody cancelled it."
--   * `EntityListPanel`'s `completed` note, which describes reading `exited`
--     alone as the bug: it "files a CRASHED session as unfinished while the Done
--     tab counted it".
--
--   `cancelled` is the category for a thing that STOPPED WITHOUT FINISHING at
--   someone's decision — a cancelled task. A crashed run finished; it finished
--   badly, and `state.status`, the exit code and the error string are where that
--   is said. Filing it under `cancelled` would make the Done tab lie about the
--   set of runs that ran to completion.
--
--   No session status maps to `cancelled` at all, and that is the honest
--   reading rather than an omission: nothing in the session lifecycle is a
--   cancellation. `terminate` produces `exited`.
--
-- ## WHY A TRIGGER ON `work_sessions` AND NOT A LINE IN `work_session_transition`
--
-- Exactly 150's answer for tasks. `status` has one writer TODAY (R29's guard
-- makes that a database fact), but it has five INSERT paths, and 062's resume
-- takes the guard's escape hatch rather than going through the transition
-- function. A trigger is asked by all of them; a line in one RPC is asked by
-- one. The guard keeps writer #2 from ever appearing; this keeps writer #2 from
-- being able to forget the envelope if the guard is ever widened.
--
-- ## WHAT THIS CHANGES ABOUT WHAT BLOCKS WHAT
--
-- 152 pointed `internal.is_resolved` at the category, and ruled (decision #3)
-- that a `work_session` reaching `done` should RESOLVE a `depends_on`. Until
-- this file no session could reach `done`, so that ruling had no effect it could
-- have. It does now: a `depends_on` pointing at an exited session is satisfied,
-- and one pointing at a running session blocks. That is the ruling arriving, not
-- a new decision made here.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. THE MAPPING, as ONE function.
--
-- Mirrored in TypeScript by `SESSION_STATUS_CATEGORY` in
-- packages/server/src/facade/status.ts and by `SESSION_STATE_CONTROL.options` in
-- packages/tm8-ui/src/domain/registry.ts — but THIS is the writer, exactly as
-- 147's header says of `internal.work_status_category`. The server reads the
-- column; it never computes it.
--
-- No `else` arm, for 147's reason verbatim: `work_sessions.status` carries a DDL
-- CHECK naming exactly these five (001:703), so a sixth cannot exist without a
-- migration; if one ever does, this returns NULL and the bridge below leaves the
-- category alone rather than filing the row under a bucket nobody chose.
-- -----------------------------------------------------------------------------
create or replace function internal.session_status_category(p_status text)
returns text language sql immutable set search_path = public, internal, pg_temp as $$
  select case p_status
    when 'spawning' then 'to_do'
    when 'running'  then 'in_progress'
    when 'idle'     then 'in_progress'
    when 'exited'   then 'done'
    when 'failed'   then 'done'
  end
$$;

comment on function internal.session_status_category(text) is
  'The RULED work_sessions.status -> status_category mapping. spawning -> to_do '
  '(asked for is not started, and it is what makes session_resume a legal '
  'done -> to_do reopen); idle -> in_progress (an idle session is still alive); '
  'failed -> done (the run reached its end — nobody cancelled it, and the '
  'failure is a badge). Returns NULL for an unknown status rather than guessing.';

-- -----------------------------------------------------------------------------
-- 2. THE QUIET RESOLVER — status -> the workflow state the envelope should hold.
--
-- `internal.workflow_state_for_work_status`'s shape, minus its NAME-first arm
-- and minus the `type` axis, both deliberately:
--
--   * The name arm exists for tasks because 149 COPIED the legacy `work_status`
--     vocabulary into workflow state names, so `working` resolves to a state
--     literally called `working`. A session's statuses are the NODE's vocabulary
--     for a process, never a workflow's for a lane; matching `running` against a
--     state name would be a coincidence, and a space that happened to name a
--     state `idle` would silently re-point every idle session at it.
--   * `type` is a task axis. Every other kind resolves with a NULL type value.
--
-- Quiet (NULL, not a raise) for the same reason 150's bridge resolver is: a
-- trigger that raised here would turn a legal `work_session_transition` into an
-- abort because somebody authored a session workflow without a `done` state.
-- The bridge's second arm is what covers that case.
-- -----------------------------------------------------------------------------
create or replace function internal.workflow_state_for_session_status(
  p_entity_id uuid, p_status text
) returns uuid language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  wf_id uuid;
  category text := internal.session_status_category(p_status);
begin
  if category is null then return null; end if;
  select * into e from public.entities where id = p_entity_id;
  if e.id is null then return null; end if;

  wf_id := internal.workflow_for_entity(e.space_id, e.kind, null);
  if wf_id is null then return null; end if;

  return internal.find_workflow_state_for_category(wf_id, category);
end
$$;

comment on function internal.workflow_state_for_session_status(uuid, text) is
  'A session status projected onto the workflow governing its entity, by '
  'CATEGORY only — a session status is the node''s vocabulary for a process, not '
  'a workflow''s for a lane, so matching it against a state name would be a '
  'coincidence. NULL when nothing resolves; the bridge degrades to the column.';

-- -----------------------------------------------------------------------------
-- 3. THE BRIDGE.
--
-- `after insert or update of status`, so every one of the five spawn paths and
-- both status writers (043's transition function and 062's resume) are asked,
-- and nothing else pays for it.
--
-- `is distinct from` is the EVENT POSTURE, not an optimization — 147's choice,
-- kept by 150, and kept here: a zero-row UPDATE emits no `entity.upsert`, which
-- is what makes `spawning -> running` (both already in their state) silent and
-- what keeps a spawn exactly one event.
--
-- Firing order among AFTER triggers on `public.work_sessions` is alphabetical:
-- `work_sessions_category_bridge` < `work_sessions_w1_after_insert`. The
-- envelope's status is therefore written before 015's projection edges, and —
-- the part that matters to a client — before `work_session_transition`'s own
-- `version + 1` bump, which runs after the whole `work_sessions` UPDATE
-- statement. So the last event a client sees for a session transition carries
-- both the new version and the new category, exactly as 150 arranged for tasks.
--
-- THE SECOND ARM LEAVES THE CATEGORY ALONE where 150's writes it. The tasks
-- bridge falls back to `status_category = work_status_category(new.work_status)`,
-- which for an unmappable status would be NULL — and a NULL category means "this
-- entity has no status at all", which is a strictly worse statement about a live
-- session than a stale-but-true one. A status we cannot bucket is not a reason
-- to un-file a row. Both fallbacks are unreachable through any door today.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_session_status_to_state() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  category       text := internal.session_status_category(new.status);
  resolved_state uuid := internal.workflow_state_for_session_status(new.entity_id, new.status);
begin
  if resolved_state is not null then
    update public.entities
       set status_id = resolved_state
     where id = new.entity_id
       and status_id is distinct from resolved_state;
    return new;
  end if;

  -- No state to point at. Write the column directly when we at least know the
  -- bucket; leave it untouched when we do not.
  if category is not null then
    update public.entities
       set status_category = category
     where id = new.entity_id
       and status_category is distinct from category;
  end if;
  return new;
end
$$;

create trigger work_sessions_category_bridge
after insert or update of status on public.work_sessions
for each row execute function internal.bridge_session_status_to_state();

-- -----------------------------------------------------------------------------
-- 4. THE BACKFILL.
--
-- Every session that exists adopts the state its status names. Soft-deleted
-- rows included, for 152's reason: `deleted_at` is the archive axis and
-- orthogonal to status, and a restored session with a stale category would be
-- the one row the four tabs get wrong.
--
-- `entities_capture_event` off for the duration, taking 147's escape (a
-- table-owner `disable trigger`, rolled back with the migration) rather than
-- `session_replication_role`, which is superuser-only and would ALSO silence
-- `entities_status_from_state` — the one trigger this backfill depends on
-- running, because it is what derives `status_category` from the state.
--
-- Every move this makes is legal under `internal.category_transition_allowed`:
-- every session is currently in `to_do` (152 seeded them there and nothing has
-- moved one since), and `to_do -> in_progress`, `to_do -> done` and the no-op
-- are all ruled. The completion conditions 151 attaches to entry into `done`
-- pass vacuously — both read `public.tasks`, and a session has no row there.
-- -----------------------------------------------------------------------------
alter table public.entities disable trigger entities_capture_event;

update public.entities e
   set status_id = internal.workflow_state_for_session_status(e.id, ws.status)
  from public.work_sessions ws
 where ws.entity_id = e.id
   and internal.workflow_state_for_session_status(e.id, ws.status) is not null
   and e.status_id is distinct from internal.workflow_state_for_session_status(e.id, ws.status);

alter table public.entities enable trigger entities_capture_event;

-- =============================================================================
-- VERIFY
-- =============================================================================
do $verify$
declare
  n bigint;
begin
  -- 4.1 THE CLAIM OF THE FILE: no session's category disagrees with its status.
  select count(*) into n
    from public.entities e
    join public.work_sessions ws on ws.entity_id = e.id
   where e.status_category is distinct from internal.session_status_category(ws.status);
  if n > 0 then
    raise exception '155: % work_sessions have a category that disagrees with their status', n;
  end if;

  -- 4.2 The mapping is total over the DDL CHECK's five, so the fallback arm is
  -- unreachable and the claim above cannot be satisfied by a NULL.
  select count(*) into n
    from unnest(array['spawning','running','idle','exited','failed']) s
   where internal.session_status_category(s) is null;
  if n > 0 then
    raise exception '155: session_status_category leaves % of the five statuses unmapped', n;
  end if;

  -- 4.3 The bridge is installed and enabled — a backfill without the trigger
  -- would be correct today and wrong at the next spawn.
  select count(*) into n
    from pg_trigger
   where tgname = 'work_sessions_category_bridge'
     and tgrelid = 'public.work_sessions'::regclass
     and tgenabled = 'O';
  if n <> 1 then
    raise exception '155: work_sessions_category_bridge is missing or disabled (found %)', n;
  end if;

  -- 4.4 The event trigger is back on. A backfill that left it disabled would be
  -- a graph that silently stopped telling clients anything (152 §5.3).
  select count(*) into n
    from pg_trigger
   where tgname = 'entities_capture_event'
     and tgrelid = 'public.entities'::regclass
     and tgenabled = 'O';
  if n <> 1 then
    raise exception '155: entities_capture_event is not enabled (found %)', n;
  end if;
end
$verify$;

reset role;
