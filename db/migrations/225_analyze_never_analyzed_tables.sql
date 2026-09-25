-- =============================================================================
-- 225 — ANALYZE every table the planner still thinks was never analyzed.
--
-- THE DEFECT. `pg_class.reltuples = -1` means "never vacuumed or analyzed", and
-- for such a table the planner does not believe the real size: it assumes at
-- least 10 pages and fills them at the row width (plancat.c, the "HACK" in
-- table_block_relation_estimate_size). Measured on PG 17.5 and PG 18.4 alike,
-- one uuid-keyed table:
--
--     fresh, empty            reltuples -1   estimate  720 rows
--     never analyzed, 3 rows  reltuples -1   estimate 1070 rows
--     ANALYZEd, empty         reltuples  0   estimate    1 row
--     ANALYZEd, then 3 rows   reltuples  0   estimate   72 rows (real pages)
--     TRUNCATEd               reltuples -1   the heuristic is back
--
-- (The -1 sentinel dates from PG 14, so prod's 16 has the same code; 16 itself
-- was not run.)
--
-- Autovacuum analyzes a table only after 50 + 10% rows have changed, so a table
-- that stays small NEVER leaves the -1 state: 50 of 104 public tables on prod,
-- 39 of 104 on the dev node's tm8_stable, non-empty ones included (chats,
-- forms, spells, graphs, collections). ENTITY_FROM and the projector's
-- SUMMARY_SQL left-join ~30 of them and each join multiplies the estimate. It
-- compounds hardest on a YOUNG database — a small, analyzed `entities` and -1
-- detail tables, i.e. every CI integration server: CI's auto_explain (PR #802)
-- caught SUMMARY_SQL estimating 7.8e13 rows (cost 2.7e15) for 3 actual, far past
-- jit_above_cost, so each execution paid 2-5s of LLVM compile. The CLI receipt
-- suite replayed on PG 17 with auto_explain: 151 of 561 wide reads over
-- jit_above_cost, max estimate 5.15e12 for 4 rows; with this file, 0 and 4.
-- #802 turns JIT off per connection; this is the estimate itself, which also
-- picks the join order.
--
-- WHY ONCE IS ENOUGH PER TABLE. After one ANALYZE, reltuples is >= 0 for good:
-- the planner then scales the estimate by the table's REAL page count, and
-- autovacuum takes over once the table sees real traffic. Nothing in the server
-- TRUNCATEs, and a table rewrite keeps its stats (both checked on 17 and 18).
-- The two ways back to -1 are a NEW table and a TRUNCATE, and both are DDL,
-- which only a migration runs. So `db/migrate.mjs up` calls this function after
-- every run, including a run with nothing pending: a table a future migration
-- creates is analyzed in the same deploy that creates it.
--
-- COST. It touches only tables at -1, which by construction are small (a big
-- one would have crossed the autovacuum threshold). Rehearsed with the runner
-- on a copy of tm8_stable (221-223 + this file): 39 tables, 137ms for the whole
-- file. ANALYZE takes SHARE UPDATE EXCLUSIVE, which blocks neither reads nor
-- writes.
--
-- WHY NOT AT BOOT. The server never runs DDL, so it never creates the -1 state
-- it would be fixing; a boot step would be a query on every start for a state
-- only a deploy produces. WHY NOT a per-table autovacuum_analyze_threshold: it
-- needs rows to change, so a table nothing writes to would still never qualify,
-- and every new table would need to remember the reloption.
--
-- SECURITY INVOKER, not granted to anyone: ANALYZE needs the table owner or a
-- superuser, which is the migration login. As anyone else Postgres skips the
-- table with a WARNING, so a wrong caller is a no-op, not an error.
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.analyze_never_analyzed_tables()
returns setof regclass
language plpgsql
volatile
set search_path = pg_catalog
as $$
declare
  rel regclass;
begin
  for rel in
    select c.oid::regclass
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'internal')
       and c.relkind in ('r', 'p')
       and c.reltuples < 0
     order by c.oid
  loop
    execute format('analyze %s', rel);
    return next rel;
  end loop;
end
$$;

comment on function internal.analyze_never_analyzed_tables() is
  'ANALYZE every public/internal table whose reltuples is still -1 (never analyzed), so the planner stops inventing 10 pages of rows for it. Called by db/migrate.mjs after every up; 225 explains.';

revoke all on function internal.analyze_never_analyzed_tables() from public;

reset role;

-- As the migration login, which owns (or outranks the owner of) every table,
-- applied_migrations included.
select count(*) as analyzed from internal.analyze_never_analyzed_tables();
