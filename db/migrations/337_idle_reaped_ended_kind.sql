-- =============================================================================
-- 337: a session the idle reaper stopped says so — `ended_kind = 'idle_reaped'`.
--
-- The idle reaper (TM8_SESSION_IDLE_REAP_MINUTES) ends an idle agent's process
-- to give its memory back; the conversation is kept and resume restores it.
-- Until now it ended the row as a bare terminate, `stopped_by_operator`, which
-- is byte-identical to a person pressing Stop. The node resumes a session on
-- demand (a user opens it, types into it, or a message arrives for it) only
-- when nothing but the node itself stopped it, so the two must be told apart.
--
-- Adds the kind to the CHECK and to work_session_transition's allow-list; the
-- function is otherwise 302's, unchanged.
-- =============================================================================

alter table public.work_sessions drop constraint work_sessions_ended_kind_check;
alter table public.work_sessions add constraint work_sessions_ended_kind_check
  check (ended_kind is null or ended_kind in (
    'exited_clean', 'stopped_by_operator', 'server_restart', 'out_of_memory',
    'crashed', 'unknown', 'container_stopped', 'runtime_lost',
    'lost', 'credential_revoked', 'idle_reaped'));

create or replace function public.work_session_transition(
  p_session_id uuid, p_status text, p_exit_code integer default null, p_error text default null,
  p_transcript_doc_id uuid default null, p_client_mutation_id text default null,
  p_ended_kind text default null, p_ended_reason text default null)
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
       'container_stopped','runtime_lost','lost','credential_revoked','idle_reaped') then
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
         ended_kind = case when p_status in ('exited','failed')
                           then coalesce(v_kind, ended_kind) else ended_kind end,
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

