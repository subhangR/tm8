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
-- THE BACKFILL, AND WHY IT IS SAFE. Every row that currently carries
-- `deleted_at` on this node got it from a control labelled "Archive" — that is
-- the only affordance the UI has ever offered for the bit, and `entities.delete`
-- is what it calls. So the honest reading of the existing data is that all of it
-- is ARCHIVED, not deleted, and §5 moves it. No title is recovered from a backup
-- to do this: the redaction was always read-time only and every real title has
-- been sitting in its kind table the whole time (measured: 95/95 tasks on prod).
-- Moving the bit is what makes them legible again.
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
-- It is HALF of a change and the other half is in the server. Every "live" read
-- in the codebase today filters on `deleted_at is null` and nothing else,
-- because `archived_at` did not exist when they were written. The moment §5
-- moves the existing tombstones onto the new column, their `deleted_at` becomes
-- NULL — so on a node running the CURRENT server every archived row silently
-- reappears in the ordinary lists. On the prod node that is 95 tasks landing in
-- the Open tier.
--
-- This migration is only safe alongside the server change that teaches the read
-- path `archived_at`: default lists exclude it, the Archived tier selects it,
-- and `entities.get` RETURNS it (unlike a tombstone, which still 404s — you
-- must be able to open an archived thing to decide whether to bring it back).
-- Apply them together, or not at all.
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
   and archived_at is null;
