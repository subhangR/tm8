-- =============================================================================
-- 379  THE BOOT OF A LAUNCH, RECORDED ON ITS ROW (task 01a182d2-7217, lane C).
--
-- `execution.spawn` now answers as soon as a launch is ADMITTED — validated,
-- its slot counted, its row written, its worktree reserved — and the server
-- boots the session after answering. Whoever launched it (the launching page,
-- `tm8 session spawn`) learns how far the boot has got from the row itself,
-- through the same `entity.upsert` every row change already produces.
--
--   boot_phase     the last step the boot REACHED
--                    admitted  the row exists, its slot is counted, its workdir
--                              is reserved; the checkout is being prepared
--                    lane      the checkout (or scratch directory) is ready
--                    briefing  the manifest and the prompt are composed and recorded
--                    agent     the agent process has started; its first turn is settling
--                    live      the session is running
--                    failed    the boot failed; status, error and ended_reason say why
--   boot_phase_at  when it got there
--
-- NULL on both means a row from before this migration. Every row written from
-- now on is born `admitted` (the column defaults): every door that inserts a
-- work session — spawn, shell, tool, credential login — inserts it `spawning`,
-- which is exactly what `admitted` asserts, so no door has to change.
--
-- -----------------------------------------------------------------------------
-- THE STATE MACHINE, AND THE ONE PLACE THAT MOVES IT
-- -----------------------------------------------------------------------------
--
--   admitted → lane → briefing → agent → live      forward only; a step may be skipped
--   admitted | lane | briefing | agent → failed
--   any → admitted                                 the row is resurrected (resume)
--
-- `internal.work_session_boot_phase_next` decides every move, and one trigger
-- applies it to every UPDATE of `status` or `boot_phase`, whoever writes it:
--
--   * A STATUS CHANGE DERIVES THE PHASE, in the same row write. spawning →
--     running/idle is `live`; spawning → exited/failed is `failed`; anything →
--     spawning (resume) is `admitted`; a change after the boot (running → exited)
--     leaves the phase alone, because the boot it describes succeeded. So a boot
--     failure is on the row in the very write that records the failure, and
--     `status` and `boot_phase` can never disagree — not for
--     `work_session_transition`, not for `execution_resume`, not for the
--     membership and credential sweeps that end sessions directly.
--   * THE THREE PROGRESS STEPS (lane, briefing, agent) are REPORTED by the boot
--     through `public.work_session_transition(..., p_boot_phase)` with the
--     status unchanged. That door is already the single writer of `status`
--     (R29); it becomes the single writer of an explicit phase too, and the
--     trigger refuses any other writer the way 001's guard does for status.
--     A report the machine forbids — backwards, after the boot ended, on a row
--     that is no longer `spawning` — is refused with 23514, which is how a boot
--     learns that its session was stopped underneath it.
--
-- Runs as the migration user, like 302: `work_session_transition` is owned by
-- it (171/174), and tm8_graph_owner can neither replace nor grant on it.
-- =============================================================================

alter table public.work_sessions
  add column boot_phase text,
  add column boot_phase_at timestamptz;

-- Defaults set AFTER the add, so existing rows keep NULL ("before boot phases")
-- instead of all claiming a boot they never had.
alter table public.work_sessions
  alter column boot_phase set default 'admitted',
  alter column boot_phase_at set default now();

alter table public.work_sessions
  add constraint work_sessions_boot_phase_check check (
    boot_phase is null
    or boot_phase in ('admitted', 'lane', 'briefing', 'agent', 'live', 'failed'));

-- -----------------------------------------------------------------------------
-- 1. The machine
-- -----------------------------------------------------------------------------

/**
 * The phase a work session moves to. Pure: the trigger below is its only
 * caller, and every rule of the header's diagram is here and nowhere else.
 *
 *   p_phase           the current phase (NULL: a row from before 379)
 *   p_from, p_to      the status before and after this write
 *   p_requested       an explicit progress report, or NULL
 *
 * Returns the new phase, or raises 23514 for a report the machine forbids.
 */
create or replace function internal.work_session_boot_phase_next(
  p_phase text, p_from text, p_to text, p_requested text
) returns text language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare
  ranks constant text[] := array['admitted', 'lane', 'briefing', 'agent', 'live'];
begin
  if p_requested is null then
    if p_to is not distinct from p_from then return p_phase; end if;
    if p_to = 'spawning' then return 'admitted'; end if;
    if p_from = 'spawning' then
      return case when p_to in ('running', 'idle') then 'live' else 'failed' end;
    end if;
    -- running/idle → anything: the boot ended long ago, and well.
    return p_phase;
  end if;

  if p_to is distinct from p_from then
    raise exception 'boot_phase follows a status change; report % on its own', p_requested
      using errcode = '22023';
  end if;
  if p_requested not in ('lane', 'briefing', 'agent') then
    raise exception 'boot_phase % is derived from status, never reported', p_requested
      using errcode = '22023';
  end if;
  if p_to <> 'spawning' then
    raise exception 'illegal boot_phase report % on a % session: its boot has ended', p_requested, p_to
      using errcode = '23514', detail = 'boot_ended';
  end if;
  if p_phase is not null
     and (p_phase not in ('admitted', 'lane', 'briefing', 'agent')
          or array_position(ranks, p_requested) < array_position(ranks, p_phase)) then
    raise exception 'illegal boot_phase transition % -> %', p_phase, p_requested
      using errcode = '23514', detail = 'boot_phase_backwards';
  end if;
  return p_requested;
end
$$;

-- -----------------------------------------------------------------------------
-- 2. The one place it moves
-- -----------------------------------------------------------------------------

create or replace function internal.advance_work_session_boot_phase() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  requested text := case when new.boot_phase is distinct from old.boot_phase then new.boot_phase end;
begin
  if requested is not null
     and coalesce(internal.claim_text('tm8.work_session_transition'), '') <> 'on' then
    raise exception 'work_session.boot_phase has a single writer: the execution transition function'
      using errcode = '23514',
            detail = 'call public.work_session_transition(..., p_boot_phase) — 379';
  end if;
  new.boot_phase := internal.work_session_boot_phase_next(old.boot_phase, old.status, new.status, requested);
  if new.boot_phase is distinct from old.boot_phase then
    new.boot_phase_at := now();
  end if;
  return new;
end
$$;

create trigger work_sessions_advance_boot_phase
  before update of status, boot_phase on public.work_sessions
  for each row execute function internal.advance_work_session_boot_phase();

-- -----------------------------------------------------------------------------
-- 3. The writer: 302's work_session_transition, plus p_boot_phase
-- -----------------------------------------------------------------------------
--
-- Body unchanged from 302 except the `boot_phase` line in the UPDATE and the
-- progress-report branch at the end. A NULL p_boot_phase leaves the column as
-- it is, so the trigger derives the phase from the status; a phase with the
-- status unchanged is a progress report, which bumps neither version nor
-- activity_at and announces itself with its own `entity.upsert`.
-- Positional callers of the 8-argument form keep working: the new argument is
-- last and defaults to NULL.

drop function if exists public.work_session_transition(uuid, text, integer, text, uuid, text, text, text);

create function public.work_session_transition(
  p_session_id uuid, p_status text, p_exit_code integer default null, p_error text default null,
  p_transcript_doc_id uuid default null, p_client_mutation_id text default null,
  p_ended_kind text default null, p_ended_reason text default null,
  p_boot_phase text default null)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  current_status text;
  allowed boolean;
  v_kind text := p_ended_kind;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.transition');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  if p_status not in ('spawning','running','idle','exited','failed') then
    raise exception 'invalid work_session status: %', p_status using errcode = '22023';
  end if;
  -- 299: `completed` is the pre-299 spelling of `exited_clean`. Accepted so a
  -- server older than this migration keeps working during a deploy.
  if v_kind = 'completed' then v_kind := 'exited_clean'; end if;
  if v_kind is not null and v_kind not in (
       'exited_clean','stopped_by_operator','server_restart',
       'out_of_memory','crashed','unknown',
       'container_stopped','runtime_lost','lost','credential_revoked') then
    raise exception 'invalid work_session ended_kind: %', p_ended_kind using errcode = '22023';
  end if;

  select status into current_status from public.work_sessions where entity_id = p_session_id for update;
  allowed := case
    when current_status = p_status then true
    when current_status in ('exited','failed') then false
    when p_status = 'spawning' then false
    else true end;
  if not allowed then
    raise exception 'illegal work_session transition % -> %', current_status, p_status
      using errcode = '23514';
  end if;

  perform set_config('tm8.work_session_transition', 'on', true);
  update public.work_sessions
     set status = p_status,
         boot_phase = coalesce(p_boot_phase, boot_phase),
         exit_code = coalesce(p_exit_code, exit_code),
         error = coalesce(p_error, error),
         transcript_doc_id = coalesce(p_transcript_doc_id, transcript_doc_id),
         ended_kind = case when p_status in ('exited','failed')
                           then coalesce(v_kind, ended_kind) else ended_kind end,
         ended_reason = case when p_status in ('exited','failed')
                             then coalesce(p_ended_reason, ended_reason) else ended_reason end,
         started_at = case when p_status = 'running' then coalesce(started_at, now()) else started_at end,
         exited_at = case when p_status in ('exited','failed') then coalesce(exited_at, now()) else exited_at end
   where entity_id = p_session_id;
  perform set_config('tm8.work_session_transition', 'off', true);

  if p_boot_phase is not null and current_status = p_status then
    -- A PROGRESS REPORT moves no status, so it is not an edit of the entity:
    -- no version bump (a caller holding the admitted detail may still write
    -- with its version) and no activity_at (recency feeds do not reorder
    -- around a boot). The entities row is untouched, so its capture trigger
    -- stays silent; the change is announced here instead, as the same
    -- `entity.upsert` the trigger writes, and the mapper hydrates the
    -- session's current state — its new boot phase — from it.
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id, recipient_member_id)
    select en.space_id, internal.next_event_seq(en.space_id), 'entity.upsert', to_jsonb(en), internal.claim_cmid(), null
      from public.entities en where en.id = p_session_id;
  else
    update public.entities
       set version = version + 1, activity_at = now(), updated_at = now()
     where id = p_session_id;
  end if;

  return internal.ledger_record(p_client_mutation_id, 'execution.transition',
           internal.command_result(p_session_id, null, null, array[p_session_id]));
end
$$;

-- The DROP above makes this a NEW function, and Postgres grants EXECUTE on a
-- new function to PUBLIC; 171's comment is the full story. Revoke, then grant.
revoke all on function public.work_session_transition(
  uuid, text, integer, text, uuid, text, text, text, text) from public;
grant execute on function public.work_session_transition(
  uuid, text, integer, text, uuid, text, text, text, text) to tm8_app;
