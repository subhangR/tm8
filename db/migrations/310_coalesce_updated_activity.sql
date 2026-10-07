-- =============================================================================
-- 310 — Coalesce autosave 'updated' activity (task 01a1163b-1792).
--
-- Doc and task bodies now autosave on a debounce, so one sitting of typing
-- would write one 'updated' activity row (and, through 003's
-- activity_capture_event trigger, one workspace event) per pause. The feed
-- and the entity's activity list fill with "updated" rows that say nothing new.
--
-- internal.record_activity now RETURNS THE EXISTING ROW'S ID instead of
-- inserting when all of these hold for the entity's latest activity row:
--   * the new verb is 'updated' and the summary is a body save —
--     {kind:'doc'} (update_document) or {kind:'task'} (update_task_content);
--   * the latest row is also 'updated', by the same actor, with the same
--     ref_id and the same summary;
--   * the latest row was written less than 10 minutes ago.
-- Anything in between (a comment, a status change, another person's edit)
-- breaks the run, so the feed still shows who edited around what.
--
-- The kept row's created_at is NOT bumped: activity keyset cursors order on
-- (created_at, id), and moving a row would let a page skip or repeat it. The
-- window is therefore measured from the first save of the run.
--
-- No row is inserted, so no workspace event fires either; the command result
-- and ledger still carry an activity id (the kept row's), which hydrates
-- normally. Every other verb and summary keeps the old insert-always path.
-- =============================================================================

create or replace function internal.record_activity(
  p_space uuid, p_entity uuid, p_actor uuid, p_verb text,
  p_ref uuid default null, p_summary jsonb default '{}'::jsonb
) returns uuid language plpgsql set search_path = public, internal, pg_temp as $$
declare
  v_summary jsonb := coalesce(p_summary, '{}'::jsonb);
  latest public.activity%rowtype;
  activity_id uuid;
begin
  if p_verb = 'updated'
     and p_entity is not null
     and p_actor is not null
     and v_summary in ('{"kind":"doc"}'::jsonb, '{"kind":"task"}'::jsonb) then
    select * into latest
      from public.activity a
     where a.entity_id = p_entity
     order by a.created_at desc, a.id desc
     limit 1;
    if found
       and latest.verb = 'updated'
       and latest.actor_id = p_actor
       and latest.space_id = p_space
       and latest.ref_id is not distinct from p_ref
       and latest.summary = v_summary
       and latest.created_at > now() - interval '10 minutes' then
      return latest.id;
    end if;
  end if;

  insert into public.activity(space_id, entity_id, actor_id, verb, ref_id, summary)
  values (p_space, p_entity, p_actor, p_verb, p_ref, v_summary)
  returning id into activity_id;
  return activity_id;
end
$$;
