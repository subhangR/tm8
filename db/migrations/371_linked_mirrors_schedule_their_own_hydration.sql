-- Linked provider mirrors schedule their own hydration.
--
-- THE DEFECT
--
--   `public.link_commit` (017:581) creates the commit mirror as a DELIBERATE
--   PLACEHOLDER: `message` is set to the sha itself, and `author`,
--   `committed_at` and `fetched_at` are left null. `public.link_pull_request`
--   (017:535) does the same with `title := repo || ' #' || number` and
--   `state := 'open'`. Neither door reads the provider — that is correct, a
--   command inside a transaction has no business making a network call.
--
--   The real facts are meant to arrive later, through the tracking observer
--   (packages/server/src/tracking/observer.ts), which calls
--   `public.apply_commit_facts` / `public.apply_pull_request_facts` with what
--   it read from GitHub. That observer is purely QUEUE-DRIVEN: it drains
--   `public.tracking_refresh_requests` and does nothing else.
--
--   And nothing has ever put a linking event on that queue. The only producer
--   is `public.queue_tracking_refresh` (034:107), reachable only when a human
--   runs `tm8 tracking refresh`. So the handoff was never completed: the link
--   door wrote a placeholder and told no one it needed filling.
--
--   On the node this was found on, 57 of 86 commit mirrors and 40 of 95 pull
--   request mirrors had never been fetched — every single one of them created
--   by a link. The 29 hydrated commits all came from the local worktree
--   recorder (`public.record_session_commit`, 082:181), which reads git
--   directly and therefore never needed the queue. Running `tracking refresh`
--   by hand on one of the 57 hydrated it on the next observer tick, which is
--   what fixes the fault to a missing enqueue and nothing else.
--
-- THE FIX
--
--   The link doors enqueue. One row per newly-placeholdered mirror, written in
--   the same transaction as the link, so a link that commits cannot leave an
--   unhydrated mirror with nobody scheduled to hydrate it. The observer's
--   existing 60s tick does the rest, and every failure mode it already handles
--   — rate limits, 404s, retirement after N attempts — applies unchanged.
--
--   Two bounds on what gets enqueued, both in `internal.schedule_tracking_hydration`:
--
--     * ONLY WHEN THE MIRROR STILL HAS NO PROVIDER FACTS (`fetched_at is null`).
--       Re-linking a commit whose facts were already read is not new
--       information, and should not cost a provider request.
--     * ONLY WHEN A QUEUED REQUEST DOES NOT ALREADY COVER IT. Linking the same
--       commit to three tasks before the observer's next tick is one refresh,
--       not three. A request with null/empty `entity_ids` means "everything
--       tracked in this Space" (081:597), so it counts as covering.
--
--   The helper takes INVOKER rights, exactly like `internal.w2_associate_tracking_project`
--   (017:494). Called from the definer link doors it runs as tm8_graph_owner
--   and inserts; called directly by tm8_app it runs as tm8_app, which holds no
--   INSERT on `tracking_refresh_requests`, and fails. The privilege comes from
--   the door, not from the helper.
--
--   `requested_by` FKs to `public.members(entity_id)`. It is resolved as
--   `internal.current_member_id` first — matching what `queue_tracking_refresh`
--   records for a hand-run refresh — falling back to `internal.member_for_actor`
--   (166:37) so an actor that is a teammate rather than a member still maps to
--   a real member row instead of tripping the FK. That is the same conflation
--   166 fixed for `space_projects.linked_by`, and it is worth not repeating.
--
-- WHAT THIS DOES NOT DO
--
--   It does not repair the mirrors already in the graph. They are hydrated by
--   one `tracking.refresh` naming them, which is an operational action and not
--   a migration's business — a migration that enqueued 97 provider requests as
--   a side effect of `db/migrate.mjs` would be a surprise, and on a node whose
--   token cannot see the repo it would be a wedge.

set role tm8_graph_owner;

-- Ask the tracking observer to read this mirror's facts, unless it already has
-- them or someone has already asked. Returns the request id, or null when no
-- request was needed — callers ignore it; it exists for tests and for a future
-- door that wants to report what it scheduled.
create or replace function internal.schedule_tracking_hydration(
  p_space_id uuid, p_entity_id uuid, p_actor_id uuid default null
) returns uuid language plpgsql set search_path = public, internal, pg_temp as $$
declare requester uuid; request_id uuid; already boolean;
begin
  if p_space_id is null or p_entity_id is null then return null; end if;

  -- Already fetched? Then there is nothing to learn that we do not have. Both
  -- mirror tables carry `fetched_at`, and only the apply doors stamp it, so it
  -- is the one honest "the provider has answered about this row" marker.
  if exists (select 1 from public.commits
              where entity_id = p_entity_id and fetched_at is not null)
     or exists (select 1 from public.pull_requests
                 where entity_id = p_entity_id and fetched_at is not null) then
    return null;
  end if;

  select exists (
    select 1 from public.tracking_refresh_requests
     where space_id = p_space_id
       and status = 'queued'
       and (entity_ids is null or cardinality(entity_ids) = 0
            or p_entity_id = any(entity_ids))
  ) into already;
  if already then return null; end if;

  requester := coalesce(internal.current_member_id(p_space_id),
                        internal.member_for_actor(p_actor_id, p_space_id));
  -- Unreachable from the link doors: both call `internal.require_space_member`
  -- before they get here, and a caller that passed it has a member row. Kept
  -- because dropping a queue row is a strictly better failure than turning a
  -- successful link into a foreign key violation.
  if requester is null then return null; end if;

  insert into public.tracking_refresh_requests(space_id, requested_by, entity_ids)
  values (p_space_id, requester, array[p_entity_id])
  returning id into request_id;
  return request_id;
end
$$;

comment on function internal.schedule_tracking_hydration(uuid, uuid, uuid) is
  'Enqueues one tracking_refresh_requests row for a provider mirror that has '
  'never been fetched, unless a queued request already covers it. Invoker '
  'rights on purpose: the INSERT privilege comes from the SECURITY DEFINER '
  'link door that calls it, and tm8_app holds none of its own.';

-- Supersedes 017:581. Body is unchanged apart from the hydration enqueue.
create or replace function public.link_commit(
  p_task_id uuid, p_url text, p_provider text, p_repo text, p_sha text,
  p_project_id uuid default null, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; task public.entities; actor uuid; artifact_id uuid; tracks_id uuid;
  projection_id uuid; activity_id uuid; normalized_sha text := lower(p_sha);
begin
  replay := internal.ledger_replay(p_client_mutation_id,'entities.commands.linkCommit'); if replay is not null then return replay; end if;
  if p_project_id is not null then
    perform 1 from public.projects where id=p_project_id for update;
    if not found then raise exception 'Project not found' using errcode='23514',detail='project_not_linked'; end if;
  end if;
  select * into task from public.entities where id=p_task_id and kind='task' and deleted_at is null for update;
  if task.id is null then raise exception 'task not found' using errcode='P0002'; end if;
  perform internal.require_space_member(task.space_id);
  actor := internal.resolve_actor(p_actor_id,task.space_id); perform internal.bind_actor(actor);
  if nullif(btrim(p_repo),'') is null or normalized_sha !~ '^[a-f0-9]{7,64}$' then
    raise exception 'invalid commit reference' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(task.space_id::text||':commit:'||lower(p_provider)||':'||lower(p_repo)||':'||normalized_sha,0));
  select entity_id into artifact_id from public.commits
   where space_id=task.space_id and provider=lower(p_provider) and repo=p_repo and sha=normalized_sha for update;
  if artifact_id is null then
    artifact_id := internal.create_envelope(task.space_id,'commit',actor,null,null);
    insert into public.commits(entity_id,space_id,provider,url,repo,sha,message)
    values(artifact_id,task.space_id,lower(p_provider),p_url,p_repo,normalized_sha,normalized_sha);
    perform internal.record_initial_version(artifact_id,actor);
  else
    update public.commits set url=p_url,updated_at=now() where entity_id=artifact_id and url is distinct from p_url;
  end if;
  -- The message above is the sha and the author is null; ask the observer for
  -- the real ones. Placed here, next to the placeholder, so the two can never
  -- drift apart again.
  perform internal.schedule_tracking_hydration(task.space_id,artifact_id,actor);
  insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
  values(task.space_id,p_task_id,artifact_id,'tracks',jsonb_build_object('url',p_url),actor)
  on conflict(src_id,dst_id,type) do update set props=excluded.props,updated_at=now()
  returning id into tracks_id;
  if p_project_id is not null then
    perform 1 from public.spaces where id=task.space_id for update;
    projection_id := internal.w2_associate_tracking_project(task.space_id,artifact_id,p_project_id,actor);
  end if;
  activity_id := internal.record_activity(task.space_id,p_task_id,actor,'linked',tracks_id,
    jsonb_build_object('commitId',artifact_id,'url',p_url,'projectId',p_project_id));
  return internal.ledger_record(p_client_mutation_id,'entities.commands.linkCommit',
    internal.command_result(p_task_id,tracks_id,activity_id,
      array_remove(array[p_task_id,artifact_id,projection_id],null)));
end
$$;

comment on function public.link_commit(uuid,text,text,text,text,uuid,uuid,text) is
  'Links a commit to a task, creating the mirror as a placeholder and enqueueing '
  'a tracking refresh so the observer fills in message/author/committed_at. '
  'Supersedes 017_w2_entities_commands_tracking.sql:581.';

-- Supersedes 017:535. Body is unchanged apart from the hydration enqueue: the
-- pull request mirror is placeholdered the same way (title is 'repo #number',
-- state is assumed 'open') and was never scheduled either.
create or replace function public.link_pull_request(
  p_task_id uuid, p_url text, p_provider text, p_repo text, p_number integer,
  p_project_id uuid default null, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; task public.entities; actor uuid; artifact_id uuid; tracks_id uuid;
  projection_id uuid; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id,'entities.commands.linkPr'); if replay is not null then return replay; end if;
  if p_project_id is not null then
    perform 1 from public.projects where id=p_project_id for update;
    if not found then raise exception 'Project not found' using errcode='23514',detail='project_not_linked'; end if;
  end if;
  select * into task from public.entities where id=p_task_id and kind='task' and deleted_at is null for update;
  if task.id is null then raise exception 'task not found' using errcode='P0002'; end if;
  perform internal.require_space_member(task.space_id);
  actor := internal.resolve_actor(p_actor_id,task.space_id); perform internal.bind_actor(actor);
  if nullif(btrim(p_repo),'') is null or p_number<1 or nullif(btrim(p_url),'') is null then
    raise exception 'invalid pull request reference' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(task.space_id::text||':pr:'||lower(p_provider)||':'||lower(p_repo)||':'||p_number,0));
  select entity_id into artifact_id from public.pull_requests
   where space_id=task.space_id and provider=lower(p_provider) and repo=p_repo and number=p_number for update;
  if artifact_id is null then
    artifact_id := internal.create_envelope(task.space_id,'pull_request',actor,null,null);
    insert into public.pull_requests(entity_id,space_id,provider,url,repo,number,title,state)
    values(artifact_id,task.space_id,lower(p_provider),p_url,p_repo,p_number,p_repo||' #'||p_number,'open');
    perform internal.record_initial_version(artifact_id,actor);
  else
    update public.pull_requests set url=p_url,updated_at=now() where entity_id=artifact_id and url is distinct from p_url;
  end if;
  perform internal.schedule_tracking_hydration(task.space_id,artifact_id,actor);
  insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
  values(task.space_id,p_task_id,artifact_id,'tracks',jsonb_build_object('url',p_url),actor)
  on conflict(src_id,dst_id,type) do update set props=excluded.props,updated_at=now()
  returning id into tracks_id;
  if p_project_id is not null then
    perform 1 from public.spaces where id=task.space_id for update;
    projection_id := internal.w2_associate_tracking_project(task.space_id,artifact_id,p_project_id,actor);
  end if;
  activity_id := internal.record_activity(task.space_id,p_task_id,actor,'pr.linked',tracks_id,
    jsonb_build_object('pullRequestId',artifact_id,'url',p_url,'projectId',p_project_id));
  return internal.ledger_record(p_client_mutation_id,'entities.commands.linkPr',
    internal.command_result(p_task_id,tracks_id,activity_id,
      array_remove(array[p_task_id,artifact_id,projection_id],null)));
end
$$;

comment on function public.link_pull_request(uuid,text,text,text,integer,uuid,uuid,text) is
  'Links a pull request to a task, creating the mirror as a placeholder and '
  'enqueueing a tracking refresh so the observer fills in title/state/head_sha. '
  'Supersedes 017_w2_entities_commands_tracking.sql:535.';

reset role;
