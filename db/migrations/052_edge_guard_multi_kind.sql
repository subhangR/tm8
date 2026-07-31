-- =============================================================================
-- 052 — SHARED PREREQUISITE: the multi-kind edge guard and registry widenings.
--
-- ⚠ THIS FILE IS OWNED BY NO SINGLE FEATURE. Three in-flight features depend on
-- it and none of them may re-declare what it declares:
--
--     memories   (kind `memory`,   feature migration after this one)
--     worktrees  (kind `worktree`, feature migration after this one)
--     artifacts  (kind `artifact`, feature migration after this one)
--
-- WHY ONE FILE. `create or replace function` swaps the ENTIRE body. Two
-- migrations that both replace `internal.guard_w1_edge` do not error — the
-- lexically later filename silently wins and the earlier feature's branch
-- vanishes, with no message and no test failure unless someone happened to test
-- the exact branch that disappeared. The same hazard applies to
-- `edge_types.src_kinds` array rewrites: the later full-array UPDATE silently
-- drops the earlier widening. Applied migrations are immutable (per-file
-- checksum ledger in db/migrate.mjs), so recovery from a collision is a third
-- migration — after somebody notices. Therefore every shared-object change the
-- three features need lands here, exactly once, before any of them.
--
-- THE RULE THIS FILE ESTABLISHES: no later migration may `create or replace
-- internal.guard_w1_edge` or rewrite the src_kinds arrays below without first
-- absorbing this file's changes into its own text — and if you find yourself
-- doing that for a feature, the change belongs HERE-like in a new shared
-- prerequisite, not in the feature file. (Recommended follow-up, not in scope
-- here: a CI check that greps the chain for duplicate `create or replace
-- function internal.<name>` declarations — this bug class has no error message.)
--
-- The three new entity kinds themselves are deliberately NOT seeded here. A
-- core kind seed must land atomically with its `CoreEntityKind` contract entry
-- (packages/contract/src/contract.ts) or `EntityKindDriftError`
-- (packages/server/src/events/projector.ts) takes down the projector lane, and
-- each kind is a one-way door (`entity_kinds_guard_core`, 005) awaiting user
-- ratification. Referencing a not-yet-seeded kind in `src_kinds` is safe: the
-- kind check in internal.validate_edge simply never matches until the kind
-- exists and an entity of it is created.
-- =============================================================================

set role tm8_graph_owner;

-- 1. Registry widenings — full-array rewrites, stated explicitly so the final
--    state is readable here rather than derived from appends.
--    (015 seeded: in_project = {task,work_session,pull_request,commit};
--     authored_from = {message};
--     001 seeded attached_to = {task,member,team_member,doc,file,spell,skill,
--     pull_request,commit,work_session,collection}.)

update public.edge_types
   set src_kinds   = array['message','memory','artifact'],
       -- description made kind-neutral: it previously read "work-session
       -- MESSAGE provenance", which becomes a lie once three kinds carry it.
       description = 'Immutable Server-recorded work-session provenance'
 where type = 'authored_from';

update public.edge_types
   set src_kinds = array['task','work_session','pull_request','commit','artifact']
 where type = 'in_project';

update public.edge_types
   set src_kinds = array['task','member','team_member','doc','file','spell','skill',
                         'pull_request','commit','work_session','collection',
                         'memory','artifact']
 where type = 'attached_to';

-- 2. Index rename ONLY. The index said "message" while it is about to cover
--    three kinds. ⚠ The UNIQUE constraint itself (one `authored_from` per
--    source entity, globally) is load-bearing for all three features — it is
--    what makes the memories lane's verification-independence check well
--    defined ("the authoring session" is unambiguous because at most one can
--    exist) and it matches artifacts' one-session-per-artifact rule. Do NOT
--    drop or widen it.
alter index public.edges_authored_from_message_idx
  rename to edges_authored_from_source_idx;

-- 3. The ONE replace of internal.guard_w1_edge. Body copied verbatim from the
--    live definition (015), with exactly two semantic edits, both marked
--    `-- 052:` below:
--      (a) the `authored_from` writer equality becomes a per-type
--          permitted-writer SET: {message_recorder, memory_recorder,
--          artifact_publisher};
--      (b) `in_worktree` joins the `props.origin` stamping list.
create or replace function internal.guard_w1_edge() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
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
  -- artifact_publisher (artifacts). A per-type SET, not three equalities, so
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
           and coalesce(writer, '') not in ('message_recorder','memory_recorder','artifact_publisher'))
       or (row_value.type = 'selected_profile' and coalesce(writer, '') <> 'profile_pin')
       or (row_value.type = 'defaults_to_profile' and coalesce(writer, '') <> 'profile_default') then
      raise exception 'edge type % is recorder/configuration owned', row_value.type
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.props ? 'origin' and coalesce(writer, '') = '' then
      raise exception 'edge props.origin is Server-owned' using errcode = '42501';
    end if;
    -- 052 (b): `in_worktree` joins the stamping list (the worktrees lane's
    -- entire ask on this function). The registry row for `in_worktree` lands in
    -- the worktrees feature migration; until then this branch simply never
    -- matches that type.
    if new.type in ('in_project','participates_in','in_worktree') then
      new.props := new.props || jsonb_build_object('origin', coalesce(nullif(writer, ''), 'user'));
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
$$;

reset role;
