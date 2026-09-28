-- =============================================================================
-- 276 (PROVISIONAL; renumbered at merge) — revoke_listed_auth_session: the
-- comment states the node-admin arm correctly (task 01a0dc09, from the #857
-- security review 5324284172).
--
-- COMMENT ONLY. The body is 249's, unchanged.
--
-- 249's comment said "(gate only) node admin". "Gate only" describes the
-- CALLER, not the target: internal.is_node_admin() is false under a pin (233
-- K6), so only an unpinned node admin gets that arm. Such a caller may revoke
-- ANY target session id — any account, any auth kind, gate or pinned — and
-- has no matching list arm in list_auth_sessions, so a 200 vs 404 answers
-- whether an id exists.
-- =============================================================================

comment on function public.revoke_listed_auth_session(uuid) is
  'auth.sessions.revoke (249, plan W4; comment 276). Allowed: the caller''s '
  'own session; a session pinned to a space the caller administers; or, for '
  'an unpinned node admin (the arm is off under a pin, 233 K6), ANY session '
  'id — any account, any kind, gate or pinned — with no matching list arm, so '
  'it can tell an existing id (200) from a missing one (404). A pinned caller '
  'reaches only sessions pinned to its own space. Cascades to children; '
  'returns every id it revoked. Humans only.';
