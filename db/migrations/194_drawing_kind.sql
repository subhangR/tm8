-- =============================================================================
-- 194 — `drawing`, the Excalidraw canvas core kind (task 01a09575, Subhang's
-- rulings 2026-09-17).
--
-- D1: a drawing is a FIRST-CLASS ENTITY, not a graph type and not a doc
-- format. Both cheaper homes were offered with their costs measured and both
-- were declined: a drawing gets its own palette row, its own panel, its own
-- slug and its own list treatment.
--
-- D2: the scene is stored in EXCALIDRAW'S OWN THREE PARTS — `elements`,
-- `app_state`, `files` — not as one opaque blob. The split is what makes
-- phase 2 (embedded images) a change to ONE column instead of a reshape of
-- the row, and it gives the projector an element count for free, exactly as
-- 135 gets node/edge counts from `jsonb_array_length`.
--
-- D3: PHASE 1 REFUSES EMBEDDED IMAGES. `files` exists and is constrained to
-- an object, but the doors below reject a non-empty one BY NAME. An
-- Excalidraw scene stores pasted images as base64 inside `files`, so allowing
-- them today means a single paste writes tens of megabytes into a row that
-- has no image lifecycle behind it. Phase 2 splits them to `public.files`
-- (which already exists with on-disk blobs) and then relaxes exactly this
-- check. The refusal is explicit rather than a silent size failure so the UI
-- can warn BEFORE the user loses work.
--
-- D4: single-writer. There is no collaboration machinery here: a drawing is
-- patched under `internal.assert_version` like every other entity, and two
-- editors race to an ordinary version conflict. Live multiplayer is a later
-- phase and needs a separate excalidraw-room server, not a migration.
--
-- NUMBERED 194, MEASURED 2026-09-17 against ALL remote refs (`git ls-tree` of
-- db/migrations over every origin branch). The union's max is 193 — main's
-- head is only 186, and `origin/feat/architecture_security` holds 187..193
-- unmerged. Taking main's previous+1 would have collided with SEVEN files.
-- The union is the measure, never previous+1 (135's own numbering note).
--
-- SHARED-OBJECT NOTICE, same as 053/055/056/057/091/135/176/177: §3 REPLACES
-- `internal.entity_content`. Its body is copied VERBATIM from 177 — the
-- latest definition in the chain (057 -> 091 -> 135 -> 176 -> 177; verified
-- no file between 178 and 193 on any remote ref touches it) — plus one
-- `drawing` arm. Omitting an arm is SILENT: that kind's content resolves to
-- '{}'::jsonb forever.
--
-- CRUD rides `entities.create`/`entities.patch` through the doors below —
-- the 056/091/135 pattern exactly: ZERO new catalog rows in this feature.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry. `entity_kinds_guard_core` (005) fires on UPDATE/DELETE only, so
--    the seed is an ordinary insert (053/056/091/135 precedent).
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('drawing', 'core', null, 'pen-tool')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 1b. `attached_to` must accept a drawing as a SOURCE.
--
--     This is how a drawing hangs off a task (Subhang's ruling: "while
--     creating task, user should be able to create a drawing and attach to
--     task"). The obvious reading — make the task the drawing's PARENT — is
--     refused by `validate_entity_parent`, which requires parent.kind =
--     child.kind with exactly one ruled exception (chat -> work_session).
--     `parent_id` is homogeneous hierarchy; attachment is this edge, and the
--     server's `attachInitialConnections` already writes it for every kind
--     but task/doc when `entities.create` carries `attachTo`.
--
--     APPEND, NOT A FULL-ARRAY REWRITE. 052's own header records why: a later
--     full-array UPDATE silently drops every kind an earlier migration
--     appended, and 052 is where that already happened once. The guard also
--     makes this idempotent. `dst_kinds` is already '{*}', so a drawing can
--     attach to anything without touching it.
-- -----------------------------------------------------------------------------
update public.edge_types
   set src_kinds = array_append(src_kinds, 'drawing')
 where type = 'attached_to'
   and not ('drawing' = any(src_kinds));

-- -----------------------------------------------------------------------------
-- 2. Detail table.
--
--    Column names `entity_id` and `updated_at` are load-bearing:
--    snapshot_entity_version() reads both unqualified, which is also what
--    gives a drawing history-as-a-unit — every saved revision of the canvas
--    is an `entities.versions` snapshot of this whole row.
--
--    `format` is a SLUG GRAMMAR, not a closed list (135's R3 lesson): a
--    second canvas format later is a contract/UI change, never a migration.
--
--    No size CHECK on the jsonb columns: a CHECK must be IMMUTABLE and
--    neither `pg_column_size` nor a `::text` cast qualifies. The cap is
--    enforced in the doors below, where any function is legal — the same
--    place 135 does its validation.
-- -----------------------------------------------------------------------------
create table public.drawings (
  entity_id  uuid primary key references public.entities(id) on delete cascade,
  -- Title lives on the DETAIL row: `public.entities` has no title column at
  -- all (091 precedent).
  title      text not null check (length(btrim(title)) between 1 and 200),
  format     text not null default 'excalidraw'
             check (format ~ '^[a-z0-9][a-z0-9_-]{0,48}$'),
  -- The Excalidraw scene, in its own three parts (D2).
  elements   jsonb not null default '[]'::jsonb check (jsonb_typeof(elements) = 'array'),
  app_state  jsonb not null default '{}'::jsonb check (jsonb_typeof(app_state) = 'object'),
  -- Phase 2 lands here. Constrained to an object today; the doors refuse a
  -- non-empty one (D3).
  files      jsonb not null default '{}'::jsonb check (jsonb_typeof(files) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger drawings_validate_kind
before insert or update of entity_id on public.drawings
for each row execute function internal.validate_detail_envelope('drawing');

create trigger drawings_touch_updated_at before update on public.drawings
for each row execute function internal.touch_updated_at();

create trigger drawings_w2_snapshot_version after update on public.drawings
for each row execute function internal.snapshot_entity_version();

alter table public.drawings enable row level security;

create policy drawings_select on public.drawings for select to tm8_app
  using (internal.entity_readable(entity_id));

grant select on public.drawings to tm8_app;

-- -----------------------------------------------------------------------------
-- 2b. Shared validation for both doors. Kept as ONE function so the create
--     door and the update door cannot drift — the phase-2 image work relaxes
--     it in exactly one place.
--
--     1,000,000 chars of element JSON is roughly a few thousand shapes: far
--     beyond any hand-drawn board, and small enough that a runaway client
--     cannot write an unbounded row.
-- -----------------------------------------------------------------------------
create or replace function internal.assert_drawing_scene(
  p_elements jsonb, p_app_state jsonb, p_files jsonb
) returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
begin
  if p_elements is not null and jsonb_typeof(p_elements) <> 'array' then
    raise exception 'drawing elements must be a JSON array' using errcode = '22023';
  end if;
  if p_app_state is not null and jsonb_typeof(p_app_state) <> 'object' then
    raise exception 'drawing appState must be a JSON object' using errcode = '22023';
  end if;
  if p_files is not null and jsonb_typeof(p_files) <> 'object' then
    raise exception 'drawing files must be a JSON object' using errcode = '22023';
  end if;
  -- D3: the phase-1 refusal, BY NAME so a client can show it verbatim.
  if p_files is not null and p_files <> '{}'::jsonb then
    raise exception 'drawing embedded images are not supported yet (phase 2): remove the image, or link a file entity'
      using errcode = '22023';
  end if;
  if p_elements is not null and length(p_elements::text) > 1000000 then
    raise exception 'drawing is too large (% chars of elements; limit 1000000)', length(p_elements::text)
      using errcode = '22023';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. Content hydration. See the SHARED-OBJECT NOTICE above. Body copied from
--    177 verbatim; the `drawing` arm is the only addition.
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
      when 'worktree' then select to_jsonb(w) - 'entity_id' into content from public.worktrees w where w.entity_id = target;
      when 'loop' then select to_jsonb(l) - 'entity_id' into content from public.loops l where l.entity_id = target;
      when 'graph' then select to_jsonb(g) - 'entity_id' into content from public.graphs g where g.entity_id = target;
      when 'chat' then select to_jsonb(c) - 'entity_id' - 'cwd' - 'native_session_id' - 'client_mutation_id'
                       into content from public.chats c where c.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      when 'container' then select to_jsonb(c) - 'entity_id' - 'runtime_ref' - 'host_spec'
                              into content from public.containers c where c.entity_id = target;
      when 'drawing' then select to_jsonb(d) - 'entity_id' into content from public.drawings d where d.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. Create door. Ledger label `entities.create` — a drawing is an ordinary
--    entity to every client; only its detail row is special (091/135 pattern).
--
--    `p_parent_id` is how a drawing is ATTACHED TO A TASK (Subhang's ruling:
--    "while creating task, user should be able to create a drawing and attach
--    to task"). It is the same child door every other kind takes; no separate
--    attachment concept is introduced.
-- -----------------------------------------------------------------------------
create or replace function public.create_drawing_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null,
  p_format text default 'excalidraw',
  p_elements jsonb default '[]'::jsonb, p_app_state jsonb default '{}'::jsonb,
  p_files jsonb default '{}'::jsonb,
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  drawing_id uuid;
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

  if length(btrim(coalesce(p_title, ''))) not between 1 and 200 then
    raise exception 'drawing title is required (1..200 chars after trim)' using errcode = '22023';
  end if;
  if coalesce(p_format, '') !~ '^[a-z0-9][a-z0-9_-]{0,48}$' then
    raise exception 'drawing format must be a lowercase slug (got %)', p_format using errcode = '22023';
  end if;
  perform internal.assert_drawing_scene(p_elements, p_app_state, p_files);

  drawing_id := internal.create_envelope(p_space_id, 'drawing', actor, p_parent_id, p_position);
  insert into public.drawings(entity_id, title, format, elements, app_state, files)
  values (drawing_id, btrim(p_title), p_format,
          coalesce(p_elements, '[]'::jsonb), coalesce(p_app_state, '{}'::jsonb),
          coalesce(p_files, '{}'::jsonb));
  perform internal.record_initial_version(drawing_id, actor);

  activity_id := internal.record_activity(p_space_id, drawing_id, actor, 'created',
                   null, jsonb_build_object('kind', 'drawing'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(drawing_id, null, activity_id, array[drawing_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Update door.
--
--    `null` MERGES (the loop/graph pattern): a patch carries only the members
--    it changes, which is what makes a debounced canvas save cheap — the
--    editor sends elements and appState and never restates the title.
--
--    There is no explicit clear: every column has a non-null default and
--    "empty" is '[]'/'{}', never null.
-- -----------------------------------------------------------------------------
create or replace function public.update_drawing_entity(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_format text default null,
  p_elements jsonb default null, p_app_state jsonb default null,
  p_files jsonb default null,
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
  e := internal.live_entity(p_entity_id, 'drawing');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  if p_title is not null and length(btrim(p_title)) not between 1 and 200 then
    raise exception 'drawing title must be 1..200 chars after trim' using errcode = '22023';
  end if;
  if p_format is not null and p_format !~ '^[a-z0-9][a-z0-9_-]{0,48}$' then
    raise exception 'drawing format must be a lowercase slug (got %)', p_format using errcode = '22023';
  end if;
  perform internal.assert_drawing_scene(p_elements, p_app_state, p_files);

  update public.drawings
     set title      = coalesce(btrim(p_title), title),
         format     = coalesce(p_format, format),
         elements   = coalesce(p_elements, elements),
         app_state  = coalesce(p_app_state, app_state),
         files      = coalesce(p_files, files),
         updated_at = now()
   where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'drawing')), array[p_entity_id]));
end
$$;

-- 008's wholesale grant was a one-time statement; functions created afterwards
-- need their own (050/053/056/091/135 precedent). Full argument signatures.
revoke all on function public.create_drawing_entity(uuid,text,uuid,text,jsonb,jsonb,jsonb,uuid,double precision,text) from public;
grant execute on function public.create_drawing_entity(uuid,text,uuid,text,jsonb,jsonb,jsonb,uuid,double precision,text) to tm8_app;
revoke all on function public.update_drawing_entity(uuid,integer,uuid,text,text,jsonb,jsonb,jsonb,text) from public;
grant execute on function public.update_drawing_entity(uuid,integer,uuid,text,text,jsonb,jsonb,jsonb,text) to tm8_app;

reset role;
