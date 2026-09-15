-- =============================================================================
-- 188 — Memory full-text search: an indexed search document over the four
-- fields of a memory, and `public.search_memories`, the one read that answers
-- "which memories say something about X" from the database instead of from a
-- JavaScript substring loop.
--
-- Design: docs/features/memory/MEMORY-DESIGN-FINAL.md — §3.1 (the four fields
-- and why a memory is not its statement), §7.2 (reads resolve a superseded
-- memory to its chain head; disputed memories are shown WITH their marks, never
-- hidden). §6.5 said "no new read operation is proposed and none is needed";
-- that predates this file, and the product owner's ruling that the memory
-- layer must be searchable is what this migration carries out.
--
-- WHAT WAS THERE. The MCP `memory_search` tool (packages/mcp/src/direct-tools.ts)
-- fetched the 100 most recently updated memories through `collections.query`
-- and substring-matched the query's words, in JavaScript, against the summary
-- `title` (120 chars) and `excerpt` (200 chars). Production carries 43
-- memories with a mean statement of 1,752 characters and a maximum of 4,000:
-- the search saw about the first 11% of an average statement and never saw
-- `mechanism`, `subject_scope` or `does_not_establish` at all — the three
-- fields the schema DEMANDS on every write and that say what a claim rests on
-- and where it stops. A memory whose boundary said "does not establish the
-- port for any other node" could not be found by "port". Nothing in the
-- database helped: no tsvector, no GIN index anywhere (pg_extension carries
-- plpgsql alone), so the only fix in JavaScript was to fetch everything.
--
-- WHAT THIS DOES.
--   §1 `internal.memory_search_document(statement, mechanism, subject_scope,
--      does_not_establish)` — the IMMUTABLE search document: the four fields as
--      one weighted tsvector under the 'english' configuration. Statement
--      weight A, subject scope B, mechanism C, boundary D, so a hit in what a
--      memory CLAIMS outranks the same word in what it declines to claim, and
--      the boundary is still searchable.
--   §2 an expression GIN index over that document on public.memories.
--   §3 `public.search_memories(p_space_id, p_query, p_limit)` — SECURITY
--      DEFINER with the visibility rule in its body (see below); ranks with
--      ts_rank_cd; resolves every superseded hit to its live chain head;
--      returns one row per head with the five plain-word marks; every row
--      passes internal.entity_readable.
--
-- WHY AN EXPRESSION INDEX AND NOT A GENERATED COLUMN. A stored tsvector column
-- on public.memories would ride along in `to_jsonb(m)`, which is how
-- `internal.entity_content` (056 §3, the `memory` arm) and
-- `internal.snapshot_entity_version` (001) serialise a memory row. The search
-- document would then leak into every `entities.get` content block — where the
-- contract's `memory` content schema is `.strict()` and would refuse it — and
-- into every entity_versions snapshot, and removing it again would mean
-- replacing a shared function whose copy-forward rule (056's SHARED-OBJECT
-- NOTICE) this file would rather not touch. An expression index changes no row
-- shape. The planner matches it whenever a query uses the SAME immutable
-- function call over the same columns, which §3 does; the pg test proves the
-- match by reading the plan with sequential scans disabled.
--
-- WHY SECURITY DEFINER, AND WHAT STANDS IN FOR RLS. The first draft of §3 ran
-- as the caller, so the three SELECT policies — memories_select (056),
-- entities_select (070), edges_select (008) — applied unchanged. Measured on a
-- migrated scratch database, that draft never touched the index: as tm8_app
-- the plan was a Seq Scan with `enable_seqscan = off`, while the same query
-- as the table owner was a Bitmap Index Scan on memories_search_document_idx.
-- The reason is the planner's leakproof rule for row-security tables: a
-- non-leakproof operator (`@@` is one) may not run before the security
-- predicate, so it cannot be an index condition on a table the caller reaches
-- only through a policy. Under RLS the GIN index would have been decorative
-- and every search a full scan computing four tsvectors per row.
--
-- So §3 runs as the graph owner, which bypasses the policies, and the
-- visibility rule is written INTO the body: every hit and every resolved
-- head must pass `internal.entity_readable`, the very predicate the SELECT
-- policies are made of (159). That is the 007 pattern — "SECURITY DEFINER
-- bypasses RLS, so an RPC that skips these has no protection whatsoever; they
-- are not belt-and-braces, they ARE the belt" (002) — and it fails closed:
-- with no identity claim bound, entity_readable is false and the function
-- answers nothing. The pg test proves both directions, as tm8_app: a member
-- of another space and a caller with no identity get zero rows; the member
-- gets the rows. `search_path` is pinned, as every definer function's is.
--
-- CHAIN HEADS. `supersedes` runs successor → predecessor (056 §5: "Successor
-- marks predecessor. Reads resolve to the chain head."). A hit is walked up
-- through its LIVE successors; the deepest reachable node is the head, and
-- between branches at the same depth the newest successor wins, so the same
-- graph always answers the same head. The walk is bounded at 32 hops, the
-- bound the read path already uses (entity-read.ts); the acyclicity trigger
-- keeps a chain a chain, the bound is what keeps this read finite if that
-- guard is ever bypassed by a restore or a direct write. A chain that hits the
-- bound is UNRESOLVED and is left out — a wrong head is worse than none. Two
-- hits on one chain collapse to one row carrying the better rank, so a
-- corrected memory is never listed twice under two wordings.
--
-- MARKS are the five plain words the spawn injector and the sibling selector
-- (185, `internal.memory_marks`) also use, in display precedence:
-- 'superseded', 'disputed', 'basis deleted', 'basis changed', 'verified'.
-- They are derived from the mark edges at read time exactly as
-- `badges.staleness` derives them (entity-read.ts): a dispute is open until a
-- verification names it in `answers` AND pins the memory's current version;
-- a verification counts only at the current version. This file computes them
-- inline rather than calling 185's function so that it applies in either
-- order relative to that sibling migration. 'superseded' is false for every
-- row this function returns, by construction (the walk stops only where no
-- live successor exists); it is derived anyway so the vocabulary is the same
-- five words everywhere and stays correct if a caller ever asks for
-- unresolved rows.
--
-- QUERY SYNTAX is `websearch_to_tsquery`'s: plain words are AND-ed, "quoted
-- words" are a phrase, `or` is OR, `-word` excludes. A query made only of
-- stop words, or of nothing, yields no rows rather than an error — a search
-- box must never raise on what a person typed. Deleted memories never appear.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The search document. IMMUTABLE because it feeds an index expression:
--    `to_tsvector(regconfig, text)` with an explicit configuration is itself
--    immutable, and so are setweight and tsvector concatenation. Text is
--    coalesced so the function is total even though the columns are NOT NULL.
-- -----------------------------------------------------------------------------
create or replace function internal.memory_search_document(
  p_statement text,
  p_mechanism text,
  p_subject_scope text,
  p_does_not_establish text
) returns tsvector
language sql immutable parallel safe as $$
  select setweight(to_tsvector('english', coalesce(p_statement, '')), 'A')
      || setweight(to_tsvector('english', coalesce(p_subject_scope, '')), 'B')
      || setweight(to_tsvector('english', coalesce(p_mechanism, '')), 'C')
      || setweight(to_tsvector('english', coalesce(p_does_not_establish, '')), 'D')
$$;

-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default; every
-- role on the cluster would be able to call it. Revoke first, then grant the
-- one role that reads memories (the delivery principal's grant list is pinned
-- by test/db/w2-execution.pg.test.ts and must not grow).
revoke all on function internal.memory_search_document(text, text, text, text) from public;
grant execute on function internal.memory_search_document(text, text, text, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 2. The index. Maintained by Postgres on every write to the four columns; the
--    door that writes them (create_memory / update_memory, 056 + 090) needs no
--    change, which is the other reason to prefer an expression over a column.
-- -----------------------------------------------------------------------------
create index memories_search_document_idx on public.memories
  using gin (internal.memory_search_document(statement, mechanism, subject_scope, does_not_establish));

-- -----------------------------------------------------------------------------
-- 3. The read.
-- -----------------------------------------------------------------------------
create or replace function public.search_memories(
  p_space_id uuid,
  p_query text,
  p_limit integer default 20
) returns table (
  entity_id uuid,
  statement text,
  subject_scope text,
  does_not_establish text,
  rank real,
  marks text[]
)
language sql stable
security definer
set search_path = public, internal, pg_temp
as $$
  with recursive
  -- The parsed query. Filtered to zero rows when it carries no lexemes, so the
  -- `@@` below is never evaluated against an empty query (which would only
  -- raise a notice and match nothing anyway) and the join yields nothing.
  q as (
    select parsed.tsq
      from (select websearch_to_tsquery('english', coalesce(p_query, '')) as tsq) parsed
     where numnode(parsed.tsq) > 0
  ),
  -- Every readable, live memory in the space whose document matches, with its
  -- rank. The index expression in §2 is repeated verbatim: that identity is
  -- what lets the planner use the index. `entity_readable` is the visibility
  -- rule here (see the header): this function bypasses the SELECT policies.
  hit as (
    select m.entity_id,
           ts_rank_cd(
             internal.memory_search_document(m.statement, m.mechanism, m.subject_scope, m.does_not_establish),
             q.tsq
           ) as rank
      from q
      join public.memories m
        on internal.memory_search_document(m.statement, m.mechanism, m.subject_scope, m.does_not_establish) @@ q.tsq
      join public.entities e on e.id = m.entity_id
     where e.kind = 'memory'
       and e.space_id = p_space_id
       and e.deleted_at is null
       and internal.entity_readable(m.entity_id)
  ),
  -- Walk each hit up its chain of LIVE successors (see the header).
  chain as (
    select h.entity_id as origin, h.entity_id as node, 0 as depth
      from hit h
    union all
    select c.origin, s.src_id, c.depth + 1
      from chain c
      join public.edges s on s.type = 'supersedes' and s.dst_id = c.node
      join public.entities se
        on se.id = s.src_id and se.kind = 'memory' and se.deleted_at is null
     where c.depth < 32
  ),
  head as (
    select distinct on (c.origin) c.origin, c.node as head_id, c.depth
      from chain c
     order by c.origin, c.depth desc, c.node desc
  ),
  -- One row per head, carrying the best rank of every hit that resolved to it.
  -- A walk that reached the bound is unresolved and dropped.
  resolved as (
    select hd.head_id as entity_id, max(h.rank) as rank
      from head hd
      join hit h on h.entity_id = hd.origin
     where hd.depth < 32
     group by hd.head_id
  ),
  marked as (
    select r.entity_id,
           r.rank,
           exists (
             select 1
               from public.edges s
               join public.entities se on se.id = s.src_id and se.deleted_at is null
              where s.type = 'supersedes' and s.dst_id = r.entity_id
           ) as superseded,
           exists (
             select 1
               from public.edges d
              where d.type = 'disputes' and d.dst_id = r.entity_id
                and not exists (
                  select 1
                    from public.edges v
                   where v.type = 'verifies' and v.dst_id = r.entity_id
                     and (v.props -> 'answers') ? d.id::text
                     and (v.props ->> 'pinnedVersion')::integer = e.version
                )
           ) as disputed,
           exists (
             select 1
               from public.edges v
              where v.type = 'verifies' and v.dst_id = r.entity_id
                and (v.props ->> 'pinnedVersion')::integer = e.version
           ) as verified,
           exists (
             select 1
               from public.edges b
               left join public.entities bt on bt.id = b.dst_id
              where b.type in ('based_on', 'copy_of') and b.src_id = r.entity_id
                and (bt.id is null or bt.deleted_at is not null)
           ) as basis_deleted,
           exists (
             select 1
               from public.edges b
               join public.entities bt on bt.id = b.dst_id
              where b.type in ('based_on', 'copy_of') and b.src_id = r.entity_id
                and (b.props ->> 'pinnedVersion')::integer > 0
                and (b.props ->> 'pinnedVersion')::integer < bt.version
           ) as basis_moved
      from resolved r
      join public.entities e on e.id = r.entity_id
     -- A head reached through the chain is checked in its own right: the hit
     -- was readable, the head must be too.
     where e.deleted_at is null
       and internal.entity_readable(r.entity_id)
  )
  select mk.entity_id,
         m.statement,
         m.subject_scope,
         m.does_not_establish,
         mk.rank,
         array_remove(array[
           case when mk.superseded then 'superseded' end,
           case when mk.disputed then 'disputed' end,
           case when mk.basis_deleted then 'basis deleted' end,
           case when mk.basis_moved then 'basis changed' end,
           case when mk.verified then 'verified' end
         ], null) as marks
    from marked mk
    join public.memories m on m.entity_id = mk.entity_id
   -- Total and deterministic (design §7.2): rank, then what was measured most
   -- recently, then the id, so the same inputs always list the same order.
   order by mk.rank desc, coalesce(m.measured_at, m.created_at) desc, mk.entity_id
   -- Bounded here, whatever the caller asked for: an unbounded page is a
   -- denial of service, and a limit below one is a request for nothing.
   limit greatest(1, least(coalesce(p_limit, 20), 200))
$$;

-- Same rule as §1: PUBLIC's default EXECUTE is revoked before the grant, so a
-- definer function that bypasses row policies is callable by tm8_app alone.
revoke all on function public.search_memories(uuid, text, integer) from public;
grant execute on function public.search_memories(uuid, text, integer) to tm8_app;

reset role;
