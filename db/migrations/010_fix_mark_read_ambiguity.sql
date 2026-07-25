-- =============================================================================
-- 010 — public.mark_read could never run: an ambiguous column reference.
--
-- THE BUG (found by db/test/rls_negatives.test.mjs, which needed a real read mark
-- to have something for the personal-scope policies to hide):
--
--   007's mark_read declares `member_id uuid` and then writes
--
--     insert into public.read_marks(member_id, anchor_id, last_read_at)
--     values (member_id, p_anchor_id, marked)
--     on conflict (member_id, anchor_id) do update set ...
--
--   The ON CONFLICT inference clause has the target table in scope, so `member_id`
--   there is both a PL/pgSQL variable and public.read_marks.member_id:
--
--     ERROR:  column reference "member_id" is ambiguous    (42702)
--     DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
--   It is a runtime error raised at first execution, not a creation-time one, so
--   007 applied clean and the function was simply 100% non-functional: EVERY call
--   to readMarks.upsert failed. Nothing had called it until now.
--
-- The fix is the variable rename (the `v_` prefix the rest of the catalog uses for
-- exactly this reason), and nothing else changes: same guards, same order, same
-- result shape, same operation name in the ledger.
--
-- Forward-only: 001-008 are applied and checksum-locked elsewhere.
-- =============================================================================
set role tm8_graph_owner;

create or replace function public.mark_read(p_anchor_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  v_member_id uuid;
  marked timestamptz := now();
begin
  -- The replay result is deliberately discarded rather than returned: a read mark
  -- is an idempotent upsert, so re-running is the same as replaying. The call is
  -- still made because it binds the cmid for the event-capture trigger.
  perform internal.ledger_replay(p_client_mutation_id, 'readMarks.upsert');
  e := internal.live_entity(p_anchor_id);
  perform internal.require_space_member(e.space_id);
  v_member_id := internal.current_member_id(e.space_id);
  insert into public.read_marks(member_id, anchor_id, last_read_at)
  values (v_member_id, p_anchor_id, marked)
  on conflict (member_id, anchor_id) do update set last_read_at = excluded.last_read_at;
  -- Reading the thing the notification pointed at IS reading the notification.
  update public.notifications set read_at = coalesce(read_at, marked)
   where recipient_member_id = v_member_id and target_entity_id = p_anchor_id and read_at is null;
  return internal.ledger_record(p_client_mutation_id, 'readMarks.upsert',
           jsonb_build_object('anchorId', p_anchor_id, 'lastReadAt', marked, 'patches', '[]'::jsonb));
end
$$;

-- 008 granted EXECUTE on all functions in `public` at the time it ran; a
-- create-or-replace keeps the existing ACL, so no re-grant is needed here. Stated
-- explicitly because it is the kind of thing a reader stops to wonder about.

reset role;
