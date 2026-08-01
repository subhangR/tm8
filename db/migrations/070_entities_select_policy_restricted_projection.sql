-- 070 · entities_select learns the 021 restricted-projection carve-out
--
-- Identity v2 Stage 1/2 (the role downgrade made this real).
--
-- WHAT WAS WRONG. 008 wrote the `entities_select` policy as
--
--     visibility = 'space' and internal.is_space_member(space_id)
--
-- and 021 then invented `visibility = 'restricted'` for materialized project
-- projections, teaching `internal.entity_readable` the carve-out — but never
-- the policy itself. Nobody noticed for a simple reason: the server connected
-- as a superuser with `rolbypassrls`, so this policy never executed. The
-- Stage-2 role downgrade (`set_config('role','tm8_app',true)` inside every
-- claim-binding transaction, db/client.ts) makes it execute, and a linked
-- project's projection entity vanished from every direct read while
-- `entity_readable`-guarded satellites (versions, counters) still admitted it.
--
-- THE FIX is one SECURITY DEFINER predicate for the row policy, mirroring the
-- 021 rules with two deliberate differences from `entity_readable`:
--
--   * no `deleted_at is null` filter — the 008 policy admitted tombstones to
--     members and the handlers own tombstone presentation (`deleted:"only"`
--     listings must keep working);
--   * defined over the ROW's own columns, passed in, rather than a second
--     lookup — the policy already holds the row.
--
-- The project_links/space_projects EXISTS must live in a SECURITY DEFINER
-- helper: inlined in the policy it would run as `tm8_app` and recurse into
-- those tables' own RLS, where project_links has no select policy — the
-- carve-out would evaluate to false forever.

set role tm8_graph_owner;

create or replace function internal.entity_row_visible(
  p_id uuid, p_space_id uuid, p_kind text, p_visibility text
) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.is_space_member(p_space_id) and (
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

revoke all on function internal.entity_row_visible(uuid, uuid, text, text) from public;
-- RLS predicate: tm8_app must be able to execute it from inside the policy
-- (008 §grants pattern; 047 precedent for later additions).
grant execute on function internal.entity_row_visible(uuid, uuid, text, text) to tm8_app;

drop policy entities_select on public.entities;
create policy entities_select on public.entities for select to tm8_app
  using (internal.entity_row_visible(id, space_id, kind, visibility));

reset role;
