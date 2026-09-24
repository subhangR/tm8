-- =============================================================================
-- 208  ONE CANONICAL SUBJECT SET for workspace_events.subject_ids.
--
-- Spec: "scoped change feed (`tm8 event changes`)", doc 01a0cf35, section 4
-- Storage, and change feed step 3 (the only reader of the column).
--
-- THE DEFECT. Two steps of the change feed each wrote down "which entities is
-- this event about", and they disagreed:
--
--   * 205's `internal.event_subject_ids` (the column's derivation) omitted
--     `counter.changed`, although that row names exactly one entity -- its
--     `entity_id` (the mapper projects it as `counter.changed.entityId`,
--     packages/server/src/events/mapper.ts). A counter row was indexed as '{}'
--     -- "about nothing" -- so no subject query could ever find it.
--   * #672's `events.poll ?entity=` jsonb predicate omitted `counter.changed`
--     too, and additionally omitted the `git.*` passthrough rows 205 included.
--
-- THE CANONICAL SET, decided here and pinned on both sides by
-- packages/server/test/events/subject-set.pg.test.ts:
--
--   entity.upsert / entity.deleted / entity.activity_touched    id
--   edge.upsert / edge.deleted                                  src_id, dst_id
--   message.created / .updated / .deleted                       entity_id, anchor_id
--   counter.changed                                             entity_id        <- NEW
--   activity.created                                            entity_id
--   notification.created / .read                                target_entity_id
--   git.commit_recorded                                         commitEntityId
--   git.pr_state_changed                                        prEntityId
--   git.worktree_status_changed                                 worktreeEntityId
--   everything else (menu.updated, space.default_channel.updated, ...)   '{}'
--
-- WHY git.* STAYS IN. Spec section 3.2 has `pr` and `commit` change classes, and
-- a git fact row names ONLY its PR/commit/worktree entity, never the task. The
-- change feed resolves a task's tracked PR/commit ids at request time and
-- matches their git rows through THIS column; with git.* out of the set those
-- classes could never fire. They are about their fact entity in exactly the
-- sense an entity.upsert is about its entity.
--
-- WHY counter.changed GOES IN although the change feed drops it (section 3.2
-- "derived from rows already counted"): the column answers "what is this row
-- about", not "what does one consumer render". `events.poll ?entity=X` now
-- reads the same derivation, and a counter change about X is an event about X.
--
-- WHAT THIS FILE DOES.
--   1. Redefines `internal.event_subject_ids` with the canonical set. The live
--      insert trigger and 205's online backfill both call it, so every row
--      written or backfilled from now on is indexed with the canonical set.
--   2. Grants EXECUTE on it to tm8_app explicitly (205 left it PUBLIC; see the
--      grant below for why PUBLIC is NOT revoked). It is IMMUTABLE and reads nothing but
--      its arguments, so it discloses nothing; `events.poll ?entity=` uses it
--      for window rows the backfill has not reached yet (poll.ts), so there is
--      ONE definition of "about", not a jsonb copy that can drift again.
--   3. Corrects the rows 205 already indexed with the wrong set: only
--      `counter.changed` rows changed meaning, and only those already indexed
--      (subject_ids NOT NULL) can be wrong -- a NULL row will be backfilled by
--      the redefined function. Row locks only, on append-only rows no writer
--      updates; the watermark invariant (NOT NULL at or above indexed_from) is
--      untouched because no row goes NULL.
--
-- RE-RUN SAFETY. `create or replace`, idempotent grants, and an UPDATE that
-- only touches rows whose stored value differs from the canonical one.
-- =============================================================================

create or replace function internal.event_subject_ids(p_event_type text, p_payload jsonb)
returns uuid[] language sql immutable parallel safe
set search_path = pg_catalog, pg_temp as $$
  -- `array(...)` is '{}' on no rows, never NULL. The uuid shape check keeps a
  -- malformed payload value from raising inside an INSERT trigger: a bad id
  -- is dropped, the event is still written.
  select array(
    select distinct candidate::uuid
      from unnest(case
        when p_event_type in ('entity.upsert', 'entity.deleted', 'entity.activity_touched')
          then array[p_payload ->> 'id']
        when p_event_type in ('edge.upsert', 'edge.deleted')
          then array[p_payload ->> 'src_id', p_payload ->> 'dst_id']
        when p_event_type in ('message.created', 'message.updated', 'message.deleted')
          then array[p_payload ->> 'entity_id', p_payload ->> 'anchor_id']
        when p_event_type = 'counter.changed'
          then array[p_payload ->> 'entity_id']
        when p_event_type = 'activity.created'
          then array[p_payload ->> 'entity_id']
        when p_event_type in ('notification.created', 'notification.read')
          then array[p_payload ->> 'target_entity_id']
        when p_event_type = 'git.commit_recorded'
          then array[p_payload ->> 'commitEntityId']
        when p_event_type = 'git.pr_state_changed'
          then array[p_payload ->> 'prEntityId']
        when p_event_type = 'git.worktree_status_changed'
          then array[p_payload ->> 'worktreeEntityId']
        else array[]::text[]
      end) as candidate
     where candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     order by 1)
$$;

comment on function internal.event_subject_ids(text, jsonb) is
  'The entity ids a workspace_events row is about, from its type and payload -- the '
  'canonical subject set (208; pinned by test/events/subject-set.pg.test.ts). Shared by '
  'the insert trigger, the 205 backfill and events.poll ?entity=. Never NULL.';

-- NOT `revoke ... from public`: 205 left this function PUBLIC-executable, and
-- the BEFORE INSERT trigger calls it as whichever role inserts the event --
-- including the SECURITY DEFINER owners of every RPC that writes one
-- (post_message's tm8_graph_owner, ...). Revoking PUBLIC would make every
-- mutation fail with "permission denied for function event_subject_ids"
-- (measured: test/events/subject-set.pg.test.ts). The explicit tm8_app grant
-- documents the one direct reader and survives any later PUBLIC revoke.
grant execute on function internal.event_subject_ids(text, jsonb) to tm8_app;

-- The corrective pass: rows 205 indexed as '{}' that the canonical set says are
-- about an entity. `is distinct from` keeps a re-run from touching anything.
update public.workspace_events e
   set subject_ids = internal.event_subject_ids(e.event_type, e.payload)
 where e.event_type = 'counter.changed'
   and e.subject_ids is not null
   and e.subject_ids is distinct from internal.event_subject_ids(e.event_type, e.payload);

do $verify$
begin
  if internal.event_subject_ids('counter.changed', '{"entity_id":"00000000-0000-0000-0000-000000000009"}')
     <> array['00000000-0000-0000-0000-000000000009']::uuid[] then
    raise exception '208: counter.changed subjects must be {entity_id}';
  end if;

  if internal.event_subject_ids('git.pr_state_changed', '{"prEntityId":"00000000-0000-0000-0000-000000000007"}')
     <> array['00000000-0000-0000-0000-000000000007']::uuid[] then
    raise exception '208: git.pr_state_changed subjects must be {prEntityId}';
  end if;

  if internal.event_subject_ids('menu.updated', '{"id":"00000000-0000-0000-0000-000000000001"}') <> '{}'::uuid[] then
    raise exception '208: a subjectless type must index as {}';
  end if;

  if not has_function_privilege('tm8_app', 'internal.event_subject_ids(text, jsonb)', 'execute') then
    raise exception '208: tm8_app must be able to execute internal.event_subject_ids';
  end if;

  -- No indexed row disagrees with the canonical derivation for the type 208 moved.
  if exists (
    select 1 from public.workspace_events e
     where e.event_type = 'counter.changed'
       and e.subject_ids is not null
       and e.subject_ids is distinct from internal.event_subject_ids(e.event_type, e.payload)) then
    raise exception '208: an indexed counter.changed row still carries the pre-208 subject set';
  end if;
end
$verify$;
