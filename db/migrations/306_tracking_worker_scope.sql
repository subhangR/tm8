-- =============================================================================
-- 306 · TRACKING WORKER SCOPE AND FRESHNESS (Game v1 P0e, task 01a111b1-8ee0).
--
-- THE BUG. Both tracking jobs (081's queue drainer `tracking.observer`, 103's
-- watcher `tracking.forge-watcher`) run as the node's loopback owner. Every
-- door they read through is filtered to the CALLER'S member spaces
-- (`observer_watch_targets` and `claim_tracking_refresh`, 220:508/556), and
-- every door they write through calls `require_space_member`. The owner
-- belongs to the spaces it created and nothing else, so a pull request linked
-- in any other space was never polled once, and `tm8 tracking refresh` queued
-- requests that no process could claim. Measured on prod, 6 Oct 2026: one
-- space fresh, six spaces' PRs never fetched (`fetched_at` null on all of them).
--
-- THE FIX, and its boundary (owner rulings on the task, 6 Oct):
--
--   1. A new claim, `tm8.background_job`, that only the in-process scheduler
--      binds (db/client.ts, a closed list in db/types.ts). No HTTP, CLI or MCP
--      claims builder produces it, and a space-pinned session never binds it.
--      `internal.is_tracking_worker()` reads it. A node admin over HTTP is NOT
--      a tracking worker — `nodeAdmin` is deliberately not the key.
--   2. The bypass reaches ONLY the tracking list / claim / apply / etag doors,
--      through `internal.require_tracking_space` and
--      `internal.tracking_space_ids`. No general entity read changes.
--   3. Those doors write tracking facts only: PR/commit state, checks, review
--      threads, etags, poll bookkeeping. Nothing here lets the worker write any
--      other entity field, and nothing here moves a task: owner ruling, 6 Oct,
--      "no link between PR and task completion". The pr_merged gate stays what
--      082/151 made it, an opt-in check on a manual move to done.
--   4. Polling is prioritised and backed off (§3), because an unauthenticated
--      node has 60 requests an hour for every space at once.
--
-- ALSO HERE:
--   §2 freshness: `last_polled_at` / `last_poll_error` on pull_requests and
--      commits, written on EVERY poll (a 304 included — `fetched_at` only moves
--      when facts are written, so it could not say "we looked and nothing
--      changed").
--   §4 per-space GitHub credential: `read_space_tracking_token`, the space's
--      default active GitHub token, opened only by the tracking worker and only
--      for that space's own pull requests.
--   §6 health: `tracking_health` per space, and a system attention signal on a
--      gated in_review task whose pull request tracking has gone stale.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. Who the tracking worker is.
-- -----------------------------------------------------------------------------

create or replace function internal.is_tracking_worker()
returns boolean
language sql stable
set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null
     and coalesce(internal.claim_text('tm8.background_job') in ('tracking.observer', 'tracking.forge-watcher'), false)
     and nullif(current_setting('tm8.session_space_id', true), '') is null
$$;

comment on function internal.is_tracking_worker() is
  '306: true only inside a transaction the in-process tracking jobs opened. The '
  'claim is bound by db/client.ts from a closed list and never from a request; '
  'a node admin over HTTP is not a tracking worker.';

create or replace function internal.require_tracking_space(target_space uuid)
returns void
language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_identity();
  if internal.is_tracking_worker() then
    return;
  end if;
  perform internal.require_space_member(target_space);
end
$$;

create or replace function internal.tracking_space_ids()
returns uuid[]
language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select case when internal.is_tracking_worker()
              then coalesce((select array_agg(s.id) from public.spaces s), '{}'::uuid[])
              else internal.member_space_ids() end
$$;

revoke all on function internal.is_tracking_worker() from public;
revoke all on function internal.require_tracking_space(uuid) from public;
revoke all on function internal.tracking_space_ids() from public;

-- -----------------------------------------------------------------------------
-- §2. Freshness columns.
-- -----------------------------------------------------------------------------

alter table public.pull_requests
  add column if not exists last_polled_at timestamptz,
  add column if not exists last_poll_error text;

alter table public.commits
  add column if not exists last_polled_at timestamptz,
  add column if not exists last_poll_error text;

comment on column public.pull_requests.last_polled_at is
  '306: when tracking last ASKED the provider about this row, whatever it answered '
  '(a 304 and an error included). fetched_at is when facts were last written.';

-- The watch list's scan: open/draft rows ordered by when they were last looked at.
create index if not exists pull_requests_watch_idx
  on public.pull_requests (last_polled_at nulls first)
  where state in ('open', 'draft');

-- Poll bookkeeping. One door for both kinds, called after every attempt.
create or replace function public.record_tracking_poll(
  p_entity_id uuid,
  p_error text default null)
returns jsonb
language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare v_space uuid; v_kind text;
begin
  perform internal.require_identity();
  select e.space_id, e.kind into v_space, v_kind
    from public.entities e where e.id = p_entity_id and e.deleted_at is null;
  if v_space is null or v_kind not in ('pull_request', 'commit') then
    raise exception 'no tracked entity %', p_entity_id using errcode = 'P0002';
  end if;
  perform internal.require_tracking_space(v_space);

  if v_kind = 'pull_request' then
    update public.pull_requests
       set last_polled_at  = now(),
           last_poll_error = left(p_error, 500)
     where entity_id = p_entity_id;
    if p_error is null then
      -- Polled cleanly: any staleness signal raised on a task waiting on it ends.
      perform internal.clear_attention_signal(v_space, 'tracking_stale:' || p_entity_id);
    end if;
  else
    update public.commits
       set last_polled_at = now(), last_poll_error = left(p_error, 500)
     where entity_id = p_entity_id;
  end if;
  return jsonb_build_object('entityId', p_entity_id, 'polledAt', now());
end
$$;

revoke all on function public.record_tracking_poll(uuid, text) from public;
grant execute on function public.record_tracking_poll(uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §3. The watch list: every space for the worker, prioritised, backed off.
--
-- A row is DUE when it was last polled longer ago than its tier allows:
--   hot   (a task tracking it is in review or working, or the PR was linked in
--          the last day)            -> the caller's floor (p_min_age_seconds)
--   warm  (linked in the last week) -> at least 10 minutes
--   cold  (older, or its last poll errored) -> at least an hour
-- Never-polled rows come first, then hot before warm before cold, then the
-- longest-unpolled. An unauthenticated node spends its 60 requests an hour on
-- the rows a merge is most likely to be waiting on.
--
-- A MERGED row whose CI rollup is still pending stays on the list for two days:
-- a PR merged while checks were still running would otherwise leave the list
-- with `ci_status = 'pending'` forever, and the gate and the Code Factory map
-- would read a CI verdict that was never final.
-- -----------------------------------------------------------------------------

create or replace function public.observer_watch_targets(p_limit integer DEFAULT 25, p_min_age_seconds integer DEFAULT 0)
returns jsonb
language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  perform internal.require_identity();

  with candidates as (
    select pr.*,
           case
             when exists (select 1 from public.edges ed join public.tasks t on t.entity_id = ed.src_id
                           where ed.dst_id = pr.entity_id and ed.type = 'tracks'
                             and t.work_status in ('in_review', 'working'))
                  or pr.created_at > now() - interval '1 day' then 0
             when pr.last_poll_error is null and pr.created_at > now() - interval '7 days' then 1
             else 2
           end as tier
      from public.pull_requests pr
      join public.entities pe on pe.id = pr.entity_id and pe.deleted_at is null
     where (pr.state in ('open','draft')
            or (pr.state = 'merged' and pr.ci_status = 'pending'
                and coalesce(pr.last_polled_at, now()) > now() - interval '2 days'))
       and pr.space_id = any ((select internal.tracking_space_ids())::uuid[])
       and exists (select 1 from public.edges ed
                    where ed.dst_id = pr.entity_id and ed.type = 'tracks')
  ), due as (
    select c.* from candidates c
     where c.last_polled_at is null
        or c.last_polled_at < now() - make_interval(secs => greatest(
             greatest(coalesce(p_min_age_seconds, 0), 0),
             case c.tier when 0 then 0 when 1 then 600 else 3600 end))
     order by (c.last_polled_at is not null), c.tier, c.last_polled_at nulls first, c.entity_id
     limit greatest(coalesce(p_limit, 25), 1)
  )
  select coalesce(jsonb_agg(t.payload order by t.ordinal), '[]'::jsonb) into result
    from (
      select
        row_number() over (order by (pr.last_polled_at is not null), pr.tier, pr.last_polled_at nulls first, pr.entity_id) as ordinal,
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
          'tier', pr.tier,
          'lastPolledAt', pr.last_polled_at,
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
        from due pr
        left join lateral (
          select internal.pr_owning_session(pr.entity_id) as id
        ) sess on true
        left join public.work_sessions ws on ws.entity_id = sess.id
    ) t;

  return jsonb_build_object('targets', result);
end
$$;

-- -----------------------------------------------------------------------------
-- §3b. The rest of the tracking doors: 220's/103's/081's bodies VERBATIM except
-- that `require_space_member` is `require_tracking_space` and
-- `member_space_ids()` is `tracking_space_ids()`. For every caller that is not
-- the tracking worker those two answer exactly as before.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_tracking_refresh(p_limit integer DEFAULT 10, p_stale_after_seconds integer DEFAULT 600, p_max_attempts integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare claimed jsonb;
begin
  perform internal.require_identity();

  update public.tracking_refresh_requests
     set status = 'queued', started_at = null
   where status = 'running'
     and started_at is not null
     and started_at < now() - make_interval(secs => greatest(p_stale_after_seconds, 1));

  -- Retire the rows that have burned their budget. Recorded as `failed` with a
  -- reason rather than left queued, so an operator sees a terminal row instead
  -- of a tick that mysteriously never finishes.
  update public.tracking_refresh_requests
     set status = 'failed',
         error = coalesce(error, '') ||
                 case when coalesce(error, '') = '' then '' else '; ' end ||
                 'retired after ' || attempts || ' attempts',
         completed_at = now()
   where status = 'queued'
     and attempts >= greatest(coalesce(p_max_attempts, 5), 1);

  with picked as (
    select id from public.tracking_refresh_requests r
     where r.status = 'queued'
       -- Same entitlement the apply doors enforce. Claiming what we could never
       -- apply is what turns one bad row into a permanent wedge.
       and r.space_id = any ((select internal.tracking_space_ids())::uuid[])
     order by r.created_at
     limit greatest(coalesce(p_limit, 10), 1)
     for update skip locked
  ), taken as (
    update public.tracking_refresh_requests r
       set status = 'running', started_at = now(), attempts = r.attempts + 1
      from picked
     where r.id = picked.id
     returning r.id, r.space_id, r.entity_ids, r.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'requestId', t.id, 'spaceId', t.space_id, 'attempts', t.attempts,
           'targets', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'entityId', e.id, 'kind', e.kind,
                      'provider', coalesce(pr.provider, c.provider),
                      'repo',     coalesce(pr.repo, c.repo),
                      'number',   pr.number,
                      'sha',      c.sha))
               from public.entities e
               left join public.pull_requests pr on pr.entity_id = e.id
               left join public.commits c        on c.entity_id  = e.id
              where e.space_id = t.space_id
                and e.deleted_at is null
                and e.kind in ('pull_request','commit')
                -- An empty/absent entity_ids means "everything tracked in this
                -- space", which is what 017's door accepts and records.
                and (t.entity_ids is null or cardinality(t.entity_ids) = 0
                     or e.id = any(t.entity_ids))
           ), '[]'::jsonb))), '[]'::jsonb)
    into claimed
    from taken t;

  return jsonb_build_object('claimed', claimed);
end
$function$;

CREATE OR REPLACE FUNCTION public.apply_pull_request_facts(p_entity_id uuid, p_title text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_head_sha text DEFAULT NULL::text, p_ci_status text DEFAULT NULL::text, p_head_ref text DEFAULT NULL::text, p_base_ref text DEFAULT NULL::text, p_mergeable_state text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare row public.pull_requests;
begin
  perform internal.require_identity();
  select * into row from public.pull_requests where entity_id = p_entity_id for update;
  if not found then
    raise exception 'no pull request %', p_entity_id using errcode = 'P0002';
  end if;
  perform internal.require_tracking_space(row.space_id);
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
$function$;

CREATE OR REPLACE FUNCTION public.apply_commit_facts(p_entity_id uuid, p_message text DEFAULT NULL::text, p_author text DEFAULT NULL::text, p_committed_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare row public.commits;
begin
  perform internal.require_identity();
  select * into row from public.commits where entity_id = p_entity_id for update;
  if not found then
    raise exception 'no commit %', p_entity_id using errcode = 'P0002';
  end if;
  perform internal.require_tracking_space(row.space_id);

  update public.commits
     set message      = coalesce(p_message, message),
         author       = coalesce(p_author, author),
         committed_at = coalesce(p_committed_at, committed_at),
         url          = coalesce(p_url, url),
         fetched_at   = now(),
         updated_at   = now()
   where entity_id = p_entity_id;

  return jsonb_build_object('entityId', p_entity_id,
                            'changed', (coalesce(p_message, row.message) is distinct from row.message
                                     or coalesce(p_author, row.author) is distinct from row.author));
end
$function$;

CREATE OR REPLACE FUNCTION public.apply_pr_check_facts(p_pr_entity_id uuid, p_head_sha text, p_checks jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
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
  perform internal.require_tracking_space(pr.space_id);
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
$function$;

CREATE OR REPLACE FUNCTION public.apply_pr_review_thread_facts(p_pr_entity_id uuid, p_threads jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
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
  perform internal.require_tracking_space(pr.space_id);

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
$function$;

CREATE OR REPLACE FUNCTION public.provider_etag_lookup(p_space_id uuid, p_resource_keys text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare result jsonb;
begin
  perform internal.require_identity();
  perform internal.require_tracking_space(p_space_id);
  select coalesce(jsonb_object_agg(resource_key, etag), '{}'::jsonb) into result
    from public.provider_etags
   where space_id = p_space_id and resource_key = any(coalesce(p_resource_keys, '{}'::text[]));
  return result;
end
$function$;

CREATE OR REPLACE FUNCTION public.provider_etag_record(p_space_id uuid, p_resource_key text, p_etag text DEFAULT NULL::text, p_not_modified boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
begin
  perform internal.require_identity();
  perform internal.require_tracking_space(p_space_id);
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
$function$;

-- 081's completion door had no space check at all; it now has the same one the
-- claim door has, so a request can be completed only by whoever could claim it.
create or replace function public.complete_tracking_refresh(p_request_id uuid, p_error text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
returns jsonb
language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare final_status text; v_space uuid;
begin
  perform internal.require_identity();
  final_status := coalesce(p_status, case when p_error is null then 'completed' else 'failed' end);
  if final_status not in ('completed','failed') then
    raise exception 'invalid tracking refresh status: %', final_status using errcode = '22023';
  end if;
  select space_id into v_space from public.tracking_refresh_requests where id = p_request_id;
  if v_space is null then
    raise exception 'no tracking refresh request %', p_request_id using errcode = 'P0002';
  end if;
  perform internal.require_tracking_space(v_space);
  update public.tracking_refresh_requests
     set status = final_status,
         error = p_error,
         completed_at = now()
   where id = p_request_id;
  return jsonb_build_object('requestId', p_request_id, 'status', final_status);
end
$$;

-- -----------------------------------------------------------------------------
-- §4. The space's GitHub credential, for the tracking worker only.
--
-- Owner ruling (6 Oct): no node-wide env token on prod. A space that holds a
-- GitHub token credential has its OWN pull requests polled with it, and with
-- nothing else's. Only the space DEFAULT, active, token-shaped row is eligible:
-- a member's private credential is theirs to spend, not the node's. The
-- ciphertext leaves Postgres sealed; the server opens it with the node key.
-- -----------------------------------------------------------------------------

create or replace function public.read_space_tracking_token(p_space_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare stored public.space_credentials;
begin
  perform internal.require_identity();
  if not internal.is_tracking_worker() then
    raise exception 'only the tracking worker reads a tracking token' using errcode = '42501';
  end if;
  select * into stored from public.space_credentials
   where space_id = p_space_id and provider = 'github' and shape = 'token'
     and is_default and status = 'active'
     and secret_ciphertext is not null and secret_nonce is not null
   order by updated_at desc
   limit 1;
  if stored.id is null then return null; end if;
  update public.space_credentials set last_used_at = now() where id = stored.id;
  return jsonb_build_object(
    'credentialId', stored.id,
    'spaceId', stored.space_id,
    'provider', stored.provider,
    'secretCiphertext', encode(stored.secret_ciphertext, 'base64'),
    'secretNonce', encode(stored.secret_nonce, 'base64'));
end
$$;

revoke all on function public.read_space_tracking_token(uuid) from public;
grant execute on function public.read_space_tracking_token(uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- §6. Health, and staleness made visible.
-- -----------------------------------------------------------------------------

-- Per space the caller may see (every space for the tracking worker): how many
-- open rows are tracked, how many were never polled or are older than the
-- threshold, the newest and oldest poll, and whether the space has a GitHub
-- credential the poller can use (without one it polls unauthenticated).
create or replace function public.tracking_health(p_stale_after_seconds integer default 3600)
returns jsonb
language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare result jsonb; threshold interval;
begin
  perform internal.require_identity();
  threshold := make_interval(secs => greatest(coalesce(p_stale_after_seconds, 3600), 60));
  select coalesce(jsonb_agg(row_to_json(s)::jsonb order by s."spaceId"), '[]'::jsonb) into result
    from (
      select pr.space_id as "spaceId",
             count(*) filter (where pr.state in ('open','draft')) as "trackedOpen",
             count(*) filter (where pr.last_polled_at is null) as "neverPolled",
             count(*) filter (where pr.state in ('open','draft')
                                and coalesce(pr.last_polled_at, pr.created_at) < now() - threshold) as "stale",
             count(*) filter (where pr.last_poll_error is not null) as "erroring",
             max(pr.last_polled_at) as "lastPolledAt",
             min(pr.last_polled_at) filter (where pr.state in ('open','draft')) as "oldestOpenPolledAt",
             exists (select 1 from public.space_credentials sc
                      where sc.space_id = pr.space_id and sc.provider = 'github' and sc.shape = 'token'
                        and sc.is_default and sc.status = 'active') as "githubCredential"
        from public.pull_requests pr
        join public.entities pe on pe.id = pr.entity_id and pe.deleted_at is null
       where pr.space_id = any ((select internal.tracking_space_ids())::uuid[])
         and exists (select 1 from public.edges ed where ed.dst_id = pr.entity_id and ed.type = 'tracks')
       group by pr.space_id
    ) s;
  return jsonb_build_object('staleAfterSeconds', extract(epoch from threshold)::integer, 'spaces', result);
end
$$;

revoke all on function public.tracking_health(integer) from public;
grant execute on function public.tracking_health(integer) to tm8_app;

-- The attention half. A pr_merged-gated task in review is where a stale poll
-- costs something — the gate reads the stored PR state when someone moves the
-- task to done, and a stale row refuses a merged PR — so that is where the
-- signal goes:
-- one per (task, pull request), raised here, cleared by record_tracking_poll
-- the moment that pull request is polled cleanly. Worker only.
create or replace function public.tracking_sweep_staleness(p_stale_after_seconds integer default 3600)
returns jsonb
language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare r record; raised integer := 0; threshold interval;
begin
  perform internal.require_identity();
  if not internal.is_tracking_worker() then
    raise exception 'only the tracking worker sweeps staleness' using errcode = '42501';
  end if;
  threshold := make_interval(secs => greatest(coalesce(p_stale_after_seconds, 3600), 60));
  for r in
    select ed.space_id, ed.src_id as task_id, ed.created_by, pr.entity_id as pr_id, pr.repo, pr.number,
           pr.last_polled_at, pr.last_poll_error
      from public.edges ed
      join public.tasks tk on tk.entity_id = ed.src_id
      join public.entities te on te.id = tk.entity_id and te.deleted_at is null
      join public.pull_requests pr on pr.entity_id = ed.dst_id
     where ed.type = 'tracks'
       and tk.completion_gate = 'pr_merged' and tk.work_status = 'in_review'
       and pr.state in ('open', 'draft')
       and (coalesce(pr.last_polled_at, pr.created_at) < now() - threshold
            or pr.last_poll_error is not null)
  loop
    perform internal.raise_attention_signal(
      r.space_id, r.task_id, 'tracking_stale:' || r.pr_id,
      format('PR tracking is stale for %s#%s (last polled %s%s). Its pr_merged gate reads that stored state.',
             r.repo, r.number, coalesce(to_char(r.last_polled_at, 'YYYY-MM-DD HH24:MI TZ'), 'never'),
             coalesce(', last error: ' || left(r.last_poll_error, 120), '')),
      'normal', 'review', r.created_by);
    raised := raised + 1;
  end loop;
  return jsonb_build_object('raised', raised);
end
$$;

revoke all on function public.tracking_sweep_staleness(integer) from public;
grant execute on function public.tracking_sweep_staleness(integer) to tm8_app;

reset role;
