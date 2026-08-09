-- 094 — File upload slot sweep doors (2026-08-10).
--
-- 006 created `internal.expire_file_upload_slots()` and nothing ever called
-- it: a pending slot past `expires_at` sat `pending` forever, and the bytes a
-- client STAGED for an upload it never completed sat on disk forever. Abort
-- removes its own bytes, but only when abort is actually called — a closed
-- laptop leaves staged bytes with no owner.
--
-- Two doors for the scheduler's sweep job (the R26 runner in
-- packages/server/src/scheduler):
--
--   * `public.sweep_file_upload_slots(limit)` marks overdue pending slots
--     expired and returns a bounded batch of expired/aborted slots whose
--     staged bytes have not yet been purged from the blob store.
--   * `public.mark_file_upload_slots_purged(ids)` records that the node
--     removed those bytes, so a slot is purged exactly once.
--
-- The split exists because the bytes live OUTSIDE Postgres: the database can
-- only name what should be deleted; the node deletes it and then writes the
-- receipt. A crash between the two re-offers the same slots next tick, and
-- blob removal is idempotent (ENOENT is success).
--
-- Node-admin only: the sweep returns storage paths across every space, which
-- no ordinary member is entitled to enumerate.

set role tm8_graph_owner;

alter table public.file_upload_slots
  add column storage_purged_at timestamptz;

-- Completed slots keep their bytes (they ARE the file); only expired/aborted
-- slots are sweep candidates, and each only until its receipt is written.
create index file_upload_slots_purgeable_idx
  on public.file_upload_slots (expires_at)
  where status in ('expired', 'aborted') and storage_purged_at is null;

create or replace function public.sweep_file_upload_slots(
  p_limit integer default 100
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  expired_count bigint;
  purgeable jsonb;
begin
  perform internal.require_identity();
  if not internal.is_node_admin() then
    raise exception 'sweeping upload slots requires node admin'
      using errcode = '42501';
  end if;

  -- 006's expiry, finally invoked.
  select internal.expire_file_upload_slots() into expired_count;

  with picked as (
    select id from public.file_upload_slots
     where status in ('expired', 'aborted')
       and storage_purged_at is null
     order by expires_at
     limit greatest(coalesce(p_limit, 100), 1)
       for update skip locked
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'uploadId', s.id,
           'spaceId', s.space_id,
           'storagePath', s.storage_path)), '[]'::jsonb)
    into purgeable
    from public.file_upload_slots s
    join picked on picked.id = s.id;

  return jsonb_build_object(
    'expired', coalesce(expired_count, 0),
    'purgeable', purgeable);
end
$$;

create or replace function public.mark_file_upload_slots_purged(
  p_upload_ids uuid[]
) returns bigint language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare affected bigint;
begin
  perform internal.require_identity();
  if not internal.is_node_admin() then
    raise exception 'recording upload-slot purges requires node admin'
      using errcode = '42501';
  end if;

  update public.file_upload_slots
     set storage_purged_at = now()
   where id = any(coalesce(p_upload_ids, '{}'))
     and status in ('expired', 'aborted')
     and storage_purged_at is null;
  get diagnostics affected = row_count;
  return affected;
end
$$;

-- -----------------------------------------------------------------------------
-- Timed blob purge for SOFT-DELETED file entities.
--
-- Soft delete is reversible by design: `entities.deleted_at` can be cleared
-- and the file is whole again — nothing here touches a file inside its grace
-- window. Past the grace window the BYTES are reclaimed while the metadata
-- row survives: `purged_at` is set and `checksum_sha256` is nulled, which is
-- the exact predicate `files.download` already treats as "no readable file".
-- A purged-then-restored entity therefore answers an honest not_found rather
-- than serving nothing with a 200, and an operator can still see what the
-- file WAS.
--
-- ONE door, MARK-FIRST — deliberately the opposite order from the slot sweep.
-- For upload slots the race is harmless (nobody can restore an expired slot),
-- so offer-then-receipt is fine there. Here a restore can land between an
-- offer and the node's unlink, and deleting bytes a restore just brought back
-- to life is data loss. So the database commits the purge FIRST (the row
-- stops being restorable-to-bytes at that instant) and only then does the
-- node remove what the committed mark named. A crash between mark and unlink
-- leaks bytes, not data — and the retry window below re-offers recently
-- marked rows so an idempotent re-unlink repairs the leak.
-- -----------------------------------------------------------------------------

alter table public.files
  add column purged_at timestamptz;

create index files_purge_candidate_idx
  on public.files (entity_id)
  where purged_at is null;

create or replace function public.purge_deleted_file_blobs(
  p_grace_seconds integer default 2592000, -- 30 days
  p_retry_seconds integer default 86400,   -- re-offer marked rows for a day
  p_limit integer default 100
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare purgeable jsonb;
begin
  perform internal.require_identity();
  if not internal.is_node_admin() then
    raise exception 'purging deleted file blobs requires node admin'
      using errcode = '42501';
  end if;

  with picked as (
    select f0.entity_id from public.files f0
      join public.entities e0 on e0.id = f0.entity_id
     where f0.purged_at is null
       and e0.deleted_at is not null
       and e0.deleted_at < now() - make_interval(secs => greatest(p_grace_seconds, 0))
     order by e0.deleted_at
     limit greatest(coalesce(p_limit, 100), 1)
       for update of f0 skip locked
  ), marked as (
    update public.files f
       set purged_at = now(), checksum_sha256 = null
      from picked
     where f.entity_id = picked.entity_id
     returning f.entity_id, f.storage_path
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'entityId', m.entity_id,
           'spaceId', e.space_id,
           'storagePath', m.storage_path)), '[]'::jsonb)
    into purgeable
    from (
      select entity_id, storage_path from marked
      union
      -- The repair window: rows marked recently whose unlink may not have
      -- happened (a crash between mark and unlink). Removal is idempotent.
      select f.entity_id, f.storage_path from public.files f
       where f.purged_at is not null
         and f.purged_at > now() - make_interval(secs => greatest(p_retry_seconds, 0))
    ) m
    join public.entities e on e.id = m.entity_id;

  return jsonb_build_object('purgeable', purgeable);
end
$$;

revoke all on function public.purge_deleted_file_blobs(integer, integer, integer) from public;
grant execute on function public.purge_deleted_file_blobs(integer, integer, integer) to tm8_app;

revoke all on function public.sweep_file_upload_slots(integer) from public;
grant execute on function public.sweep_file_upload_slots(integer) to tm8_app;
revoke all on function public.mark_file_upload_slots_purged(uuid[]) from public;
grant execute on function public.mark_file_upload_slots_purged(uuid[]) to tm8_app;

reset role;
