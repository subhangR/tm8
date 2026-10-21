-- =============================================================================
-- 359: end a credential login terminal's work session once its login is over.
--
-- A credential work session (session_kind 'credential', a vendor login
-- terminal) is minted `spawning` by start_credential_session (083/183) or
-- start_space_credential_login (206/239), with NO node_id (D5). Until this
-- change nothing ever moved it out of `spawning`:
--
--   * the close path stamps credential_sessions.finished_at and nothing else
--     (finish_credential_session, finish_space_credential_login — R7);
--   * the PTY-exit sink has no captured claims for a login terminal, so it
--     writes nothing;
--   * boot ghost reconciliation and the lost-session reaper list candidates BY
--     node_id, which a login terminal never has.
--
-- Measured on a single-node install 2026-10-19: twelve "Connect github /
-- anthropic / openai / hermes" rows still `spawning` since 2026-09-06..14, every
-- one with credential_sessions.finished_at already stamped.
--
-- The server now records the ending itself on every close path, under the
-- member's own claims (credential-sessions.ts). This sweep is the backstop for
-- what that cannot reach: rows written before it shipped, a close whose
-- ending write failed, and a node that died holding a terminal.
--
-- WHEN A ROW IS OVER. A login terminal's lease is credential_sessions, not a
-- node. `expires_at` (TTL clamped to [60, 1800] s) is when the owning node's
-- registry sweep kills the terminal, and a node that died took its PTY with
-- it, so past `expires_at` no terminal for the row is running anywhere.
-- `finished_at` is NOT enough on its own: a manager's delete or a member's
-- reclaim on ANOTHER node can stamp it while the owning node's PTY still runs
-- until that node's own expiry. So a row is reaped only when, older than the
-- grace:
--
--   * its lease ran out (expires_at < now() - grace), finished or not, or
--   * it has no login row at all (the mint writes both in one transaction, so
--     only a hand delete gets here).
--
-- A login still inside its lease is never touched, whichever node holds it.
-- Finished logins are ended at once by the server's own close; this only
-- catches what that missed.
--
-- THE ENDING. `failed / lost`, the process fact the lost-session reaper writes
-- (299): the record said live and no process exists for it. Boot auto-resume
-- acts only on `server_restart` agent sessions on its own node, and resume
-- refuses a session with no Teammate, so a reaped login terminal is never
-- brought back. Same write as credential_binding_sweep (273): status, ending
-- and exited_at under the transition guard, entities.version bumped.
--
-- Node admin only, like credential_binding_sweep: login terminals belong to
-- every member, and the node's background identity is not a member of every
-- space. FOR UPDATE SKIP LOCKED, so two nodes sweeping together reap a row once.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function public.credential_session_ending_sweep(
  p_grace interval default interval '10 minutes', p_limit integer default 200
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_reaped uuid[];
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_grace interval := greatest(coalesce(p_grace, interval '10 minutes'), interval '1 minute');
begin
  if not internal.is_node_admin() then
    raise exception 'node admin required' using errcode = '42501';
  end if;

  with stale as (
    select ws.entity_id
      from public.work_sessions ws
      join public.entities e on e.id = ws.entity_id and e.deleted_at is null
      left join public.credential_sessions cs on cs.work_session_id = ws.entity_id
     where ws.session_kind = 'credential'
       and ws.status in ('spawning', 'running', 'idle')
       and ws.status_changed_at < now() - v_grace
       and (cs.work_session_id is null or cs.expires_at < now() - v_grace)
     order by ws.entity_id
     limit v_limit
     for update of ws skip locked
  )
  select coalesce(array_agg(entity_id), array[]::uuid[]) into v_reaped from stale;

  if cardinality(v_reaped) > 0 then
    perform set_config('tm8.work_session_transition', 'on', true);
    update public.work_sessions
       set status = 'failed',
           error = coalesce(error, 'credential session ending sweep: the login terminal ended '
                                   || 'without its work session recording it'),
           ended_kind = coalesce(ended_kind, 'lost'),
           ended_reason = coalesce(ended_reason, 'Closed: this login terminal had already ended. '
                                   || 'If the account is not connected, connect it again.'),
           exited_at = coalesce(exited_at, now())
     where entity_id = any(v_reaped);
    perform set_config('tm8.work_session_transition', 'off', true);
    update public.entities
       set version = version + 1, activity_at = now(), updated_at = now()
     where id = any(v_reaped);
  end if;

  return jsonb_build_object('reaped', to_jsonb(v_reaped));
end
$$;

revoke all on function public.credential_session_ending_sweep(interval, integer) from public;
grant execute on function public.credential_session_ending_sweep(interval, integer) to tm8_app;

reset role;
