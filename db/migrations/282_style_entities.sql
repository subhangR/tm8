-- =============================================================================
-- 282 — styles: personal styles, read-only space styles, per-identity prefs and
-- the space default (styles spec doc 01a0fc22 v8, signed off 2026-10-02;
-- §3 database, §4 actions, §4.3 events, §7 permissions).
--
-- THE MODEL IN ONE BREATH. A style document is `{schemaVersion, foundation,
-- vars, css}`. A PERSONAL style is owned by one identity and lives in
-- `personal_styles` — NOT an entity, so it is private by construction and the
-- inert `restricted` arms of entities_select / entity_readable are never
-- touched (§7). A SPACE style is an ordinary `visibility = 'space'` entity of
-- kind `style` with a `styles` detail row, and it is READ-ONLY: the only
-- writer is `push_style`, which creates it on the first push and re-versions it
-- on every later one. Any ACTIVE MEMBER may push onto an existing space style
-- (sign-off decision); `pushed_by` and the `entity_versions` history are the
-- safety net. `remove_style` (space admin) soft-deletes it.
--
-- WHERE VALIDATION LIVES. Kind-aware per-key validation, clamping, the css
-- sanitiser and `resolved_hash` are the TypeScript resolver's job (one
-- implementation for server, CLI and UI, spec §8). This file defends only what
-- belongs in storage — key grammar, value size, key count, document size —
-- in `internal.validate_style_vars`, so a direct SQL write cannot store
-- garbage. The doors below therefore take documents the server has already
-- validated; push and pull COPY rows inside SQL, so a pushed document is
-- byte-for-byte the one that was validated when it was written.
--
-- EVENTS (§4.3). A push or remove moves `public.entities`, which the 003
-- capture trigger already turns into `entity.upsert` / `entity.deleted`.
-- `personal_style.updated` and `identity.style_prefs.updated` are about ONE
-- person, and tm8 has no per-identity channel: they are written as one
-- `workspace_events` row PER ACTIVE MEMBERSHIP of the caller with
-- `recipient_member_id` set — the existing per-person mechanism (003:294-310,
-- RLS 008:156-161) — so they never reach another member's socket.
-- `space.style_default.updated` is space-wide, exactly like
-- `space.default_channel.updated` (031:665). All three are RPC-authored
-- passthrough rows: the payload IS the contract arm, `type` included.
--
-- NUMBERED 282, MEASURED 2026-10-02 against the union of every remote ref
-- (194's rule): main's tip is 277 and 278..281 exist on unmerged branches
-- (space_link_inbound, cross_space_refs, op_requests, path_grants,
-- space_link_spawn). None of those redefine `internal.entity_content` or
-- `public.delete_entity`, the two shared objects replaced below.
--
-- SHARED-OBJECT NOTICE (same as 194/239/250/261): §8 REPLACES
-- `internal.entity_content` (body copied VERBATIM from 261, the latest in the
-- chain, plus one `style` arm) and §9 REPLACES `public.delete_entity` (body
-- copied VERBATIM from 261, plus `style` in the command-owned refusal, because
-- removal is an admin action with its own door).
--
-- Rate limits are Phase 3 (spec §11), not here.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry. Ordinary insert (`entity_kinds_guard_core` fires on
--    UPDATE/DELETE only; 194 precedent).
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('style', 'core', null, 'palette')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. The storage-layer invariant both document tables share (spec §3.3).
--    Only what is worth defending below the resolver: key grammar, string
--    values of bounded size, a key-count cap. 200 rather than the registry's
--    119 so a release that adds variables never needs a migration here, and a
--    style that still carries a key a release removed stays storable (§10.4).
-- -----------------------------------------------------------------------------
create or replace function internal.assert_style_vars(p_vars jsonb)
returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare k text; v jsonb; n integer := 0;
begin
  if p_vars is null or jsonb_typeof(p_vars) <> 'object' then
    raise exception 'style vars must be a JSON object' using errcode = '22023';
  end if;
  for k, v in select key, value from jsonb_each(p_vars) loop
    n := n + 1;
    if k !~ '^--pn-[a-z0-9-]{1,64}$' then
      raise exception 'style variable name % is not a --pn-* custom property', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) <> 'string' then
      raise exception 'style variable % must be a string', k using errcode = '22023';
    end if;
    if length(v #>> '{}') > 512 then
      raise exception 'style variable % is longer than 512 characters', k using errcode = '22023';
    end if;
  end loop;
  if n > 200 then
    raise exception 'a style may set at most 200 variables (got %)', n using errcode = '22023';
  end if;
end
$$;

create or replace function internal.validate_style_vars() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  perform internal.assert_style_vars(new.vars);
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. `public.personal_styles` (spec §3.2). Not an entity: no space, no edges,
--    no generic door. RLS is one line — the owner — which is the whole of
--    "private". The owner may be a human or an agent identity.
-- -----------------------------------------------------------------------------
create table public.personal_styles (
  id                   uuid primary key default internal.new_id(),
  owner_identity_id    text not null check (length(owner_identity_id) between 1 and 200),
  title                text not null check (length(btrim(title)) between 1 and 200),
  description          text check (description is null or length(description) <= 2000),
  schema_version       integer not null default 1 check (schema_version >= 1),
  foundation           text not null check (foundation ~ '^builtin:[a-z0-9-]{1,64}$'),
  vars                 jsonb not null default '{}'::jsonb
                       check (jsonb_typeof(vars) = 'object' and pg_column_size(vars) <= 65536),
  css                  text check (css is null or octet_length(css) <= 16384),
  tags                 text[] not null default '{}' check (cardinality(tags) <= 16),
  resolved_hash        text,
  published_as         uuid references public.entities(id) on delete set null,
  pulled_from          uuid references public.entities(id) on delete set null,
  pulled_from_version  integer,
  version              integer not null default 1 check (version > 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index personal_styles_owner_idx on public.personal_styles (owner_identity_id, updated_at desc);

create trigger personal_styles_touch_updated_at before update on public.personal_styles
for each row execute function internal.touch_updated_at();
create trigger personal_styles_validate_vars before insert or update on public.personal_styles
for each row execute function internal.validate_style_vars();

alter table public.personal_styles enable row level security;
create policy personal_styles_owner on public.personal_styles for all to tm8_app
  using (owner_identity_id = internal.identity_id())
  with check (owner_identity_id = internal.identity_id());
grant select, insert, update, delete on public.personal_styles to tm8_app;

-- -----------------------------------------------------------------------------
-- 4. `public.styles` — the space style detail row (spec §3.3). Mirrors
--    `drawings` (194): `entity_id` and `updated_at` are load-bearing because
--    snapshot_entity_version() reads them unqualified — which is also what
--    makes every push one `entity_versions` row (history: decided, keep).
-- -----------------------------------------------------------------------------
create table public.styles (
  entity_id                 uuid primary key references public.entities(id) on delete cascade,
  title                     text not null check (length(btrim(title)) between 1 and 200),
  description               text check (description is null or length(description) <= 2000),
  schema_version            integer not null default 1 check (schema_version >= 1),
  foundation                text not null check (foundation ~ '^builtin:[a-z0-9-]{1,64}$'),
  vars                      jsonb not null default '{}'::jsonb
                            check (jsonb_typeof(vars) = 'object' and pg_column_size(vars) <= 65536),
  css                       text check (css is null or octet_length(css) <= 16384),
  tags                      text[] not null default '{}' check (cardinality(tags) <= 16),
  resolved_hash             text,
  -- The member (or team_member) entity of the LAST push.
  pushed_by                 uuid not null references public.entities(id),
  source_personal_style_id  uuid references public.personal_styles(id) on delete set null,
  -- Identity of the FIRST pusher. Attribution only; grants nothing.
  source_owner_identity_id  text not null,
  pushed_at                 timestamptz not null default now(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create trigger styles_validate_kind
before insert or update of entity_id on public.styles
for each row execute function internal.validate_detail_envelope('style');

create trigger styles_touch_updated_at before update on public.styles
for each row execute function internal.touch_updated_at();

create trigger styles_w2_snapshot_version after update on public.styles
for each row execute function internal.snapshot_entity_version();

create trigger styles_validate_vars before insert or update on public.styles
for each row execute function internal.validate_style_vars();

alter table public.styles enable row level security;

-- 218's flattened shape: the entities row's own RLS decides readability, and
-- `offset 0` keeps it a per-row pkey probe.
create policy styles_select on public.styles for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = styles.entity_id
                     and readable_entity.deleted_at is null offset 0)));

grant select on public.styles to tm8_app;

-- -----------------------------------------------------------------------------
-- 5. `public.identity_style_prefs` (spec §3.4). Keyed by IDENTITY, not
--    member, because a person's style follows them across spaces. References
--    are typed strings, not FKs: a space style can be removed or become
--    invisible and a personal style can be deleted, and the preference must
--    survive that by falling back to `snapshot`.
-- -----------------------------------------------------------------------------
create table public.identity_style_prefs (
  identity_id   text primary key check (length(identity_id) between 1 and 200),
  current_style text not null default 'builtin:atelier-light'
                check (current_style ~ '^(builtin:[a-z0-9-]{1,64}|(personal|space):[0-9a-f-]{36})$'),
  dark_style    text check (dark_style is null
                            or dark_style ~ '^(builtin:[a-z0-9-]{1,64}|(personal|space):[0-9a-f-]{36})$'),
  follow_os     boolean not null default false,
  snapshot      jsonb not null default '{}'::jsonb check (jsonb_typeof(snapshot) = 'object'),
  trusted_css   text[] not null default '{}' check (cardinality(trusted_css) <= 200),
  revision      integer not null default 1 check (revision > 0),
  updated_at    timestamptz not null default now()
);

create trigger identity_style_prefs_touch_updated_at before update on public.identity_style_prefs
for each row execute function internal.touch_updated_at();

alter table public.identity_style_prefs enable row level security;
create policy identity_style_prefs_self on public.identity_style_prefs for all to tm8_app
  using (identity_id = internal.identity_id())
  with check (identity_id = internal.identity_id());
-- Read only: every write goes through set_identity_style_prefs, which also
-- writes the snapshot and the per-member event.
grant select on public.identity_style_prefs to tm8_app;

-- -----------------------------------------------------------------------------
-- 6. `public.space_style_defaults` (spec §3.5). A separate table, like
--    `space_chat_defaults` (229), so writing it never bumps
--    `spaces.settings_revision`. Never a personal style: other members cannot
--    see one.
-- -----------------------------------------------------------------------------
create table public.space_style_defaults (
  space_id      uuid primary key references public.spaces(id) on delete cascade,
  default_style text not null
                check (default_style ~ '^(builtin:[a-z0-9-]{1,64}|space:[0-9a-f-]{36})$'),
  set_by        uuid references public.entities(id) on delete set null,
  revision      integer not null default 1 check (revision > 0),
  updated_at    timestamptz not null default now()
);

create trigger space_style_defaults_touch_updated_at before update on public.space_style_defaults
for each row execute function internal.touch_updated_at();

alter table public.space_style_defaults enable row level security;
create policy space_style_defaults_select on public.space_style_defaults for select to tm8_app
  using (space_id = any ((select internal.member_space_ids())::uuid[]));
grant select on public.space_style_defaults to tm8_app;

-- -----------------------------------------------------------------------------
-- 7. Shared helpers: JSON views (the contract's camelCase shapes), the
--    readability rule for a typed reference, and the per-member event writer.
-- -----------------------------------------------------------------------------

-- The StyleDoc both tables store (spec §1.3).
create or replace function internal.style_doc_json(
  p_schema_version integer, p_foundation text, p_vars jsonb, p_css text
) returns jsonb language sql immutable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'schemaVersion', p_schema_version,
    'foundation', p_foundation,
    'vars', coalesce(p_vars, '{}'::jsonb),
    'css', p_css)
$$;

-- PersonalStyleView. `upstreamVersion` is the pulled-from space style's
-- CURRENT version, null once it is removed or no longer readable.
create or replace function internal.personal_style_json(ps public.personal_styles)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', ps.id,
    'ref', 'personal:' || ps.id,
    'title', ps.title,
    'description', ps.description,
    'tags', to_jsonb(ps.tags),
    'version', ps.version,
    'doc', internal.style_doc_json(ps.schema_version, ps.foundation, ps.vars, ps.css),
    'resolvedHash', ps.resolved_hash,
    'publishedAs', ps.published_as,
    'pulledFrom', case when ps.pulled_from is null then null else jsonb_build_object(
        'id', ps.pulled_from,
        'version', ps.pulled_from_version,
        'upstreamVersion', (select e.version from public.entities e
                             where e.id = ps.pulled_from and e.deleted_at is null
                               and internal.entity_readable(e.id))) end,
    'createdAt', ps.created_at,
    'updatedAt', ps.updated_at)
$$;

-- PersonalStyleSummary (the list row): no doc, counts instead.
create or replace function internal.personal_style_summary_json(ps public.personal_styles)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select (internal.personal_style_json(ps) - 'doc' - 'description' - 'createdAt')
         || jsonb_build_object(
              'foundation', ps.foundation,
              'varCount', (select count(*) from jsonb_object_keys(ps.vars)),
              'hasCss', ps.css is not null and btrim(ps.css) <> '')
$$;

-- SpaceStyleView, read straight from the detail row + envelope. Callers have
-- already established readability.
create or replace function internal.space_style_json(p_entity_id uuid)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', e.id,
    'ref', 'space:' || e.id,
    'spaceId', e.space_id,
    'title', s.title,
    'description', s.description,
    'tags', to_jsonb(s.tags),
    'version', e.version,
    'doc', internal.style_doc_json(s.schema_version, s.foundation, s.vars, s.css),
    'resolvedHash', s.resolved_hash,
    'pushedBy', s.pushed_by,
    'pushedAt', s.pushed_at,
    'sourceOwnerIdentityId', s.source_owner_identity_id,
    'sourcePersonalStyleId', s.source_personal_style_id)
  from public.entities e join public.styles s on s.entity_id = e.id
  where e.id = p_entity_id
$$;

create or replace function internal.style_prefs_json(p public.identity_style_prefs)
returns jsonb language sql immutable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'currentStyle', p.current_style,
    'darkStyle', p.dark_style,
    'followOs', p.follow_os,
    'trustedCss', to_jsonb(p.trusted_css),
    'snapshot', jsonb_build_object(
      'current', p.snapshot -> 'current',
      'dark', p.snapshot -> 'dark',
      'currentHash', p.snapshot -> 'currentHash',
      'currentTitle', p.snapshot -> 'currentTitle'),
    'revision', p.revision,
    'updatedAt', p.updated_at)
$$;

/*
 * The document a typed reference names, IF THE CALLER MAY READ IT NOW.
 * Returns {doc, hash, title} or raises 42501 (→ 403). A built-in is always
 * readable; its document is the identity (foundation = itself, no vars) — the
 * server checks the slug against BUILTIN_STYLE_IDS before calling, because
 * the database does not ship the built-ins (spec §2.2 of the design: they are
 * code, not rows).
 */
create or replace function internal.style_ref_doc(p_ref text)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  kind text := split_part(p_ref, ':', 1);
  ident text := substr(p_ref, length(split_part(p_ref, ':', 1)) + 2);
  ps public.personal_styles;
  s public.styles;
begin
  if p_ref is null then return null; end if;
  if kind = 'builtin' then
    if ident !~ '^[a-z0-9-]{1,64}$' then
      raise exception 'not a built-in style id: %', p_ref using errcode = '22023';
    end if;
    return jsonb_build_object(
      'doc', internal.style_doc_json(1, p_ref, '{}'::jsonb, null),
      'hash', null, 'title', null);
  end if;
  if ident !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'not a style reference: %', p_ref using errcode = '22023';
  end if;
  if kind = 'personal' then
    select * into ps from public.personal_styles
     where id = ident::uuid and owner_identity_id = internal.identity_id();
    if ps.id is null then
      raise exception 'style % is not readable by you', p_ref using errcode = '42501';
    end if;
    return jsonb_build_object(
      'doc', internal.style_doc_json(ps.schema_version, ps.foundation, ps.vars, ps.css),
      'hash', ps.resolved_hash, 'title', ps.title);
  elsif kind = 'space' then
    select st.* into s
      from public.styles st join public.entities e on e.id = st.entity_id
     where st.entity_id = ident::uuid and e.kind = 'style' and e.deleted_at is null
       and internal.entity_readable(e.id);
    if s.entity_id is null then
      raise exception 'style % is not readable by you', p_ref using errcode = '42501';
    end if;
    return jsonb_build_object(
      'doc', internal.style_doc_json(s.schema_version, s.foundation, s.vars, s.css),
      'hash', s.resolved_hash, 'title', s.title);
  end if;
  raise exception 'not a style reference: %', p_ref using errcode = '22023';
end
$$;

/*
 * One `workspace_events` row per ACTIVE membership of the CALLER, each
 * addressed to that membership. This is how an identity-scoped fact reaches
 * only that person's sockets in every space they have open (spec §3.4):
 * tm8 has no per-identity channel, and `recipient_member_id` is the existing
 * per-person routing (RLS 008:156-161 hides the row from everyone else).
 * An identity with no active membership gets no row; there is no socket to
 * reach.
 */
create or replace function internal.emit_identity_style_event(
  p_event_type text, p_payload jsonb, p_client_mutation_id text
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  m record;
  body jsonb := jsonb_build_object('type', p_event_type) || p_payload
    || case when p_client_mutation_id is null then '{}'::jsonb
            else jsonb_build_object('clientMutationId', p_client_mutation_id) end;
begin
  for m in select entity_id, space_id from public.members
            where identity_id = internal.identity_id() and status = 'active' loop
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id, recipient_member_id)
    values (m.space_id, internal.next_event_seq(m.space_id), p_event_type, body,
            p_client_mutation_id, m.entity_id);
  end loop;
end
$$;

/*
 * Keep `identity_style_prefs.snapshot` in step with a style that just changed,
 * for every prefs row that has it as current or dark (spec §3.4, §4.3: the
 * snapshot is what a viewer falls back to once the source is gone, so it must
 * be the LAST version they could see, not the one they picked).
 *
 * For a SPACE style only identities that are still ACTIVE MEMBERS of its
 * space are refreshed — anyone else could not read the new version and must
 * keep the old copy. For a PERSONAL style only its owner can hold the ref.
 * No event: `entity.upsert` / `personal_style.updated` already tell the
 * viewers, and a prefs event per viewer per push would be a fan-out storm.
 */
create or replace function internal.refresh_style_snapshots(
  p_ref text, p_space_id uuid, p_doc jsonb, p_hash text, p_title text
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  -- ONE set-based statement for both columns (no per-row loop): a row whose
  -- current AND dark are this style gets both halves in the same write.
  update public.identity_style_prefs p
     set snapshot = p.snapshot
           || case when p.current_style = p_ref
                   then jsonb_build_object('current', p_doc, 'currentHash', p_hash, 'currentTitle', p_title)
                   else '{}'::jsonb end
           || case when p.dark_style = p_ref
                   then jsonb_build_object('dark', p_doc)
                   else '{}'::jsonb end
   where (p.current_style = p_ref or p.dark_style = p_ref)
     and (p_space_id is null or exists (
           select 1 from public.members m
            where m.identity_id = p.identity_id and m.space_id = p_space_id and m.status = 'active'));
end
$$;

create or replace function internal.personal_style_event(
  ps public.personal_styles, p_deleted boolean, p_client_mutation_id text
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.emit_identity_style_event('personal_style.updated',
    jsonb_build_object(
      'id', ps.id,
      'version', ps.version,
      'doc', case when p_deleted then null
                  else internal.style_doc_json(ps.schema_version, ps.foundation, ps.vars, ps.css) end,
      'resolvedHash', case when p_deleted then null else ps.resolved_hash end,
      'deleted', p_deleted),
    p_client_mutation_id);
end
$$;

-- The common text checks every door repeats, in one place.
create or replace function internal.assert_style_fields(
  p_title text, p_description text, p_foundation text, p_css text, p_tags text[]
) returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
begin
  if p_title is not null and length(btrim(p_title)) not between 1 and 200 then
    raise exception 'style title must be 1..200 characters after trimming' using errcode = '22023';
  end if;
  if p_description is not null and length(p_description) > 2000 then
    raise exception 'style description is longer than 2000 characters' using errcode = '22023';
  end if;
  if p_foundation is not null and p_foundation !~ '^builtin:[a-z0-9-]{1,64}$' then
    raise exception 'a style foundation must be a built-in id (got %)', p_foundation using errcode = '22023';
  end if;
  if p_css is not null and octet_length(p_css) > 16384 then
    raise exception 'style css is larger than 16 KiB' using errcode = '54000';
  end if;
  if p_tags is not null and cardinality(p_tags) > 16 then
    raise exception 'a style may carry at most 16 tags' using errcode = '22023';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 8. Content hydration. SHARED-OBJECT NOTICE above: body copied VERBATIM from
--    261 (the latest definition), plus the `style` arm. The arm is an
--    allow-list in the contract's camelCase (spec §3.3), so version snapshots
--    and generic reads carry the document.
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
      -- `-` binds tighter than `||`: the entity_id is dropped, THEN the
      -- ordered sections and questions are merged in.
      when 'form' then select to_jsonb(fm) - 'entity_id'
                              || jsonb_build_object('sections', internal.form_sections_json(target),
                                                    'questions', internal.form_questions_json(target))
                         into content from public.forms fm where fm.entity_id = target;
      -- An allow-list, never to_jsonb(sc): the row holds the sealed secret,
      -- the hint and the vendor login (§3a).
      when 'credential' then select to_jsonb(cc) - 'entity_id' into content from public.credential_cards cc where cc.entity_id = target;
      -- 250 (W6): the shared link's metadata. `space_links` holds no secret; the
      -- sealed per-member token is `space_link_tokens` (251) and has no arm.
      when 'space_link' then select to_jsonb(sl) - 'entity_id' into content from public.space_links sl where sl.entity_id = target;
      -- W8: the server's metadata. `servers` holds no secret; the sealed
      -- per-member gate session is `server_gate_tokens` and has no arm.
      when 'server' then select to_jsonb(sv) - 'entity_id' into content from public.servers sv where sv.entity_id = target;
      -- 282: a space style, as the spec's allow-list (§3.3), camelCase.
      when 'style' then select jsonb_build_object(
                                 'title', st.title,
                                 'description', st.description,
                                 'foundation', st.foundation,
                                 'vars', st.vars,
                                 'css', st.css,
                                 'tags', to_jsonb(st.tags),
                                 'resolvedHash', st.resolved_hash,
                                 'pushedBy', st.pushed_by,
                                 'pushedAt', st.pushed_at,
                                 'sourceOwnerIdentityId', st.source_owner_identity_id)
                          into content from public.styles st where st.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 9. The generic delete door refuses `style`. SHARED-OBJECT NOTICE above:
--    body copied VERBATIM from 261, plus `style` in the command-owned list.
--    Removing a space style is a space-ADMIN action (spec §7) with its own
--    door, `remove_style`; through the generic door any member could do it.
-- -----------------------------------------------------------------------------
create or replace function public.delete_entity(
  p_entity_id uuid, p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; e public.entities; actor uuid; affected uuid[]; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.delete'); if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id); perform internal.require_space_member(e.space_id);
  if e.kind in ('member','message','work_session','project','interaction_profile','credential','server','style') then
    raise exception 'entity lifecycle is command-owned for kind %', e.kind using errcode = '42501';
  end if;
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  with recursive subtree(id, path, depth) as (
    select p_entity_id, array[p_entity_id], 0
    union all
    select child.id, s.path || child.id, s.depth + 1
      from public.entities child join subtree s on child.parent_id = s.id
     where s.depth < 256 and not child.id = any(s.path)
  )
  select array_agg(distinct s.id) into affected from subtree s join public.entities e2 on e2.id=s.id
   where e2.deleted_at is null;
  update public.entities set deleted_at=now(), updated_at=now()
   where id = any(coalesce(affected,array[]::uuid[]));
  activity_id := internal.record_activity(e.space_id,p_entity_id,actor,'deleted',null,jsonb_build_object('kind',e.kind));
  return internal.ledger_record(p_client_mutation_id,'entities.delete',
    internal.command_result(p_entity_id,null,activity_id,coalesce(affected,array[p_entity_id]),
      internal.issue_undo_token(e.space_id,actor,'Undo delete','entities.restore',jsonb_build_object('entityId',p_entity_id))));
end
$$;

-- -----------------------------------------------------------------------------
-- 10. Personal style doors (spec §4.1). Owner = the bound identity; there is
--     no parameter naming whose style to touch. A style that is not the
--     caller's is NOT FOUND (P0002 → 404), never "forbidden": its existence is
--     itself private (§14: "another identity gets 404").
--
--     `update_personal_style` takes the FULL new document: the server reads
--     the row, applies the merge patch (§6.5), validates and hashes, then
--     writes here under the version check — so the merge base is exactly the
--     version the check accepts.
-- -----------------------------------------------------------------------------
create or replace function public.create_personal_style(
  p_title text, p_foundation text,
  p_description text default null, p_vars jsonb default '{}'::jsonb,
  p_css text default null, p_tags text[] default '{}',
  p_resolved_hash text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  identity text;
  ps public.personal_styles;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'styles.personal.create');
  if replay is not null then return replay; end if;
  identity := internal.require_identity();

  if p_title is null or p_foundation is null then
    raise exception 'a personal style needs a title and a foundation' using errcode = '22023';
  end if;
  perform internal.assert_style_fields(p_title, p_description, p_foundation, p_css, p_tags);
  -- Serialise the cap check per identity so two concurrent creates cannot
  -- both see 99 (the cap exists so an agent loop cannot fill the table).
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('personal_styles:' || identity, 0));
  if (select count(*) from public.personal_styles where owner_identity_id = identity) >= 100 then
    raise exception 'personal style limit reached (100 per identity): delete one first'
      using errcode = '53400';
  end if;

  insert into public.personal_styles(owner_identity_id, title, description, foundation, vars, css, tags, resolved_hash)
  values (identity, btrim(p_title), p_description, p_foundation,
          coalesce(p_vars, '{}'::jsonb), p_css, coalesce(p_tags, '{}'), p_resolved_hash)
  returning * into ps;

  perform internal.personal_style_event(ps, false, p_client_mutation_id);
  return internal.ledger_record(p_client_mutation_id, 'styles.personal.create',
           jsonb_build_object('style', internal.personal_style_json(ps)));
end
$$;

create or replace function public.update_personal_style(
  p_id uuid, p_expected_version integer,
  p_title text, p_description text, p_foundation text,
  p_vars jsonb, p_css text, p_tags text[],
  p_resolved_hash text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  identity text;
  ps public.personal_styles;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'styles.personal.update');
  if replay is not null then return replay; end if;
  identity := internal.require_identity();

  -- FOR UPDATE for the same reason assert_version takes it (014): the check
  -- and the write it guards must not be separable.
  select * into ps from public.personal_styles
   where id = p_id and owner_identity_id = identity for update;
  if ps.id is null then
    raise exception 'personal style % not found', p_id using errcode = 'P0002';
  end if;
  if p_expected_version is null or ps.version <> p_expected_version then
    raise exception 'version conflict on personal style %', p_id
      using errcode = '40001',
            detail = jsonb_build_object('entityId', p_id, 'currentVersion', ps.version)::text;
  end if;
  if p_title is null or p_foundation is null or p_vars is null then
    raise exception 'update_personal_style takes the whole document' using errcode = '22023';
  end if;
  perform internal.assert_style_fields(p_title, p_description, p_foundation, p_css, p_tags);

  update public.personal_styles
     set title = btrim(p_title),
         description = p_description,
         foundation = p_foundation,
         vars = p_vars,
         css = p_css,
         tags = coalesce(p_tags, '{}'),
         resolved_hash = p_resolved_hash,
         version = version + 1
   where id = p_id
  returning * into ps;

  perform internal.refresh_style_snapshots('personal:' || ps.id, null,
    internal.style_doc_json(ps.schema_version, ps.foundation, ps.vars, ps.css),
    ps.resolved_hash, ps.title);
  perform internal.personal_style_event(ps, false, p_client_mutation_id);
  return internal.ledger_record(p_client_mutation_id, 'styles.personal.update',
           jsonb_build_object('style', internal.personal_style_json(ps)));
end
$$;

create or replace function public.delete_personal_style(
  p_id uuid, p_expected_version integer default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  identity text;
  ps public.personal_styles;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'styles.personal.delete');
  if replay is not null then return replay; end if;
  identity := internal.require_identity();

  select * into ps from public.personal_styles
   where id = p_id and owner_identity_id = identity for update;
  if ps.id is null then
    raise exception 'personal style % not found', p_id using errcode = 'P0002';
  end if;
  if p_expected_version is not null and ps.version <> p_expected_version then
    raise exception 'version conflict on personal style %', p_id
      using errcode = '40001',
            detail = jsonb_build_object('entityId', p_id, 'currentVersion', ps.version)::text;
  end if;

  -- The pushed space style (if any) stays; the FK sets its
  -- source_personal_style_id to null (spec §4.1). Prefs that point here keep
  -- rendering from their snapshot.
  delete from public.personal_styles where id = p_id;

  perform internal.personal_style_event(ps, true, p_client_mutation_id);
  return internal.ledger_record(p_client_mutation_id, 'styles.personal.delete',
           jsonb_build_object('id', ps.id, 'deleted', true));
end
$$;

-- -----------------------------------------------------------------------------
-- 11. Pull (spec §1.4): copy a READABLE space style into a new personal style,
--     remembering where it came from and at which version. Done in SQL so the
--     copy is exactly the stored (already validated) document.
-- -----------------------------------------------------------------------------
create or replace function public.pull_style(
  p_entity_id uuid, p_title text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  identity text;
  e public.entities;
  s public.styles;
  ps public.personal_styles;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'styles.pull');
  if replay is not null then return replay; end if;
  identity := internal.require_identity();

  e := internal.live_entity(p_entity_id, 'style');
  if not internal.entity_readable(e.id) then
    raise exception 'style % is not readable by you', p_entity_id using errcode = '42501';
  end if;
  select * into s from public.styles where entity_id = e.id;
  perform internal.assert_style_fields(p_title, null, null, null, null);

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('personal_styles:' || identity, 0));
  if (select count(*) from public.personal_styles where owner_identity_id = identity) >= 100 then
    raise exception 'personal style limit reached (100 per identity): delete one first'
      using errcode = '53400';
  end if;

  insert into public.personal_styles(owner_identity_id, title, description, schema_version, foundation,
                                     vars, css, tags, resolved_hash, pulled_from, pulled_from_version)
  values (identity, coalesce(btrim(p_title), s.title), s.description, s.schema_version, s.foundation,
          s.vars, s.css, s.tags, s.resolved_hash, e.id, e.version)
  returning * into ps;

  perform internal.personal_style_event(ps, false, p_client_mutation_id);
  return internal.ledger_record(p_client_mutation_id, 'styles.pull',
           jsonb_build_object('style', internal.personal_style_json(ps)));
end
$$;

-- -----------------------------------------------------------------------------
-- 12. Push (spec §1.4, §3.3, §6.2). The ONLY writer of a space style.
--
--     Target: `p_target_entity_id`, else the personal style's `published_as`
--     when that space style is still live in THIS space, else none — a first
--     push, which creates the entity. A removed target therefore makes the
--     next push create a fresh style, as the spec says.
--
--     Rights (sign-off decision): the caller must OWN the personal style (the
--     row lookup is owner-scoped) and be an ACTIVE MEMBER of the space —
--     nothing more, even onto a style someone else first pushed. A
--     non-member gets 42501 from require_space_member.
--
--     Re-versioning is an UPDATE of the detail row: snapshot_entity_version()
--     bumps entities.version and writes the history row, and the 003 capture
--     trigger turns the envelope change into `entity.upsert`, whose summary
--     state carries the full document (projector) — so no event is written
--     here. `p_resolved_hash`, when given, is the server's fresh hash
--     (a deploy may have changed a built-in since the personal row was saved).
-- -----------------------------------------------------------------------------
create or replace function public.push_style(
  p_personal_style_id uuid, p_space_id uuid,
  p_target_entity_id uuid default null, p_expected_version integer default null,
  p_actor_id uuid default null, p_title text default null,
  p_resolved_hash text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  identity text;
  actor uuid;
  ps public.personal_styles;
  target public.entities;
  target_id uuid;
  created boolean := false;
  activity_id uuid;
  final_title text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'styles.push');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{style,spaceId}', p_space_id::text, 'space');
    return replay;
  end if;
  identity := internal.require_identity();
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  select * into ps from public.personal_styles
   where id = p_personal_style_id and owner_identity_id = identity for update;
  if ps.id is null then
    raise exception 'personal style % not found', p_personal_style_id using errcode = 'P0002';
  end if;
  perform internal.assert_style_fields(p_title, null, null, null, null);
  final_title := coalesce(btrim(p_title), ps.title);

  if p_target_entity_id is not null then
    target := internal.live_entity(p_target_entity_id, 'style');
    if target.space_id <> p_space_id then
      raise exception 'style % belongs to another space', p_target_entity_id using errcode = '22023';
    end if;
    target_id := target.id;
  elsif ps.published_as is not null then
    select * into target from public.entities
     where id = ps.published_as and kind = 'style' and deleted_at is null and space_id = p_space_id;
    target_id := target.id;
  end if;

  if target_id is null then
    if p_expected_version is not null then
      raise exception 'expectedVersion names a version of a style that does not exist yet; omit it on a first push'
        using errcode = '22023';
    end if;
    target_id := internal.create_envelope(p_space_id, 'style', actor, null, null);
    insert into public.styles(entity_id, title, description, schema_version, foundation, vars, css, tags,
                              resolved_hash, pushed_by, source_personal_style_id, source_owner_identity_id, pushed_at)
    values (target_id, final_title, ps.description, ps.schema_version, ps.foundation, ps.vars, ps.css, ps.tags,
            coalesce(p_resolved_hash, ps.resolved_hash), actor, ps.id, identity, now());
    perform internal.record_initial_version(target_id, actor);
    created := true;
    activity_id := internal.record_activity(p_space_id, target_id, actor, 'created',
                     null, jsonb_build_object('kind', 'style'));
  else
    perform internal.assert_version(target_id, p_expected_version);
    update public.styles
       set title = final_title,
           description = ps.description,
           schema_version = ps.schema_version,
           foundation = ps.foundation,
           vars = ps.vars,
           css = ps.css,
           tags = ps.tags,
           resolved_hash = coalesce(p_resolved_hash, ps.resolved_hash),
           pushed_by = actor,
           -- The first source stays the source; a pull-and-push by someone
           -- else must not orphan the original owner's link.
           source_personal_style_id = coalesce(source_personal_style_id, ps.id),
           pushed_at = now()
     where entity_id = target_id;
    activity_id := internal.record_activity(p_space_id, target_id, actor, 'updated',
                     null, jsonb_build_object('kind', 'style'));
  end if;

  update public.personal_styles set published_as = target_id where id = ps.id
     and published_as is distinct from target_id;

  perform internal.refresh_style_snapshots('space:' || target_id, p_space_id,
    internal.style_doc_json(ps.schema_version, ps.foundation, ps.vars, ps.css),
    coalesce(p_resolved_hash, ps.resolved_hash), final_title);

  return internal.ledger_record(p_client_mutation_id, 'styles.push',
           jsonb_build_object('style', internal.space_style_json(target_id), 'created', created,
                              'activityId', activity_id));
end
$$;

-- -----------------------------------------------------------------------------
-- 13. Remove (spec §1.4, §7): space admin only; soft delete. The 003 trigger
--     emits `entity.deleted`. Viewers on it keep rendering from their prefs
--     snapshot, which is DELIBERATELY NOT TOUCHED here: it holds the last
--     pushed version, and that is exactly what a viewer falls back to; a personal style's `published_as` keeps pointing at the
--     tombstone, which is why push_style only targets LIVE styles.
-- -----------------------------------------------------------------------------
create or replace function public.remove_style(
  p_entity_id uuid, p_expected_version integer default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'styles.remove');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay #>> '{id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_entity_id, 'style');
  perform internal.require_space_admin(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  update public.entities set deleted_at = now(), updated_at = now() where id = p_entity_id;
  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'deleted',
                   null, jsonb_build_object('kind', 'style'));
  return internal.ledger_record(p_client_mutation_id, 'styles.remove',
           jsonb_build_object('id', p_entity_id, 'spaceId', e.space_id, 'removed', true,
                              'activityId', activity_id));
end
$$;

-- -----------------------------------------------------------------------------
-- 14. Preferences (spec §3.4, §4.2). The server passes the FULL new row (it
--     merged the request onto the current one); this door checks the revision,
--     verifies the caller can read both references NOW, writes the snapshot
--     from what it read, and tells the caller's other sockets.
-- -----------------------------------------------------------------------------
create or replace function public.set_identity_style_prefs(
  p_current_style text, p_dark_style text, p_follow_os boolean, p_trusted_css text[],
  p_expected_revision integer default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  identity text;
  existing public.identity_style_prefs;
  current_revision integer;
  cur jsonb;
  drk jsonb;
  prefs public.identity_style_prefs;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'identity.stylePrefs.set');
  if replay is not null then return replay; end if;
  identity := internal.require_identity();

  select * into existing from public.identity_style_prefs where identity_id = identity for update;
  current_revision := coalesce(existing.revision, 0);
  if p_expected_revision is not null and p_expected_revision <> current_revision then
    raise exception 'style prefs revision conflict'
      using errcode = '40001',
            detail = jsonb_build_object('currentVersion', current_revision,
                                        'currentRevision', current_revision)::text;
  end if;
  if p_current_style is null then
    raise exception 'currentStyle is required' using errcode = '22023';
  end if;

  -- Readability check (403 when not readable) AND the snapshot source, in one read.
  cur := internal.style_ref_doc(p_current_style);
  drk := internal.style_ref_doc(p_dark_style);

  insert into public.identity_style_prefs(identity_id, current_style, dark_style, follow_os, snapshot, trusted_css, revision)
  values (identity, p_current_style, p_dark_style, coalesce(p_follow_os, false),
          jsonb_build_object('current', cur -> 'doc', 'dark', drk -> 'doc',
                             'currentHash', cur -> 'hash', 'currentTitle', cur -> 'title'),
          coalesce(p_trusted_css, '{}'), 1)
  on conflict (identity_id) do update
    set current_style = excluded.current_style,
        dark_style = excluded.dark_style,
        follow_os = excluded.follow_os,
        snapshot = excluded.snapshot,
        trusted_css = excluded.trusted_css,
        revision = identity_style_prefs.revision + 1
  returning * into prefs;

  perform internal.emit_identity_style_event('identity.style_prefs.updated',
    jsonb_build_object(
      'currentStyle', prefs.current_style,
      'darkStyle', prefs.dark_style,
      'followOs', prefs.follow_os,
      'revision', prefs.revision,
      'currentHash', prefs.snapshot ->> 'currentHash'),
    p_client_mutation_id);

  return internal.ledger_record(p_client_mutation_id, 'identity.stylePrefs.set',
           jsonb_build_object('prefs', internal.style_prefs_json(prefs)));
end
$$;

-- -----------------------------------------------------------------------------
-- 15. Space default (spec §3.5): HUMAN space admins only — the same gate as
--     `space_chat_defaults` — so an agent cannot restyle a space's newcomers.
--     Only a built-in or a live style OF THIS SPACE; never a personal style.
-- -----------------------------------------------------------------------------
create or replace function public.set_space_style_default(
  p_space_id uuid, p_default_style text,
  p_expected_revision integer default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  admin_member uuid;
  existing public.space_style_defaults;
  current_revision integer;
  target uuid;
  row_out public.space_style_defaults;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.styleDefault.set');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay #>> '{spaceId}', p_space_id::text, 'space');
    return replay;
  end if;
  admin_member := internal.require_human_space_admin(p_space_id);

  if p_default_style is null
     or p_default_style !~ '^(builtin:[a-z0-9-]{1,64}|space:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
    raise exception 'a space default is builtin:<slug> or space:<uuid> — a personal style is invisible to other members'
      using errcode = '22023';
  end if;
  if p_default_style like 'space:%' then
    target := substr(p_default_style, 7)::uuid;
    if not exists (select 1 from public.entities
                    where id = target and kind = 'style' and space_id = p_space_id and deleted_at is null) then
      raise exception 'style % is not a live style of this space', p_default_style using errcode = '22023';
    end if;
  end if;

  select * into existing from public.space_style_defaults where space_id = p_space_id for update;
  current_revision := coalesce(existing.revision, 0);
  if p_expected_revision is not null and p_expected_revision <> current_revision then
    raise exception 'space style default revision conflict'
      using errcode = '40001',
            detail = jsonb_build_object('currentVersion', current_revision,
                                        'currentRevision', current_revision)::text;
  end if;

  insert into public.space_style_defaults(space_id, default_style, set_by, revision)
  values (p_space_id, p_default_style, admin_member, 1)
  on conflict (space_id) do update
    set default_style = excluded.default_style,
        set_by = excluded.set_by,
        revision = space_style_defaults.revision + 1
  returning * into row_out;

  insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
  values (p_space_id, internal.next_event_seq(p_space_id), 'space.style_default.updated',
          jsonb_build_object('type', 'space.style_default.updated',
                             'defaultStyle', row_out.default_style,
                             'revision', row_out.revision)
          || case when p_client_mutation_id is null then '{}'::jsonb
                  else jsonb_build_object('clientMutationId', p_client_mutation_id) end,
          p_client_mutation_id);

  return internal.ledger_record(p_client_mutation_id, 'spaces.styleDefault.set',
           jsonb_build_object('spaceId', row_out.space_id, 'defaultStyle', row_out.default_style,
                              'setBy', row_out.set_by, 'revision', row_out.revision,
                              'updatedAt', row_out.updated_at));
end
$$;

-- -----------------------------------------------------------------------------
-- 16. Reads. SECURITY DEFINER with the rule stated inside each, so the facade
--     needs no raw SQL and the rule cannot drift between callers.
-- -----------------------------------------------------------------------------
create or replace function public.list_personal_styles()
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(internal.personal_style_summary_json(ps)
                                                        order by ps.updated_at desc, ps.id), '[]'::jsonb))
    from public.personal_styles ps
   where ps.owner_identity_id = internal.require_identity()
$$;

create or replace function public.get_personal_style(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare ps public.personal_styles;
begin
  select * into ps from public.personal_styles
   where id = p_id and owner_identity_id = internal.require_identity();
  if ps.id is null then
    raise exception 'personal style % not found', p_id using errcode = 'P0002';
  end if;
  return internal.personal_style_json(ps);
end
$$;

create or replace function public.get_space_style(p_entity_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_identity();
  if not exists (select 1 from public.entities e
                  where e.id = p_entity_id and e.kind = 'style' and e.deleted_at is null
                    and internal.entity_readable(e.id)) then
    raise exception 'style % not found', p_entity_id using errcode = 'P0002';
  end if;
  return internal.space_style_json(p_entity_id);
end
$$;

-- `styles.list` space half: rows plus the default and whether it dangles.
-- Built-ins are prepended by the server (they are code, not rows).
create or replace function public.list_space_styles(p_space_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  me text;
  prefs public.identity_style_prefs;
  default_ref text;
  dangling boolean := false;
  items jsonb;
begin
  perform internal.require_space_member(p_space_id);
  me := internal.identity_id();
  select * into prefs from public.identity_style_prefs where identity_id = me;
  select default_style into default_ref from public.space_style_defaults where space_id = p_space_id;
  default_ref := coalesce(default_ref, 'builtin:atelier-light');
  if default_ref like 'space:%' then
    dangling := not exists (select 1 from public.entities
                             where id = substr(default_ref, 7)::uuid and kind = 'style'
                               and deleted_at is null);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'origin', 'space',
           'id', e.id,
           'ref', 'space:' || e.id,
           'title', s.title,
           'foundation', s.foundation,
           'varCount', (select count(*) from jsonb_object_keys(s.vars)),
           'hasCss', s.css is not null and btrim(s.css) <> '',
           'tags', to_jsonb(s.tags),
           'version', e.version,
           'resolvedHash', s.resolved_hash,
           'pushedBy', s.pushed_by,
           'pushedAt', s.pushed_at,
           'isDefault', default_ref = 'space:' || e.id,
           'inUseByMe', prefs.current_style = 'space:' || e.id or prefs.dark_style = 'space:' || e.id,
           -- Any active member may push a new version (sign-off decision);
           -- require_space_member above already proved this caller is one.
           'canPush', true)
         order by s.title, e.id), '[]'::jsonb)
    into items
    from public.entities e join public.styles s on s.entity_id = e.id
   where e.space_id = p_space_id and e.kind = 'style' and e.deleted_at is null
     and internal.entity_readable(e.id);

  return jsonb_build_object('items', items, 'defaultStyle', default_ref, 'defaultDangling', dangling);
end
$$;

create or replace function public.get_identity_style_prefs()
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare prefs public.identity_style_prefs;
begin
  select * into prefs from public.identity_style_prefs where identity_id = internal.require_identity();
  if prefs.identity_id is null then
    return jsonb_build_object('prefs', null);
  end if;
  return jsonb_build_object('prefs', internal.style_prefs_json(prefs));
end
$$;

create or replace function public.get_space_style_default(p_space_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare d public.space_style_defaults;
begin
  perform internal.require_space_member(p_space_id);
  select * into d from public.space_style_defaults where space_id = p_space_id;
  if d.space_id is null then
    -- No row: the built-in fallback, revision 0 (spec §3.5).
    return jsonb_build_object('spaceId', p_space_id, 'defaultStyle', 'builtin:atelier-light',
                              'setBy', null, 'revision', 0, 'updatedAt', null);
  end if;
  return jsonb_build_object('spaceId', d.space_id, 'defaultStyle', d.default_style,
                            'setBy', d.set_by, 'revision', d.revision, 'updatedAt', d.updated_at);
end
$$;

-- -----------------------------------------------------------------------------
-- 17. Grants. 008's wholesale grant was a one-time statement; functions
--     created afterwards need their own. Full argument signatures.
-- -----------------------------------------------------------------------------
revoke all on function public.create_personal_style(text,text,text,jsonb,text,text[],text,text) from public;
grant execute on function public.create_personal_style(text,text,text,jsonb,text,text[],text,text) to tm8_app;
revoke all on function public.update_personal_style(uuid,integer,text,text,text,jsonb,text,text[],text,text) from public;
grant execute on function public.update_personal_style(uuid,integer,text,text,text,jsonb,text,text[],text,text) to tm8_app;
revoke all on function public.delete_personal_style(uuid,integer,text) from public;
grant execute on function public.delete_personal_style(uuid,integer,text) to tm8_app;
revoke all on function public.pull_style(uuid,text,text) from public;
grant execute on function public.pull_style(uuid,text,text) to tm8_app;
revoke all on function public.push_style(uuid,uuid,uuid,integer,uuid,text,text,text) from public;
grant execute on function public.push_style(uuid,uuid,uuid,integer,uuid,text,text,text) to tm8_app;
revoke all on function public.remove_style(uuid,integer,uuid,text) from public;
grant execute on function public.remove_style(uuid,integer,uuid,text) to tm8_app;
revoke all on function public.set_identity_style_prefs(text,text,boolean,text[],integer,text) from public;
grant execute on function public.set_identity_style_prefs(text,text,boolean,text[],integer,text) to tm8_app;
revoke all on function public.set_space_style_default(uuid,text,integer,text) from public;
grant execute on function public.set_space_style_default(uuid,text,integer,text) to tm8_app;
revoke all on function public.list_personal_styles() from public;
grant execute on function public.list_personal_styles() to tm8_app;
revoke all on function public.get_personal_style(uuid) from public;
grant execute on function public.get_personal_style(uuid) to tm8_app;
revoke all on function public.get_space_style(uuid) from public;
grant execute on function public.get_space_style(uuid) to tm8_app;
revoke all on function public.list_space_styles(uuid) from public;
grant execute on function public.list_space_styles(uuid) to tm8_app;
revoke all on function public.get_identity_style_prefs() from public;
grant execute on function public.get_identity_style_prefs() to tm8_app;
revoke all on function public.get_space_style_default(uuid) from public;
grant execute on function public.get_space_style_default(uuid) to tm8_app;

-- The internal helpers are called only from the SECURITY DEFINER doors above,
-- which run as the owner; nothing grants them to tm8_app.
revoke all on function internal.style_ref_doc(text) from public;
revoke all on function internal.emit_identity_style_event(text,jsonb,text) from public;
revoke all on function internal.refresh_style_snapshots(text,uuid,jsonb,text,text) from public;
revoke all on function internal.personal_style_event(public.personal_styles,boolean,text) from public;
revoke all on function internal.personal_style_json(public.personal_styles) from public;
revoke all on function internal.personal_style_summary_json(public.personal_styles) from public;
revoke all on function internal.space_style_json(uuid) from public;

reset role;
