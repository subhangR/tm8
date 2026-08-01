-- 062 — session resume: native agent-session identity + the resurrection RPC.
--
-- Maestro-style resume (the proven design this ports): the provider-owned
-- conversation id — Claude Code's session uuid, Codex's rollout id — is what
-- `claude --resume <uuid>` / `codex resume <id>` need to restore a
-- conversation. tm8 captured none of it. This migration adds the storage and
-- the one legal path back from a terminal status.
--
-- `native_session_id` is WRITE-ONCE (execution_record_native_session refuses to
-- overwrite a non-null value): the id names one provider conversation for the
-- whole life of the session, across every resume. Claude ids are pre-minted by
-- SpawnService and recorded at spawn; Codex ids are captured from the rollout
-- file under ~/.codex/sessions at first resume.
--
-- R29 note — execution_resume is deliberately a SECOND function, not a new arm
-- in work_session_transition. The transition function's law ("exited/failed
-- are sinks, nothing re-enters spawning") stays exactly as 043 wrote it, so
-- every existing caller keeps the invariant it was audited against. Resume is
-- the one named exception, with its own ledger operation, its own activity
-- verb, and the same single-writer guard flag the transition function uses.

alter table public.work_sessions add column if not exists native_session_id text;

-- --- capture -----------------------------------------------------------------

create or replace function public.execution_record_native_session(
  p_session_id uuid, p_native_session_id text, p_actor_id uuid default null
) returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
begin
  if p_native_session_id is null or length(trim(p_native_session_id)) = 0 then
    raise exception 'native session id must not be empty' using errcode = '22023';
  end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);

  -- Write-once. A second, different id arriving here is a capture bug upstream
  -- (two rollouts claiming one session), and silently replacing the first id
  -- would re-point every future resume at a different conversation.
  update public.work_sessions
     set native_session_id = trim(p_native_session_id)
   where entity_id = p_session_id and native_session_id is null;
  return found;
end
$$;

revoke all on function public.execution_record_native_session(uuid, text, uuid) from public;
grant execute on function public.execution_record_native_session(uuid, text, uuid) to tm8_app;

-- --- resume ------------------------------------------------------------------

create or replace function public.execution_resume(
  p_session_id uuid, p_session_cap integer default 8,
  p_actor_id uuid default null, p_client_mutation_id text default null,
  p_node_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  member_id uuid;
  current_status text;
begin
  -- W2.SEC-1, both halves. A resume is a command like prompt/terminate, so it
  -- owes the same replay law record_execution_command obeys (041): a stored
  -- result may go back only to the principal that recorded it, and only to a
  -- request addressing the SAME session. Without the subject binding, a
  -- clientMutationId recorded against session A and replayed while addressing
  -- session B returns A's projection — the caller named B and received A.
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.resume');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD. The
    -- subject binding needs the stored projection, so it can only live here.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_session_id::text, 'work session');
    return replay || jsonb_build_object('__tm8_replayed', true);
  end if;

  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  -- Same persona authorization as spawn: resuming a session re-runs its
  -- Teammate, so the caller must be allowed to act as that Teammate.
  select dst_id into member_id
    from public.edges
   where src_id = p_session_id and type = 'relates_to'
   limit 1;
  if member_id is not null and not internal.can_act_as(member_id, e.space_id) then
    raise exception 'not permitted to resume this persona' using errcode = '42501';
  end if;

  select status into current_status
    from public.work_sessions where entity_id = p_session_id for update;
  if current_status not in ('exited', 'failed') then
    raise exception 'work session is not resumable from status %', current_status
      using errcode = '23514';
  end if;

  -- A resumed session is a live agent again — it counts against the same cap
  -- spawn enforces, or resume becomes the unmetered way around it.
  if internal.live_work_session_count(null) >= greatest(coalesce(p_session_cap, 8), 1) then
    raise exception 'session concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_session_cap,
                                  'live', internal.live_work_session_count(null))::text;
  end if;

  -- The exit evidence (exit_code/error/exited_at) belongs to the PREVIOUS run;
  -- leaving it on a session now spawning again would read as a live agent that
  -- somehow also died. The next exit writes fresh evidence through the normal
  -- single-writer path.
  --
  -- node_id moves WITH the resume. The row names the node that owns the live
  -- PTY, and after this call that is the node resuming — which need not be the
  -- node that first spawned it. Leaving the old value would make startup ghost
  -- reconciliation on node A list a session whose PTY is on node B, find no
  -- local PTY, and retire a genuinely running agent. `coalesce` so a caller
  -- that does not know its node id leaves the existing value alone rather than
  -- nulling it.
  perform set_config('tm8.work_session_transition', 'on', true);
  update public.work_sessions
     set status = 'spawning', exit_code = null, error = null, exited_at = null,
         node_id = coalesce(p_node_id, node_id)
   where entity_id = p_session_id;
  perform set_config('tm8.work_session_transition', 'off', true);

  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_session_id;

  -- 'restored' is the closest member of activity's CLOSED verb set (003's
  -- activity_verb_check) — a resume literally restores a terminal session to
  -- life. The summary carries the precise action for any consumer that needs
  -- to distinguish it from an entities.restore soft-delete reversal.
  return internal.ledger_record(p_client_mutation_id, 'execution.resume',
           internal.command_result(p_session_id, null,
             internal.record_activity(e.space_id, p_session_id, actor, 'restored', null,
               jsonb_build_object('kind', 'work_session', 'action', 'resumed',
                                  'fromStatus', current_status)),
             array[p_session_id])) || jsonb_build_object('__tm8_replayed', false);
end
$$;

revoke all on function public.execution_resume(uuid, integer, uuid, text, text) from public;
grant execute on function public.execution_resume(uuid, integer, uuid, text, text) to tm8_app;
