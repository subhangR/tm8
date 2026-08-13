-- 108 — TILE COUNT FACTS: `entity_counters.docs` / `entity_counters.memories`.
--
-- A tile answers "does this task/session carry docs, memories, messages"
-- at a glance, from the summary it already holds. `messages` has ridden
-- `entity_counters` since 001; the other two counted nothing anywhere, so a
-- reader had to open the entity to learn the answer existed.
--
-- THE ONE-WRITER INVARIANT (001 §8), kept exactly: counters are derived,
-- trigger-owned and rebuildable. RPCs never touch these columns; the single
-- writer is the edge trigger below, the same shape as
-- `internal.maintain_reaction_counters`. The counted relations are:
--
--   * docs      — `attached_to` edges whose SOURCE is a `doc`, counted on the
--                 edge's DESTINATION (001's registry: src = the attachment,
--                 dst = what it decorates);
--   * memories  — `remembers` edges whose DESTINATION is a `memory`, counted
--                 on the edge's SOURCE (056/090: src = the holder).
--
-- The kind test is against the PEER ROW, not the edge type alone: 007's
-- attachTo mints `attached_to` from files and other kinds too, and only docs
-- are being counted here. A soft-deleted peer keeps its count — edges survive
-- entity soft-delete, and the reaction counters behave identically; the
-- decrement event is the edge's own deletion.
--
-- Projected additively as OPTIONAL `docs`/`memories` on EntityCounters:
-- a rolling client renders NOTHING for absence, and zero also renders
-- nothing — a badge exists to say "there is something here".

alter table public.entity_counters
  add column if not exists docs     integer not null default 0,
  add column if not exists memories integer not null default 0;

comment on column public.entity_counters.docs is
  'attached_to edges from a doc into this entity. Trigger-owned (108 '
  'edges_link_counters), rebuildable, never written by an RPC.';
comment on column public.entity_counters.memories is
  'remembers edges from this entity to a memory. Trigger-owned (108 '
  'edges_link_counters), rebuildable, never written by an RPC.';

-- --- the single writer ------------------------------------------------------

create or replace function internal.maintain_link_counters() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  -- Decrement per the OLD row, increment per the NEW row — an UPDATE that
  -- moves an endpoint or retypes an edge nets out correctly, exactly like
  -- maintain_reaction_counters above it in the chain.
  if tg_op in ('DELETE','UPDATE') then
    if old.type = 'attached_to'
       and exists (select 1 from public.entities pe where pe.id = old.src_id and pe.kind = 'doc') then
      update public.entity_counters
         set docs = greatest(docs - 1, 0), updated_at = now()
       where entity_id = old.dst_id;
    end if;
    if old.type = 'remembers'
       and exists (select 1 from public.entities pe where pe.id = old.dst_id and pe.kind = 'memory') then
      update public.entity_counters
         set memories = greatest(memories - 1, 0), updated_at = now()
       where entity_id = old.src_id;
    end if;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    if new.type = 'attached_to'
       and exists (select 1 from public.entities pe where pe.id = new.src_id and pe.kind = 'doc') then
      update public.entity_counters
         set docs = docs + 1, updated_at = now()
       where entity_id = new.dst_id;
    end if;
    if new.type = 'remembers'
       and exists (select 1 from public.entities pe where pe.id = new.dst_id and pe.kind = 'memory') then
      update public.entity_counters
         set memories = memories + 1, updated_at = now()
       where entity_id = new.src_id;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger edges_link_counters after insert or update or delete on public.edges
for each row execute function internal.maintain_link_counters();

-- --- backfill ---------------------------------------------------------------
--
-- Same predicate as the trigger, run once, so pre-108 rows are honest from
-- the first read. SCOPED to entities that actually hold a counted edge:
-- every touched `entity_counters` row emits a `counter.changed` event via
-- 003's capture trigger, and rewriting every counter row in the workspace
-- would flood the log with rows that say nothing.

update public.entity_counters ec
   set docs = (select count(*)
                 from public.edges ed
                 join public.entities pe on pe.id = ed.src_id
                where ed.dst_id = ec.entity_id
                  and ed.type = 'attached_to' and pe.kind = 'doc'),
       memories = (select count(*)
                     from public.edges ed
                     join public.entities pe on pe.id = ed.dst_id
                    where ed.src_id = ec.entity_id
                      and ed.type = 'remembers' and pe.kind = 'memory'),
       updated_at = now()
 where exists (select 1 from public.edges ed
                where (ed.dst_id = ec.entity_id and ed.type = 'attached_to')
                   or (ed.src_id = ec.entity_id and ed.type = 'remembers'));
