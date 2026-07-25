-- =============================================================================
-- 014 — optimistic concurrency did not survive actual concurrency: two edits at
--       the same expectedVersion BOTH succeeded, and one silently clobbered the
--       other. A lost update.
--
-- THE BUG (found by db/test/second_user.test.mjs, which races two entitled members
-- on one task — the case Orion asked for after the loop went green):
--
--   internal.assert_version is "optimistic concurrency, one place". It read the
--   current version with a PLAIN SELECT:
--
--     select version into current_version from public.entities where id = target;
--     if expected is not null and current_version <> expected then raise 40001
--
--   An unlocked read under READ COMMITTED means two transactions holding
--   expectedVersion = 1 both read 1, both pass the check, and both proceed. The
--   second one then blocks on the tasks row lock, waits for the first to commit,
--   and applies its UPDATE on top — overwriting an edit its author never saw.
--
--   Measured on the applied 001-013 sequence: two simultaneous
--   update_task_content calls on one task, both with p_expected_version = 1,
--   both returned SUCCESS. Neither client was told anything had gone wrong.
--   expectedVersion is the ONLY thing standing between two users and a lost
--   update, and it was decorative under the exact conditions it exists for.
--
--   Note it was NOT reachable through complete_task: that one takes
--   `select ... from entities ... for update` itself before calling
--   assert_version, which is precisely the lock this migration moves into the
--   shared helper. The concurrent-completion test passed and paid one award even
--   before this fix — the hole was in every OTHER version-checked RPC
--   (update_task_content, update_document, update_channel, update_collection,
--   update_team_member, edit_message).
--
-- THE FIX: take the row lock while checking, so the check and the write that
-- depends on it cannot be separated. `for update` blocks the second caller; when
-- the first commits, READ COMMITTED re-fetches the updated row, the second sees
-- version 2 against its expected 1, and gets its 40001.
--
--   * The function must become VOLATILE. Postgres refuses `SELECT FOR UPDATE is
--     not allowed in a non-volatile function`, and it was declared STABLE.
--     Verified directly before writing this.
--   * No deadlock risk from lock ordering: the lock is on the same
--     public.entities row that internal.snapshot_entity_version already takes
--     (`select version + 1 ... for update`) a moment later, and complete_task
--     already took it first. This makes the order uniform rather than adding to it.
--   * Callers that pass expected := null still take the lock. That is deliberate:
--     it serialises concurrent writers to one entity, so a caller that opts out of
--     version checking still cannot lose an update.
--
-- Everything else is byte-identical: same 40001, same P0002 for a missing entity,
-- same DETAIL carrying entityId and currentVersion so the facade can attach
-- `current` to the conflict.
--
-- Forward-only: 007 is applied and checksum-locked elsewhere.
-- =============================================================================
set role tm8_graph_owner;

-- VOLATILE, not STABLE: `for update` is a tuple write and Postgres will not allow
-- it in a non-volatile function. The volatility change IS part of the fix.
create or replace function internal.assert_version(target uuid, expected integer) returns void
language plpgsql volatile set search_path = public, internal, pg_temp as $$
declare current_version integer;
begin
  -- FOR UPDATE is load-bearing, not defensive. Without the lock two callers
  -- holding the same expectedVersion both pass this check and the second silently
  -- overwrites the first (014). With it, the second blocks here, then re-reads the
  -- committed row under READ COMMITTED and raises the conflict it should have.
  select version into current_version from public.entities where id = target for update;
  if current_version is null then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;
  if expected is not null and current_version <> expected then
    raise exception 'version conflict on %', target
      using errcode = '40001',
            detail = jsonb_build_object('entityId', target, 'currentVersion', current_version)::text;
  end if;
end
$$;

comment on function internal.assert_version(uuid, integer) is
  'Optimistic concurrency, in one place. Locks the entities row FOR UPDATE while '
  'checking, so the check cannot be separated from the write that relies on it — '
  'an unlocked read let two callers at the same expectedVersion both succeed, and '
  'the loser''s edit vanished (014). Must stay VOLATILE for the lock.';

reset role;
