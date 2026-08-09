-- =============================================================================
-- 088 — Space folders: a directory tree the user UPLOADED, named by them, owned
-- by the Space.
--
-- THERE ARE TWO KINDS OF FILE ROOT IN tm8 AND THEY ARE NOT ALTERNATIVES.
--   1. A LINKED PROJECT is a LIVE directory on the node. It is read through
--      `projects.files.list` / `projects.files.read`, which jail every path
--      inside the project's working directory. Nothing here touches that.
--   2. A SPACE FOLDER is an IMMUTABLE SNAPSHOT the user uploaded. It has no
--      directory on the node at all. That is what this file builds.
--
-- WHY THE SNAPSHOT IS NOT EXPANDED ONTO THE FILESYSTEM.
--
-- An uploaded tree is stored as CONTENT-ADDRESSED BLOBS PLUS VALIDATED PATH
-- ROWS. Nothing is ever written to a path derived from an archive member name.
-- Three consequences, and they are the entire reason for the design:
--
--   * ZIP-SLIP COLLAPSES FROM AN EXPLOIT TO A STRING CHECK. With no filesystem
--     to escape, `../../etc/passwd` is a bad row, not a bad write. The ingest
--     path still REFUSES it by name (see the server-side validator) rather than
--     normalising it away, because a silent normalisation hides an attack from
--     every log — but a validator bug here loses a refusal, not a machine.
--   * DEDUP IS FREE. `stored_blobs` is already content-addressed and
--     space-scoped, so re-uploading a tree stores only the bytes that changed.
--   * BROWSING NEEDS NO JAIL. It is an equality lookup on a path column that
--     the ingest validator already proved well-formed.
--
-- WHY `stored_blobs` AND NOT A SECOND BLOB TABLE.
--
-- `public.stored_blobs` (055_artifacts.sql:58-73) is already exactly this: a
-- space-scoped, content-addressed row with a frozen `spaces/<uuid>/<uuid>`
-- storage_path and an `unreferenced_since` column a GC sweep is meant to read.
-- A second blob table would be a second GC contract and a second place for a
-- refcount bug to live. `space_folder_entries.blob_id` therefore carries the
-- SAME `on delete restrict` posture `artifact_bundle_entries` (055:133-146)
-- established: a blob with a live entry cannot be deleted, so a refcount bug is
-- a loud FK error instead of a 404 in a file viewer.
--
-- WHY THERE IS A DIRECTORY TABLE AND NOT JUST A PREFIX QUERY.
--
-- Listing "one level" off a path column means a LIKE-prefix scan, which is a
-- RECURSIVE read — it returns every descendant and then throws most of them
-- away. That is the read this feature must never perform on a tree with a
-- hundred thousand paths. `space_folder_dirs` materialises the directory set at
-- ingest, so browsing one level is TWO EXACT-EQUALITY lookups (child dirs by
-- `parent_path`, child files by `dir_path`) and the query plan cannot degrade
-- into a scan no matter how deep the tree is.
--
-- It also preserves a fact the blob model would otherwise silently lose: an
-- EMPTY DIRECTORY. A ZIP carries directory entries; a table of files-with-blobs
-- cannot represent a directory with no files in it, and dropping one would be
-- exactly the kind of quiet, unreported loss `SpaceFolderUploadResult.skipped[]`
-- exists to prevent.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE.
--
--   * A space folder is NOT an entity. It mints no envelope, so
--     `internal.entity_content` is NOT touched here and the 055 shared-object
--     hazard (a lexically-later migration silently replacing the whole body)
--     does not apply to this file. Do not add an arm; there is no kind to add.
--   * There is no `space_folders.delete`. Deleting a folder must decrement blob
--     references and hand them to the GC sweep, and that sweep is still Phase 2
--     (055 §2). A delete that leaks blobs is worse than no delete.
--   * There are no quotas. The caps the ingest path applies are SAFETY limits
--     against archive bombs, not storage quotas — see the server-side comment.
-- =============================================================================

-- Same reason as every other detail table and RPC in this chain: SECURITY
-- DEFINER functions must run as the owner, or RLS applies to them on tables
-- they do not own and the first RPC call fails at runtime while every
-- migration-time check passes (053 hit exactly this). `reset role` at the end.
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The root. Named BY THE USER, which is the whole point of the feature — the
--    ask was "place it beneath a server-side root directory created/named by
--    the user", so the name is user data, not derived from the archive.
--
--    `entry_count` / `total_size_bytes` are denormalised so listing a Space's
--    folders is one row per folder and never a count(*) over the entry table.
--    Both are maintained ONLY by `public.ingest_space_folder`, which is the
--    only writer of `space_folder_entries`.
-- -----------------------------------------------------------------------------
create table public.space_folders (
  id               uuid primary key default internal.new_id(),
  space_id         uuid not null references public.spaces(id) on delete cascade,
  name             text not null check (char_length(btrim(name)) between 1 and 200),
  created_by       uuid not null references public.entities(id),
  entry_count      integer not null default 0 check (entry_count >= 0),
  total_size_bytes bigint  not null default 0 check (total_size_bytes >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Case- and whitespace-insensitive, because two folders called "Docs" and
-- "docs " in one Space is a naming accident, not an intent.
create unique index space_folders_space_name_idx
  on public.space_folders(space_id, lower(btrim(name)));
create index space_folders_space_idx on public.space_folders(space_id, created_at desc);

create trigger space_folders_touch_updated_at before update on public.space_folders
for each row execute function internal.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 2. The directory set. `path` is the directory's own path relative to the
--    folder root, with '' for the root itself. `parent_path` is NULL for the
--    root row and the containing directory for every other row — so "list the
--    children of X" is `where folder_id = $1 and parent_path = $2`, an equality
--    on an index, never a prefix scan.
--
--    Paths are stored NORMALISED AND ALREADY VALIDATED: forward slashes only,
--    no leading or trailing slash, no '.' or '..' segment, no NUL, no empty
--    segment. The server refuses a member that violates any of those BY NAME
--    before it ever reaches this table. The CHECK constraints below are the
--    belt to that braces — they exist so a future writer that skips the
--    validator produces a loud constraint violation instead of a poisoned tree.
-- -----------------------------------------------------------------------------
create table public.space_folder_dirs (
  folder_id   uuid not null references public.space_folders(id) on delete cascade,
  path        text not null check (
                path = ''
                or (path !~ '(^|/)\.\.?(/|$)'
                    and path !~ '^/' and path !~ '/$' and path !~ '//'
                    and path !~ E'[\\x00-\\x1f]'
                    and path !~ E'\\\\'
                    and char_length(path) <= 1024)),
  parent_path text,
  created_at  timestamptz not null default now(),
  primary key (folder_id, path),
  -- Exactly one row per folder may be the root, and only the root may be
  -- parentless. Written as a two-way CHECK so neither half can drift.
  constraint space_folder_dirs_root_is_parentless
    check ((path = '') = (parent_path is null))
);
create index space_folder_dirs_children_idx
  on public.space_folder_dirs(folder_id, parent_path);

-- -----------------------------------------------------------------------------
-- 3. The path rows. Shape copied from `artifact_bundle_entries` (055:133-146),
--    including the ON DELETE RESTRICT on the blob.
--
--    `dir_path` is the containing directory and carries a COMPOSITE FK into
--    `space_folder_dirs`. That FK is load-bearing: it makes a file in a
--    directory that was never recorded STRUCTURALLY IMPOSSIBLE, so browse can
--    never show a directory whose children it cannot enumerate, nor hide a file
--    whose directory it forgot to list.
-- -----------------------------------------------------------------------------
create table public.space_folder_entries (
  folder_id  uuid not null references public.space_folders(id) on delete cascade,
  path       text not null check (
               path <> ''
               and path !~ '(^|/)\.\.?(/|$)'
               and path !~ '^/' and path !~ '/$' and path !~ '//'
               and path !~ E'[\\x00-\\x1f]'
               and path !~ E'\\\\'
               and char_length(path) <= 1024),
  dir_path   text not null,
  media_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  -- RESTRICT, exactly as 055:138-140: a blob with a live entry cannot be
  -- deleted, so a refcount bug is a loud FK error and not a 404 in a viewer.
  blob_id    uuid not null references public.stored_blobs(id) on delete restrict,
  created_at timestamptz not null default now(),
  -- Duplicate paths are structurally impossible, independent of validation.
  primary key (folder_id, path),
  foreign key (folder_id, dir_path)
    references public.space_folder_dirs(folder_id, path) on delete cascade
);
create index space_folder_entries_dir_idx on public.space_folder_entries(folder_id, dir_path);
create index space_folder_entries_blob_idx on public.space_folder_entries(blob_id);

-- -----------------------------------------------------------------------------
-- 4. RLS + grants. `tm8_app` gets SELECT only; every write is a SECURITY
--    DEFINER RPC (008 §3). A table created after 008's one-time loop does all
--    three steps itself.
-- -----------------------------------------------------------------------------
alter table public.space_folders enable row level security;
alter table public.space_folder_dirs enable row level security;
alter table public.space_folder_entries enable row level security;

create policy space_folders_select on public.space_folders for select to tm8_app
  using (internal.is_space_member(space_id));

create policy space_folder_dirs_select on public.space_folder_dirs for select to tm8_app
  using (exists (
    select 1 from public.space_folders f
     where f.id = folder_id and internal.is_space_member(f.space_id)));

create policy space_folder_entries_select on public.space_folder_entries for select to tm8_app
  using (exists (
    select 1 from public.space_folders f
     where f.id = folder_id and internal.is_space_member(f.space_id)));

grant select on public.space_folders to tm8_app;
grant select on public.space_folder_dirs to tm8_app;
grant select on public.space_folder_entries to tm8_app;

-- -----------------------------------------------------------------------------
-- 5. `spaceFolders.create` — mint an empty, named root.
--
-- Creating the root and ingesting bytes into it are DELIBERATELY TWO
-- OPERATIONS. An upload is three round trips (open an upload slot, PUT the
-- archive to the raw byte sink, ingest) and the folder must exist before the
-- first of them, so that a failed or abandoned upload leaves a visible empty
-- folder the user can retry into rather than nothing at all.
-- -----------------------------------------------------------------------------
create or replace function public.create_space_folder(
  p_space_id uuid,
  p_name text,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  folder public.space_folders;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaceFolders.create');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay ->> 'spaceId', p_space_id::text, 'space');
    return replay;
  end if;

  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  if p_name is null or char_length(btrim(p_name)) = 0 then
    raise exception 'space folder name is required' using errcode = '22023';
  end if;

  begin
    insert into public.space_folders(space_id, name, created_by)
    values (p_space_id, btrim(p_name), actor)
    returning * into folder;
  exception when unique_violation then
    -- A NAMED conflict, never a silent reuse of somebody else's folder: two
    -- trees under one name would be indistinguishable to every later reader.
    raise exception 'a folder with that name already exists in this Space'
      using errcode = '23505', detail = 'duplicate_folder_name';
  end;

  return internal.ledger_record(p_client_mutation_id, 'spaceFolders.create',
    jsonb_build_object(
      'id', folder.id,
      'spaceId', folder.space_id,
      'name', folder.name,
      'entryCount', folder.entry_count,
      'totalSizeBytes', folder.total_size_bytes,
      'createdBy', folder.created_by,
      'createdAt', folder.created_at,
      'updatedAt', folder.updated_at));
end
$$;

revoke all on function public.create_space_folder(uuid, text, uuid, text) from public;
grant execute on function public.create_space_folder(uuid, text, uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 6. `spaceFolders.ingest` — record one already-validated, already-stored batch
--    of members.
--
-- THIS RPC DOES NOT PARSE ANYTHING. The archive is read, validated and written
-- to the blob store by the server before this is called; what arrives here is a
-- list of paths that have already been refused-or-accepted by name, and blobs
-- that already exist. Splitting it that way keeps the parser in a language that
-- can stream bytes and keeps the transaction here short.
--
-- `p_dirs` is a jsonb array of directory paths (WITHOUT the root, which this
-- function inserts itself). `p_entries` is a jsonb array of
-- `{path, dirPath, mediaType, sizeBytes, sha256}`. Blobs are resolved by
-- (space, sha256) and the declared size is VERIFIED against the stored row
-- rather than trusted — the same posture as `internal.artifact_insert_revision`
-- (055 §10).
--
-- Re-ingesting a path REPLACES it. A space folder is a snapshot and a user who
-- uploads the same tree twice means the second one; the alternative is a folder
-- that can never be corrected.
-- -----------------------------------------------------------------------------
create or replace function public.ingest_space_folder(
  p_folder_id uuid,
  p_dirs jsonb,
  p_entries jsonb,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  folder public.space_folders;
  actor uuid;
  dir_path text;
  entry jsonb;
  entry_blob public.stored_blobs;
  added integer := 0;
  replaced integer := 0;
  existed boolean;
  resolved_total bigint;
  resolved_count integer;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaceFolders.ingest');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay ->> 'folderId', p_folder_id::text, 'entity');
    return replay;
  end if;

  select * into folder from public.space_folders where id = p_folder_id for update;
  if folder.id is null then
    raise exception 'space folder not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(folder.space_id);
  actor := internal.resolve_actor(p_actor_id, folder.space_id);
  perform internal.bind_actor(actor);

  -- The root row is this function's own invariant, not the caller's.
  insert into public.space_folder_dirs(folder_id, path, parent_path)
  values (p_folder_id, '', null)
  on conflict (folder_id, path) do nothing;

  -- Directories first and SHALLOWEST FIRST, because each row's parent must
  -- already exist for the composite FK on the entries to have anything to point
  -- at. The caller sends them sorted; sorting again here means a caller that
  -- forgets cannot produce a half-built tree.
  for dir_path in
    select value #>> '{}' from jsonb_array_elements(coalesce(p_dirs, '[]'::jsonb))
     order by length(value #>> '{}')
  loop
    insert into public.space_folder_dirs(folder_id, path, parent_path)
    values (p_folder_id, dir_path,
            case when strpos(dir_path, '/') = 0 then ''
                 else left(dir_path, length(dir_path) - strpos(reverse(dir_path), '/')) end)
    on conflict (folder_id, path) do nothing;
  end loop;

  for entry in select value from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    select * into entry_blob from public.stored_blobs
     where space_id = folder.space_id and sha256 = lower(entry ->> 'sha256');
    if entry_blob.id is null then
      raise exception 'ingest references an unknown blob (sha256 %)', entry ->> 'sha256'
        using errcode = '22023', detail = 'unknown_blob';
    end if;
    if entry_blob.size_bytes <> (entry ->> 'sizeBytes')::bigint then
      -- Same posture as 055 §10: a declared size that disagrees with the stored
      -- bytes is surfaced, never smoothed over.
      raise exception 'declared size does not match stored blob for %', entry ->> 'path'
        using errcode = '22023', detail = 'size_mismatch';
    end if;

    select true into existed from public.space_folder_entries
     where folder_id = p_folder_id and path = entry ->> 'path';

    insert into public.space_folder_entries(
      folder_id, path, dir_path, media_type, size_bytes, blob_id)
    values (p_folder_id, entry ->> 'path', entry ->> 'dirPath',
            entry ->> 'mediaType', entry_blob.size_bytes, entry_blob.id)
    on conflict (folder_id, path) do update
      set dir_path = excluded.dir_path,
          media_type = excluded.media_type,
          size_bytes = excluded.size_bytes,
          blob_id = excluded.blob_id;

    if coalesce(existed, false) then replaced := replaced + 1; else added := added + 1; end if;
    existed := null;

    update public.stored_blobs set unreferenced_since = null
     where id = entry_blob.id and unreferenced_since is not null;
  end loop;

  -- Recomputed, never incremented: a counter that drifts is worse than a count.
  select count(*), coalesce(sum(size_bytes), 0)
    into resolved_count, resolved_total
    from public.space_folder_entries where folder_id = p_folder_id;

  update public.space_folders
     set entry_count = resolved_count,
         total_size_bytes = resolved_total,
         updated_at = now()
   where id = p_folder_id;

  return internal.ledger_record(p_client_mutation_id, 'spaceFolders.ingest',
    jsonb_build_object(
      'folderId', p_folder_id,
      'added', added,
      'replaced', replaced,
      'entryCount', resolved_count,
      'totalSizeBytes', resolved_total));
end
$$;

revoke all on function public.ingest_space_folder(uuid, jsonb, jsonb, uuid, text) from public;
grant execute on function public.ingest_space_folder(uuid, jsonb, jsonb, uuid, text) to tm8_app;

reset role;
