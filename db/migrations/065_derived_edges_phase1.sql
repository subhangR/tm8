-- =============================================================================
-- 065 — Derived edges, phase 1: make relations that already exist in Postgres
--       visible IN THE GRAPH, and keep them that way automatically.
--
-- Context: docs/graph/ (root: README.md). Measured before this file:
-- 31 edge types registered, 9 ever written. 170 messages each carry a NOT NULL
-- `messages.anchor_id` and NO edge type could represent it, so a channel with
-- 14 messages returned `nodes: 1, edges: 0` from `graph.query` — a graph
-- isolate. `participates_in` had ONE row across 152 sessions, because the 015
-- backfill ran once and nothing has written it since.
--
-- The session->session type (`messaged`) backfills ZERO, and that is the finding,
-- not a bug in this file. `session_message_deliveries.source_work_session_id` is
-- NULL in all 67 rows: it is fed by `resolveAuthoredFromWorkSessionId`
-- (messages-handoffs.ts:307 -> :325), the same unwired composition-root seam that
-- keeps `authored_from` empty. One seam, two symptoms. The registry row and the
-- trigger below are therefore the FORWARD half only — they light up the moment
-- that resolver is wired, with no further migration. (An earlier note claimed 25
-- pairs; that came from `count(distinct (a,b))`, which counts `(NULL, x)` tuples
-- and so counted 25 distinct TARGETS with no known sender.)
--
-- The shape of every derivation here is the same, and it is deliberate:
--   BACKFILL what exists + a TRIGGER so it never goes stale again.
-- A backfill without a trigger decays from the next write onward, and a
-- half-populated edge type is worse than an absent one — it reads as an answer.
--
-- WHY TRIGGERS AND NOT RPC EDITS. The obvious place to write `participates_in`
-- is `public.execution_spawn`. That is a shared body on the critical spawn
-- path, and replacing it is the 052/056/057 hazard (create-or-replace silently
-- drops other lanes' arms). A trigger on the `relates_to` edge that spawn
-- ALREADY writes achieves the same thing, touches no shared body, and works
-- against the frozen server snapshot on 7777/7778 because it is pure SQL.
--
-- ⚠ SHARED-OBJECT NOTICE (the 052/053/055/056/057 rule, continued).
-- §3 does `create or replace function internal.guard_w1_edge`. That swaps the
-- ENTIRE body, so the lexically-later migration silently wins and every earlier
-- feature's branch vanishes with no error. The base text here is copied
-- verbatim from 052 (still the latest definition — verified with
-- pg_get_functiondef against tm8_stable before writing, not by reading 015),
-- plus TWO type names on ONE line (`anchored_to`, `messaged`). WHOEVER WRITES THE
-- NEXT ARM MUST COPY THIS FILE'S BODY, NOT 052'S.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO:
--   * It does not write `authored_from`. Backfilling `participates_in` was
--     described as unblocking it; that is MEASURED FALSE and the measurement is
--     why this file exists in this shape. All three recorders require
--     `edges.src_id = <acting actor>`, the `participates_in` src is the
--     `team_member`, and the acting actor for an agent's CLI call is the space
--     OWNER MEMBER (`identity get` → `actingAs: null`). So the precondition is
--     now satisfiable but not satisfied. `authored_from` needs the agent-token
--     work first. See docs/graph/06-SESSION-PROVENANCE.md.
--   * It does not stamp `working_on`/`relates_to` at all. That WAS the plan and
--     it is measured wrong — spawn claims no writer token, so the stamp would
--     read `origin: 'user'` on every machine-written edge. See §1. Nor does it
--     invent origins for rows that predate it: which of those were machine-
--     written is exactly the fact that was lost, and absent origin honestly
--     means "written before 065".
--   * It does not make `anchored_to`/`messaged` recorder-owned. That branch has
--     no `pg_trigger_depth()` exemption (only `forward_compensation`), so a
--     cascade delete of a message — an ordinary operation, 170 rows live —
--     would raise 42501. They are stamped, not owned.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry. Two new types. Both `additionalProperties: true` and both
--    declare `origin`, because §3 stamps them.
-- -----------------------------------------------------------------------------
insert into public.edge_types(type, src_kinds, dst_kinds, description, acyclic, props_schema) values
  ('anchored_to', array['message'], array['*'],
   'Server-derived projection of messages.anchor_id: this message hangs on that entity',
   false,
   jsonb_build_object(
     'type', 'object',
     'properties', jsonb_build_object('origin', jsonb_build_object('type', 'string')),
     'additionalProperties', true)),
  ('messaged', array['work_session'], array['work_session'],
   'Server-derived from session_message_deliveries: this session addressed that session',
   false,
   jsonb_build_object(
     'type', 'object',
     'properties', jsonb_build_object('origin', jsonb_build_object('type', 'string')),
     'additionalProperties', true))
on conflict (type) do nothing;

-- NOT DONE HERE, ON PURPOSE: adding `working_on` and `relates_to` to the §3
-- stamping list. It was planned, built, and then MEASURED WRONG, so it is out.
--   The stamp is `coalesce(nullif(writer,''),'user')`, and `public.execution_spawn`
--   (048:90-100) claims NO writer token when it inserts those two edges — the
--   only `w1_set_writer('spawn')` in the tree is 015:1127, scoped tightly around
--   the `in_project` insert and cleared four lines later. So stamping them would
--   label every one of spawn's own machine-written edges `origin: 'user'`: a FALSE
--   provenance claim, which is the precise failure this whole change exists to
--   fix. A missing label beats a wrong one.
--   The fix is one line — `w1_set_writer('spawn')` around 048:90-100 — but that
--   is `execution_spawn`, a shared body on the critical launch path, and
--   migration 064 (another lane, uncommitted at the time of writing) is actively
--   reshaping that same path. Sequence it with that lane, then add the two names
--   to §3's list. Nothing here needs to change first.

-- -----------------------------------------------------------------------------
-- 2. Writer tokens used below: `anchor_recorder`, `delivery_recorder`. The
--    existing `backfill` token is reused for the participates_in pass, which is
--    what internal.w1_backfill_participant already sets (015).
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 3. internal.guard_w1_edge — VERBATIM 052 BODY + two names on the stamping
--    line, so the two edge types this file derives carry the recorder that wrote
--    them (`anchor_recorder` / `delivery_recorder`) and a hand-drawn one would
--    carry `user`. See §1 for why `working_on`/`relates_to` are NOT in this list.
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
-- -----------------------------------------------------------------------------
-- 4. Derivation A — participates_in from the relates_to edge spawn writes.
--
--    internal.w1_backfill_participant (015) already does this exactly right:
--    it refuses when a participant exists, resolves the team_member from the
--    relates_to pair, requires EXACTLY ONE candidate, locks the session, stamps
--    origin='backfill', and audits an unresolved case instead of guessing. This
--    file adds no logic — it just calls it at the right moment.
-- -----------------------------------------------------------------------------
create or replace function internal.derive_participant_from_relates() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  -- spawn writes work_session -relates_to-> team_member (048:97). Only that
  -- shape implies participation; a user's relates_to between anything else must
  -- not manufacture a participant.
  if exists (select 1 from public.entities s
              where s.id = new.src_id and s.kind = 'work_session' and s.deleted_at is null)
     and exists (select 1 from public.entities d
                  where d.id = new.dst_id and d.kind = 'team_member' and d.deleted_at is null)
  then
    perform internal.w1_backfill_participant(new.src_id);
  end if;
  return null;
end
$$;

drop trigger if exists edges_derive_participant on public.edges;
create trigger edges_derive_participant after insert on public.edges
for each row when (new.type = 'relates_to')
execute function internal.derive_participant_from_relates();

-- -----------------------------------------------------------------------------
-- 5. Derivation B — anchored_to from messages.anchor_id.
--
--    anchor_id is NOT NULL and never updated, so this edge is a pure projection
--    of a column that already exists. Insert-only trigger; no update path to
--    mirror. `created_by` is the message author, which is the only actor the
--    row knows about.
-- -----------------------------------------------------------------------------
create or replace function internal.derive_message_anchor() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare msg_space uuid; anchor_space uuid;
begin
  select space_id into msg_space from public.entities where id = new.entity_id;
  select space_id into anchor_space from public.entities where id = new.anchor_id;
  -- validate_edge would raise on a cross-space pair; a message whose anchor is
  -- somehow elsewhere must not take the whole post down over a derived edge.
  if msg_space is null or anchor_space is null or msg_space <> anchor_space then
    return null;
  end if;
  perform internal.w1_set_writer('anchor_recorder');
  insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
  values (msg_space, new.entity_id, new.anchor_id, 'anchored_to', '{}'::jsonb, new.author_id)
  on conflict do nothing;
  perform internal.w1_set_writer(null);
  return null;
end
$$;

drop trigger if exists messages_derive_anchor on public.messages;
create trigger messages_derive_anchor after insert on public.messages
for each row execute function internal.derive_message_anchor();

-- -----------------------------------------------------------------------------
-- 6. Derivation C — messaged from session_message_deliveries.
--
--    Written on delivery RESERVATION, not on success: "these two sessions
--    addressed each other" is true of a failed attempt too, and the delivery
--    ledger keeps the per-attempt outcome. 67 delivery rows collapse to 25
--    pairs; the (src,dst,type) unique constraint does the collapsing.
--    source_work_session_id is nullable (a human-originated message), and those
--    rows derive nothing.
-- -----------------------------------------------------------------------------
create or replace function internal.derive_session_messaged() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare src_space uuid; dst_space uuid; author uuid;
begin
  if new.source_work_session_id is null
     or new.source_work_session_id = new.target_work_session_id then
    return null;
  end if;
  select space_id into src_space from public.entities where id = new.source_work_session_id;
  select space_id into dst_space from public.entities where id = new.target_work_session_id;
  if src_space is null or dst_space is null or src_space <> dst_space then
    return null;
  end if;
  select created_by into author from public.entities where id = new.source_work_session_id;
  perform internal.w1_set_writer('delivery_recorder');
  insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
  values (src_space, new.source_work_session_id, new.target_work_session_id,
          'messaged', '{}'::jsonb, author)
  on conflict do nothing;
  perform internal.w1_set_writer(null);
  return null;
end
$$;

drop trigger if exists deliveries_derive_messaged on public.session_message_deliveries;
create trigger deliveries_derive_messaged after insert on public.session_message_deliveries
for each row execute function internal.derive_session_messaged();

-- -----------------------------------------------------------------------------
-- 7. Backfills. All three are idempotent (`on conflict do nothing`, and
--    w1_backfill_participant returns 0 when a participant exists), so a re-run
--    is a no-op and this file is safe under the runner's checksum ledger.
-- -----------------------------------------------------------------------------
do $backfill$
declare
  s record;
  participants integer := 0;
  anchors integer := 0;
  pairs integer := 0;
begin
  -- 7a. participates_in for every existing session.
  for s in select entity_id from public.work_sessions order by entity_id loop
    participants := participants + internal.w1_backfill_participant(s.entity_id);
  end loop;

  -- 7b. anchored_to for every existing message.
  perform internal.w1_set_writer('anchor_recorder');
  with inserted as (
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    select me.space_id, m.entity_id, m.anchor_id, 'anchored_to', '{}'::jsonb, m.author_id
      from public.messages m
      join public.entities me on me.id = m.entity_id
      join public.entities ae on ae.id = m.anchor_id
     where ae.space_id = me.space_id
     order by m.created_at, m.entity_id
    on conflict do nothing
    returning 1
  ) select count(*) into anchors from inserted;
  perform internal.w1_set_writer(null);

  -- 7c. messaged for every existing delivery pair.
  perform internal.w1_set_writer('delivery_recorder');
  with inserted as (
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    select distinct on (d.source_work_session_id, d.target_work_session_id)
           se.space_id, d.source_work_session_id, d.target_work_session_id,
           'messaged', '{}'::jsonb, se.created_by
      from public.session_message_deliveries d
      join public.entities se on se.id = d.source_work_session_id
      join public.entities te on te.id = d.target_work_session_id
     where d.source_work_session_id is not null
       and d.source_work_session_id <> d.target_work_session_id
       and te.space_id = se.space_id
    on conflict do nothing
    returning 1
  ) select count(*) into pairs from inserted;
  perform internal.w1_set_writer(null);

  raise notice '065 backfill: participates_in=% anchored_to=% messaged=%',
    participants, anchors, pairs;
end
$backfill$;

reset role;
