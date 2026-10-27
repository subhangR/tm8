-- =============================================================================
-- 300 — resolve_actor says WHICH actor refusal it is. Task 01a1108a.
--
-- THE DEFECT. `internal.resolve_actor` (002) raises two different refusals
-- with the same SQLSTATE and no DETAIL: no actor at all, and an actor the
-- caller may not act as. The facade decides codes by SQLSTATE alone and never
-- reads message text (db/errors.ts), so both reached a caller, and every
-- audit, as a bare `forbidden`. On prod an agent writing through a space link
-- with its home actor stamped on the input got exactly that, and the link
-- audit (cross_space_audit) recorded only `forbidden`: the cause could not be
-- told apart from any other refusal after the fact.
--
-- THE FIX. The same function, the same checks, the same SQLSTATE and message;
-- each RAISE now carries a JSON DETAIL with a closed `reason`
-- (`no_actor` | `actor_not_permitted`) and the refused actor id. The facade
-- already parses a JSON DETAIL into `details`, so a caller can branch on
-- `details.reason` without reading text. Nothing is authorized differently.
--
-- `create or replace` with the same signature keeps the owner and ACL.
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.resolve_actor(requested uuid, target_space uuid) returns uuid
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare actor uuid;
begin
  perform internal.require_identity();
  actor := coalesce(requested, internal.actor_id(), internal.current_member_id(target_space));
  if actor is null then
    raise exception 'no actor available in this space' using errcode = '42501',
      detail = jsonb_build_object('reason', 'no_actor', 'spaceId', target_space)::text;
  end if;
  if not internal.can_act_as(actor, target_space) then
    raise exception 'not permitted to act as this actor' using errcode = '42501',
      detail = jsonb_build_object('reason', 'actor_not_permitted', 'actorId', actor, 'spaceId', target_space)::text;
  end if;
  return actor;
end
$$;

reset role;
