-- =============================================================================
-- 083 — The forge observer stops being a state-fetcher and becomes a WATCHER.
--
-- 081 shipped a queue drainer: something asked for a refresh, the observer
-- fetched the PR, wrote `title/state/head_sha`, and stopped. 082 made the state
-- transition watchable on the ledger. Neither one can answer the question the
-- agent actually has, which is not "what is this PR" but "did something happen
-- to it that I have to do something about".
--
-- That question needs four things this schema does not have:
--
--   A. THE FACTS A DIFF IS COMPUTED AGAINST. "CI went red" is not a property of
--      a check run; it is a relation between the check run I see now and the one
--      I saw last tick. Without stored per-check and per-thread facts there is
--      nothing to subtract from, so every tick either re-reports everything or
--      reports nothing. §C and §D are the subtrahend.
--
--   B. THE PR FIELDS THE LOOPS TURN ON. `mergeable_state` is the conflict fact.
--      `head_ref`/`base_ref` are two things at once: the branch that resolves
--      WHICH SESSION owns this PR (§F), and the edge that makes "stacked on an
--      open parent" a query rather than a guess (§G). None of the three existed.
--
--   C. AN ETAG CACHE (§E). A watcher polls; a poller with no conditional
--      requests spends its whole rate limit re-downloading bytes it already has.
--      A 304 costs nothing against the limit, which is the entire reason the
--      interval can be short enough to be useful.
--
--   D. DURABLE NUDGE DEDUP (§H). The loops post messages into a live agent's
--      session. In-memory dedup is dedup that a deploy erases — the agent gets
--      the same red check re-delivered on every restart, and an inbox that
--      cries wolf is an inbox that gets ignored. The signature is stored, so
--      "I already told you this" survives the process that said it.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO: invent new event types. 082
-- authored `git.pr_state_changed` in a trigger on `pull_requests`, and the
-- observer reaches it the same way any other writer does — by calling
-- `apply_pull_request_facts`. A watcher that emitted its own parallel event
-- stream would give the ledger two vocabularies for one fact.
--
-- ⚠ NO TABLE HERE IS A CLIENT SURFACE. Every one of them is reached only
-- through the security-definer doors below, which run as the owner; that is why
-- there are no table grants. Observation churn is operational truth, not a
-- semantic command, so the fact doors are UNLEDGERED — the same argument 081 §B4
-- makes for its own.
-- =============================================================================

set role tm8_graph_owner;

-- =============================================================================
-- A. The PR columns the loops turn on.
--
-- All three are nullable and all three mean "the provider did not tell me"
-- when NULL — the same unknown-vs-erasure contract 081 §B4 established, which
-- is what lets a 304 leave the row alone instead of blanking it.
-- =============================================================================
alter table public.pull_requests
  add column if not exists head_ref text,
  add column if not exists base_ref text,
  -- GitHub's own vocabulary, verbatim, rather than a boolean. `dirty` is the
  -- conflict; `unknown` is GitHub still computing the merge, which is NOT the
  -- same answer and must not nudge anybody. Collapsing these to
  -- `mergeable boolean` throws away exactly the distinction the loop needs.
  add column if not exists mergeable_state text
    constraint pull_requests_mergeable_state_check
    check (mergeable_state in ('clean','dirty','unknown','blocked','behind','unstable','draft','has_hooks'));

comment on column public.pull_requests.head_ref is
  'Source branch. Also the provenance key: a session working in a worktree on '
  'this branch owns this PR (083 internal.pr_owning_session).';
comment on column public.pull_requests.base_ref is
  'Target branch. A PR whose base_ref is another open PR''s head_ref is '
  'STACKED, which is why its conflicts are suppressed (083 §G).';

-- Stacked detection reads (space, repo, head_ref); so does branch provenance.
create index if not exists pull_requests_space_repo_head_ref_idx
  on public.pull_requests(space_id, repo, head_ref) where head_ref is not null;

-- 081 §B2 / 082 §C1 narrowed version-bumping to columns that carry meaning.
-- head_ref and base_ref carry meaning: the branch a PR is cut from changing is
-- a real fact about it. `mergeable_state` deliberately does NOT join the list —
-- GitHub recomputes it asynchronously and it oscillates through `unknown` on
-- every push, so bumping `entities.version` on it would drift every pinned
-- memory pointing at the PR several times an hour for no semantic reason.
drop trigger if exists pull_requests_w2_snapshot_version on public.pull_requests;
create trigger pull_requests_w2_snapshot_version after update on public.pull_requests
for each row when (
  new.provider is distinct from old.provider or new.url    is distinct from old.url
  or new.repo  is distinct from old.repo     or new.number is distinct from old.number
  or new.title is distinct from old.title    or new.state  is distinct from old.state
  or new.head_sha is distinct from old.head_sha
  or new.ci_status is distinct from old.ci_status
  or new.head_ref is distinct from old.head_ref
  or new.base_ref is distinct from old.base_ref
) execute function internal.snapshot_entity_version();

-- =============================================================================
-- B. apply_pull_request_facts learns the three new fields.
--
-- DROP then CREATE, exactly as 082 §C2 did and for the same reason: the
-- argument list grows, and `create or replace` with more defaulted parameters
-- would leave the old overload in place and make every existing 4- and 5-value
-- call site ambiguous. Recreating means 081's 4-argument call binds the new
-- parameters to their defaults and behaves identically.
-- =============================================================================
drop function if exists public.apply_pull_request_facts(uuid, text, text, text, text);
create or replace function public.apply_pull_request_facts(
  p_entity_id uuid, p_title text default null, p_state text default null,
  p_head_sha text default null, p_ci_status text default null,
  p_head_ref text default null, p_base_ref text default null,
  p_mergeable_state text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare row public.pull_requests;
begin
  perform internal.require_identity();
  select * into row from public.pull_requests where entity_id = p_entity_id for update;
  if not found then
    raise exception 'no pull request %', p_entity_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(row.space_id);
  if p_state is not null and p_state not in ('open','merged','closed','draft') then
    raise exception 'invalid pull request state: %', p_state using errcode = '22023';
  end if;
  if p_ci_status is not null and p_ci_status not in ('passing','failing','pending') then
    raise exception 'invalid ci status: %', p_ci_status using errcode = '22023';
  end if;
  if p_mergeable_state is not null
     and p_mergeable_state not in ('clean','dirty','unknown','blocked','behind','unstable','draft','has_hooks') then
    raise exception 'invalid mergeable state: %', p_mergeable_state using errcode = '22023';
  end if;

  update public.pull_requests
     set title           = coalesce(p_title, title),
         state           = coalesce(p_state, state),
         head_sha        = coalesce(p_head_sha, head_sha),
         ci_status       = coalesce(p_ci_status, ci_status),
         head_ref        = coalesce(p_head_ref, head_ref),
         base_ref        = coalesce(p_base_ref, base_ref),
         mergeable_state = coalesce(p_mergeable_state, mergeable_state),
         fetched_at      = now(),
         updated_at      = now()
   where entity_id = p_entity_id;

  -- The SEMANTIC diff, not "did any byte move". `previousState` and
  -- `previousMergeableState` ride along because the caller decides whether to
  -- nudge on the TRANSITION (clean → dirty nudges; dirty → dirty does not) and
  -- cannot see the old row from outside this function.
  return jsonb_build_object(
    'entityId', p_entity_id,
    'state', coalesce(p_state, row.state),
    'previousState', row.state,
    'mergeableState', coalesce(p_mergeable_state, row.mergeable_state),
    'previousMergeableState', row.mergeable_state,
    'headSha', coalesce(p_head_sha, row.head_sha),
    'previousHeadSha', row.head_sha,
    'changed', (coalesce(p_title, row.title) is distinct from row.title
             or coalesce(p_state, row.state) is distinct from row.state
             or coalesce(p_head_sha, row.head_sha) is distinct from row.head_sha
             or coalesce(p_ci_status, row.ci_status) is distinct from row.ci_status
             or coalesce(p_head_ref, row.head_ref) is distinct from row.head_ref
             or coalesce(p_base_ref, row.base_ref) is distinct from row.base_ref
             or coalesce(p_mergeable_state, row.mergeable_state) is distinct from row.mergeable_state));
end
$$;

revoke all on function public.apply_pull_request_facts(uuid,text,text,text,text,text,text,text) from public;
grant execute on function public.apply_pull_request_facts(uuid,text,text,text,text,text,text,text) to tm8_app;

-- =============================================================================
-- C. Check facts — one row per (pull request, head sha, check name).
--
-- KEYED ON head_sha, not on the PR alone. A check named `build` is red on
-- commit A and green on commit B, and a table keyed only by name would let the
-- push that fixed it silently overwrite the evidence that it was ever broken —
-- which is fine for display and fatal for a diff, because the next tick would
-- then see green-vs-green and conclude nothing happened.
-- =============================================================================
create table if not exists public.pr_check_facts (
  id            uuid primary key default internal.new_id(),
  space_id      uuid not null references public.spaces(id) on delete cascade,
  pr_entity_id  uuid not null references public.pull_requests(entity_id) on delete cascade,
  head_sha      text not null,
  check_name    text not null,
  -- GitHub's check-run id. Also the GitHub Actions JOB id, which is how the CI
  -- loop reaches the log tail without scraping `details_url`.
  external_id   text,
  status        text not null,
  conclusion    text,
  details_url   text,
  started_at    timestamptz,
  completed_at  timestamptz,
  observed_at   timestamptz not null default now(),
  unique (pr_entity_id, head_sha, check_name)
);

-- No CHECK constraint on `status`/`conclusion`: GitHub has added values to both
-- vocabularies since check runs shipped (`waiting`, `requested`, `stale`), and a
-- constraint here would turn the next addition into a failed observer tick —
-- the observer refusing to record a fact because it is unfamiliar. The
-- INTERPRETATION of a conclusion lives in internal.check_conclusion_is_failure,
-- one place, deliberately conservative about what counts as red.
comment on table public.pr_check_facts is
  'Last-observed CI check runs per (pull request, head sha). The subtrahend the '
  '083 watcher computes "went red" against; not a client surface.';

-- =============================================================================
-- D. Review-thread facts — one row per (pull request, thread).
--
-- `thread_key` is the provider's own thread node id. It is text and not uuid
-- because it is GitHub's identifier, and minting a local one would mean the
-- per-thread nudge cap could not survive the row being re-observed.
-- =============================================================================
create table if not exists public.pr_review_thread_facts (
  id            uuid primary key default internal.new_id(),
  space_id      uuid not null references public.spaces(id) on delete cascade,
  pr_entity_id  uuid not null references public.pull_requests(entity_id) on delete cascade,
  thread_key    text not null,
  path          text,
  line          integer,
  is_resolved   boolean not null default false,
  is_outdated   boolean not null default false,
  comment_count integer not null default 0,
  author        text,
  body_excerpt  text,
  observed_at   timestamptz not null default now(),
  unique (pr_entity_id, thread_key)
);

comment on table public.pr_review_thread_facts is
  'Last-observed review threads per pull request, including resolution state. '
  'Not a client surface.';

-- =============================================================================
-- E. The ETag cache.
--
-- Keyed by an opaque `resource_key` the client composes, so one table serves
-- every conditional GET the observer makes without the schema needing to know
-- the shape of GitHub URLs. `not_modified_hits` is not decoration: it is the
-- only way to tell "the cache is working" from "the cache is never consulted",
-- and those look identical in a rate-limit graph.
-- =============================================================================
create table if not exists public.provider_etags (
  space_id          uuid not null references public.spaces(id) on delete cascade,
  resource_key      text not null,
  etag              text not null,
  fetched_at        timestamptz not null default now(),
  not_modified_hits integer not null default 0,
  primary key (space_id, resource_key)
);

-- =============================================================================
-- F. Owning session — "who do I tell?"
--
-- Three provenance routes, in confidence order, and the order is the point:
--
--   1. The PR mirror's own `created_in` edge (066): the session that linked
--      this PR. Directly asserted, so it wins.
--   2. The `created_in` edge on the commit at the PR head (082 §B): the session
--      whose worktree produced the code. One inference step.
--   3. An `in_worktree` edge (081 §A6) to a worktree checked out on the PR's
--      head branch. Two inference steps, and the weakest, because a branch can
--      outlive the session that made it.
--
-- LIVENESS OUTRANKS ALL THREE. A closed-loop nudge delivered to an `exited`
-- session is a message nobody will ever read, so a live weaker candidate beats
-- a dead stronger one — this function answers "who can act", not "who to
-- blame". The caller still gets the status and decides.
-- =============================================================================
create or replace function internal.pr_owning_session(p_pr_entity_id uuid)
returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  with pr as (
    select * from public.pull_requests where entity_id = p_pr_entity_id
  ), candidates as (
    select e.dst_id as session_id, 1 as confidence
      from public.edges e
     where e.src_id = p_pr_entity_id and e.type = 'created_in'
    union all
    select e.dst_id, 2
      from pr
      join public.commits c
        on c.space_id = pr.space_id and c.repo = pr.repo and c.sha = lower(pr.head_sha)
      join public.edges e on e.src_id = c.entity_id and e.type = 'created_in'
     where pr.head_sha is not null
    union all
    select e.src_id, 3
      from pr
      join public.worktrees w on w.branch = pr.head_ref
      join public.edges e on e.dst_id = w.entity_id and e.type = 'in_worktree'
     where pr.head_ref is not null
  )
  select c.session_id
    from candidates c
    join public.entities se
      on se.id = c.session_id and se.kind = 'work_session' and se.deleted_at is null
    join public.work_sessions ws on ws.entity_id = se.id
   order by (ws.status in ('spawning','running','idle')) desc, c.confidence, ws.status_changed_at desc
   limit 1
$$;

-- =============================================================================
-- G. The watcher's work list.
--
-- 006's queue answers "someone asked me to look at these". A watcher needs the
-- complementary read: "what should I be looking at anyway". The predicate is
-- narrow on purpose — an OPEN pull request that some TASK tracks. A PR nobody
-- tracks has no task to close a loop around, and polling it would spend rate
-- limit to produce a nudge with no addressee.
--
-- ⚠ SAME ENTITLEMENT AS THE APPLY DOORS, for the reason 081 §B3 spells out at
-- length: handing back rows the caller could never apply wedges the loop.
--
-- `stackedOnOpenParent` is computed HERE rather than in the observer because it
-- is a join, and shipping it to the client would mean a second round trip per
-- PR to answer a question Postgres already has the rows for.
-- =============================================================================
create or replace function public.observer_watch_targets(
  p_limit integer default 25, p_min_age_seconds integer default 0
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  perform internal.require_identity();

  select coalesce(jsonb_agg(t.payload order by t.ordinal), '[]'::jsonb) into result
    from (
      select
        row_number() over (order by coalesce(pr.fetched_at, 'epoch'::timestamptz), pr.entity_id) as ordinal,
        jsonb_build_object(
          'prEntityId', pr.entity_id,
          'spaceId', pr.space_id,
          'provider', pr.provider,
          'repo', pr.repo,
          'number', pr.number,
          'state', pr.state,
          'headSha', pr.head_sha,
          'headRef', pr.head_ref,
          'baseRef', pr.base_ref,
          'ciStatus', pr.ci_status,
          'mergeableState', pr.mergeable_state,
          'taskId', (select ed.src_id from public.edges ed
                      where ed.dst_id = pr.entity_id and ed.type = 'tracks'
                      order by ed.created_at limit 1),
          'owningSessionId', sess.id,
          'owningSessionStatus', ws.status,
          'owningSessionLive', coalesce(ws.status in ('spawning','running','idle'), false),
          'stackedOnOpenParent', exists (
            select 1 from public.pull_requests parent
             where parent.space_id = pr.space_id
               and parent.repo = pr.repo
               and parent.entity_id <> pr.entity_id
               and parent.head_ref is not null
               and parent.head_ref = pr.base_ref
               and parent.state in ('open','draft'))
        ) as payload
        from public.pull_requests pr
        join public.entities pe on pe.id = pr.entity_id and pe.deleted_at is null
        left join lateral (
          select internal.pr_owning_session(pr.entity_id) as id
        ) sess on true
        left join public.work_sessions ws on ws.entity_id = sess.id
       where pr.state in ('open','draft')
         and internal.is_space_member(pr.space_id)
         and exists (select 1 from public.edges ed
                      where ed.dst_id = pr.entity_id and ed.type = 'tracks')
         -- A floor on how often one PR may be re-polled, so a small watch list
         -- cannot turn a short interval into a hot loop against the provider.
         and (pr.fetched_at is null
              or pr.fetched_at < now() - make_interval(secs => greatest(coalesce(p_min_age_seconds, 0), 0)))
       order by coalesce(pr.fetched_at, 'epoch'::timestamptz), pr.entity_id
       limit greatest(coalesce(p_limit, 25), 1)
    ) t;

  return jsonb_build_object('targets', result);
end
$$;

revoke all on function public.observer_watch_targets(integer,integer) from public;
grant execute on function public.observer_watch_targets(integer,integer) to tm8_app;

-- =============================================================================
-- H. Fact application, with the diff computed where the old rows are.
-- =============================================================================

-- Deliberately conservative. `cancelled` and `timed_out` are red — a job the
-- agent must look at. `neutral`, `skipped` and `stale` are NOT: reporting a
-- skipped optional check as a CI failure trains the agent to ignore the loop,
-- which costs more than the missed signal it buys.
create or replace function internal.check_conclusion_is_failure(p_conclusion text)
returns boolean language sql immutable parallel safe as $$
  select p_conclusion in ('failure','timed_out','cancelled','action_required','startup_failure')
$$;

-- -----------------------------------------------------------------------------
-- H1. apply_pr_check_facts — replace the observed set, return what CHANGED.
--
-- `p_checks` is a jsonb array of {name, status, conclusion, externalId,
-- detailsUrl, startedAt, completedAt}.
--
-- The return is the whole point: `newlyFailing` is the set of checks that are
-- red now and were NOT red the last time this (pr, sha) was observed. A check
-- that has been red for six ticks appears once. `ciStatus` is the rollup, so
-- the caller does not re-derive it and the two answers cannot disagree.
--
-- FIRST OBSERVATION OF AN ALREADY-RED CHECK COUNTS AS NEWLY FAILING. The agent
-- has not been told yet, and "we started watching after it broke" is not a
-- reason to stay quiet; §I's durable signature is what stops that from
-- repeating.
-- -----------------------------------------------------------------------------
create or replace function public.apply_pr_check_facts(
  p_pr_entity_id uuid, p_head_sha text, p_checks jsonb
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  pr public.pull_requests;
  sha text := lower(nullif(btrim(coalesce(p_head_sha, '')), ''));
  payload jsonb := coalesce(p_checks, '[]'::jsonb);
  newly jsonb;
  failing_count integer;
  pending_count integer;
  total_count integer;
  rollup text;
begin
  perform internal.require_identity();
  select * into pr from public.pull_requests where entity_id = p_pr_entity_id for update;
  if not found then
    raise exception 'no pull request %', p_pr_entity_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(pr.space_id);
  if sha is null or sha !~ '^[a-f0-9]{7,64}$' then
    raise exception 'invalid head sha for check facts' using errcode = '22023';
  end if;

  -- ONE statement, because the diff must be read from the snapshot the writes
  -- have not touched yet. Data-modifying CTEs all see the same snapshot and are
  -- all executed whether or not the outer query references them, so `newly`
  -- below is computed against the PREVIOUS observation even though the upsert
  -- sits in the same statement. Splitting this into four statements would let
  -- the insert land before the comparison and report every check as unchanged.
  with incoming as (
    select nullif(btrim(c ->> 'name'), '') as check_name,
           coalesce(nullif(btrim(c ->> 'status'), ''), 'completed') as status,
           nullif(btrim(c ->> 'conclusion'), '') as conclusion,
           nullif(btrim(c ->> 'externalId'), '') as external_id,
           nullif(btrim(c ->> 'detailsUrl'), '') as details_url,
           (c ->> 'startedAt')::timestamptz as started_at,
           (c ->> 'completedAt')::timestamptz as completed_at
      from jsonb_array_elements(payload) c
     where nullif(btrim(c ->> 'name'), '') is not null
  ), diff as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', i.check_name, 'status', i.status, 'conclusion', i.conclusion,
             'externalId', i.external_id, 'detailsUrl', i.details_url)), '[]'::jsonb) as v
      from incoming i
      left join public.pr_check_facts f
        on f.pr_entity_id = p_pr_entity_id and f.head_sha = sha and f.check_name = i.check_name
     where internal.check_conclusion_is_failure(i.conclusion)
       and not coalesce(internal.check_conclusion_is_failure(f.conclusion), false)
  ), purge_moved_head as (
    -- The head moved: checks for a sha this PR no longer points at are not
    -- facts about it any more, and keeping them would make the rollup a lie.
    delete from public.pr_check_facts
     where pr_entity_id = p_pr_entity_id and head_sha <> sha
     returning 1
  ), upserted as (
    insert into public.pr_check_facts(
      space_id, pr_entity_id, head_sha, check_name, external_id, status, conclusion,
      details_url, started_at, completed_at, observed_at)
    select pr.space_id, p_pr_entity_id, sha, i.check_name, i.external_id, i.status,
           i.conclusion, i.details_url, i.started_at, i.completed_at, now()
      from incoming i
    on conflict (pr_entity_id, head_sha, check_name) do update
       set external_id  = excluded.external_id,
           status       = excluded.status,
           conclusion   = excluded.conclusion,
           details_url  = excluded.details_url,
           started_at   = excluded.started_at,
           completed_at = excluded.completed_at,
           observed_at  = excluded.observed_at
    returning 1
  ), purge_withdrawn as (
    -- A check the provider stopped reporting (a workflow removed on this sha).
    -- Disjoint from `upserted` by construction — it deletes only rows whose
    -- name is absent from `incoming` — so no tuple is both updated and deleted.
    delete from public.pr_check_facts f
     where f.pr_entity_id = p_pr_entity_id and f.head_sha = sha
       and not exists (select 1 from incoming i where i.check_name = f.check_name)
     returning 1
  )
  select v into newly from diff;

  select count(*) filter (where internal.check_conclusion_is_failure(conclusion)),
         count(*) filter (where status <> 'completed'),
         count(*)
    into failing_count, pending_count, total_count
    from public.pr_check_facts where pr_entity_id = p_pr_entity_id and head_sha = sha;

  -- NULL, not 'passing', when nothing was reported. Zero checks means "this
  -- repo has no CI on this commit yet", and 082's completion gate refuses on
  -- `failing` while treating NULL as unknown — writing `passing` here would
  -- manufacture a green light out of an absence.
  rollup := case
              when total_count = 0 then null
              when failing_count > 0 then 'failing'
              when pending_count > 0 then 'pending'
              else 'passing'
            end;

  return jsonb_build_object(
    'prEntityId', p_pr_entity_id, 'headSha', sha,
    'newlyFailing', newly,
    'failingCount', failing_count, 'pendingCount', pending_count, 'total', total_count,
    'ciStatus', rollup);
end
$$;

revoke all on function public.apply_pr_check_facts(uuid,text,jsonb) from public;
grant execute on function public.apply_pr_check_facts(uuid,text,jsonb) to tm8_app;

-- -----------------------------------------------------------------------------
-- H2. apply_pr_review_thread_facts — same shape, same reasoning.
--
-- `p_threads` is a jsonb array of {threadKey, path, line, isResolved,
-- isOutdated, commentCount, author, bodyExcerpt}.
--
-- `newlyUnresolved` is a thread that is unresolved now and either was resolved
-- last time or was never seen. A thread that has been open for a week is not
-- news; a thread that was resolved and got REOPENED is.
--
-- OUTDATED THREADS ARE STILL UNRESOLVED. GitHub marks a thread outdated when
-- the line it points at has changed, which is exactly what happens when the
-- agent pushes a fix WITHOUT resolving the conversation — the reviewer is still
-- waiting for a reply. Excluding them would make the loop go quiet at the
-- moment it matters most.
-- -----------------------------------------------------------------------------
create or replace function public.apply_pr_review_thread_facts(
  p_pr_entity_id uuid, p_threads jsonb
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  pr public.pull_requests;
  payload jsonb := coalesce(p_threads, '[]'::jsonb);
  newly jsonb;
  unresolved_count integer;
begin
  perform internal.require_identity();
  select * into pr from public.pull_requests where entity_id = p_pr_entity_id for update;
  if not found then
    raise exception 'no pull request %', p_pr_entity_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(pr.space_id);

  -- One statement, for the reason H1 states: the comparison must read the
  -- previous observation, and the upsert is in the same snapshot.
  with incoming as (
    select nullif(btrim(t ->> 'threadKey'), '') as thread_key,
           nullif(btrim(t ->> 'path'), '') as path,
           nullif(t ->> 'line', '')::integer as line,
           coalesce((t ->> 'isResolved')::boolean, false) as is_resolved,
           coalesce((t ->> 'isOutdated')::boolean, false) as is_outdated,
           coalesce(nullif(t ->> 'commentCount', '')::integer, 0) as comment_count,
           nullif(btrim(t ->> 'author'), '') as author,
           left(coalesce(t ->> 'bodyExcerpt', ''), 2000) as body_excerpt
      from jsonb_array_elements(payload) t
     where nullif(btrim(t ->> 'threadKey'), '') is not null
  ), diff as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'threadKey', i.thread_key, 'path', i.path, 'line', i.line,
             'author', i.author, 'bodyExcerpt', i.body_excerpt,
             'commentCount', i.comment_count, 'isOutdated', i.is_outdated)), '[]'::jsonb) as v
      from incoming i
      left join public.pr_review_thread_facts f
        on f.pr_entity_id = p_pr_entity_id and f.thread_key = i.thread_key
     where i.is_resolved = false
       -- `true` for a thread we have never seen, so first sight of an open
       -- thread is news exactly once.
       and coalesce(f.is_resolved, true) = true
  ), upserted as (
    insert into public.pr_review_thread_facts(
      space_id, pr_entity_id, thread_key, path, line, is_resolved, is_outdated,
      comment_count, author, body_excerpt, observed_at)
    select pr.space_id, p_pr_entity_id, i.thread_key, i.path, i.line, i.is_resolved,
           i.is_outdated, i.comment_count, i.author, i.body_excerpt, now()
      from incoming i
    on conflict (pr_entity_id, thread_key) do update
       set path          = excluded.path,
           line          = excluded.line,
           is_resolved   = excluded.is_resolved,
           is_outdated   = excluded.is_outdated,
           comment_count = excluded.comment_count,
           author        = excluded.author,
           body_excerpt  = excluded.body_excerpt,
           observed_at   = excluded.observed_at
    returning 1
  ), purge_withdrawn as (
    delete from public.pr_review_thread_facts f
     where f.pr_entity_id = p_pr_entity_id
       and not exists (select 1 from incoming i where i.thread_key = f.thread_key)
     returning 1
  )
  select v into newly from diff;

  select count(*) into unresolved_count
    from public.pr_review_thread_facts
   where pr_entity_id = p_pr_entity_id and is_resolved = false;

  return jsonb_build_object(
    'prEntityId', p_pr_entity_id,
    'newlyUnresolved', newly,
    'unresolvedCount', unresolved_count);
end
$$;

revoke all on function public.apply_pr_review_thread_facts(uuid,jsonb) from public;
grant execute on function public.apply_pr_review_thread_facts(uuid,jsonb) to tm8_app;

-- =============================================================================
-- I. The ETag doors.
--
-- Batched lookup, single-row record. The asymmetry is the access pattern: the
-- observer wants every etag for a PR before it makes any request, and writes
-- them back one response at a time.
-- =============================================================================
create or replace function public.provider_etag_lookup(
  p_space_id uuid, p_resource_keys text[]
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  perform internal.require_identity();
  perform internal.require_space_member(p_space_id);
  select coalesce(jsonb_object_agg(resource_key, etag), '{}'::jsonb) into result
    from public.provider_etags
   where space_id = p_space_id and resource_key = any(coalesce(p_resource_keys, '{}'::text[]));
  return result;
end
$$;

-- `p_not_modified` records the 304 WITHOUT touching the stored etag: a 304
-- carries the same validator, and rewriting it would reset `fetched_at` in a
-- way that reads as "we re-downloaded this" in exactly the metric the cache
-- exists to improve.
create or replace function public.provider_etag_record(
  p_space_id uuid, p_resource_key text, p_etag text default null,
  p_not_modified boolean default false
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_identity();
  perform internal.require_space_member(p_space_id);
  if nullif(btrim(coalesce(p_resource_key, '')), '') is null then
    raise exception 'empty etag resource key' using errcode = '22023';
  end if;

  if coalesce(p_not_modified, false) then
    update public.provider_etags
       set not_modified_hits = not_modified_hits + 1
     where space_id = p_space_id and resource_key = p_resource_key;
    return jsonb_build_object('resourceKey', p_resource_key, 'notModified', true);
  end if;

  if nullif(btrim(coalesce(p_etag, '')), '') is null then
    -- The provider answered 200 with no validator. Forget what we had rather
    -- than keep a stale one that would produce a bogus 304 next tick.
    delete from public.provider_etags
     where space_id = p_space_id and resource_key = p_resource_key;
    return jsonb_build_object('resourceKey', p_resource_key, 'stored', false);
  end if;

  insert into public.provider_etags(space_id, resource_key, etag, fetched_at)
  values (p_space_id, p_resource_key, btrim(p_etag), now())
  on conflict (space_id, resource_key) do update
     set etag = excluded.etag, fetched_at = excluded.fetched_at;
  return jsonb_build_object('resourceKey', p_resource_key, 'stored', true);
end
$$;

revoke all on function public.provider_etag_lookup(uuid,text[]) from public;
grant execute on function public.provider_etag_lookup(uuid,text[]) to tm8_app;
revoke all on function public.provider_etag_record(uuid,text,text,boolean) from public;
grant execute on function public.provider_etag_record(uuid,text,text,boolean) to tm8_app;

-- =============================================================================
-- J. Durable nudge dedup.
--
-- The signature is the CONTENT of what would be said — for CI, check name +
-- commit sha + status + a hash of the log tail. Two identical signatures are
-- two identical messages, and the second one is noise. Because the row is in
-- Postgres and not in a Map, a restart does not re-send it.
--
-- `scope_key` is the axis a CAP applies to, and it is separate from the
-- signature because the two loops want different behaviour:
--
--   * CI failures are UNCAPPED per scope and deduped per signature. Ten
--     different red checks are ten things to fix, and swallowing nine because
--     "we already nudged about CI" would hide real work.
--   * Review threads are CAPPED per thread. A reviewer who has not been
--     answered does not need to be re-announced every tick; after the cap the
--     loop goes quiet on that thread and waits for the agent.
-- =============================================================================
create table if not exists public.session_nudge_signatures (
  space_id        uuid not null references public.spaces(id) on delete cascade,
  work_session_id uuid not null references public.entities(id) on delete cascade,
  loop_kind       text not null check (loop_kind in ('ci_failure','merge_conflict','review_thread')),
  scope_key       text not null,
  signature       text not null,
  sent_at         timestamptz not null default now(),
  primary key (space_id, work_session_id, loop_kind, scope_key, signature)
);

comment on table public.session_nudge_signatures is
  'One row per nudge actually delivered. Durable so a server restart does not '
  're-spam a live session with facts it has already been told (083 §J).';

-- CLAIM BEFORE POSTING, and release if the post fails.
--
-- The other order — post, then record — re-sends on any crash between the two,
-- which is the exact failure this table exists to prevent. Claiming first can
-- instead LOSE a nudge if the process dies before the post, and losing one
-- message is a smaller harm than a restart loop that re-delivers every red
-- check in the space. `release_session_nudge` closes the gap for the ordinary
-- case where the post merely errors.
--
-- The advisory lock makes the cap check and the insert one decision: without
-- it, two observer nodes both read count = cap-1 and both post.
create or replace function public.claim_session_nudge(
  p_work_session_id uuid, p_loop_kind text, p_scope_key text, p_signature text,
  p_scope_cap integer default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  session_entity public.entities;
  session_status text;
  scope_count integer;
begin
  perform internal.require_identity();
  select * into session_entity from public.entities
   where id = p_work_session_id and kind = 'work_session' and deleted_at is null;
  if not found then
    raise exception 'no work session %', p_work_session_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(session_entity.space_id);
  if p_loop_kind not in ('ci_failure','merge_conflict','review_thread') then
    raise exception 'invalid nudge loop kind: %', p_loop_kind using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_scope_key, '')), '') is null
     or nullif(btrim(coalesce(p_signature, '')), '') is null then
    raise exception 'nudge scope key and signature are required' using errcode = '22023';
  end if;

  -- Liveness is enforced HERE and not only in the caller, because this is the
  -- door: a nudge to an exited session is a message with no reader, and one
  -- refusal in the schema beats the same check written in every call site.
  select status into session_status from public.work_sessions where entity_id = p_work_session_id;
  if session_status is null or session_status not in ('spawning','running','idle') then
    return jsonb_build_object('claimed', false, 'reason', 'session_not_live',
                              'sessionStatus', session_status);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_work_session_id::text || ':nudge:' || p_loop_kind || ':' || p_scope_key, 0));

  if exists (
    select 1 from public.session_nudge_signatures
     where space_id = session_entity.space_id and work_session_id = p_work_session_id
       and loop_kind = p_loop_kind and scope_key = p_scope_key and signature = p_signature
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'duplicate');
  end if;

  select count(*) into scope_count from public.session_nudge_signatures
   where space_id = session_entity.space_id and work_session_id = p_work_session_id
     and loop_kind = p_loop_kind and scope_key = p_scope_key;

  if p_scope_cap is not null and scope_count >= greatest(p_scope_cap, 0) then
    return jsonb_build_object('claimed', false, 'reason', 'capped', 'scopeCount', scope_count);
  end if;

  insert into public.session_nudge_signatures(
    space_id, work_session_id, loop_kind, scope_key, signature)
  values (session_entity.space_id, p_work_session_id, p_loop_kind, p_scope_key, p_signature);

  return jsonb_build_object('claimed', true, 'scopeCount', scope_count + 1,
                            'spaceId', session_entity.space_id);
end
$$;

create or replace function public.release_session_nudge(
  p_work_session_id uuid, p_loop_kind text, p_scope_key text, p_signature text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare session_entity public.entities;
begin
  perform internal.require_identity();
  select * into session_entity from public.entities where id = p_work_session_id;
  if not found then
    raise exception 'no work session %', p_work_session_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(session_entity.space_id);
  delete from public.session_nudge_signatures
   where space_id = session_entity.space_id and work_session_id = p_work_session_id
     and loop_kind = p_loop_kind and scope_key = p_scope_key and signature = p_signature;
  return jsonb_build_object('released', found);
end
$$;

revoke all on function public.claim_session_nudge(uuid,text,text,text,integer) from public;
grant execute on function public.claim_session_nudge(uuid,text,text,text,integer) to tm8_app;
revoke all on function public.release_session_nudge(uuid,text,text,text) from public;
grant execute on function public.release_session_nudge(uuid,text,text,text) to tm8_app;

reset role;
