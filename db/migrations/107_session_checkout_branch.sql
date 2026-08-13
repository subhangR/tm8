-- 107 — SESSION LANE FACTS: `work_sessions.checkout_branch`.
--
-- (104-106 are deliberately skipped: PR #188's chat stack claimed them while
-- this migration was in flight — coordinator ruling 2026-08-13.)
--
-- A session must always answer "what am I working on, git-wise" — branch,
-- mode, PRs — without requiring a worktree (user ruling 2026-08-13). The mode
-- half already exists (`workdir_mode`, 001/015); the branch half did not:
--
--   * worktree mode — the lane branch, known at provision time (081 §4.4);
--   * project mode — whatever `git branch --show-current` says in the SHARED
--     checkout at spawn. NOT exclusively this session's branch, and the read
--     side says so (the 'shared' badge is the honesty);
--   * scratch with no repo — NULL, and NULL renders NO claim.
--
-- NULLABLE, NEVER DEFAULTED. A NULL means "no branch fact was captured" —
-- a scratch session, a detached HEAD, a pre-107 row, or a git read that
-- failed. Inventing a value for any of those would turn absence into a claim,
-- which is exactly the failure the lane line's honesty rules forbid.
--
-- WHY A COLUMN AND NOT A JOIN THROUGH `in_worktree`: the worktree edge covers
-- one of the three modes. The branch of a shared project checkout lives in no
-- entity, and making it one would mint a graph node for a fact that a `git
-- checkout` in a terminal tm8 does not own can silently invalidate. A fact
-- column that is refreshed opportunistically states exactly what was measured
-- and when it was measured, nothing more.
--
-- This is also the OBSERVER'S ASSOCIATION KEY: a pull request whose
-- `pull_requests.head_ref` (103 §A) equals a session's `checkout_branch`
-- associates with that session mechanically, at LOWER confidence than
-- `created_in`/`in_worktree`. `internal.pr_owning_session` (103 §F) is
-- deliberately UNTOUCHED — the nudge addressee keeps its measured confidence
-- order; the client-side linked-PR index is where the low-confidence match
-- surfaces.

alter table public.work_sessions add column if not exists checkout_branch text;

comment on column public.work_sessions.checkout_branch is
  'The git branch of the checkout this session works in, captured at spawn '
  'and refreshed opportunistically. Worktree mode: the lane branch. Project '
  'mode: the SHARED checkout''s current branch — not exclusively this '
  'session''s. NULL: no repo, detached HEAD, or never captured — and NULL '
  'must render as no claim, never as a default. Projected additively into '
  'the work_session summary state (contract checkoutBranch).';

-- --- capture -----------------------------------------------------------------
--
-- Mirrors execution_record_native_session (062) in shape, but deliberately
-- NOT write-once: a branch is a fact that legitimately changes (a shared
-- checkout switches branches; a lane branch is renamed), and refusing the
-- second write would freeze the first measurement as eternal truth.
--
-- The entities.version bump is conditional on the value actually CHANGING,
-- because this fact rides in the summary state and clients learn of summary
-- changes by version. `activity_at` is deliberately NOT touched: a passive
-- fact refresh is not activity, and bumping it would reorder session lists
-- every time a poll re-measures the same checkout.

create or replace function public.execution_record_checkout_branch(
  p_session_id uuid, p_branch text, p_actor_id uuid default null
) returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  next_branch text;
  changed boolean;
begin
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);

  -- Empty and whitespace-only collapse to NULL: `git branch --show-current`
  -- prints an empty line on a detached HEAD, and an empty-string "branch"
  -- stored verbatim would render a lane line claiming a branch named nothing.
  next_branch := nullif(btrim(coalesce(p_branch, '')), '');

  select ws.checkout_branch is distinct from next_branch into changed
    from public.work_sessions ws where ws.entity_id = p_session_id for update;
  if not found then
    raise exception 'no work session %', p_session_id using errcode = 'P0002';
  end if;
  if not changed then
    return false;
  end if;

  update public.work_sessions
     set checkout_branch = next_branch
   where entity_id = p_session_id;

  update public.entities
     set version = version + 1, updated_at = now()
   where id = p_session_id;
  return true;
end
$$;

revoke all on function public.execution_record_checkout_branch(uuid, text, uuid) from public;
grant execute on function public.execution_record_checkout_branch(uuid, text, uuid) to tm8_app;
