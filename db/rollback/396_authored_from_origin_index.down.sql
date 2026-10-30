-- =============================================================================
-- ROLLBACK for 396_authored_from_origin_index.sql — NOT a migration (db/migrate.mjs
-- never reads this directory). Run by hand, as the migration owner, only to
-- undo 396:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/396_authored_from_origin_index.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '396_authored_from_origin_index.sql'"
--
-- Restores the one-per-source index of 015/052, the authored_from props schema
-- without bridgeId, the 2-argument story_walk_skips and every reader body as it
-- stood before 396 (pg_get_functiondef of a database migrated to 390). REFUSES
-- while any bridge provenance edge (props.bridgeId) exists: the old index
-- cannot hold them, and deleting provenance is not a rollback's call. Roll back
-- the provenance writer (B1b-3) and remove its edges first.
-- =============================================================================

do $$
begin
  if exists (select 1 from public.edges where type = 'authored_from' and props ? 'bridgeId') then
    raise exception '396 rollback: bridge provenance authored_from edges exist; remove them first';
  end if;
end
$$;

drop index public.edges_authored_from_source_idx;
create unique index edges_authored_from_source_idx on public.edges(src_id)
  where type = 'authored_from';

update public.edge_types
   set props_schema = props_schema #- '{properties,bridgeId}'
 where type = 'authored_from';

CREATE OR REPLACE FUNCTION internal.story_walk_skips(p_type text, p_src_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
  -- A session's messages and forms are authored_from it too; walking them
  -- would pull every message into the story and spend the 500-row budget.
  select p_type = 'authored_from'
     and exists (select 1 from public.entities m
                  where m.id = p_src_id and m.kind in ('message', 'form'))
$function$;
revoke all on function internal.story_walk_skips(text, uuid) from public;
grant execute on function internal.story_walk_skips(text, uuid) to tm8_app, tm8_graph_owner;

CREATE OR REPLACE FUNCTION public.record_authored_from(p_entity_id uuid, p_work_session_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  e public.entities;
  origin public.entities;
  edge_row_id uuid;
begin
  select * into e from public.entities where id = p_entity_id and deleted_at is null;
  if e.id is null or e.kind in ('message', 'form') then
    return null;
  end if;
  select id into edge_row_id from public.edges where src_id = p_entity_id and type = 'authored_from';
  if edge_row_id is not null then
    return edge_row_id;
  end if;
  select * into origin from public.entities
   where id = p_work_session_id and deleted_at is null and space_id = e.space_id;
  if origin.id is null then
    return null;
  end if;
  if e.kind = 'work_session' then
    -- A session was made where it was launched (330: its launched_by edge).
    if origin.kind not in ('work_session', 'chat') or internal.launched_by(e.id) is distinct from origin.id then
      return null;
    end if;
  elsif origin.kind = 'work_session' then
    if not exists (
      select 1
        from public.work_sessions ws
        join public.edges p on p.dst_id = ws.entity_id and p.type = 'participates_in'
       where ws.entity_id = origin.id
         and ws.status in ('spawning', 'running', 'idle')
         and p.src_id = e.created_by) then
      return null;
    end if;
  elsif origin.kind = 'chat' then
    if not exists (
      select 1 from public.chats c
       where c.entity_id = origin.id and c.teammate_id = e.created_by) then
      return null;
    end if;
  else
    return null;
  end if;
  perform internal.w1_set_writer('entity_recorder');
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (e.space_id, p_entity_id, origin.id, 'authored_from', e.created_by)
  on conflict do nothing
  returning id into edge_row_id;
  perform internal.w1_set_writer(null);
  return edge_row_id;
end
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION internal.guard_verifies_semantics()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  target public.entities;
  evidence public.entities;
  answer_id text;
  answer_edge public.edges;
  target_session uuid;
  evidence_session uuid;
  claimed_basis text;
begin
  select * into target from public.entities where id = new.dst_id;
  select * into evidence from public.entities where id = new.src_id;

  -- Pin currency: a verification of a version the target has already left is
  -- not a clear, it is history.
  if (new.props ->> 'pinnedVersion')::int is distinct from target.version then
    raise exception 'verifies must pin the target''s current version % (got %)',
      target.version, coalesce(new.props ->> 'pinnedVersion', 'null')
      using errcode = '23514';
  end if;

  -- Every answered dispute must exist, be on this target, and not already be
  -- answered at the current version.
  for answer_id in
    select jsonb_array_elements_text(coalesce(new.props -> 'answers', '[]'::jsonb))
  loop
    if answer_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'verifies.answers entries must be dispute edge ids (got %)', answer_id
        using errcode = '22023';
    end if;
    select * into answer_edge from public.edges
      where id = answer_id::uuid and type = 'disputes' and dst_id = new.dst_id;
    if answer_edge.id is null then
      raise exception 'verifies.answers id % is not a disputes edge on this target', answer_id
        using errcode = '23514';
    end if;
    if exists (select 1 from public.edges v
                where v.type = 'verifies' and v.dst_id = new.dst_id
                  and v.props -> 'answers' ? answer_id
                  and (v.props ->> 'pinnedVersion')::int = target.version) then
      raise exception 'dispute % is already answered at the current version', answer_id
        using errcode = '23514';
    end if;
  end loop;

  -- Two-tier independence (design §3.4). The one-per-source UNIQUE index on
  -- authored_from (renamed in 052) makes "the authoring session" unambiguous.
  -- The basis is checked against what the graph shows — a caller cannot claim
  -- 'session' when only actor separation is available, and the recorded basis
  -- surfaces on the badge so a reader can see which tier a clear rests on.
  select e.dst_id into target_session from public.edges e
    where e.src_id = new.dst_id and e.type = 'authored_from';
  select e.dst_id into evidence_session from public.edges e
    where e.src_id = new.src_id and e.type = 'authored_from';
  claimed_basis := new.props ->> 'independenceBasis';

  if target_session is not null and evidence_session is not null then
    if target_session = evidence_session then
      raise exception 'verification evidence shares the claim''s authoring session'
        using errcode = '23514';
    end if;
    if claimed_basis is distinct from 'session' then
      raise exception 'independenceBasis must be ''session'' when both sides carry authored_from provenance (claimed %)',
        coalesce(claimed_basis, 'null') using errcode = '23514';
    end if;
  else
    if evidence.created_by = target.created_by then
      raise exception 'verification requires an independent author when session provenance is absent'
        using errcode = '23514';
    end if;
    if claimed_basis is distinct from 'actor' then
      raise exception 'independenceBasis must be ''actor'' when session provenance is missing on either side (claimed %)',
        coalesce(claimed_basis, 'null') using errcode = '23514';
    end if;
  end if;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION internal.form_requesting_session(p_form_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
  select edge.dst_id
    from public.edges edge
    join public.entities ws on ws.id = edge.dst_id and ws.deleted_at is null
   where edge.src_id = p_form_id and edge.type = 'authored_from'
   limit 1
$function$;

CREATE OR REPLACE FUNCTION internal.form_delivery_deleted_session()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  deleted_session uuid;
  delivery jsonb;
  dies boolean;
begin
  if new.status <> 'submitted' then return null; end if;
  if tg_op = 'UPDATE' and old.status = 'submitted' then return null; end if;
  if internal.form_requesting_session(new.form_id) is not null then return null; end if;
  select edge.dst_id into deleted_session
    from public.edges edge
    join public.entities ws on ws.id = edge.dst_id and ws.kind = 'work_session'
   where edge.src_id = new.form_id and edge.type = 'authored_from'
     and ws.deleted_at is not null
   limit 1;
  if deleted_session is not null then
    select internal.form_settings_effective(f.settings) -> 'delivery' into delivery
      from public.forms f where f.entity_id = new.form_id;
    -- The same rule as the claim's step 2: only resume/queue to the requesting
    -- session dies with it.
    dies := delivery ->> 'target' = 'requesting_session'
            and delivery ->> 'onSessionNotLive' in ('resume', 'queue');
    insert into public.form_deliveries(response_id, work_session_id, status, last_error)
    values (new.id, deleted_session,
            case when dies then 'cancelled' else 'pending' end,
            case when dies then 'session_deleted' end)
    on conflict (response_id, work_session_id) do nothing;
  end if;
  return null;
end
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.w2_record_session_message_routes(p_message_ids uuid[], p_conversation_anchor_id uuid DEFAULT NULL::uuid, p_mention_session_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
-- `author_id` is BOTH a local below and a real column of public.messages, and
-- the batch guard compares them in one predicate over that table. Without this
-- option that reference is ambiguous and every call dies with SQLSTATE 42702 --
-- which is every messages.post. See 072 and the repair in PR #8.
#variable_conflict use_variable
declare
  message_count integer;
  batch_id text;
  author_id uuid;
  message_space uuid;
  source_message_id uuid;
  source_anchor_kind text;
  mention_ids uuid[] := array(select distinct unnest(coalesce(p_mention_session_ids, '{}'::uuid[])));
  -- 121: split out of the old single `if not exists(...) and not exists(...)`
  -- guard, because the answer is now needed TWICE -- once to decide whether the
  -- batch owes anything at all, and once to decide whether the conversation
  -- anchor has to be resolved. Computing it into a local keeps those two
  -- decisions from drifting apart.
  owes_addressed_copy boolean;
  owes_task_copy boolean;
  route_row record;
  result jsonb := '[]'::jsonb;
begin
  if cardinality(coalesce(p_message_ids, '{}'::uuid[])) < 1 then
    raise exception 'message route recording requires a message batch' using errcode = '22023';
  end if;
  if cardinality(p_message_ids) <> cardinality(array(select distinct unnest(p_message_ids))) then
    raise exception 'message route ids must be unique' using errcode = '22023';
  end if;

  select m.message_batch_id, m.author_id, e.space_id into batch_id, author_id, message_space
    from public.messages m join public.entities e on e.id = m.entity_id
   where m.entity_id = p_message_ids[1];
  select count(*) into message_count
    from public.messages m
   where m.entity_id = any(p_message_ids);
  if message_count <> cardinality(p_message_ids)
     or exists (
       select 1 from public.messages m
        where m.entity_id = any(p_message_ids)
          and (m.message_batch_id is distinct from batch_id or m.author_id is distinct from author_id)
     )
     or author_id is distinct from coalesce(internal.actor_id(), internal.current_member_id(message_space)) then
    raise exception 'message route batch does not match the current authored command' using errcode = '42501';
  end if;

  -- Fail before the early exit, not after: an invalid poke target must refuse
  -- even when the batch owes nothing else, or the caller learns the target was
  -- bad only on the batches that happened to owe other deliveries.
  if exists (
    select 1 from unnest(mention_ids) s(session_id)
     where not exists (
       select 1 from public.work_sessions ws
         join public.entities se on se.id = ws.entity_id
        where ws.entity_id = s.session_id
          and se.space_id = message_space and se.deleted_at is null
     )
  ) then
    raise exception 'poke target is not a live work session in this space' using errcode = '22023';
  end if;

  -- DOES THIS BATCH OWE ANYONE A LIVE COPY? 076's two disjuncts, plus 099's
  -- explicit pokes. These three are the ADDRESSED classes: each names its
  -- target, directly or through the thread, and each reads the conversation
  -- anchor below.
  owes_addressed_copy :=
       exists (
         select 1 from public.messages m join public.entities e on e.id = m.anchor_id
          where m.entity_id = any(p_message_ids) and e.kind = 'work_session'
       )
    or exists (
         select 1
           from public.messages m
           join public.entities me on me.id = m.entity_id
           join public.edges origin on origin.src_id = me.parent_id and origin.type = 'authored_from'
          where m.entity_id = any(p_message_ids) and me.parent_id is not null
       )
    or cardinality(mention_ids) > 0;

  -- 121's disjunct, in TWO STATEMENTS, and the split is a measured performance
  -- fix rather than a stylistic one. See "THE ORDER IS NOT THE PLANNER'S TO
  -- CHOOSE" in this file's header: written as one query with the anchor-kind
  -- test as a join predicate, Postgres INLINES the membership function and is
  -- then free to reorder, and it puts `entities anchor` LAST -- so a message on
  -- a CHANNEL walks that channel's entire history through the SPOKEN arm and
  -- throws all of it away on `Rows Removed by Filter: 1`. Measured on the live
  -- node, a channel post with 209 siblings: 5 buffers before, 712 after.
  --
  -- A plpgsql IF is a real branch and not a planner preference, so the cheap
  -- question is asked first and the expensive one is not asked at all unless the
  -- batch actually has a task anchor. Every non-task post -- 2437 of the 4382
  -- messages on this node -- takes the first statement and stops.
  owes_task_copy := false;
  if exists (
    select 1
      from public.messages m
      join public.entities anchor on anchor.id = m.anchor_id
     where m.entity_id = any(p_message_ids)
       and anchor.kind = 'task' and anchor.deleted_at is null
  ) then
    -- Over-approximates the CTE below on purpose: it does not re-test the
    -- author-exclusion or the already-owed narrowing, because being wrong here
    -- costs one extra pass through a loop that then yields nothing, while being
    -- wrong the other way silently drops the whole class.
    owes_task_copy := exists (
      select 1
        from public.messages m
        join public.entities anchor
          on anchor.id = m.anchor_id and anchor.kind = 'task' and anchor.deleted_at is null
        join internal.w2_task_conversation_sessions(m.anchor_id, p_message_ids) member on true
        join public.work_sessions ws on ws.entity_id = member.work_session_id
       where m.entity_id = any(p_message_ids)
         and ws.status in ('spawning', 'running', 'idle')
         and ws.session_kind = 'agent'
    );
  end if;

  if not owes_addressed_copy and not owes_task_copy then
    return result;
  end if;

  -- Only the addressed classes read the conversation anchor, so only they may
  -- force it to exist. A task-only batch reaches its sessions without one.
  if owes_addressed_copy or p_conversation_anchor_id is not null then
    if p_conversation_anchor_id is null then
      if cardinality(p_message_ids) <> 1 then
        raise exception 'multi-anchor session delivery requires conversationAnchorId' using errcode = '22023';
      end if;
      select m.anchor_id into p_conversation_anchor_id
        from public.messages m where m.entity_id = p_message_ids[1];
    end if;

    select m.entity_id, e.kind into source_message_id, source_anchor_kind
      from public.messages m
      join public.entities e on e.id = m.anchor_id and e.deleted_at is null
     where m.entity_id = any(p_message_ids)
       and m.anchor_id = p_conversation_anchor_id;
    if source_message_id is null then
      raise exception 'conversationAnchorId must identify one message-batch anchor' using errcode = '22023';
    end if;
  end if;

  for route_row in
    -- ANCHOR TARGETS: 072's rule, byte-for-byte in meaning.
    with anchor_targets as (
      select m.entity_id               as target_message_id,
             m.anchor_id               as target_work_session_id,
             p_conversation_anchor_id  as src_anchor_id,
             source_message_id         as src_message_id
        from public.messages m
        join public.entities anchor on anchor.id = m.anchor_id
       where m.entity_id = any(p_message_ids) and anchor.kind = 'work_session'
    ),
    -- REPLY TARGETS: the session that authored the message this copy answers
    -- (076's rule, byte-for-byte in meaning).
    reply_targets as (
      select m.entity_id    as target_message_id,
             origin.dst_id  as target_work_session_id,
             m.anchor_id    as src_anchor_id,
             m.entity_id    as src_message_id
        from public.messages m
        join public.entities me on me.id = m.entity_id
        join public.edges origin on origin.src_id = me.parent_id and origin.type = 'authored_from'
        join public.work_sessions ws on ws.entity_id = origin.dst_id
       where m.entity_id = any(p_message_ids) and me.parent_id is not null
    ),
    -- MENTION TARGETS: caller-named sessions, delivered the CONVERSATION copy.
    -- src is (the conversation anchor, the tagging message itself), so the
    -- poked session's reply lands back in the thread (099's rule, unchanged).
    mention_targets as (
      select source_message_id          as target_message_id,
             s.session_id               as target_work_session_id,
             p_conversation_anchor_id   as src_anchor_id,
             source_message_id          as src_message_id
        from unnest(mention_ids) s(session_id)
    ),
    -- THE TASK ANCHORS OF THIS BATCH, FENCED. `as materialized` is the CTE's
    -- half of the same performance fix the guard above takes as a plpgsql IF,
    -- and it is required for the same reason: without the fence the planner
    -- inlines the membership function, reorders, and evaluates the anchor-kind
    -- test AFTER the walk. A batch that reaches this loop at all has satisfied
    -- an ADDRESSED class -- a work-session anchor, a reply, a poke -- so the
    -- common case here is a batch with NO task anchor, and it must not pay.
    -- Measured on the live node, a work_session post with 84 siblings:
    -- 323 buffers unfenced, 6 fenced with every task-side node `never executed`.
    task_anchored as materialized (
      select m.entity_id as message_id, m.anchor_id as task_id
        from public.messages m
        join public.entities anchor
          on anchor.id = m.anchor_id and anchor.kind = 'task' and anchor.deleted_at is null
       where m.entity_id = any(p_message_ids)
    ),
    -- TASK TARGETS (121, widened by 163): the live AGENT sessions in this
    -- task's conversation -- working it, or having opened it, or having spoken
    -- on it -- delivered that anchor's own copy. src is (the task, the message
    -- on it), so the woken session answers on the task.
    task_targets as (
      select m.message_id as target_message_id,
             ws.entity_id as target_work_session_id,
             m.task_id    as src_anchor_id,
             m.message_id as src_message_id
        from task_anchored m
        join internal.w2_task_conversation_sessions(m.task_id, p_message_ids) member
          on true
        join public.work_sessions ws on ws.entity_id = member.work_session_id
        join public.entities se on se.id = ws.entity_id
       where ws.status in ('spawning', 'running', 'idle')
         -- Narrowing 5 (163): a wake is typed into a terminal, and only an
         -- agent's terminal is reading prompts. A `shell` or `credential`
         -- session can open a task or post on one through the CLI, has no
         -- interaction pin, and would therefore pass `sessionInputAllowed`.
         and ws.session_kind = 'agent'
         and se.space_id = message_space
         and se.deleted_at is null
         -- Narrowing 2: never hand a session back its own message.
         and not exists (
           select 1 from public.edges authored
            where authored.src_id = m.message_id
              and authored.type = 'authored_from'
              and authored.dst_id = ws.entity_id
         )
         -- Narrowing 3: yield to any class that already owes this session a
         -- copy of this batch, whatever source that class recorded.
         and not exists (
           select 1 from anchor_targets a where a.target_work_session_id = ws.entity_id
         )
         and not exists (
           select 1 from reply_targets r where r.target_work_session_id = ws.entity_id
         )
         and not exists (
           select 1 from mention_targets x where x.target_work_session_id = ws.entity_id
         )
    )
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from anchor_targets
     union
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from reply_targets
     union
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from mention_targets
     union
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from task_targets
  loop
    insert into public.session_message_reply_routes(
      target_message_id, target_work_session_id, source_anchor_id,
      source_message_id, addressing_kind
    ) values (
      route_row.target_message_id,
      route_row.target_work_session_id,
      route_row.src_anchor_id,
      route_row.src_message_id,
      internal.w2_addressing_kind(route_row.src_anchor_id, route_row.target_work_session_id)
    )
    on conflict (target_message_id, target_work_session_id) do update
      set target_message_id = excluded.target_message_id
      where session_message_reply_routes.source_anchor_id = excluded.source_anchor_id
        and session_message_reply_routes.source_message_id = excluded.source_message_id
        and session_message_reply_routes.addressing_kind = excluded.addressing_kind;
    if not found then
      raise exception 'message reply route conflicts with its recorded origin' using errcode = '23514';
    end if;

    result := result || jsonb_build_array(jsonb_build_object(
      'targetMessageId', route_row.target_message_id,
      'targetWorkSessionId', route_row.target_work_session_id,
      'messageBatchId', batch_id,
      'senderActorId', author_id,
      'senderActorKind', (select e.kind from public.entities e where e.id = author_id),
      'sourceAnchorId', route_row.src_anchor_id,
      'sourceAnchorKind', (select e.kind from public.entities e where e.id = route_row.src_anchor_id),
      'sourceMessageId', route_row.src_message_id,
      'threadParentMessageId', (select e.parent_id from public.entities e where e.id = route_row.src_message_id),
      'threadRootMessageId', (select coalesce(m.root_message_id, m.entity_id)
        from public.messages m where m.entity_id = route_row.src_message_id),
      'body', (select m.body from public.messages m where m.entity_id = route_row.target_message_id),
      -- 134: one canonical route, one canonical copy manifest. This field was
      -- already audience-validated before the message row was stored (019).
      'attachments', (select coalesce(m.attachments, '[]'::jsonb)
        from public.messages m where m.entity_id = route_row.target_message_id),
      'contextAnchors', (
        select coalesce(jsonb_agg(jsonb_build_object('id', sibling.anchor_id, 'kind', sibling_anchor.kind)
          order by sibling.anchor_id), '[]'::jsonb)
          from public.messages sibling
          join public.entities sibling_anchor on sibling_anchor.id = sibling.anchor_id
         where sibling.entity_id = any(p_message_ids)
           and sibling.anchor_id <> route_row.src_anchor_id
           and sibling.anchor_id <> route_row.target_work_session_id
      ),
      -- Read for the TARGET session, not the anchor (076's point, unchanged).
      'rollingControlMaxBytes', coalesce((
        select (pin.resolved_snapshot #>> '{agentProjection,promptPolicy,rollingControlMaxBytes}')::integer
          from public.work_session_interaction_pins pin
         where pin.work_session_id = route_row.target_work_session_id
         order by pin.pin_revision desc limit 1
      ), 16384),
      'sessionInputAllowed', coalesce((
        select case
          when jsonb_array_length(coalesce(
            pin.resolved_snapshot #> '{agentProjection,promptPolicy,allowedInjectionKinds}', '[]'::jsonb
          )) = 0 then true
          else coalesce(
            (pin.resolved_snapshot #> '{agentProjection,promptPolicy,allowedInjectionKinds}')
              ? 'tm8.session-input',
            false
          )
        end
          from public.work_session_interaction_pins pin
         where pin.work_session_id = route_row.target_work_session_id
         order by pin.pin_revision desc limit 1
      ), true),
      'addressingKind',
        internal.w2_addressing_kind(route_row.src_anchor_id, route_row.target_work_session_id)
    ));
  end loop;
  return result;
end
$function$;

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
$function$;

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
$function$;

drop function internal.story_walk_skips(text, uuid, jsonb);
