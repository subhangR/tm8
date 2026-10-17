-- =============================================================================
-- ROLLBACK for 327_authored_from_chat.sql — NOT a migration (db/migrate.mjs
-- never reads this directory). Run by hand, as the migration owner, only to
-- undo 327:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/327_authored_from_chat.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '327_authored_from_chat.sql'"
--
-- Restores 308's `record_authored_from` (work-session origins only, sessions
-- skipped). Edges 327 recorded stay: they are ordinary recorder-written
-- `authored_from` rows and remain true.
-- =============================================================================


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
  if not exists (
    select 1
      from public.entities s
      join public.work_sessions ws on ws.entity_id = s.id
      join public.edges p on p.dst_id = s.id and p.type = 'participates_in'
     where s.id = p_work_session_id and s.kind = 'work_session' and s.deleted_at is null
       and s.space_id = e.space_id
       and ws.status in ('spawning', 'running', 'idle')
       and p.src_id = e.created_by) then
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

