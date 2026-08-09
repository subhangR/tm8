-- =============================================================================
-- 086 — `loop`, the scheduled-work core kind.
--
-- Design: docs/features/dreamer-dispatcher/DESIGN.md §4.4 (D6).
--
-- A loop is a schedule expression plus a spawn configuration. Each firing
-- derives a task, spawns a session on it, and edges the result back to the loop
-- (`triggered_by`), so run history IS the loop's edge neighbourhood and there is
-- no second run table to keep consistent with the graph.
--
-- SHARED-OBJECT NOTICE, same as 053/055/056/057: §3 REPLACES
-- `internal.entity_content`. Its body is copied verbatim from 057 (the latest
-- definition) plus one `loop` arm. Omitting an arm is SILENT — content resolves
-- to '{}'::jsonb forever and every assertion that only checks for success stays
-- green. That is why db/test/loop_rpcs.test.mjs asserts new kinds' CONTENT.
--
-- CRUD rides `entities.create`/`entities.patch` through the doors below, the
-- 056 pattern exactly: zero new catalog rows. The only catalog row this whole
-- feature adds is `execution.dispatch` (087).
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry. `entity_kinds_guard_core` (005) fires on UPDATE/DELETE only, so
--    the seed is an ordinary insert (053/056 precedent).
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('loop', 'core', null, 'repeat')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. Detail table.
--
--    `team_member_id` NULL is meaningful, not missing: it means "route this
--    through the dispatcher" (§4.4). That is why it is nullable and why the
--    executor branches on it rather than on a separate mode column — one
--    nullable FK cannot disagree with itself the way a flag plus an id can.
--
--    `next_run_at` is the only scheduling state the executor reads. `last_*`
--    are reporting columns; nothing branches on them, so a stale one cannot
--    misfire anything.
--
--    Column names `entity_id` and `updated_at` are load-bearing:
--    snapshot_entity_version() reads both unqualified.
-- -----------------------------------------------------------------------------
create table public.loops (
  entity_id      uuid primary key references public.entities(id) on delete cascade,
  -- Title lives on the DETAIL row, not on `public.entities`, which has no title
  -- column at all: every kind carries its own and `entity_content` hands the
  -- whole row up. A loop that stored its title anywhere else would render blank.
  title          text not null check (length(btrim(title)) between 1 and 200),
  schedule       text not null check (length(btrim(schedule)) between 1 and 200),
  team_member_id uuid references public.entities(id) on delete set null,
  subject_id     uuid references public.entities(id) on delete set null,
  prompt         text not null default '' check (length(prompt) <= 20000),
  config         jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  enabled        boolean not null default true,
  last_run_at    timestamptz,
  next_run_at    timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- The executor's only hot query: due loops, cheapest first. Partial on
-- `enabled` because a disabled loop is never due by definition.
create index loops_due_idx on public.loops (next_run_at)
  where enabled and next_run_at is not null;

create trigger loops_validate_kind
before insert or update of entity_id on public.loops
for each row execute function internal.validate_detail_envelope('loop');

create trigger loops_touch_updated_at before update on public.loops
for each row execute function internal.touch_updated_at();

create trigger loops_w2_snapshot_version after update on public.loops
for each row execute function internal.snapshot_entity_version();

alter table public.loops enable row level security;

create policy loops_select on public.loops for select to tm8_app
  using (internal.entity_readable(entity_id));

grant select on public.loops to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. Content hydration. See the SHARED-OBJECT NOTICE above. Body copied from
--    057 verbatim; the `loop` arm is the only addition.
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
-- 4. `triggered_by` — run history as edges (§4.4).
--
--    src is the thing a firing produced (the derived task, and the session
--    spawned on it), dst is the loop. Reading a loop's run history is one
--    inbound-edge walk; there is no run table to fall out of step with the
--    graph it describes.
-- -----------------------------------------------------------------------------
insert into public.edge_types (type, src_kinds, dst_kinds, description, props_schema, acyclic, append_only)
values
  ('triggered_by', array['task', 'work_session'], array['loop'],
   'This task or session exists because that loop fired. The loop''s inbound triggered_by edges ARE its run history.',
   jsonb_build_object('type', 'object', 'properties', jsonb_build_object(
      'firedAt', jsonb_build_object('type', 'string')),
     'additionalProperties', false),
   false, false)
on conflict (type) do nothing;

-- -----------------------------------------------------------------------------
-- 5. Create door. Ledger label `entities.create` — a loop is an ordinary
--    entity to every client; only its detail row is special.
-- -----------------------------------------------------------------------------
create or replace function public.create_loop(
  p_space_id uuid, p_title text, p_actor_id uuid default null,
  p_schedule text default null, p_team_member_id uuid default null,
  p_subject_id uuid default null, p_prompt text default '',
  p_config jsonb default '{}'::jsonb, p_enabled boolean default true,
  p_next_run_at timestamptz default null,
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  loop_id uuid;
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
    raise exception 'loop title is required (1..200 chars after trim)' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_schedule, ''))) not between 1 and 200 then
    raise exception 'loop schedule is required (1..200 chars after trim)' using errcode = '22023';
  end if;

  -- Both references must live in THIS space. Without these two checks a loop
  -- could name a teammate or a subject from another space and fire across the
  -- boundary every period, under the loop creator's authority — a scheduled
  -- confused deputy. The FKs alone do not say "same space".
  if p_team_member_id is not null then
    perform 1 from public.entities e
      where e.id = p_team_member_id and e.space_id = p_space_id
        and e.kind = 'team_member' and e.deleted_at is null;
    if not found then
      raise exception 'loop team_member_id must name a live team_member in this space'
        using errcode = '23503';
    end if;
  end if;
  if p_subject_id is not null then
    perform 1 from public.entities e
      where e.id = p_subject_id and e.space_id = p_space_id and e.deleted_at is null;
    if not found then
      raise exception 'loop subject_id must name a live entity in this space'
        using errcode = '23503';
    end if;
  end if;

  loop_id := internal.create_envelope(p_space_id, 'loop', actor, p_parent_id, p_position);
  insert into public.loops(entity_id, title, schedule, team_member_id, subject_id, prompt,
                           config, enabled, next_run_at)
  values (loop_id, btrim(p_title), btrim(p_schedule), p_team_member_id, p_subject_id,
          coalesce(p_prompt, ''), coalesce(p_config, '{}'::jsonb),
          coalesce(p_enabled, true), p_next_run_at);
  perform internal.record_initial_version(loop_id, actor);

  activity_id := internal.record_activity(p_space_id, loop_id, actor, 'created',
                   null, jsonb_build_object('kind', 'loop'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(loop_id, null, activity_id, array[loop_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Update door.
--
--    `p_next_run_at` is writable here because the EXECUTOR advances it through
--    this same door — one writer, one audit trail, rather than a scheduler that
--    reaches around the command ledger to UPDATE a table directly.
-- -----------------------------------------------------------------------------
create or replace function public.update_loop(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_schedule text default null,
  p_team_member_id uuid default null, p_clear_team_member boolean default false,
  p_subject_id uuid default null, p_clear_subject boolean default false,
  p_prompt text default null, p_config jsonb default null,
  p_enabled boolean default null,
  p_next_run_at timestamptz default null, p_clear_next_run_at boolean default false,
  p_last_run_at timestamptz default null,
  p_last_error text default null, p_clear_last_error boolean default false,
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
  e := internal.live_entity(p_entity_id, 'loop');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  if p_schedule is not null and length(btrim(p_schedule)) not between 1 and 200 then
    raise exception 'loop schedule must be 1..200 chars after trim' using errcode = '22023';
  end if;
  -- Same-space containment as the create door: a patch is just as capable of
  -- pointing a loop across a space boundary as a create is.
  if p_team_member_id is not null then
    perform 1 from public.entities tm
      where tm.id = p_team_member_id and tm.space_id = e.space_id
        and tm.kind = 'team_member' and tm.deleted_at is null;
    if not found then
      raise exception 'loop team_member_id must name a live team_member in this space'
        using errcode = '23503';
    end if;
  end if;
  if p_subject_id is not null then
    perform 1 from public.entities s
      where s.id = p_subject_id and s.space_id = e.space_id and s.deleted_at is null;
    if not found then
      raise exception 'loop subject_id must name a live entity in this space'
        using errcode = '23503';
    end if;
  end if;

  if p_title is not null and length(btrim(p_title)) not between 1 and 200 then
    raise exception 'loop title must be 1..200 chars after trim' using errcode = '22023';
  end if;

  update public.loops
     set title          = coalesce(btrim(p_title), title),
         schedule       = coalesce(btrim(p_schedule), schedule),
         team_member_id = case when p_clear_team_member then null
                               else coalesce(p_team_member_id, team_member_id) end,
         subject_id     = case when p_clear_subject then null
                               else coalesce(p_subject_id, subject_id) end,
         prompt         = coalesce(p_prompt, prompt),
         config         = coalesce(p_config, config),
         enabled        = coalesce(p_enabled, enabled),
         next_run_at    = case when p_clear_next_run_at then null
                               else coalesce(p_next_run_at, next_run_at) end,
         last_run_at    = coalesce(p_last_run_at, last_run_at),
         last_error     = case when p_clear_last_error then null
                                else coalesce(p_last_error, last_error) end,
         updated_at     = now()
   where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'loop')), array[p_entity_id]));
end
$$;

-- 008's wholesale grant was a one-time statement; functions created afterwards
-- need their own (050/053/056 precedent). Full argument signatures — nothing is
-- inherited.
revoke all on function public.create_loop(uuid,text,uuid,text,uuid,uuid,text,jsonb,boolean,timestamptz,uuid,double precision,text) from public;
grant execute on function public.create_loop(uuid,text,uuid,text,uuid,uuid,text,jsonb,boolean,timestamptz,uuid,double precision,text) to tm8_app;
revoke all on function public.update_loop(uuid,integer,uuid,text,text,uuid,boolean,uuid,boolean,text,jsonb,boolean,timestamptz,boolean,timestamptz,text,boolean,text) from public;
grant execute on function public.update_loop(uuid,integer,uuid,text,text,uuid,boolean,uuid,boolean,text,jsonb,boolean,timestamptz,boolean,timestamptz,text,boolean,text) to tm8_app;

reset role;
