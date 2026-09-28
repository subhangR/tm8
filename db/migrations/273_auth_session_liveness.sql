-- =============================================================================
-- 273 (provisional; set at the merge position after main 79efe3fb3's 272) —
-- which of these sessions have ended (P7, task 01a0db30-b2f9, lane L2a).
--
-- An event socket authenticates once, at upgrade. Before this, nothing looked
-- at its session again: only `auth.sessions.revoke` (W4) and W1's membership
-- end closed sockets, each from its own call site. Logout, the 249 cascade to
-- pinned children, W5's space-password resets, the W6 link revokes (login
-- replace, logout, remove, stale, the members trigger) and expiry all end a
-- session in SQL and left its sockets open until they dropped.
--
-- The server now re-verifies every open socket's session once per event-pump
-- tick, in ONE call to this function with the set of distinct session ids,
-- and closes the sockets of every id it returns. The predicate lives here, in
-- one place, so every present and future revoke path is covered by writing
-- `revoked_at` — no call site has to remember to close anything.
--
-- ENDED means the session no longer authenticates, OR its pinned space no
-- longer admits it:
--   * no row (pruned), `revoked_at` set, `expires_at` passed, or the account is
--     not `active` — exactly the negation of `resolve_auth_session` (256:179);
--   * the session is pinned (`space_id` set: a W3 pinned human session, an
--     agent / agent_runtime session, or a W6 link session, whose space is the
--     link TARGET) and the account's member row for that space is `left` or
--     `removed` (232). A MISSING member row is not "ended": this function
--     reports memberships that ended, it does not re-decide admission, which
--     stays with the per-request claims and RLS.
--
-- COST: one statement per tick, keyed by the ids — `unnest` joined on the
-- auth_sessions primary key, the accounts primary key and members'
-- `unique (space_id, identity_id)` (002:100). Never a scan, never per socket.
--
-- CLAIM-FREE, like `resolve_auth_session`: the sweep runs outside any request
-- and has no caller identity. It returns only ids it was given, and says only
-- "ended"; no token, hash, owner or space leaves SQL. The facade exposes no
-- operation that reaches it.
--
-- SHARED-OBJECT REGISTER: redefines or alters NOTHING. One new function.
-- =============================================================================

set role tm8_graph_owner;

create or replace function public.ended_auth_sessions(p_session_ids uuid[])
returns uuid[]
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select coalesce(array_agg(ids.id), '{}')
    from (select distinct unnest(p_session_ids) as id) ids
    left join public.auth_sessions s on s.id = ids.id
    left join public.accounts a on a.id = s.account_id
   where ids.id is not null
     and (s.id is null
          or s.revoked_at is not null
          or s.expires_at <= now()
          or a.status is distinct from 'active'
          or (s.space_id is not null and exists (
                select 1 from public.members m
                 where m.space_id = s.space_id
                   and m.identity_id = a.identity_id
                   and m.status in ('left', 'removed'))))
$$;

comment on function public.ended_auth_sessions(uuid[]) is
  'P7 (273): the subset of p_session_ids that no longer authenticate (missing, '
  'revoked, expired, account not active) or whose pinned space membership is '
  'left/removed. The event pump calls it once per tick and closes those '
  'sessions'' sockets. Claim-free; returns only the ids it was given.';

revoke all on function public.ended_auth_sessions(uuid[]) from public;
grant execute on function public.ended_auth_sessions(uuid[]) to tm8_app;

reset role;
