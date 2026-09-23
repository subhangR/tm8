-- 204 — the session bridge skips a move the algebra refuses, again.
--
-- 156 taught `internal.bridge_session_status_to_state()` one rule: when the
-- envelope a status implies is a transition `category_transition_allowed`
-- refuses, SKIP the write instead of attempting it. That rule is the whole of
-- "tick marks the session done, but does not close it": a user files a RUNNING
-- session under Done, the process later reports idle/running, the bridge asks
-- for `done -> in_progress`, and 149's guard would raise 23514 — inside
-- `public.work_session_transition`, the node's own writer, with no user in
-- front of it.
--
-- 174 re-created the function to pass `ended_kind` through to the mapping and,
-- in doing so, rewrote it from 155's body rather than 156's. The guard was lost.
-- Every tick since has been one process-status write away from breaking the
-- session's lifecycle, and `session-mark-done.pg.test.ts` (156's tripwire pair)
-- is red on main for exactly this reason.
--
-- This is 156's body with 174's two-argument mapping — nothing else changes.
--
-- WHY THE GUARD DOES NOT UNDO 174. 174's point is that an interrupted session
-- (failed + server_restart/crashed/out_of_memory) files under in_progress, not
-- done. A session that is RUNNING when it is interrupted sits in in_progress,
-- so `in_progress -> in_progress` is the same-category no-op and the guard
-- never fires. The only row the guard holds in Done is one a human put there
-- — which is the tick, and which 156 ruled must stick. 174's backfill of
-- historical rows ran with the guard switched off and is unaffected.
create or replace function internal.bridge_session_status_to_state() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  category       text := internal.session_status_category(new.status, new.ended_kind);
  resolved_state uuid := internal.workflow_state_for_session_status(
                           new.entity_id, new.status, new.ended_kind);
  current_cat    text;
begin
  -- Where the row IS, which is not necessarily where its status says it should
  -- be — that gap is the authored tick (156).
  select e.status_category into current_cat
    from public.entities e
   where e.id = new.entity_id;

  if category is not null
     and current_cat is not null
     and not internal.category_transition_allowed(current_cat, category)
  then
    return new;
  end if;

  if resolved_state is not null then
    update public.entities
       set status_id = resolved_state
     where id = new.entity_id
       and status_id is distinct from resolved_state;
    return new;
  end if;

  if category is not null then
    update public.entities
       set status_category = category
     where id = new.entity_id
       and status_category is distinct from category;
  end if;
  return new;
end
$$;

comment on function internal.bridge_session_status_to_state() is
  '155 bridge + 156 guard + 174 ending facts. Derives the envelope from '
  'work_sessions.status and ended_kind, but SKIPS any move '
  'internal.category_transition_allowed refuses — which is what lets a '
  'user-authored done survive the process going idle underneath it, and what '
  'stops that skip being a 23514 raised inside work_session_transition. 174 '
  'dropped the guard when it re-created this function; 204 restores it.';
