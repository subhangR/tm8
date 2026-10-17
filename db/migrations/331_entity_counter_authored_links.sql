-- 331 — TILE COUNT FACTS, PART THREE: count what a session or chat CREATED
-- and the sessions it LAUNCHED.
--
-- A session's tile showed almost nothing: what a session makes is recorded
-- as `authored_from` (entity -> the session or chat that created it, written
-- by the server's recorders, 308/327), and 329 counted only `attached_to`,
-- `tracks` and `remembers`. Subhang, 2026-10-17 (task 01a14af9-c46a): "I need
-- the entities that session created or attached to, or whatever, all of
-- those shown on the session."
--
-- THE RULES — each group counts DISTINCT PEERS over the union of its edges,
-- on the holder:
--
--   * docs / artifacts / drawings — peers of that kind with an `attached_to`
--                  (329) OR an `authored_from` edge into the holder;
--   * prs        — pull_requests the holder `tracks` (329) OR that are
--                  `authored_from` the holder;
--   * memories   — memories the holder `remembers` (108) OR that are
--                  `authored_from` the holder;
--   * sessions   — NEW: work_sessions `launched_by` the holder (330), so a
--                  chat's tile, and a session that launched sub-sessions,
--                  say how many sessions they started.
--
-- So a doc a session both created and attached counts once, and a PR it
-- created and also tracks counts once. `authored_from` only ever ends at a
-- chat or a work_session, so a task's counts are unchanged.
--
-- ONE WRITER STAYS ONE WRITER: `internal.maintain_link_counters` is replaced
-- again and the existing `edges_link_counters` trigger keeps calling it. It
-- stays incremental (108's shape) and gains the distinct rule: an edge moves
-- a count only when it is the holder's ONLY counted link to that peer. Each
-- side of the row checks "is there another counted link between this peer
-- and this holder, other than this edge row?" against the table as it stands
-- after the statement. For an UPDATE both sides see the same rows minus this
-- one, so a re-point (308's rewrite, or any endpoint move) or a retype nets
-- out: old pair decremented iff nothing else links it, new pair incremented
-- iff nothing else already did.
--
-- Peer kinds stay tested against the PEER ROW, so `authored_from` from a
-- message (every chat post) or from a session (its launcher) moves nothing:
-- a launched session is counted through `launched_by` alone.

alter table public.entity_counters
  add column if not exists sessions integer not null default 0;

-- --- the classifier ---------------------------------------------------------

-- Which counter, if any, an edge row feeds: the holder, the peer and the
-- group column. Null group = not a counted edge.
create or replace function internal.link_counter_group(
  p_type text, p_src_id uuid, p_dst_id uuid,
  out holder uuid, out peer uuid, out grp text)
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  k text;
begin
  if p_type in ('attached_to','authored_from') then
    select pe.kind into k from public.entities pe where pe.id = p_src_id;
    if k in ('doc','artifact','drawing')
       or (p_type = 'authored_from' and k in ('pull_request','memory')) then
      holder := p_dst_id;
      peer := p_src_id;
    end if;
  elsif p_type = 'launched_by' then
    select pe.kind into k from public.entities pe where pe.id = p_src_id;
    if k = 'work_session' then
      holder := p_dst_id;
      peer := p_src_id;
    end if;
  elsif p_type in ('tracks','remembers') then
    select pe.kind into k from public.entities pe where pe.id = p_dst_id;
    if (p_type = 'tracks' and k = 'pull_request') or (p_type = 'remembers' and k = 'memory') then
      holder := p_src_id;
      peer := p_dst_id;
    end if;
  end if;
  if peer is not null then
    grp := case k when 'doc' then 'docs' when 'artifact' then 'artifacts'
                  when 'drawing' then 'drawings' when 'pull_request' then 'prs'
                  when 'memory' then 'memories' when 'work_session' then 'sessions' end;
  end if;
end
$$;

-- Does any counted edge other than p_except link this peer to this holder?
create or replace function internal.link_counter_linked(
  p_holder uuid, p_peer uuid, p_grp text, p_except uuid)
returns boolean
language sql stable set search_path = public, internal, pg_temp as $$
  select exists (
    select 1 from public.edges e
     where e.id <> p_except
       and ((e.src_id = p_peer and e.dst_id = p_holder
             and ((e.type = 'authored_from' and p_grp <> 'sessions')
                  or (e.type = 'attached_to' and p_grp in ('docs','artifacts','drawings'))
                  or (e.type = 'launched_by' and p_grp = 'sessions')))
         or (e.src_id = p_holder and e.dst_id = p_peer
             and ((e.type = 'tracks' and p_grp = 'prs')
                  or (e.type = 'remembers' and p_grp = 'memories')))))
$$;

-- --- the single writer ------------------------------------------------------

create or replace function internal.maintain_link_counters() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  g record;
begin
  -- The OLD row's pair loses a peer, the NEW row's pair gains one — each
  -- only when no other counted edge links that pair. (OLD is null on INSERT
  -- and NEW on DELETE, so the guards only keep the classifier from running.)
  for g in
    select c.holder, c.peer, c.grp, -1 as delta, old.id as edge_id
      from internal.link_counter_group(old.type, old.src_id, old.dst_id) c
     where tg_op in ('DELETE','UPDATE')
    union all
    select c.holder, c.peer, c.grp, 1, new.id
      from internal.link_counter_group(new.type, new.src_id, new.dst_id) c
     where tg_op in ('INSERT','UPDATE')
  loop
    continue when g.grp is null
               or internal.link_counter_linked(g.holder, g.peer, g.grp, g.edge_id);
    update public.entity_counters
       set docs      = case when g.grp = 'docs'      then greatest(docs + g.delta, 0)      else docs end,
           prs       = case when g.grp = 'prs'       then greatest(prs + g.delta, 0)       else prs end,
           artifacts = case when g.grp = 'artifacts' then greatest(artifacts + g.delta, 0) else artifacts end,
           drawings  = case when g.grp = 'drawings'  then greatest(drawings + g.delta, 0)  else drawings end,
           memories  = case when g.grp = 'memories'  then greatest(memories + g.delta, 0)  else memories end,
           sessions  = case when g.grp = 'sessions'  then greatest(sessions + g.delta, 0)  else sessions end,
           updated_at = now()
     where entity_id = g.holder;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

-- --- backfill ---------------------------------------------------------------
--
-- Recount every holder of a counted edge under the distinct rule, and write
-- only the rows whose numbers change: every touched counter row emits a
-- `counter.changed` event (108), and a holder with no authored_from link
-- already reads the same under the old rule.

with links as (
  select c.holder, c.peer, c.grp
    from public.edges ed
    cross join lateral internal.link_counter_group(ed.type, ed.src_id, ed.dst_id) c
   where ed.type in ('attached_to','authored_from','launched_by','tracks','remembers')
     and c.grp is not null
), recount as (
  select holder,
         count(distinct peer) filter (where grp = 'docs')::integer      as docs,
         count(distinct peer) filter (where grp = 'prs')::integer       as prs,
         count(distinct peer) filter (where grp = 'artifacts')::integer as artifacts,
         count(distinct peer) filter (where grp = 'drawings')::integer  as drawings,
         count(distinct peer) filter (where grp = 'memories')::integer  as memories,
         count(distinct peer) filter (where grp = 'sessions')::integer  as sessions
    from links
   group by holder
)
update public.entity_counters ec
   set docs = r.docs, prs = r.prs, artifacts = r.artifacts,
       drawings = r.drawings, memories = r.memories, sessions = r.sessions, updated_at = now()
  from recount r
 where ec.entity_id = r.holder
   and (ec.docs, ec.prs, ec.artifacts, ec.drawings, ec.memories, ec.sessions)
       is distinct from (r.docs, r.prs, r.artifacts, r.drawings, r.memories, r.sessions);

comment on column public.entity_counters.docs is
  'Distinct docs attached_to or authored_from this entity. Trigger-owned (331 '
  'edges_link_counters), rebuildable, never written by an RPC.';
comment on column public.entity_counters.prs is
  'Distinct pull_requests this entity tracks or that are authored_from it. '
  'Trigger-owned (331 edges_link_counters), rebuildable, never written by an RPC.';
comment on column public.entity_counters.artifacts is
  'Distinct artifacts attached_to or authored_from this entity. Trigger-owned '
  '(331 edges_link_counters), rebuildable, never written by an RPC.';
comment on column public.entity_counters.drawings is
  'Distinct drawings attached_to or authored_from this entity. Trigger-owned '
  '(331 edges_link_counters), rebuildable, never written by an RPC.';
comment on column public.entity_counters.memories is
  'Distinct memories this entity remembers or that are authored_from it. '
  'Trigger-owned (331 edges_link_counters), rebuildable, never written by an RPC.';
comment on column public.entity_counters.sessions is
  'Work sessions launched_by this entity. Trigger-owned (331 '
  'edges_link_counters), rebuildable, never written by an RPC.';
