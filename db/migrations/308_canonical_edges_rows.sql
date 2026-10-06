-- =============================================================================
-- 308 — Canonical edges, part B: legacy rows move to the edge that says what
-- they mean (P0b, task 01a10c66). Decisions: doc 01a11262-6bae (child of the
-- inventory doc 01a111b8-74a1), from the owner's answers on form 01a111b8-e840
-- (response 01a11275-a57f, every recommendation taken).
--
--   Q1  created_in -> authored_from. authored_from accepts any source kind; the
--       server records it (public.record_authored_from on create and link-pr/
--       link-commit, and the commit recorder). Every created_in row is
--       rewritten in place (props, incl. origin=client_claim, kept); a row whose
--       source already has an authored_from is deleted (logged). created_in is
--       retired: it refuses new rows.
--   Q3a rule-classified outputs -> produces, inputs -> attached_to.
--   Q3b the 35 review rows: each row's suggestion, as listed (confirmed=owner).
--   Q3c one output may have several producing tasks.
--   Q6  the 16 follow-ups -> follows_up. Two of them are walked attached_to
--       rows; they move only if no story loses an entity (see below).
--   Q4  the story walk follows authored_from instead of created_in, except
--       from message and form sources (a session's messages never flood it).
--
--   THE REAL-DATA CHECK. Every live story's subgraph is snapshotted BEFORE any
--   change, with the walk as it stood; after the moves it is computed again.
--   If any entity left any story this migration ABORTS (one transaction), so
--   nothing changes. Additions (docs a relates_to row hid from the walk that
--   really are a task's input or output) are recorded per story in
--   internal.edge_migration_story_diff, as are walked rows kept ('kept').
--
--   Every move is in internal.edge_migration_log under batch 'p0b-308';
--   select internal.revert_edge_migration('p0b-308') undoes it.
--   Not here (part C, after #1056): deleting the relates_to session->teammate
--   duplicates and spawn's duplicate write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Before anything changes: every live story's subgraph, as walked today.
-- -----------------------------------------------------------------------------
create temp table p0b_308_before on commit drop as
  select s.id as story_id, t.entity_id, t.root_id
    from public.entities s
    cross join lateral internal.story_trail(s.id) t
   where s.kind = 'story' and s.deleted_at is null;

create table if not exists internal.edge_migration_story_diff (
  batch     text not null,
  story_id  uuid not null,
  entity_id uuid not null,
  root_id   uuid not null,
  change    text not null check (change in ('added', 'removed', 'kept')),
  at        timestamptz not null default now()
);
analyze internal.edge_migration_story_diff;

comment on table internal.edge_migration_story_diff is
  '308: per story, what a semantic edge migration added to (or, aborted, would '
  'have removed from) the story subgraph.';

-- The log's confirmed column also records rows decided by review.
alter table internal.edge_migration_log drop constraint if exists edge_migration_log_confirmed_check;
alter table internal.edge_migration_log add constraint edge_migration_log_confirmed_check
  check (confirmed in ('rule', 'reviewed', 'owner'));

-- -----------------------------------------------------------------------------
-- 1. authored_from: any entity made during a session; the server records it.
-- -----------------------------------------------------------------------------
update public.edge_types set src_kinds = array['*'] where type = 'authored_from';

CREATE OR REPLACE FUNCTION internal.guard_w1_edge()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  row_value public.edges;
  writer text := internal.w1_writer();
  src public.entities;
  dst public.entities;
  project_resource uuid;
  live_associations integer;
  session_state text;
begin
  if tg_op = 'DELETE' then row_value := old; else row_value := new; end if;
  select * into src from public.entities where id = row_value.src_id;
  select * into dst from public.entities where id = row_value.dst_id;

  -- A file->attached_to->message edge is message-owned even though attached_to
  -- remains generic for every other permitted endpoint pair.
  if row_value.type = 'attached_to' and src.kind = 'file' and dst.kind = 'message'
     and coalesce(writer, '') <> 'message_attachment' then
    raise exception 'message attachment edges are owned by message attachment commands'
      using errcode = '42501', detail = 'attachment_edge_owned';
  end if;

  -- 052 (a): `authored_from` is written by exactly one recorder per source
  -- kind — message_recorder (messages), memory_recorder (memories),
  -- artifact_publisher (artifacts), form_recorder (forms, 211). A per-type SET, not equalities, so
  -- the three recorders coexist in one branch that is declared once.
  --
  -- `in_worktree` is DELIBERATELY ABSENT from this recorder-owned list: it is
  -- an ordinarily mutable association (like `in_project`), correctable through
  -- generic edges.create/edges.delete. Putting it here would freeze filing
  -- errors into permanent facts. It appears only in the origin-stamping branch
  -- below, so a spawn-created association is distinguishable from a hand-drawn
  -- one without becoming immutable.
  if row_value.type in ('shared_into','authored_from','selected_profile','defaults_to_profile')
     and not (tg_op = 'DELETE' and coalesce(writer, '') = 'forward_compensation') then
    if (row_value.type = 'shared_into' and coalesce(writer, '') <> 'handoff_recorder')
       or (row_value.type = 'authored_from'
           and coalesce(writer, '') not in ('message_recorder','memory_recorder','artifact_publisher','form_recorder',
                                            -- 308: any entity made by a live session (entity_recorder), a commit the
                                            -- server observed in a session's worktree (commit_recorder), and P0b's
                                            -- logged legacy-row migration (edge_migration).
                                            'entity_recorder','commit_recorder','edge_migration'))
       or (row_value.type = 'selected_profile' and coalesce(writer, '') <> 'profile_pin')
       or (row_value.type = 'defaults_to_profile' and coalesce(writer, '') <> 'profile_default') then
      raise exception 'edge type % is recorder/configuration owned', row_value.type
        using errcode = '42501';
    end if;
  end if;

  -- 308: a logged edge migration (forward or revert) writes the row it logged,
  -- origin included, so a revert restores it exactly; it stamps nothing.
  if coalesce(writer, '') = 'edge_migration' then
    null;
  elsif tg_op = 'INSERT' then
    if new.props ? 'origin' and coalesce(writer, '') = '' then
      raise exception 'edge props.origin is Server-owned' using errcode = '42501';
    end if;
    -- 052 (b): `in_worktree` joins the stamping list (the worktrees lane's
    -- entire ask on this function). The registry row for `in_worktree` lands in
    -- the worktrees feature migration; until then this branch simply never
    -- matches that type.
    if new.type in ('in_project','participates_in','in_worktree',
                    'anchored_to','messaged') then
      new.props := new.props || jsonb_build_object('origin', coalesce(nullif(writer, ''), 'user'));
    -- 066: `created_in` defaults to 'client_claim', NOT 'user'. The CLI asserts
    -- it from TM8_SESSION_ID with no writer token, and nothing verifies the
    -- claim, so the tag must say so rather than implying a human drew it. When a
    -- server-side recorder eventually writes this (from a session-scoped token),
    -- its token lands here instead and the edge becomes self-describing.
    elsif new.type = 'created_in' then
      new.props := new.props || jsonb_build_object('origin', coalesce(nullif(writer, ''), 'client_claim'));
    -- 308: the two new authored_from recorders stamp their own name, so a row
    -- says which server path recorded it.
    elsif new.type = 'authored_from' and writer in ('entity_recorder','commit_recorder') then
      new.props := new.props || jsonb_build_object('origin', writer);
    elsif new.type in ('shared_into','authored_from','selected_profile','defaults_to_profile') then
      new.props := new.props || jsonb_build_object('origin', 'materialized');
    end if;
  elsif tg_op = 'UPDATE' then
    -- ⚠ KNOWN, DELIBERATE GAP (flagged, not fixed): this allowlist for
    -- CHANGING props.origin contains none of the three new tokens
    -- (memory_recorder, worktree_manager, artifact_publisher). Harmless today —
    -- all three features write their edges once and never update them — but any
    -- future correction/compensation path that rewrites an existing edge's
    -- origin under a new token will fail 42501 until its token is added here.
    -- That addition is a policy decision for the feature that needs it, not a
    -- side effect of this migration.
    if new.props -> 'origin' is distinct from old.props -> 'origin'
       and coalesce(writer, '') not in ('project_correction','handoff_recorder','message_recorder','profile_pin','profile_default') then
      raise exception 'edge props.origin is Server-owned' using errcode = '42501';
    end if;
  end if;

  -- PR/commit materialized associations are repair-command owned.  Task and
  -- work_session user/backfill associations remain ordinarily mutable.
  if tg_op in ('UPDATE','DELETE') and old.type = 'in_project'
     and src.kind in ('pull_request','commit') and old.props ->> 'origin' = 'materialized'
     and coalesce(writer, '') not in ('project_correction','forward_compensation') then
    raise exception 'materialized Project association requires correction command'
      using errcode = '42501';
  end if;

  -- Removing a participant serializes on the session and every participant edge.
  if tg_op in ('UPDATE','DELETE') and old.type = 'participates_in'
     and (tg_op = 'DELETE' or new.type <> old.type or new.dst_id <> old.dst_id) then
    perform 1 from public.work_sessions where entity_id = old.dst_id for update;
    perform 1 from public.edges
      where type = 'participates_in' and dst_id = old.dst_id
      order by id for update;
    select status into session_state from public.work_sessions where entity_id = old.dst_id;
    if session_state in ('spawning','running','idle')
       and (select count(*) from public.edges
             where type = 'participates_in' and dst_id = old.dst_id) <= 1 then
      raise exception 'a live work session must retain one participant'
        using errcode = '23514';
    end if;
  end if;

  if tg_op in ('INSERT','UPDATE') and new.type = 'in_project'
     and (tg_op = 'INSERT' or new.src_id <> old.src_id or new.dst_id <> old.dst_id
          or new.type <> old.type) then
    select project_id into project_resource
      from public.project_projection_details where entity_id = new.dst_id;
    if project_resource is null then
      raise exception 'Project projection has no resource mapping'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
    perform 1 from public.projects where id = project_resource for update;
    perform 1 from public.spaces where id = new.space_id for update;
    if not exists (select 1 from public.space_projects
                    where space_id = new.space_id and project_id = project_resource)
       or dst.deleted_at is not null
       or not exists (select 1 from public.project_links
                       where space_id = new.space_id and project_id = project_resource
                         and project_entity_id = new.dst_id) then
      raise exception 'Project is not actively linked to this Space'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
    if src.kind = 'work_session' and src.deleted_at is null then
      select count(*) into live_associations
        from public.edges edge
        join public.entities projection on projection.id = edge.dst_id
       where edge.src_id = new.src_id and edge.type = 'in_project'
         and projection.deleted_at is null and edge.id is distinct from new.id;
      if live_associations >= 16 then
        raise exception 'work session Project association cap reached'
          using errcode = '53400', detail = 'project_association_cap';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$
;

-- Revert, as the edge_migration writer (so recorder-owned types and
-- props.origin come back exactly as logged), optionally for one edge only.
drop function if exists internal.revert_edge_migration(text);
create or replace function internal.revert_edge_migration(p_batch text, p_edge_id uuid default null)
returns integer
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  r internal.edge_migration_log;
  n integer := 0;
begin
  perform set_config('tm8.edge_migration', p_batch, true);
  perform internal.w1_set_writer('edge_migration');
  for r in select * from internal.edge_migration_log
            where batch = p_batch and reverted_at is null
              and (p_edge_id is null or edge_id = p_edge_id)
            order by id desc
  loop
    if r.action = 'insert' then
      delete from public.edges where id = r.edge_id;
    elsif r.action = 'delete' then
      insert into public.edges
        select * from jsonb_populate_record(null::public.edges, r.old_row)
      on conflict (id) do nothing;
    else
      update public.edges e
         set type = o.type, src_id = o.src_id, dst_id = o.dst_id, props = o.props
        from jsonb_populate_record(null::public.edges, r.old_row) o
       where e.id = r.edge_id;
    end if;
    update internal.edge_migration_log set reverted_at = now() where id = r.id;
    n := n + 1;
  end loop;
  perform internal.w1_set_writer(null);
  return n;
end
$$;
revoke all on function internal.revert_edge_migration(text, uuid) from public;

CREATE OR REPLACE FUNCTION internal.migrate_edge(p_batch text, p_rule text, p_edge_id uuid, p_type text, p_src_id uuid, p_dst_id uuid, p_confirmed text DEFAULT 'rule'::text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  old_e public.edges;
  new_e public.edges;
begin
  if coalesce(p_batch, '') = '' or coalesce(p_rule, '') = '' then
    raise exception 'migrate_edge needs a batch and a rule' using errcode = '22023';
  end if;
  select * into old_e from public.edges where id = p_edge_id for update;
  if not found then
    return 'missing';
  end if;
  perform set_config('tm8.edge_migration', p_batch, true);
  -- 308: recorder-owned types (authored_from) accept this writer only.
  perform internal.w1_set_writer('edge_migration');

  if p_type is null
     or exists (select 1 from public.edges
                 where src_id = p_src_id and dst_id = p_dst_id and type = p_type
                   and id <> p_edge_id) then
    delete from public.edges where id = p_edge_id;
    insert into internal.edge_migration_log(batch, rule, action, edge_id, old_row, new_row, confirmed)
    values (p_batch, p_rule, 'delete', p_edge_id, to_jsonb(old_e), null, p_confirmed);
    perform internal.w1_set_writer(null);
    return case when p_type is null then 'deleted' else 'merged' end;
  end if;

  update public.edges
     set type = p_type, src_id = p_src_id, dst_id = p_dst_id, updated_at = now()
   where id = p_edge_id
  returning * into new_e;
  insert into internal.edge_migration_log(batch, rule, action, edge_id, old_row, new_row, confirmed)
  values (p_batch, p_rule, 'rewrite', p_edge_id, to_jsonb(old_e), to_jsonb(new_e), p_confirmed);
  perform internal.w1_set_writer(null);
  return 'rewritten';
end
$function$
;

-- The server's one door for "this entity was made during this session". It is
-- called by the facade with the CALLER's verified work session (bearer token),
-- and records only when that session is live, in the entity's space, and its
-- participating teammate is the entity's creator. One row per source;
-- messages and forms keep their own recorders.
create or replace function public.record_authored_from(p_entity_id uuid, p_work_session_id uuid)
returns uuid
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  edge_row_id uuid;
begin
  select * into e from public.entities where id = p_entity_id and deleted_at is null;
  if e.id is null or e.kind in ('message', 'form', 'work_session') then
    return null;
  end if;
  select id into edge_row_id from public.edges where src_id = p_entity_id and type = 'authored_from';
  if edge_row_id is not null then
    return edge_row_id;
  end if;
  if not exists (
    select 1
      from public.entities s
      join public.work_sessions ws on ws.entity_id = s.id
      join public.edges p on p.dst_id = s.id and p.type = 'participates_in'
     where s.id = p_work_session_id and s.kind = 'work_session' and s.deleted_at is null
       and s.space_id = e.space_id
       and ws.status in ('spawning', 'running', 'idle')
       and p.src_id = e.created_by) then
    return null;
  end if;
  perform internal.w1_set_writer('entity_recorder');
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (e.space_id, p_entity_id, p_work_session_id, 'authored_from', e.created_by)
  on conflict do nothing
  returning id into edge_row_id;
  perform internal.w1_set_writer(null);
  return edge_row_id;
end
$$;
revoke all on function public.record_authored_from(uuid, uuid) from public;
grant execute on function public.record_authored_from(uuid, uuid) to tm8_app;

CREATE OR REPLACE FUNCTION public.record_session_commit(p_work_session_id uuid, p_repo text, p_sha text, p_message text DEFAULT NULL::text, p_author text DEFAULT NULL::text, p_committed_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_provider text DEFAULT 'github'::text, p_actor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  session_entity public.entities;
  actor uuid;
  artifact_id uuid;
  edge_id uuid;
  created boolean := false;
  normalized_sha text := lower(p_sha);
begin
  perform internal.require_identity();
  select * into session_entity from public.entities
   where id = p_work_session_id and kind = 'work_session' and deleted_at is null;
  if not found then
    raise exception 'no live work session %', p_work_session_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(session_entity.space_id);
  actor := internal.resolve_actor(p_actor_id, session_entity.space_id);
  perform internal.bind_actor(actor);
  if nullif(btrim(p_repo), '') is null or normalized_sha !~ '^[a-f0-9]{7,64}$' then
    raise exception 'invalid commit reference' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    session_entity.space_id::text || ':commit:' || lower(p_provider) || ':' || lower(p_repo) || ':' || normalized_sha, 0));

  select entity_id into artifact_id from public.commits
   where space_id = session_entity.space_id and provider = lower(p_provider)
     and repo = p_repo and sha = normalized_sha for update;
  if artifact_id is null then
    artifact_id := internal.create_envelope(session_entity.space_id, 'commit', actor, null, null);
    insert into public.commits(entity_id, space_id, provider, repo, sha, message, author, committed_at)
    values (artifact_id, session_entity.space_id, lower(p_provider), p_repo, normalized_sha,
            coalesce(p_message, normalized_sha), p_author, p_committed_at);
    perform internal.record_initial_version(artifact_id, actor);
    created := true;
  else
    -- The same "NULL means the caller did not learn it" contract as
    -- apply_commit_facts: refresh only what was observed.
    update public.commits
       set message      = coalesce(p_message, message),
           author       = coalesce(p_author, author),
           committed_at = coalesce(p_committed_at, committed_at),
           updated_at   = now()
     where entity_id = artifact_id;
  end if;

  -- 308: the canonical "made during a session" edge is authored_from,
  -- recorded by the server (this job observes the session's own worktree),
  -- origin stamped 'commit_recorder' by the guard. One per source.
  if not exists (select 1 from public.edges where src_id = artifact_id and type = 'authored_from') then
    perform internal.w1_set_writer('commit_recorder');
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (session_entity.space_id, artifact_id, p_work_session_id, 'authored_from', actor)
    on conflict do nothing;
    perform internal.w1_set_writer(null);
  end if;
  select id into edge_id from public.edges
   where src_id = artifact_id and type = 'authored_from';

  return jsonb_build_object(
    'commitEntityId', artifact_id, 'created', created,
    'edgeId', edge_id, 'workSessionId', p_work_session_id);
end
$function$
;

CREATE OR REPLACE FUNCTION internal.pr_owning_session(p_pr_entity_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
  with pr as (
    select * from public.pull_requests where entity_id = p_pr_entity_id
  ), candidates as (
    select e.dst_id as session_id, 1 as confidence, pr.space_id
      from pr
      join public.edges e
        on e.src_id = p_pr_entity_id and e.type = 'authored_from'
    union all
    select e.dst_id, 2, pr.space_id
      from pr
      join public.commits c
        on c.space_id = pr.space_id and c.repo = pr.repo and c.sha = lower(pr.head_sha)
      join public.edges e on e.src_id = c.entity_id and e.type = 'authored_from'
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
$function$
;

CREATE OR REPLACE FUNCTION internal.w2_task_conversation_sessions(p_task_id uuid, p_batch_message_ids uuid[])
 RETURNS TABLE(work_session_id uuid)
 LANGUAGE sql
 STABLE
AS $function$
  -- WORKING: `working_on` names the PROCESS that is on the task (111, 121).
  select work.src_id
    from public.edges work
   where work.dst_id = p_task_id and work.type = 'working_on'
  union
  -- OPENED: `authored_from` (308; was created_in) names the session that
  -- created the task -- the coordinator. Direction is task -> session.
  select opened.dst_id
    from public.edges opened
    join public.entities s on s.id = opened.dst_id and s.kind = 'work_session'
   where opened.src_id = p_task_id and opened.type = 'authored_from'
  union
  -- SPOKEN: any session that has already posted on this task is in the
  -- conversation, whether or not anything ever put it on the task.
  select authored.dst_id
    from public.messages prior
    join public.edges authored
      on authored.src_id = prior.entity_id and authored.type = 'authored_from'
   where prior.anchor_id = p_task_id
     and not (prior.entity_id = any(coalesce(p_batch_message_ids, '{}'::uuid[])))
$function$
;

-- -----------------------------------------------------------------------------
-- 2. The story walk follows authored_from (not created_in), never from a
--    message or form source.
-- -----------------------------------------------------------------------------
create or replace function internal.story_followed_edge_types()
returns text[]
language sql immutable set search_path = public, internal, pg_temp as $$
  -- Followed in BOTH directions from a root, to depth 3 (283 D1). Hierarchy
  -- (parent -> child) is walked separately. authored_from is followed except
  -- from a message or form (internal.story_walk_skips). Not followed, on
  -- purpose: relates_to (see-also), depends_on (drawn, not walked),
  -- participates_in, follows_up (owner decision Q5), reactions and access.
  -- MIRROR: STORY_FOLLOWED_EDGE_TYPES in packages/contract/src/story.ts
  -- (canonical-edges.pg.test.ts asserts they agree).
  select array['attached_to', 'tracks', 'working_on', 'about', 'authored_from',
               'assigned_to', 'has_member', 'produces', 'remembers']::text[]
$$;

create or replace function internal.story_walk_skips(p_type text, p_src_id uuid)
returns boolean
language sql stable set search_path = public, internal, pg_temp as $$
  -- A session's messages and forms are authored_from it too; walking them
  -- would pull every message into the story and spend the 500-row budget.
  select p_type = 'authored_from'
     and exists (select 1 from public.entities m
                  where m.id = p_src_id and m.kind in ('message', 'form'))
$$;
revoke all on function internal.story_walk_skips(text, uuid) from public;
grant execute on function internal.story_walk_skips(text, uuid) to tm8_app, tm8_graph_owner;

CREATE OR REPLACE FUNCTION internal.story_trail(p_story_id uuid)
 RETURNS TABLE(entity_id uuid, root_id uuid, depth integer, via_id uuid, edge_type text, edge_id uuid, direction text, root_position double precision)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  -- 303: one list, shared with stories_containing and mirrored by
  -- STORY_FOLLOWED_EDGE_TYPES in packages/contract/src/story.ts.
  followed constant text[] := internal.story_followed_edge_types();
  -- D1b: a row of one of these kinds is a LEAF — reached, never walked out of.
  leaf_kinds constant text[] := array['team_member', 'member', 'project', 'interaction_profile',
                                      'skill', 'story'];
  max_depth constant integer := 3;
  budget integer := 500;
  a_ids uuid[]; a_roots uuid[]; a_depth integer[]; a_via uuid[];
  a_type text[]; a_edge uuid[]; a_dir text[]; a_pos double precision[];
  f_ids uuid[]; f_roots uuid[];
  n_ids uuid[]; n_roots uuid[]; n_via uuid[]; n_type text[]; n_edge uuid[]; n_dir text[];
  lvl integer;
begin
  -- 303: a deleted story contains nothing. Soft delete leaves its `contains`
  -- edges in place (restore must be lossless), so every reader filters here.
  if exists (select 1 from public.entities s where s.id = p_story_id and s.deleted_at is not null) then
    return;
  end if;
  -- Roots: the live `contains` targets, ordered by the edge's position.
  select coalesce(array_agg(r.dst_id order by r.pos nulls last, r.dst_id), '{}'),
         coalesce(array_agg(r.edge_id order by r.pos nulls last, r.dst_id), '{}'),
         coalesce(array_agg(r.pos order by r.pos nulls last, r.dst_id), '{}')
    into a_ids, a_edge, a_pos
    from (
      select c.dst_id, c.id as edge_id,
             case when jsonb_typeof(c.props -> 'position') = 'number'
                  then (c.props ->> 'position')::double precision end as pos
        from public.edges c
        join public.entities re on re.id = c.dst_id and re.deleted_at is null
       where c.src_id = p_story_id and c.type = 'contains' and c.dst_id <> p_story_id
       order by pos nulls last, c.dst_id
       limit budget
    ) r;
  a_roots := a_ids;
  a_depth := array_fill(0, array[cardinality(a_ids)]);
  a_via := array_fill(p_story_id, array[cardinality(a_ids)]);
  a_type := array_fill('contains'::text, array[cardinality(a_ids)]);
  a_dir := array_fill('out'::text, array[cardinality(a_ids)]);
  budget := budget - cardinality(a_ids);
  f_ids := a_ids; f_roots := a_roots;

  lvl := 1;
  while lvl <= max_depth and budget > 0 and cardinality(f_ids) > 0 loop
    select coalesce(array_agg(s.id), '{}'), coalesce(array_agg(s.root), '{}'), coalesce(array_agg(s.via), '{}'),
           coalesce(array_agg(s.etype), '{}'), coalesce(array_agg(s.eid), '{}'), coalesce(array_agg(s.dir), '{}')
      into n_ids, n_roots, n_via, n_type, n_edge, n_dir
      from (
        select distinct on (nb.id, f.root) nb.id, f.root, f.via, nb.etype, nb.eid, nb.dir
          from unnest(f_ids, f_roots) as f(via, root)
          join public.entities fe on fe.id = f.via and not (fe.kind = any(leaf_kinds))
          cross join lateral (
            select ch.id, 'parent'::text as etype, null::uuid as eid, 'out'::text as dir
              from public.entities ch
             where ch.parent_id = f.via and ch.deleted_at is null
            union all
            select g.dst_id, g.type, g.id, 'out'
              from public.edges g where g.src_id = f.via and g.type = any(followed)
               and not internal.story_walk_skips(g.type, g.src_id)
            union all
            select g.src_id, g.type, g.id, 'in'
              from public.edges g where g.dst_id = f.via and g.type = any(followed)
               and not internal.story_walk_skips(g.type, g.src_id)
          ) nb
          join public.entities ne on ne.id = nb.id and ne.deleted_at is null
         where nb.id <> p_story_id
           and not exists (
             select 1 from unnest(a_ids, a_roots) as v(id, root)
              where v.id = nb.id and v.root = f.root)
         order by nb.id, f.root, nb.etype, nb.eid
         limit budget
      ) s;
    exit when cardinality(n_ids) = 0;
    a_ids := a_ids || n_ids; a_roots := a_roots || n_roots; a_via := a_via || n_via;
    a_type := a_type || n_type; a_edge := a_edge || n_edge; a_dir := a_dir || n_dir;
    a_depth := a_depth || array_fill(lvl, array[cardinality(n_ids)]);
    budget := budget - cardinality(n_ids);
    f_ids := n_ids; f_roots := n_roots;
    lvl := lvl + 1;
  end loop;

  return query
    select t.id, t.root, t.d, t.via, t.etype, t.eid, t.dir, rp.pos
      from unnest(a_ids, a_roots, a_depth, a_via, a_type, a_edge, a_dir)
             as t(id, root, d, via, etype, eid, dir)
      left join unnest(a_ids[1:cardinality(a_pos)], a_pos) as rp(id, pos) on rp.id = t.root;
end
$function$
;

CREATE OR REPLACE FUNCTION public.stories_containing(p_entity_id uuid)
 RETURNS TABLE(story_id uuid, root_id uuid, depth integer)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  -- 303: one list, shared with stories_containing and mirrored by
  -- STORY_FOLLOWED_EDGE_TYPES in packages/contract/src/story.ts.
  followed constant text[] := internal.story_followed_edge_types();
  -- D1b in reverse: an intermediate row of a leaf kind is never walked
  -- through (the forward walk could not have left it). The start may be one.
  leaf_kinds constant text[] := array['team_member', 'member', 'project', 'interaction_profile',
                                      'skill', 'story'];
  budget integer := 500;
  a_ids uuid[] := array[p_entity_id];
  a_depth integer[] := array[0];
  f_ids uuid[] := array[p_entity_id];
  n_ids uuid[];
  lvl integer := 1;
begin
  while lvl <= 3 and budget > 0 and cardinality(f_ids) > 0 loop
    select coalesce(array_agg(s.id), '{}') into n_ids
      from (
        select distinct nb.id
          from unnest(f_ids) as f(id)
          join public.entities fe on fe.id = f.id and (lvl = 1 or not (fe.kind = any(leaf_kinds)))
          cross join lateral (
            select p.parent_id as id from public.entities p
             where p.id = f.id and p.parent_id is not null
            union all
            select g.src_id from public.edges g where g.dst_id = f.id and g.type = any(followed)
               and not internal.story_walk_skips(g.type, g.src_id)
            union all
            select g.dst_id from public.edges g where g.src_id = f.id and g.type = any(followed)
               and not internal.story_walk_skips(g.type, g.src_id)
          ) nb
          join public.entities ne on ne.id = nb.id and ne.deleted_at is null
         where not (nb.id = any(a_ids))
         limit budget
      ) s;
    exit when cardinality(n_ids) = 0;
    a_ids := a_ids || n_ids;
    a_depth := a_depth || array_fill(lvl, array[cardinality(n_ids)]);
    budget := budget - cardinality(n_ids);
    f_ids := n_ids;
    lvl := lvl + 1;
  end loop;

  return query
    select c.src_id, c.dst_id, min(r.d)::integer
      from unnest(a_ids, a_depth) as r(id, d)
      join public.edges c on c.dst_id = r.id and c.type = 'contains'
      join public.entities st on st.id = c.src_id and st.kind = 'story' and st.deleted_at is null
     group by c.src_id, c.dst_id
     order by min(r.d), c.src_id;
end
$function$
;

-- -----------------------------------------------------------------------------
-- 3. The rows. Q1 for every created_in row in the database; Q3/Q6 for the
--    reviewed list (edge ids from this node's tm8 space; a row that is gone or
--    no longer the type it was when reviewed is left alone).
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
  batch constant text := 'p0b-308';
  done integer := 0;
begin
  for r in select e.id, e.src_id, e.dst_id from public.edges e where e.type = 'created_in' order by e.id loop
    if exists (select 1 from public.edges a where a.src_id = r.src_id and a.type = 'authored_from') then
      perform internal.migrate_edge(batch, 'Q1 superseded by a recorded authored_from', r.id, null, null, null);
    else
      perform internal.migrate_edge(batch, 'Q1 made during a session', r.id, 'authored_from', r.src_id, r.dst_id);
    end if;
    done := done + 1;
  end loop;
  raise notice '308: % created_in rows moved', done;

  done := 0;
  for r in
    select v.* from (values
    ('01a108cd-5741-7a1b-8bfe-21e3931e40de'::uuid, 'attached_to', 'Q3c several producers: each claiming task produced it', 'produces', '01a108a0-53c0-7b6e-a9aa-d4eadc047a34'::uuid, '01a108cc-6b63-7de2-b3d5-d7a8d65126b4'::uuid, 'owner'),
    ('01a108cd-48ed-7d01-8702-ed4b604e8ae2'::uuid, 'attached_to', 'Q3c several producers: each claiming task produced it', 'produces', '01a1087f-9de2-7abb-ab84-c01dd6bee6e9'::uuid, '01a108cc-6b63-7de2-b3d5-d7a8d65126b4'::uuid, 'owner'),
    ('01a108b9-77fc-72d3-af10-a89968b19942'::uuid, 'attached_to', 'Q3c several producers: each claiming task produced it', 'produces', '01a108a0-53c0-7b6e-a9aa-d4eadc047a34'::uuid, '01a108b8-f8b2-7cd6-8877-7ead54dc9b41'::uuid, 'owner'),
    ('01a108b9-74a9-73f4-a6d5-34faa1804930'::uuid, 'attached_to', 'Q3c several producers: each claiming task produced it', 'produces', '01a1087f-9de2-7abb-ab84-c01dd6bee6e9'::uuid, '01a108b8-f8b2-7cd6-8877-7ead54dc9b41'::uuid, 'owner'),
    ('01a1124a-8f4e-7e05-b9f9-86cb7a8a154f'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1123d-17ec-785f-a1a6-3c6c9c835d13'::uuid, '01a1124a-8f26-7723-bd74-aa65505dacdd'::uuid, 'rule'),
    ('01a111fa-47c0-70b3-9db1-c1eaf3658256'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10c66-1529-7326-9360-3570c87b4c73'::uuid, '01a111fa-1f8a-7f92-b4c3-daf6ed1bf170'::uuid, 'rule'),
    ('01a111ba-3185-7125-9b74-46fdab533f97'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a111b4-a94b-76a4-b587-2274497fa9a6'::uuid, '01a111ba-3178-71ae-8a3c-5c16e245f595'::uuid, 'rule'),
    ('01a10c5d-25b9-7076-a13e-c93192e3c42a'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10c0f-b61e-774b-920f-79f35528f0ef'::uuid, '01a10c5d-259f-76c5-a220-b39d43a66b21'::uuid, 'rule'),
    ('01a10b65-653f-79c9-9b36-1b87dd7f103d'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10b47-ce50-7277-85ff-0a2a07a1575e'::uuid, '01a10b65-6523-73eb-a9af-be389bdc6700'::uuid, 'rule'),
    ('01a10b57-5d72-723e-92b2-cc694df799f3'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10b47-ce50-7277-85ff-0a2a07a1575e'::uuid, '01a10b57-5d60-7d39-b700-d8dabd98ab37'::uuid, 'rule'),
    ('01a10b4f-84fd-7435-9f62-9c935ef9d82c'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10b1d-8a05-7640-9638-1b27ee876834'::uuid, '01a10b4f-84e8-7052-8c70-785be900ae26'::uuid, 'rule'),
    ('01a10b4f-82f1-7e84-924e-4cc77f4bd0a7'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10b1d-8a05-7640-9638-1b27ee876834'::uuid, '01a10b4f-82dc-7fbe-89a5-4a6289938ae1'::uuid, 'rule'),
    ('01a10b4d-9552-7e0f-881f-dac26289dc3d'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10b47-ce50-7277-85ff-0a2a07a1575e'::uuid, '01a10b4d-953a-7df0-a497-f140d80233ee'::uuid, 'rule'),
    ('01a10956-e8e7-74a2-8d4b-3ecba6baff78'::uuid, 'attached_to', 'D3a: the output names its task id', 'produces', '01a10907-ee46-7fb0-82f2-359b6df1b559'::uuid, '01a10956-e8d4-7588-a861-32c83e3f8a9f'::uuid, 'owner'),
    ('01a10956-e5b4-73a2-be9d-fe91fd3e1e2f'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a108cd-a4c4-73e6-a8f6-7097fbefe291'::uuid, '01a108ed-2f4c-75de-a196-e9616f92c2d5'::uuid, 'rule'),
    ('01a10956-dd4b-7017-b4f7-9a9edd6b7c95'::uuid, 'attached_to', 'D3a: the output names its task id', 'produces', '01a10907-ee46-7fb0-82f2-359b6df1b559'::uuid, '01a10937-b466-7b3d-a089-1668f673146e'::uuid, 'owner'),
    ('01a10956-d6d3-737d-9ff7-b1dece5c2c8d'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10900-4a49-7bf7-ba47-8f84072163a9'::uuid, '01a1090e-7ff7-7f6f-8e45-2249f6e4eaee'::uuid, 'rule'),
    ('01a10938-15b8-7b0a-b5fc-f93eb926877f'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10907-ee46-7fb0-82f2-359b6df1b559'::uuid, '01a10938-15ab-7fc9-939e-3a33453502d3'::uuid, 'rule'),
    ('01a10938-0360-768c-adec-523f57ba245d'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10907-ee46-7fb0-82f2-359b6df1b559'::uuid, '01a10938-035d-758a-9fad-bddc31a597a5'::uuid, 'rule'),
    ('01a10938-0025-7515-9877-081886b1e31a'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10907-ee46-7fb0-82f2-359b6df1b559'::uuid, '01a10938-0020-7346-89c2-c1860685dd9d'::uuid, 'rule'),
    ('01a10937-fcaa-78cd-bd10-60a14192fc0c'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10907-ee46-7fb0-82f2-359b6df1b559'::uuid, '01a10937-fc9e-7f2a-852c-2c7661e48508'::uuid, 'rule'),
    ('01a10937-f784-798c-8c9d-b5831d3db9b5'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10907-ee46-7fb0-82f2-359b6df1b559'::uuid, '01a10937-f774-7571-976f-75a35022770c'::uuid, 'rule'),
    ('01a10937-f392-7f06-8732-29ffe4de39ae'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10907-ee46-7fb0-82f2-359b6df1b559'::uuid, '01a10937-f38d-7314-b76c-75b1ec2f1c51'::uuid, 'rule'),
    ('01a10937-ef9d-7485-b7e8-cd04e3f6ebb9'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10907-ee46-7fb0-82f2-359b6df1b559'::uuid, '01a10937-ef92-71b8-aa0c-567e5b25a55c'::uuid, 'rule'),
    ('01a10937-ec0c-7b55-acda-8b8d241976cc'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10907-ee46-7fb0-82f2-359b6df1b559'::uuid, '01a10937-ec08-766e-bf3c-7830b09f46cd'::uuid, 'rule'),
    ('01a10937-e85d-7e73-a09d-5aa111481cd3'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10907-ee46-7fb0-82f2-359b6df1b559'::uuid, '01a10937-e84e-7eb5-ac0f-7a16521fc853'::uuid, 'rule'),
    ('01a108ec-70e9-7c5e-a489-9bcd748d9809'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a108cd-a4c4-73e6-a8f6-7097fbefe291'::uuid, '01a108ec-70e4-7a7a-81b3-ddd28f04fb4f'::uuid, 'rule'),
    ('01a108ec-6cd9-74f5-9e82-130dc65c2b95'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a108cd-a4c4-73e6-a8f6-7097fbefe291'::uuid, '01a108ec-6ccf-7efa-a2c8-15f1025709ff'::uuid, 'rule'),
    ('01a108df-4515-791d-b5c0-27ea09192f19'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a108cd-a4c4-73e6-a8f6-7097fbefe291'::uuid, '01a108df-44fb-7b21-b0f9-0a2870e19af9'::uuid, 'rule'),
    ('01a108cd-3bd7-7f44-985e-3cd2e2dc5a11'::uuid, 'attached_to', 'D3b: release evidence of the release task (one producer)', 'produces', '01a108aa-9c82-7f1f-9a34-7959d189c3b6'::uuid, '01a108cc-6b63-7de2-b3d5-d7a8d65126b4'::uuid, 'owner'),
    ('01a108b9-7246-7371-8ea3-2dcb3293a916'::uuid, 'attached_to', 'D3b: release evidence of the release task (one producer)', 'produces', '01a108aa-9c82-7f1f-9a34-7959d189c3b6'::uuid, '01a108b8-f8b2-7cd6-8877-7ead54dc9b41'::uuid, 'owner'),
    ('01a108b0-4739-7f45-bd35-bcaefb4638e4'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a108a0-53c0-7b6e-a9aa-d4eadc047a34'::uuid, '01a108af-3748-72fd-8806-d40e1d75de2c'::uuid, 'rule'),
    ('01a108a9-a9cb-7d32-a4bf-849f59a7d49b'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1087f-9de2-7abb-ab84-c01dd6bee6e9'::uuid, '01a108a9-a9c7-7b5c-b56a-e3521f60efec'::uuid, 'rule'),
    ('01a108a9-a644-730d-a393-590da947059e'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1087f-9de2-7abb-ab84-c01dd6bee6e9'::uuid, '01a108a9-a63e-7fe4-b8a9-84405033f839'::uuid, 'rule'),
    ('01a108a5-8465-7aa6-ac6e-d0144c0cf248'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1087f-9de2-7abb-ab84-c01dd6bee6e9'::uuid, '01a108a5-845e-78d7-910c-be2de254ef3b'::uuid, 'rule'),
    ('01a108a5-78a7-7910-9dff-566ce0e81589'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1087f-9de2-7abb-ab84-c01dd6bee6e9'::uuid, '01a108a5-789c-7bf0-a8b8-e87372eb0f2b'::uuid, 'rule'),
    ('01a108a2-0092-7908-aebe-ee0363a9db35'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1087f-9de2-7abb-ab84-c01dd6bee6e9'::uuid, '01a108a2-008c-7a06-aa87-7bb8052e5728'::uuid, 'rule'),
    ('01a108a1-fba5-72b1-858e-b13a4da9355b'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1087f-9de2-7abb-ab84-c01dd6bee6e9'::uuid, '01a108a1-fb9e-740b-a636-f1df050e2682'::uuid, 'rule'),
    ('01a1089c-771f-7572-8232-8828762390ca'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1087f-9de2-7abb-ab84-c01dd6bee6e9'::uuid, '01a1089c-7700-7463-b741-7eebe80b20f2'::uuid, 'rule'),
    ('01a1089c-4cc0-7871-a29c-94e6cb805dce'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1087f-9de2-7abb-ab84-c01dd6bee6e9'::uuid, '01a1089c-4cba-7f63-ae4b-abb5b8bdb0bf'::uuid, 'rule'),
    ('01a10891-65d7-731d-b8f1-c182a4668e24'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1087f-9de2-7abb-ab84-c01dd6bee6e9'::uuid, '01a10891-65d1-75ac-a417-637e0ca75f07'::uuid, 'rule'),
    ('01a10889-579a-7563-a753-8142d376c955'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10877-c5b6-774a-a29e-04051e8f75ae'::uuid, '01a10888-fde4-76f4-8881-81bded142fcf'::uuid, 'rule'),
    ('01a10888-e10e-7cc2-83e0-33a789142dd1'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10885-4c75-7cc2-9eb8-6c2a5b28aee0'::uuid, '01a10888-e0fd-7ed9-8d4e-6d7088420467'::uuid, 'rule'),
    ('01a10887-8b7f-7c97-8e86-1a7cd3e45650'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10885-4ef3-76fa-986a-371a292ba00d'::uuid, '01a10887-8b73-7bcc-af8e-c28e69f30424'::uuid, 'rule'),
    ('01a10885-1799-7b1c-95ee-8ab45a666940'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10880-59b9-7d72-b519-e4ad4feaa671'::uuid, '01a10885-178b-76f2-aa5f-c599faa94572'::uuid, 'rule'),
    ('01a1087f-9e02-7dec-ad7f-1ee22f8631da'::uuid, 'attached_to', 'R4/R5 input', 'attached_to', '01a107f1-5ef1-7af2-a6b2-acb2c2de8e83'::uuid, '01a1087f-9de2-7abb-ab84-c01dd6bee6e9'::uuid, 'rule'),
    ('01a10877-8f11-71e6-b724-b82968c4259a'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a107e7-8886-7ebd-b1fc-8f21c6578458'::uuid, '01a10877-8efc-764d-a557-6442825b6b81'::uuid, 'rule'),
    ('01a10877-8bb7-7067-84d5-000b60cc22eb'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a107e7-8886-7ebd-b1fc-8f21c6578458'::uuid, '01a10877-8bb3-7f43-95c3-9078756f515b'::uuid, 'rule'),
    ('01a10877-8781-79ae-85d9-d595fcdf84ef'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a107e7-8886-7ebd-b1fc-8f21c6578458'::uuid, '01a10877-8774-71bf-ab85-2aa508a193f4'::uuid, 'rule'),
    ('01a107f2-1c99-72ee-8de9-881004a0aafc'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a107e7-8886-7ebd-b1fc-8f21c6578458'::uuid, '01a107f1-5ef1-7af2-a6b2-acb2c2de8e83'::uuid, 'rule'),
    ('01a10630-0242-7264-8cd8-1322c712d073'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10629-787a-7d7d-b37e-ef79cb134ade'::uuid, '01a10630-0225-74af-9fbc-68e96a8b19db'::uuid, 'rule'),
    ('01a1062b-c01f-7d27-993f-24885785195b'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10624-bf3c-7796-9c35-eb172fd20000'::uuid, '01a1062b-bff7-7a8d-b69e-e60d7c45aecd'::uuid, 'rule'),
    ('01a10585-ae2a-76fe-86a7-73f0bd0df4ce'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a10570-1e6b-7dee-9634-d9964c34ee62'::uuid, '01a10585-ae14-78d2-9b88-774686e1cfbb'::uuid, 'rule'),
    ('01a1056f-f433-7d26-9f1c-8c9f43510c5a'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a0fe7a-f07a-72c9-bb6a-d9b0c0f93e02'::uuid, '01a1056f-f412-7788-ad17-ddc6b853d8fe'::uuid, 'rule'),
    ('01a1056f-f426-7df5-90fc-e6bc582b3c5b'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a0fe7a-f6e4-7d71-b42c-12e19926ef3f'::uuid, '01a1056f-f412-7788-ad17-ddc6b853d8fe'::uuid, 'rule'),
    ('01a103cf-c08e-7589-924e-23d963d9afdf'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a0fec0-bd84-744a-b413-18ec852f99e2'::uuid, '01a103cf-c077-782b-99d7-8873c3304a7b'::uuid, 'rule'),
    ('01a103c7-e0be-78b5-9f91-fef5fff1250b'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a103b2-7e55-7fab-8d29-b3d8bef41ca3'::uuid, '01a103c7-e0b5-7475-bb76-9706197360e1'::uuid, 'rule'),
    ('01a1039b-6b26-7192-b62d-282135661ee9'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a0ff51-3637-75f5-88ed-0a3500745f0d'::uuid, '01a1039b-6b1b-7a82-84b5-31c5f0d475bb'::uuid, 'rule'),
    ('01a1033a-4c5f-709c-b1a3-3e81efcb84e7'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a102d6-3943-7be7-9668-648fe9e15962'::uuid, '01a1033a-4c36-7060-818d-0da6fe9d0912'::uuid, 'rule'),
    ('01a10339-7367-7f39-9ea5-d6ba8b21a7c7'::uuid, 'attached_to', 'D3c: the lane''s own audit, authored by the teammate who filed it', 'produces', '01a1031c-e129-7556-ae09-c5e7057d7dd8'::uuid, '01a10339-7356-7754-8a6c-ffd5884592e8'::uuid, 'owner'),
    ('01a10334-51b4-7e89-8298-93834613dc7e'::uuid, 'attached_to', 'D3c: the lane''s own audit, authored by the teammate who filed it', 'produces', '01a1031c-db8f-774a-a125-927f6d535749'::uuid, '01a10334-517a-72ab-88f9-64b3dffe4d96'::uuid, 'owner'),
    ('01a10332-cce4-7a6d-8d4e-dcd9cc8b7c7e'::uuid, 'attached_to', 'D3c: the lane''s own audit, authored by the teammate who filed it', 'produces', '01a1031c-db8f-774a-a125-927f6d535749'::uuid, '01a10332-ccce-7028-8d25-10511b247d5d'::uuid, 'owner'),
    ('01a10332-cab5-796b-aa1a-2d821b6039ed'::uuid, 'attached_to', 'D3c: the lane''s own audit, authored by the teammate who filed it', 'produces', '01a1031c-db8f-774a-a125-927f6d535749'::uuid, '01a10332-caa4-7657-8e12-4a73fa2f08b8'::uuid, 'owner'),
    ('01a10332-c876-79fe-9765-8735595aec9c'::uuid, 'attached_to', 'D3c: the lane''s own audit, authored by the teammate who filed it', 'produces', '01a1031c-db8f-774a-a125-927f6d535749'::uuid, '01a10332-c862-74dd-88f6-597a977214f8'::uuid, 'owner'),
    ('01a1032e-afeb-7b82-a518-059265ee201d'::uuid, 'attached_to', 'D3c: the lane''s own audit, authored by the teammate who filed it', 'produces', '01a1031c-de50-768c-a942-747c2f52fe64'::uuid, '01a1032e-afd7-7ecd-b541-669dfad1fc22'::uuid, 'owner'),
    ('01a10327-b7e2-783a-a9b1-8bbe9460d6e7'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a102d6-3943-7be7-9668-648fe9e15962'::uuid, '01a10327-b7d6-7dd2-9b57-da7ef1736eab'::uuid, 'rule'),
    ('01a102f5-3a8b-760e-8952-0f64cd211c80'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a102e3-8dc3-762a-822e-cc3a75efd1b5'::uuid, '01a102f5-3a6e-7687-b75a-f3d1ef73e706'::uuid, 'rule'),
    ('01a102f5-0adc-7472-87cc-e625b0ba1dc8'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a102e3-9041-7dcf-85a4-1b9db6a54907'::uuid, '01a102f5-0ac1-7e8d-a48c-9734de93209e'::uuid, 'rule'),
    ('01a102f1-23cb-7026-aa84-c4f29f0d7b9a'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a102e3-925e-792c-826c-3c808e183ac1'::uuid, '01a102f1-23b2-75aa-8a01-046c69b36280'::uuid, 'rule'),
    ('01a102ef-b108-7e87-83c8-2640ecb2faa9'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a102e4-aa1b-7741-b637-f7492e06a22a'::uuid, '01a102ef-b0f1-7204-89ff-9e9a5019551f'::uuid, 'rule'),
    ('01a102dd-c7ef-7506-8c17-f2920dc6e988'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a102d6-3943-7be7-9668-648fe9e15962'::uuid, '01a102dd-c7d9-70d0-8eb9-58a244ecfa44'::uuid, 'rule'),
    ('01a1012b-d8bd-7c68-a85c-ee8aac50ca51'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1011f-b3d2-7337-8139-2f6eecca4b51'::uuid, '01a1012b-d8b0-7ded-8753-a1affeed5a23'::uuid, 'rule'),
    ('01a1012b-d4d9-7e0f-b28a-250fefa598f8'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1011f-b3d2-7337-8139-2f6eecca4b51'::uuid, '01a1012b-d4c9-7179-936e-015ee512aaf0'::uuid, 'rule'),
    ('01a1012b-d14b-77dc-8b31-b1f8b462b0cb'::uuid, 'attached_to', 'R1-R3 output', 'produces', '01a1011f-b3d2-7337-8139-2f6eecca4b51'::uuid, '01a1012b-d13e-782c-bf1e-1e9c2251323e'::uuid, 'rule'),
    ('01a1120f-e6bf-7ad7-abe5-18750c3b98a5'::uuid, 'relates_to', 'R1-R3 output', 'produces', '01a111b1-8ee0-73f5-ac52-4cc2c89a81f3'::uuid, '01a1120f-e66d-714a-b101-b4e1f1d5969e'::uuid, 'rule'),
    ('01a10b65-bdc5-7ba7-b218-dac8f4463bad'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a10b65-6523-73eb-a9af-be389bdc6700'::uuid, '01a10b65-bda3-73be-963f-613f6695cd28'::uuid, 'rule'),
    ('01a10b65-bb56-7d67-8c5b-d1c6a24bfaf7'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a10b65-6523-73eb-a9af-be389bdc6700'::uuid, '01a10b65-bb26-7865-a5a9-8292c1439e42'::uuid, 'rule'),
    ('01a10b57-9e16-70b8-9d24-b1d81bd24045'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a10b57-5d60-7d39-b700-d8dabd98ab37'::uuid, '01a10b57-9e03-74f4-8e0f-a4184a4b7b45'::uuid, 'rule'),
    ('01a10b57-5d95-7187-8755-ce7d9b05d133'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a10b57-5d60-7d39-b700-d8dabd98ab37'::uuid, '01a10b4e-793f-763d-9f29-6e5f7dc7411c'::uuid, 'rule'),
    ('01a10b56-c860-72d4-ac3a-30f0f54bd2e4'::uuid, 'relates_to', 'R1-R3 output', 'produces', '01a10b4e-793f-763d-9f29-6e5f7dc7411c'::uuid, '01a10b56-c83f-788c-845e-7463e13a4ec5'::uuid, 'rule'),
    ('01a10b51-6c9c-785e-a93d-cc0b25869744'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a10b46-016f-7a9f-aff0-c759caaaa6db'::uuid, '01a10b51-6c2f-7536-85ca-8e30a88c7855'::uuid, 'rule'),
    ('01a10b51-6745-79bc-a18a-d8f6f02d6d19'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a10b46-016f-7a9f-aff0-c759caaaa6db'::uuid, '01a10b51-671e-76c4-927f-1808d544338e'::uuid, 'rule'),
    ('01a10b51-61b3-78e4-b733-d92a2f324c1b'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a10b46-016f-7a9f-aff0-c759caaaa6db'::uuid, '01a10b51-618c-7806-882a-b55277686ba0'::uuid, 'rule'),
    ('01a10b50-e3f2-75fe-9d51-ec947aabae73'::uuid, 'relates_to', 'R1-R3 output', 'produces', '01a10b35-4246-7887-9975-96c122cf4ce6'::uuid, '01a10b50-9356-7a64-b2da-20953e3b7256'::uuid, 'rule'),
    ('01a10b4f-6a23-7cb5-96e5-7c5823906d69'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a10b4d-953a-7df0-a497-f140d80233ee'::uuid, '01a10b4f-69f8-7d72-9ef0-9c2ef41d142e'::uuid, 'rule'),
    ('01a10b4f-667e-7cee-bb02-c3f33814012b'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a10b4d-953a-7df0-a497-f140d80233ee'::uuid, '01a10b4f-6660-7a16-8ce3-7b72950ea1a7'::uuid, 'rule'),
    ('01a10b4f-6236-7e19-b69d-8eef1ba75ede'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a10b4d-953a-7df0-a497-f140d80233ee'::uuid, '01a10b4f-6217-703e-a6f3-3a06cf0d55f7'::uuid, 'rule'),
    ('01a10b46-0189-720d-9b86-42a1c49d5b06'::uuid, 'relates_to', 'R1-R3 output', 'produces', '01a10b35-4246-7887-9975-96c122cf4ce6'::uuid, '01a10b46-016f-7a9f-aff0-c759caaaa6db'::uuid, 'rule'),
    ('01a10880-59c9-79cc-8fac-7b6f65779008'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a10817-05fe-7a3a-8add-ee46a8ca3194'::uuid, '01a10880-59b9-7d72-b519-e4ad4feaa671'::uuid, 'rule'),
    ('01a10817-0640-7cdf-bb41-b0d673d194d0'::uuid, 'relates_to', 'R1-R3 output', 'produces', '01a10725-97e5-7ee6-8f2d-b24ff7c54098'::uuid, '01a10817-05fe-7a3a-8add-ee46a8ca3194'::uuid, 'rule'),
    ('01a10803-20a3-7be0-abbe-fafd0d939f3d'::uuid, 'relates_to', 'R1-R3 output', 'produces', '01a10725-97e5-7ee6-8f2d-b24ff7c54098'::uuid, '01a10803-207f-7173-ba62-1b4bc184516c'::uuid, 'rule'),
    ('01a1029b-ddde-7dbd-8421-67a173c880e5'::uuid, 'relates_to', 'R1-R3 output', 'produces', '01a0fb59-aad0-7b51-8d6e-b5ba9161c78b'::uuid, '01a1029b-ddcf-7134-9582-b2d2dd032df6'::uuid, 'rule'),
    ('01a0ff46-e3e9-7b64-b591-13c2cfe4a262'::uuid, 'relates_to', 'R1-R3 output', 'produces', '01a0ff2b-ed42-73dc-87f2-79ff06eccad8'::uuid, '01a0ff46-e3cd-76f3-b9d5-3c7d4bb2a975'::uuid, 'rule'),
    ('01a0ff2f-aa1e-7330-acab-f2cb2443c1df'::uuid, 'relates_to', 'R1-R3 output', 'produces', '01a0ff2b-ed42-73dc-87f2-79ff06eccad8'::uuid, '01a0ff2f-aa00-725e-a5df-5e179e4e6ae3'::uuid, 'rule'),
    ('01a0fe4b-5d7a-775f-9917-f3bc4e18cb92'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a0fe4b-5d48-7f8b-ab82-c2482b36e73c'::uuid, '01a0fba4-b9c1-7f44-a37f-54a1ec7bff8d'::uuid, 'rule'),
    ('01a0fe4b-5d6f-7b1d-ae8b-052cf2a68ac4'::uuid, 'relates_to', 'R1-R3 output', 'produces', '01a0fe46-83b6-783c-84cc-6a53d9d5fe5a'::uuid, '01a0fe4b-5d48-7f8b-ab82-c2482b36e73c'::uuid, 'rule'),
    ('01a0fc2e-75ad-74b4-9a33-29690dd2875e'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a0fc22-854f-7c0c-a7a7-f77d433e271a'::uuid, '01a0fc2e-759b-7022-abcb-2b23cea0caac'::uuid, 'rule'),
    ('01a0fc22-8564-78d0-86a0-a71db5fe19ca'::uuid, 'relates_to', 'R1-R3 output', 'produces', '01a0fba4-b9c1-7f44-a37f-54a1ec7bff8d'::uuid, '01a0fc22-854f-7c0c-a7a7-f77d433e271a'::uuid, 'rule'),
    ('01a0fc07-8ad8-72fa-a44b-47e5c94eb386'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fc07-8a97-725e-aeea-ad8d2f32843a'::uuid, '01a0fc05-1b46-771b-b896-b3fde21721f7'::uuid, 'owner'),
    ('01a0fc06-c3bb-7542-96d6-836eb72f9c79'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fc01-b43c-79e5-a584-cc9b3dca2347'::uuid, '01a0fc05-91de-7c12-ad5b-5b10224cb6ca'::uuid, 'owner'),
    ('01a0fc06-c14b-76fe-9e21-087b98d89460'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fc01-b43c-79e5-a584-cc9b3dca2347'::uuid, '01a0fc05-8a6c-7eac-8d01-77376d2f1ab3'::uuid, 'owner'),
    ('01a0fc06-bdaa-7f87-a169-60903d5303a5'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fc01-b43c-79e5-a584-cc9b3dca2347'::uuid, '01a0fc05-7f39-7c4f-b55e-5d8b95122116'::uuid, 'owner'),
    ('01a0fc06-b3a3-74ad-87fb-97001b0c67cb'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fc01-b43c-79e5-a584-cc9b3dca2347'::uuid, '01a0fc05-72af-7c58-8574-0f853e403f12'::uuid, 'owner'),
    ('01a0fc06-ae10-7797-bd27-757fcd9b66de'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fc01-b43c-79e5-a584-cc9b3dca2347'::uuid, '01a0fc05-6ada-7572-855f-4aec934b1641'::uuid, 'owner'),
    ('01a0fc06-ab72-7c9f-912b-754fd7f3574f'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fc01-b43c-79e5-a584-cc9b3dca2347'::uuid, '01a0fc05-6501-7b64-a9dc-b94050214a56'::uuid, 'owner'),
    ('01a0fc06-a8a3-7190-a37f-41082181b735'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fc06-9212-7095-acff-07f06eb39883'::uuid, '01a0fc05-613e-758c-8e46-b5cb921714f9'::uuid, 'owner'),
    ('01a0fc06-a619-7a7b-9381-fda51df58405'::uuid, 'relates_to', 'D3d: the design task''s design', 'produces', '01a0fc05-613e-758c-8e46-b5cb921714f9'::uuid, '01a0fc01-b43c-79e5-a584-cc9b3dca2347'::uuid, 'owner'),
    ('01a0fc06-a164-7826-961e-91fc65b34ed6'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fc06-8d2e-7977-8708-9d34ad5307ce'::uuid, '01a0fc05-1b46-771b-b896-b3fde21721f7'::uuid, 'owner'),
    ('01a0fc06-9943-7353-aa39-251e67361132'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fc01-c0f8-7124-be94-86e72fc6da63'::uuid, '01a0fc05-1b46-771b-b896-b3fde21721f7'::uuid, 'owner'),
    ('01a0fba4-c4c2-7aed-b2f0-625e6d57191f'::uuid, 'relates_to', 'R4/R5 input', 'attached_to', '01a0fba4-8593-70dc-8cfc-0e7f1a6b307b'::uuid, '01a0fba4-c4b6-7ccb-bf41-9e1544e938de'::uuid, 'rule'),
    ('01a0fba4-c133-7473-b50c-315a130e1526'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fba4-8593-70dc-8cfc-0e7f1a6b307b'::uuid, '01a0fba4-c11e-703e-a626-d2a2d2960168'::uuid, 'owner'),
    ('01a0fba4-be59-7a87-9920-5a9dcd680c08'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fba4-8593-70dc-8cfc-0e7f1a6b307b'::uuid, '01a0fba4-be45-7fac-a975-e245a87fcdbd'::uuid, 'owner'),
    ('01a0fba4-bc17-71de-9fa0-f08627022502'::uuid, 'relates_to', 'D3f: unclear or an input; kept as a reference', 'attached_to', '01a0fba4-8593-70dc-8cfc-0e7f1a6b307b'::uuid, '01a0fba4-bc09-79b1-942d-734f0c99b48e'::uuid, 'owner'),
    ('01a0fba4-b9cd-7cba-af18-ba367e4179ba'::uuid, 'relates_to', 'D3e: authored under the parent task', 'produces', '01a0fba4-b9c1-7f44-a37f-54a1ec7bff8d'::uuid, '01a0fba4-8593-70dc-8cfc-0e7f1a6b307b'::uuid, 'owner'),
    ('01a10c66-87ad-728f-8129-bb293a7adc24'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10c66-0f00-7fb7-b33c-aa79f32d463e'::uuid, '01a10c0f-b61e-774b-920f-79f35528f0ef'::uuid, 'owner'),
    ('01a10b65-bdb6-72c2-a4c7-41678a090c36'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b65-bda3-73be-963f-613f6695cd28'::uuid, '01a10b47-ce50-7277-85ff-0a2a07a1575e'::uuid, 'owner'),
    ('01a10b65-bb47-7ef3-8502-63e1e01a50bc'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b65-bb26-7865-a5a9-8292c1439e42'::uuid, '01a10b47-ce50-7277-85ff-0a2a07a1575e'::uuid, 'owner'),
    ('01a10b57-9e0f-746a-86fb-a4635fa9c978'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b57-9e03-74f4-8e0f-a4184a4b7b45'::uuid, '01a10b47-ce50-7277-85ff-0a2a07a1575e'::uuid, 'owner'),
    ('01a10b57-1a62-7862-b924-afdc9837c3ca'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b57-1a29-7300-9613-773bb3653acb'::uuid, '01a10b4e-793f-763d-9f29-6e5f7dc7411c'::uuid, 'owner'),
    ('01a10b57-167a-741c-8f74-6be119eb6831'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b57-1668-79fd-a7b9-b29d13f6c04c'::uuid, '01a10b4e-793f-763d-9f29-6e5f7dc7411c'::uuid, 'owner'),
    ('01a10b57-1443-7bd0-96b9-85bf7e00865c'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b57-1432-755c-882a-e605ddbac83f'::uuid, '01a10b4e-793f-763d-9f29-6e5f7dc7411c'::uuid, 'owner'),
    ('01a10b57-1117-7de5-a5da-94edc70e2a66'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b57-10f7-7632-b312-9a999683c59e'::uuid, '01a10b4e-793f-763d-9f29-6e5f7dc7411c'::uuid, 'owner'),
    ('01a10b51-6c6d-773a-8070-71268c630928'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b51-6c2f-7536-85ca-8e30a88c7855'::uuid, '01a10b35-4246-7887-9975-96c122cf4ce6'::uuid, 'owner'),
    ('01a10b51-6732-7e3e-870c-b7cb28370a7d'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b51-671e-76c4-927f-1808d544338e'::uuid, '01a10b35-4246-7887-9975-96c122cf4ce6'::uuid, 'owner'),
    ('01a10b51-61a4-7042-a084-d01bec6f6ab1'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b51-618c-7806-882a-b55277686ba0'::uuid, '01a10b35-4246-7887-9975-96c122cf4ce6'::uuid, 'owner'),
    ('01a10b4f-6a05-77af-b699-2be13224bcb9'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b4f-69f8-7d72-9ef0-9c2ef41d142e'::uuid, '01a10b47-ce50-7277-85ff-0a2a07a1575e'::uuid, 'owner'),
    ('01a10b4f-6673-748b-b641-2bd22769b135'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b4f-6660-7a16-8ce3-7b72950ea1a7'::uuid, '01a10b47-ce50-7277-85ff-0a2a07a1575e'::uuid, 'owner'),
    ('01a10b4f-622a-7055-9e3e-71b95ca6b1b2'::uuid, 'relates_to', 'Q6 follow-up of a design/origin task', 'follows_up', '01a10b4f-6217-703e-a6f3-3a06cf0d55f7'::uuid, '01a10b47-ce50-7277-85ff-0a2a07a1575e'::uuid, 'owner'),
    ('01a1032e-58a1-7ffd-94a6-5bb394dd26cd'::uuid, 'attached_to', 'D3c: the lane''s own audit, authored by the teammate who filed it', 'produces', '01a1031c-de50-768c-a942-747c2f52fe64'::uuid, '01a1032e-5893-7404-9875-bffd190d064e'::uuid, 'owner'),
    ('01a1032e-5699-7b77-9d11-78e2ac20f4c2'::uuid, 'attached_to', 'D3c: the lane''s own audit, authored by the teammate who filed it', 'produces', '01a1031c-de50-768c-a942-747c2f52fe64'::uuid, '01a1032e-568d-79c3-964e-2d8a425f5061'::uuid, 'owner'),
    ('01a1032e-5449-7bb9-929d-8a6482a5ec20'::uuid, 'attached_to', 'D3c: the lane''s own audit, authored by the teammate who filed it', 'produces', '01a1031c-de50-768c-a942-747c2f52fe64'::uuid, '01a1032e-543f-7c61-bee4-64173ad6d924'::uuid, 'owner'),
    ('01a1032e-5213-72cd-8815-ee88e28d859c'::uuid, 'attached_to', 'D3c: the lane''s own audit, authored by the teammate who filed it', 'produces', '01a1031c-de50-768c-a942-747c2f52fe64'::uuid, '01a1032e-5206-70b2-96a7-afd0182f5b36'::uuid, 'owner'),
    ('01a1032e-4fd7-7635-9fc2-efdc24e7b941'::uuid, 'attached_to', 'D3c: the lane''s own audit, authored by the teammate who filed it', 'produces', '01a1031c-de50-768c-a942-747c2f52fe64'::uuid, '01a1032e-4fbd-75a2-bc10-8a42a090ded9'::uuid, 'owner')
    ) as v(edge_id, old_type, rule, new_type, new_src, new_dst, confirmed)
    join public.edges e on e.id = v.edge_id and e.type = v.old_type
  loop
    perform internal.migrate_edge(batch, r.rule, r.edge_id, r.new_type, r.new_src, r.new_dst, r.confirmed);
    done := done + 1;
  end loop;
  raise notice '308: % reviewed rows moved', done;
end
$$;

-- Q6, the two walked rows (Appendix D 1-2). Unlike the other 14 follow-ups
-- these are attached_to task -> task, which the story walk follows; follows_up
-- is not walked (Q5). The owner approved all 16, and the guardrail says no
-- entity may leave a story. So these two move only if every story keeps every
-- entity it had; otherwise they are put back (logged) and stay attached_to.
do $$
declare
  r record;
  lost integer;
begin
  for r in
    select v.* from (values
    ('01a10570-1e7b-705c-a3b8-cb13f30d29e5'::uuid, '01a10570-1e6b-7dee-9634-d9964c34ee62'::uuid, '01a0fe7a-f07a-72c9-bb6a-d9b0c0f93e02'::uuid),
    ('01a10570-1e74-777d-af2a-4d7a92e62f11'::uuid, '01a10570-1e6b-7dee-9634-d9964c34ee62'::uuid, '01a0fe7a-f6e4-7d71-b42c-12e19926ef3f'::uuid)
    ) as v(edge_id, new_src, new_dst)
    join public.edges e on e.id = v.edge_id and e.type = 'attached_to'
  loop
    perform internal.migrate_edge('p0b-308', 'Q6 follow-up of a design/origin task (walked row)',
                                  r.edge_id, 'follows_up', r.new_src, r.new_dst, 'owner');
    select count(*) into lost
      from p0b_308_before b
     where not exists (select 1 from public.entities s
                         cross join lateral internal.story_trail(s.id) t
                        where s.id = b.story_id and t.entity_id = b.entity_id and t.root_id = b.root_id);
    if lost > 0 then
      perform internal.revert_edge_migration('p0b-308', r.edge_id);
      insert into internal.edge_migration_story_diff(batch, story_id, entity_id, root_id, change)
      select 'p0b-308', b.story_id, b.entity_id, b.root_id, 'kept'
        from p0b_308_before b
       where not exists (select 1 from public.entities s
                           cross join lateral internal.story_trail(s.id) t
                          where s.id = b.story_id and t.entity_id = b.entity_id and t.root_id = b.root_id);
      raise notice '308: % stays attached_to; as follows_up it would take % entity/root pairs out of stories',
        r.edge_id, lost;
    end if;
  end loop;
end
$$;

update public.edge_types
   set replaced_by = 'authored_from',
       description = 'Retired: merged into authored_from (Made during). Its rows were moved there with origin=client_claim kept.'
 where type = 'created_in';
update public.edge_types
   set description = 'Made during: this entity was made in that work session or chat. The server records it; origin says which recorder (or client_claim for rows moved from created_in).'
 where type = 'authored_from';

-- -----------------------------------------------------------------------------
-- 4. The real-data check: nothing leaves any story.
-- -----------------------------------------------------------------------------
create temp table p0b_308_after on commit drop as
  select s.id as story_id, t.entity_id, t.root_id
    from public.entities s
    cross join lateral internal.story_trail(s.id) t
   where s.kind = 'story' and s.deleted_at is null;

insert into internal.edge_migration_story_diff(batch, story_id, entity_id, root_id, change)
select 'p0b-308', a.story_id, a.entity_id, a.root_id, 'added'
  from p0b_308_after a
 where not exists (select 1 from p0b_308_before b
                    where b.story_id = a.story_id and b.entity_id = a.entity_id and b.root_id = a.root_id);

do $$
declare
  lost integer;
  sample text;
begin
  select count(*), string_agg(b.story_id || ':' || b.entity_id, ', ' order by b.story_id) filter (where true)
    into lost, sample
    from p0b_308_before b
   where not exists (select 1 from p0b_308_after a
                      where a.story_id = b.story_id and a.entity_id = b.entity_id and a.root_id = b.root_id);
  if lost > 0 then
    raise exception '308 would remove % entity/root pairs from story subgraphs (e.g. %); nothing was changed',
      lost, left(sample, 400) using errcode = '23514';
  end if;
  raise notice '308: story subgraphs kept; % pairs added',
    (select count(*) from internal.edge_migration_story_diff where batch = 'p0b-308');
end
$$;
