-- =============================================================================
-- NNN (placeholder; number assigned by the coordinator at merge) — "was this session id ever issued HERE?" for the named-Server relay
-- (task 01a0da1f, follow-up to W0b / PR #817).
--
-- THE GAP. The relay (http/remote-proxy.ts `resolveRelayCaller`) forwards an
-- `Authorization` that does not resolve on this node, because that is what a
-- remote's pass looks like. A LOCAL token that is revoked or expired does not
-- resolve either, so it was forwarded to the remote too — next to a live
-- cookie, and with no cookie on a loopback node with the auto-owner on. Both
-- are `tm8s_<uuid>.<secret>`; the format cannot tell them apart. The session
-- id can: if this node ever issued it, in any state, the token is ours and
-- never leaves.
--
-- WHY A DEFINER. `auth_sessions` has no grant for tm8_app (007/008), and the
-- question is asked before any identity is known — the relay is deciding what
-- to do with a credential that did NOT authenticate — so it is claim-free, like
-- resolve_auth_session (007) and resolve_node_owner (142).
--
-- WHAT IT EXPOSES. One boolean per uuid: whether a session row with that id
-- exists. It takes the session id only, never the secret or its hash, and
-- returns nothing about the row. Session ids are random uuids; the answer
-- names no account and authenticates nothing. tm8_app only; PUBLIC is locked
-- out as 116/142 do.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function public.auth_session_issued_here(p_session_id uuid)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select exists (select 1 from public.auth_sessions s where s.id = p_session_id)
$$;

comment on function public.auth_session_issued_here(uuid) is
  'Claim-free (NNN): true when this node issued the session id, in ANY state '
  '(live, revoked, expired). The relay uses it to keep a local token from being '
  'forwarded as a remote pass. Takes the id only, never a secret.';

revoke all on function public.auth_session_issued_here(uuid) from public;
grant execute on function public.auth_session_issued_here(uuid) to tm8_app;

reset role;
