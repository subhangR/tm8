-- =============================================================================
-- 109 — an agent bearer dies with its agent (2026-08-12).
--
-- ── THE REGRESSION BEING REPAIRED ─────────────────────────────────────────
--
-- `072_session_io_routes.sql:36-59` defined `resolve_auth_session` with an
-- explicit liveness clause and an explicit rationale:
--
--     "a work-session token is valid only while that exact session is live.
--      Terminal sessions therefore lose authority immediately without relying
--      on a cleanup job"
--
--     and (s.work_session_id is null
--          or exists (select 1 from public.work_sessions ws
--                      where ws.entity_id = s.work_session_id
--                        and ws.status in ('spawning','running','idle')))
--
-- `074_agent_session_credentials.sql:26-41` redefines the same function — to
-- add `workSessionId` to the projection — and OMITS that clause. 074 is the last
-- definition in the chain, so it is what runs, and an agent bearer has outlived
-- its work session ever since.
--
-- ── WHY THIS COULD NOT BE FIXED IN PHASE 0, AND CAN BE NOW ────────────────
--
-- Restoring the clause makes "mark this session exited" equivalent to "revoke
-- this session's agent credential". While `work_session_transition` was gated
-- on `require_space_member` alone, that handed EVERY MEMBER of a space a
-- one-call revocation of any other member's live agent — trading a
-- credential-lifetime bug for a denial of service.
--
-- 108 split that transition: `exited`/`failed` now require `manage`. So the
-- people who can end a session are exactly the people who could already
-- terminate it, and the clause is safe to restore. This ordering was designed
-- for in Phase 0 and is the reason this migration is 109 rather than 100.
--
-- ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
--
-- It does not yet cap an agent's reach to its own spawn tree. That needs a
-- verified `tm8.auth_session_id` claim bound by the server, and is deliberately
-- left to its own change rather than smuggled in here — an agent bearer still
-- carries its spawner's full identity while it is alive.
-- =============================================================================
set role tm8_graph_owner;

create or replace function public.resolve_auth_session(p_token_hash text)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'sessionId', s.id, 'accountId', a.id, 'identityId', a.identity_id,
    'username', a.username, 'displayName', a.display_name,
    'isNodeAdmin', a.is_node_admin, 'isOwner', a.is_owner,
    'kind', s.kind, 'actingAsTeamMemberId', s.acting_as_team_member_id,
    'workSessionId', s.work_session_id,
    'expiresAt', s.expires_at, 'label', s.label)
    from public.auth_sessions s
    join public.accounts a on a.id = s.account_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and a.status = 'active'
     -- 072's clause, restored verbatim in meaning. A browser or CLI session has
     -- no work session and is unaffected; an AGENT token is authority only for
     -- as long as the agent it was minted for is actually running.
     and (s.work_session_id is null
          or exists (select 1 from public.work_sessions ws
                      where ws.entity_id = s.work_session_id
                        and ws.status in ('spawning','running','idle')))
$$;

-- An agent session that names no work session could never be liveness-checked,
-- so the clause above would silently treat it as a human bearer. Both minting
-- RPCs already set it; this makes that a guarantee rather than a convention.
--
-- Written as NOT VALID + VALIDATE so a node with legacy rows is told about them
-- rather than refused an upgrade: VALIDATE takes a lighter lock and reports
-- exactly which rows are wrong.
alter table public.auth_sessions
  add constraint auth_sessions_agent_names_a_session
  check (kind <> 'agent' or work_session_id is not null) not valid;
alter table public.auth_sessions validate constraint auth_sessions_agent_names_a_session;

reset role;
