-- =============================================================================
-- 223 — entity_headers: LENIENT (ruling msg 01a0d6f1-5cc4, 2026-09-25).
--
-- Headers are routing hints an agent writes on the way past. A refusal costs a
-- wasted tool call and fixes nothing, so header CONTENT is never validated: it
-- is normalised, and the limits (whenToUse ≈ 400, summary ≈ 600, ≤ 12 keywords
-- of ≤ 40) are guidance in the help, the MCP guides and the prompt only. Readers
-- clip for display and declare it (`clipped`, packages/server/src/headers/resolve.ts).
--
-- 216 is merged and may be applied, so it is never edited. This file carries the
-- FULL new bodies of every function it changes: migrate.mjs applies by filename,
-- so the higher-numbered file is the one Postgres keeps.
--
-- WHAT CHANGES
--   1. The length/blank CHECKs on entity_headers go (when_to_use, summary,
--      keywords, and the table-level "when_to_use or summary"), and with them
--      internal.valid_header_keywords. The version / pinned_version > 0 checks
--      stay. The names are Postgres's generated ones, dropped IF EXISTS; the
--      block after them ASSERTS no content CHECK is left, whatever it was named.
--   2. set_entity_header normalises instead of refusing: text is trimmed and a
--      field that trims to nothing is NULL; blank keywords are dropped and
--      duplicates removed, first occurrence kept. No length or count raises.
--      A keywords-only header is fine.
--      A set with NOTHING left after that is a no-op: it returns the current
--      header (the facade resolves it) and warning `header_empty`. It is never
--      an implicit clear, so a flagless `tm8 entity header set` cannot destroy
--      a header; `entities.header.clear` is the only way to remove one.
--   3. A kind that cannot carry a header (skill, memory, work_session, chat,
--      message, c:*, any other) is a no-op SUCCESS with warning
--      `header_not_stored` saying why, not 22023. The allowlist still decides
--      what is STORED (216's reasons stand); it just never refuses. The kind
--      check therefore moves out of header_target into the two doors, after
--      the authorisation header_target still does (space member, RLS read, the
--      teammate owner/admin rule).
--   4. clear_entity_header: the expected version is optional (NULL =
--      unguarded). No header is a no-op success (warning `header_absent`), not
--      P0002. An EXPLICIT expected version that mismatches still raises 40001:
--      the caller asked for the guard.
--
-- KEPT: a header write never moves entities.version; staleness is computed at
-- read; ledger replay; an activity row only when a header row is written or
-- deleted (never on a no-op).
-- =============================================================================

set role tm8_graph_owner;

alter table public.entity_headers drop constraint if exists entity_headers_when_to_use_check;
alter table public.entity_headers drop constraint if exists entity_headers_summary_check;
alter table public.entity_headers drop constraint if exists entity_headers_keywords_check;
alter table public.entity_headers drop constraint if exists entity_headers_check;

do $assert$
declare
  leftover text;
begin
  select string_agg(conname || ': ' || pg_get_constraintdef(oid), '; ') into leftover
    from pg_constraint
   where conrelid = 'public.entity_headers'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ~ '(when_to_use|summary|keywords)';
  if leftover is not null then
    raise exception '223: entity_headers still carries a content CHECK: %', leftover;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.entity_headers'::regclass and contype = 'c'
                    and pg_get_constraintdef(oid) ~ 'pinned_version > 0') then
    raise exception '223: entity_headers lost its pinned_version > 0 CHECK';
  end if;
end
$assert$;

drop function if exists internal.valid_header_keywords(text[]);

-- Header text as stored: trimmed of whitespace; blank is NULL.
create or replace function internal.header_text(p_text text)
returns text language sql immutable set search_path = public, internal, pg_temp as $$
  select nullif(btrim(p_text, E' \t\r\n\f\v'), '')
$$;

-- Why a kind stores no header: the `header_not_stored` warning a caller gets
-- instead of a refusal.
create or replace function internal.header_not_stored_warning(p_kind text)
returns jsonb language sql immutable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object('code', 'header_not_stored', 'message',
    case
      when p_kind = 'skill' then
        'a skill carries no separate header: it is routed by its own description and when_to_use; nothing was stored'
      when p_kind = 'memory' then
        'a memory carries no separate header: it is routed by its subject_scope; nothing was stored'
      when p_kind in ('work_session', 'chat', 'message') then
        format('a %s is referenced by id alone and carries no header; nothing was stored', p_kind)
      else
        format('a %s cannot carry a selection header; nothing was stored', p_kind)
    end)
$$;

-- The write prologue both doors share: a live entity, the caller a member of
-- its space and able to read it (a restricted entity's header is as closed as
-- the entity), the actor resolved and bound. The edit right is the one patching
-- the entity needs: for most kinds space membership; for a team_member also
-- update_team_member's rule (007/038), the owning member or a space admin.
-- The KIND is no longer checked here (223): the doors turn a kind that cannot
-- carry a header into a no-op with a warning, after this authorisation.
create or replace function internal.header_target(p_entity_id uuid, p_actor_id uuid)
returns table (entity public.entities, actor uuid)
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  who uuid;
begin
  e := internal.live_entity(p_entity_id);
  perform internal.require_space_member(e.space_id);
  if not internal.entity_readable(p_entity_id) then
    raise exception 'entity % not found', p_entity_id using errcode = 'P0002';
  end if;
  who := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(who);
  if e.kind = 'team_member'
     and not internal.is_space_admin(e.space_id)
     and (select tm.owner_member_id from public.team_members tm where tm.entity_id = e.id)
         is distinct from internal.current_member_id(e.space_id) then
    raise exception 'only the owning member or a space admin may change this teammate''s header'
      using errcode = '42501';
  end if;
  return query select e, who;
end
$$;

-- Set (create or replace) an entity's header. The whole header is written: a
-- null field is absent. Nothing is refused for content (see the file head).
-- The row is re-pinned to the entity's current version (and body ref), so
-- re-saving unchanged text is "mark current".
create or replace function public.set_entity_header(
  p_entity_id uuid, p_expected_header_version integer default null, p_actor_id uuid default null,
  p_when_to_use text default null, p_summary text default null, p_keywords text[] default '{}',
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  target record;
  e public.entities;
  actor uuid;
  current_row public.entity_headers;
  saved public.entity_headers;
  when_to_use text := internal.header_text(p_when_to_use);
  summary text := internal.header_text(p_summary);
  keywords text[];
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.header.set');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  select * into target from internal.header_target(p_entity_id, p_actor_id);
  e := target.entity;
  actor := target.actor;

  if not internal.header_kind_allowed(e.kind) then
    return internal.ledger_record(p_client_mutation_id, 'entities.header.set',
             internal.command_result(e.id)
               || jsonb_build_object('warnings', jsonb_build_array(internal.header_not_stored_warning(e.kind))));
  end if;

  select coalesce(array_agg(k order by first_at), '{}') into keywords
    from (select internal.header_text(raw) as k, min(ord) as first_at
            from unnest(coalesce(p_keywords, '{}')) with ordinality as u(raw, ord)
           where internal.header_text(raw) is not null
           group by internal.header_text(raw)) dedup;

  -- Serialize concurrent writers of one header on the entity row, then check
  -- the header's own version.
  perform 1 from public.entities where id = e.id for no key update;
  select * into current_row from public.entity_headers where entity_id = e.id;
  perform internal.assert_header_version(e.id, p_expected_header_version, current_row.version);

  if when_to_use is null and summary is null and cardinality(keywords) = 0 then
    return internal.ledger_record(p_client_mutation_id, 'entities.header.set',
             internal.command_result(e.id)
               || jsonb_build_object('warnings', jsonb_build_array(jsonb_build_object(
                    'code', 'header_empty',
                    'message', 'every header field was empty after trimming, so nothing was written; '
                            || 'the header in effect is unchanged (to remove one, use entities.header.clear)'))));
  end if;

  insert into public.entity_headers as h
         (entity_id, space_id, when_to_use, summary, keywords, pinned_version, pinned_ref, version, author_id, updated_at)
  values (e.id, e.space_id, when_to_use, summary, keywords,
          (select version from public.entities where id = e.id),
          internal.header_body_ref(e.id, e.kind), 1, actor, now())
  on conflict (entity_id) do update
     set when_to_use = excluded.when_to_use,
         summary = excluded.summary,
         keywords = excluded.keywords,
         pinned_version = excluded.pinned_version,
         pinned_ref = excluded.pinned_ref,
         version = h.version + 1,
         author_id = excluded.author_id,
         updated_at = now()
  returning * into saved;

  activity_id := internal.record_activity(e.space_id, e.id, actor, 'updated', null,
                   jsonb_build_object('kind', e.kind, 'fields', jsonb_build_array('header'), 'header', 'set'));
  return internal.ledger_record(p_client_mutation_id, 'entities.header.set',
           internal.command_result(e.id, null, activity_id)
             || jsonb_build_object('header', internal.header_projection(saved)));
end
$$;

-- Remove an entity's header; it falls back to native/derived at the next read.
-- The expected header version is optional: NULL is last-writer-wins, an
-- explicit one must match (0 = "no header"). Nothing to clear is a no-op.
create or replace function public.clear_entity_header(
  p_entity_id uuid, p_expected_header_version integer default null, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  target record;
  e public.entities;
  actor uuid;
  current_row public.entity_headers;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.header.clear');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  select * into target from internal.header_target(p_entity_id, p_actor_id);
  e := target.entity;
  actor := target.actor;

  if not internal.header_kind_allowed(e.kind) then
    return internal.ledger_record(p_client_mutation_id, 'entities.header.clear',
             internal.command_result(e.id)
               || jsonb_build_object('warnings', jsonb_build_array(internal.header_not_stored_warning(e.kind))));
  end if;

  perform 1 from public.entities where id = e.id for no key update;
  select * into current_row from public.entity_headers where entity_id = e.id;
  perform internal.assert_header_version(e.id, p_expected_header_version, current_row.version);
  if current_row.entity_id is null then
    return internal.ledger_record(p_client_mutation_id, 'entities.header.clear',
             internal.command_result(e.id)
               || jsonb_build_object('warnings', jsonb_build_array(jsonb_build_object(
                    'code', 'header_absent',
                    'message', 'the entity has no authored header, so there was nothing to clear'))));
  end if;
  delete from public.entity_headers where entity_id = e.id;

  activity_id := internal.record_activity(e.space_id, e.id, actor, 'updated', null,
                   jsonb_build_object('kind', e.kind, 'fields', jsonb_build_array('header'), 'header', 'cleared'));
  return internal.ledger_record(p_client_mutation_id, 'entities.header.clear',
           internal.command_result(e.id, null, activity_id));
end
$$;

revoke all on function internal.header_text(text) from public;
revoke all on function internal.header_not_stored_warning(text) from public;
revoke all on function internal.header_target(uuid, uuid) from public;
revoke all on function public.set_entity_header(uuid, integer, uuid, text, text, text[], text) from public;
grant execute on function public.set_entity_header(uuid, integer, uuid, text, text, text[], text) to tm8_app;
revoke all on function public.clear_entity_header(uuid, integer, uuid, text) from public;
grant execute on function public.clear_entity_header(uuid, integer, uuid, text) to tm8_app;

reset role;
