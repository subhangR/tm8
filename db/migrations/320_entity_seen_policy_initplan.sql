-- 313's entity_seen_select called internal.is_space_member() once per row,
-- the shape 218 removed from every policy. Same visibility (the caller's own
-- active member rows in a space they are a member of, pinned by 227), resolved
-- once per statement through member_space_ids(), like workspace_active_select.
set role tm8_graph_owner;

drop policy entity_seen_select on public.entity_seen;
create policy entity_seen_select on public.entity_seen for select to tm8_app
  using (member_id in (
    select m.entity_id from public.members m
     where m.identity_id = (select internal.identity_id())
       and m.status = 'active'
       and m.space_id = any ((select internal.member_space_ids())::uuid[])
  ));

-- 313 created entity_seen without analyzing it (225's rule: no table at
-- reltuples = -1 after the chain).
analyze public.entity_seen;

reset role;
