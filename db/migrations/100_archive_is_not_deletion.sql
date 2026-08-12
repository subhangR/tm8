-- =============================================================================
-- 100 — ARCHIVE IS NOT DELETION: `entities.archived_at`, and the two verbs it
--       needs.
--
-- THE DEFECT THIS EXISTS TO FIX, measured on the prod node 2026-08-12.
--
-- There was exactly ONE lifecycle bit, `entities.deleted_at`, and the product
-- spent it on TWO jobs. The UI's button says "Archive", its tier says
-- "Archived", and `restore_entity` is documented as the inverse — all of that
-- writes and reads `deleted_at`. Meanwhile the read path applies the tombstone
-- rule (02 §3.2) to the same bit: `titleOf` returns the literal 'Deleted' and
-- `contentOf` returns nothing, for every kind.
--
-- Both behaviours are individually correct. Together, on one bit, they produced
-- an Archived tier of 69 rows every one of which was struck through and titled
-- "Deleted". Nothing in it could be told apart, so `restore` — which existed
-- and worked — could not be aimed at anything. An archive whose entries have no
-- names is not an archive.
--
-- WHY A SECOND COLUMN AND NOT A RELABEL. Relabelling `deleted_at` to mean
-- "archived" and dropping the redaction would have been one line, and it was
-- considered. It fails on the thing the tombstone rule is actually for: after
-- it, NOTHING can ever be made to stop rendering. Archive and delete are
-- different intents — put away, still mine, bring it back later; versus this
-- should stop existing — and a single nullable timestamp cannot answer both
-- without the caller guessing which one was meant. So:
--
--     archived_at  reversible. KEEPS its title and its content. Hidden from
--                  default lists, listed by the Archived tier, restorable.
--     deleted_at   unchanged. The tombstone: content withheld, reads 404,
--                  `titleOf` still says 'Deleted'.
--
-- The two are independent, and deliberately so: an archived row may later be
-- deleted, and a deleted row's archive bit is simply irrelevant. Nothing here
-- weakens the tombstone; it stops being asked to do a job it was never for.
--
-- THE BACKFILL. Every row that currently carries `deleted_at` on this node is
-- best read as ARCHIVED: the UI's only affordance for that bit is a control
-- labelled "Archive", and `entities.delete` is what it calls. So §5 moves it.
-- No title is recovered from a backup to do this — the redaction was always
-- read-time only and every real title has been in its kind table the whole
-- time. Moving the bit is what makes them legible again.
--
-- ADVERSARIAL REVIEW CORRECTED THREE THINGS HERE, and they are worth stating
-- because two of them were in the header as facts:
--
--   * THE SIZE. This said "95/95 tasks". That measured ONE KIND. The real
--     blast radius is 264 rows across SIX: task 223, file 30, doc 8,
--     channel 1, collection 1, team_member 1 — and the non-task rows are
--     exactly the ones carrying teeth (the files, the channel). Any statement
--     about this migration's risk that says "95 tasks" understates it 2.8x.
--
--   * THE PROVENANCE CLAIM. "The only affordance the UI has ever offered" is
--     true of the UI and FALSE of the product: `tm8 entity delete` exists and
--     the CLI itself calls it destructive. `command_ledger` records no surface,
--     so the data cannot distinguish a CLI delete from a UI Archive click.
--     Of the 264, 201 have their own `verb='deleted'` activity row and 63 are
--     explained by cascade — provenance is complete, but INTENT is not
--     recoverable. The reinterpretation is a judgement, not a measurement.
--
--   * FILES ARE EXCLUDED, and this is the important one. `purge_deleted_file_blobs`
--     (095) selects on `deleted_at is not null and deleted_at < now() - grace`.
--     Nulling `deleted_at` does not pause that 30-day clock, it DISCARDS it:
--     30 file rows with `purged_at is null` — real bytes, deleted 2026-08-01,
--     partway through the window — would silently leave the purge door forever
--     and never re-enter it on their own. Someone who deleted a file expecting
--     the bytes reclaimed would get indefinite retention and no signal.
--
--     Excluding `kind='file'` is chosen over repointing the purge at
--     `coalesce(deleted_at, archived_at)`, because that repoint would reclaim
--     the bytes of files someone merely PUT AWAY — making an archive
--     unrecoverable, which is the opposite failure and a worse one. The rule
--     this exclusion follows: THE BACKFILL MUST NOT CHANGE THE RETENTION
--     BEHAVIOUR OF ANY EXISTING ROW. Excluding files changes nothing at all
--     about them; they stay deleted, on their existing clock.
--
--     The consequence for NEW data is a real policy question and it is the
--     owner's, not this migration's: from stage 2 on, archiving a file will not
--     start a purge clock, so bytes are retained until someone deletes it. That
--     is the correct reading of "archive", and it is written down here rather
--     than discovered later.
--
--   * `interaction_profile` IS EXCLUDED as cheap insurance.
--     `w2g12_guard_profile_envelope` raises 42501 on ANY `deleted_at` change for
--     that kind, and this is an unqualified UPDATE — one such row anywhere would
--     abort the entire migration. Prod has zero today, so this is latent, which
--     is exactly when a one-word predicate is worth adding.
--
-- The backfill is written so it CANNOT run twice destructively (`where
-- deleted_at is not null and archived_at is null`), because a migration that
-- re-runs against a partially-migrated ledger is a migration that loses data.
--
-- FUNCTION OWNERSHIP. `archive_entity` / `unarchive_entity` are SECURITY
-- DEFINER and owned by `tm8_graph_owner`, matching `delete_entity` /
-- `restore_entity` (007) exactly. A definer function created by the wrong role
-- silently runs with the wrong authority.
--
-- !! DO NOT APPLY THIS MIGRATION ON ITS OWN. !!
--
-- Every "live" read in the codebase filters on `deleted_at is null` and nothing
-- else, because `archived_at` did not exist when they were written. The moment
-- §5 moves the existing tombstones onto the new column their `deleted_at`
-- becomes NULL — so on a node running the CURRENT server every archived row
-- reappears in the ordinary lists. On prod that is 233 rows across five kinds
-- (223 tasks, 8 docs, 1 channel, 1 collection, 1 team_member; files excluded).
--
-- AND THERE IS NO DATABASE BACKSTOP. Adversarial review established that the
-- entities SELECT policy (`internal.entity_row_visible`) never mentions
-- `deleted_at` at all — lifecycle filtering has never lived at the RLS layer.
-- So nothing below the application will catch this. "Apply them together" is
-- the only thing standing between this migration and that outcome.
--
-- THE OTHER HALF IS NOT ONLY IN THE SERVER — that framing was wrong and the
-- review was right to attack it. A large part of it is in the DATABASE, and
-- that is the part with teeth: four triggers keyed `UPDATE OF deleted_at` (two
-- fixed in §3b), one retention door (§5 excludes files rather than break it),
-- and 83 plpgsql functions that read `deleted_at`. `internal.entity_readable`
-- is among them and gates WRITES, so until it learns the new bit you can post
-- messages to, and create edges against, an archived entity.
--
-- STILL REQUIRED BEFORE THIS IS SAFE, and NOT in this file:
--   * read path: default lists exclude archived; the Archived tier selects it;
--     `entities.get` RETURNS an archived row (unlike a tombstone, which still
--     404s) — you must be able to open one to decide whether to bring it back;
--   * `internal.entity_readable` and the counting/tree/ready-to-work functions;
--   * THE EVENT PATH, which the original stage-2 scope missed entirely.
--     `capture_workspace_event` classifies any row with `deleted_at is null` as
--     `entity.upsert`, so archiving emits an upsert, and the client applies an
--     upsert IN PLACE. An archived row therefore stays on an open unfiltered
--     list until a manual reload — the realtime half of "it disappeared" does
--     not exist yet. The backfill itself emits ~1,000 events in one statement.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The column.
-- -----------------------------------------------------------------------------

alter table public.entities add column if not exists archived_at timestamptz;

comment on column public.entities.archived_at is
  'Archive bit: reversible put-away. Hidden from default lists, KEEPS title and '
  'content, restorable via unarchive_entity. Independent of deleted_at, which is '
  'the tombstone (content withheld, reads 404). Added by migration 100.';

-- The Archived tier''s own query, mirroring `entities_deleted_idx`. Partial, so
-- it costs nothing on the overwhelmingly common archived_at IS NULL row.
create index if not exists entities_archived_idx
  on public.entities (space_id, archived_at)
  where archived_at is not null;

-- Every "live" list is now `deleted_at is null and archived_at is null`. The
-- existing live indexes are partial on `deleted_at is null` only, so they still
-- serve those reads correctly — an archived row simply gets filtered after the
-- index scan. Re-indexing every live path is a performance change and belongs
-- with a measurement, not with this correctness fix.

-- -----------------------------------------------------------------------------
-- 1b. The activity vocabulary has to learn the two new verbs.
--
-- `activity_verb_check` is a closed list, and `record_activity` writes through
-- it — so without this the archive RPC below raises 23514 from inside
-- `record_activity` and the whole command aborts. Found by running the verbs
-- against a real database rather than by reading them: a FakeDb has no CHECK
-- constraints and would have reported this migration as working.
--
-- 'archived' / 'unarchived' rather than reusing 'deleted' / 'restored': the
-- activity feed is a record of what a person did, and "Ada deleted the
-- onboarding doc" when Ada archived it is the same conflation this migration
-- exists to end.
-- -----------------------------------------------------------------------------

alter table public.activity drop constraint if exists activity_verb_check;
alter table public.activity add constraint activity_verb_check check (
  verb = any (array[
    'created','updated','moved','deleted','restored','linked','unlinked',
    'reacted','awarded','completed','joined','pulled','work.changed',
    'pr.linked','unblocked',
    'archived','unarchived'
  ])
);

-- -----------------------------------------------------------------------------
-- 1c. …and the UNDO registry has to learn the inverse.
--
-- `undo_tokens_registered_inverse_check` is a second closed list: only a
-- REGISTERED inverse may be handed out as an undo token, so that `commands.undo`
-- can never be pointed at an arbitrary operation. `archive_entity` issues one
-- naming `entities.unarchive`, which has to be on the list for the insert to
-- pass. Also found by running it, not by reading it — this raised from inside
-- `issue_undo_token`, three frames below the RPC.
-- -----------------------------------------------------------------------------

alter table public.undo_tokens drop constraint if exists undo_tokens_registered_inverse_check;
alter table public.undo_tokens add constraint undo_tokens_registered_inverse_check check (
  operation = any (array[
    'edges.delete','entities.move','entities.restore','messages.delete',
    'entities.unarchive'
  ])
);

-- -----------------------------------------------------------------------------
-- 2. archive_entity — put a subtree away, reversibly.
--
-- CASCADES LIKE DELETE, and for the same reason: archiving a parent while
-- leaving its children in the live list would strand rows under a parent the
-- list no longer shows. The recursion guard (`depth < 256`, `not id = any(path)`)
-- is copied from `delete_entity` verbatim — a cycle in `parent_id` must not
-- become an infinite loop here either.
--
-- THE SAME KIND REFUSAL AS DELETE. member / message / work_session / project /
-- interaction_profile have command-owned lifecycles; archiving them out from
-- under their own commands is the same category error as deleting them, so it
-- raises the same 42501 with the same words.
-- -----------------------------------------------------------------------------

create or replace function public.archive_entity(
  p_entity_id uuid,
  p_actor_id uuid,
  p_client_mutation_id text
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare replay jsonb; e public.entities; actor uuid; affected uuid[]; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.archive');
  if replay is not null then return replay; end if;

  -- `live_entity` refuses a DELETED row, which is right: a tombstone is not a
  -- thing you put away. An already-archived row is allowed through and the
  -- update below is a no-op on it, so a double-archive is idempotent rather
  -- than an error.
  e := internal.live_entity(p_entity_id);
  perform internal.require_space_member(e.space_id);

  if e.kind in ('member','message','work_session','project','interaction_profile') then
    raise exception 'entity lifecycle is command-owned for kind %', e.kind using errcode = '42501';
  end if;

  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  with recursive subtree(id, path, depth) as (
    select p_entity_id, array[p_entity_id], 0
    union all
    select child.id, s.path || child.id, s.depth + 1
      from public.entities child join subtree s on child.parent_id = s.id
     where s.depth < 256 and not child.id = any(s.path)
  )
  select array_agg(distinct s.id) into affected
    from subtree s join public.entities e2 on e2.id = s.id
   where e2.archived_at is null and e2.deleted_at is null;

  update public.entities set archived_at = now(), updated_at = now()
   where id = any(coalesce(affected, array[]::uuid[]));

  activity_id := internal.record_activity(
    e.space_id, p_entity_id, actor, 'archived', null, jsonb_build_object('kind', e.kind));

  return internal.ledger_record(p_client_mutation_id, 'entities.archive',
    internal.command_result(p_entity_id, null, activity_id, coalesce(affected, array[p_entity_id]),
      internal.issue_undo_token(e.space_id, actor, 'Undo archive', 'entities.unarchive',
        jsonb_build_object('entityId', p_entity_id))));
end
$$;

alter function public.archive_entity(uuid, uuid, text) owner to tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 3. unarchive_entity — bring it back.
--
-- THE PARENT GUARD IS `restore_entity`'s, for its reason: bringing a child back
-- under a parent that is still put away would show a row whose ancestor the list
-- does not, and the user would have no way to reach it. Unarchive the parent and
-- the cascade below brings the child with it.
-- -----------------------------------------------------------------------------

create or replace function public.unarchive_entity(
  p_entity_id uuid,
  p_actor_id uuid,
  p_client_mutation_id text
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare replay jsonb; e public.entities; actor uuid; affected uuid[]; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.unarchive');
  if replay is not null then return replay; end if;

  -- NOT `live_entity`: the whole point is to act on a row the live reads hide.
  select * into e from public.entities where id = p_entity_id for update;
  if e.id is null then raise exception 'entity not found' using errcode = 'P0002'; end if;

  -- A DELETED row is not unarchivable — restore it first. The two bits are
  -- independent and so are their inverses; conflating them here would let this
  -- verb quietly resurrect a tombstone.
  if e.deleted_at is not null then
    raise exception 'entity is deleted, not archived — restore it first' using errcode = '23514';
  end if;

  perform internal.require_space_member(e.space_id);

  if e.kind in ('member','message','work_session','project','interaction_profile') then
    raise exception 'entity lifecycle is command-owned for kind %', e.kind using errcode = '42501';
  end if;

  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  if e.parent_id is not null
     and exists (select 1 from public.entities p
                  where p.id = e.parent_id and p.archived_at is not null) then
    raise exception 'unarchive the parent first' using errcode = '23514';
  end if;

  with recursive subtree(id, path, depth) as (
    select p_entity_id, array[p_entity_id], 0
    union all
    select child.id, s.path || child.id, s.depth + 1
      from public.entities child join subtree s on child.parent_id = s.id
     where s.depth < 256 and not child.id = any(s.path)
  )
  select array_agg(distinct id) into affected from subtree;

  -- `deleted_at is null` in the predicate: a subtree may contain rows that were
  -- genuinely deleted while the parent sat archived, and unarchiving the parent
  -- must not resurrect them.
  update public.entities set archived_at = null, updated_at = now()
   where id = any(coalesce(affected, array[p_entity_id]))
     and archived_at is not null
     and deleted_at is null;

  activity_id := internal.record_activity(
    e.space_id, p_entity_id, actor, 'unarchived', null, jsonb_build_object('kind', e.kind));

  return internal.ledger_record(p_client_mutation_id, 'entities.unarchive',
    internal.command_result(p_entity_id, null, activity_id, coalesce(affected, array[p_entity_id])));
end
$$;

alter function public.unarchive_entity(uuid, uuid, text) owner to tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 3b. THE TRIGGERS THAT GUARD `deleted_at` ARE BLIND TO ARCHIVE. Fix the two
--     that have teeth.
--
-- Four triggers are declared `… UPDATE OF deleted_at`. A new lifecycle bit does
-- not inherit any of them, so on the day the UI's Archive button stops calling
-- `delete_entity` and starts calling `archive_entity`, every protection those
-- triggers provide silently stops applying to the SAME user action. Measured on
-- a prod copy, both of these:
--
--   * `w2_guard_default_channel_deletion` refuses to delete a space's default
--     channel without a live successor. `delete_entity` on Utho Prod's `general`
--     raised 23514; `archive_entity` on the same row SUCCEEDED, leaving the
--     space pointing at an archived feed. `channel` is not in the kind refusal
--     list, and archiving a NON-default channel is perfectly legitimate — so the
--     fix is the guard, not a blanket refusal.
--
--   * `revoke_artifact_previews` revokes live preview links when an artifact is
--     deleted. On an artifact with 6 unrevoked preview sessions, `delete_entity`
--     revoked all 6 and `archive_entity` revoked none. Decided EXPLICITLY, as
--     the review asked: archive DOES revoke. A preview link is a capability
--     handed out to people who are not signed in; an entity the owner has put
--     away must not stay publicly fetchable, and "you can still reach it because
--     it was archived rather than deleted" is not a distinction anyone holding
--     the link would understand. Unarchiving does not un-revoke — reissuing a
--     capability is an explicit act, and silently reviving old links would be
--     the worse default.
--
-- The other two need nothing: `recompute_w1_incident_counters` recomputes from
-- `deleted_at` and is correct to ignore archive (an archived incident is not a
-- closed one), and `w2g12_guard_profile_envelope` covers a kind archive refuses
-- outright.
-- -----------------------------------------------------------------------------

create or replace function internal.guard_default_channel_archive()
returns trigger
language plpgsql
as $$
begin
  if old.kind = 'channel'
     and old.archived_at is null
     and new.archived_at is not null
     and exists (
       select 1 from public.spaces space_row where space_row.default_channel_id = old.id
     ) then
    raise exception 'select a live successor or explicit no-feed before archiving the default channel'
      using errcode = '23514';
  end if;
  return new;
end
$$;

alter function internal.guard_default_channel_archive() owner to tm8_graph_owner;

drop trigger if exists entities_w2_guard_default_channel_archive on public.entities;
create trigger entities_w2_guard_default_channel_archive
  before update of archived_at on public.entities
  for each row execute function internal.guard_default_channel_archive();

create or replace function internal.revoke_artifact_previews_on_archive()
returns trigger
language plpgsql
as $$
begin
  if new.archived_at is not null and old.archived_at is null then
    update public.artifact_preview_sessions
       set revoked_at = now()
     where artifact_entity_id = new.id and revoked_at is null;
  end if;
  return new;
end
$$;

alter function internal.revoke_artifact_previews_on_archive() owner to tm8_graph_owner;

drop trigger if exists entities_revoke_artifact_previews_on_archive on public.entities;
create trigger entities_revoke_artifact_previews_on_archive
  after update of archived_at on public.entities
  for each row when (new.kind = 'artifact')
  execute function internal.revoke_artifact_previews_on_archive();

-- -----------------------------------------------------------------------------
-- 3c. `restore_entity` has to learn the other bit, or the guards are one-sided.
--
-- `unarchive_entity` refuses to surface a child under an archived parent. But
-- `restore_entity` was written when `archived_at` did not exist and guards only
-- on a DELETED parent — so three ordinary actions walk straight into the state
-- the new verb exists to prevent (measured):
--
--     delete_entity(child)    → child deleted
--     archive_entity(parent)  → parent archived; child SKIPPED (already deleted)
--     restore_entity(child)   → SUCCEEDS: a LIVE child under an ARCHIVED parent
--
-- and `unarchive_entity(child)` on that same state raises "unarchive the parent
-- first". The database was refusing to let you reach deliberately a state it
-- would hand you by accident. Recreated here with BOTH guards.
--
-- SIGNATURE UNCHANGED and ownership restated: a SECURITY DEFINER function
-- recreated under the wrong role runs with the wrong authority, and `or replace`
-- keeps the original owner only if the recreating role matches.
-- -----------------------------------------------------------------------------

-- THE DEFAULTS ARE PART OF THE SIGNATURE. Restating this function without
-- `DEFAULT NULL` on the last two parameters fails outright — "cannot remove
-- parameter defaults from existing function" — which is the good outcome, but
-- only because Postgres happens to refuse it. The dangerous version of this
-- mistake is a signature that DIFFERS rather than narrows: `create or replace`
-- then mints a second overload and leaves the original in place, so callers
-- keep hitting the old body and the migration reports success.
create or replace function public.restore_entity(
  p_entity_id uuid,
  p_actor_id uuid default null::uuid,
  p_client_mutation_id text default null::text
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare replay jsonb; e public.entities; actor uuid; affected uuid[]; activity_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.restore');
  if replay is not null then return replay; end if;
  select * into e from public.entities where id = p_entity_id for update;
  if e.id is null then raise exception 'entity not found' using errcode = 'P0002'; end if;
  perform internal.require_space_member(e.space_id);
  if e.kind in ('member','message','work_session','project','interaction_profile') then
    raise exception 'entity lifecycle is command-owned for kind %', e.kind using errcode = '42501';
  end if;
  actor := internal.resolve_actor(p_actor_id, e.space_id); perform internal.bind_actor(actor);
  if e.parent_id is not null and exists(
       select 1 from public.entities p where p.id = e.parent_id and p.deleted_at is not null) then
    raise exception 'restore the parent first' using errcode = '23514';
  end if;
  -- THE NEW ARM. Restoring under an archived parent produces a row the lists
  -- cannot show under an ancestor they also cannot show.
  if e.parent_id is not null and exists(
       select 1 from public.entities p where p.id = e.parent_id and p.archived_at is not null) then
    raise exception 'unarchive the parent first' using errcode = '23514';
  end if;
  with recursive subtree(id,path,depth) as (
    select p_entity_id, array[p_entity_id], 0
    union all
    select child.id, s.path||child.id, s.depth+1
      from public.entities child join subtree s on child.parent_id = s.id
     where s.depth < 256 and not child.id = any(s.path)
  )
  select array_agg(distinct id) into affected from subtree;
  update public.entities set deleted_at = null, updated_at = now()
   where id = any(coalesce(affected, array[p_entity_id])) and deleted_at is not null;
  activity_id := internal.record_activity(
    e.space_id, p_entity_id, actor, 'restored', null, jsonb_build_object('kind', e.kind));
  return internal.ledger_record(p_client_mutation_id,'entities.restore',
    internal.command_result(p_entity_id, null, activity_id, coalesce(affected, array[p_entity_id])));
end
$$;

alter function public.restore_entity(uuid, uuid, text) owner to tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 4. Grants, matching delete_entity / restore_entity exactly.
-- -----------------------------------------------------------------------------

revoke all on function public.archive_entity(uuid, uuid, text) from public;
revoke all on function public.unarchive_entity(uuid, uuid, text) from public;
grant execute on function public.archive_entity(uuid, uuid, text) to tm8_app;
grant execute on function public.unarchive_entity(uuid, uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- 5. THE BACKFILL — every existing tombstone was an archive.
--
-- See the header. The guard makes this idempotent: a row that already has
-- `archived_at` is left alone, so re-running cannot blank a `deleted_at` that a
-- later, genuine delete has set.
--
-- Deliberately NOT touching `updated_at`: this is a reinterpretation of data
-- that already existed, not an edit anybody made, and bumping the timestamp
-- would reorder every affected row to the top of "Recent activity" for no
-- reason a user could explain.
-- -----------------------------------------------------------------------------

update public.entities
   set archived_at = deleted_at,
       deleted_at  = null
 where deleted_at is not null
   and archived_at is null
   -- Retention must not move. See the header: nulling deleted_at would take 30
   -- file rows out of `purge_deleted_file_blobs`'s door permanently.
   and kind <> 'file'
   -- `w2g12_guard_profile_envelope` raises on any deleted_at change for this
   -- kind, and one such row would abort the whole migration.
   and kind <> 'interaction_profile';
