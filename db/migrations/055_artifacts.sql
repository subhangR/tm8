-- =============================================================================
-- 055 — Artifacts: web bundles (immutable published revisions) + the blob seam.
--
-- Design: docs/plans/TM8-ARTIFACTS-DESIGN.md (§5 physical schema, §5.3
-- non-debounced publish). Corrections applied from
-- docs/plans/TM8-FOUNDATION-VERIFICATION.md — in particular V4, which REFUTED
-- the design's §5.1 note that an unconditional append-only trigger survives the
-- FK purge cascade. It does not: a cascaded delete fires row triggers as part
-- of the same statement, whoever owns the table, so an unconditional trigger
-- makes artifact-entity purge (and space delete) fail at its last step. The
-- trigger below therefore carries an explicit purge exemption — see §5.
--
-- ⚠ SHARED-OBJECT NOTICE (052's rule, restated by 053):
-- §7 below does `create or replace function internal.entity_content`. That
-- swaps the ENTIRE body; the lexically-later migration silently wins. The base
-- text here is copied verbatim from 054_entity_memory.sql (the latest
-- definition at the time of writing; 001 → 005 → 011 → 015 → 017 → 053 → 054),
-- plus one `artifact` arm — so it carries the `voice_channel` (053) AND
-- `memory` (054) arms forward. THE WORKTREES LANE STILL NEEDS AN ARM IN THIS
-- FUNCTION: whoever writes next must copy THIS file's body, not 054's or
-- 053's, or the `artifact` content hydration disappears silently. Verify with
-- pg_get_functiondef against a scratch chain.
--
-- This file re-declares NOTHING owned by 052 (the edge guard, the src_kinds
-- arrays, the renamed authored_from index). The writer token this feature uses
-- on `authored_from` edges — `artifact_publisher` — was allocated and proven
-- accepted by 052.
--
-- One-way-door note: the `artifact` core kind seed below is irreversible
-- (`entity_kinds_guard_core`, 005, blocks update/delete of core rows). It lands
-- here atomically with its CoreEntityKind contract entry per the build-order
-- manifest §4, in the working tree only (nothing committed).
-- =============================================================================

-- Everything below must be OWNED BY tm8_graph_owner, like every other detail
-- table and RPC in the chain. Without this, SECURITY DEFINER functions run as
-- the migration user, RLS applies to them on tables they don't own, and the
-- first RPC create fails at runtime while every migration-time check passes
-- (053 hit exactly this; its comment records it). `reset role` at the bottom.
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry. Same idempotent seed shape as 015/053.
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('artifact', 'core', null, 'package')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. The blob seam. `stored_blobs` did NOT exist before this migration — bytes
--    live on disk under W2BlobStore's frozen `spaces/<uuid>/<uuid>` shape, and
--    content addressing lives HERE as `unique (space_id, sha256)`, never in the
--    path (design §5.1 Decision 2). Space-scoped uniqueness is load-bearing:
--    two spaces holding identical bytes must not share a row, or purging one
--    space's artifact could revoke the other's.
--    The `files` backfill is deliberately NOT here (Phase 2, design §5.4).
-- -----------------------------------------------------------------------------
create table public.stored_blobs (
  id           uuid primary key default internal.new_id(),
  space_id     uuid not null references public.spaces(id) on delete cascade,
  sha256       text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes   bigint not null check (size_bytes >= 0),
  -- The SAME frozen shape W2BlobStore already enforces. Server-generated (S17).
  storage_path text not null unique
    check (storage_path ~ '^spaces/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  created_at   timestamptz not null default now(),
  -- Set when the last reference drops; the GC sweep (Phase 2) reads it. Never
  -- sweep inside the grace window, and never sweep a row created inside it.
  unreferenced_since timestamptz,
  unique (space_id, sha256)
);
create index stored_blobs_sweep_idx on public.stored_blobs(unreferenced_since)
  where unreferenced_since is not null;

-- -----------------------------------------------------------------------------
-- 3. Revisions — created BEFORE public.artifacts so the detail table can carry
--    a NOT NULL FK to its current revision. Insert order inside the RPCs is
--    envelope → revision → artifacts row, so no deferral is needed and an
--    artifact structurally always has a revision (design §5.2's deferred CHECK
--    is not valid Postgres; the NOT NULL FK + insert order achieves the same).
-- -----------------------------------------------------------------------------
create table public.artifact_bundle_revisions (
  id                 uuid primary key default internal.new_id(),
  artifact_entity_id uuid not null references public.entities(id) on delete cascade,
  space_id           uuid not null references public.spaces(id) on delete cascade,
  revision_number    integer not null check (revision_number > 0),
  manifest           jsonb not null,
  manifest_sha256    text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  entrypoint_path    text not null,
  file_count         integer not null check (file_count between 1 and 128),
  total_size_bytes   bigint not null check (total_size_bytes >= 0),
  source_provenance  jsonb not null,
  published_by       uuid not null references public.entities(id),
  created_at         timestamptz not null default now(),
  unique (artifact_entity_id, revision_number)
);
create index artifact_bundle_revisions_artifact_idx
  on public.artifact_bundle_revisions(artifact_entity_id, revision_number desc);

-- No uniqueness on manifest_sha256: publishing identical bytes twice is legal
-- and creates a new revision — provenance differs even when content does not.

create table public.artifacts (
  entity_id           uuid primary key references public.entities(id) on delete cascade,
  name                text not null check (char_length(btrim(name)) between 1 and 200),
  description         text check (description is null or char_length(description) <= 2000),
  -- NO ACTION (default) on purpose, not RESTRICT: FK checks queue to statement
  -- end, so the entity-delete cascade that removes both this row and the
  -- revision row in one statement passes. RESTRICT would refuse mid-cascade.
  current_revision_id uuid not null references public.artifact_bundle_revisions(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger artifacts_validate_kind
before insert or update of entity_id on public.artifacts
for each row execute function internal.validate_detail_envelope('artifact');

create trigger artifacts_touch_updated_at before update on public.artifacts
for each row execute function internal.touch_updated_at();

-- ⚠ DELIBERATELY NO `snapshot_entity_version` trigger on public.artifacts,
-- unlike every other content-bearing core detail table (017 §1). This is not
-- the 015 omission bug — it is the design (§5.2, §5.3): an artifact's version
-- advances on PUBLISH, which must bypass the 5-minute snapshot debounce
-- (publish-look-tweak-publish inside the window would otherwise overwrite
-- revision N-1's snapshot in place). publish_artifact_revision below advances
-- `entities.version` and inserts the `entity_versions` row itself — the
-- established pattern of move_entity (017), the project materializer (021) and
-- w2g12_advance_profile_entity (027). Adding the trigger here would create two
-- competing version writers. Do not "fix" this absence.

create table public.artifact_bundle_entries (
  revision_id uuid not null references public.artifact_bundle_revisions(id) on delete cascade,
  path        text not null,
  media_type  text not null,
  size_bytes  bigint not null check (size_bytes >= 0),
  -- RESTRICT is the referential half of GC: a blob with a live entry cannot be
  -- deleted, so a refcount bug is a loud FK error, not a 404 in a preview.
  blob_id     uuid not null references public.stored_blobs(id) on delete restrict,
  ordinal     integer not null,
  -- Exact-equality lookup for the preview; duplicate paths structurally
  -- impossible independent of manifest validation.
  primary key (revision_id, path)
);
create index artifact_bundle_entries_blob_idx on public.artifact_bundle_entries(blob_id);

create table public.artifact_preview_sessions (
  id                 uuid primary key default internal.new_id(),
  artifact_entity_id uuid not null references public.entities(id) on delete cascade,
  revision_id        uuid not null references public.artifact_bundle_revisions(id) on delete cascade,
  space_id           uuid not null references public.spaces(id) on delete cascade,
  viewer_identity_id text not null,
  -- The hash, never the token (the w2-file-upload discipline): a database read
  -- never yields a usable credential.
  token_hash         text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  revoked_at         timestamptz
);
create index artifact_preview_sessions_expiry_idx
  on public.artifact_preview_sessions(expires_at);

-- -----------------------------------------------------------------------------
-- 5. Append-only enforcement on revisions — WITH the purge exemption V4 proved
--    necessary (docs/plans/TM8-FOUNDATION-VERIFICATION.md §V4).
--
--    Mechanism: a FK `on delete cascade` fires the referencing table's row
--    triggers inside the FK's own internal trigger, so during a legitimate
--    purge (delete of the artifact entity, or of the whole space)
--    `pg_trigger_depth()` is >= 1 by the time this table's row trigger is
--    evaluated. A direct client `DELETE FROM artifact_bundle_revisions` runs at
--    depth 0. The WHEN clause below therefore refuses exactly the direct
--    deletes while letting the cascade through — the refusal and the exemption
--    are both proven by db/test/artifacts.test.mjs (the red/green pair the
--    verification demanded).
--
--    UPDATE has no exemption: nothing legitimately updates a revision row,
--    cascade or otherwise (entity ids are immutable; there is no ON UPDATE
--    CASCADE anywhere in this chain).
--
--    Known residual, accepted: a DELETE issued from inside any OTHER user
--    trigger would also run at depth > 0 and bypass the guard. tm8_app holds no
--    DELETE grant on this table at all, so the guard is a belt against
--    owner/SECURITY DEFINER bugs, not the primary barrier.
-- -----------------------------------------------------------------------------
create or replace function internal.artifact_revisions_append_only() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  raise exception 'artifact bundle revisions are append-only'
    using errcode = '42501';
end
$$;

create trigger artifact_bundle_revisions_no_update
before update on public.artifact_bundle_revisions
for each row execute function internal.artifact_revisions_append_only();

create trigger artifact_bundle_revisions_no_delete
before delete on public.artifact_bundle_revisions
for each row when (pg_trigger_depth() = 0)
execute function internal.artifact_revisions_append_only();

-- -----------------------------------------------------------------------------
-- 6. Preview revocation on soft delete: a running preview must stop being
--    servable at the moment of deletion, not at the next sweep (design §10.2).
--    `public.delete_entity` (007) is shared and immutable, so the revocation
--    rides an additive trigger on the envelope rather than an edit to the RPC.
-- -----------------------------------------------------------------------------
create or replace function internal.revoke_artifact_previews() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.artifact_preview_sessions
       set revoked_at = now()
     where artifact_entity_id = new.id and revoked_at is null;
  end if;
  return new;
end
$$;

create trigger entities_revoke_artifact_previews
after update of deleted_at on public.entities
for each row when (new.kind = 'artifact')
execute function internal.revoke_artifact_previews();

-- -----------------------------------------------------------------------------
-- 7. Content hydration. See the SHARED-OBJECT NOTICE at the top of this file.
--    Body: 054's, verbatim, plus the `artifact` arm. (Hole 1 of the design's
--    §A.1: omitting this arm returns `{}` silently, forever —
--    db/test/loop_rpcs.test.mjs carries the explicit assertion.)
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
      when 'memory' then select to_jsonb(m) - 'entity_id' into content from public.memories m where m.entity_id = target;
      when 'artifact' then select to_jsonb(a) - 'entity_id' into content from public.artifacts a where a.entity_id = target;
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
-- 8. RLS + grants. `tm8_app` gets SELECT only on all five tables; every write
--    is a SECURITY DEFINER RPC (008 §3). Read predicates mirror
--    entity_versions_select: the envelope's visibility, via entity_readable.
--    008's loop and wholesale grants were one-time statements — a table created
--    afterwards does all three steps itself (008 is immutable).
-- -----------------------------------------------------------------------------
alter table public.stored_blobs enable row level security;
alter table public.artifacts enable row level security;
alter table public.artifact_bundle_revisions enable row level security;
alter table public.artifact_bundle_entries enable row level security;
alter table public.artifact_preview_sessions enable row level security;

create policy stored_blobs_select on public.stored_blobs for select to tm8_app
  using (internal.is_space_member(space_id));

create policy artifacts_select on public.artifacts for select to tm8_app
  using (internal.entity_readable(entity_id));

create policy artifact_bundle_revisions_select on public.artifact_bundle_revisions
  for select to tm8_app
  using (internal.entity_readable(artifact_entity_id));

create policy artifact_bundle_entries_select on public.artifact_bundle_entries
  for select to tm8_app
  using (exists (
    select 1 from public.artifact_bundle_revisions r
     where r.id = revision_id and internal.entity_readable(r.artifact_entity_id)));

create policy artifact_preview_sessions_select on public.artifact_preview_sessions
  for select to tm8_app
  using (internal.entity_readable(artifact_entity_id));

grant select on public.stored_blobs to tm8_app;
grant select on public.artifacts to tm8_app;
grant select on public.artifact_bundle_revisions to tm8_app;
grant select on public.artifact_bundle_entries to tm8_app;
grant select on public.artifact_preview_sessions to tm8_app;

-- -----------------------------------------------------------------------------
-- 9. The blob write RPC (Phase 0 item 0.8b). Registers an uploaded blob under
--    content addressing. Idempotent on (space_id, sha256): a duplicate upload
--    returns the CANONICAL row (the caller learns `inserted: false` and must
--    discard its staged duplicate file; the stored storage_path wins).
-- -----------------------------------------------------------------------------
create or replace function public.register_stored_blob(
  p_space_id uuid, p_sha256 text, p_size_bytes bigint, p_storage_path text,
  p_actor_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  existing public.stored_blobs;
  blob_id uuid;
begin
  perform internal.require_space_member(p_space_id);
  perform internal.resolve_actor(p_actor_id, p_space_id);

  select * into existing from public.stored_blobs
   where space_id = p_space_id and sha256 = lower(p_sha256)
   for update;

  if existing.id is not null then
    if existing.size_bytes <> p_size_bytes then
      -- Same hash, different size: on-disk corruption or a lying client.
      -- Surfaced, never smoothed over (design §5.4's discipline).
      raise exception 'stored blob size disagrees with existing content-addressed row'
        using errcode = '23514';
    end if;
    update public.stored_blobs set unreferenced_since = null where id = existing.id;
    return jsonb_build_object(
      'blobId', existing.id, 'storagePath', existing.storage_path,
      'sizeBytes', existing.size_bytes, 'inserted', false);
  end if;

  insert into public.stored_blobs(space_id, sha256, size_bytes, storage_path)
  values (p_space_id, lower(p_sha256), p_size_bytes, p_storage_path)
  returning id into blob_id;

  return jsonb_build_object(
    'blobId', blob_id, 'storagePath', p_storage_path,
    'sizeBytes', p_size_bytes, 'inserted', true);
end
$$;

revoke all on function public.register_stored_blob(uuid,text,bigint,text,uuid) from public;
grant execute on function public.register_stored_blob(uuid,text,bigint,text,uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- 10. Shared internals for the two publish-shaped RPCs. p_entries is a jsonb
--     array of {path, mediaType, sizeBytes, sha256} in manifest (canonical)
--     order; blobs are resolved by (space, sha256) and the declared size is
--     verified against the row, never trusted (design §4.2).
-- -----------------------------------------------------------------------------
-- Two-pass shape on purpose: the revision row is append-only from birth, so
-- the total must be known BEFORE the insert — pass 1 resolves and verifies
-- every blob without writing, pass 2 inserts the one immutable row + entries.
create or replace function internal.artifact_insert_revision(
  p_artifact_entity_id uuid, p_space_id uuid, p_revision_number integer,
  p_manifest jsonb, p_manifest_sha256 text, p_entrypoint text,
  p_entries jsonb, p_provenance jsonb, p_actor uuid
) returns uuid language plpgsql set search_path = public, internal, pg_temp as $$
declare
  revision_id uuid;
  entry jsonb;
  entry_ordinal integer := 0;
  entry_blob public.stored_blobs;
  entry_count integer;
  running_total bigint := 0;
  saw_entrypoint boolean := false;
  resolved uuid[] := '{}';
  resolved_sizes bigint[] := '{}';
begin
  entry_count := jsonb_array_length(p_entries);
  if entry_count is null or entry_count < 1 or entry_count > 128 then
    raise exception 'artifact bundle must contain between 1 and 128 files'
      using errcode = '22023';
  end if;

  -- Pass 1: resolve every blob, verify sizes, sum the total, find the
  -- entrypoint. Nothing is written until the whole bundle is proven coherent.
  for entry in select value from jsonb_array_elements(p_entries) loop
    select * into entry_blob from public.stored_blobs
     where space_id = p_space_id and sha256 = lower(entry ->> 'sha256');
    if entry_blob.id is null then
      raise exception 'manifest references an unknown blob (sha256 %)', entry ->> 'sha256'
        using errcode = '22023', detail = 'unknown_blob';
    end if;
    if entry_blob.size_bytes <> (entry ->> 'sizeBytes')::bigint then
      raise exception 'declared size does not match stored blob for %', entry ->> 'path'
        using errcode = '22023', detail = 'size_mismatch';
    end if;
    resolved := resolved || entry_blob.id;
    resolved_sizes := resolved_sizes || entry_blob.size_bytes;
    running_total := running_total + entry_blob.size_bytes;
    if entry ->> 'path' = p_entrypoint then saw_entrypoint := true; end if;
  end loop;

  if not saw_entrypoint then
    raise exception 'entrypoint % is not among the bundle paths', p_entrypoint
      using errcode = '22023', detail = 'entrypoint_missing';
  end if;

  -- Pass 2: one immutable revision row, then its entries.
  insert into public.artifact_bundle_revisions(
    artifact_entity_id, space_id, revision_number, manifest, manifest_sha256,
    entrypoint_path, file_count, total_size_bytes, source_provenance, published_by)
  values (p_artifact_entity_id, p_space_id, p_revision_number, p_manifest,
          lower(p_manifest_sha256), p_entrypoint, entry_count, running_total,
          p_provenance, p_actor)
  returning id into revision_id;

  for entry in select value from jsonb_array_elements(p_entries) loop
    entry_ordinal := entry_ordinal + 1;
    insert into public.artifact_bundle_entries(
      revision_id, path, media_type, size_bytes, blob_id, ordinal)
    values (revision_id, entry ->> 'path', entry ->> 'mediaType',
            resolved_sizes[entry_ordinal], resolved[entry_ordinal], entry_ordinal - 1);
  end loop;

  update public.stored_blobs set unreferenced_since = null
   where id = any(resolved) and unreferenced_since is not null;

  return revision_id;
end
$$;

-- -----------------------------------------------------------------------------
-- 11. `artifacts.create` — entity + first revision, atomically (there is no
--     draft state; design §2.2/§2.3). Shape mirrors create_voice_channel (053),
--     which mirrors 036's replay-principal hardening.
-- -----------------------------------------------------------------------------
create or replace function public.create_artifact(
  p_space_id uuid, p_name text, p_description text,
  p_manifest jsonb, p_manifest_sha256 text, p_entrypoint text,
  p_entries jsonb, p_provenance jsonb,
  p_work_session_id uuid default null,
  p_actor_id uuid default null, p_parent_id uuid default null,
  p_position double precision default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  artifact_id uuid;
  revision_id uuid;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'artifacts.create');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  artifact_id := internal.create_envelope(p_space_id, 'artifact', actor, p_parent_id, p_position);
  revision_id := internal.artifact_insert_revision(
    artifact_id, p_space_id, 1, p_manifest, p_manifest_sha256, p_entrypoint,
    p_entries, p_provenance, actor);

  insert into public.artifacts(entity_id, name, description, current_revision_id)
  values (artifact_id, btrim(p_name), p_description, revision_id);

  perform internal.record_initial_version(artifact_id, actor);

  -- Provenance edge: at most one authored_from per source (the 052-renamed
  -- unique index), written under the writer token 052 allocated to this lane.
  if p_work_session_id is not null then
    perform internal.w1_set_writer('artifact_publisher');
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, artifact_id, p_work_session_id, 'authored_from', actor);
    perform internal.w1_set_writer(null);
  end if;

  activity_id := internal.record_activity(p_space_id, artifact_id, actor, 'created',
                   null, jsonb_build_object('kind', 'artifact'));
  return internal.ledger_record(p_client_mutation_id, 'artifacts.create',
           internal.command_result(artifact_id, null, activity_id, array[artifact_id]));
end
$$;

revoke all on function public.create_artifact(uuid,text,text,jsonb,text,text,jsonb,jsonb,uuid,uuid,uuid,double precision,text) from public;
grant execute on function public.create_artifact(uuid,text,text,jsonb,text,text,jsonb,jsonb,uuid,uuid,uuid,double precision,text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 12. `artifacts.publish` — a further revision, with the NON-DEBOUNCED version
--     write (design §5.3). The snapshot debounce
--     (internal.snapshot_entity_version, 001) would fold a second same-actor
--     publish inside 5 minutes into the previous snapshot — silently divorcing
--     version history from revision history. This RPC therefore advances
--     `entities.version` and inserts the `entity_versions` row directly, the
--     move_entity/materializer/profile pattern. The db test asserts TWO rows
--     after two rapid publishes — the exact inverse of the debounce test at
--     packages/server/test/w3/g02-public.test.ts.
-- -----------------------------------------------------------------------------
create or replace function public.publish_artifact_revision(
  p_artifact_entity_id uuid, p_expected_version integer,
  p_manifest jsonb, p_manifest_sha256 text, p_entrypoint text,
  p_entries jsonb, p_provenance jsonb,
  p_work_session_id uuid default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  revision_id uuid;
  next_revision integer;
  next_version integer;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'artifacts.publish');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_artifact_entity_id::text, 'entity');
    return replay;
  end if;

  select * into e from public.entities where id = p_artifact_entity_id;
  if e.id is null or e.kind <> 'artifact' or e.deleted_at is not null then
    raise exception 'artifact not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  -- Serialize publishes per artifact on the detail row, then check the version
  -- under the lock.
  perform 1 from public.artifacts where entity_id = p_artifact_entity_id for update;
  perform internal.assert_version(p_artifact_entity_id, p_expected_version);

  select coalesce(max(revision_number), 0) + 1 into next_revision
    from public.artifact_bundle_revisions
   where artifact_entity_id = p_artifact_entity_id;

  revision_id := internal.artifact_insert_revision(
    p_artifact_entity_id, e.space_id, next_revision, p_manifest,
    p_manifest_sha256, p_entrypoint, p_entries, p_provenance, actor);

  update public.artifacts
     set current_revision_id = revision_id, updated_at = now()
   where entity_id = p_artifact_entity_id;

  -- The non-debounced version write (see the section comment).
  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_artifact_entity_id
  returning version into next_version;

  insert into public.entity_versions(entity_id, version, snapshot, changed_by)
  values (p_artifact_entity_id, next_version,
          internal.entity_snapshot(p_artifact_entity_id), actor);

  activity_id := internal.record_activity(e.space_id, p_artifact_entity_id, actor,
                   'updated', null,
                   jsonb_build_object('kind', 'artifact', 'revisionNumber', next_revision));
  return internal.ledger_record(p_client_mutation_id, 'artifacts.publish',
           internal.command_result(p_artifact_entity_id, null, activity_id,
                                   array[p_artifact_entity_id]));
end
$$;

revoke all on function public.publish_artifact_revision(uuid,integer,jsonb,text,text,jsonb,jsonb,uuid,uuid,text) from public;
grant execute on function public.publish_artifact_revision(uuid,integer,jsonb,text,text,jsonb,jsonb,uuid,uuid,text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 13. `artifacts.preview.start` — a stateful, revocable capability row (design
--     §9.5): revocation must be immediate on delete, which a stateless signed
--     token cannot do. The RPC stores the token HASH the caller computed; the
--     token itself never touches the database.
-- -----------------------------------------------------------------------------
create or replace function public.start_artifact_preview(
  p_artifact_entity_id uuid, p_revision_number integer,
  p_token_hash text, p_viewer_identity_id text,
  p_ttl_seconds integer default 600,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  target_revision public.artifact_bundle_revisions;
  session_id uuid;
  session_expires timestamptz;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'artifacts.preview.start');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_artifact_entity_id::text, 'entity');
    return replay;
  end if;

  select * into e from public.entities where id = p_artifact_entity_id;
  if e.id is null or e.kind <> 'artifact' or e.deleted_at is not null then
    raise exception 'artifact not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  if p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 3600 then
    raise exception 'preview TTL must be between 1 and 3600 seconds'
      using errcode = '22023';
  end if;

  if p_revision_number is null then
    select r.* into target_revision
      from public.artifacts a
      join public.artifact_bundle_revisions r on r.id = a.current_revision_id
     where a.entity_id = p_artifact_entity_id;
  else
    select r.* into target_revision
      from public.artifact_bundle_revisions r
     where r.artifact_entity_id = p_artifact_entity_id
       and r.revision_number = p_revision_number;
  end if;
  if target_revision.id is null then
    raise exception 'artifact revision not found' using errcode = 'P0002';
  end if;

  session_expires := now() + make_interval(secs => p_ttl_seconds);
  insert into public.artifact_preview_sessions(
    artifact_entity_id, revision_id, space_id, viewer_identity_id,
    token_hash, expires_at)
  values (p_artifact_entity_id, target_revision.id, e.space_id,
          p_viewer_identity_id, lower(p_token_hash), session_expires)
  returning id into session_id;

  return internal.ledger_record(p_client_mutation_id, 'artifacts.preview.start',
           jsonb_build_object(
             'previewSessionId', session_id,
             'revisionNumber', target_revision.revision_number,
             'expiresAt', to_jsonb(session_expires) #>> '{}'));
end
$$;

revoke all on function public.start_artifact_preview(uuid,integer,text,text,integer,uuid,text) from public;
grant execute on function public.start_artifact_preview(uuid,integer,text,text,integer,uuid,text) to tm8_app;

reset role;
