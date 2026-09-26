-- =============================================================================
-- 254 · ATTENTION WRITES EMIT THE FULL entity.upsert (Attention v2 S2, G3).
--
-- THE DEFECT. Every attention write (050's create/update/resolve RPCs, 211's
-- form raise/resolve) ends in `update entities set activity_at = now(),
-- updated_at = now()` on the request's entity. Since 165 an update that moves
-- only those two columns is published as the THIN `entity.activity_touched`
-- -- `{id, kind, activity_at}`, no summary, no badge. Only the top-bar segment
-- refetched on it; tiles, the graph and the gate on open kept the old badge
-- until something else re-read the entity.
--
-- THE FIX, in two parts.
--
--   1. `attention_requests_flag_changed` (AFTER INSERT/UPDATE/DELETE, per row)
--      records the request's entity id in the TRANSACTION-LOCAL setting
--      `tm8.attention_changed`. A trigger on the table rather than a line in
--      each RPC, so every writer is covered -- the five that exist today and
--      S3/S4's new ones -- and none can forget.
--
--   2. `internal.capture_workspace_event` (restated in full from 165; only one
--      condition changes) skips the thin downgrade for a flagged entity id.
--      The projector then builds the summary with `badges.attention` from
--      `public.attention_badges` (252), the same function the read path uses.
--
-- 165 IS UNCHANGED FOR EVERY OTHER TOUCH: an id that no attention row named in
-- this transaction still gets `entity.activity_touched`, and an update that
-- moved nothing still emits nothing. The flag is `set_config(..., true)`, so it
-- dies with the transaction and cannot reach the next one on a pooled
-- connection.
--
-- In S2 "the affected root" is the request's own entity: 252's badge is per
-- `entity_id` and there is no rollup yet. When S3 adds one, the flag trigger is
-- where the extra ids (root, raising session) get added.
-- =============================================================================

create or replace function internal.attention_requests_flag_changed() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  -- NULL before the first set_config in a session, '' after a transaction-local
  -- one ends: both mean nothing is flagged.
  flagged text[] := coalesce(string_to_array(
    nullif(current_setting('tm8.attention_changed', true), ''), ','), '{}');
  touched uuid[] := '{}';
  id uuid;
begin
  -- NEW and OLD exist only for their own operations; reading the other is an
  -- error, not a NULL, so each is read inside a branch that knows.
  if tg_op <> 'DELETE' then touched := touched || new.entity_id; end if;
  if tg_op <> 'INSERT' then touched := touched || old.entity_id; end if;
  foreach id in array touched loop
    if not (id::text = any(flagged)) then
      flagged := flagged || id::text;
    end if;
  end loop;
  perform set_config('tm8.attention_changed', array_to_string(flagged, ','), true);
  return null;
end
$$;

drop trigger if exists attention_requests_flag_changed on public.attention_requests;
create trigger attention_requests_flag_changed
after insert or update or delete on public.attention_requests
for each row execute function internal.attention_requests_flag_changed();

-- The capture function is shared by six tables, so it is restated in full; only
-- the recency-downgrade condition in the `entities` branch changes (see 254 in
-- the comment there). The triggers 165 attached keep pointing at it.

create or replace function internal.capture_workspace_event() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  deleting boolean := tg_op = 'DELETE';
  -- The columns whose movement is a recency hint rather than a change to the
  -- entity. `version` is NOT one of them -- see migration 165's header. `updated_at` rides
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
      --
      -- 254: an entity whose attention requests changed in this transaction
      -- is exempt. Its badge moved, the badge lives in the projector's summary
      -- and not on this row, and the thin event carries no summary -- so the
      -- touch every attention write ends with must stay a full upsert.
      if tg_op = 'UPDATE'
         and event_name = 'entity.upsert'
         and (row_value - recency_cols) = (to_jsonb(old) - recency_cols)
         and not coalesce(new.id::text = any(string_to_array(
               nullif(current_setting('tm8.attention_changed', true), ''), ',')), false) then
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

comment on function internal.capture_workspace_event() is
  'Captures raw row payloads onto public.workspace_events for the server''s event '
  'mapper to project. On public.entities UPDATE, an edit confined to '
  '{activity_at, updated_at} emits the thin entity.activity_touched instead of a '
  'full entity.upsert, and an edit that moved neither emits nothing -- unless an '
  'attention_requests row for that entity changed in the same transaction '
  '(migration 254), which keeps the full entity.upsert so the badge reaches clients. '
  '`version` is NEVER treated as recency (see migration 165).';

-- PUBLIC gets EXECUTE on every new function by default, and the delivery role's
-- surface is pinned by w2-execution.pg.test.ts. A trigger function needs no
-- EXECUTE grant to fire. (The flag test is inlined in the capture function,
-- not a helper, for the same reason: a helper would need EXECUTE for every
-- role that writes an entity row.)
revoke all on function internal.attention_requests_flag_changed() from public;

-- -----------------------------------------------------------------------------
-- VERIFY. Asserts only what THIS FILE creates.
-- -----------------------------------------------------------------------------
do $verify$
begin
  if (select count(*) from pg_trigger
       where tgrelid = 'public.attention_requests'::regclass and not tgisinternal
         and tgname = 'attention_requests_flag_changed' and tgenabled = 'O') <> 1 then
    raise exception '254: attention_requests_flag_changed must exist and be enabled';
  end if;

  if (select count(*) from pg_proc p
        join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'internal' and p.proname = 'capture_workspace_event'
         and p.prosrc like '%tm8.attention_changed%'
         and p.prosrc like '%''activity_at'', ''updated_at''%'
         and p.prosrc not like '%''version''%') <> 1 then
    raise exception '254: capture_workspace_event must exempt attention-flagged ids and keep 165''s recency set exactly';
  end if;
end
$verify$;
