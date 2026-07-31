-- =============================================================================
-- 056 — Memories: the `memory` core entity kind, its mark-edge vocabulary, and
-- append-only enforcement for epistemic history.
--
-- Design: docs/plans/TM8-MEMORY-DESIGN-FINAL.md, corrected by
-- docs/plans/TM8-FOUNDATION-VERIFICATION.md (V4 refuted the design's D2 trigger:
-- an unconditional append-only trigger on public.edges breaks the FK purge
-- cascade — `spaces → entities → edges` are `on delete cascade` TODAY, so space
-- deletion would fail on the first flagged edge. §4 below carries the required
-- exemption; db/test/memory.test.mjs carries the red/green pair).
--
-- What this file does NOT do, because 052_edge_guard_multi_kind.sql already did
-- it (shared prerequisite, owned by no feature — do not redo, do not touch):
--   * `authored_from.src_kinds` widened to {message, memory, artifact};
--   * `internal.guard_w1_edge` writer set includes `memory_recorder`;
--   * `edges_authored_from_message_idx` renamed to `edges_authored_from_source_idx`
--     (the UNIQUE one-per-source predicate is load-bearing for §6's
--     verification-independence check — never drop or widen it);
--   * `attached_to.src_kinds` includes `memory`.
--
-- ⚠ SHARED-OBJECT NOTICES (the 052/053 rule):
--   * §3 replaces `internal.entity_content`. Base text is copied from 055 (the
--     latest definition in the chain: 001 → 005 → 011 → 015 → 017 → 053 → 055),
--     plus ONE `memory` arm — so it carries BOTH the `voice_channel` (053) and
--     `artifact` (055) arms. The worktrees lane needs an arm here too: whoever
--     writes next must copy THIS file's body, not 055's or 053's, or the
--     `memory` arm silently vanishes. Verify with pg_get_functiondef against a
--     scratch chain.
--   * §7 replaces `public.write_edge`. Base text is copied from 018 (the latest
--     definition: 007 → 018), with ONE semantic edit marked `-- 056:` — undo
--     tokens are suppressed for append-only edge types (the token would be dead
--     on arrival; `edges.delete` on them is refused 23514). Same copy-forward
--     rule applies.
--
-- RELEASE ATOMICITY: the `memory` kind seed in §1 must ship in the SAME change
-- as the `CoreEntityKind` contract entry (packages/contract/src/contract.ts),
-- the kind-dispositions row, and both dispatch-arm sets (facade/entity-read.ts
-- AND events/projector.ts) — SQL-first kills the projector lane at runtime with
-- `EntityKindDriftError`. This migration is one half of one atomic unit.
--
-- Standing hazard, pre-existing and NOT introduced here (flagged, not fixed):
-- `internal.guard_w1_edge` refuses DELETE of `authored_from` edges without a
-- writer token, INCLUDING inside an FK purge cascade — so a hard delete of a
-- space containing any message/memory provenance edge already fails today at
-- 42501. That is 052/015 territory, shared, and out of this file's scope.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry: core kind #17. `entity_kinds_guard_core` (005) fires on
--    UPDATE/DELETE only, so the seed is an ordinary insert (053 precedent).
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('memory', 'core', null, 'brain')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. Detail table. The scope fields are NOT NULL with btrim length checks —
--    a single space satisfies bare NOT NULL and defeats the point. Column names
--    `entity_id` and `updated_at` are load-bearing: snapshot_entity_version()
--    reads both unqualified.
-- -----------------------------------------------------------------------------
create table public.memories (
  entity_id          uuid primary key references public.entities(id) on delete cascade,
  statement          text not null check (length(btrim(statement)) between 1 and 4000),
  mechanism          text not null check (length(btrim(mechanism)) between 1 and 1000),
  subject_scope      text not null check (length(btrim(subject_scope)) between 1 and 1000),
  does_not_establish text not null check (length(btrim(does_not_establish)) between 1 and 1000),
  measured_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger memories_validate_kind
before insert or update of entity_id on public.memories
for each row execute function internal.validate_detail_envelope('memory');

create trigger memories_touch_updated_at before update on public.memories
for each row execute function internal.touch_updated_at();

-- The step four kinds missed for sixteen migrations (017's header). INSERT does
-- not fire this; create_memory calls record_initial_version explicitly.
create trigger memories_w2_snapshot_version after update on public.memories
for each row execute function internal.snapshot_entity_version();

alter table public.memories enable row level security;

create policy memories_select on public.memories for select to tm8_app
  using (internal.entity_readable(entity_id));

grant select on public.memories to tm8_app;

-- Memories do not participate in entity hierarchy: a memory parented under a
-- memory would be a second, unpinned relationship mechanism competing with
-- `supersedes`. `HIERARCHY_DISABLED_KINDS` on the read path only HIDES the
-- hierarchy; this refuses it where it is unreachable (design §6.4).
create or replace function internal.guard_memory_no_parent() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  raise exception 'memory entities do not participate in hierarchy; relate memories with supersedes or about edges'
    using errcode = '23514';
end
$$;

create trigger entities_memory_no_parent
before insert or update of parent_id on public.entities
for each row when (new.kind = 'memory' and new.parent_id is not null)
execute function internal.guard_memory_no_parent();

-- -----------------------------------------------------------------------------
-- 3. Content hydration. See the SHARED-OBJECT NOTICE at the top of this file.
--    Body: 055's, verbatim, plus the `memory` arm. Omitting an arm is SILENT —
--    content resolves to '{}'::jsonb forever (verified, V3).
-- -----------------------------------------------------------------------------
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then return null; end if;
  if e.kind like 'c:%' then
    select jsonb_build_object('title', c.title, 'fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case e.kind
      when 'task' then select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'voice_channel' then select to_jsonb(v) - 'entity_id' into content from public.voice_channels v where v.entity_id = target;
      when 'artifact' then select to_jsonb(a) - 'entity_id' into content from public.artifacts a where a.entity_id = target;
      when 'memory' then select to_jsonb(m) - 'entity_id' into content from public.memories m where m.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. Append-only enforcement: registry flag + row trigger.
--
--    Three mutation doors exist (edges.delete, edges.patch, AND edges.create —
--    write_edge is an upsert whose `on conflict do update` rewrites props), so
--    an operation-layer guard covers two doors of a three-door room. The
--    trigger covers all three: the upsert's DO UPDATE arm fires BEFORE UPDATE.
--
--    ⚠ V4 (TM8-FOUNDATION-VERIFICATION.md): the FK purge cascade fires this
--    trigger as part of the same statement, whoever owns the table. Without an
--    exemption, `delete from entities` — and, because `spaces → entities` and
--    `entities → edges` cascade TODAY, deleting a SPACE — fails on the first
--    flagged edge. A cascaded delete reaches this row INSIDE the FK's internal
--    RI trigger, so pg_trigger_depth() > 1 there; a direct client delete
--    arrives with only this trigger on the stack (depth 1). DELETE at
--    depth > 1 is therefore the purge cascade and is permitted; everything
--    else is refused. db/test/memory.test.mjs proves both directions.
-- -----------------------------------------------------------------------------
alter table public.edge_types add column append_only boolean not null default false;

create or replace function internal.guard_append_only_edge() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare flagged boolean;
begin
  select append_only into flagged from public.edge_types t where t.type = old.type;
  if not coalesce(flagged, false) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    -- The entity/space purge cascade (V4). The epistemic record dies with its
    -- graph, not by hand.
    return old;
  end if;
  raise exception 'edge type % is append-only; corrections are a new evidence entity and a new edge', old.type
    using errcode = '23514';
end
$$;

create trigger edges_append_only_guard
before update or delete on public.edges
for each row execute function internal.guard_append_only_edge();

-- -----------------------------------------------------------------------------
-- 5. The mark-edge vocabulary (design §3.2). Six new registry rows, one flip on
--    the shipped `copy_of`. Every props_schema closes with
--    `additionalProperties: false` — the first consumers of the closed-schema
--    branch 018 built and left dead. `authored_from` is deliberately ABSENT
--    here: 052 owns its registry row.
-- -----------------------------------------------------------------------------
insert into public.edge_types (type, src_kinds, dst_kinds, description, props_schema, acyclic, append_only) values
  ('about', array['memory'], array['*'],
   'Subject routing: this memory concerns X. Mutable and unpinned — filing errors must be correctable.',
   jsonb_build_object('type', 'object', 'properties', '{}'::jsonb, 'additionalProperties', false),
   false, false),
  ('based_on', array['memory'], array['*'],
   'Epistemic dependency, version-pinned. Drift is derived at read time from pinnedVersion < target.version.',
   jsonb_build_object('type', 'object', 'properties', jsonb_build_object(
      'pinnedVersion', jsonb_build_object('type', 'integer'),
      'pinnedAt', jsonb_build_object('type', 'string'),
      'build', jsonb_build_object('type', 'object')),
    'required', jsonb_build_array('pinnedVersion', 'pinnedAt'),
    'additionalProperties', false),
   false, true),
  ('supersedes', array['memory'], array['memory'],
   'Successor marks predecessor. Reads resolve to the chain head.',
   jsonb_build_object('type', 'object', 'properties', jsonb_build_object(
      'reason', jsonb_build_object('type', 'string')),
    'required', jsonb_build_array('reason'),
    'additionalProperties', false),
   true, true),
  ('disputes', array['message','memory'], array['*'],
   'The cheap suspect mark. Source must be evidence-bearing, so a dispute without evidence is structurally impossible.',
   jsonb_build_object('type', 'object', 'properties', jsonb_build_object(
      'quote', jsonb_build_object('type', 'string'),
      'expected', jsonb_build_object('type', 'string'),
      'observed', jsonb_build_object('type', 'string'),
      'citation', jsonb_build_object('type', 'string'),
      'pinnedVersion', jsonb_build_object('type', 'integer')),
    'required', jsonb_build_array('quote', 'expected', 'observed', 'pinnedVersion'),
    'additionalProperties', false),
   false, true),
  ('verifies', array['message','memory'], array['*'],
   'The expensive clear: mechanism, answered disputes, current-version pin, and a checked independence basis.',
   jsonb_build_object('type', 'object', 'properties', jsonb_build_object(
      'mechanism', jsonb_build_object('type', 'string'),
      'answers', jsonb_build_object('type', 'array'),
      'pinnedVersion', jsonb_build_object('type', 'integer'),
      'independenceBasis', jsonb_build_object('type', 'string')),
    'required', jsonb_build_array('mechanism', 'answers', 'pinnedVersion', 'independenceBasis'),
    'additionalProperties', false),
   false, true),
  ('remembers', array['member','team_member','work_session'], array['memory'],
   'Owner association: whose memory set this belongs to. Mutable — an actor''s memory set needs correcting.',
   jsonb_build_object('type', 'object', 'properties', jsonb_build_object(
      'note', jsonb_build_object('type', jsonb_build_array('string', 'null'))),
    'additionalProperties', false),
   false, false);

-- The shipped restatement edge gains a pin convention and immutability.
update public.edge_types
   set append_only = true,
       props_schema = jsonb_build_object('type', 'object', 'properties', jsonb_build_object(
          'pinnedVersion', jsonb_build_object('type', 'integer'),
          'source', jsonb_build_object('type', 'string')),
        'required', jsonb_build_array('pinnedVersion', 'source'),
        'additionalProperties', false)
 where type = 'copy_of';

-- -----------------------------------------------------------------------------
-- 6. The semantic verification trigger (design §3.4, §5.1 item 11). Named to
--    sort AFTER edges_props_schema and edges_validate (alphabetical trigger
--    order), so required-prop and kind errors surface as 22023/23514 from the
--    generic validators before this trigger reads the props it needs.
-- -----------------------------------------------------------------------------
create or replace function internal.guard_verifies_semantics() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
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
$$;

create trigger edges_verifies_semantic_guard
before insert on public.edges
for each row when (new.type = 'verifies')
execute function internal.guard_verifies_semantics();

-- -----------------------------------------------------------------------------
-- 7. write_edge, replaced. See the SHARED-OBJECT NOTICE at the top of this
--    file. Body: 018's, verbatim, with ONE semantic edit marked `-- 056:`.
-- -----------------------------------------------------------------------------
create or replace function public.write_edge(
  p_src_id uuid, p_dst_id uuid, p_type text, p_props jsonb default '{}'::jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  replay jsonb;
  src public.entities;
  dst public.entities;
  actor uuid;
  edge_id uuid;
  activity_id uuid;
  project_resource uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'edges.create');
  if replay is not null then return replay; end if;
  if coalesce(p_props, '{}'::jsonb) ? 'origin' then
    raise exception 'edge props.origin is Server-owned' using errcode = '42501';
  end if;
  -- `in_project` has a stricter lock order than generic graph writes.  Resolve
  -- the projection mapping even when the envelope was concurrently hidden,
  -- lock ProjectResource first, and keep every unlink race on the frozen
  -- project_not_linked path instead of degrading to a generic not_found.
  if p_type = 'in_project' then
    select project_id into project_resource
      from public.project_projection_details where entity_id = p_dst_id;
    if project_resource is null then
      raise exception 'Project projection has no resource mapping'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
    perform 1 from public.projects where id = project_resource for update;
    select * into dst from public.entities where id = p_dst_id and deleted_at is null;
    if dst.id is null then
      raise exception 'Project is not actively linked to this Space'
        using errcode = '23514', detail = 'project_not_linked';
    end if;
  else
    dst := internal.live_entity(p_dst_id);
  end if;
  src := internal.live_entity(p_src_id);
  if src.space_id <> dst.space_id then
    raise exception 'edge endpoints must be in the same space' using errcode = '23514';
  end if;
  perform internal.require_space_member(src.space_id);
  actor := internal.resolve_actor(p_actor_id, src.space_id);
  perform internal.bind_actor(actor);

  insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
  values (src.space_id, p_src_id, p_dst_id, p_type, coalesce(p_props, '{}'::jsonb), actor)
  on conflict (src_id, dst_id, type) do update
    set props = excluded.props
      || case when public.edges.props ? 'origin'
           then jsonb_build_object('origin', public.edges.props -> 'origin')
           else '{}'::jsonb end,
        updated_at = now()
  returning id into edge_id;

  activity_id := internal.record_activity(
    src.space_id, p_src_id, actor, 'linked', edge_id,
    jsonb_build_object('type', p_type, 'dstId', p_dst_id));
  -- 056: append-only edge types mint NO undo token. Their edges.delete is
  -- refused (23514, §4), so the token would be dead on arrival — suppressed at
  -- creation rather than left to fail at redemption (design D2).
  if coalesce((select t.append_only from public.edge_types t where t.type = p_type), false) then
    return internal.ledger_record(
      p_client_mutation_id,
      'edges.create',
      internal.command_result(null, edge_id, activity_id, array[p_src_id, p_dst_id]));
  end if;
  return internal.ledger_record(
    p_client_mutation_id,
    'edges.create',
    internal.command_result(
      null, edge_id, activity_id, array[p_src_id, p_dst_id],
      internal.issue_undo_token(
        src.space_id, actor, 'Undo link', 'edges.delete',
        jsonb_build_object('edgeId', edge_id))));
end
$$;

-- -----------------------------------------------------------------------------
-- 8. The two doors. Both join EXISTING ledger labels (`entities.create`,
--    `entities.patch`), so the catalog gains ZERO operations. Replay shape
--    copied from the live definitions (046 is the current
--    require_replay_principal/subject shape; 053 is the create precedent, 038
--    the patch precedent). The 22023 pre-validation is mandatory: SQLSTATE
--    23502 is absent from the error map and would surface as a retryable 503
--    for a write that can never succeed (review F5).
-- -----------------------------------------------------------------------------
create or replace function public.create_memory(
  p_space_id uuid, p_statement text, p_mechanism text, p_subject_scope text,
  p_does_not_establish text, p_measured_at timestamptz default null,
  p_actor_id uuid default null, p_position double precision default null,
  p_work_session_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  memory_id uuid;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  if length(btrim(coalesce(p_statement, ''))) not between 1 and 4000 then
    raise exception 'memory statement is required (1..4000 chars after trim)' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_mechanism, ''))) not between 1 and 1000 then
    raise exception 'memory mechanism is required (1..1000 chars after trim)' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_subject_scope, ''))) not between 1 and 1000 then
    raise exception 'memory subject_scope is required (1..1000 chars after trim)' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_does_not_establish, ''))) not between 1 and 1000 then
    raise exception 'memory does_not_establish is required (1..1000 chars after trim)' using errcode = '22023';
  end if;

  -- No parent parameter exists: memories are outside hierarchy (§2), and no
  -- title parameter exists: the title is DERIVED from the statement at read
  -- time, so a restatement with no back-link cannot be manufactured here.
  memory_id := internal.create_envelope(p_space_id, 'memory', actor, null, p_position);
  insert into public.memories(entity_id, statement, mechanism, subject_scope, does_not_establish, measured_at)
  values (memory_id, btrim(p_statement), btrim(p_mechanism), btrim(p_subject_scope),
          btrim(p_does_not_establish), p_measured_at);
  perform internal.record_initial_version(memory_id, actor);

  -- Provenance is server-written under the 052 writer token, NEVER a client
  -- `connections` entry: if agents could forge authored_from, verification
  -- independence (§6) would be self-certified. Shape mirrors the message
  -- recorder (019): the acting actor must participate in the named session.
  if p_work_session_id is not null then
    perform 1 from public.entities e
      join public.work_sessions ws on ws.entity_id = e.id
     where e.id = p_work_session_id and e.space_id = p_space_id and e.deleted_at is null
       and exists (select 1 from public.edges edge
                    where edge.src_id = actor and edge.dst_id = p_work_session_id
                      and edge.type = 'participates_in')
     for update;
    if not found then
      raise exception 'authored_from provenance does not match the acting session'
        using errcode = '42501';
    end if;
    perform internal.w1_set_writer('memory_recorder');
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, memory_id, p_work_session_id, 'authored_from', actor);
    perform internal.w1_set_writer('');
  end if;

  activity_id := internal.record_activity(p_space_id, memory_id, actor, 'created',
                   null, jsonb_build_object('kind', 'memory'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(memory_id, null, activity_id, array[memory_id]));
end
$$;

create or replace function public.update_memory(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_statement text default null, p_mechanism text default null,
  p_subject_scope text default null, p_does_not_establish text default null,
  p_measured_at timestamptz default null, p_clear_measured_at boolean default false,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_entity_id, 'memory');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  -- Edits are for typos: any material edit bumps the version (snapshot
  -- trigger), which un-pins every inbound verification — the machinery treats
  -- an edited claim as changed, because it is. A materially wrong memory is
  -- superseded, never edited.
  if p_statement is not null and length(btrim(p_statement)) not between 1 and 4000 then
    raise exception 'memory statement must be 1..4000 chars after trim' using errcode = '22023';
  end if;
  if p_mechanism is not null and length(btrim(p_mechanism)) not between 1 and 1000 then
    raise exception 'memory mechanism must be 1..1000 chars after trim' using errcode = '22023';
  end if;
  if p_subject_scope is not null and length(btrim(p_subject_scope)) not between 1 and 1000 then
    raise exception 'memory subject_scope must be 1..1000 chars after trim' using errcode = '22023';
  end if;
  if p_does_not_establish is not null and length(btrim(p_does_not_establish)) not between 1 and 1000 then
    raise exception 'memory does_not_establish must be 1..1000 chars after trim' using errcode = '22023';
  end if;

  update public.memories
     set statement = coalesce(btrim(p_statement), statement),
         mechanism = coalesce(btrim(p_mechanism), mechanism),
         subject_scope = coalesce(btrim(p_subject_scope), subject_scope),
         does_not_establish = coalesce(btrim(p_does_not_establish), does_not_establish),
         measured_at = case when p_clear_measured_at then null
                            else coalesce(p_measured_at, measured_at) end,
         updated_at = now()
   where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'memory')), array[p_entity_id]));
end
$$;

-- 008's wholesale grant was a one-time statement; functions created afterwards
-- need their own (050/053 precedent). Full argument signatures — nothing is
-- inherited.
revoke all on function public.create_memory(uuid,text,text,text,text,timestamptz,uuid,double precision,uuid,text) from public;
grant execute on function public.create_memory(uuid,text,text,text,text,timestamptz,uuid,double precision,uuid,text) to tm8_app;
revoke all on function public.update_memory(uuid,integer,uuid,text,text,text,text,timestamptz,boolean,text) from public;
grant execute on function public.update_memory(uuid,integer,uuid,text,text,text,text,timestamptz,boolean,text) to tm8_app;

reset role;
