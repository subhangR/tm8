-- =============================================================================
-- 156  A USER CAN FILE A SESSION UNDER DONE WITHOUT ENDING IT.
--
-- USER RULING 2026-08-19: "we need the tick mark there, tick marks the session
-- done, but does not close it … i want to mark sessions done, but not close
-- them to revisit later, this is through the tick mark."
--
-- 155 made a session's category FOLLOW its lifecycle, which fixed 420 rows
-- sitting under To Do forever. This file adds the second writer: the user. The
-- two are not in competition, because they answer different questions —
--
--     work_sessions.status     what the PROCESS is doing.   Observed by the node.
--     entities.status_category whether YOU are done with it. Authored, or
--                              derived from the status when you have not said.
--
-- A session you have ticked keeps running, keeps streaming, and keeps its
-- terminal. It stops sitting in In Progress asking to be looked at.
--
-- ## THE ONE HARD CONSTRAINT, AND WHY IT SHAPES EVERY LINE BELOW
--
-- 149's `internal.category_transition_allowed` has NO `done -> in_progress`
-- arm. That is a product ruling, not an oversight: a thing that finished and is
-- now being worked on again has been REOPENED, and reopen lands in To Do.
--
-- So the moment a user can put a RUNNING session into `done`, the 155 bridge
-- becomes a live hazard. The session is `running`; it goes `idle`; the bridge
-- computes `in_progress`; `entities_status_from_state` raises 23514 — INSIDE
-- `public.work_session_transition`, the node's own status writer, on a path no
-- user is standing in front of. A tick would have started breaking the session
-- lifecycle a few seconds later, for a reason nothing in the trace would name.
--
-- Piece 1 is what makes that impossible, and it is the whole reason this file
-- is not just a door.
--
-- ## PIECES
--
--   1. The bridge only writes a move the algebra allows. Skips, never raises.
--   2. `public.set_session_done` — the door. Envelope only; status untouched.
--   3. VERIFY.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. THE BRIDGE BECOMES A DEFAULT WRITER, NOT THE ONLY ONE.
--
-- 155's body, plus one question asked before each write: is this move legal
-- from where the row actually is?
--
-- WHAT SKIPPING BUYS, stated as the four cases that matter:
--
--   ticked while running, then goes idle
--       done -> in_progress. REFUSED by the algebra, so skipped: the row stays
--       done. This is what makes a tick STICK, and it is why no `marked_done`
--       column exists — the mark's persistence is the transition algebra's
--       existing ruling, not a second fact that could disagree with it.
--   ticked while running, then exits
--       done -> done. The same-category axiom. No-op either way.
--   ticked, then RESUMED (062 puts it back to `spawning`)
--       done -> to_do. Ruled: THE REOPEN. It happens, and it should — resuming
--       a session is the clearest possible statement that you are not done.
--   never ticked
--       every move 155 makes is already legal, so this arm changes nothing for
--       any row that existed before this file. Measured in VERIFY 3.1.
--
-- WHY SKIP RATHER THAN RAISE. The bridge is a DERIVED-DEFAULT writer running
-- inside someone else's transaction. A default that cannot be applied is not an
-- error in the thing that triggered it: the node reporting that a process went
-- idle is telling the truth and must not be refused because of a filing
-- decision a human made. 060's lesson is about doors that refuse a CALLER
-- silently; nobody is calling this.
--
-- THE FRAGILITY, NAMED SO IT IS NOT REDISCOVERED: the stickiness of a tick is
-- exactly `not category_transition_allowed('done','in_progress')`. Add that arm
-- to 149 and ticks silently stop sticking — no error, no test failure outside
-- the one below, just a feature quietly evaporating. `156_verify_tick_sticks`
-- in `session-mark-done.pg.test.ts` is the tripwire.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_session_status_to_state() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  category       text := internal.session_status_category(new.status);
  resolved_state uuid := internal.workflow_state_for_session_status(new.entity_id, new.status);
  current_cat    text;
begin
  -- Where the row IS, which is not necessarily where its status says it should
  -- be — that gap is the authored tick, and it is the whole point.
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

  -- No state to point at. Write the column directly when we at least know the
  -- bucket; leave it untouched when we do not. (155's fallback, unchanged: both
  -- arms are unreachable through any door today.)
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
  '155 bridge + 156 guard. Derives the envelope from work_sessions.status, but '
  'SKIPS any move internal.category_transition_allowed refuses — which is what '
  'lets a user-authored done survive the process going idle underneath it, and '
  'what stops that skip being a 23514 raised inside work_session_transition.';

-- -----------------------------------------------------------------------------
-- 2. THE DOOR.
--
-- ONE function rather than a mark/unmark pair: the tick is a toggle, and both
-- directions want the same version guard, the same actor resolution, the same
-- ledger key and the same event. A pair would be two places to keep all four
-- correct, and they would drift on the first change to any of them.
--
-- IT NEVER TOUCHES `work_sessions`. Not the status, not the PTY, not the exit
-- code. That is the ruling in one line — mark done, do not close — and it is
-- enforced structurally: this function has no `work_sessions` write in it, so
-- no future edit can add "and also stop it" without being visible.
--
-- ## REOPEN IS TWO MOVES, AND THE INTERMEDIATE ONE IS REAL
--
-- Reopening a session that is still `running` wants `done -> in_progress`,
-- which the algebra refuses. It is reached the way the algebra says to reach
-- it: `done -> to_do` (THE REOPEN) and then `to_do -> in_progress`. Both are
-- ruled, and the row genuinely passes through reopen — so emitting the two
-- events that implies is honest rather than a leak. Collapsing them would mean
-- either a lie about the path or an exemption from the algebra, and 149's
-- header is explicit that changing the ruled set is the intended cost of
-- wanting a different path.
--
-- A reopened session that is NOT running (stale, unknown, exited-then-ticked)
-- resolves to whatever its status names, which for `exited` is `done` — so the
-- second move is the same-category axiom and nothing happens. Un-ticking an
-- exited session is correctly a no-op: the process really did finish.
-- -----------------------------------------------------------------------------
-- ## WHY IT TAKES NO `done` ARGUMENT
--
-- It reads where the row IS and goes the other way. That is not a shortcut, it
-- is what keeps this change free of a contract amendment:
-- `CompleteTaskInputSchema` is `.strict()`, so a `done` field would have to be
-- added to the shared input of an operation whose OTHER kind has no use for it
-- — a field that is meaningless for a task, on the schema every task
-- completion validates against.
--
-- The usual objection to a stateful toggle is the lost-response retry: the
-- caller cannot tell "it worked and I missed the reply" from "it never ran",
-- and a blind retry flips the row back. That objection is already answered here
-- and not by this function — `internal.ledger_replay` above returns the FIRST
-- result for a repeated `clientMutationId` without re-executing. Idempotency
-- lives in the ledger, where every other command in this file puts it.
create or replace function public.set_session_done(
  p_entity_id          uuid,
  p_expected_version   integer,
  p_actor_id           uuid    default null,
  p_client_mutation_id text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  replay      jsonb;
  e           public.entities;
  actor       uuid;
  v_status    text;
  v_target    uuid;
  v_reopen    uuid;
  v_done      boolean;
  activity_id uuid;
begin
  -- SAME LEDGER KEY AS THE TASK PATH. Both reach here through
  -- `entities.commands.complete`, so a replayed mutation id must find the
  -- earlier result whichever kind produced it — one operation, one ledger.
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.commands.complete');
  if replay is not null then return replay; end if;

  -- `live_entity` does the not-found AND the wrong-kind refusal in one, the
  -- same way `set_work_state` pins itself to 'task'.
  e := internal.live_entity(p_entity_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  select ws.status into v_status from public.work_sessions ws where ws.entity_id = p_entity_id;

  -- WHERE IT IS decides where it goes. `e` was read before any write above, so
  -- this is the category the caller was looking at when they clicked.
  v_done := e.status_category is distinct from 'done';

  if v_done then
    -- Straight to the workflow's done state. `to_do -> done` and
    -- `in_progress -> done` are both ruled, and `done -> done` is the axiom, so
    -- ticking an already-done row is a no-op rather than a refusal.
    select internal.workflow_state_for_category(p_entity_id, 'done') into v_target;
  else
    -- The reopen, then the catch-up. See the header.
    select internal.workflow_state_for_category(p_entity_id, 'to_do') into v_reopen;
    if v_reopen is not null then
      update public.entities set status_id = v_reopen
       where id = p_entity_id and status_id is distinct from v_reopen;
    end if;
    select internal.workflow_state_for_session_status(p_entity_id, v_status) into v_target;
  end if;

  if v_target is not null then
    update public.entities set status_id = v_target
     where id = p_entity_id and status_id is distinct from v_target;
  end if;

  -- The envelope moved, so the row is a new version. Explicit for the reason
  -- 155's header gives about `work_session_transition`: nothing bumps
  -- `entities.version` on a status_id write by itself, and a client that pinned
  -- the old version must see a conflict rather than a silent overwrite.
  update public.entities
     set version = version + 1, updated_at = now(), activity_at = now()
   where id = p_entity_id;

  -- `activity.verb` is a CLOSED set (003's `activity_verb_check`, last widened
  -- by 123). 'completed' is a member and is exactly right for the tick.
  -- Un-ticking has no member of its own, so this takes 062's precedent
  -- verbatim — "'restored' is the closest member … the summary carries the
  -- precise action for any consumer that needs to distinguish it" — and uses
  -- 'updated' with `action: 'reopened'` beside it. Widening the constraint for
  -- one verb would be a schema ruling in a file whose subject is a button.
  --
  -- `processEnded: false` is the ruling, recorded on every row this writes:
  -- whatever else changed, the session was not stopped. A future reader
  -- auditing what ended a session can filter these out on the payload rather
  -- than having to know that this door never touches `work_sessions`.
  activity_id := internal.record_activity(
    e.space_id, p_entity_id, actor,
    case when v_done then 'completed' else 'updated' end,
    null,
    jsonb_build_object(
      'kind', 'work_session',
      'action', case when v_done then 'marked_done' else 'reopened' end,
      'sessionStatus', v_status,
      'processEnded', false
    )
  );

  return internal.ledger_record(p_client_mutation_id, 'entities.commands.complete',
           internal.command_result(p_entity_id, null, activity_id));
end
$$;

comment on function public.set_session_done(uuid, integer, uuid, text) is
  'THE TICK (user ruling 2026-08-19). Files a work_session under Done, or takes '
  'it back out, WITHOUT touching work_sessions.status — the process keeps '
  'running. Toggling rather than one-way, guarded by expectedVersion so a '
  'double submit is a version conflict and not a silent flip back.';

-- -----------------------------------------------------------------------------
-- 3. VERIFY
-- -----------------------------------------------------------------------------
do $verify$
declare
  n bigint;
begin
  -- 3.1 THE GUARD CHANGES NOTHING FOR ANY EXISTING ROW. Every session's
  -- category still agrees with its status, because nothing has ticked anything
  -- yet — this is 155's own claim, re-asserted after replacing its trigger.
  select count(*) into n
    from public.entities e
    join public.work_sessions ws on ws.entity_id = e.id
   where e.status_category is distinct from internal.session_status_category(ws.status);
  if n > 0 then
    raise exception '156: % sessions disagree with their status after the guard', n;
  end if;

  -- 3.2 THE CONSTRAINT THIS FILE IS BUILT AROUND IS STILL TRUE. If a later
  -- migration adds `done -> in_progress`, the tick silently stops sticking;
  -- fail loudly HERE rather than let that ship quietly.
  if internal.category_transition_allowed('done', 'in_progress') then
    raise exception
      '156: category_transition_allowed now permits done -> in_progress; the '
      'tick no longer sticks and needs an explicit marked-done column instead';
  end if;
end
$verify$;
