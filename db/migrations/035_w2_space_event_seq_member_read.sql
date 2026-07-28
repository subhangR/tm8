-- =============================================================================
-- public.space_event_seq — make the durable high-water mark READABLE by the
-- role the server actually connects as, without inventing a new visibility rule.
--
-- NO MIGRATION NUMBER APPEARS IN THIS FILE, BY NAME OR IN ITS TEXT. The
-- coordinator assigns it at landing; nothing here depends on the number.
--
-- -----------------------------------------------------------------------------
-- 1. THE DEFECT
-- -----------------------------------------------------------------------------
-- PgDurableSeqSource.latest (packages/server/src/events/seq.ts:124-134) issues
--
--     select last_seq from public.space_event_seq where space_id = $1
--
-- as tm8_app and fails outright:
--
--     permission denied for table space_event_seq
--
-- The table is created by the read-model migration and never granted to
-- tm8_app. It is a TABLE, not a sequence, despite the name — verified from
-- pg_class.relkind = 'r', not inferred from the identifier.
--
-- -----------------------------------------------------------------------------
-- 2. WHY THE OBVIOUS ONE-LINE FIX IS STRICTLY WORSE THAN THE DEFECT
-- -----------------------------------------------------------------------------
-- READ THIS BEFORE REDUCING THIS FILE TO ITS `grant` LINE.
--
-- The RLS migration enables row security on public.space_event_seq and
-- deliberately gives it ZERO POLICIES, alongside accounts, auth_sessions,
-- command_ledger, notification_outbox and undo_tokens: "RLS is enabled with
-- zero policies, which means zero rows for tm8_app". Verified live rather than
-- read off the file — pg_class.relrowsecurity = t and pg_policy holds no row
-- for this table.
--
-- RLS-enabled-with-no-policy denies every row REGARDLESS of the grant. So a
-- grant-only fix does not make the read work. It converts
--
--     a loud, immediate, unambiguous "permission denied"
-- into
--     a silent zero rows.
--
-- and PgDurableSeqSource.latest documents 0 as "this space has never had an
-- event" (seq.ts:130). The caller cannot tell the two apart. A reconnecting
-- client told the log is at 0 replays a space it is already caught up on.
--
-- That is a plausible wrong answer where there used to be an honest failure —
-- the dishonest-surface class this codebase removes on sight. The grant is
-- therefore necessary and NOT sufficient, and the policy below is the half that
-- makes the grant safe to add.
--
-- -----------------------------------------------------------------------------
-- 3. THE POLICY, AND WHY THIS PREDICATE AND NOT ANOTHER
-- -----------------------------------------------------------------------------
-- The counter carries exactly two columns, space_id and last_seq. There is no
-- recipient column, so the personal-event half of workspace_events_select has
-- nothing to address here and is deliberately not copied.
--
-- What remains is workspace_events_select's SPACE half, unchanged:
--
--     using (internal.is_space_member(space_id))
--
-- This is the same predicate, verbatim, that already guards tracking_refresh_-
-- select, and the space half of spaces_select. Reusing it is the point: the
-- high-water mark of a space's event log must be visible to exactly the callers
-- who may read that space's events, and no reader may diverge from the
-- subscription authorizer. A bespoke predicate here would be a second, quietly
-- different answer to "who may see this space's event stream".
--
-- internal.is_space_member is SECURITY DEFINER and already returns false for an
-- unbound caller (it tests internal.identity_id() is not null before the
-- exists), so an identity-less tm8_app connection reads nothing. That is
-- checked below rather than assumed.
--
-- No INSERT/UPDATE/DELETE policy and no write grant: the counter is advanced
-- only by internal.next_event_seq, which is SECURITY DEFINER and runs as the
-- owner. Granting writes here would widen the surface for no caller.
-- =============================================================================

set role tm8_graph_owner;

-- The grant. Necessary, and on its own not sufficient — see section 2.
grant select on public.space_event_seq to tm8_app;

-- The half that makes the grant mean something. Without this the table is
-- RLS-enabled with no policy and every select returns zero rows.
create policy space_event_seq_select on public.space_event_seq for select to tm8_app
  using (internal.is_space_member(space_id));

comment on table public.space_event_seq is
  'Per-space durable high-water mark for workspace_events.seq. Advanced only by '
  'internal.next_event_seq (SECURITY DEFINER, runs as owner); tm8_app holds '
  'SELECT only. Read authorization is internal.is_space_member(space_id) -- the '
  'same predicate as workspace_events_select and the subscription authorizer, so '
  'the mark can never be visible to a caller who may not read the events it '
  'counts. Read via PgDurableSeqSource rather than max(seq) from '
  'workspace_events because retention pruning deletes events and a mark derived '
  'from a pruned table would move BACKWARD.';

reset role;
