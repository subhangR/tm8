-- =============================================================================
-- 299  A SESSION SPAWNED THROUGH A LINK IS OBSERVABLE BY ITS SPAWNER.
--
-- 281 lets an agent in A spawn, resume or dispatch a session in B through a
-- space link, and records the child's provenance in `space_link_spawns`. But
-- `execution.journal` and `execution.transcript` stay in SPACE_LINK_REFUSED
-- (session_body), so the spawner saw liveness and nothing else. Now the two
-- reads pass through the link for ONE kind of session: one that this link,
-- under this member, started. Every other session's body stays refused.
--
-- `spaceLinks.invoke`'s in-process executor calls the predicate below under
-- the LINK session's own claims, after the stored session is re-resolved and
-- before B's handler runs. It answers true only when:
--   * the caller is a `link` session carrying its link claim (tm8.via_link);
--   * the work session has a `space_link_spawns` row for THAT link;
--   * the row's member is the caller's own member in the row's target space.
-- A second home member linked over the same link holds a different B member,
-- so it cannot read the first member's child. Anything else answers false,
-- never an error: the executor turns false into the `session_body` refusal.
--
-- ADDS ONLY: one new function.
-- =============================================================================

set role tm8_graph_owner;

create or replace function public.space_link_spawn_owned(p_work_session_id uuid)
returns boolean language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  v_link uuid;
  r public.space_link_spawns;
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') <> 'link' then
    return false;
  end if;
  v_link := nullif(internal.claim_text('tm8.via_link'), '')::uuid;
  if v_link is null then
    return false;
  end if;
  select * into r from public.space_link_spawns where work_session_id = p_work_session_id;
  if r.work_session_id is null or r.link_id <> v_link then
    return false;
  end if;
  return coalesce(r.member_id = internal.current_member_id(r.target_space_id), false);
end
$$;

revoke all on function public.space_link_spawn_owned(uuid) from public;
grant execute on function public.space_link_spawn_owned(uuid) to tm8_app;

reset role;
