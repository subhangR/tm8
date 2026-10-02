-- =============================================================================
-- 277 · ATTENTION GOES TO WHOEVER RUNS THE SESSION.
--
-- tm8 is a collaborative space: every member still SEES every request (RLS is
-- unchanged), but a request a session or chat raises is PERSONAL to the human
-- running that session (Subhang, 2026-10-02). Before this, agent and system
-- rows were unassigned unless the caller named an assignee, so they were
-- nobody's "Personal" and landed in everyone's "Team" queue alike.
--
--   1. internal.session_runner_member(session): the active member who runs a
--      work_session or chat. No column records "who pressed launch" (202), so
--      it is derived, nearest fact first, walking up the parent chain:
--        a. a chat:          chats.configured_by_member_id
--        b. a work_session:  entities.created_by when that is a member (a human
--                            spawned it; an agent spawn records the persona)
--        c.                  the account on its agent token
--                            (auth_sessions.work_session_id; the spawner's
--                            account, re-issued to the resumer on resume —
--                            live tokens first, then newest)
--        d.                  session_space_credentials.launcher_account_id
--        e. else the parent session or chat (an agent's child session).
--      team_members.owner_member_id is deliberately NOT a fallback: since 075
--      any active member may act as any teammate (206:116). Unresolvable →
--      null, and the request stays unassigned (Team only).
--   2. A BEFORE INSERT trigger defaults assignee_id from source_session_id when
--      the writer named none. That covers every writer at once: the public
--      create (agents), and the system pair (forms an agent raised, conflicts
--      from a worktree session). A system row with no session (blocked
--      dependency) stays unassigned. An explicit --assignee always wins.
-- =============================================================================

-- Runs as the graph owner, like 265/266: the attention writers are its
-- definers, and so is the trigger function they fire.
set role tm8_graph_owner;

create or replace function internal.session_runner_member(p_session_id uuid)
returns uuid language sql stable security definer
set search_path = public, internal, pg_temp as $$
  with recursive chain(id, kind, space_id, created_by, parent_id, depth) as (
    select e.id, e.kind, e.space_id, e.created_by, e.parent_id, 0
      from public.entities e
     where e.id = p_session_id and e.kind in ('work_session', 'chat')
    union all
    select p.id, p.kind, p.space_id, p.created_by, p.parent_id, c.depth + 1
      from chain c
      join public.entities p on p.id = c.parent_id
     where c.kind = 'work_session' and p.kind in ('work_session', 'chat') and c.depth < 16
  ), candidate(member_id, depth, rank) as (
    select ch.configured_by_member_id, c.depth, 1
      from chain c join public.chats ch on ch.entity_id = c.id
    union all
    select c.created_by, c.depth, 2
      from chain c where c.kind = 'work_session'
    union all
    select m.entity_id, c.depth, 3
      from chain c
      cross join lateral (
        select a.account_id from public.auth_sessions a
         where a.work_session_id = c.id and a.kind = 'agent'
         order by (a.revoked_at is null) desc, a.created_at desc
         limit 1) token
      join public.accounts acc on acc.id = token.account_id
      join public.members m on m.identity_id = acc.identity_id and m.space_id = c.space_id
    union all
    select m.entity_id, c.depth, 4
      from chain c
      join public.session_space_credentials ssc on ssc.work_session_id = c.id
      join public.accounts acc on acc.id = ssc.launcher_account_id
      join public.members m on m.identity_id = acc.identity_id and m.space_id = c.space_id
  )
  select candidate.member_id
    from candidate
    join public.members m on m.entity_id = candidate.member_id and m.status = 'active'
    join public.entities s on s.id = p_session_id and s.space_id = m.space_id
   order by candidate.depth, candidate.rank
   limit 1
$$;

revoke all on function internal.session_runner_member(uuid) from public;

comment on function internal.session_runner_member(uuid) is
  'The active member running a work_session or chat (277): chat configurer, human spawner, '
  'agent-token account, space-credential launcher, else the parent session''s. Null when unknown.';

create or replace function internal.attention_requests_default_assignee() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if new.assignee_id is null and new.source_session_id is not null then
    new.assignee_id := internal.session_runner_member(new.source_session_id);
  end if;
  return new;
end
$$;

revoke all on function internal.attention_requests_default_assignee() from public;

-- Named to sort BEFORE attention_requests_validate (BEFORE triggers fire in
-- name order), so the validate trigger checks the assignee this one chose.
create trigger attention_requests_assign_runner
before insert on public.attention_requests
for each row execute function internal.attention_requests_default_assignee();

reset role;
