-- 329 — TILE COUNT FACTS, PART TWO: `entity_counters.prs` / `.artifacts` /
-- `.drawings`.
--
-- The list tile's counts line reads five link groups (Docs · PRs ·
-- Artifacts · Drawings · Memories, tm8-ui domain/tile-counts.ts). 108 counted
-- the first and last; the middle three were absent, which the UI renders as
-- "never counted". This counts them, under 108's law exactly: derived,
-- trigger-owned, rebuildable, never written by an RPC (001 §8).
--
-- THE RULES (task 01a14a66-d65c, approved by Subhang 2026-10-17, option A —
-- `attached_to` only, matching 108; `produces` is NOT counted, for docs or
-- for these):
--
--   * prs        — `tracks` edges whose DESTINATION is a `pull_request`,
--                  counted on the edge's SOURCE. The only edge `link-pr`
--                  writes (017 link_pull_request: task -> pull_request,
--                  upserted on (src,dst,type), so relinking never
--                  double-counts). The peer-kind test keeps `link-commit`'s
--                  `tracks` edges to a `commit` out;
--   * artifacts  — `attached_to` edges whose SOURCE is an `artifact`, counted
--                  on the DESTINATION (108's docs shape);
--   * drawings   — `attached_to` edges whose SOURCE is a `drawing`, counted
--                  on the DESTINATION (194 registered drawings as attachers).
--
-- ONE WRITER STAYS ONE WRITER: rather than a second trigger beside 108's,
-- `internal.maintain_link_counters` is replaced with the five-group body and
-- the existing `edges_link_counters` trigger keeps calling it. The docs and
-- memories arms are 108's, unchanged. Each edge row reads its peer's kind
-- once per side instead of once per group.
--
-- Projected additively as OPTIONAL `prs`/`artifacts`/`drawings` on
-- EntityCounters, spread-when-present like 108's pair.

alter table public.entity_counters
  add column if not exists prs       integer not null default 0,
  add column if not exists artifacts integer not null default 0,
  add column if not exists drawings  integer not null default 0;

comment on column public.entity_counters.prs is
  'tracks edges from this entity to a pull_request. Trigger-owned (329 '
  'edges_link_counters), rebuildable, never written by an RPC.';
comment on column public.entity_counters.artifacts is
  'attached_to edges from an artifact into this entity. Trigger-owned (329 '
  'edges_link_counters), rebuildable, never written by an RPC.';
comment on column public.entity_counters.drawings is
  'attached_to edges from a drawing into this entity. Trigger-owned (329 '
  'edges_link_counters), rebuildable, never written by an RPC.';

-- --- the single writer ------------------------------------------------------

create or replace function internal.maintain_link_counters() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  peer text;
begin
  -- Decrement per the OLD row, increment per the NEW row — an UPDATE that
  -- moves an endpoint or retypes an edge nets out correctly (108).
  if tg_op in ('DELETE','UPDATE') then
    if old.type = 'attached_to' then
      select pe.kind into peer from public.entities pe where pe.id = old.src_id;
      if peer in ('doc','artifact','drawing') then
        update public.entity_counters
           set docs      = case when peer = 'doc'      then greatest(docs - 1, 0)      else docs end,
               artifacts = case when peer = 'artifact' then greatest(artifacts - 1, 0) else artifacts end,
               drawings  = case when peer = 'drawing'  then greatest(drawings - 1, 0)  else drawings end,
               updated_at = now()
         where entity_id = old.dst_id;
      end if;
    elsif old.type in ('remembers','tracks') then
      select pe.kind into peer from public.entities pe where pe.id = old.dst_id;
      if (old.type = 'remembers' and peer = 'memory')
         or (old.type = 'tracks' and peer = 'pull_request') then
        update public.entity_counters
           set memories = case when peer = 'memory'       then greatest(memories - 1, 0) else memories end,
               prs      = case when peer = 'pull_request' then greatest(prs - 1, 0)      else prs end,
               updated_at = now()
         where entity_id = old.src_id;
      end if;
    end if;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    if new.type = 'attached_to' then
      select pe.kind into peer from public.entities pe where pe.id = new.src_id;
      if peer in ('doc','artifact','drawing') then
        update public.entity_counters
           set docs      = case when peer = 'doc'      then docs + 1      else docs end,
               artifacts = case when peer = 'artifact' then artifacts + 1 else artifacts end,
               drawings  = case when peer = 'drawing'  then drawings + 1  else drawings end,
               updated_at = now()
         where entity_id = new.dst_id;
      end if;
    elsif new.type in ('remembers','tracks') then
      select pe.kind into peer from public.entities pe where pe.id = new.dst_id;
      if (new.type = 'remembers' and peer = 'memory')
         or (new.type = 'tracks' and peer = 'pull_request') then
        update public.entity_counters
           set memories = case when peer = 'memory'       then memories + 1 else memories end,
               prs      = case when peer = 'pull_request' then prs + 1      else prs end,
               updated_at = now()
         where entity_id = new.src_id;
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

-- --- backfill ---------------------------------------------------------------
--
-- Same predicate as the trigger, run once, and SCOPED like 108's to entities
-- that actually hold a counted edge: every touched counter row emits a
-- `counter.changed` event, and rewriting every row would flood the log.

update public.entity_counters ec
   set prs = (select count(*)
                from public.edges ed
                join public.entities pe on pe.id = ed.dst_id
               where ed.src_id = ec.entity_id
                 and ed.type = 'tracks' and pe.kind = 'pull_request'),
       artifacts = (select count(*)
                      from public.edges ed
                      join public.entities pe on pe.id = ed.src_id
                     where ed.dst_id = ec.entity_id
                       and ed.type = 'attached_to' and pe.kind = 'artifact'),
       drawings = (select count(*)
                     from public.edges ed
                     join public.entities pe on pe.id = ed.src_id
                    where ed.dst_id = ec.entity_id
                      and ed.type = 'attached_to' and pe.kind = 'drawing'),
       updated_at = now()
 where exists (select 1
                 from public.edges ed
                 join public.entities pe on pe.id = ed.dst_id
                where ed.src_id = ec.entity_id and ed.type = 'tracks' and pe.kind = 'pull_request')
    or exists (select 1
                 from public.edges ed
                 join public.entities pe on pe.id = ed.src_id
                where ed.dst_id = ec.entity_id and ed.type = 'attached_to'
                  and pe.kind in ('artifact','drawing'));
