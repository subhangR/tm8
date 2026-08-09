-- =============================================================================
-- 082 — Git facts become first-class graph citizens (Tier 4 git×graph).
--
--   A. Git EVENTS on the durable ledger. The facts tables 001/057 created and
--      081's observer writes (`pull_requests`, `commits`, `worktrees`) are not
--      covered by 003's capture trigger — deliberately, because their raw rows
--      are not contract event bodies. This section adds narrow capture
--      triggers that author RPC-authored-passthrough payloads (mapper.ts
--      RPC_AUTHORED_PASSTHROUGH): the payload is built contract-shaped in the
--      trigger, `type` discriminant included, so `tm8 event watch
--      --until-match 'git.pr_state_changed'` can react to a merge the same way
--      it reacts to any other durable event.
--
--      Why triggers and not the writing RPCs: `pull_requests.state` is written
--      by `apply_pull_request_facts` (the 081 observer), but also by any
--      future writer. An event authored in the trigger fires for every door,
--      known and future — the same argument 003 makes for its own coverage.
--
--   B. PROVENANCE: session → commit. `record_session_commit` is the door a
--      local commit observer calls when a session's worktree produces a
--      commit: find-or-create the commit mirror entity (the 017 link_commit
--      dedupe, same advisory-lock key, so a later `task link-commit` converges
--      on the SAME entity) and stamp a `created_in` edge (066) from the commit
--      to the work session. "Which session produced commit X" is then an
--      ordinary edge read; no new edge type is introduced.
--
--   C. COMPLETION GATE on git facts, opt-in per task. `tasks.completion_gate`
--      defaults to 'none' — default complete behaviour is UNCHANGED. When a
--      task opts in ('pr_merged' via `set_task_gate`), `complete_task` refuses
--      while any `tracks`-linked pull request is unmerged or CI-red.
--      `pull_requests.ci_status` (nullable) carries the CI fact;
--      `apply_pull_request_facts` gains an optional argument to record it.
--      NULL ci_status means "unknown", and unknown does not refuse — the gate
--      is on facts we have, not facts we lack.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- A1. git.commit_recorded — a commit mirror entity came into existence.
--     INSERT-only: the facts on a commit row may be refreshed later
--     (apply_commit_facts), but the commit itself is recorded once.
-- -----------------------------------------------------------------------------
create or replace function internal.capture_git_commit() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
  values (
    new.space_id,
    internal.next_event_seq(new.space_id),
    'git.commit_recorded',
    jsonb_build_object(
      'type', 'git.commit_recorded',
      'commitEntityId', new.entity_id,
      'repo', new.repo,
      'sha', new.sha,
      'provider', new.provider),
    internal.claim_cmid()
  );
  return new;
end
$$;

drop trigger if exists commits_capture_git_event on public.commits;
create trigger commits_capture_git_event after insert on public.commits
for each row execute function internal.capture_git_commit();

-- -----------------------------------------------------------------------------
-- A2. git.pr_state_changed — the transition the whole tier exists for
--     (open → merged is what acceptance gating and derived status feed on).
--     Fires only when `state` actually changes, so the observer's "I looked
--     and learned nothing" refresh (081 §B2) emits nothing.
-- -----------------------------------------------------------------------------
create or replace function internal.capture_git_pr_state() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
  values (
    new.space_id,
    internal.next_event_seq(new.space_id),
    'git.pr_state_changed',
    jsonb_build_object(
      'type', 'git.pr_state_changed',
      'prEntityId', new.entity_id,
      'repo', new.repo,
      'number', new.number,
      'previousState', old.state,
      'state', new.state,
      'headSha', new.head_sha),
    internal.claim_cmid()
  );
  return new;
end
$$;

drop trigger if exists pull_requests_capture_git_event on public.pull_requests;
create trigger pull_requests_capture_git_event after update on public.pull_requests
for each row when (new.state is distinct from old.state)
execute function internal.capture_git_pr_state();

-- -----------------------------------------------------------------------------
-- A3. git.worktree_status_changed — active → merged/abandoned/deleted is a
--     lane-lifecycle fact (057 §2.4 versions it; now it is also watchable).
--     `worktrees` carries no space_id; the envelope row does.
-- -----------------------------------------------------------------------------
create or replace function internal.capture_git_worktree_status() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare space uuid;
begin
  select space_id into space from public.entities where id = new.entity_id;
  if space is not null then
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (
      space,
      internal.next_event_seq(space),
      'git.worktree_status_changed',
      jsonb_build_object(
        'type', 'git.worktree_status_changed',
        'worktreeEntityId', new.entity_id,
        'projectId', new.project_id,
        'branch', new.branch,
        'previousStatus', old.status,
        'status', new.status),
      internal.claim_cmid()
    );
  end if;
  return new;
end
$$;

drop trigger if exists worktrees_capture_git_event on public.worktrees;
create trigger worktrees_capture_git_event after update on public.worktrees
for each row when (new.status is distinct from old.status)
execute function internal.capture_git_worktree_status();

-- -----------------------------------------------------------------------------
-- B. record_session_commit — the provenance door.
--
-- Mirrors link_commit's dedupe exactly (same advisory-lock key, same
-- find-or-create on (space, provider, repo, sha)), so a commit first observed
-- locally and later linked to a task by `task link-commit` is ONE entity, with
-- both the `tracks` edge and the `created_in` edge hanging off it.
--
-- The `created_in` edge (066) is src=commit, dst=work_session, one per commit
-- (066's partial unique index on src). A commit observed twice — two ticks of
-- a recorder, or a rebase re-listing it — converges: `on conflict do nothing`.
--
-- UNLEDGERED, like 081's fact doors: observation churn is operational truth,
-- not a semantic command.
-- -----------------------------------------------------------------------------
create or replace function public.record_session_commit(
  p_work_session_id uuid, p_repo text, p_sha text,
  p_message text default null, p_author text default null,
  p_committed_at timestamptz default null, p_provider text default 'github',
  p_actor_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  session_entity public.entities;
  actor uuid;
  artifact_id uuid;
  edge_id uuid;
  created boolean := false;
  normalized_sha text := lower(p_sha);
begin
  perform internal.require_identity();
  select * into session_entity from public.entities
   where id = p_work_session_id and kind = 'work_session' and deleted_at is null;
  if not found then
    raise exception 'no live work session %', p_work_session_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(session_entity.space_id);
  actor := internal.resolve_actor(p_actor_id, session_entity.space_id);
  perform internal.bind_actor(actor);
  if nullif(btrim(p_repo), '') is null or normalized_sha !~ '^[a-f0-9]{7,64}$' then
    raise exception 'invalid commit reference' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    session_entity.space_id::text || ':commit:' || lower(p_provider) || ':' || lower(p_repo) || ':' || normalized_sha, 0));

  select entity_id into artifact_id from public.commits
   where space_id = session_entity.space_id and provider = lower(p_provider)
     and repo = p_repo and sha = normalized_sha for update;
  if artifact_id is null then
    artifact_id := internal.create_envelope(session_entity.space_id, 'commit', actor, null, null);
    insert into public.commits(entity_id, space_id, provider, repo, sha, message, author, committed_at)
    values (artifact_id, session_entity.space_id, lower(p_provider), p_repo, normalized_sha,
            coalesce(p_message, normalized_sha), p_author, p_committed_at);
    perform internal.record_initial_version(artifact_id, actor);
    created := true;
  else
    -- The same "NULL means the caller did not learn it" contract as
    -- apply_commit_facts: refresh only what was observed.
    update public.commits
       set message      = coalesce(p_message, message),
           author       = coalesce(p_author, author),
           committed_at = coalesce(p_committed_at, committed_at),
           updated_at   = now()
     where entity_id = artifact_id;
  end if;

  -- No props: `origin` is Server-owned (066's guard) and defaults to
  -- 'client_claim'; supplying it here would be refused for every caller.
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (session_entity.space_id, artifact_id, p_work_session_id, 'created_in', actor)
  on conflict (src_id) where type = 'created_in' do nothing;
  select id into edge_id from public.edges
   where src_id = artifact_id and type = 'created_in';

  return jsonb_build_object(
    'commitEntityId', artifact_id, 'created', created,
    'edgeId', edge_id, 'workSessionId', p_work_session_id);
end
$$;

revoke all on function public.record_session_commit(uuid,text,text,text,text,timestamptz,text,uuid) from public;
grant execute on function public.record_session_commit(uuid,text,text,text,text,timestamptz,text,uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- C1. The gate column and the CI fact.
-- -----------------------------------------------------------------------------
alter table public.tasks
  add column if not exists completion_gate text not null default 'none'
    constraint tasks_completion_gate_check check (completion_gate in ('none', 'pr_merged'));

alter table public.pull_requests
  add column if not exists ci_status text
    constraint pull_requests_ci_status_check check (ci_status in ('passing', 'failing', 'pending'));

-- 081 §B2 narrowed version-bumping to columns that carry meaning; ci_status
-- now carries meaning, so it joins the list. Same name, same function —
-- replacement by name, one column added to the when-clause.
drop trigger if exists pull_requests_w2_snapshot_version on public.pull_requests;
create trigger pull_requests_w2_snapshot_version after update on public.pull_requests
for each row when (
  new.provider is distinct from old.provider or new.url    is distinct from old.url
  or new.repo  is distinct from old.repo     or new.number is distinct from old.number
  or new.title is distinct from old.title    or new.state  is distinct from old.state
  or new.head_sha is distinct from old.head_sha
  or new.ci_status is distinct from old.ci_status
) execute function internal.snapshot_entity_version();

-- -----------------------------------------------------------------------------
-- C2. apply_pull_request_facts learns to carry the CI fact. Dropped and
--     recreated because the argument list changes; the 081 observer's 4-value
--     call binds to the defaulted 5th argument unchanged.
-- -----------------------------------------------------------------------------
drop function if exists public.apply_pull_request_facts(uuid, text, text, text);
create or replace function public.apply_pull_request_facts(
  p_entity_id uuid, p_title text default null, p_state text default null,
  p_head_sha text default null, p_ci_status text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare row public.pull_requests;
begin
  perform internal.require_identity();
  select * into row from public.pull_requests where entity_id = p_entity_id for update;
  if not found then
    raise exception 'no pull request %', p_entity_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(row.space_id);
  if p_state is not null and p_state not in ('open','merged','closed','draft') then
    raise exception 'invalid pull request state: %', p_state using errcode = '22023';
  end if;
  if p_ci_status is not null and p_ci_status not in ('passing','failing','pending') then
    raise exception 'invalid ci status: %', p_ci_status using errcode = '22023';
  end if;

  update public.pull_requests
     set title      = coalesce(p_title, title),
         state      = coalesce(p_state, state),
         head_sha   = coalesce(p_head_sha, head_sha),
         ci_status  = coalesce(p_ci_status, ci_status),
         fetched_at = now(),
         updated_at = now()
   where entity_id = p_entity_id;

  return jsonb_build_object('entityId', p_entity_id, 'state', coalesce(p_state, row.state),
                            'changed', (coalesce(p_title, row.title) is distinct from row.title
                                     or coalesce(p_state, row.state) is distinct from row.state
                                     or coalesce(p_head_sha, row.head_sha) is distinct from row.head_sha
                                     or coalesce(p_ci_status, row.ci_status) is distinct from row.ci_status));
end
$$;

revoke all on function public.apply_pull_request_facts(uuid,text,text,text,text) from public;
grant execute on function public.apply_pull_request_facts(uuid,text,text,text,text) to tm8_app;

-- -----------------------------------------------------------------------------
-- C3. set_task_gate — the opt-in. Ledgered ('entities.commands.gate'), version
--     -guarded, activity-recorded: flipping the gate is a semantic command.
-- -----------------------------------------------------------------------------
create or replace function public.set_task_gate(
  p_task_id uuid, p_expected_version integer, p_gate text,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.commands.gate');
  if replay is not null then return replay; end if;
  if p_gate not in ('none', 'pr_merged') then
    raise exception 'invalid completion gate: %', p_gate using errcode = '22023';
  end if;
  select * into e from public.entities where id = p_task_id and kind = 'task' and deleted_at is null for update;
  if e.id is null then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_task_id, p_expected_version);

  update public.tasks set completion_gate = p_gate, updated_at = now()
   where entity_id = p_task_id;

  -- 'updated' is the closest member of 003's CLOSED verb set (062's
  -- 'restored' precedent); the summary carries the precise action.
  activity_id := internal.record_activity(e.space_id, p_task_id, actor, 'updated', null,
                   jsonb_build_object('action', 'gate_set', 'gate', p_gate));
  return internal.ledger_record(p_client_mutation_id, 'entities.commands.gate',
           internal.command_result(p_task_id, null, activity_id, array[p_task_id]));
end
$$;

revoke all on function public.set_task_gate(uuid,integer,text,uuid,text) from public;
grant execute on function public.set_task_gate(uuid,integer,text,uuid,text) to tm8_app;

-- -----------------------------------------------------------------------------
-- C4. complete_task — 007:1807 body VERBATIM plus the opt-in gate check,
--     inserted immediately after the acceptance-criteria gate it parallels.
--     A task whose gate is 'none' (the default, and every existing row) takes
--     exactly the old path.
--
--     'pr_merged' refuses when:
--       * no `tracks`-linked pull request exists (a gate demanding PR facts
--         with no PR to read is unsatisfiable — refusing is the honest answer
--         rather than completing vacuously), or
--       * any tracked PR is not merged, or reports ci_status = 'failing'.
--     ci_status NULL is "unknown" and does not refuse.
-- -----------------------------------------------------------------------------
create or replace function public.complete_task(
  p_task_id uuid, p_expected_version integer, p_completer_ids uuid[] default '{}'::uuid[],
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  completer uuid;
  task public.tasks;
  activity_id uuid;
  patches uuid[];
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.commands.complete');
  if replay is not null then return replay; end if;
  select * into e from public.entities where id = p_task_id and kind = 'task' and deleted_at is null for update;
  if e.id is null then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_task_id, p_expected_version);

  select * into task from public.tasks where entity_id = p_task_id;
  if task.work_status = 'done' then
    raise exception 'task is already complete' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(task.acceptance_criteria) c
     where not coalesce((c ->> 'done')::boolean, false)
  ) then
    raise exception 'all acceptance criteria must be complete first' using errcode = '23514';
  end if;

  -- 082: the opt-in git-facts gate. See C4 header for the refusal conditions.
  if task.completion_gate = 'pr_merged' then
    if not exists (
      select 1 from public.edges ed
        join public.pull_requests pr on pr.entity_id = ed.dst_id
       where ed.src_id = p_task_id and ed.type = 'tracks'
    ) then
      raise exception 'completion gate pr_merged: no tracked pull request on this task'
        using errcode = '23514', detail = '{"reason":"gate_no_tracked_pr"}';
    end if;
    if exists (
      select 1 from public.edges ed
        join public.pull_requests pr on pr.entity_id = ed.dst_id
       where ed.src_id = p_task_id and ed.type = 'tracks'
         and (pr.state <> 'merged' or pr.ci_status = 'failing')
    ) then
      raise exception 'completion gate pr_merged: a tracked pull request is unmerged or CI-red'
        using errcode = '23514', detail = '{"reason":"gate_pr_unmerged_or_ci_red"}';
    end if;
  end if;

  patches := array[p_task_id];
  update public.tasks set work_status = 'done', updated_at = now() where entity_id = p_task_id;

  foreach completer in array coalesce(p_completer_ids, '{}'::uuid[]) loop
    if not exists (
      select 1 from public.entities c
       where c.id = completer and c.space_id = e.space_id
         and c.kind in ('member','team_member') and c.deleted_at is null
    ) then
      raise exception 'invalid completer %', completer using errcode = '23503';
    end if;
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (e.space_id, p_task_id, completer, 'completed_by', actor)
    on conflict (src_id, dst_id, type) do nothing;
    -- The award is idempotent per (command, completer): a retry of the same
    -- completion cannot pay twice, which is why the key includes both.
    insert into public.point_events(space_id, entity_id, actor_id, amount, reason, ref_id, client_event_id)
    select e.space_id, completer, actor, task.points_estimate, 'award', p_task_id,
           case when p_client_mutation_id is null then null
                else p_client_mutation_id || ':award:' || completer::text end
     where coalesce(task.points_estimate, 0) > 0
    on conflict (client_event_id) do nothing;
    patches := patches || completer;
  end loop;

  activity_id := internal.record_activity(e.space_id, p_task_id, actor, 'completed', null,
                   jsonb_build_object('completerIds', to_jsonb(coalesce(p_completer_ids, '{}'::uuid[]))));
  return internal.ledger_record(p_client_mutation_id, 'entities.commands.complete',
           internal.command_result(p_task_id, null, activity_id, patches));
end
$$;

reset role;
