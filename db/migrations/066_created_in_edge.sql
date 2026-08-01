-- =============================================================================
-- 066 — `created_in`: which session an entity was born in.
--
-- Context: docs/graph/ (root README.md), and 065 which this continues.
--
-- THE OBSERVED PROBLEM. Measured on prod before this file: 59 docs, exactly ONE
-- linked to any session, and 45 with no edges at all. Sessions create docs all
-- day and their connection surface shows the teammate, the project, the task and
-- (since 065) their messages — but almost nothing they produced. "The session
-- made this" is the single most obvious question about an agent's work and the
-- graph could not answer it for any entity kind.
--
-- WHY `authored_from` COULD NOT BE USED. It is the type designed for exactly
-- this, and it is unavailable twice over:
--   * its src_kinds are {message, memory, artifact} (052:49), so a doc, task,
--     channel, file or collection is refused by internal.validate_edge outright;
--   * it is recorder-owned (052:117-127) — a client write raises 42501 — and the
--     server-side recorder cannot fire because the session id never reaches the
--     server at all (seven independent breaks; docs/graph/06-SESSION-PROVENANCE.md).
-- Widening and unblocking it is the RIGHT fix and it needs a session-scoped agent
-- token so the server can DERIVE the session instead of being told it.
--
-- WHAT THIS FILE DOES INSTEAD, AND WHAT IT IS WORTH. `created_in` is a SEPARATE,
-- WEAKER, HONESTLY-LABELLED type: the CLI asserts it from TM8_SESSION_ID at
-- create time, through the already-supported `connections` field, so it needs NO
-- server change and works against the frozen prod build on 7777/7778. Proven
-- before writing this: a doc created with `--connect attached_to=<session>`
-- appeared in that session's connections on the live frozen server.
--
-- ⚠ IT IS A CLAIM, NOT A FACT. Nothing verifies that the caller really is the
-- session it names. That is acceptable TODAY only because auth is loopback-only
-- and every actor already resolves to the space owner, so there is no boundary
-- being crossed that was not already open. It will NOT be acceptable once real
-- identities exist. Hence `props.origin = 'client_claim'` rather than the usual
-- writer-derived 'user' — the tag has to say which kind of thing it is, or a
-- later reader will mistake an assertion for a recorded fact. This is the same
-- reasoning that kept `working_on`/`relates_to` OUT of 065's stamping list.
--
-- NO BACKFILL, AND IT IS NOT AN OMISSION. The 45 orphan docs cannot be
-- attributed: peak concurrency is 49 sessions, 154 of 170 messages fall inside
-- two or more live session windows, the command ledger has no session column and
-- is pruned at 24h, and the event log has neither actor nor session and is pruned
-- at 7d. Forward capture only. See docs/graph/08-WHAT-WE-GOT-WRONG.md.
--
-- ⚠ SHARED-OBJECT NOTICE (the 052/053/055/056/057/065 rule, continued).
-- §3 does `create or replace function internal.guard_w1_edge`. That swaps the
-- ENTIRE body. The base text here is copied verbatim from 065 — the latest
-- definition, verified with pg_get_functiondef, not read off 052 or 015 — plus
-- ONE `elsif` branch. WHOEVER WRITES THE NEXT ARM MUST COPY THIS FILE'S BODY.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry. src `*` because every creatable kind needs this (the same shape
--    `shared_into` already uses, 015:37). dst is a work_session.
--
--    NOT acyclic and NOT append_only: an entity's birth session is immutable in
--    principle, but freezing an UNVERIFIED claim would make a wrong stamp
--    permanent and uncorrectable. Correctability wins until the claim is
--    verified — the same call 052:111-116 makes for `in_worktree`.
-- -----------------------------------------------------------------------------
insert into public.edge_types(type, src_kinds, dst_kinds, description, acyclic, props_schema) values
  ('created_in', array['*'], array['work_session'],
   'Client-asserted: this entity was created during that work session. Unverified until agents carry session-scoped tokens; see authored_from for the verified form.',
   false,
   jsonb_build_object(
     'type', 'object',
     'properties', jsonb_build_object('origin', jsonb_build_object('type', 'string')),
     'additionalProperties', true))
on conflict (type) do nothing;

-- -----------------------------------------------------------------------------
-- 2. One birth session per entity. Mirrors edges_authored_from_source_idx
--    (015:295 / 052:73). Two contradictory claims about where something was born
--    is a defect, not a difference of opinion, so the database refuses it rather
--    than storing both and letting readers pick.
--
--    This does NOT block the CLI's normal path: it writes exactly one such edge
--    at create time, and `write_edge` upserts on (src_id, dst_id, type).
-- -----------------------------------------------------------------------------
create unique index if not exists edges_created_in_source_idx
  on public.edges(src_id) where type = 'created_in';

-- -----------------------------------------------------------------------------
-- 3. internal.guard_w1_edge — VERBATIM 065 BODY + one `elsif` for created_in's
--    'client_claim' default. See the shared-object notice above.
-- -----------------------------------------------------------------------------
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
