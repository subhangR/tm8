-- 085 — a work session's DISPLAY TITLE becomes editable, and only that.
--
-- WHY THERE WAS NOTHING TO CALL. `work_session` sits in the server's
-- RESTRICTED_LIFECYCLE_KINDS: a session is spawned and it exits, so
-- entities.create / delete / move are owned by the execution block and the
-- generic doors refuse. entities.patch was refused with them — but a session's
-- title is not lifecycle. It is a LABEL a person reads in a list of a dozen
-- live agents, resolved once at spawn from the first linked task
-- (manifest.ts:resolveSessionTitle) and never correctable afterwards. Two
-- sessions on the same task were called the same thing forever.
--
-- THIS IS A TWELFTH DOOR ONTO THE 'entities.patch' LEDGER LABEL, and it carries
-- 038's binding for exactly the reason 038 states: internal.ledger_replay
-- resolves a stored result from (cmid, label) ALONE and cannot tell which
-- function called it, so every function sharing the label must bind the replay
-- subject or the unbound one becomes the way around all eleven. The subject
-- expression is 038's — {entity,id} against this door's own p_entity_id.
--
-- WHAT IT DELIBERATELY DOES NOT TOUCH. Only work_sessions.title. status keeps
-- its single writer (001's guard trigger, R29) — this UPDATE does not name the
-- column, so the `before update of status` trigger does not even fire — and
-- node_id, model, agent_tool, workdir and the exit evidence stay as the
-- execution block wrote them. A rename is not a lifecycle transition.
--
-- THE VERSION BUMP IS 062's, NOT A TRIGGER. work_sessions carries no
-- snapshot_entity_version trigger (that is for the versioned authoring kinds),
-- so entities.version is bumped in the function exactly as execution_resume
-- does. Without it internal.assert_version would pass twice for two concurrent
-- renames at the same expectedVersion and the loser's edit would vanish with no
-- conflict ever firing — which is the whole point of the optimistic version the
-- UI holds while the user is typing.

create or replace function public.rename_work_session(
  p_entity_id uuid,
  p_expected_version integer,
  p_actor_id uuid default null,
  p_title text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  clean text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD (038).
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;

  -- A blank rename is refused rather than stored. 049 exists because an empty
  -- title read as "Session" through REST and as nothing through the live
  -- projection — the same title disappearing on reload. The door that could
  -- re-create that state is the one that must close it.
  --
  -- THE CHARACTER SET IS SPELLED OUT ON PURPOSE. One-argument btrim() strips
  -- SPACES ONLY, so a title of a tab and a newline survives it non-empty and is
  -- stored — a title that renders as nothing in every client while the door
  -- reports success. Measured, not assumed: the test for this raised
  -- `stored title is now "\t \n"` against the one-argument form.
  clean := nullif(btrim(p_title, E' \t\r\n\f\v'), '');
  if clean is null then
    raise exception 'work session title must not be empty' using errcode = '22023';
  end if;
  -- Named here so the caller gets an invalid_input naming the limit, rather
  -- than 001's check constraint surfacing as an opaque integrity violation.
  if char_length(clean) > 500 then
    raise exception 'work session title must be at most 500 characters'
      using errcode = '22023';
  end if;

  e := internal.live_entity(p_entity_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  update public.work_sessions set title = clean where entity_id = p_entity_id;

  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated', null,
               jsonb_build_object('kind', 'work_session', 'action', 'renamed')),
             array[p_entity_id]));
end
$$;

revoke all on function public.rename_work_session(uuid, integer, uuid, text, text) from public;
grant execute on function public.rename_work_session(uuid, integer, uuid, text, text) to tm8_app;

comment on function public.rename_work_session(uuid, integer, uuid, text, text) is
  'Rename a work session. The ONLY generic-patch door onto work_session: title '
  'is a human label, every other column belongs to the execution block. Shares '
  'the entities.patch ledger label and therefore 038''s replay subject binding.';
