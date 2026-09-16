-- 189 — The due-loop sweep sees every space, and knows who may fire each loop
-- (2026-09-15).
--
-- Authored as 185, which was free on the base this branch forked from, and
-- renumbered twice since. First to 187, when two sibling memory lanes landed
-- 185 and 186 in this same integration. Then to 189, when main independently
-- landed its own 185 and 186 (the work-session usage instrument and the
-- CodeBrain tab removal) and this branch merged main back in: main is the
-- trunk, its numbers were published first, so the three files arriving from
-- here moved up rather than asking main to move down.
--
-- Renumbering stays free for the same reason each time: these three add only
-- new functions, none of them touches an object another one defines, and
-- nothing in the tree derives anything from a migration's number — the
-- regression test for this file resolves it by suffix, not by prefix.
--
-- WHAT WAS WRONG. The loop executor (packages/server/src/scheduler/jobs/loops.ts)
-- found due loops with a plain read of public.loops bound as the node's
-- loopback owner. `loops_select` (091) is `internal.entity_readable`, which is
-- membership in public.members and nothing else — the node-admin claim does
-- not widen it, by 002's explicit ruling. On a single-user node the owner is a
-- member of every space and that read is complete. On a multi-user node it is
-- not. Measured on production, bound exactly as the executor binds (owner
-- identity, node_admin = true): the read saw 1 of the node's 21 loops and 0 of
-- its 16 due ones. The "Dreamer daily sweep" that `spaces.create` seeds into
-- every new space — enabled, `every 1d`, first run a day out — had never once
-- been SELECTED in any space the owner did not belong to: no session, no
-- last_run_at, no last_error, entity version still 1, for up to five weeks.
-- The one space where it did run is the one space the owner is a member of.
--
-- THIS DOOR. One node-admin-only SECURITY DEFINER read, the shape 095's
-- file-upload sweep already uses for the same reason (a node job that must
-- enumerate across every space). It returns the due loops on the whole node,
-- oldest-first and bounded, together with WHO may fire each one.
--
-- That second half is as load-bearing as the first. Seeing a loop is not the
-- same as being allowed to run it: `execution_spawn` (043, latest body in 178)
-- admits a persona only through `internal.can_act_as`, which requires the
-- bound identity to OWN the member row that owns the teammate — and
-- `update_loop`, the door the executor advances state through, requires
-- membership of the loop's space. Node-admin widens neither. So the executor
-- has to bind the identity of the teammate's owner: for a loop that names a
-- teammate, that teammate's owner; for a loop that names none (routed through
-- the dispatcher), the owner of the space's dispatcher persona, chosen by the
-- same rule `resolveDispatcherSession` uses — the first-created live
-- dispatcher-mode teammate — so the two cannot drift. A loop for which that
-- resolves to nobody (teammate gone AND no dispatcher; or an owner member row
-- that no longer exists) is still RETURNED, with `runAsIdentityId` null: the
-- executor reports it rather than silently skipping it, because a due loop
-- that quietly never fires is exactly the defect this migration repairs.
--
-- WHY BINDING ANOTHER USER'S IDENTITY IS NOT A BYPASS. 091 calls a loop "a
-- standing grant of the creator's authority on a timer". Each seeded Dreamer
-- loop was created under that user's own claims at the moment they created
-- their space; firing it as them is carrying out the intent they recorded,
-- through every door and every guard a request of theirs would pass. The
-- executor already did exactly this for the owner's own space. Nothing is
-- widened: an identity that could not spawn a persona over HTTP still cannot
-- here, and the refusal lands in the loop's last_error like any other.
--
-- Not a shared object: the function is new. Grants follow 091's explicit
-- revoke/grant pair — 008's wholesale grant predates this function.

set role tm8_graph_owner;

create or replace function public.list_due_loops(
  p_limit integer default 25
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  due jsonb;
begin
  perform internal.require_identity();
  if not internal.is_node_admin() then
    raise exception 'only a node admin can list the loops that are due across every space'
      using errcode = '42501';
  end if;

  with picked as (
    select l.entity_id, e.space_id, l.title, l.schedule, l.team_member_id,
           l.subject_id, l.prompt, l.config, e.version, l.next_run_at,
           -- The persona this firing runs as: the loop's own teammate, else the
           -- space's dispatcher (the pick `resolveDispatcherSession` makes: the
           -- first-created live dispatcher-mode teammate). The loop's own
           -- teammate is NOT filtered on liveness on purpose: if it has been
           -- deleted, resolving its owner anyway lets the spawn refusal be
           -- RECORDED on the loop and the schedule advance, instead of the loop
           -- staying due with nobody entitled to write the error down.
           coalesce(
             l.team_member_id,
             (select tm.entity_id
                from public.team_members tm
                join public.entities te on te.id = tm.entity_id
               where te.space_id = e.space_id
                 and te.deleted_at is null
                 and tm.mode = 'dispatcher'
               order by tm.created_at
               limit 1)
           ) as persona_id
      from public.loops l
      join public.entities e on e.id = l.entity_id
     where l.enabled
       and e.deleted_at is null
       and l.next_run_at is not null
       and l.next_run_at <= now()
     order by l.next_run_at
     limit greatest(coalesce(p_limit, 25), 1)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'entityId',        p.entity_id,
           'spaceId',         p.space_id,
           'title',           p.title,
           'schedule',        p.schedule,
           'teamMemberId',    p.team_member_id,
           'subjectId',       p.subject_id,
           'prompt',          p.prompt,
           'config',          p.config,
           'version',         p.version,
           -- Exactly the `can_act_as` route (002): teammate -> owning member
           -- row in the same space -> that row's identity.
           'runAsIdentityId', m.identity_id,
           -- Carried honestly from the account, never asserted: it is what the
           -- executor would bind for this person if they were the node owner.
           'runAsNodeAdmin',  coalesce(a.is_node_admin, false)
         ) order by p.next_run_at), '[]'::jsonb)
    into due
    from picked p
    left join public.team_members persona on persona.entity_id = p.persona_id
    left join public.members m on m.entity_id = persona.owner_member_id
                              and m.space_id = p.space_id
    left join public.accounts a on a.identity_id = m.identity_id;

  return due;
end
$$;

revoke all on function public.list_due_loops(integer) from public;
grant execute on function public.list_due_loops(integer) to tm8_app;

reset role;
