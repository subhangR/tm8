-- 169 — WHY A SESSION ENDED, in a form a human can read.
--
-- Incident 2026-08-22 11:04:16 UTC: a deploy SIGKILLed the server with four
-- live agents. All four were retired as ordinary `exited` rows and the event
-- was invisible in the graph — because the ONLY fields a client can see are
-- `status` and `exited_at`. `exit_code` was NULL (it always is on that path:
-- `kill()` cannot wait for node-pty's async exit event), and `error` — which
-- did carry an accurate reason — is not projected into the contract at all.
--
-- PR #510 made the STATUS honest ('failed', not 'exited'). This makes the
-- REASON legible. Two columns, because they answer two different questions:
--
--   ended_kind    — WHAT CLASS of ending, for code. A closed vocabulary, so a
--                   client can branch (and so an OOM kill stays recognisable
--                   rather than folded in with every other ending).
--   ended_reason  — WHY, for a person. One plain-English sentence. "Stopped by
--                   a server restart at 11:04." Never a signal number, never a
--                   stack trace, never the word SIGKILL.
--
-- WHY NOT REUSE `error`. `error` is the technical diagnostic and stays exactly
-- as it is. It is also semantically wrong for the happy path: a session that
-- finished its work has no error, but it does have a reason ("Finished on its
-- own."), and a human reading a session list deserves that sentence too. One
-- column cannot be both "something went wrong" and "here is what happened".
--
-- NULLABLE, NEVER DEFAULTED — 107's rule. NULL means no ending fact was
-- captured: a pre-169 row, or a session still running. NULL must render as no
-- claim. Inventing "Finished normally" for a row nobody measured is exactly the
-- lie this migration exists to end.

alter table public.work_sessions add column if not exists ended_kind text;
alter table public.work_sessions add column if not exists ended_reason text;

do $$ begin
  alter table public.work_sessions add constraint work_sessions_ended_kind_check
    check (ended_kind is null or ended_kind in (
      'completed', 'stopped_by_operator', 'server_restart',
      'out_of_memory', 'crashed', 'unknown'));
exception when duplicate_object then null; end $$;

comment on column public.work_sessions.ended_kind is
  'What class of ending this was, for code to branch on. NULL = never '
  'captured (pre-169 row, or still running) and must render as no claim. '
  '''out_of_memory'' is kernel evidence from the cgroup oom_kill counter, not '
  'an inference from a signal number — it is the one involuntary death policy '
  'permits, so it must stay distinguishable from every other ending.';

comment on column public.work_sessions.ended_reason is
  'ONE PLAIN-ENGLISH SENTENCE for a person: "Stopped by a server restart at '
  '11:04." The reader is not a developer. Never a signal name, exit code, or '
  'stack trace — those live in `error`, which is unchanged and remains the '
  'technical diagnostic. Projected additively as contract `endedReason`.';

-- --- the single writer learns two more facts ---------------------------------
--
-- `work_session_transition` is R29's SINGLE WRITER of status (001's trigger
-- enforces it), so the ending facts must be written by the same call that
-- writes the terminal status — anything else could interleave and leave a row
-- whose status and reason disagree about the same event.
--
-- The old 6-arg signature is DROPPED rather than left beside the new one:
-- Postgres would treat a 7th defaulted parameter as an overload, and a
-- positional 6-arg call would then raise 'function is not unique' rather than
-- resolving. Every caller passes positionally.
--
-- coalesce(), like the exit_code/error arguments beside them: a later
-- transition that says nothing about the ending must not erase what an earlier
-- one measured.

drop function if exists public.work_session_transition(uuid, text, integer, text, uuid, text);

create or replace function public.work_session_transition(
  p_session_id uuid, p_status text, p_exit_code integer default null,
  p_error text default null, p_transcript_doc_id uuid default null,
  p_client_mutation_id text default null, p_ended_kind text default null,
  p_ended_reason text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  current_status text;
  allowed boolean;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.transition');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  if p_status not in ('spawning','running','idle','exited','failed') then
    raise exception 'invalid work_session status: %', p_status using errcode = '22023';
  end if;
  if p_ended_kind is not null and p_ended_kind not in (
       'completed','stopped_by_operator','server_restart',
       'out_of_memory','crashed','unknown') then
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
         exit_code = coalesce(p_exit_code, exit_code),
         error = coalesce(p_error, error),
         transcript_doc_id = coalesce(p_transcript_doc_id, transcript_doc_id),
         -- The ending facts are only meaningful on a terminal status. A
         -- running/idle transition carrying them would be a caller bug, and
         -- silently storing them would date-stamp an ending that never
         -- happened.
         ended_kind = case when p_status in ('exited','failed')
                           then coalesce(p_ended_kind, ended_kind) else ended_kind end,
         ended_reason = case when p_status in ('exited','failed')
                             then coalesce(p_ended_reason, ended_reason) else ended_reason end,
         started_at = case when p_status = 'running' then coalesce(started_at, now()) else started_at end,
         exited_at = case when p_status in ('exited','failed') then coalesce(exited_at, now()) else exited_at end
   where entity_id = p_session_id;
  perform set_config('tm8.work_session_transition', 'off', true);

  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_session_id;

  return internal.ledger_record(p_client_mutation_id, 'execution.transition',
           internal.command_result(p_session_id, null, null, array[p_session_id]));
end
$$;

-- 008's blanket `grant execute on all functions in schema public to tm8_app`
-- ran once, at 008. A function created later — or recreated under a NEW
-- signature, as here — is not covered by it and must be granted explicitly,
-- or every caller gets a bare permission denied at runtime.
grant execute on function public.work_session_transition(
  uuid, text, integer, text, uuid, text, text, text) to tm8_app;

-- --- resume clears the ending, exactly as it clears the rest of it ------------
--
-- 062's rule: the exit evidence belongs to the PREVIOUS run. It already nulls
-- exit_code/error/exited_at on resume; the two new facts are the same kind of
-- fact and must go with them. Leaving a stale "Stopped by a server restart"
-- on a session that is running again is precisely the sort of lie 169 exists
-- to remove — and it is why the 11:04 incident showed only two of its four
-- rows by the time anyone looked.

-- A TRIGGER, not a patch to `execution_resume`. Copying 062's 90-line function
-- in here to add two NULLs would freeze a snapshot of it that silently drifts
-- the next time resume changes — and the invariant is not "resume clears the
-- ending", it is "ANY path back to a live status clears it". A row that is
-- spawning again must not still claim it was stopped by a restart, whoever put
-- it there.
--
-- Ordering: this fires BEFORE `work_sessions_guard_status` (001) — trigger
-- order on the same event is alphabetical, and 'c' precedes 'g'. The guard is
-- untouched and still refuses any status write not coming through the single
-- writer.

create or replace function internal.clear_ending_on_respawn() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.status = 'spawning' and old.status is distinct from 'spawning' then
    new.ended_kind := null;
    new.ended_reason := null;
  end if;
  return new;
end
$$;

drop trigger if exists work_sessions_clear_ending_on_respawn on public.work_sessions;
create trigger work_sessions_clear_ending_on_respawn
  before update of status on public.work_sessions
  for each row execute function internal.clear_ending_on_respawn();
