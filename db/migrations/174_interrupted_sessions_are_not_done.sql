-- 174 — a session the server killed is UNFINISHED, not done.
--
-- 155 ruled the mapping `exited -> done, failed -> done`, and at the time that
-- was the whole truth available: a session had ended, and nothing recorded WHY.
-- 171 changed that. `ended_kind` now distinguishes an ending the work chose
-- ('completed', 'stopped_by_operator') from one that happened TO it
-- ('server_restart', 'crashed', 'out_of_memory').
--
-- The mapping never caught up. So a restart files every live session under Done
-- — the same bucket as work that actually finished — and an operator's
-- In Progress column empties on every deploy while the work in it is untouched.
-- Observed on a live node 2026-08-29: one service restart moved 20 sessions to
-- Done, none of which had finished anything.
--
-- Done is a claim about the WORK, not about the process. A session whose agent
-- was killed mid-task has not completed its task; it has stopped. The row it
-- belongs in is the one that says there is still something to do, with Resume
-- one click away — which is exactly `in_progress`.
--
-- WHAT DOES NOT CHANGE. `status` stays `failed`: the process is genuinely gone
-- and claiming otherwise is the lie "Liveness never lies" exists to prevent.
-- `exited` still maps to done — a session that ended on its own terms is done.
-- 'stopped_by_operator' is done: a human decided it was over, and second-
-- guessing that is how a stop button stops meaning anything.
--
-- NULL AND 'unknown' KEEP THE OLD ANSWER. A pre-171 row carries no ending fact,
-- and re-filing 153 historical rows as in_progress on the strength of an absent
-- column would be inventing a claim nobody measured — 171's own rule.

-- --- the mapping, now aware of HOW the session ended ---------------------------
create or replace function internal.session_status_category(p_status text, p_ended_kind text)
returns text language sql immutable set search_path = public, internal, pg_temp as $$
  select case
    -- Involuntary endings. The work did not finish; it was interrupted, and the
    -- three named here are the whole involuntary vocabulary 171 defines.
    when p_status = 'failed'
     and p_ended_kind in ('server_restart', 'crashed', 'out_of_memory')
    then 'in_progress'
    else internal.session_status_category(p_status)
  end
$$;

comment on function internal.session_status_category(text, text) is
  'The 155 mapping, refined by 171''s ending facts: a session ended by a '
  'server restart, a crash or an OOM kill is UNFINISHED work and files under '
  'in_progress, not done. Done is a claim about the work, and interrupted work '
  'has not finished. NULL/unknown ending keeps the one-argument answer, so no '
  'pre-171 row is re-filed on an absent fact.';

-- --- the workflow resolver learns the same fact --------------------------------
--
-- This is the branch that actually runs here: every work_session entity on this
-- node carries a `status_id`, so the bucket reaches the UI through a workflow
-- state, not through `status_category`. It resolves that state FROM the
-- category, so it must ask the same refined question.
create or replace function internal.workflow_state_for_session_status(
  p_entity_id uuid, p_status text, p_ended_kind text)
returns uuid language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  wf_id uuid;
  category text := internal.session_status_category(p_status, p_ended_kind);
begin
  if category is null then return null; end if;
  select * into e from public.entities where id = p_entity_id;
  if e.id is null then return null; end if;

  wf_id := internal.workflow_for_entity(e.space_id, e.kind, null);
  if wf_id is null then return null; end if;

  return internal.find_workflow_state_for_category(wf_id, category);
end
$$;

-- --- the single bridge passes the fact it already has --------------------------
--
-- `work_session_transition` writes status and the ending facts in one statement
-- (171 put them there deliberately, so a row's status and its reason cannot
-- disagree about the same event), so NEW already carries `ended_kind` when this
-- fires.
create or replace function internal.bridge_session_status_to_state() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  category       text := internal.session_status_category(new.status, new.ended_kind);
  resolved_state uuid := internal.workflow_state_for_session_status(
                           new.entity_id, new.status, new.ended_kind);
begin
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

-- Fire on the ending facts too. Without this a row whose `ended_kind` is written
-- in a later statement than its `status` keeps the bucket the status alone
-- implied — the failure this migration exists to end, arriving by a different
-- door.
drop trigger if exists work_sessions_category_bridge on public.work_sessions;
create trigger work_sessions_category_bridge
after insert or update of status, ended_kind on public.work_sessions
for each row execute function internal.bridge_session_status_to_state();

-- --- re-file the sessions this node already interrupted ------------------------
--
-- Only rows that CARRY an involuntary ending fact, which is exactly the set 171
-- has been recording since it landed. Nothing is invented for a row that never
-- measured why it stopped.
-- The transition guard forbids Done -> In Progress: `category_transition_allowed`
-- has no backward arm, and rightly so — nothing in normal operation should walk
-- work back out of Done. This backfill is not normal operation. It is correcting
-- rows that were filed under Done by the very mapping this migration replaces,
-- and every one of them carries an involuntary ending fact proving it never
-- finished.
--
-- So the guard comes off for the duration, 147's escape as 155 used it: a
-- table-owner `disable trigger`, rolled back with the migration if anything
-- below fails. NOT `session_replication_role`, which is superuser-only.
--
-- `entities_status_from_state` is BOTH the guard and what derives
-- `status_category` from `status_id` (155's header says so). Disabling it means
-- the derivation stops too, so this writes BOTH columns explicitly rather than
-- setting the state and trusting a trigger that is switched off.
alter table public.entities disable trigger entities_status_from_state;
alter table public.entities disable trigger entities_capture_event_upd;

-- The transition guard forbids Done -> In Progress: `category_transition_allowed`
-- has no backward arm, and rightly so — nothing in normal operation should walk
-- work back out of Done. This backfill is not normal operation. It corrects rows
-- filed under Done by the very mapping this migration replaces, and every one of
-- them carries an involuntary ending fact proving it never finished.
--
-- So the guard comes off for the duration: 147's escape as 155 used it, a
-- table-owner `disable trigger`, rolled back with the migration if anything below
-- fails. NOT `session_replication_role`, which is superuser-only.
--
-- `entities_status_from_state` is BOTH the guard and what derives
-- `status_category` from `status_id` (155's header says so), so disabling it
-- stops the derivation too. This therefore writes BOTH columns explicitly rather
-- than setting the state and trusting a trigger that is switched off.
alter table public.entities disable trigger entities_status_from_state;
alter table public.entities disable trigger entities_capture_event_upd;

do $$
declare r record; st uuid; cat text; moved int := 0;
begin
  for r in
    select w.entity_id, w.status, w.ended_kind
      from public.work_sessions w
      join public.entities e on e.id = w.entity_id
     where w.status = 'failed'
       and w.ended_kind in ('server_restart', 'crashed', 'out_of_memory')
  loop
    cat := internal.session_status_category(r.status, r.ended_kind);
    st  := internal.workflow_state_for_session_status(r.entity_id, r.status, r.ended_kind);
    update public.entities
       set status_id       = coalesce(st, status_id),
           status_category = coalesce(cat, status_category)
     where id = r.entity_id
       and (status_id is distinct from coalesce(st, status_id)
         or status_category is distinct from coalesce(cat, status_category));
    if found then moved := moved + 1; end if;
  end loop;
  raise notice 're-filed % interrupted session(s) as in_progress', moved;
end $$;

alter table public.entities enable trigger entities_capture_event_upd;
alter table public.entities enable trigger entities_status_from_state;
