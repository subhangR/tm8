-- =============================================================================
-- 216 — entity_headers: authored selection headers (headers design 01a0d31e
-- §2.2 / §3 / §8.3; integrated design 01a0d348 v17 §8 M2 I3 = headers T2).
--
-- WHAT IS HERE
--   1. `public.entity_headers`, 1:1 with `entities`: the text a person or
--      agent wrote to say when to pick an entity (`when_to_use`, ≤ 400) and
--      what it is (`summary`, ≤ 600), plus up to 12 keywords of ≤ 40 chars.
--   2. RLS: a header is exactly as visible as its entity
--      (`internal.entity_readable`, the `memories_select` pattern from 056).
--      No INSERT/UPDATE/DELETE grant: writes go through the two doors below.
--   3. `public.set_entity_header` / `public.clear_entity_header`, SECURITY
--      DEFINER, standard prologue, kind allowlist, own optimistic version.
--
-- NOT HERE (I4): catalog operations, HTTP, CLI. The ledger labels
-- `entities.header.set` / `entities.header.clear` are the names I4's
-- operations will carry.
--
-- WHY A SEPARATE TABLE, NOT THE ENTITY ENVELOPE (decided, msg 01a0d3bb-5031)
--   * Every `entities` UPDATE emits a full-row `entity.upsert` (165), so
--     header text on the envelope would ride in every later event, and a
--     header edit would look like an entity edit.
--   * The header has its own pin/version/author bookkeeping, which must never
--     touch `entities.version`: bumping it would un-pin every verifies/
--     disputes edge and fail every in-flight `expectedVersion` on the body.
--   * A missing row means "use the native/derived fallback" (§3.3). No
--     backfill: derived text frozen as authored rows would go stale on the next
--     edit and look like decisions nobody made (§9.1).
--
-- STALENESS (§3.2) is computed at read, never stored: a header is stale when
--   `pinned_version <> entities.version`, or, for kinds whose body changes
--   without a version bump, when `pinned_ref` differs from the live ref
--   (artifact: `artifacts.current_revision_id`; file: `files.checksum_sha256`).
--   Writing a header re-pins it. A stale header is still used, flagged.
--
-- EVENTS (open question O1, decided here): a header write records an
--   `activity` row, verb `updated`, summary `{kind, fields:["header"],
--   header:"set"|"cleared"}`. That is an `activity.created` event about the
--   entity (208's canonical subject set already covers it), so change feeds
--   see it, and no new subject or verb is needed. It does not UPDATE
--   `entities`, so no `entity.upsert` carries header text and the version
--   stays put.
--
-- ALLOWED KINDS: team_member, doc, artifact, drawing, file, task, collection.
--   Refused: skill (its header is the file's frontmatter, rewritten from disk),
--   memory (`subject_scope` is its header; a separately editable header would
--   bypass "a wrong memory is superseded"), work_session / chat (referenced by
--   id alone), message (excerpted by its own path), and every other kind. The
--   design's `c:*` custom kinds are held back until `resolveHeaders` reads
--   them: a header nobody can read would only mislead its author.
-- =============================================================================

set role tm8_graph_owner;

-- One keyword rule, usable from a CHECK (a CHECK cannot hold a subquery).
create or replace function internal.valid_header_keywords(p_keywords text[])
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select p_keywords is not null
     and cardinality(p_keywords) <= 12
     and not exists (
       select 1 from unnest(p_keywords) k
        where k is null or k <> btrim(k) or char_length(k) not between 1 and 40
     )
$$;

create table public.entity_headers (
  entity_id      uuid primary key references public.entities(id) on delete cascade,
  space_id       uuid not null references public.spaces(id) on delete cascade,
  when_to_use    text check (when_to_use is null
                             or (when_to_use = btrim(when_to_use) and char_length(when_to_use) between 1 and 400)),
  summary        text check (summary is null
                             or (summary = btrim(summary) and char_length(summary) between 1 and 600)),
  keywords       text[] not null default '{}' check (internal.valid_header_keywords(keywords)),
  -- `entities.version` the header describes.
  pinned_version integer not null check (pinned_version > 0),
  -- The body ref for kinds whose body changes without a version bump:
  -- artifact current_revision_id, file checksum_sha256. Null otherwise.
  pinned_ref     text,
  -- The header's own concurrency guard; never `entities.version`.
  version        integer not null default 1 check (version > 0),
  author_id      uuid not null references public.entities(id),
  updated_at     timestamptz not null default now(),
  check (when_to_use is not null or summary is not null)
);

-- FK indexes: a space purge and an author hard-delete each find their rows
-- without a sequential scan.
create index entity_headers_space_idx on public.entity_headers(space_id);
create index entity_headers_author_idx on public.entity_headers(author_id);

alter table public.entity_headers enable row level security;

create policy entity_headers_select on public.entity_headers for select to tm8_app
  using (internal.entity_readable(entity_id));

grant select on public.entity_headers to tm8_app;

-- The kinds that may carry an authored header: the contract's
-- SELECTION_HEADER_KINDS less skill and memory, exactly what `resolveHeaders`
-- lets an authored row override (packages/server/src/headers/derive.ts,
-- AUTHORABLE). packages/server/test/db/entity-headers.pg.test.ts pins the two together.
create or replace function internal.header_kind_allowed(p_kind text)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select p_kind in ('team_member', 'doc', 'artifact', 'drawing', 'file', 'task', 'collection')
$$;

-- The live body ref a header pins, for the kinds that have one.
create or replace function internal.header_body_ref(p_entity_id uuid, p_kind text)
returns text language sql stable security definer set search_path = public, internal, pg_temp as $$
  select case p_kind
           when 'artifact' then (select a.current_revision_id::text from public.artifacts a where a.entity_id = p_entity_id)
           when 'file'     then (select f.checksum_sha256 from public.files f where f.entity_id = p_entity_id)
         end
$$;

-- The write prologue both doors share: live entity of an allowed kind, the
-- caller a member of its space and able to read it (a restricted entity's
-- header is as closed as the entity), the actor resolved and bound. The edit
-- right is the one patching the entity needs, no more and no less.
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
  if not internal.header_kind_allowed(e.kind) then
    raise exception 'a % cannot carry a selection header', e.kind using errcode = '22023';
  end if;
  who := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(who);
  return query select e, who;
end
$$;

-- Header optimistic concurrency. `p_expected` null skips the check (as
-- `assert_version` does); 0 means "no header yet". A conflict raises 40001
-- with the header's current version (0 when absent) in DETAIL, marked
-- `subject: header` so the facade never mistakes it for the entity's version.
create or replace function internal.assert_header_version(p_entity_id uuid, p_expected integer, p_current integer)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if p_expected is not null and coalesce(p_current, 0) <> p_expected then
    raise exception 'header version conflict on %', p_entity_id
      using errcode = '40001',
            detail = jsonb_build_object('entityId', p_entity_id, 'currentVersion', coalesce(p_current, 0),
                                        'subject', 'header')::text;
  end if;
end
$$;

create or replace function internal.header_projection(h public.entity_headers)
returns jsonb language sql immutable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'entityId', h.entity_id, 'whenToUse', h.when_to_use, 'summary', h.summary,
    'keywords', to_jsonb(h.keywords), 'version', h.version,
    'pinnedVersion', h.pinned_version, 'pinnedRef', h.pinned_ref,
    'authorId', h.author_id, 'updatedAt', h.updated_at)
$$;

-- Set (create or replace) an entity's header. The whole header is written:
-- a null field is absent, so one call can clear `when_to_use` while keeping
-- `summary`. Text is trimmed; a field that trims to nothing is refused, never
-- silently dropped. Keywords are trimmed and de-duplicated in order. The row
-- is re-pinned to the entity's current version (and body ref), so re-saving
-- unchanged text is "mark current".
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
  when_to_use text := btrim(p_when_to_use);
  summary text := btrim(p_summary);
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

  if p_when_to_use is not null and char_length(when_to_use) not between 1 and 400 then
    raise exception 'header when_to_use must be 1..400 chars after trim' using errcode = '22023';
  end if;
  if p_summary is not null and char_length(summary) not between 1 and 600 then
    raise exception 'header summary must be 1..600 chars after trim' using errcode = '22023';
  end if;
  if when_to_use is null and summary is null then
    raise exception 'a header needs when_to_use or summary; clear it instead' using errcode = '22023';
  end if;
  select coalesce(array_agg(k order by first_at), '{}') into keywords
    from (select btrim(raw) as k, min(ord) as first_at
            from unnest(coalesce(p_keywords, '{}')) with ordinality as u(raw, ord)
           group by btrim(raw)) dedup;
  if not internal.valid_header_keywords(keywords) then
    raise exception 'header keywords: at most 12, each 1..40 chars after trim' using errcode = '22023';
  end if;

  -- Serialize concurrent writers of one header on the entity row, then check
  -- the header's own version.
  perform 1 from public.entities where id = e.id for no key update;
  select * into current_row from public.entity_headers where entity_id = e.id;
  perform internal.assert_header_version(e.id, p_expected_header_version, current_row.version);

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
-- The expected header version is required: a clear is never blind.
create or replace function public.clear_entity_header(
  p_entity_id uuid, p_expected_header_version integer, p_actor_id uuid default null,
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
  if p_expected_header_version is null then
    raise exception 'clearing a header needs its expected version' using errcode = '22023';
  end if;
  select * into target from internal.header_target(p_entity_id, p_actor_id);
  e := target.entity;
  actor := target.actor;

  perform 1 from public.entities where id = e.id for no key update;
  select * into current_row from public.entity_headers where entity_id = e.id;
  if current_row.entity_id is null then
    raise exception 'entity % has no header', e.id using errcode = 'P0002';
  end if;
  perform internal.assert_header_version(e.id, p_expected_header_version, current_row.version);
  delete from public.entity_headers where entity_id = e.id;

  activity_id := internal.record_activity(e.space_id, e.id, actor, 'updated', null,
                   jsonb_build_object('kind', e.kind, 'fields', jsonb_build_array('header'), 'header', 'cleared'));
  return internal.ledger_record(p_client_mutation_id, 'entities.header.clear',
           internal.command_result(e.id, null, activity_id));
end
$$;

-- Full argument signatures; nothing is inherited (050/053 precedent). The
-- internal helpers are callable only through the doors.
revoke all on function internal.valid_header_keywords(text[]) from public;
revoke all on function internal.header_kind_allowed(text) from public;
revoke all on function internal.header_body_ref(uuid, text) from public;
revoke all on function internal.header_target(uuid, uuid) from public;
revoke all on function internal.assert_header_version(uuid, integer, integer) from public;
revoke all on function internal.header_projection(public.entity_headers) from public;
revoke all on function public.set_entity_header(uuid, integer, uuid, text, text, text[], text) from public;
grant execute on function public.set_entity_header(uuid, integer, uuid, text, text, text[], text) to tm8_app;
revoke all on function public.clear_entity_header(uuid, integer, uuid, text) from public;
grant execute on function public.clear_entity_header(uuid, integer, uuid, text) to tm8_app;

reset role;
