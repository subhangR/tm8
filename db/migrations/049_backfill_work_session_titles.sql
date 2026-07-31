-- 049 — repair work sessions created before SpawnService persisted its
-- resolved display title.
--
-- The manifest already named these sessions, but work_sessions.title remained
-- empty. REST projection repaired that to "Session" while live projection
-- exposed the empty value, so a title disappeared until reload. Prefer the
-- first linked task (the same default SpawnService uses), then the persona.
-- Never rewrite a non-blank title.

update public.work_sessions ws
   set title = coalesce(
     (
       select nullif(btrim(t.title), '')
         from public.edges edge
         join public.tasks t on t.entity_id = edge.dst_id
        where edge.src_id = ws.entity_id
          and edge.type = 'working_on'
        order by edge.created_at, edge.id
        limit 1
     ),
     (
       select nullif(btrim(tm.name), '') || ' session'
         from public.edges edge
         join public.team_members tm on tm.entity_id = edge.dst_id
        where edge.src_id = ws.entity_id
          and edge.type = 'relates_to'
        order by edge.created_at, edge.id
        limit 1
     ),
     'Session'
   )
 where nullif(btrim(ws.title), '') is null;
