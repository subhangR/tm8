-- =============================================================================
-- 009 — grant tm8_app EXECUTE on internal.claim_text, without which twelve of
--       008's RLS policies raise instead of filtering.
--
-- THE BUG (found by db/test/00_claim_guards.test.mjs, first read ever performed
-- as tm8_app rather than through a SECURITY DEFINER RPC):
--
--   008 grants tm8_app EXECUTE on the claim accessors its policies name —
--   internal.identity_id(), account_id(), is_node_admin(), acting_as(),
--   actor_id(). All five are SECURITY INVOKER, and all five are one-line wrappers
--   around internal.claim_text(text), which 002/007 leave owner-only. An RLS
--   policy expression is evaluated as the QUERYING role, so tm8_app calling
--   internal.identity_id() hits:
--
--     ERROR:  permission denied for function claim_text   (42501)
--
--   That is not a filtered read — it aborts the whole statement. Every policy
--   naming one of those five was affected:
--
--     spaces_select · projects_select · edge_types_select · entity_kinds_select
--     user_profiles_select · read_marks_select · notifications_select
--     workspace_events_select · saved_views_select · stream_grants_select
--     file_upload_slots_select
--
--   It went unnoticed because the RPCs are SECURITY DEFINER (they run as
--   tm8_graph_owner, for whom claim_text is executable) and because the policies
--   whose predicates are ENTIRELY definer helpers — entities_select and every
--   detail table via internal.entity_readable — worked fine. So `select * from
--   entities` passed while `select * from spaces` raised 42501, which reads like a
--   permissions bug in the caller rather than a missing grant in the schema.
--
-- THE FIX, and why it is a grant rather than SECURITY DEFINER on the accessors:
--   Reading a GUC that the caller's own transaction set is not a privilege —
--   pg_catalog.current_setting() is executable by PUBLIC already, so claim_text
--   confers nothing tm8_app cannot already do; it only adds the null-and-error
--   handling. Marking the five accessors SECURITY DEFINER would also work, but
--   would make them non-inlinable, putting an un-inlined function call in the
--   per-row predicate of the most-evaluated policies in the schema. The grant
--   keeps internal.identity_id() inlinable and the plans flat.
--
-- Forward-only: 001-008 are applied and checksum-locked elsewhere, so this ships
-- as a new file rather than an edit to 008's grant block.
-- =============================================================================
set role tm8_graph_owner;

grant execute on function internal.claim_text(text) to tm8_app;

comment on function internal.claim_text(text) is
  'Reads one transaction-local claim. Executable by tm8_app because the RLS '
  'policies in 008 evaluate internal.identity_id()/is_node_admin() AS tm8_app, '
  'and those are SECURITY INVOKER wrappers around this function (009).';

-- internal.claim_uuids(text) is deliberately NOT granted. It parses the CSV
-- claims (tm8.member_ids / team_member_ids / can_act_as), and the ratified claims
-- contract says authorization never trusts those — RLS resolves membership from
-- the tables. Nothing in `public` or in any policy references it. Leaving it
-- owner-only keeps it that way: a future policy reaching for it fails loudly here
-- instead of quietly re-introducing claim-asserted authorization.

reset role;
