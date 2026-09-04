-- =============================================================================
-- 135 — `graph`, the blueprint/diagram core kind (Craft P1, task 01a00a31,
-- rulings R1-R3 on task 01a00a0b, 2026-08-16).
--
-- R1: a graph is an entity — ONE ROW holds vertices AND edges. Referenced
-- entities stay outside in the space; the flow between them lives inside the
-- row. It is not a collection (mere membership) and it never re-materializes
-- its wiring as `public.edges` rows while being crafted: each real edge write
-- fires four triggers and bumps `activity_at` on both endpoints, so a craft
-- session staying inside one row is what keeps crafting free of side effects.
--
-- R2: LEAN BY LAW. `nodes`/`edges` are sketches (`{key, id | spec}`,
-- `{src,dst,type,note}`) that the orchestrating agent interprets at
-- materialize time. The checks below assert only container types — array,
-- object — never a program schema; the door RPCs stay equally permissive.
--
-- R3: content-discriminated `graph_type` — 'entity' (orchestratable
-- blueprint), 'mermaid' (durable diagram source, `source` column), future
-- types later. The type check is a SLUG GRAMMAR, not a closed list, so a new
-- graph type is a contract/UI change only, never a migration.
--
-- NUMBERED 135: measured 2026-08-16 against ALL remote refs (`git ls-tree`
-- of db/migrations over every origin branch) — the union's max is 134, and
-- no reservation message names 135 (the chain has raced twice; the union
-- plus reservations is the measure, never previous+1). This lane also takes
-- 136 (craft chat mode) and 137 (menu craft tab).
--
-- SHARED-OBJECT NOTICE, same as 053/055/056/057/091: §3 REPLACES
-- `internal.entity_content`. Its body is copied verbatim from 091 (the latest
-- definition — verified: 099/064 only CALL it) plus one `graph` arm. Omitting
-- an arm is SILENT — content resolves to '{}'::jsonb forever — which is why
-- db/test/graph_rpcs.test.mjs asserts the new kind's CONTENT.
--
-- CRUD rides `entities.create`/`entities.patch` through the doors below, the
-- 056/091 pattern exactly: ZERO new catalog rows in this whole feature —
-- crafting is create + version-guarded patch, orchestration is the existing
-- delegation surface.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry. `entity_kinds_guard_core` (005) fires on UPDATE/DELETE only, so
--    the seed is an ordinary insert (053/056/091 precedent).
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('graph', 'core', null, 'workflow')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. Detail table.
--
--    Column names `entity_id` and `updated_at` are load-bearing:
--    snapshot_entity_version() reads both unqualified — which is also what
--    gives blueprints their history-as-a-unit (`entities.versions` snapshots
--    the whole row; real edges hard-delete with no history).
--
--    `source` is nullable and NULL means "this graph type has no text
--    source" — an entity-type blueprint. A mermaid graph stores its diagram
--    text here and typically keeps nodes/edges empty.
-- -----------------------------------------------------------------------------
create table public.graphs (
  entity_id  uuid primary key references public.entities(id) on delete cascade,
  -- Title lives on the DETAIL row, not on `public.entities`, which has no
  -- title column at all (091 precedent).
  title      text not null check (length(btrim(title)) between 1 and 200),
  graph_type text not null default 'entity'
             check (graph_type ~ '^[a-z0-9][a-z0-9_-]{0,48}$'),
  nodes      jsonb not null default '[]'::jsonb check (jsonb_typeof(nodes) = 'array'),
  edges      jsonb not null default '[]'::jsonb check (jsonb_typeof(edges) = 'array'),
  -- Presentation only; renderers fall back to a first-seen grid without it.
  layout     jsonb not null default '{}'::jsonb check (jsonb_typeof(layout) = 'object'),
  source     text check (source is null or length(source) <= 200000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger graphs_validate_kind
before insert or update of entity_id on public.graphs
for each row execute function internal.validate_detail_envelope('graph');

create trigger graphs_touch_updated_at before update on public.graphs
for each row execute function internal.touch_updated_at();

create trigger graphs_w2_snapshot_version after update on public.graphs
for each row execute function internal.snapshot_entity_version();

alter table public.graphs enable row level security;

create policy graphs_select on public.graphs for select to tm8_app
  using (internal.entity_readable(entity_id));

grant select on public.graphs to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. Content hydration. See the SHARED-OBJECT NOTICE above. Body copied from
--    091 verbatim; the `graph` arm is the only addition.
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
-- 4. Create door. Ledger label `entities.create` — a graph is an ordinary
--    entity to every client; only its detail row is special (091 pattern).
-- -----------------------------------------------------------------------------
create or replace function public.create_graph_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null,
  p_graph_type text default 'entity',
  p_nodes jsonb default '[]'::jsonb, p_edges jsonb default '[]'::jsonb,
  p_layout jsonb default '{}'::jsonb, p_source text default null,
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  graph_id uuid;
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
    raise exception 'graph title is required (1..200 chars after trim)' using errcode = '22023';
  end if;
  if coalesce(p_graph_type, '') !~ '^[a-z0-9][a-z0-9_-]{0,48}$' then
    raise exception 'graph_type must be a lowercase slug (got %)', p_graph_type using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_nodes, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_edges, '[]'::jsonb)) <> 'array' then
    raise exception 'graph nodes and edges must be JSON arrays' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_layout, '{}'::jsonb)) <> 'object' then
    raise exception 'graph layout must be a JSON object' using errcode = '22023';
  end if;

  graph_id := internal.create_envelope(p_space_id, 'graph', actor, p_parent_id, p_position);
  insert into public.graphs(entity_id, title, graph_type, nodes, edges, layout, source)
  values (graph_id, btrim(p_title), p_graph_type,
          coalesce(p_nodes, '[]'::jsonb), coalesce(p_edges, '[]'::jsonb),
          coalesce(p_layout, '{}'::jsonb), p_source);
  perform internal.record_initial_version(graph_id, actor);

  activity_id := internal.record_activity(p_space_id, graph_id, actor, 'created',
                   null, jsonb_build_object('kind', 'graph'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(graph_id, null, activity_id, array[graph_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Update door.
--
--    `null` MERGES (the loop pattern): a patch carries only the members it
--    changes, which is what makes one-guarded-patch-per-turn crafting cheap.
--    `p_clear_source` is the only explicit clear — the other columns have
--    non-null defaults and "empty" is expressed as '[]'/'{}', never null.
-- -----------------------------------------------------------------------------
create or replace function public.update_graph_entity(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_graph_type text default null,
  p_nodes jsonb default null, p_edges jsonb default null,
  p_layout jsonb default null,
  p_source text default null, p_clear_source boolean default false,
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
  e := internal.live_entity(p_entity_id, 'graph');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  if p_title is not null and length(btrim(p_title)) not between 1 and 200 then
    raise exception 'graph title must be 1..200 chars after trim' using errcode = '22023';
  end if;
  if p_graph_type is not null and p_graph_type !~ '^[a-z0-9][a-z0-9_-]{0,48}$' then
    raise exception 'graph_type must be a lowercase slug (got %)', p_graph_type using errcode = '22023';
  end if;
  if p_nodes is not null and jsonb_typeof(p_nodes) <> 'array' then
    raise exception 'graph nodes must be a JSON array' using errcode = '22023';
  end if;
  if p_edges is not null and jsonb_typeof(p_edges) <> 'array' then
    raise exception 'graph edges must be a JSON array' using errcode = '22023';
  end if;
  if p_layout is not null and jsonb_typeof(p_layout) <> 'object' then
    raise exception 'graph layout must be a JSON object' using errcode = '22023';
  end if;

  update public.graphs
     set title      = coalesce(btrim(p_title), title),
         graph_type = coalesce(p_graph_type, graph_type),
         nodes      = coalesce(p_nodes, nodes),
         edges      = coalesce(p_edges, edges),
         layout     = coalesce(p_layout, layout),
         source     = case when p_clear_source then null
                           else coalesce(p_source, source) end,
         updated_at = now()
   where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'graph')), array[p_entity_id]));
end
$$;

-- 008's wholesale grant was a one-time statement; functions created afterwards
-- need their own (050/053/056/091 precedent). Full argument signatures.
revoke all on function public.create_graph_entity(uuid,text,uuid,text,jsonb,jsonb,jsonb,text,uuid,double precision,text) from public;
grant execute on function public.create_graph_entity(uuid,text,uuid,text,jsonb,jsonb,jsonb,text,uuid,double precision,text) to tm8_app;
revoke all on function public.update_graph_entity(uuid,integer,uuid,text,text,jsonb,jsonb,jsonb,text,boolean,text) from public;
grant execute on function public.update_graph_entity(uuid,integer,uuid,text,text,jsonb,jsonb,jsonb,text,boolean,text) to tm8_app;

reset role;
