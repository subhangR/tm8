-- =============================================================================
-- 165  STOP EMITTING ENTITY EVENTS FOR CHANGES THAT DID NOT HAPPEN.
--
-- THE DEFECT, measured on the live node (tm8_stable, 2026-08-21, 109,065 rows
-- in public.workspace_events). Of the 52,209 `entity.upsert` rows that have a
-- predecessor for the same entity, classified by which columns actually differ
-- from that predecessor:
--
--     <identical -- not one column moved>                       20,475   39.2%
--     activity_at                                               17,765   34.0%
--     activity_at, updated_at, version                           13,018   24.9%
--     updated_at, version                                          730    1.4%
--     status_category, status_id                                   203
--     activity_at, updated_at                                      110
--     activity_at, status_category, status_id                       33
--     ... (six more buckets, 42 rows in total)
--
-- 20,475 of them -- two in five -- report that nothing whatsoever changed, and
-- each one carries a full `to_jsonb(row)` payload (~462 bytes) down every open
-- socket and through the whole client reducer. A further 17,875 moved only the
-- recency columns.
--
-- TWO CAUSES, both in DDL, both fixed here.
--
--   1. `entities_capture_event` (003:385) has NO `WHEN` clause. Postgres fires
--      an AFTER ... FOR EACH ROW trigger on an UPDATE that writes byte-identical
--      values -- it does not compare for you. Every idempotent re-upsert is
--      therefore a full event. This is an omission and not house style: the
--      sibling trigger on the SAME table, `entities_revoke_artifact_previews`,
--      does guard (`WHEN (new.kind = 'artifact')`).
--
--   2. `edges_touch_activity` (001:866) bumps `entities.activity_at` on both
--      endpoints of every edge write, which re-fires the capture trigger and
--      emits a full entity upsert. 16,397 edge writes against 17,765
--      activity_at-only upserts is very close to 1:1. `activity_at` is a
--      recency hint for list ordering, not entity state.
--
-- -----------------------------------------------------------------------------
-- WHY `version` IS NOT A RECENCY COLUMN, AND WHY THAT IS THE WHOLE DESIGN
-- -----------------------------------------------------------------------------
--
-- The obvious reading of the histogram above is that `version` belongs in the
-- "nothing really happened" set alongside `activity_at` and `updated_at` --
-- which would fold buckets 3 and 4 (13,748 rows, 26.3%) into the cheap path and
-- take the claimed saving from 73% to 99.5%. That reading is WRONG, and it is
-- wrong in the silent direction: it would stop live title, body and status
-- changes from ever reaching a second open client.
--
-- `public.entities` is a SPINE. It has twelve columns and NOT ONE of them is
-- content: no title, no body, no description (001:329). Content lives in 27
-- detail tables, and NONE of those tables has a capture trigger. What they have
-- is `internal.snapshot_entity_version` (001:1130), whose entire effect on the
-- entities row is:
--
--     update public.entities
--        set version = next_version, activity_at = now(), updated_at = now()
--      where id = new.entity_id;
--
-- So the version bump IS the change notification for a detail-table edit. It is
-- the only one there is.
--
-- Probed rather than reasoned, against the live graph in a rolled-back
-- transaction:
--
--     begin;
--       update public.tasks set title = title || ' [probe]' where entity_id = ...;
--       -- entities-row columns that differ: {activity_at, updated_at, version}
--       -- events emitted:                   entity.upsert, version 2 -> 3
--     rollback;
--
-- A TASK RENAME LANDS EXACTLY IN BUCKET 3. Corroborated across the whole log by
-- joining each bucket to `public.entity_versions` (a row there at the event's
-- version means a real content edit was snapshotted):
--
--     bucket                            kind          events  has_snapshot
--     {activity_at,updated_at,version}  task            1,130           614
--     {activity_at,updated_at,version}  pull_request      741           429
--     {activity_at,updated_at,version}  doc               100            91
--     {activity_at,updated_at,version}  artifact           51            51
--     {updated_at,version}              task              376           358
--
-- (`work_session` shows 10,874 in bucket 3 with no snapshots because it is not
-- a snapshot-versioned kind; its version is bumped by 015 when its own detail
-- row moves -- status running/idle, wake counters -- which is precisely why
-- session status is live on screen. Also semantic. Also must not be thinned.)
--
-- THE RECENCY SET IS THEREFORE `{activity_at, updated_at}` AND NOTHING ELSE.
-- A `version` bump always emits a full `entity.upsert`. If you are here to add
-- a column to that array, run the rollback probe above first.
--
-- -----------------------------------------------------------------------------
-- THE SHAPE
-- -----------------------------------------------------------------------------
--
-- A `WHEN` clause cannot reference OLD on INSERT, so one trigger cannot carry
-- the guard and the trigger has to split by operation:
--
--     entities_capture_event_ins_del  AFTER INSERT OR DELETE   (no guard)
--     entities_capture_event_upd      AFTER UPDATE
--                                     WHEN (old.* IS DISTINCT FROM new.*)
--
-- The WHEN clause kills bucket 1 outright, in C, without entering plpgsql. The
-- remaining classification happens INSIDE the function, where OLD and NEW are
-- both live: if the differing columns are a subset of the recency set, the row
-- emits `entity.activity_touched` with `{id, kind, activity_at}` (~90 bytes
-- against 462) instead of a full snapshot; if the only mover was `updated_at`
-- the row emits nothing at all, because nothing observable changed.
--
-- Suppression ALONE is not an option and the thin event is not optional garnish.
-- `activity_at` is load-bearing: two indexes order live lists by it
-- (`entities_space_activity_live_idx`, `entities_space_kind_activity_idx`) and
-- `activityAt` is on the summary contract, so a silently-suppressed touch stalls
-- list ordering on every open client. Deriving the touch client-side was tested
-- and rejected -- only 9.3% of touches carry a `client_mutation_id` and
-- seq-adjacency covers 80%, which is the worst possible number: it would work
-- almost always and silently strand one row in five.
--
-- MEASURED EFFECT of this file on the same 52,209 rows:
--
--     suppressed entirely                       20,477   39.2%
--     thin entity.activity_touched               17,875   34.2%
--     full entity.upsert, byte-for-byte as now   13,857   26.5%
--
-- -----------------------------------------------------------------------------
-- THE RENAME IS DELIBERATE
-- -----------------------------------------------------------------------------
--
-- Four migrations (147, 150, 152, 155) wrap a synthetic backfill in
-- `alter table public.entities disable trigger entities_capture_event`. Those
-- files run BEFORE this one in the chain and are unaffected. A FUTURE migration
-- that copies the idiom will fail loudly -- `trigger "entities_capture_event"
-- does not exist` -- which is the outcome we want. Keeping the old name on one
-- of the two halves would instead have let a backfill INSERT slip through
-- silently while its UPDATEs were suppressed. Loud beats subtle.
--
-- The capture function is shared by six tables, so it is restated in full; only
-- the `entities` branch changes.
-- =============================================================================

create or replace function internal.capture_workspace_event() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  deleting boolean := tg_op = 'DELETE';
  -- The columns whose movement is a recency hint rather than a change to the
  -- entity. `version` is NOT one of them -- see the header. `updated_at` rides
  -- along because every writer that touches `activity_at` sets it in the same
  -- statement, and on its own it says nothing a client can render.
  recency_cols constant text[] := array['activity_at', 'updated_at'];
  row_value jsonb;
  space uuid;
  event_name text;
  recipient uuid;
  target uuid;
begin
  -- NEW and OLD are only assigned for their own operations, so every field read
  -- happens inside a branch that knows which one exists. (Touching new.<field>
  -- in a DELETE trigger is an error, not a NULL.)
  if deleting then row_value := to_jsonb(old); else row_value := to_jsonb(new); end if;

  if tg_table_name = 'entities' then
    if deleting then
      space := old.space_id;
      event_name := 'entity.deleted';
    else
      space := new.space_id;
      event_name := case when new.deleted_at is not null then 'entity.deleted' else 'entity.upsert' end;

      -- An UPDATE that moved only recency columns is not a change to the
      -- entity, and the client must not be handed a full snapshot for it. The
      -- `entity.upsert` guard keeps both edges of the delete/undelete
      -- transition on the full path, where they belong.
      if tg_op = 'UPDATE'
         and event_name = 'entity.upsert'
         and (row_value - recency_cols) = (to_jsonb(old) - recency_cols) then
        if old.activity_at is not distinct from new.activity_at then
          -- Nothing an observer can see moved at all. Emit nothing: an event
          -- whose only content is a timestamp nobody reads is not a change.
          return new;
        end if;
        event_name := 'entity.activity_touched';
        -- `kind` is in the payload so that a consumer can act on the touch
        -- without a lookup -- the client's session-liveness cadence keys on
        -- `work_session` and has no entity cache at that layer.
        row_value := jsonb_build_object(
          'id', new.id,
          'kind', new.kind,
          'activity_at', new.activity_at);
      end if;
    end if;
  elsif tg_table_name = 'edges' then
    if deleting then
      space := old.space_id;
      event_name := 'edge.deleted';
    else
      space := new.space_id;
      event_name := 'edge.upsert';
    end if;
  elsif tg_table_name = 'messages' then
    if deleting then
      target := old.entity_id;
      event_name := 'message.deleted';
    else
      target := new.entity_id;
      event_name := case when tg_op = 'INSERT' then 'message.created' else 'message.updated' end;
    end if;
    select space_id into space from public.entities where id = target;
  elsif tg_table_name = 'entity_counters' then
    if deleting then target := old.entity_id; else target := new.entity_id; end if;
    select space_id into space from public.entities where id = target;
    event_name := 'counter.changed';
  elsif tg_table_name = 'activity' then
    space := new.space_id;
    event_name := 'activity.created';
  elsif tg_table_name = 'notifications' then
    space := new.space_id;
    recipient := new.recipient_member_id;
    event_name := case when tg_op = 'INSERT' then 'notification.created' else 'notification.read' end;
  else
    if deleting then return old; end if;
    return new;
  end if;

  if space is not null then
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id, recipient_member_id)
    values (space, internal.next_event_seq(space), event_name, row_value, internal.claim_cmid(), recipient);
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

-- The split. `entities_capture_event` is replaced, not supplemented: leaving it
-- in place would double every event it still matched.
drop trigger if exists entities_capture_event on public.entities;

create trigger entities_capture_event_ins_del after insert or delete on public.entities
for each row execute function internal.capture_workspace_event();

create trigger entities_capture_event_upd after update on public.entities
for each row when (old.* is distinct from new.*)
execute function internal.capture_workspace_event();

comment on function internal.capture_workspace_event() is
  'Captures raw row payloads onto public.workspace_events for the server''s event '
  'mapper to project. On public.entities UPDATE, an edit confined to '
  '{activity_at, updated_at} emits the thin entity.activity_touched instead of a '
  'full entity.upsert, and an edit that moved neither emits nothing. `version` is '
  'NEVER treated as recency -- it is the only signal a detail-table content change '
  'produces (see migration 165).';

-- -----------------------------------------------------------------------------
-- VERIFY. Asserts only what THIS FILE creates: tranche suites replay the chain
-- mid-flight, so a chain-wide assertion here would fail against a tree that is
-- correct at its own position.
-- -----------------------------------------------------------------------------
do $verify$
declare
  n integer;
begin
  -- Both halves present, enabled, and split by the right operations. In
  -- `pg_trigger.tgtype` the operation bits are INSERT = 4, DELETE = 8,
  -- UPDATE = 16 (the undivided trigger read 29 = row + all three).
  --
  -- Firing order is alphabetical by name and both new names still sort between
  -- the same neighbours the old one did (`entities_assign_position` before,
  -- `entities_ensure_counter` after), so nothing else on this table moves.
  select count(*) into n from pg_trigger
   where tgrelid = 'public.entities'::regclass and not tgisinternal
     and tgname = 'entities_capture_event_ins_del'
     and tgenabled = 'O'
     and (tgtype & 4) <> 0 and (tgtype & 8) <> 0 and (tgtype & 16) = 0;
  if n <> 1 then
    raise exception '165: entities_capture_event_ins_del must exist, be enabled, and fire on INSERT and DELETE only (found %)', n;
  end if;

  select count(*) into n from pg_trigger
   where tgrelid = 'public.entities'::regclass and not tgisinternal
     and tgname = 'entities_capture_event_upd'
     and tgenabled = 'O'
     and (tgtype & 16) <> 0 and (tgtype & 4) = 0 and (tgtype & 8) = 0;
  if n <> 1 then
    raise exception '165: entities_capture_event_upd must exist, be enabled, and fire on UPDATE only (found %)', n;
  end if;

  -- The UPDATE half is worthless without its guard, and losing the guard is
  -- invisible: everything keeps working, it just emits 20,000 events again.
  if (select count(*) from pg_trigger
       where tgrelid = 'public.entities'::regclass
         and tgname = 'entities_capture_event_upd'
         and tgqual is not null) <> 1 then
    raise exception '165: entities_capture_event_upd lost its WHEN (old.* is distinct from new.*) guard';
  end if;

  -- The old undivided trigger must be gone, or every event fires twice.
  if exists (select 1 from pg_trigger
              where tgrelid = 'public.entities'::regclass and tgname = 'entities_capture_event') then
    raise exception '165: the undivided entities_capture_event is still attached -- events would double';
  end if;

  -- `version` must not have been folded into the recency set by a later edit.
  -- This is the one mistake that breaks live collaboration silently.
  if (select count(*) from pg_proc p
        join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'internal' and p.proname = 'capture_workspace_event'
         and p.prosrc like '%recency_cols%'
         and p.prosrc like '%''activity_at'', ''updated_at''%'
         and p.prosrc not like '%''version''%') <> 1 then
    raise exception '165: the recency set must be exactly {activity_at, updated_at} -- `version` is a content-change signal, not a recency hint';
  end if;
end
$verify$;
