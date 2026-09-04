-- 175 — un-starting is a legal move, and resume is the proof.
--
-- 174 files an interrupted session as `in_progress`, because work the server
-- killed has not finished. That is right, and it immediately broke resume.
--
-- `session_resume` moves a failed session back to `spawning`, which 155 maps to
-- `to_do`. While an interrupted session sat in `done` that was `done -> to_do`,
-- which 149 names THE REOPEN and allows. From `in_progress` it is
-- `in_progress -> to_do`, which the matrix does not have an arm for — so every
-- resume of an interrupted session raised 23514 and the operator could not get
-- their work back. Observed immediately after 172: six sessions unresumable.
--
-- 155 warned about precisely this shape, from the other side: "the transition
-- algebra is not a detail this mapping gets to disagree with". 172 disagreed
-- with it. The answer is not to un-say what 172 says about the work — the work
-- genuinely is unfinished — but to give the algebra the arm it is missing.
--
-- WHY THE ARM IS RIGHT, not merely convenient. The matrix already allows
-- `done -> to_do` (reopen) and `cancelled -> to_do` (revive): both say that work
-- believed over can be picked up again. `in_progress -> to_do` says something
-- weaker — that work believed STARTED can be put back to not-started. A session
-- whose process was killed is exactly that: it was running, it no longer is, and
-- nothing about it has finished. Refusing the weaker move while allowing the two
-- stronger ones is the gap, not the guard.
--
-- It is also what a human does to a task by hand: drag it out of In Progress
-- when it turns out nobody has started. The matrix forbade that too.
--
-- WHAT STAYS FORBIDDEN. Everything else the `else false` arm covers, including
-- `done -> in_progress`. Reopening still goes through To Do, so the one path
-- into In Progress remains "someone started it", and Done is still only reached
-- from to_do or in_progress.

create or replace function internal.category_transition_allowed(from_category text, to_category text)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select case
    -- The axiom: refinement inside a category is free.
    when from_category = to_category                              then true
    -- any -> cancelled (ruled).
    when to_category = 'cancelled'                                then true
    when from_category = 'to_do'       and to_category = 'in_progress' then true
    when from_category = 'in_progress' and to_category = 'done'        then true
    -- done comes from to_do or in_progress (ruled).
    when from_category = 'to_do'       and to_category = 'done'        then true
    -- reopen.
    when from_category = 'done'        and to_category = 'to_do'       then true
    -- revive.
    when from_category = 'cancelled'   and to_category = 'to_do'       then true
    -- un-start (173). Work believed started, put back to not-started. This is
    -- the arm `session_resume` needs once 172 files an interrupted session as
    -- in_progress: resume routes through `spawning`, which is `to_do`.
    when from_category = 'in_progress' and to_category = 'to_do'       then true
    else false
  end
$$;

comment on function internal.category_transition_allowed(text, text) is
  'The category transition matrix. 173 added in_progress -> to_do ("un-start"): '
  'resume moves a session through spawning/to_do, and 172 files an interrupted '
  'session as in_progress, so without this arm no interrupted session could be '
  'resumed. done -> in_progress remains forbidden: reopening still goes through '
  'To Do.';
