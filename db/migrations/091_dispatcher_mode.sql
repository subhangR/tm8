-- =============================================================================
-- 091 — the fifth agent mode, and the edge that records a routed spawn.
--
-- Design: docs/features/dreamer-dispatcher/DESIGN.md §4.3 (D2, D4).
--
-- Two CHECK constraints carry the mode vocabulary — `work_sessions.mode`
-- (001_core_graph.sql:708) and `team_members.mode` (002_identity.sql:122) — and
-- BOTH must widen together. A dispatcher teammate that cannot be seeded is a
-- dispatcher that never exists; a dispatcher session that cannot be recorded is
-- a spawn that fails after the PTY is already up. They are one change.
--
-- The constraints are dropped and re-added rather than altered because Postgres
-- has no `alter constraint ... check`. `if exists` keeps this replayable against
-- a database that a previous partial run already touched.
-- =============================================================================

alter table public.work_sessions drop constraint if exists work_sessions_mode_check;
alter table public.work_sessions add constraint work_sessions_mode_check
  check (mode is null or mode in
    ('worker','coordinator','coordinated-worker','coordinated-coordinator','dispatcher'));

alter table public.team_members drop constraint if exists team_members_mode_check;
alter table public.team_members add constraint team_members_mode_check
  check (mode is null or mode in
    ('worker','coordinator','coordinated-worker','coordinated-coordinator','dispatcher'));

-- -----------------------------------------------------------------------------
-- dispatched_by — provenance for a routed spawn (§4.3).
--
-- src is the session that was spawned, dst is the dispatcher session that chose
-- it. Direction matters: the interesting question at read time is "who sent
-- this session here", asked of the session, and edges are cheap to walk from
-- src. NOT append-only: unlike the 056 epistemic edges this records a routing
-- act, not a claim about the world, and a purge of either session should take
-- it with them rather than raise.
--
-- `reason` is deliberately NOT a required prop. The dispatcher's justification
-- is a durable message on the task anchor, where a human can read it and reply;
-- duplicating it into edge props would make the edge the record of record and
-- the message decorative, which is backwards.
-- -----------------------------------------------------------------------------
insert into public.edge_types (type, src_kinds, dst_kinds, description, props_schema, acyclic, append_only)
values
  ('dispatched_by', array['work_session'], array['work_session'],
   'This session was spawned by that dispatcher session. Provenance for a routed spawn; the reasoning is the dispatcher''s message on the task anchor.',
   jsonb_build_object('type', 'object', 'properties', jsonb_build_object(
      'note', jsonb_build_object('type', 'string')),
     'additionalProperties', false),
   false, false)
on conflict (type) do nothing;
