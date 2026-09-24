-- =============================================================================
-- 212 — `produces` and `consumes`: the data-flow edges a materialized Craft
-- blueprint writes (Craft Foundations, task 01a0d3c5-825e; vocabulary in
-- packages/contract/src/orchestration.ts, coordinator ruling 2026-09-24).
--
-- WHY REAL TYPES, NOT A MAPPING. A blueprint's flow edges ("t-research
-- produces d-spec", "t-api consumes d-spec") had no registered twin. Folding
-- them into `depends_on` would materialize, but a live progress map reading
-- real edges could then no longer tell "writes" from "waits for" — ordering
-- and data flow are different facts. `attached_to` is context, not output.
-- So each blueprint word materializes 1:1, same direction, as itself.
--
-- THE SENTENCE RULE: src <type> dst. Both run TASK → output/input, so a
-- task's inbound/outbound walk answers "what does it make, what does it read"
-- in one hop each. The DATA flows task → doc for `produces` and doc → task
-- for `consumes`; the renderer reads that from the vocabulary, not from here.
--
-- NOT ACYCLIC: each type is bipartite (task → doc|artifact|memory) and cannot
-- close a loop on its own. Cross-type cycles (produce → consume → depends_on)
-- are a PLAN finding the coherence check reports, never a write refusal.
--
-- NUMBERED 212: measured 2026-09-24 against ALL remote refs (`git ls-tree`
-- of db/migrations over every origin branch) — the union's max is 211.
-- Re-measured immediately before push (the chain races; see 135's header).
-- =============================================================================

set role tm8_graph_owner;

insert into public.edge_types (type, src_kinds, dst_kinds, description, props_schema, acyclic, append_only) values
  ('produces', array['task'], array['doc', 'artifact', 'memory'],
   'Data flow: this task produces that output. Written 1:1 by Craft materialize; the blueprint edge''s note rides in props.note.',
   jsonb_build_object('type', 'object', 'properties', jsonb_build_object(
      'note', jsonb_build_object('type', 'string'),
      'blueprintId', jsonb_build_object('type', 'string')),
    'additionalProperties', false),
   false, false),
  ('consumes', array['task'], array['doc', 'artifact', 'memory'],
   'Data flow: this task reads that input. Written 1:1 by Craft materialize; the blueprint edge''s note rides in props.note.',
   jsonb_build_object('type', 'object', 'properties', jsonb_build_object(
      'note', jsonb_build_object('type', 'string'),
      'blueprintId', jsonb_build_object('type', 'string')),
    'additionalProperties', false),
   false, false)
on conflict (type) do nothing;

reset role;
