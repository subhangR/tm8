-- 313 introduced personal seen markers after the once-per-statement RLS and
-- initial-statistics migrations. Preserve its applied checksum and bring the
-- new table into those existing invariants.
set role tm8_graph_owner;

alter policy entity_seen_select on public.entity_seen
  using (member_id in (
    select m.entity_id from public.members m
     where m.identity_id = internal.identity_id()
       and m.status = 'active'
       and m.space_id = any ((select internal.member_space_ids())::uuid[])
  ));

analyze public.entity_seen;

reset role;
