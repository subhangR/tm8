-- 159 · the two nested RLS predicates stop calling `internal.is_space_member`
--
-- WHAT THIS CHANGES. `internal.entity_row_visible` (the `entities_select`
-- policy body, 070) and `internal.entity_readable` (the SELECT policy body on
-- 38 tables, 008/021) each open by calling ANOTHER `security definer`
-- `language sql` function, `internal.is_space_member`, whose body contains a
-- query. Both callers inline that membership `exists` instead. Nothing else
-- moves: the carve-out, the tombstone filter, the volatility, the security
-- context, the search_path and the signatures are byte-identical, so the
-- policies that reference these functions are not touched at all.
--
-- WHY. A `language sql` function that contains a query costs ~17 us called
-- from a top-level `WHERE`, and ~104 us called from inside another non-inlined
-- SQL function's body. Same function, same arguments, same data. The cause is
-- plan/executor-state lifetime: at top level the callee's cache lives in the
-- calling expression's `fn_extra` and survives across rows; nested inside
-- another SQL function's body it is torn down and rebuilt per call.
--
-- This was bisected one variable at a time on staging, 7 000 calls each:
--
--     exact production shape                        119 us/call
--     project carve-out REMOVED                     125 us/call   <- not it
--     `set search_path` REMOVED                     124 us/call   <- not it
--     `security definer` REMOVED                    133 us/call   <- not it
--     nesting FLATTENED, carve-out intact            25 us/call   <- 4.8x
--
-- The three obvious suspects are all exonerated by measurement, which is why
-- the carve-out is deliberately left exactly as 070 and 021 wrote it: it costs
-- nothing, so there is no reason to touch it and every reason not to.
-- `security definer` matters only because it is what stops the OUTER function
-- from being inlined in the first place; removing it alone changes nothing,
-- because the body still contains a SubPlan.
--
-- Measured on prod data (7 099 rows, same session, back to back):
--
--     policy = entity_row_visible  (nested)      1 285 ms
--     policy = flattened                           242 ms      5.3x
--     entity_readable over 7 099 real ids        1 441 ms
--     flattened                                    354 ms      3.9x
--
-- `internal.is_space_member` IS NOT TOUCHED. It is called at top level by 18
-- other policies, where it already costs ~17 us and where the defect does not
-- exist. This migration changes the two nested callers, not the leaf.
--
-- WHY THIS IS SAFE, stated precisely.
--
--   * Every one of the 66 RLS policies in this database is a SELECT policy and
--     there is not a single `with check` clause anywhere
--     (`select cmd, count(*) from pg_policies group by cmd` -> SELECT = 66;
--      `select count(*) from pg_policies where with_check is not null` -> 0),
--     and `tm8_app` holds only SELECT on `entities`, `messages`, `members` and
--     `edges`. So no POLICY consults these functions on a write.
--
--   * That is NOT the same as "the write path never consults these functions",
--     and the difference matters: `internal.entity_readable` is also called as
--     an explicit authorization guard INSIDE `security definer` write RPCs —
--     `public.w2_post_message_batch` (anchor and parent checks),
--     `public.mark_read`, `public.start_chat_thread`,
--     `public.w2_init_file_upload` and others. A semantic change here WOULD
--     reach write authorization through those callers.
--
--   * What makes this safe is therefore equivalence, not reachability. The
--     inlined expression is the callee's body with its parameter substituted,
--     evaluated in the same security context (all three functions are owned by
--     `tm8_graph_owner`), against tables that same owner already bypasses RLS
--     on (`members` has `relrowsecurity` set and `relforcerowsecurity` unset,
--     and its owner is `tm8_graph_owner`), under the same `search_path`. `and`
--     is associative in three-valued logic and `exists` never yields NULL, so
--     `is_space_member(x) and P` and `(identity_id() is not null and exists …)
--     and P` agree on every input including NULL — which is also what the
--     empirical check below found.
--
-- EQUIVALENCE, verified on prod data before this was written (read only, in a
-- transaction that rolled back), old function vs new under four identity
-- classes — a member, a DIFFERENT member, a non-member, and `tm8.identity_id`
-- unset:
--
--     entity_row_visible, every real row tuple            7 100 combos
--     entity_row_visible, full cross-product             27 540 combos
--       (every carve-out id x every space x every kind x every visibility,
--        plus NULLs and an id that does not exist)
--     entity_row_visible, carve-out over EVERY id        85 224 combos
--     entity_readable, exhaustive over every id           7 102 combos
--                                                    --------------
--                            507 864 comparisons in total, 0 mismatches
--
-- and row-count equality on the real tables for all 9 member identities and
-- all 5 spaces: `select count(*) from public.entities` and `from
-- public.messages` under `set role tm8_app` are identical before and after,
-- per identity and per space. The non-member and unset identities see 0 rows
-- in every part, which is the failure this change could plausibly have caused
-- and did not.

set role tm8_graph_owner;

-- 070's body, with `internal.is_space_member(p_space_id)` expanded in place.
-- The carve-out below is character-for-character what 070 shipped.
create or replace function internal.entity_row_visible(
  p_id uuid, p_space_id uuid, p_kind text, p_visibility text
) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select (
    -- WAS: `internal.is_space_member(p_space_id)`. Identical expression, one
    -- SQL-function call level shallower. See 002 for the original.
    internal.identity_id() is not null
    and exists (
      select 1 from public.members m
       where m.space_id = p_space_id
         and m.identity_id = internal.identity_id()
    )
  ) and (
    p_visibility = 'space'
    or (
      -- 021: a restricted `project` projection is visible exactly while its
      -- space link is active. Same shape as entity_readable's carve-out.
      p_visibility = 'restricted'
      and p_kind = 'project'
      and exists (
        select 1
          from public.project_links link
          join public.space_projects active_link
            on active_link.space_id = link.space_id
           and active_link.project_id = link.project_id
         where link.project_entity_id = p_id
           and link.space_id = p_space_id
      )
    )
  )
$$;

-- 021's body, same expansion. The `deleted_at is null` conjunct stays — it is
-- the one thing entity_readable has that entity_row_visible deliberately does
-- not (070 explains why), and dropping it here would silently admit tombstones
-- to 38 tables.
create or replace function internal.entity_readable(target uuid) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select exists (
    select 1 from public.entities entity_row
     where entity_row.id = target
       and entity_row.deleted_at is null
       -- WAS: `internal.is_space_member(entity_row.space_id)`.
       and internal.identity_id() is not null
       and exists (
         select 1 from public.members m
          where m.space_id = entity_row.space_id
            and m.identity_id = internal.identity_id()
       )
       and (
         entity_row.visibility = 'space'
         or (
           entity_row.visibility = 'restricted'
           and entity_row.kind = 'project'
           and exists (
             select 1
               from public.project_links link
               join public.space_projects active_link
                 on active_link.space_id = link.space_id
                and active_link.project_id = link.project_id
              where link.project_entity_id = entity_row.id
                and link.space_id = entity_row.space_id
           )
         )
       )
  )
$$;

-- `create or replace` preserves the existing ACL, so these are restatements
-- rather than repairs. They are here because 138 exists precisely because a
-- migration once left a definer function executable by PUBLIC, and because the
-- surface enumeration test asserts on the result.
revoke all on function internal.entity_row_visible(uuid, uuid, text, text) from public;
grant execute on function internal.entity_row_visible(uuid, uuid, text, text) to tm8_app;
revoke all on function internal.entity_readable(uuid) from public;
grant execute on function internal.entity_readable(uuid) to tm8_app;

reset role;
