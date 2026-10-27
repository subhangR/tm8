-- =============================================================================
-- 288 — a story's status is SETTABLE (task 01a0fe59, issues #6 and #8).
--
-- 283 gave a story "the status every kind already has" (152's birth trigger
-- seeds it `to_do`) and no way to move it: `update_story_entity` wrote title
-- and description only, so every story stayed `to_do` forever — four finished
-- chapters at to_do, a parent at to_do over ~80 working tasks.
--
-- THE DOOR. `update_story_entity` grows ONE argument, `p_status`, and the
-- facade reaches it through `entities.patch` with `content.status` — the
-- worktree posture (its status transition also rides the patch door). ZERO new
-- catalog rows. `null` MERGES like the other two fields: a rename does not
-- touch the status.
--
-- WHAT `p_status` NAMES, in this order:
--   1. a CATEGORY — to_do | in_progress | done | cancelled — resolved through
--      `internal.workflow_state_for_category` (the door resolver every other
--      door uses: is_default, else lowest position);
--   2. else a STATE NAME of the story's workflow, case-insensitive, so a space
--      that authors a story workflow (`entity_kinds.workflow_id`, 152) can
--      move to "Shipped" by name.
-- Anything else is refused 22023 naming the allowed values.
--
-- THE MOVE IS NOT RE-RULED HERE. The status_id write goes through 149's
-- `entities_status_from_state` trigger like every other writer, so the ruled
-- category transitions (and any workflow_transitions override) apply as they
-- do to a task (175's matrix): e.g. done -> in_progress is refused
-- `transition_not_allowed`; reopening goes through to_do.
--
-- DECISION: STATUS IS MANUAL, NOT DERIVED (recorded on the task and in
-- `tm8 help entity update`). The story's derived signal is its `progress` /
-- `taskProgress`, computed at read time (283 D1: the trail is never stored).
-- Deriving a STORED status would mean writing the story on every change to
-- anything its trail follows, which is the materialisation D1 ruled out; and
-- an auto-status cannot also be set, which is the complaint this file fixes.
-- `entity context` points at the setter when progress and status disagree.
--
-- SIGNATURE CHANGE: a seventh defaulted argument beside the six-argument
-- original would make every six-argument call ambiguous, so the old function
-- is DROPPED and re-created. The facade is the only caller and changes in the
-- same commit. Body is 283's verbatim plus the status arm.
-- =============================================================================

set role tm8_graph_owner;

drop function public.update_story_entity(uuid, integer, uuid, text, text, text);

create function public.update_story_entity(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_description text default null,
  p_client_mutation_id text default null,
  p_status text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  wanted text;
  target uuid;
  before_category text;
  moved integer := 0;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_entity_id, 'story');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  if p_title is not null and length(btrim(p_title)) not between 1 and 200 then
    raise exception 'story title must be 1..200 chars after trim' using errcode = '22023';
  end if;
  if p_description is not null and length(p_description) > 20000 then
    raise exception 'story description is too long (% chars; limit 20000)', length(p_description) using errcode = '22023';
  end if;

  before_category := e.status_category;
  if p_status is not null then
    wanted := lower(btrim(p_status));
    if wanted in ('to_do', 'in_progress', 'done', 'cancelled') then
      target := internal.workflow_state_for_category(p_entity_id, wanted);
    else
      select s.id into target
        from public.workflow_states s
       where s.workflow_id = internal.workflow_for_entity(e.space_id, e.kind, null)
         and lower(s.name) = wanted
       order by s.position
       limit 1;
    end if;
    if target is null then
      raise exception 'unknown story status %: use to_do, in_progress, done, cancelled or a state name of the story''s workflow', p_status
        using errcode = '22023';
    end if;
    -- 149's trigger validates the move and derives status_category.
    update public.entities set status_id = target
     where id = p_entity_id and status_id is distinct from target;
    get diagnostics moved = row_count;
  end if;

  update public.stories
     set title       = coalesce(btrim(p_title), title),
         description = coalesce(p_description, description),
         updated_at  = now()
   where entity_id = p_entity_id;

  -- 156's lesson: nothing bumps `entities.version` on a status_id write by
  -- itself, and the stories snapshot trigger skips a row whose columns did not
  -- change. A moved status is a new version so a pinned client conflicts —
  -- exactly one, so not again when a title/description edit already moved it.
  if moved > 0 then
    update public.entities
       set version = version + 1, updated_at = now(), activity_at = now()
     where id = p_entity_id and version = e.version;
  end if;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, case
                 when p_status is null then jsonb_build_object('kind', 'story')
                 else jsonb_build_object('kind', 'story', 'action', 'status_changed',
                        'fromCategory', before_category,
                        'toCategory', (select status_category from public.entities where id = p_entity_id))
               end), array[p_entity_id]));
end
$$;

revoke all on function public.update_story_entity(uuid,integer,uuid,text,text,text,text) from public;
grant execute on function public.update_story_entity(uuid,integer,uuid,text,text,text,text) to tm8_app;

reset role;
