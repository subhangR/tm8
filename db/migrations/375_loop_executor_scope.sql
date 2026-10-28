-- =============================================================================
-- 375 · THE LOOP EXECUTOR CAN SEE LOOPS OUTSIDE THE NODE OWNER'S SPACES
--       (task 01a17937-4b06, measured on prod 26 Oct 2026).
--
-- THE BUG, measured. The seeded `Dreamer daily sweep` in space 01a0fb3d was
-- enabled, due 2026-10-03, and 23 days later had `last_run_at` NULL,
-- `last_error` NULL and zero `triggered_by` edges. The executor was registered
-- and ticking on the R26 runner the whole time.
--
-- `createLoopExecutorPort.claimsFor` returned the node's LOOPBACK OWNER and
-- ignored the `spaceId` it was handed. The due read was a direct select on
-- `public.loops join public.entities`, so `entities_select` applied:
-- `space_id = any(internal.member_space_ids())`. `member_space_ids()` has no
-- node-admin bypass (232:107), and 306 added a background-job bypass to the
-- TRACKING doors only — explicitly "No general entity read changes".
--
-- The node owner belongs to the spaces it created and nothing else. A space a
-- human created is not one of them, so the loop seeded into it was INVISIBLE:
-- the due read returned zero rows and the job answered `{skipped: 'no loops
-- are due'}`. It never reached `recordRun`, the only writer of `last_error`,
-- which is why 23 days of not firing left no trace for anyone to find. Same
-- root cause 306 measured for the tracking jobs, in a lane 306 did not cover.
--
-- THE FIX, and why it is shaped this way.
--
-- The whole firing path needs authority in the loop's space, not just the read:
-- `update_loop` and `derive_task_for_entity` call `require_space_member`, and
-- `resolve_actor` needs a member row to name an actor at all. Widening every
-- one of those doors for a background claim would hand a scheduled job spawn
-- authority in every space on the node — a far larger grant than 306 made, and
-- not one this migration takes.
--
-- Instead the executor is given what `LoopExecutorPort.claimsFor(spaceId)`
-- always said it would use: claims for THE LOOP'S OWN SPACE. §2 resolves, per
-- loop, an identity that is genuinely a member there. Every existing door then
-- works unchanged, under an actor that honestly names who the firing acts for.
-- NO RLS POLICY CHANGES HERE, and no write door is widened.
--
-- WHOSE AUTHORITY, and why this question was already answered. 343 added
-- `loops.armed_by_member_id` / `armed_by_identity_id` — "the human who last
-- authorised what this schedule does", re-stamped when a human changes the
-- loop's CONTENT and nulled when a non-human does — and made it the provenance
-- root of every firing. Its own comment says that human is "who the firings act
-- for". So this migration does not invent an authority: it makes the claims
-- match the provenance root 343 already established. The F2 hole 343 closed
-- (Bob rewriting a loop Alice armed) stays closed, because a content edit by
-- Bob re-stamps `armed_by` to Bob and this read follows the stamp.
--
-- THE ONE NEW GRANT is narrow and read-only: `loops_due_for_executor` crosses
-- space boundaries to answer "which loops are due, and whose authority does
-- each run under". It is gated on `internal.is_loops_worker()` — a claim only
-- the in-process scheduler binds (db/types.ts' closed list), never a request,
-- and never a space-pinned session. It returns loop scheduling columns and one
-- identity string; it writes nothing and reads no other entity.
--
-- A loop with no active member to act as is returned with `act_as_identity`
-- NULL. Such a loop cannot be fired, and cannot be RECORDED against either —
-- `update_loop` needs a member row like every other door — so the executor logs
-- it at warn level and counts it in the tick's outcome. That is the honest
-- degraded mode: the one thing it must not do is skip in silence, which is the
-- failure this migration exists to end.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. Who the loop executor is.
--
--     Mirrors `internal.is_tracking_worker()` (306 §1) exactly, including the
--     session-pin refusal: a space-pinned session never binds the claim, and a
--     node admin over HTTP is deliberately NOT a loop worker. `nodeAdmin` is
--     not the key, because the point is to admit ONE in-process job rather than
--     a class of caller.
-- -----------------------------------------------------------------------------
create or replace function internal.is_loops_worker()
returns boolean
language sql stable
set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null
     and coalesce(internal.claim_text('tm8.background_job') = 'loops.execute-due', false)
     and nullif(current_setting('tm8.session_space_id', true), '') is null
$$;

comment on function internal.is_loops_worker() is
  '375: true only inside a transaction the in-process loop executor opened. The '
  'claim is bound by db/client.ts from a closed list and never from a request; a '
  'node admin over HTTP is not a loop worker.';

-- -----------------------------------------------------------------------------
-- §2. The due-loop read, and the authority each firing runs under.
--
--     This REPLACES the executor's direct select. It is the only place that
--     crosses space boundaries, and all it hands back is scheduling state plus
--     the identity to act as.
--
--     `act_as_identity`, in order:
--       1. the human `armed_by_identity_id` names (343), while their membership
--          of the loop's space is still active. This is the provenance root of
--          the firing, so the claims and the provenance now agree.
--       2. otherwise the space's OWNER, so a loop outlives the member who armed
--          it instead of silently dying when they leave — and so a loop armed
--          by a non-human path (`armed_by` null by design) still runs.
--       3. otherwise NULL: nothing can be done with this loop, and the executor
--          says so rather than skipping.
--     Both branches require `status = 'active'`, so a tombstoned member (232)
--     is never acted as.
--
--     The predicates are the executor's own, kept here rather than in the caller
--     so the partial index `loops_due_idx` (091:68) still serves them.
-- -----------------------------------------------------------------------------
create or replace function public.loops_due_for_executor(p_limit integer default 25)
returns table (
  entity_id        uuid,
  space_id         uuid,
  title            text,
  schedule         text,
  team_member_id   uuid,
  subject_id       uuid,
  prompt           text,
  config           jsonb,
  version          integer,
  act_as_identity  text
)
language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select l.entity_id,
         e.space_id,
         l.title,
         l.schedule,
         l.team_member_id,
         l.subject_id,
         l.prompt,
         l.config,
         e.version,
         coalesce(
           -- 1. the human who armed the schedule (343), still an active member.
           (select m.identity_id
              from public.members m
             where m.identity_id = l.armed_by_identity_id
               and m.space_id = e.space_id
               and m.status = 'active'),
           -- 2. else the space owner, so the loop outlives whoever armed it.
           (select m.identity_id
              from public.members m
             where m.space_id = e.space_id
               and m.role = 'owner'
               and m.status = 'active'
             order by m.entity_id
             limit 1)
         ) act_as_identity
    from public.loops l
    join public.entities e on e.id = l.entity_id
   where internal.is_loops_worker()
     and l.enabled
     and e.deleted_at is null
     and l.next_run_at is not null
     and l.next_run_at <= now()
   order by l.next_run_at
   limit greatest(coalesce(p_limit, 25), 0)
$$;

comment on function public.loops_due_for_executor(integer) is
  '375: due loops across every space, for the in-process loop executor only '
  '(internal.is_loops_worker). Read-only. `act_as_identity` is the human who '
  'armed the loop (343), else the space owner, else NULL when the space has no '
  'active member left to act as.';

revoke all on function public.loops_due_for_executor(integer) from public;
grant execute on function public.loops_due_for_executor(integer) to tm8_app;

reset role;
