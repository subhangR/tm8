-- =============================================================================
-- 013 — carve the "seq order IS commit order" invariant into
--       internal.next_event_seq itself. NO behaviour change whatsoever.
--
-- WHY THIS MIGRATION EXISTS (Orion's ruling, and he is right): the invariant was
-- documented in db/test/event_seq.test.mjs, but the engineer who would break it is
-- reading the SQL, not the tests. So the warning has to travel with the object.
--
-- The function body below is byte-for-byte the logic from 003 — same INSERT ... ON
-- CONFLICT, same language sql, same default volatility, same search_path. Only
-- comments are added. A create-or-replace preserves the ACL, and comments inside a
-- SQL function body are stored verbatim in pg_proc.prosrc, so anyone running
--
--     \sf internal.next_event_seq
--     select pg_get_functiondef('internal.next_event_seq(uuid)'::regprocedure);
--
-- sees the warning at the moment they are about to edit it. That is the whole
-- point of putting it here rather than only in 003's prose (which is
-- checksum-locked) or in a test file (which they are not reading).
-- =============================================================================
set role tm8_graph_owner;

create or replace function internal.next_event_seq(target_space uuid) returns bigint
language sql set search_path = public, internal, pg_temp as $$
  -- ############################################################################
  -- ##  DO NOT convert this to a Postgres SEQUENCE, an identity column, or     ##
  -- ##  anything else that allocates outside the transaction.                  ##
  -- ############################################################################
  --
  -- This is an UPSERT against a per-space ROW on purpose, and two properties that
  -- the entire event stream depends on fall out of that choice:
  --
  --   1. SEQ ORDER IS COMMIT ORDER. The ON CONFLICT DO UPDATE takes a row lock on
  --      space_event_seq for this space and HOLDS IT UNTIL COMMIT. So a second
  --      writer in the same space cannot obtain seq N+1 until the holder of seq N
  --      has committed. That is what makes `where seq > cursor` a safe poll
  --      cursor: a client can never read seq 5, advance its cursor past 4, and
  --      then have 4 appear later. A real sequence allocates OUTSIDE the
  --      transaction, so seq 5 could commit while 4 was still in flight — and the
  --      poller would lose event 4 permanently. It would not error. It would just
  --      silently drop events under concurrency.
  --
  --   2. NO GAPS. A rolled-back transaction rolls back its increment too, so the
  --      next writer reuses the number. A sequence would burn it forever. Several
  --      tests assert the seq run is contiguous from 1, which is only a legitimate
  --      invariant because of this.
  --
  -- The cost of both guarantees is that writes to ONE space serialise on this row.
  -- That is deliberate and it is per-space, not global: a busy space does not
  -- throttle any other space. Do not "optimise" the contention away without
  -- reading db/test/event_seq.test.mjs first — its blocking, rollback and
  -- concurrent-poller tests exist to make that change fail loudly.
  insert into public.space_event_seq(space_id, last_seq) values (target_space, 1)
  on conflict (space_id) do update set last_seq = space_event_seq.last_seq + 1
  returning last_seq
$$;

comment on function internal.next_event_seq(uuid) is
  'Allocates the next per-space workspace_events.seq. Deliberately an upsert '
  'against a per-space ROW, not a sequence: the row lock is held to commit, so '
  'seq order equals COMMIT order and `seq > cursor` cannot skip an uncommitted '
  'lower seq. Rolled-back writers leave no gap. Converting this to a sequence '
  'silently breaks the poll cursor under concurrency — see the body comment and '
  'db/test/event_seq.test.mjs (013).';

reset role;
