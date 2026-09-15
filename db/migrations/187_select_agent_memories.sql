-- =============================================================================
-- 187 — select_agent_memories: the spawn-time memory selector lives in the
-- graph, not in the injector.
--
-- Design: docs/features/memory/MEMORY-DESIGN-FINAL.md §7.2–§7.4 (decision D4).
--
-- WHAT WAS THERE. `DbGraphPort.loadSpawnContext` (packages/server/src/facade/
-- execution-handlers.ts) read every memory a teammate could reach with one
-- inline query that had no relevance term and ordered by created_at; PR #609
-- then bounded the result in TypeScript, tier by tier. The rules for "which
-- memories reach a fresh agent" therefore lived in two places — a SQL where
-- clause and a TypeScript loop — and neither was the design's rank order.
--
-- WHAT THIS DOES. Selection is ONE read, `internal.select_agent_memories`,
-- called inside the injector's transaction so the chosen set describes the
-- same instant as the persona, tasks and skills it is composed beside. Four
-- read-only functions, every one SECURITY INVOKER so row-level security
-- applies as the caller — exactly the visibility the inline query had:
--
--   internal.clip_text(text, chars, bytes)            bounded text, visible '…'
--   internal.memory_marks(uuid[])                     epistemic state of memories,
--                                                     derived from mark edges at
--                                                     read time (§3.3), never stored
--   internal.agent_memory_entry(uuid, text, text[])   one prompt line, ≤ 512 bytes
--   internal.select_agent_memories(...)               the selector
--
-- CANDIDATES (§7.2) — the union of four routes, each bounded:
--   C1 persona   remembers(actor → memory); remembers(owner member → memory);
--                memories the actor authored (entities.created_by, the column
--                #609 found to be true today); remembers(session → memory) for
--                the actor's own sessions, joined through
--                relates_to(session → actor) — the edge spawn draws (048:99).
--                A session is a work_session or a chat: the two kinds that can
--                author (authored_from.dst_kinds since 176).
--   C2 subject   about(memory → task) and remembers(task → memory) — the
--                latter because 090 D9 ruled `remembers` THE attachment edge
--                for task working sets, and production carries thirty of them
--                against one `about` — for every assigned task and each of its
--                ancestors, walked ≤ 8 levels up.
--   C3 project   about(memory → project entity) / remembers(project → memory).
--   C4 worktree  about / based_on (memory → worktree) / remembers(worktree → memory).
--                Worktree entities exist (057); the injector passes null today
--                because the worktree is provisioned AFTER this read, and the
--                route waits for a caller that knows it.
--
-- EXCLUSIONS. Soft-deleted memories never appear. A superseded candidate is
-- REPLACED BY ITS CHAIN HEAD, never merely dropped — serving a body the graph
-- already knows to be replaced is serving rot, and dropping it silently loses
-- the correction too. If the head is already a candidate, the predecessor is
-- dropped and the head keeps the better of the two routes. Only LIVE
-- successors count: delete the correction and the original stands again,
-- unmarked, rather than disappearing behind a head that no longer exists (§2
-- carries the rule and the joins that enforce it). A chain the walk
-- cannot resolve within 32 hops (the read bound entity-read.ts also uses) is
-- treated as unresolved and its predecessor is left out. Disputed,
-- basis-changed and basis-deleted memories are NEVER excluded: they are shown
-- WITH their marks, because an agent that never sees a disputed claim also
-- never sees that the claim was disputed.
--
-- RANK (§7.2) — total and deterministic:
--   1  verified at the current version, independence basis 'session'
--   2  verified at the current version, independence basis 'actor'
--   3  unflagged
--   4  basis changed or basis deleted
--   5  disputed — an OPEN dispute outranks any verification of the same
--      memory: a verification that did not answer the dispute is not a clear.
--   then persona (C1) before subject (C2/C3/C4, which tie as the design
--   states), then coalesce(measured_at, created_at) descending, then entity id
--   ascending, so the same inputs always produce the same prompt.
--
-- BUDGET (§7.3). Entries are emitted in rank order and emission STOPS before
-- the first entry that would exceed p_budget_bytes — not skip-and-continue,
-- which would let a small low-ranked entry jump the order. Every entry is
-- ≤ 512 bytes by construction (statement ≤ 240 characters, then the whole line
-- shrunk to fit), so any budget of at least 512 bytes shows the first
-- candidate; a smaller budget is refused (22023) rather than allowed to show
-- nothing without saying so. Every emitted row carries how many candidates
-- were left out and which, so the caller can say so: a silent cap reads as
-- "you have been told everything".
--
-- WHY THE LINE IS RENDERED HERE. The budget counts the bytes the prompt will
-- carry, so whoever counts must know the shape. Rendering where the count is
-- made keeps the budget exact by construction instead of a formula two files
-- must agree on. The shape is the injector's existing one, kept verbatim:
--   <statement> [mark, mark] (mem:<entity id>)
-- The id is load-bearing: it is what lets an agent shown a wrong memory
-- dispute or supersede THAT memory instead of describing it.
--
-- No shared object is replaced by this file. Nothing here touches
-- entity_content, write_edge, create_memory or the edge guard.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Bounded text. Character cap first (the design's unit), then a byte cap
--    (the budget's unit) — 240 characters of four-byte glyphs are 960 bytes.
--    A cut is always visible: the text ends in '…', which itself must fit
--    inside the cap it announces.
-- -----------------------------------------------------------------------------
create or replace function internal.clip_text(p_text text, p_max_chars integer, p_max_bytes integer)
returns text language plpgsql immutable parallel safe as $$
declare
  s text := coalesce(p_text, '');
  clipped boolean := false;
begin
  if length(s) > p_max_chars then
    s := left(s, p_max_chars);
    clipped := true;
  end if;
  -- '…' is three UTF-8 bytes. One character at a time: the inputs are at most
  -- a few hundred characters, and obviousness beats a byte-arithmetic guess
  -- that could land inside a multi-byte character.
  while length(s) > 0 and octet_length(s) + (case when clipped then 3 else 0 end) > p_max_bytes loop
    s := left(s, length(s) - 1);
    clipped := true;
  end loop;
  if clipped then
    return rtrim(s) || '…';
  end if;
  return s;
end
$$;

-- -----------------------------------------------------------------------------
-- 2. The epistemic state of a set of memories, derived at read time from the
--    same mark edges `badges.staleness` reads (entity-read.ts), with ONE
--    deliberate difference, recorded here because it is the whole point of the
--    `deleted_at is null` joins below: a SOFT-DELETED successor is not a
--    successor. `badges.staleness` answers "what does the graph say replaced
--    this", so a deleted successor still counts there; this function answers
--    "what should the agent be told", and pointing an agent at a memory
--    somebody deleted, or hiding the surviving original behind it, is the one
--    thing §7.2 says must never happen. When every successor has been deleted
--    the predecessor is its own head again and is shown, unmarked.
--
--      superseded    a LIVE inbound `supersedes` exists; the chain head is the
--                    deepest reachable LIVE successor, and where a chain forks
--                    the newest successor at that depth wins — the same
--                    tie-break 186's `public.search_memories` uses, so the
--                    prompt and `tm8 memory search` name the same current
--                    version of one corrected fact. Bounded at 32 hops:
--                    head_id is null and head_truncated true when the bound is
--                    hit, because a wrong head is worse than none.
--      disputed      an inbound `disputes` with no answering `verifies` — one
--                    that names the dispute in props.answers AND pins the
--                    memory's CURRENT version; a clear of version N stops
--                    clearing the moment the content moves to N+1
--      verified_basis  the strongest `verifies` pinned at the current version:
--                    'session', 'actor', or null. Null is UNFLAGGED, not wrong.
--      basis_moved   an outbound `based_on`/`copy_of` pin is behind its target
--      basis_deleted an outbound pin points at a soft-deleted, hidden or gone
--                    entity (a deleted basis can ALSO have moved: both fire)
--
--    `marks` are the words a prompt shows, in display precedence (superseded >
--    disputed > basis deleted > basis changed), with 'verified' last because it
--    is the one mark that reassures. Plain words on purpose — these reach
--    people as well as agents.
-- -----------------------------------------------------------------------------
create or replace function internal.memory_marks(p_ids uuid[])
returns table (
  entity_id uuid,
  version integer,
  superseded boolean,
  head_id uuid,
  head_truncated boolean,
  disputed boolean,
  verified_basis text,
  basis_moved boolean,
  basis_deleted boolean,
  marks text[]
) language sql stable set search_path = public, internal, pg_temp as $$
  with recursive target as (
    select e.id, e.version
      from public.entities e
     where e.id = any(coalesce(p_ids, '{}'::uuid[])) and e.kind = 'memory'
  ),
  -- Walk up the LIVE successors only, at both ends of the union: a deleted
  -- successor ends the chain where it stands rather than handing the reader a
  -- head that no longer exists. Without the join at the BASE step a memory
  -- whose only correction was deleted came back superseded with a dead head,
  -- and §4's `final` then dropped it — the original claim vanished from every
  -- agent's prompt, uncounted, while search still answered it.
  chain as (
    select s.dst_id as origin, s.src_id as head, 1 as depth
      from public.edges s
      join public.entities se
        on se.id = s.src_id and se.kind = 'memory' and se.deleted_at is null
     where s.type = 'supersedes' and s.dst_id in (select t.id from target t)
    union all
    select c.origin, s.src_id, c.depth + 1
      from chain c
      join public.edges s on s.type = 'supersedes' and s.dst_id = c.head
      join public.entities se
        on se.id = s.src_id and se.kind = 'memory' and se.deleted_at is null
     where c.depth < 32
  ),
  -- Deepest wins; where two corrections fork off the same memory at the same
  -- depth the NEWEST wins. Ids are uuidv7, so `head desc` is "newest" — the
  -- identical clause 186 uses, because two reads of one graph disagreeing about
  -- which correction is current is worse than either answer alone.
  head as (
    select distinct on (c.origin) c.origin, c.head, c.depth
      from chain c
     order by c.origin, c.depth desc, c.head desc
  ),
  verification as (
    select v.dst_id as id,
           max(case when v.props ->> 'independenceBasis' = 'session' then 2 else 1 end) as strength
      from public.edges v
      join target t on t.id = v.dst_id
     where v.type = 'verifies'
       and (v.props ->> 'pinnedVersion')::integer = t.version
     group by v.dst_id
  ),
  dispute as (
    select d.dst_id as id
      from public.edges d
      join target t on t.id = d.dst_id
     where d.type = 'disputes'
       and not exists (
         select 1
           from public.edges v
          where v.type = 'verifies' and v.dst_id = d.dst_id
            and (v.props -> 'answers') ? d.id::text
            and (v.props ->> 'pinnedVersion')::integer = t.version)
     group by d.dst_id
  ),
  basis as (
    select b.src_id as id,
           bool_or(bt.id is not null
                   and (b.props ->> 'pinnedVersion')::integer > 0
                   and (b.props ->> 'pinnedVersion')::integer < bt.version) as moved,
           bool_or(bt.id is null or bt.deleted_at is not null) as deleted
      from public.edges b
      join target t on t.id = b.src_id
      left join public.entities bt on bt.id = b.dst_id
     where b.type in ('based_on', 'copy_of')
     group by b.src_id
  )
  select t.id,
         t.version,
         (h.origin is not null) as superseded,
         case when h.origin is not null and h.depth < 32 then h.head end as head_id,
         coalesce(h.depth >= 32, false) as head_truncated,
         (d.id is not null) as disputed,
         case v.strength when 2 then 'session' when 1 then 'actor' end as verified_basis,
         coalesce(b.moved, false) as basis_moved,
         coalesce(b.deleted, false) as basis_deleted,
         array_remove(array[
           case when h.origin is not null then 'superseded' end,
           case when d.id is not null then 'disputed' end,
           case when coalesce(b.deleted, false) then 'basis deleted' end,
           case when coalesce(b.moved, false) then 'basis changed' end,
           case when v.strength is not null then 'verified' end
         ], null) as marks
    from target t
    left join head h on h.origin = t.id
    left join verification v on v.id = t.id
    left join dispute d on d.id = t.id
    left join basis b on b.id = t.id
$$;

-- -----------------------------------------------------------------------------
-- 3. One prompt line, at most 512 bytes: the statement (≤ 240 characters, cut
--    with a visible '…'), the marks, and the memory's id. The suffix is
--    measured first and the statement shrunk to whatever is left, so the cap
--    holds for any marks and any script.
-- -----------------------------------------------------------------------------
create or replace function internal.agent_memory_entry(p_id uuid, p_statement text, p_marks text[])
returns text language sql immutable parallel safe as $$
  select internal.clip_text(p_statement, 240, 512 - octet_length(s.suffix)) || s.suffix
    from (select case when cardinality(coalesce(p_marks, '{}'::text[])) > 0
                      then ' [' || array_to_string(p_marks, ', ') || ']'
                      else '' end
                 || ' (mem:' || p_id::text || ')' as suffix) s
$$;

-- -----------------------------------------------------------------------------
-- 4. The selector. See the header for the routes, the exclusions, the rank
--    and the budget. Rows come back in final rank order; every row carries
--    `omitted` (how many ranked candidates did not fit) and `omitted_ids`
--    (which, in rank order) so the caller can name what it left out. Zero rows
--    means zero candidates: with a budget of at least 512 bytes the first
--    entry always fits.
-- -----------------------------------------------------------------------------
create or replace function internal.select_agent_memories(
  p_space_id uuid,
  p_actor_id uuid,
  p_task_ids uuid[],
  p_project_entity_id uuid,
  p_worktree_entity_id uuid,
  p_budget_bytes integer
) returns table (
  entity_id uuid,
  statement text,
  mechanism text,
  subject_scope text,
  does_not_establish text,
  measured_at timestamptz,
  version integer,
  route text,
  marks text[],
  replaces uuid[],
  statement_truncated boolean,
  mechanism_truncated boolean,
  subject_scope_truncated boolean,
  does_not_establish_truncated boolean,
  entry text,
  entry_bytes integer,
  omitted integer,
  omitted_ids uuid[]
) language plpgsql stable set search_path = public, internal, pg_temp as $$
begin
  -- The floor is 512 bytes because §3 caps one rendered entry at exactly that,
  -- so anything smaller could not hold a single memory. The refusal says that
  -- in words: this is a server constant, so whoever reads this is configuring
  -- the prompt, not debugging the database.
  if p_budget_bytes is null or p_budget_bytes < 512 then
    raise exception 'the memory section is too small to show even one memory'
      using errcode = '22023';
  end if;

  -- Every column reference below is table-qualified: the output columns are
  -- plpgsql variables of the same names, and an unqualified `statement` or
  -- `version` would be ambiguous.
  return query
  with recursive
  -- C2's subjects: the assigned tasks and their ancestors, at most eight up.
  -- The hierarchy trigger keeps parent chains acyclic; the depth bound is what
  -- keeps this read bounded even if a restore or a direct write bypassed it.
  subject(id, parent_id, depth) as (
    select t.id, t.parent_id, 0
      from public.entities t
     where t.id = any(coalesce(p_task_ids, '{}'::uuid[]))
       and t.space_id = p_space_id and t.deleted_at is null
    union all
    select p.id, p.parent_id, s.depth + 1
      from subject s
      join public.entities p on p.id = s.parent_id
     where s.depth < 8 and p.space_id = p_space_id and p.deleted_at is null
  ),
  -- Every entity whose `remembers` working set counts, with its route:
  -- 0 persona, 1 subject, 2 project, 3 worktree.
  holder(id, route_rank) as (
    select p_actor_id, 0
    union all
    select tm.owner_member_id, 0
      from public.team_members tm
     where tm.entity_id = p_actor_id and tm.owner_member_id is not null
    union all
    select st.src_id, 0
      from public.edges st
      join public.entities ws on ws.id = st.src_id and ws.kind in ('work_session', 'chat')
     where st.type = 'relates_to' and st.dst_id = p_actor_id
    union all
    select s.id, 1 from subject s
    union all
    select p_project_entity_id, 2 where p_project_entity_id is not null
    union all
    select p_worktree_entity_id, 3 where p_worktree_entity_id is not null
  ),
  reached(id, route_rank) as (
    select r.dst_id, h.route_rank
      from holder h
      join public.edges r on r.type = 'remembers' and r.src_id = h.id
    union all
    -- Subject routing is the memory's own `about` edge (§3.2). A memory
    -- about the persona itself is not the persona's working set, so `about`
    -- counts for subject, project and worktree holders only.
    select a.src_id, h.route_rank
      from holder h
      join public.edges a on a.type = 'about' and a.dst_id = h.id
     where h.route_rank > 0
    union all
    select b.src_id, 3
      from public.edges b
     where p_worktree_entity_id is not null
       and b.type = 'based_on' and b.dst_id = p_worktree_entity_id
    union all
    -- Authorship is membership (090 D10): the column that is true today,
    -- beside the session edge above that consolidation can later move.
    select e.id, 0
      from public.entities e
     where e.kind = 'memory' and e.space_id = p_space_id
       and e.created_by = p_actor_id and e.deleted_at is null
  ),
  candidate as (
    select r.id, min(r.route_rank) as route_rank
      from reached r
      join public.entities e
        on e.id = r.id and e.kind = 'memory' and e.space_id = p_space_id and e.deleted_at is null
     group by r.id
  ),
  candidate_state as (
    select cs.* from internal.memory_marks(array(select c.id from candidate c)) cs
  ),
  -- A superseded candidate hands its place, and its route, to its chain head.
  resolved(id, route_rank, predecessor) as (
    select case when cs.superseded then cs.head_id else c.id end,
           c.route_rank,
           case when cs.superseded then c.id end
      from candidate c
      join candidate_state cs on cs.entity_id = c.id
     where not cs.superseded or (cs.head_id is not null and not cs.head_truncated)
  ),
  final as (
    select r.id, min(r.route_rank) as route_rank,
           array_remove(array_agg(r.predecessor order by r.predecessor), null) as replaces
      from resolved r
      join public.entities e
        on e.id = r.id and e.kind = 'memory' and e.space_id = p_space_id and e.deleted_at is null
     group by r.id
  ),
  final_state as (
    select fs.* from internal.memory_marks(array(select f.id from final f)) fs
  ),
  shaped as (
    select f.id, m.statement, m.mechanism, m.subject_scope, m.does_not_establish,
           m.measured_at, m.created_at, e.version, f.route_rank, f.replaces, fs.marks,
           case when fs.disputed then 5
                when fs.basis_moved or fs.basis_deleted then 4
                when fs.verified_basis = 'session' then 1
                when fs.verified_basis = 'actor' then 2
                else 3 end as tier,
           internal.agent_memory_entry(f.id, m.statement, fs.marks) as line
      from final f
      join public.memories m on m.entity_id = f.id
      join public.entities e on e.id = f.id
      join final_state fs on fs.entity_id = f.id
     where not fs.superseded
  ),
  ranked as (
    select x.*,
           row_number() over (
             order by x.tier, least(x.route_rank, 1),
                      coalesce(x.measured_at, x.created_at) desc, x.id) as rank_no,
           octet_length(x.line) as bytes
      from shaped x
  ),
  running as (
    select r.*,
           sum(r.bytes) over (order by r.rank_no rows between unbounded preceding and current row)
             as running_bytes
      from ranked r
  ),
  -- STOP, not skip: nothing at or after the first entry that would overflow
  -- is emitted, even when a smaller one further down would have fitted.
  cut as (
    select coalesce(min(r.rank_no), (select count(*) from ranked) + 1) as first_over
      from running r
     where r.running_bytes > p_budget_bytes
  )
  select r.id,
         internal.clip_text(r.statement, 240, 960),
         internal.clip_text(r.mechanism, 120, 480),
         internal.clip_text(r.subject_scope, 120, 480),
         internal.clip_text(r.does_not_establish, 120, 480),
         r.measured_at,
         r.version,
         case r.route_rank when 0 then 'persona' when 1 then 'subject'
                           when 2 then 'project' else 'worktree' end,
         r.marks,
         r.replaces,
         internal.clip_text(r.statement, 240, 960) <> r.statement,
         internal.clip_text(r.mechanism, 120, 480) <> r.mechanism,
         internal.clip_text(r.subject_scope, 120, 480) <> r.subject_scope,
         internal.clip_text(r.does_not_establish, 120, 480) <> r.does_not_establish,
         r.line,
         r.bytes,
         ((select count(*) from ranked) - (c.first_over - 1))::integer,
         coalesce((select array_agg(o.id order by o.rank_no)
                     from running o where o.rank_no >= c.first_over), '{}'::uuid[])
    from running r
   cross join cut c
   where r.rank_no < c.first_over
   order by r.rank_no;
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Grants. New functions are executable by PUBLIC unless revoked, and the
--    schema-wide revoke in 001/004/008 covered only what existed then. The
--    injector runs as tm8_app, SECURITY INVOKER, so tm8_app needs every
--    function in the chain — the ones the selector calls included.
-- -----------------------------------------------------------------------------
revoke all on function internal.clip_text(text, integer, integer) from public;
grant execute on function internal.clip_text(text, integer, integer) to tm8_app;
revoke all on function internal.memory_marks(uuid[]) from public;
grant execute on function internal.memory_marks(uuid[]) to tm8_app;
revoke all on function internal.agent_memory_entry(uuid, text, text[]) from public;
grant execute on function internal.agent_memory_entry(uuid, text, text[]) to tm8_app;
revoke all on function internal.select_agent_memories(uuid, uuid, uuid[], uuid, uuid, integer) from public;
grant execute on function internal.select_agent_memories(uuid, uuid, uuid[], uuid, uuid, integer) to tm8_app;

reset role;
