-- =============================================================================
-- 085 — Memory working sets for ANY entity + authorship is remembered.
--
-- Design: docs/features/dreamer-dispatcher/DESIGN.md §2 D9/D10 (rulings,
-- Subhang 2026-08-09, post-P1):
--   D9  — `remembers` is THE memory-association edge and its src widens from
--         {member, team_member, work_session} to any kind ('*', the same
--         shape `depends_on`/`created_in` already use, 001:901 / 066). Task
--         attachment is remembers(task → memory); the design doc's earlier
--         `attached_to(memory → task)` proposal is retired unbuilt.
--   D10 — a session that AUTHORS a memory remembers it: `create_memory`
--         gains one insert next to its existing authored_from provenance,
--         so the authoring session's working set grows without any caller
--         action. Reads do NOT create edges (authorship is signal, reads
--         are noise).
--
-- ⚠ SHARED-OBJECT NOTICE (the 052/053/055/056/057/065/066 rule, continued).
-- §2 does `create or replace function public.create_memory`. That swaps the
-- ENTIRE body. The base text here is copied VERBATIM from 056 (the only
-- prior definition — verified by grepping every migration for
-- `create_memory`), plus ONE guarded insert. WHOEVER REPLACES THIS FUNCTION
-- NEXT MUST COPY THIS FILE'S BODY, not 056's.
--
-- The replace keeps the 056 signature, so existing grants survive (PostgreSQL
-- preserves ACLs across CREATE OR REPLACE of the same signature).
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. D9 — any entity can hold a working set. dst stays locked to memory.
-- -----------------------------------------------------------------------------
update public.edge_types
   set src_kinds = array['*'],
       description = 'Working-set association: whose (or what''s) memory set '
         || 'this belongs to — teammates, sessions, tasks, any holder. '
         || 'Mutable — a working set needs correcting.'
 where type = 'remembers';

-- -----------------------------------------------------------------------------
-- 2. D10 — the authoring session auto-remembers. Body verbatim from 056 plus
--    the ONE insert marked `-- 085:`.
-- -----------------------------------------------------------------------------
create or replace function public.create_memory(
  p_space_id uuid, p_statement text, p_mechanism text, p_subject_scope text,
  p_does_not_establish text, p_measured_at timestamptz default null,
  p_actor_id uuid default null, p_position double precision default null,
  p_work_session_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  memory_id uuid;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  if length(btrim(coalesce(p_statement, ''))) not between 1 and 4000 then
    raise exception 'memory statement is required (1..4000 chars after trim)' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_mechanism, ''))) not between 1 and 1000 then
    raise exception 'memory mechanism is required (1..1000 chars after trim)' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_subject_scope, ''))) not between 1 and 1000 then
    raise exception 'memory subject_scope is required (1..1000 chars after trim)' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_does_not_establish, ''))) not between 1 and 1000 then
    raise exception 'memory does_not_establish is required (1..1000 chars after trim)' using errcode = '22023';
  end if;

  -- No parent parameter exists: memories are outside hierarchy (§2), and no
  -- title parameter exists: the title is DERIVED from the statement at read
  -- time, so a restatement with no back-link cannot be manufactured here.
  memory_id := internal.create_envelope(p_space_id, 'memory', actor, null, p_position);
  insert into public.memories(entity_id, statement, mechanism, subject_scope, does_not_establish, measured_at)
  values (memory_id, btrim(p_statement), btrim(p_mechanism), btrim(p_subject_scope),
          btrim(p_does_not_establish), p_measured_at);
  perform internal.record_initial_version(memory_id, actor);

  -- Provenance is server-written under the 052 writer token, NEVER a client
  -- `connections` entry: if agents could forge authored_from, verification
  -- independence (§6) would be self-certified. Shape mirrors the message
  -- recorder (019): the acting actor must participate in the named session.
  if p_work_session_id is not null then
    perform 1 from public.entities e
      join public.work_sessions ws on ws.entity_id = e.id
     where e.id = p_work_session_id and e.space_id = p_space_id and e.deleted_at is null
       and exists (select 1 from public.edges edge
                    where edge.src_id = actor and edge.dst_id = p_work_session_id
                      and edge.type = 'participates_in')
     for update;
    if not found then
      raise exception 'authored_from provenance does not match the acting session'
        using errcode = '42501';
    end if;
    perform internal.w1_set_writer('memory_recorder');
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, memory_id, p_work_session_id, 'authored_from', actor);
    perform internal.w1_set_writer('');

    -- 085: D10 — authorship is remembered. Same validated session, plain
    -- insert (remembers is not recorder-owned; mutable, so it can later be
    -- moved by consolidation). Idempotent for the replay-free path where a
    -- retried command re-runs after a partial failure.
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, p_work_session_id, memory_id, 'remembers', actor)
    on conflict (src_id, dst_id, type) do nothing;
  end if;

  activity_id := internal.record_activity(p_space_id, memory_id, actor, 'created',
                   null, jsonb_build_object('kind', 'memory'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(memory_id, null, activity_id, array[memory_id]));
end
$$;

reset role;
