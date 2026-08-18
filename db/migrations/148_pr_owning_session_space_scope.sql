-- =============================================================================
-- 148  SPACE-SCOPE THE PR OWNERSHIP FALLBACK.
--
-- RENUMBERED FROM 147, and unlike 146 the position is NOT load-bearing — this
-- file only rewrites two function bodies and depends on nothing between 103 and
-- here. It moved because `147_entity_status_category.sql` (#353) landed on main
-- while this was being written, and a duplicate prefix aborts the chain outright
-- (`migrationFiles()` guards on it). Nothing here was applied anywhere under the
-- old number, so the rename is free.
--
-- `internal.pr_owning_session` (103 §F) answers "which work session owns this
-- pull request", and every caller of it is `security definer` running as the
-- graph owner: `public.observer_watch_targets` (103:436), `claim_pending_nudges`
-- (103:1038), `post_session_nudge` (103:1119). RLS is not in the path. Whatever
-- this function returns IS the addressee, unchecked.
--
-- Its third and last candidate tier matched a session BY BRANCH NAME with no
-- Space predicate at all:
--
--     select e.src_id, 3
--       from pr
--       join public.worktrees w on w.branch = pr.head_ref     -- <- any Space
--       join public.edges e on e.dst_id = w.entity_id and e.type = 'in_worktree'
--
-- Tier 2 directly above it is scoped (`c.space_id = pr.space_id`); tier 3 was
-- not. Three facts turn that from a wrong answer into a disclosure:
--
--   1. Bypassed RLS, as above.
--   2. The ORDER BY is `liveness desc, confidence` (103:378) — LIVENESS
--      OUTRANKS CONFIDENCE. So a LIVE tier-3 branch-name match in an unrelated
--      Space beats a DEAD tier-1 `created_in` match that is actually correct.
--      The wrong answer is not a tail case; it is the preferred one whenever
--      the correct session has exited.
--   3. The payload is attacker-influenceable text. `post_session_nudge`
--      (103:1161-1163) posts CI log tails and review-thread comment bodies
--      into the addressed session's transcript.
--
-- And the collision is reachable, not theoretical: `worktrees` is
-- `unique (project_id, branch)` (057:82), which permits the same branch name in
-- as many projects and Spaces as you like, and tm8's own lane branches are
-- `tm8/<8 hex of a ULID>` — a per-node time bucket, not a global identity.
--
-- ── WHY NO `space_id` COLUMN ON `public.worktrees` ──────────────────────────
--
-- An earlier plan proposed denormalising `space_id` onto `public.worktrees` and
-- backfilling it. That is the wrong shape twice over. The backfill is genuinely
-- ambiguous — a project may be linked to several Spaces via
-- `public.space_projects` — and the column would be a second source of truth for
-- something the envelope already knows. A worktree reaches its Space in ONE JOIN
-- through `public.entities`, and the codebase already spells that join out in
-- three places (057:334-335, 081:220-222, 081:259-262). This file uses it.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
--
--  A. `internal.repo_slug_from_url` — the SQL twin of the server's
--     `repoFromUrl` (packages/server/src/tracking/git-local.ts:114), so tier 3
--     can ask whether a worktree's project is even the PR's repository.
--
--  B. `internal.pr_owning_session` — whole-body replace. 103:348 is the current
--     head; 107 explicitly leaves the function alone (107:31-34). Three
--     predicates added, nothing else touched. The ORDER BY is DELIBERATELY
--     UNCHANGED: splitting this function into a provenance read
--     (confidence-ordered) and a routing read (liveness-ordered) is the right
--     long-term shape, but it is a behaviour change and belongs in its own file.
--     Correctness of the candidate SET is separable from the ranking, and this
--     file only fixes the set.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. repo_slug_from_url — "owner/name" out of a git remote, or NULL.
--
-- Deliberately the same answer as the server's `repoFromUrl`, because the two
-- are compared against the same column (`public.commits.repo`,
-- `public.pull_requests.repo`) and a disagreement between them is a silent
-- never-matches, which is exactly the class of bug 2d below is about.
--
-- Written as split-and-take-the-last-two rather than as a transliteration of
-- the TypeScript regex on purpose: Postgres AREs change the greediness of the
-- WHOLE expression when any quantifier is non-greedy, so the literal port of
-- `[:/]([^/:]+\/[^/:]+?)(?:\.git)?\/?$` does not mean in PG what it means in JS.
--
--   https://github.com/acme/forge.git  -> acme/forge
--   https://github.com/acme/forge/     -> acme/forge
--   git@github.com:acme/forge.git      -> acme/forge
--   /srv/bare/forge.git                -> bare/forge   (same as repoFromUrl)
--   forge                              -> NULL
--   NULL, ''                           -> NULL
--
-- IMMUTABLE: pure string arithmetic, no catalogue lookups, no locale-sensitive
-- collation — so it may sit in a predicate without pinning the planner.
-- -----------------------------------------------------------------------------
create or replace function internal.repo_slug_from_url(p_url text)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $$
  with cleaned as (
    select regexp_replace(
             regexp_replace(btrim(coalesce(p_url, '')), '/+$', ''),
             '\.git$', '') as u
  ), parts as (
    -- `:` is a separator too, so the scp-style `git@host:owner/name` form and
    -- the URL form collapse to the same shape before the split.
    select string_to_array(replace(u, ':', '/'), '/') as a from cleaned
  )
  select case
           when array_length(a, 1) >= 2
            and a[array_length(a, 1)]     <> ''
            and a[array_length(a, 1) - 1] <> ''
           then a[array_length(a, 1) - 1] || '/' || a[array_length(a, 1)]
         end
    from parts
$$;

-- 001:1227 revokes PUBLIC execute across `internal` wholesale, but that ran long
-- before this file: a function created now defaults back to PUBLIC. Match the
-- schema's stated posture explicitly. tm8_app needs it because
-- `pr_owning_session` is STABLE, not SECURITY DEFINER — the nested call runs as
-- whoever called the outer function.
revoke all on function internal.repo_slug_from_url(text) from public;
grant execute on function internal.repo_slug_from_url(text) to tm8_app;

comment on function internal.repo_slug_from_url(text) is
  'owner/name from a git remote url, or NULL when the url is absent or has no '
  'two-segment tail. The SQL twin of the server''s repoFromUrl (git-local.ts) — '
  'the two are compared against the same commits.repo / pull_requests.repo '
  'values, so they must agree.';

-- -----------------------------------------------------------------------------
-- B. pr_owning_session — the same three tiers, correctly scoped.
--
-- Diff against 103:348-380, and nothing else:
--
--   1. `candidates` now carries `space_id` (taken from the `pr` CTE, which is
--      exactly one row — `pull_requests.entity_id` is the primary key — so
--      joining `pr` into tier 1 cannot fan it out). The outer select then
--      requires `se.space_id = c.space_id`. This is the CHOKE POINT: every
--      tier, present and future, passes through it. Tiers 1 and 2 already could
--      not cross a Space boundary (an edge and its endpoints share a Space;
--      tier 2 scopes the commit), so this predicate is a no-op for them by
--      construction and a hard stop for anything new that forgets.
--
--   2. Tier 3 joins the worktree's ENVELOPE and scopes it:
--        join public.entities we on we.id = w.entity_id
--                               and we.space_id = pr.space_id
--      plus `we.deleted_at is null` — a soft-deleted worktree is not evidence
--      of anything, and 103's tier 3 was happy to match one.
--
--   3. Tier 3 also asks whether the worktree's PROJECT is the PR's repository.
--      Same Space is necessary but not sufficient: two unrelated projects in one
--      Space with the same branch name is still the wrong session, just a less
--      dangerous wrong session. The predicate is NULL-TOLERANT ON PURPOSE —
--
--        internal.repo_slug_from_url(wp.repo_url) is null
--          or lower(...) = lower(pr.repo)
--
--      — because a project with no remote url cannot be shown to be a different
--      repository, and turning "unknown" into "excluded" would delete working
--      tier-3 behaviour for every local-only project. Unknown falls back to the
--      Space predicate, which is the guarantee this file is actually here for.
--      `lower()` on both sides because GitHub owner/name is case-insensitive
--      while the column is not.
--
-- Unchanged: the tiers themselves, the `is_agent_session` filter (F0), the
-- ORDER BY, the LIMIT 1, the signature, the volatility, the search_path.
-- -----------------------------------------------------------------------------
create or replace function internal.pr_owning_session(p_pr_entity_id uuid)
returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  with pr as (
    select * from public.pull_requests where entity_id = p_pr_entity_id
  ), candidates as (
    select e.dst_id as session_id, 1 as confidence, pr.space_id
      from pr
      join public.edges e
        on e.src_id = p_pr_entity_id and e.type = 'created_in'
    union all
    select e.dst_id, 2, pr.space_id
      from pr
      join public.commits c
        on c.space_id = pr.space_id and c.repo = pr.repo and c.sha = lower(pr.head_sha)
      join public.edges e on e.src_id = c.entity_id and e.type = 'created_in'
     where pr.head_sha is not null
    union all
    -- D2: the branch-name fallback, now inside the PR's Space and its repo.
    select e.src_id, 3, pr.space_id
      from pr
      join public.worktrees w on w.branch = pr.head_ref
      join public.entities we
        on we.id = w.entity_id
       and we.space_id = pr.space_id
       and we.deleted_at is null
      join public.projects wp on wp.id = w.project_id
      join public.edges e on e.dst_id = w.entity_id and e.type = 'in_worktree'
     where pr.head_ref is not null
       and (internal.repo_slug_from_url(wp.repo_url) is null
            or lower(internal.repo_slug_from_url(wp.repo_url)) = lower(pr.repo))
  )
  select c.session_id
    from candidates c
    join public.entities se
      on se.id = c.session_id and se.kind = 'work_session' and se.deleted_at is null
     and se.space_id = c.space_id
    join public.work_sessions ws on ws.entity_id = se.id
    -- F0: a credential login terminal is not an addressee. Filtered rather than
    -- de-ranked — there is no circumstance in which nudging one is right.
   where internal.is_agent_session(se.id)
   order by (ws.status in ('spawning','running','idle')) desc, c.confidence, ws.status_changed_at desc
   limit 1
$$;

comment on function internal.pr_owning_session(uuid) is
  'The work session that owns a pull request, best of three tiers: a created_in '
  'edge (1), the head commit''s session (2), the head branch''s worktree (3). '
  'EVERY candidate must live in the PR''s Space — 148 added that predicate after '
  'tier 3 matched on branch name alone, and every caller is security definer.';
