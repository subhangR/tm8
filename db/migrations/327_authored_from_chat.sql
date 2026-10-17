-- =============================================================================
-- 327 — "CREATED HERE": A CHAT RECORDS WHAT IT MAKES (task 01a14a4a-8f94).
--
-- The chat's created-here strip lists the roots a chat (or a session) made,
-- by kind. 308 gave every entity a live WORK SESSION made a server-written
-- `authored_from` edge, and 176 already lets a chat be that edge's
-- destination (a chat-agent post carries authored_from(message -> chat)). Two
-- gaps kept the strip from reading that one edge:
--
--   1. `record_authored_from` only accepted a work session as the origin, so a
--      task, doc or artifact a CHAT runtime created recorded nothing. It now
--      also accepts a chat, on the same test: the chat is not deleted, is in
--      the entity's space, and its teammate is who created the entity (the chat
--      runtime acts as that teammate). The server passes the caller's verified
--      `runtimeChatId` (never a client-supplied id).
--   2. It skipped work sessions. A session's spawner is already its parent
--      (`resolveSpawnParentId`), so a session records `authored_from` to the
--      origin only when that origin IS its parent — a server fact, no teammate
--      test needed. Existing sessions are backfilled the same way (below).
--
-- Messages and forms stay excluded: they have their own recorders, and a
-- session's messages must never flood a story walk.
--
-- The second parameter keeps its 308 name (`p_work_session_id`): CREATE OR
-- REPLACE cannot rename an input parameter. It now names a session OR a chat.
-- =============================================================================


create or replace function public.record_authored_from(p_entity_id uuid, p_work_session_id uuid)
returns uuid
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  origin public.entities;
  edge_row_id uuid;
begin
  select * into e from public.entities where id = p_entity_id and deleted_at is null;
  if e.id is null or e.kind in ('message', 'form') then
    return null;
  end if;
  select id into edge_row_id from public.edges where src_id = p_entity_id and type = 'authored_from';
  if edge_row_id is not null then
    return edge_row_id;
  end if;
  select * into origin from public.entities
   where id = p_work_session_id and deleted_at is null and space_id = e.space_id;
  if origin.id is null then
    return null;
  end if;
  if e.kind = 'work_session' then
    -- A session was made where it was spawned, and that is its parent.
    if origin.kind not in ('work_session', 'chat') or e.parent_id is distinct from origin.id then
      return null;
    end if;
  elsif origin.kind = 'work_session' then
    if not exists (
      select 1
        from public.work_sessions ws
        join public.edges p on p.dst_id = ws.entity_id and p.type = 'participates_in'
       where ws.entity_id = origin.id
         and ws.status in ('spawning', 'running', 'idle')
         and p.src_id = e.created_by) then
      return null;
    end if;
  elsif origin.kind = 'chat' then
    if not exists (
      select 1 from public.chats c
       where c.entity_id = origin.id and c.teammate_id = e.created_by) then
      return null;
    end if;
  else
    return null;
  end if;
  perform internal.w1_set_writer('entity_recorder');
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (e.space_id, p_entity_id, origin.id, 'authored_from', e.created_by)
  on conflict do nothing
  returning id into edge_row_id;
  perform internal.w1_set_writer(null);
  return edge_row_id;
end
$$;
revoke all on function public.record_authored_from(uuid, uuid) from public;
grant execute on function public.record_authored_from(uuid, uuid) to tm8_app;

-- Backfill: every session spawned under a chat or a session records it.
do $$
begin
  perform internal.w1_set_writer('entity_recorder');
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  select s.space_id, s.id, p.id, 'authored_from', s.created_by
    from public.entities s
    join public.entities p on p.id = s.parent_id
   where s.kind = 'work_session' and s.deleted_at is null
     and p.kind in ('work_session', 'chat') and p.deleted_at is null
     and p.space_id = s.space_id
     and not exists (select 1 from public.edges g where g.src_id = s.id and g.type = 'authored_from')
  on conflict do nothing;
  perform internal.w1_set_writer(null);
end
$$;

