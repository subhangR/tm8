-- =============================================================================
-- 103 — The forge observer stops being a state-fetcher and becomes a WATCHER.
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
-- ORDER-INDEPENDENCE WAS CHECKED, and this is a decision rather than an
-- accident. 103 gap-fills BELOW ordinals that deployed nodes have already
-- applied (085 rename_work_session, 086 manifest_guard_token_boundary), so on
-- those nodes it runs out of numeric order. That is safe here because 103
-- shares no table, function or trigger with either: 085 touches only
-- work_sessions.title, 086 only the manifest guard token surface. The one real
-- coupling in this file is to 083 (credential sessions), which every node has
-- applied before this can run, and it is handled explicitly in §F0.
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
  'this branch owns this PR (103 internal.pr_owning_session).';
comment on column public.pull_requests.base_ref is
  'Target branch. A PR whose base_ref is another open PR''s head_ref is '
  'STACKED, which is why its conflicts are suppressed (103 §G).';

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

  -- §K: a clean/unknown -> dirty transition is enqueued here for the same
  -- reason H1 enqueues a red check — it is detected by comparing against the
  -- row we are overwriting, so it exists exactly once unless it is made
  -- durable. `row` still holds the PRE-update values.
  if coalesce(p_mergeable_state, row.mergeable_state) = 'dirty'
     and row.mergeable_state is distinct from 'dirty' then
    insert into public.pending_session_nudges(
      space_id, pr_entity_id, loop_kind, scope_key, head_sha, payload)
    values (row.space_id, p_entity_id, 'merge_conflict',
            'conflict@' || coalesce(lower(coalesce(p_head_sha, row.head_sha)), 'unknown'),
            lower(coalesce(p_head_sha, row.head_sha)),
            jsonb_build_object('baseRef', coalesce(p_base_ref, row.base_ref),
                               'headRef', coalesce(p_head_ref, row.head_ref)))
    on conflict (pr_entity_id, loop_kind, scope_key, coalesce(head_sha, ''))
    where status = 'pending' do nothing;
  end if;

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
  '103 watcher computes "went red" against; not a client surface.';

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
--
-- AND SO DOES BEING AN AGENT AT ALL — see F0.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- F0. "Is this work session something that can ACT on a nudge?"
--
-- 083 (credential sessions) made `work_sessions` hold two different animals: a
-- real agent, and an interactive vendor-login TERMINAL a human types into. Its
-- header states the obligation directly — "anything that assumed a work_sessions
-- row is an agent must narrow on this" — and this lane is squarely that: a
-- credential terminal has no agent reading its anchor, so every nudge routed to
-- one is durable spam that closes no loop.
--
-- ⚠ CREATED CONDITIONALLY, and that is not defensive tidiness. This lane's
-- branch is based at 38acf120, which PREDATES 083, so `work_sessions` has no
-- `session_kind` column on this tree and a direct reference would fail to
-- create the function at all (`language sql` bodies are parsed at creation).
-- Selecting the body against the schema actually present lets one file verify
-- green both here and on the rebased tree, and every CALL SITE reads the same
-- either way — which is the property that matters, because the call sites are
-- what a future reader has to trust.
--
-- On the rebased tree this narrows to `session_kind = 'agent'`. On a tree
-- without the column every work session is an agent, which is exactly what was
-- true before 083 existed.
-- -----------------------------------------------------------------------------
do $narrowing$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'work_sessions'
       and column_name = 'session_kind'
  ) then
    execute $body$
      create or replace function internal.is_agent_session(p_session_id uuid)
      returns boolean language sql stable set search_path = public, internal, pg_temp as
      $sql$
        select coalesce(
          (select ws.session_kind from public.work_sessions ws where ws.entity_id = p_session_id),
          'none') = 'agent'
      $sql$;
    $body$;
  else
    execute $body$
      create or replace function internal.is_agent_session(p_session_id uuid)
      returns boolean language sql stable set search_path = public, internal, pg_temp as
      $sql$
        select exists (select 1 from public.work_sessions ws where ws.entity_id = p_session_id)
      $sql$;
    $body$;
  end if;
end
$narrowing$;

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
    -- F0: a credential login terminal is not an addressee. Filtered rather than
    -- de-ranked — there is no circumstance in which nudging one is right.
   where internal.is_agent_session(se.id)
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
--
-- ⚠ THE TRANSITION IS ENQUEUED (§K), NOT JUST RETURNED — and the correction
-- that forced it is worth writing down, because the first version of this
-- header argued the opposite and was wrong.
--
-- The original reasoning: the only way to lose a transition is a crash between
-- this commit and the nudge post, which is microseconds wide and self-healing,
-- so an outbox is not worth its own failure modes. The integrator's live rig
-- then reproduced a loss in the wild, and it was not that shape at all: a check
-- went red while the PR had NO LIVE OWNING SESSION, the caller suppressed the
-- nudge for having no addressee, and the fact was already stored — so when a
-- session did come back, the next observation compared red against red and
-- correctly reported nothing. The transition was consumed by being observed.
--
-- That does NOT self-heal, and that is the whole point: nothing about the check
-- changes when the addressee appears. The original argument only held for
-- failures that some LATER event re-announces; a suppression is not one.
--
-- So the transition is now durable the moment it is detected, in the SAME
-- statement that stores the facts, and it stays pending until it is either
-- delivered or explicitly retired (§K). `newlyFailing` is still returned, for a
-- caller that wants to act within the tick; the queue is what makes the answer
-- survive not acting on it.
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

  -- §K: the transition becomes DURABLE here, in the same transaction as the
  -- facts it was derived from. Without this the answer above is single-use, and
  -- a caller that suppresses it (no live addressee) consumes it forever.
  insert into public.pending_session_nudges(
    space_id, pr_entity_id, loop_kind, scope_key, head_sha, payload)
  select pr.space_id, p_pr_entity_id, 'ci_failure', (c ->> 'name') || '@' || sha, sha, c
    from jsonb_array_elements(newly) c
  on conflict (pr_entity_id, loop_kind, scope_key, coalesce(head_sha, ''))
    where status = 'pending' do nothing;

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

  -- §K, same reasoning as H1. `head_sha` is NULL: a conversation is not tied to
  -- a commit, so a push does not make an unanswered reviewer stale.
  insert into public.pending_session_nudges(
    space_id, pr_entity_id, loop_kind, scope_key, head_sha, payload)
  select pr.space_id, p_pr_entity_id, 'review_thread', t ->> 'threadKey', null, t
    from jsonb_array_elements(newly) t
  on conflict (pr_entity_id, loop_kind, scope_key, coalesce(head_sha, ''))
    where status = 'pending' do nothing;

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
-- J. Durable nudge dedup — "has this exact text already been sent here".
--
-- Distinct from §K's outbox, and the pair is the whole delivery story: §K
-- answers "is there a transition nobody has been told about", this answers "has
-- this particular sentence already been said to this session". A transition can
-- outlive many failed delivery attempts; a delivered sentence must never repeat.
--
-- There is no claim/release pair here any more. The first version of this lane
-- had one, because posting happened OUTSIDE the claim and the gap needed
-- papering over. §K4 posts inside the same transaction as the signature insert,
-- so a failed send rolls the claim back by itself — the release door existed
-- only to compensate for an ordering that no longer exists.
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
  're-spam a live session with facts it has already been told (103 §J).';

-- =============================================================================
-- K. THE OUTBOX — a detected transition survives having nobody to tell.
--
-- WHY THIS EXISTS, precisely. §H1 detects "this check just went red" by
-- comparing against the previous observation and then STORING the new one. That
-- makes the detection single-use: whoever holds the return value is the only
-- one who will ever see it, because the next call compares red against red.
--
-- Which is fine exactly as long as the caller always acts. It does not, and the
-- integrator's live rig proved it: a check went red while the pull request had
-- no live owning session, the caller suppressed the nudge for having no
-- addressee, and the fact was already stored. When a session came back, nothing
-- re-announced it. The transition was consumed by being observed.
--
-- So detection now WRITES A ROW, in the same statement as the facts it was
-- derived from, and that row stays `pending` until something either delivers it
-- or retires it for a stated reason. The queue is small and self-limiting: one
-- row per (pull request, loop, scope, head sha), retired the moment the head
-- moves past it.
--
-- IDENTITY IS THE TRANSITION, NOT THE MESSAGE. The delivered-content signature
-- (§J) includes a hash of the CI log tail, which does not exist until the log
-- has been fetched — long after detection. So the outbox keys on what IS known
-- at detection time, and §J still guards the eventual send. Two tables, two
-- questions: "is there an untold transition" and "has this exact text been sent
-- to this session before".
-- =============================================================================
create table if not exists public.pending_session_nudges (
  id             uuid primary key default internal.new_id(),
  space_id       uuid not null references public.spaces(id) on delete cascade,
  pr_entity_id   uuid not null references public.pull_requests(entity_id) on delete cascade,
  loop_kind      text not null check (loop_kind in ('ci_failure','merge_conflict','review_thread')),
  scope_key      text not null,
  -- NULL for review threads, which are not tied to a commit. Present for CI and
  -- conflicts, and it is what makes "the head moved, this is stale" decidable.
  head_sha       text,
  -- Everything needed to RENDER the nudge later, because the renderer runs in a
  -- different process at a different time and the provider will not be asked
  -- again for facts we already had.
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'pending'
                   check (status in ('pending', 'delivered', 'retired')),
  detected_at    timestamptz not null default now(),
  attempts       integer not null default 0,
  last_error     text,
  settled_at     timestamptz,
  retire_reason  text,
  message_id     uuid
);

-- One UNTOLD row per transition, and PARTIAL ON `pending` for a reason worth
-- stating: the uniqueness must stop a tick loop from re-enqueuing something
-- nobody has been told yet, and must NOT stop a genuinely new occurrence from
-- queuing later. A check that goes red, is fixed, and breaks again is two
-- incidents; a thread that is resolved and reopened is two conversations. An
-- unconditional index would swallow the second of each forever, because the
-- settled row would sit there as a permanent conflict target.
--
-- Whether the second occurrence is actually SAID is then §J's decision, on
-- content — which is the right place for it, because only content can tell
-- "broke again for the same reason" from "broke again for a new one".
--
-- `coalesce(head_sha,'')` because a review thread has no sha, and NULL columns
-- do not conflict with each other.
create unique index if not exists pending_session_nudges_transition_idx
  on public.pending_session_nudges(pr_entity_id, loop_kind, scope_key, coalesce(head_sha, ''))
  where status = 'pending';
create index if not exists pending_session_nudges_pending_idx
  on public.pending_session_nudges(detected_at) where status = 'pending';

comment on table public.pending_session_nudges is
  'Detected-but-untold semantic transitions. Written in the same statement as '
  'the facts they were derived from (103 K), so a transition detected while no '
  'addressee was live is delivered when one appears instead of being consumed.';

-- -----------------------------------------------------------------------------
-- K1. "Is this pull request stacked on an OPEN parent?"
--
-- §G computes the same predicate for the watch list; the delivery drain needs
-- it per row, and re-evaluated at DELIVERY time rather than detection time.
-- That difference is the point: a conflict queued while the parent was open
-- must be delivered once the parent merges, and a suppression stored as a fact
-- could never do that.
-- -----------------------------------------------------------------------------
create or replace function public.pr_is_stacked_on_open_parent(p_pr_entity_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare pr public.pull_requests; answer boolean;
begin
  perform internal.require_identity();
  select * into pr from public.pull_requests where entity_id = p_pr_entity_id;
  if not found then
    raise exception 'no pull request %', p_pr_entity_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(pr.space_id);
  select exists (
    select 1 from public.pull_requests parent
     where parent.space_id = pr.space_id and parent.repo = pr.repo
       and parent.entity_id <> pr.entity_id
       and parent.head_ref is not null and parent.head_ref = pr.base_ref
       and parent.state in ('open', 'draft')
  ) into answer;
  return jsonb_build_object('stacked', answer);
end
$$;

-- -----------------------------------------------------------------------------
-- K2. Retirement. A pending nudge is not kept forever waiting for a session
--     that may never come back — but every removal states WHY, because a queue
--     that silently empties is indistinguishable from one that silently fails.
--
--     * head_moved  — the PR advanced past the commit this was about. The red
--                     check no longer describes the code, and re-announcing it
--                     would send the agent to fix a build that no longer exists.
--     * pr_settled  — merged or closed. Nothing left to act on.
--     * thread_gone — the review thread was resolved or deleted by someone else.
--     * expired     — older than the age-out. The catch-all for a PR whose
--                     session never returns, so the queue cannot grow forever.
-- -----------------------------------------------------------------------------
create or replace function public.retire_stale_pending_nudges(
  p_max_age_hours integer default 48
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare retired integer;
begin
  perform internal.require_identity();
  with settled as (
    update public.pending_session_nudges q
       set status = 'retired', settled_at = now(),
           retire_reason = case
             when pr.state not in ('open', 'draft') then 'pr_settled'
             when q.head_sha is not null and pr.head_sha is not null
                  and lower(q.head_sha) <> lower(pr.head_sha) then 'head_moved'
             when q.loop_kind = 'review_thread' and not exists (
                    select 1 from public.pr_review_thread_facts f
                     where f.pr_entity_id = q.pr_entity_id
                       and f.thread_key = q.scope_key and f.is_resolved = false
                  ) then 'thread_gone'
             else 'expired' end
      from public.pull_requests pr
     where pr.entity_id = q.pr_entity_id
       and q.status = 'pending'
       and internal.is_space_member(q.space_id)
       and (
         pr.state not in ('open', 'draft')
         or (q.head_sha is not null and pr.head_sha is not null
             and lower(q.head_sha) <> lower(pr.head_sha))
         or (q.loop_kind = 'review_thread' and not exists (
               select 1 from public.pr_review_thread_facts f
                where f.pr_entity_id = q.pr_entity_id
                  and f.thread_key = q.scope_key and f.is_resolved = false))
         or q.detected_at < now() - make_interval(hours => greatest(coalesce(p_max_age_hours, 48), 1))
       )
     returning 1
  )
  select count(*)::integer into retired from settled;
  return jsonb_build_object('retired', retired);
end
$$;

-- -----------------------------------------------------------------------------
-- K3. The drain read. Returns only rows that HAVE a live agent addressee right
--     now; everything else stays pending, which is the entire point of the
--     table. Retirement runs first so a stale row is never handed out.
-- -----------------------------------------------------------------------------
create or replace function public.claim_pending_nudges(
  p_limit integer default 20, p_max_age_hours integer default 48
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  perform internal.require_identity();
  perform public.retire_stale_pending_nudges(p_max_age_hours);

  select coalesce(jsonb_agg(t.payload order by t.detected_at), '[]'::jsonb) into result
    from (
      select q.detected_at,
        jsonb_build_object(
          'pendingId', q.id,
          'spaceId', q.space_id,
          'prEntityId', q.pr_entity_id,
          'loopKind', q.loop_kind,
          'scopeKey', q.scope_key,
          'headSha', q.head_sha,
          'payload', q.payload,
          'attempts', q.attempts,
          'repo', pr.repo,
          'number', pr.number,
          'headRef', pr.head_ref,
          'baseRef', pr.base_ref,
          'taskId', (select ed.src_id from public.edges ed
                      where ed.dst_id = pr.entity_id and ed.type = 'tracks'
                      order by ed.created_at limit 1),
          'owningSessionId', sess.id
        ) as payload
        from public.pending_session_nudges q
        join public.pull_requests pr on pr.entity_id = q.pr_entity_id
        join lateral (select internal.pr_owning_session(q.pr_entity_id) as id) sess on true
        join public.work_sessions ws on ws.entity_id = sess.id
       where q.status = 'pending'
         and internal.is_space_member(q.space_id)
         -- The addressee test. No live agent ⇒ not returned ⇒ still pending.
         and ws.status in ('spawning', 'running', 'idle')
         and internal.is_agent_session(sess.id)
       order by q.detected_at
       limit greatest(coalesce(p_limit, 20), 1)
    ) t;

  return jsonb_build_object('pending', result);
end
$$;

-- -----------------------------------------------------------------------------
-- K4. post_session_nudge — dedup, send and settle, in ONE transaction.
--
-- ⚠ WHY THIS DOOR EXISTS AT ALL, rather than the observer calling a message
-- door directly: migration 019 CLOSED the message write surface. It revoked
-- `post_message` from tm8_app and made `w2_post_message_batch` the only way in,
-- and that is not bureaucracy — the batch door is what mints the DELIVERY
-- INTENT for a work_session anchor (019:461). A message posted through the raw
-- door reaches the graph and never reaches the agent's terminal. The first
-- version of this lane called `post_message` and would have done exactly that,
-- behind a 42501 that hid it.
--
-- So this door calls `w2_post_message_batch` like every other writer, as the
-- owner. It does not re-grant the revoked door and it does not reimplement the
-- insert; 019's validation, its ledger identity binding and its delivery
-- intents all still apply. The ONLY thing added is that the dedup claim, the
-- send and the queue settlement commit together — which is what makes a crash
-- mid-send lose nothing instead of recording a nudge that never left.
--
-- ⚠ IT DOES NOT RECORD THE SESSION ROUTES, and that is a constraint rather
-- than a choice: `w2_record_session_message_routes` (072) is owned by the
-- migration role and grants EXECUTE to tm8_app only, so this function — which
-- runs as tm8_graph_owner — cannot call it. Widening 072's grant to make it
-- reachable would quietly broaden a surface that lane does not own, so the
-- caller makes that call instead, as tm8_app, immediately after this returns.
-- Nothing is lost: route recording shapes DELIVERY, and delivery already
-- cannot be transactional (reserving a slot and writing to a PTY are not
-- things SQL does). What must be atomic — the dedup claim, the send and the
-- queue settlement — still is.
-- -----------------------------------------------------------------------------
create or replace function public.post_session_nudge(
  p_pending_id uuid, p_signature text, p_body text,
  p_scope_cap integer default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  q public.pending_session_nudges;
  session_id uuid;
  session_status text;
  scope_count integer;
  posted jsonb;
  -- NOT `message_id`: that is also a column of pending_session_nudges, and
  -- `set message_id = message_id` in the settlement below resolves to the
  -- column on both sides — a self-assignment Postgres rejects as ambiguous.
  new_message_id uuid;
begin
  perform internal.require_identity();
  select * into q from public.pending_session_nudges where id = p_pending_id for update;
  if not found then
    raise exception 'no pending nudge %', p_pending_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(q.space_id);
  if q.status <> 'pending' then
    return jsonb_build_object('posted', false, 'reason', 'already_settled',
                              'status', q.status);
  end if;
  if nullif(btrim(coalesce(p_signature, '')), '') is null
     or nullif(btrim(coalesce(p_body, '')), '') is null then
    raise exception 'nudge signature and body are required' using errcode = '22023';
  end if;
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;

  -- Re-resolved HERE, not trusted from the drain read: the session that owned
  -- this pull request when the row was handed out may have exited since, and a
  -- nudge is only worth sending to somebody who can still act on it.
  session_id := internal.pr_owning_session(q.pr_entity_id);
  if session_id is null then
    return jsonb_build_object('posted', false, 'reason', 'no_owning_session');
  end if;
  select status into session_status from public.work_sessions where entity_id = session_id;
  if session_status is null or session_status not in ('spawning','running','idle') then
    return jsonb_build_object('posted', false, 'reason', 'session_not_live',
                              'sessionStatus', session_status);
  end if;
  if not internal.is_agent_session(session_id) then
    return jsonb_build_object('posted', false, 'reason', 'not_an_agent_session');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    session_id::text || ':nudge:' || q.loop_kind || ':' || q.scope_key, 0));

  if exists (
    select 1 from public.session_nudge_signatures
     where space_id = q.space_id and work_session_id = session_id
       and loop_kind = q.loop_kind and scope_key = q.scope_key and signature = p_signature
  ) then
    -- Already told. The transition is answered, so the queue row is done too.
    update public.pending_session_nudges
       set status = 'retired', settled_at = now(), retire_reason = 'duplicate'
     where id = p_pending_id;
    return jsonb_build_object('posted', false, 'reason', 'duplicate');
  end if;

  select count(*) into scope_count from public.session_nudge_signatures
   where space_id = q.space_id and work_session_id = session_id
     and loop_kind = q.loop_kind and scope_key = q.scope_key;
  if p_scope_cap is not null and scope_count >= greatest(p_scope_cap, 0) then
    update public.pending_session_nudges
       set status = 'retired', settled_at = now(), retire_reason = 'capped'
     where id = p_pending_id;
    return jsonb_build_object('posted', false, 'reason', 'capped', 'scopeCount', scope_count);
  end if;

  insert into public.session_nudge_signatures(
    space_id, work_session_id, loop_kind, scope_key, signature)
  values (q.space_id, session_id, q.loop_kind, q.scope_key, p_signature);

  -- 019's door, as the owner. If it raises — body too long, anchor unreadable —
  -- the signature insert and the settlement below roll back with it, so the
  -- transition stays pending and is retried rather than silently swallowed.
  posted := public.w2_post_message_batch(
    array[session_id], p_body, null, '{}'::uuid[], '{}'::uuid[], null, null, p_client_mutation_id);
  new_message_id := (posted -> 'messageIds' ->> 0)::uuid;

  update public.pending_session_nudges
     set status = 'delivered', settled_at = now(), message_id = new_message_id,
         attempts = attempts + 1
   where id = p_pending_id;

  return jsonb_build_object(
    'posted', true, 'messageId', new_message_id, 'workSessionId', session_id,
    'scopeCount', scope_count + 1,
    'messageBatchId', posted ->> 'messageBatchId');
end
$$;

-- -----------------------------------------------------------------------------
-- K5. Failure record. A send that threw leaves the row pending (the transaction
--     rolled back), so this exists for the caller to record WHY without
--     resurrecting anything — an attempts counter nobody can read is the same
--     decoration `attempts` was on 006's queue before 081 gave it a budget.
-- -----------------------------------------------------------------------------
create or replace function public.record_pending_nudge_failure(
  p_pending_id uuid, p_error text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare q public.pending_session_nudges;
begin
  perform internal.require_identity();
  select * into q from public.pending_session_nudges where id = p_pending_id;
  if not found then
    raise exception 'no pending nudge %', p_pending_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(q.space_id);
  update public.pending_session_nudges
     set attempts = attempts + 1, last_error = left(coalesce(p_error, ''), 500)
   where id = p_pending_id and status = 'pending';
  return jsonb_build_object('pendingId', p_pending_id);
end
$$;

revoke all on function public.pr_is_stacked_on_open_parent(uuid) from public;
grant execute on function public.pr_is_stacked_on_open_parent(uuid) to tm8_app;
revoke all on function public.claim_pending_nudges(integer,integer) from public;
grant execute on function public.claim_pending_nudges(integer,integer) to tm8_app;
revoke all on function public.retire_stale_pending_nudges(integer) from public;
grant execute on function public.retire_stale_pending_nudges(integer) to tm8_app;
revoke all on function public.post_session_nudge(uuid,text,text,integer,text) from public;
grant execute on function public.post_session_nudge(uuid,text,text,integer,text) to tm8_app;
revoke all on function public.record_pending_nudge_failure(uuid,text) from public;
grant execute on function public.record_pending_nudge_failure(uuid,text) to tm8_app;

reset role;
