-- =============================================================================
-- 053 — Voice channels (Discord-style, self-hosted LiveKit SFU).
--
-- Adds the `voice_channel` core entity kind and its detail table. This file is
-- the DB half of the voice feature; the SFU is a separate process and no audio
-- byte ever reaches Postgres. The participant roster is deliberately NOT stored
-- anywhere here — it is ephemeral, lives in server memory, and is rebuilt from
-- LiveKit webhooks (contract.ts:114 "a live read … never stored"). A table for
-- it would be a lie that survives a crash.
--
-- ⚠ SHARED-OBJECT NOTICE, in the spirit of 052's rule.
-- §4 below does `create or replace function internal.entity_content`. That
-- swaps the ENTIRE body, so the lexically-later migration silently wins and the
-- earlier feature's `when` arm vanishes with no error and no failing test. The
-- base text here is copied verbatim from 017 (the latest definition at the time
-- of writing; 001 → 005 → 011 → 015 → 017), plus one arm. THE MEMORIES,
-- WORKTREES AND ARTIFACTS LANES ALL NEED AN ARM IN THIS FUNCTION TOO: whoever
-- writes next must copy THIS file's body, not 017's, or `voice_channel` content
-- hydration disappears. Verify with pg_get_functiondef against a scratch chain,
-- never by reading the migration that introduced the function.
--
-- Shape notes:
--   * modeled on `channel` (001 §6, 008 §2/§3, 017, 036) — same envelope
--     trigger, same RLS-inherits-the-envelope policy, same typed create RPC;
--   * NO `topic` and no message anchor: a voice room has no feed. `name` is the
--     only content column, under the same slug constraint channels use, so the
--     rail can render `🔊 general` without a second naming grammar;
--   * unique (space_id, name) mirrors channels — two voice rooms in one space
--     cannot share a name, and the LiveKit room name is the entity id anyway.
-- =============================================================================

-- OWNERSHIP. Everything the graph owns is owned by `tm8_graph_owner`, and this
-- is not cosmetic. `internal.command_entity` is SECURITY DEFINER owned by that
-- role, so the moment a create RPC returns its command result the effective
-- user becomes tm8_graph_owner — which then reads the detail table through
-- `internal.entity_content`. An object created as the migrating superuser
-- instead is invisible to that hop and every create fails with `permission
-- denied for table voice_channels`, AFTER the row has been inserted. Measured,
-- not assumed: the first draft of this file omitted the `set role` and failed
-- exactly there. `reset role` at the bottom is equally load-bearing — the
-- runner's `applied_migrations` write happens on this same session and fails
-- (rolling the whole chain back) if the session is left under the role.
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry.
-- -----------------------------------------------------------------------------
-- `entity_kinds_guard_core` (005) fires on UPDATE/DELETE only, so seeding a new
-- core kind is an ordinary insert. Idempotent on the partial unique index the
-- 015 seed uses, for the same reason 015 used it.
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('voice_channel', 'core', null, 'volume-2')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. Detail table.
-- -----------------------------------------------------------------------------
create table public.voice_channels (
  entity_id  uuid primary key references public.entities(id) on delete cascade,
  space_id   uuid not null references public.spaces(id) on delete cascade,
  name       text not null check (name ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, name)
);

-- The envelope trigger is what makes the kind real: a detail row whose entity
-- is not of kind `voice_channel`, or whose space_id disagrees with the
-- envelope, raises rather than creating a half-typed entity (001 §6).
create trigger voice_channels_validate_kind
before insert or update of entity_id on public.voice_channels
for each row execute function internal.validate_detail_envelope('voice_channel');

create trigger voice_channels_touch_updated_at before update on public.voice_channels
for each row execute function internal.touch_updated_at();

-- Content-bearing detail tables are versioned (017 §1).
create trigger voice_channels_w2_snapshot_version after update on public.voice_channels
for each row execute function internal.snapshot_entity_version();

-- -----------------------------------------------------------------------------
-- 3. RLS + grants. Detail tables inherit the envelope's visibility, uniformly
--    (008 §2). SELECT only — no INSERT/UPDATE/DELETE is granted to anyone here
--    either; §5's RPC is the write surface (008 §3).
-- -----------------------------------------------------------------------------
alter table public.voice_channels enable row level security;

create policy voice_channels_select on public.voice_channels for select to tm8_app
  using (internal.entity_readable(entity_id));

grant select on public.voice_channels to tm8_app;

-- -----------------------------------------------------------------------------
-- 4. Content hydration. See the SHARED-OBJECT NOTICE at the top of this file
--    before replacing this function again.
--    Body: 017's, verbatim, plus the `voice_channel` arm.
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
-- 5. The typed create RPC — `entities.create` with kind `voice_channel` routes
--    here. Body mirrors public.create_channel as replaced in 036 (replay
--    principal + subject checks, membership, actor binding, envelope, detail
--    row, initial version, activity, ledger record) minus the topic argument.
-- -----------------------------------------------------------------------------
create or replace function public.create_voice_channel(
  p_space_id uuid, p_name text, p_actor_id uuid default null,
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  voice_id uuid;
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
  voice_id := internal.create_envelope(p_space_id, 'voice_channel', actor, p_parent_id, p_position);
  insert into public.voice_channels(entity_id, space_id, name)
  values (voice_id, p_space_id, lower(btrim(p_name)));
  perform internal.record_initial_version(voice_id, actor);
  activity_id := internal.record_activity(p_space_id, voice_id, actor, 'created',
                   null, jsonb_build_object('kind', 'voice_channel'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(voice_id, null, activity_id, array[voice_id]));
end
$$;

-- 008's wholesale `grant execute on all functions in schema public` was a
-- one-time statement, so a function created afterwards needs its own grant
-- (the 050 precedent).
revoke all on function public.create_voice_channel(uuid,text,uuid,uuid,double precision,text) from public;
grant execute on function public.create_voice_channel(uuid,text,uuid,uuid,double precision,text) to tm8_app;

reset role;
