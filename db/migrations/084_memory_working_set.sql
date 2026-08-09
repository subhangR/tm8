-- =============================================================================
-- 084 — Memory working set: move `team_members.memories` jsonb into 056 memory
-- ENTITIES linked by `remembers` edges, and empty the jsonb.
--
-- Design: docs/features/dreamer-dispatcher/DESIGN.md §4.1 (decision D1: the
-- 056 memory entities are the ONE substrate; the per-teammate jsonb column is
-- retired). This is step one of a two-step retirement:
--   084 (this file)  — copy every jsonb entry into a memory entity + a
--                      `remembers` edge (team_member → memory), then set the
--                      column to '[]'. The COLUMN survives, because frozen
--                      binaries (:7777/:7778) still select it, and the
--                      not-yet-updated teammate editor still writes it — the
--                      new spawn read path injects graph memories PLUS any
--                      jsonb remainder, so a write never silently vanishes.
--   (a later file)   — drop the column once every reader/writer is proven off
--                      it.
--
-- Why `remembers` and NOT a new `remembered_by` type: 056 already registered
-- `remembers` (src member|team_member|work_session → dst memory, mutable,
-- "Owner association: whose memory set this belongs to"). Minting a mirror
-- type would be the parallel-memory-system anti-pattern D1 exists to forbid.
--
-- Field synthesis: jsonb entries are free-form strings; 056 memory rows demand
-- statement/mechanism/subject_scope/does_not_establish (NOT NULL, length
-- checked). The synthesized values say honestly that the provenance is a
-- legacy note — they do NOT invent a mechanism that was never recorded.
--
-- Deliberately absent: activity rows and event emissions. This is a data
-- migration, not user action; the entities surface on the next read.
-- `remembers` is not recorder-owned (066's guard list), so plain inserts pass
-- the edge guards; the append-only guard ignores it (mutable type).
-- =============================================================================

set role tm8_graph_owner;

do $$
declare
  tm record;
  entry record;
  stmt text;
  memory_id uuid;
begin
  for tm in
    select t.entity_id, t.name, e.space_id
      from public.team_members t
      join public.entities e on e.id = t.entity_id
     where e.deleted_at is null
       and jsonb_typeof(t.memories) = 'array'
       and jsonb_array_length(t.memories) > 0
  loop
    for entry in
      select value, ordinality
        from jsonb_array_elements(
               (select memories from public.team_members where entity_id = tm.entity_id))
             with ordinality
    loop
      stmt := btrim(case when jsonb_typeof(entry.value) = 'string'
                         then entry.value #>> '{}'
                         else entry.value::text end);
      if stmt = '' then continue; end if;
      stmt := left(stmt, 4000);

      memory_id := internal.create_envelope(tm.space_id, 'memory', tm.entity_id, null, null);
      insert into public.memories(entity_id, statement, mechanism, subject_scope, does_not_establish)
      values (
        memory_id,
        stmt,
        'unrecorded — migrated from the legacy team_members.memories jsonb column (084)',
        format('working note carried by teammate %s', tm.name),
        'independent verification; the legacy column recorded no mechanism or evidence'
      );
      perform internal.record_initial_version(memory_id, tm.entity_id);

      insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
      values (tm.space_id, tm.entity_id, memory_id, 'remembers',
              jsonb_build_object('note', 'migrated from team_members.memories (084)'),
              tm.entity_id)
      on conflict (src_id, dst_id, type) do nothing;
    end loop;

    update public.team_members set memories = '[]'::jsonb
     where entity_id = tm.entity_id;
  end loop;
end
$$;

reset role;
