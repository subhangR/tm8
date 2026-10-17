-- =============================================================================
-- 327 — WHAT AN ENTITY PRODUCED OR HAS LINKED, as five tile counts.
--
-- Task 01a14655-e507. The owner's ruling (chat 77ae261d, 2026-10-16): a list
-- tile's meta line shows Docs · PRs · Artifacts · Drawings · Memories that the
-- entity produced or has linked to it, as numbers. Message counts leave the
-- tile. And what a session or chat makes must reach it without the agent
-- remembering to draw an edge.
--
-- 1. PROVENANCE. `public.record_authored_from` (308) recorded `authored_from`
--    only toward a work session. A CHAT's agent runs on an `agent_runtime`
--    bearer that names its chat, not a session, so everything a chat created
--    was left unlinked although 176 already admits a chat as the destination.
--    It now accepts either: a live work session whose participating teammate
--    created the entity (unchanged), or a live chat whose teammate did. The
--    server passes the bearer's verified chat id (never request input).
--
-- 2. COUNTS. `entity_counters.linked_{docs,pull_requests,artifacts,drawings,
--    memories}`: the number of DISTINCT live peers of that kind joined to the
--    holder by any of these edges (holder = H, peer = P):
--
--      authored_from  P -> H   P was made during session/chat H
--      attached_to    P -> H   P is context on H (a doc on a task)
--      produces       H -> P   P is H's deliverable
--      tracks         H -> P   H ships as PR/commit P
--      remembers      H -> P   P is in H's memory set
--
--    DISTINCT is the point: a doc a session made AND attached to its task, or
--    a doc both attached to and produced by a task, counts once.
--
--    TASK ROLL-UP. A task also counts what its sessions produced WHILE they
--    worked on it: P reached from session S through one of the edges above,
--    where S has a `working_on` claim on the task and the S–P edge was made
--    inside the claim's window [claim created_at, props.endedAt or now]. The
--    window keeps a long session that claimed ten tasks in turn from smearing
--    every output over all ten. Rolled-up peers join the same DISTINCT set, so
--    a doc linked to the task directly and made by its session counts once.
--
--    One writer, as 001 §8 requires: the edge trigger below RECOMPUTES the
--    affected holders from the edges, it never increments, so a missed event
--    can never leave drift that later events compound, and
--    `internal.refresh_output_counts` rebuilds any holder exactly. A soft
--    delete or restore of a counted peer recomputes its holders too: unlike
--    108's docs/memories, a deleted doc stops counting.
--
--    108's `docs`/`memories` stay as they were (old clients read them).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. authored_from toward a chat
-- ---------------------------------------------------------------------------
create or replace function public.record_authored_from(p_entity_id uuid, p_work_session_id uuid)
returns uuid
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  edge_row_id uuid;
begin
  select * into e from public.entities where id = p_entity_id and deleted_at is null;
  if e.id is null or e.kind in ('message', 'form', 'work_session') then
    return null;
  end if;
  select id into edge_row_id from public.edges where src_id = p_entity_id and type = 'authored_from';
  if edge_row_id is not null then
    return edge_row_id;
  end if;
  -- 308: a live work session whose participating teammate made the entity.
  -- 327: or a chat (not stopped) whose teammate made it. The parameter keeps
  -- its 308 name so existing callers bind unchanged.
  if not exists (
    select 1
      from public.entities s
      join public.work_sessions ws on ws.entity_id = s.id
      join public.edges p on p.dst_id = s.id and p.type = 'participates_in'
     where s.id = p_work_session_id and s.kind = 'work_session' and s.deleted_at is null
       and s.space_id = e.space_id
       and ws.status in ('spawning', 'running', 'idle')
       and p.src_id = e.created_by)
  and not exists (
    select 1
      from public.entities c
      join public.chats ch on ch.entity_id = c.id
     where c.id = p_work_session_id and c.kind = 'chat' and c.deleted_at is null
       and c.space_id = e.space_id
       and ch.runtime_state <> 'stopped'
       and ch.teammate_id = e.created_by) then
    return null;
  end if;
  perform internal.w1_set_writer('entity_recorder');
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (e.space_id, p_entity_id, p_work_session_id, 'authored_from', e.created_by)
  on conflict do nothing
  returning id into edge_row_id;
  perform internal.w1_set_writer(null);
  return edge_row_id;
end
$$;
revoke all on function public.record_authored_from(uuid, uuid) from public;
grant execute on function public.record_authored_from(uuid, uuid) to tm8_app;

-- ---------------------------------------------------------------------------
-- 2. The columns
-- ---------------------------------------------------------------------------
alter table public.entity_counters
  add column if not exists linked_docs          integer not null default 0,
  add column if not exists linked_pull_requests integer not null default 0,
  add column if not exists linked_artifacts     integer not null default 0,
  add column if not exists linked_drawings      integer not null default 0,
  add column if not exists linked_memories      integer not null default 0;

comment on column public.entity_counters.linked_docs is
  '327: distinct live docs this entity produced or has linked (authored_from in, attached_to in, '
  'produces/tracks/remembers out; a task adds its sessions'' outputs made inside each claim). '
  'Trigger-owned, recomputed, rebuildable with internal.refresh_output_counts.';
comment on column public.entity_counters.linked_pull_requests is '327: as linked_docs, for pull_request.';
comment on column public.entity_counters.linked_artifacts is '327: as linked_docs, for artifact.';
comment on column public.entity_counters.linked_drawings is '327: as linked_docs, for drawing.';
comment on column public.entity_counters.linked_memories is '327: as linked_docs, for memory.';

-- ---------------------------------------------------------------------------
-- 3. The relation, once
-- ---------------------------------------------------------------------------
create or replace function internal.output_counted_kinds()
returns text[] language sql immutable set search_path = public, internal, pg_temp as $$
  select array['doc', 'pull_request', 'artifact', 'drawing', 'memory']::text[]
$$;

-- Every live counted peer joined to H by one edge, with when that edge was
-- drawn (the roll-up windows on it). One row per edge: callers DISTINCT.
create or replace function internal.output_links(p_holder uuid)
returns table(peer_id uuid, peer_kind text, linked_at timestamptz)
language sql stable set search_path = public, internal, pg_temp as $$
  select p.id, p.kind, ed.created_at
    from public.edges ed
    join public.entities p on p.id = ed.src_id
   where ed.dst_id = p_holder and ed.type in ('authored_from', 'attached_to')
     and p.kind = any(internal.output_counted_kinds()) and p.deleted_at is null
  union all
  select p.id, p.kind, ed.created_at
    from public.edges ed
    join public.entities p on p.id = ed.dst_id
   where ed.src_id = p_holder and ed.type in ('produces', 'tracks', 'remembers')
     and p.kind = any(internal.output_counted_kinds()) and p.deleted_at is null
$$;

-- What H's tile counts: its own links, plus (for a task) what each claiming
-- session linked inside its claim. Distinct by peer.
create or replace function internal.output_peers(p_holder uuid)
returns table(peer_id uuid, peer_kind text)
language sql stable set search_path = public, internal, pg_temp as $$
  select distinct l.peer_id, l.peer_kind
    from (
      select d.peer_id, d.peer_kind from internal.output_links(p_holder) d
      union all
      select s.peer_id, s.peer_kind
        from public.edges w
        join public.entities t on t.id = w.dst_id and t.kind = 'task'
        join public.entities ws on ws.id = w.src_id and ws.kind = 'work_session'
        cross join lateral internal.output_links(w.src_id) s
       where w.dst_id = p_holder and w.type = 'working_on'
         and s.linked_at >= w.created_at
         and s.linked_at <= coalesce((w.props->>'endedAt')::timestamptz, 'infinity'::timestamptz)
    ) l
$$;

-- Recompute the given holders exactly. Locks their counter rows first, in id
-- order (one order for every caller), then counts in a NEW statement, so under
-- READ COMMITTED the count sees any concurrent writer that held the lock
-- before us. Writes only rows whose numbers changed: every written row emits
-- a counter.changed event (003), and an unchanged one would say nothing.
create or replace function internal.refresh_output_counts(p_holders uuid[])
returns integer
language plpgsql volatile set search_path = public, internal, pg_temp as $$
declare
  n integer;
begin
  if p_holders is null or cardinality(p_holders) = 0 then
    return 0;
  end if;
  perform 1 from public.entity_counters
   where entity_id = any(p_holders)
   order by entity_id
   for update;
  with counted as (
    select h.id,
           count(*) filter (where op.peer_kind = 'doc')          as docs,
           count(*) filter (where op.peer_kind = 'pull_request') as prs,
           count(*) filter (where op.peer_kind = 'artifact')     as artifacts,
           count(*) filter (where op.peer_kind = 'drawing')      as drawings,
           count(*) filter (where op.peer_kind = 'memory')       as memories
      from unnest(p_holders) as h(id)
      left join lateral internal.output_peers(h.id) op on true
     group by h.id
  )
  update public.entity_counters ec
     set linked_docs = c.docs, linked_pull_requests = c.prs,
         linked_artifacts = c.artifacts, linked_drawings = c.drawings,
         linked_memories = c.memories, updated_at = now()
    from counted c
   where ec.entity_id = c.id
     and (ec.linked_docs, ec.linked_pull_requests, ec.linked_artifacts,
          ec.linked_drawings, ec.linked_memories)
         is distinct from (c.docs::int, c.prs::int, c.artifacts::int, c.drawings::int, c.memories::int);
  get diagnostics n = row_count;
  return n;
end
$$;

-- The holders one edge row bears on: its holder end, and (when that holder is
-- a work session) every task the session ever claimed — the roll-up reads the
-- session's links. A working_on row bears on its task.
create or replace function internal.output_holders_of_edge(p_type text, p_src uuid, p_dst uuid)
returns uuid[]
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  holder uuid;
  peer uuid;
  holder_kind text;
begin
  if p_type = 'working_on' then
    if exists (select 1 from public.entities where id = p_src and kind = 'work_session') then
      return array[p_dst];
    end if;
    return '{}';
  elsif p_type in ('authored_from', 'attached_to') then
    holder := p_dst; peer := p_src;
  elsif p_type in ('produces', 'tracks', 'remembers') then
    holder := p_src; peer := p_dst;
  else
    return '{}';
  end if;
  -- A peer of another kind bears on nothing. A peer that is GONE (a hard
  -- delete cascading its edges) might have been counted, so it still does.
  if exists (select 1 from public.entities
              where id = peer and not (kind = any(internal.output_counted_kinds()))) then
    return '{}';
  end if;
  select kind into holder_kind from public.entities where id = holder;
  if holder_kind = 'work_session' then
    return array[holder] || coalesce((
      select array_agg(distinct w.dst_id) from public.edges w
       where w.src_id = holder and w.type = 'working_on'), '{}');
  end if;
  return array[holder];
end
$$;

-- ---------------------------------------------------------------------------
-- 4. The single writer: edges, and a counted peer's delete/restore
-- ---------------------------------------------------------------------------
create or replace function internal.maintain_output_counts() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  holders uuid[] := '{}';
begin
  if tg_op in ('DELETE', 'UPDATE') then
    holders := holders || internal.output_holders_of_edge(old.type, old.src_id, old.dst_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    holders := holders || internal.output_holders_of_edge(new.type, new.src_id, new.dst_id);
  end if;
  if cardinality(holders) > 0 then
    perform internal.refresh_output_counts(
      (select array_agg(distinct h) from unnest(holders) h where h is not null));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

-- WHEN clauses keep the trigger off every other edge type (messages draw
-- several edges each; none of them is counted).
create trigger edges_output_counts_ins after insert on public.edges
for each row when (new.type in ('authored_from', 'attached_to', 'produces', 'tracks', 'remembers', 'working_on'))
execute function internal.maintain_output_counts();
create trigger edges_output_counts_upd after update on public.edges
for each row when (
  (old.type in ('authored_from', 'attached_to', 'produces', 'tracks', 'remembers', 'working_on')
   or new.type in ('authored_from', 'attached_to', 'produces', 'tracks', 'remembers', 'working_on'))
  and (old.type, old.src_id, old.dst_id, old.props) is distinct from (new.type, new.src_id, new.dst_id, new.props))
execute function internal.maintain_output_counts();
create trigger edges_output_counts_del after delete on public.edges
for each row when (old.type in ('authored_from', 'attached_to', 'produces', 'tracks', 'remembers', 'working_on'))
execute function internal.maintain_output_counts();

create or replace function internal.maintain_output_counts_on_peer() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  holders uuid[];
begin
  select coalesce(array_agg(distinct h), '{}') into holders
    from public.edges ed
    cross join lateral unnest(internal.output_holders_of_edge(ed.type, ed.src_id, ed.dst_id)) h
   where (ed.src_id = new.id and ed.type in ('authored_from', 'attached_to'))
      or (ed.dst_id = new.id and ed.type in ('produces', 'tracks', 'remembers'));
  perform internal.refresh_output_counts(holders);
  return new;
end
$$;

create trigger entities_output_counts_peer after update of deleted_at on public.entities
for each row when (old.deleted_at is distinct from new.deleted_at
                   and new.kind in ('doc', 'pull_request', 'artifact', 'drawing', 'memory'))
execute function internal.maintain_output_counts_on_peer();

-- ---------------------------------------------------------------------------
-- 5. Backfill: every holder with a counted edge, and every task a session
--    claimed (its roll-up). Set-based: the per-edge helper would run once per
--    message edge. Only rows whose numbers change are written, so the event
--    log carries one counter.changed per holder that has something to show.
-- ---------------------------------------------------------------------------
do $$
declare
  batch uuid[];
begin
  for batch in
    select array_agg(id) from (
      select id, (row_number() over (order by id) - 1) / 500 as chunk
        from (
          select ed.dst_id as id
            from public.edges ed join public.entities p on p.id = ed.src_id
           where ed.type in ('authored_from', 'attached_to')
             and p.kind = any(internal.output_counted_kinds())
          union
          select ed.src_id
            from public.edges ed join public.entities p on p.id = ed.dst_id
           where ed.type in ('produces', 'tracks', 'remembers')
             and p.kind = any(internal.output_counted_kinds())
          union
          select ed.dst_id
            from public.edges ed join public.entities s on s.id = ed.src_id
           where ed.type = 'working_on' and s.kind = 'work_session'
        ) holders
    ) chunked
    group by chunk order by chunk
  loop
    perform internal.refresh_output_counts(batch);
  end loop;
end
$$;
