-- =============================================================================
-- 187 — ONE CORRECTION PER MEMORY.
--
-- A memory is never edited; it is replaced by a better one, and the
-- replacement points a `supersedes` edge at the claim it replaces (056 §5).
-- Nothing in the database stopped two people from doing that to the SAME claim
-- at the same time. The result is a fork: one memory with two rival
-- successors, each author believing theirs is now the current version.
--
-- The readers were recently taught to agree on which rival wins — newest
-- immediate successor for the `superseded.byId` slot, deepest walk for the
-- chain head (entity-read.ts, loadEntitySummariesByIds). That made the system
-- CONSISTENT. It did not make it CORRECT: one of the two people is silently
-- not the answer, nobody tells them, and the claim they were correcting stays
-- half-corrected in everybody's working set. Consistency without correctness
-- is the quietest kind of wrong, so this migration removes the fork at the
-- only layer that can actually remove it, and makes the refusal say something
-- a person can act on.
--
-- ─── WHY THE UNIQUENESS IS ON THE TARGET, NEVER ON THE SOURCE ───────────────
--
-- One correction MAY replace several claims at once. That is consolidation and
-- it is a first-class move: the Dreamer's standing brief
-- (server/src/bootstrap/default-teammates.ts, DREAMER_PERSONA) tells it, in so
-- many words, to author ONE merged memory and "point `supersedes` edges from
-- it to each memory it replaces". A unique index on `src_id` would make the
-- system's own scheduled memory-keeper illegal on its second edge.
--
-- What must never happen is the reverse: one claim corrected twice. So the
-- uniqueness is on `dst_id`. What this buys is not merely a blocked write — it
-- makes the supersedes graph a set of linear chains BY CONSTRUCTION, which is
-- what makes "the head of the chain" a fact rather than a convention the
-- readers agree to.
--
-- Measured on this node's production database before choosing the shape
-- (read-only, 2026-09-15):
--
--   select dst_id, count(*) from public.edges
--    where type='supersedes' group by dst_id having count(*)>1;   -> 0 rows
--   select count(*), count(distinct dst_id), count(distinct src_id)
--     from public.edges where type='supersedes';   -> 23 edges, 23 targets,
--                                                     16 sources
--
-- 23 edges over 23 distinct targets: no existing fork, so the index builds on
-- real data without a repair step. 16 distinct sources for 23 edges: seven of
-- those edges are consolidations already in production — the many-targets case
-- is not hypothetical, it is the majority pattern's neighbour, and it stays
-- legal here.
--
-- Every writer was checked before choosing an index over a trigger:
--   * `public.write_edge` is the ONLY path in the product that writes a
--     `supersedes` edge. The graph edge-create door, the memory mark flow in
--     the UI, and the memory verb in the CLI all arrive through it.
--   * No migration inserts `supersedes` directly. The direct
--     `insert into public.edges` sites write authored_from, remembers,
--     participates_in, in_project, anchored_to, messaged, derived_from,
--     assigned_to and friends — never this type. (Test fixtures do insert
--     directly, as the graph owner, and they now meet the index like anything
--     else; that is the point of them.)
--   * There is no bulk/backfill supersedes path to exempt.
-- A trigger would therefore buy nothing an index does not, and would cost the
-- linearity proof: an index is checked by the storage engine under the same
-- lock that serialises the race, a trigger is checked by a SELECT that two
-- concurrent transactions can both pass.
--
-- ─── THE NEWEST-WINS TIE-BREAK STAYS, AND WHY BOTH BELONG ───────────────────
--
-- This index means no NEW fork can be created. It does not mean no fork can
-- EXIST: an older database restored from before this migration, or a future
-- bulk import that runs as the table owner with the index dropped for the
-- load, can still present the readers with two successors. A reader that
-- responded to that by throwing, or by picking arbitrarily, would turn
-- recoverable history into an outage. So the write side refuses the fork and
-- the read side stays able to resolve one — belt and braces, on purpose, and
-- neither is redundant with the other.
--
-- ─── THE REFUSAL ────────────────────────────────────────────────────────────
--
-- SQLSTATE 23505 reaching a person as `duplicate key value violates unique
-- constraint "edges_supersedes_target_idx"` would be a failure of this work,
-- not a success. §2 catches the violation where the rival correction is one
-- join away and answers with the rival's own words, what happened, and what to
-- do instead. The catch is REACTIVE rather than a pre-flight SELECT, which is
-- not a shortcut: a pre-flight has a window between the check and the insert,
-- and the whole point of this migration is the case where two writers are
-- inside that window together. One code path serves the calm case and the race
-- identically, so the race test exercises the code the calm case uses.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The constraint. Partial-unique on the target, mirroring the shape 015
--    already uses for one-per-source facts (edges_authored_from_source_idx,
--    edges_created_in_source_idx) — the same tool, pointed the other way,
--    because the fact being made singular here is "this claim was corrected"
--    rather than "this thing came from somewhere".
--
--    Name checked against the live database: public.edges carries 14 indexes
--    and none is called this.
-- -----------------------------------------------------------------------------
create unique index edges_supersedes_target_idx
  on public.edges(dst_id) where type = 'supersedes';

-- -----------------------------------------------------------------------------
-- 2. write_edge, replaced. SHARED OBJECT — the 052/053 rule applies: this body
--    is 129's complete live text (which is 056's, which is 018's), copied
--    verbatim, with the insert wrapped in the marked `-- 187:` handler and
--    NOTHING else changed. The in_project lock arm, the origin preservation in
--    the conflict arm, the assignment-provenance refresh and the append-only
--    undo suppression are all still here. Whoever replaces this function next
--    must copy THIS text, or the humane refusal silently vanishes with no
--    error and no failing test but this file's own.
--
--    Scoping of the handler, stated because "catch unique_violation" is a
--    dangerously wide net:
--      * a non-supersedes write re-raises the ORIGINAL error unchanged —
--        same SQLSTATE, same message — so the four other unique indexes on
--        this table keep answering exactly as they did yesterday;
--      * a supersedes write with no rival found re-raises too. That is the
--        honest answer to "this 23505 was not the one we predicted": we do not
--        know what happened, so we do not narrate it. The refusal is decided
--        by a row we can see, never by parsing an error message.
--
--    The rival lookup is safe to show: `write_edge` has already run
--    `require_space_member` on the source's space, edge endpoints are required
--    to share a space, and a supersedes edge's endpoints are both memories —
--    so the rival correction is a memory in a space the caller belongs to and
--    could read by hand.
-- -----------------------------------------------------------------------------
create or replace function public.write_edge(
  p_src_id uuid, p_dst_id uuid, p_type text, p_props jsonb default '{}'::jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  replay jsonb;
  src public.entities;
  dst public.entities;
  actor uuid;
  edge_id uuid;
  activity_id uuid;
  project_resource uuid;
  -- 187: the caught violation, and the rival correction it is about. All four
  -- diagnostic fields are captured, not just the message, so a violation this
  -- handler decides NOT to narrate is re-raised as the exact error Postgres
  -- would have produced without it — detail and hint included.
  failed_state text;
  failed_message text;
  failed_detail text;
  failed_hint text;
  rival_statement text;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.create');
  if replay is not null then return replay; end if;
  if coalesce(p_props, '{}'::jsonb) ? 'origin' then
    raise exception 'edge props.origin is Server-owned' using errcode = '42501';
  end if;
  -- `in_project` has a stricter lock order than generic graph writes. Resolve
  -- the projection mapping even when the envelope was concurrently hidden,
  -- lock ProjectResource first, and keep every unlink race on the frozen
  -- project_not_linked path instead of degrading to a generic not_found.
  if p_type = 'in_project' then
    select project_id into project_resource
      from public.project_projection_details where entity_id = p_dst_id;
    if project_resource is null then
      raise exception 'Project projection has no resource mapping'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
    perform 1 from public.projects where id = project_resource for update;
    select * into dst from public.entities where id = p_dst_id and deleted_at is null;
    if dst.id is null then
      raise exception 'Project is not actively linked to this Space'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
  else
    dst := internal.live_entity(p_dst_id);
  end if;
  src := internal.live_entity(p_src_id);
  if src.space_id <> dst.space_id then
    raise exception 'edge endpoints must be in the same space' using errcode = '23514';
  end if;
  perform internal.require_space_member(src.space_id);
  actor := internal.resolve_actor(p_actor_id, src.space_id);
  perform internal.bind_actor(actor);

  -- 187: the insert, and only the insert, runs inside a handler. Everything
  -- above it has already happened and is untouched by the rollback to this
  -- block's implicit savepoint.
  begin
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (src.space_id, p_src_id, p_dst_id, p_type, coalesce(p_props, '{}'::jsonb), actor)
    on conflict (src_id, dst_id, type) do update
      set props = excluded.props
        || case when public.edges.props ? 'origin'
             then jsonb_build_object('origin', public.edges.props -> 'origin')
             else '{}'::jsonb end,
          updated_at = now(),
          -- 129: the attempted insert has already been stamped by the BEFORE
          -- trigger, so EXCLUDED holds the currently acting member/persona.
          assigned_by = excluded.assigned_by,
          assigned_at = excluded.assigned_at
    returning id into edge_id;
  exception when unique_violation then
    get stacked diagnostics
      failed_state = returned_sqlstate,
      failed_message = message_text,
      failed_detail = pg_exception_detail,
      failed_hint = pg_exception_hint;
    rival_statement := null;
    if p_type = 'supersedes' then
      -- Read committed: the transaction that beat us to it has committed by
      -- the time we are here (had it rolled back, our insert would simply have
      -- succeeded), so its row is visible to this fresh statement.
      select m.statement into rival_statement
        from public.edges e
        join public.memories m on m.entity_id = e.src_id
       where e.type = 'supersedes' and e.dst_id = p_dst_id;
    end if;
    if rival_statement is null then
      raise exception using errcode = failed_state, message = failed_message,
        detail = coalesce(failed_detail, ''), hint = coalesce(failed_hint, '');
    end if;
    -- The message is what a person sees on any door, including a bare psql
    -- prompt, so it has to stand on its own: what happened, in their words,
    -- and the move that works. It carries a shortened quote because it shares
    -- a line with other diagnostics; `correction` in DETAIL carries the whole
    -- thing for surfaces with room to show it. DETAIL is machine-readable
    -- plumbing, never copy — deliberately no ids in it, because every door
    -- that renders this should be quoting the correction, not naming it.
    raise exception
      'Someone else corrected this memory first, and a memory keeps only one correction so everyone reads the same answer. Their correction says: "%". If that is still wrong, correct their version instead of this one — corrections are meant to stack up in a single line.',
      case when length(rival_statement) > 200
           then left(rival_statement, 200) || '…' else rival_statement end
      using errcode = '23505',
            detail = jsonb_build_object(
              'reason', 'memory_already_corrected',
              'correction', rival_statement)::text;
  end;

  activity_id := internal.record_activity(
    src.space_id, p_src_id, actor, 'linked', edge_id,
    jsonb_build_object('type', p_type, 'dstId', p_dst_id));
  if coalesce((select t.append_only from public.edge_types t where t.type = p_type), false) then
    return internal.ledger_record(
      p_client_mutation_id,
      'edges.create',
      internal.command_result(null, edge_id, activity_id, array[p_src_id, p_dst_id]));
  end if;
  return internal.ledger_record(
    p_client_mutation_id,
    'edges.create',
    internal.command_result(
      null, edge_id, activity_id, array[p_src_id, p_dst_id],
      internal.issue_undo_token(
        src.space_id, actor, 'Undo link', 'edges.delete',
        jsonb_build_object('edgeId', edge_id))));
end
$$;

revoke all on function public.write_edge(uuid, uuid, text, jsonb, uuid, text) from public;
grant execute on function public.write_edge(uuid, uuid, text, jsonb, uuid, text) to tm8_app;

reset role;
