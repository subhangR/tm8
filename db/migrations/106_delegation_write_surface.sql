-- =============================================================================
-- 106 — the delegation write surface, and the cross-space read (2026-08-12).
--
-- 105 built the vocabulary. This makes it grantable, revocable and readable —
-- and carries the genuinely novel piece: a read that crosses a space boundary
-- without the reader becoming a member of that space.
--
-- Still no enforcement. Nothing refuses anybody because of a missing delegation
-- at the end of this migration; that is the next step, and it comes after the
-- UI can say what it may do.
--
-- ── THE HOT-PATH PROBLEM, AND HOW IT IS HANDLED ───────────────────────────
--
-- `entity_readable` runs per row on every read in the product. An arm that
-- scans a delegation table would be a node-wide performance regression that
-- presents as "the app got slower", not as a security change.
--
-- So the arm short-circuits on `internal.caller_has_any_delegation()`, which is
-- ONE indexed existence probe and is marked `stable` so the planner may hoist
-- it out of the per-row loop. Almost nobody holds a delegation, so almost every
-- read pays one boolean. The short-circuit can only ever DENY — if it were
-- wrong it would refuse a legitimate reader rather than admit an illegitimate
-- one, which is the correct direction for a caching optimisation on a
-- permission check.
--
-- A claim-based short-circuit was considered and rejected: it would need new
-- claim plumbing in the server for a benefit the `stable` probe already gives,
-- and every claim added to the authorization path is one more thing that has to
-- be proven not to be trusted.
--
-- ── WHAT A DELEGATION LETS YOU SEE ────────────────────────────────────────
--
-- Exactly: the named work_session entity, its transcript doc, and messages
-- anchored on it. NOT the space's other entities, NOT the project, NOT other
-- sessions. The bound is enumerated in `internal.has_delegated_reach` rather
-- than implied by a join, so widening it is a visible edit.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The short-circuit and the reach predicate.
-- -----------------------------------------------------------------------------
create or replace function internal.caller_has_any_delegation() returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null and exists (
    select 1 from public.session_delegations d
     where d.revoked_at is null
       and (d.expires_at is null or d.expires_at > now())
       and d.subject_identity_id = internal.identity_id()
  )
$$;

create or replace function internal.has_delegated_reach(target uuid) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.caller_has_any_delegation() and exists (
    select 1
      from public.entities e
      -- The three reachable shapes, enumerated. A delegation over a session
      -- reaches the session, what it said, and what was said to it — nothing
      -- else in the grantor's space.
      left join public.messages msg on msg.entity_id = e.id
      left join public.work_sessions ts on ts.transcript_doc_id = e.id
     where e.id = target
       and internal.session_capability(
             case
               when e.kind = 'work_session' then e.id
               when ts.entity_id is not null then ts.entity_id
               when msg.anchor_id is not null then msg.anchor_id
             end
           ) is not null
  )
$$;

-- The read arm. `entity_readable` is the ONE predicate every detail table
-- delegates to, so the arm lands here and nowhere else.
create or replace function internal.entity_readable(target uuid) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select exists (
    select 1 from public.entities entity_row
     where entity_row.id = target
       and entity_row.deleted_at is null
       and (
         (
           internal.is_space_member(entity_row.space_id)
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
         -- NEW: a delegation reaches across the space boundary. Deliberately
         -- NOT conditioned on is_space_member — that is the whole point.
         or internal.has_delegated_reach(target)
       )
  )
$$;

-- `entities_select` is the row policy itself and must gain the same arm, or a
-- delegate could read a session's detail row while the envelope stayed hidden.
drop policy if exists entities_select on public.entities;
create policy entities_select on public.entities for select to tm8_app
  using (
    (visibility = 'space' and internal.is_space_member(space_id))
    or (visibility = 'restricted' and internal.entity_readable(id))
    or internal.has_delegated_reach(id)
  );

grant execute on function internal.has_delegated_reach(uuid) to tm8_app;
grant execute on function internal.caller_has_any_delegation() to tm8_app;

-- -----------------------------------------------------------------------------
-- 2. Granting.
--
-- The delegate member row is what makes attribution, `can_act_as` and audit
-- keep working through existing machinery. It is `membership_kind='delegate'`,
-- which `is_space_member` excludes (105), so it confers no membership.
-- -----------------------------------------------------------------------------
create or replace function public.grant_session_delegation(
  p_space_id uuid,
  p_subject_identity text,
  p_subject_team_member_id uuid,
  p_scope text,
  p_work_session_id uuid,
  p_project_id uuid,
  p_level text,
  p_expires_at timestamptz default null,
  p_note text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  grantor uuid;
  delegate_member uuid;
  row_out public.session_delegations;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'sessions.delegations.grant');
  if replay is not null then return replay; end if;

  perform internal.require_space_member(p_space_id);
  grantor := internal.current_member_id(p_space_id);
  if grantor is null then
    raise exception 'no member row in this space' using errcode = '42501';
  end if;

  if internal.session_level_rank(p_level) = 0 then
    raise exception 'unknown delegation level: %', p_level using errcode = '22023';
  end if;

  -- You may only delegate over sessions you can already manage. Without this a
  -- member could grant a third party rights they do not themselves hold.
  if p_scope = 'session' then
    perform internal.require_session_capability(p_work_session_id, 'manage');
  end if;

  if p_subject_identity is not null and p_subject_identity = internal.identity_id() then
    raise exception 'an account may not delegate to itself' using errcode = '22023';
  end if;

  -- Clamped rather than trusted. An unbounded standing grant is the thing an
  -- audit cannot reason about later.
  if p_expires_at is not null and p_expires_at > now() + interval '30 days' then
    raise exception 'a delegation may not last more than 30 days' using errcode = '22023';
  end if;

  insert into public.session_delegations(
    grantor_space_id, grantor_member_id, subject_identity_id, subject_team_member_id,
    scope, work_session_id, project_id, level, note, granted_by, expires_at)
  values (p_space_id, grantor, p_subject_identity, p_subject_team_member_id,
          p_scope, p_work_session_id, p_project_id, p_level, p_note, grantor, p_expires_at)
  returning * into row_out;

  -- Reify an identity subject as a delegate member row, so writes have an actor.
  if p_subject_identity is not null
     and not exists (select 1 from public.members m
                      where m.space_id = p_space_id and m.identity_id = p_subject_identity) then
    delegate_member := internal.new_id();
    insert into public.entities(id, space_id, kind, created_by, visibility)
    values (delegate_member, p_space_id, 'member', grantor, 'space');
    insert into public.members(entity_id, space_id, identity_id, role, membership_kind, display_name)
    select delegate_member, p_space_id, p_subject_identity, 'member', 'delegate', up.display_name
      from public.user_profiles up where up.identity_id = p_subject_identity;
  end if;

  -- Auditability is the feature, not a byproduct.
  --
  -- `linked` rather than a new verb: activity's verb set is CLOSED (003:35-38)
  -- and a delegation genuinely IS a link between a subject and a session. Same
  -- reasoning 062 records for reusing `restored` on resume. The detail that
  -- makes it a delegation lives in the summary, where it is queryable.
  perform internal.record_activity(p_space_id, grantor, grantor, 'linked',
            p_work_session_id,
            jsonb_build_object('kind', 'session_delegation', 'level', p_level,
                               'scope', p_scope, 'delegationId', row_out.id,
                               'subject', coalesce(p_subject_identity, p_subject_team_member_id::text)));

  result := jsonb_build_object('delegation', to_jsonb(row_out));
  return internal.ledger_record(p_client_mutation_id, 'sessions.delegations.grant', result);
end
$$;

create or replace function public.revoke_session_delegation(
  p_delegation_id uuid, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  d public.session_delegations;
  me uuid;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'sessions.delegations.revoke');
  if replay is not null then return replay; end if;

  select * into d from public.session_delegations where id = p_delegation_id;
  if d.id is null then
    raise exception 'delegation not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(d.grantor_space_id);
  me := internal.current_member_id(d.grantor_space_id);

  -- The grantor, whoever recorded it, or a space admin.
  if me is distinct from d.grantor_member_id
     and me is distinct from d.granted_by
     and not internal.is_space_admin(d.grantor_space_id) then
    raise exception 'not permitted to revoke this delegation' using errcode = '42501';
  end if;

  update public.session_delegations
     set revoked_at = now(), revoked_by = me
   where id = p_delegation_id and revoked_at is null
  returning * into d;

  -- Drop the delegate member row once nothing else is holding it open. A
  -- delegate row that outlived every grant would be an actor with no authority
  -- and no reason to exist.
  if d.subject_identity_id is not null
     and not exists (select 1 from public.session_delegations other
                      where other.grantor_space_id = d.grantor_space_id
                        and other.subject_identity_id = d.subject_identity_id
                        and other.revoked_at is null
                        and (other.expires_at is null or other.expires_at > now())) then
    delete from public.entities e
     using public.members m
     where m.entity_id = e.id
       and m.space_id = d.grantor_space_id
       and m.identity_id = d.subject_identity_id
       and m.membership_kind = 'delegate';
  end if;

  perform internal.record_activity(d.grantor_space_id, me, me, 'unlinked',
            d.work_session_id,
            jsonb_build_object('kind', 'session_delegation', 'delegationId', p_delegation_id));

  result := jsonb_build_object('delegation', to_jsonb(d));
  return internal.ledger_record(p_client_mutation_id, 'sessions.delegations.revoke', result);
end
$$;

-- Invoker, so RLS on `session_delegations` (105) does the filtering: you see
-- grants you issued and grants naming you, and nothing else.
create or replace function public.list_session_delegations(p_space_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path = public, internal, pg_temp as $$
declare rows jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(d) order by d.granted_at desc), '[]'::jsonb)
    into rows
    from public.session_delegations d
   where d.grantor_space_id = p_space_id and d.revoked_at is null;
  return rows;
end
$$;

revoke all on function public.grant_session_delegation(uuid, text, uuid, text, uuid, uuid, text, timestamptz, text, text) from public;
revoke all on function public.revoke_session_delegation(uuid, text) from public;
revoke all on function public.list_session_delegations(uuid) from public;
grant execute on function public.grant_session_delegation(uuid, text, uuid, text, uuid, uuid, text, timestamptz, text, text) to tm8_app;
grant execute on function public.revoke_session_delegation(uuid, text) to tm8_app;
grant execute on function public.list_session_delegations(uuid) to tm8_app;

reset role;
