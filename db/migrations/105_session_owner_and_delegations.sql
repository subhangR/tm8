-- =============================================================================
-- 105 — session ownership and the delegation vocabulary (2026-08-12).
--
-- Everything here is INERT. Nothing calls the predicate at the end of this
-- migration, and that is deliberate: the write surface must exist before any
-- enforcement, or the first person refused would have no mechanism to be
-- allowed. This file builds the vocabulary; later migrations use it.
--
-- ── THE KEYSTONE ──────────────────────────────────────────────────────────
--
-- There is currently no answer to "whose session is this". `entities.created_by`
-- cannot be the anchor because its KIND VARIES:
--
--   human launch  → a `members` row      → can_act_as true for that human only
--   agent launch  → a `team_members` row → can_act_as true for EVERY member
--
-- The second follows from 075, which widened `can_act_as` so any member may act
-- as any teammate in the space. That is correct for LAUNCH authority and it is
-- what `grant_stream_attach` unfortunately also asks for DRIVE authority — so
-- today every space member can inject keystrokes into any other member's
-- running agent, decided by whether `created_by` happens to be a member row or
-- a teammate row. Nobody chose that, and no surface exposes it.
--
-- `owner_member_id` is a column whose type is always a human member. Because
-- ownership INHERITS DOWN THE SPAWN TREE, "my coordinator may drive my workers"
-- falls out of the plain owner rule with zero extra clauses — a separate
-- spawn-lineage rule was considered and discarded as redundant.
--
-- ── CROSSING THE SPACE BOUNDARY ───────────────────────────────────────────
--
-- Each user has their own space, so delegation must let Raghav grant Subhang
-- drive on ONE session without Subhang becoming a member of Raghav's space.
-- Two pieces: the grant subject is an `identity_id` rather than a member row,
-- and the grant is REIFIED as a `membership_kind='delegate'` member row so that
-- attribution, `can_act_as` and audit keep working through existing machinery
-- instead of a parallel system. `is_space_member` then gains one conjunct.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Who owns a session.
-- -----------------------------------------------------------------------------
alter table public.work_sessions
  add column owner_member_id uuid references public.members(entity_id) on delete restrict;

create index work_sessions_owner_idx on public.work_sessions(owner_member_id);
-- The parent walk below climbs `entities.parent_id` and must tolerate tombstoned
-- ancestors. `entities_parent_position_idx` is PARTIAL on `deleted_at is null`,
-- so without this the recursive step sequential-scans as soon as one ancestor is
-- soft-deleted.
create index entities_work_session_parent_idx on public.entities(parent_id)
  where kind = 'work_session';

create or replace function internal.derive_session_owner(
  p_space_id uuid, p_created_by uuid, p_parent_id uuid
) returns uuid language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  found uuid;
  cursor_id uuid;
  hops integer := 0;
begin
  -- 1. The creator, when it is already a human member.
  if p_created_by is not null then
    select entity_id into found from public.members where entity_id = p_created_by;
    if found is not null then return found; end if;
  end if;

  -- 2. The nearest work_session ancestor's owner. This is what makes a
  --    coordinator's workers belong to the human who started the coordinator.
  --    Bounded rather than recursive-CTE'd so a cycle cannot hang a spawn.
  cursor_id := p_parent_id;
  while cursor_id is not null and hops < 64 loop
    select ws.owner_member_id into found
      from public.work_sessions ws where ws.entity_id = cursor_id;
    if found is not null then return found; end if;
    select e.parent_id into cursor_id from public.entities e where e.id = cursor_id;
    hops := hops + 1;
  end loop;

  -- 3. The human behind the caller — an agent bearer carries its spawner's
  --    identity, so this resolves to that human.
  found := internal.current_member_id(p_space_id);
  if found is not null then return found; end if;

  -- 4. The space owner. A session must always have an accountable human.
  select m.entity_id into found
    from public.members m
   where m.space_id = p_space_id and m.role = 'owner'
   order by m.joined_at limit 1;
  return found;
end
$$;

-- The compat shim. A trigger means the three existing insert sites (043, the
-- 007/036 lineage, and 083's credential sessions) need no change at all, and so
-- does any future writer — which is the point, since a new insert path that
-- forgot to set an owner would silently create an unowned session.
create or replace function internal.fill_session_owner() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare e public.entities;
begin
  if new.owner_member_id is not null then return new; end if;
  select * into e from public.entities where id = new.entity_id;
  if e.id is null then return new; end if;
  new.owner_member_id := internal.derive_session_owner(e.space_id, e.created_by, e.parent_id);
  return new;
end
$$;

create trigger work_sessions_fill_owner
before insert on public.work_sessions
for each row execute function internal.fill_session_owner();

-- Backfill, then make it mandatory.
update public.work_sessions ws
   set owner_member_id = internal.derive_session_owner(e.space_id, e.created_by, e.parent_id)
  from public.entities e
 where e.id = ws.entity_id and ws.owner_member_id is null;

-- A session in a space with no members at all cannot be attributed; there are
-- none, and if one appears the constraint below is the right place to find out.
alter table public.work_sessions alter column owner_member_id set not null;

-- -----------------------------------------------------------------------------
-- 2. Delegate membership.
--
-- `is_space_member` gains ONE conjunct. This is the schema's most load-bearing
-- predicate — 171 call sites inherit it — so the change is a NARROWING with a
-- default that makes every existing row `'full'`, i.e. behaviour is identical
-- for all current data and only the new kind is excluded.
-- -----------------------------------------------------------------------------
alter table public.members
  add column membership_kind text not null default 'full'
    check (membership_kind in ('full', 'delegate'));

create or replace function internal.is_space_member(target_space uuid) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null and exists (
    select 1 from public.members m
     where m.space_id = target_space
       and m.identity_id = internal.identity_id()
       and m.membership_kind = 'full'
  )
$$;

-- -----------------------------------------------------------------------------
-- 3. The delegation grant.
-- -----------------------------------------------------------------------------
create table public.session_delegations (
  id                     uuid primary key default internal.new_id(),
  grantor_space_id       uuid not null references public.spaces(id) on delete cascade,
  -- WHOSE sessions. Always a human member: an agent is not accountable.
  grantor_member_id      uuid not null references public.members(entity_id) on delete cascade,
  -- WHO may act. An identity_id, NOT a member row — that is the whole
  -- cross-space change, and why the subject need not be in the grantor's space.
  subject_identity_id    text references public.user_profiles(identity_id),
  -- ...or a teammate persona, which is how a coordinator gets converse on
  -- someone else's workers once 075's blanket is gone.
  subject_team_member_id uuid references public.team_members(entity_id) on delete cascade,
  scope                  text not null check (scope in ('session', 'project', 'space')),
  work_session_id        uuid references public.work_sessions(entity_id) on delete cascade,
  project_id             uuid references public.projects(id) on delete cascade,
  level                  text not null check (level in ('watch', 'converse', 'drive', 'manage')),
  note                   text check (note is null or char_length(note) <= 280),
  granted_by             uuid not null references public.members(entity_id),
  granted_at             timestamptz not null default now(),
  expires_at             timestamptz,
  revoked_at             timestamptz,
  revoked_by             uuid references public.members(entity_id),
  constraint session_delegations_one_subject check (
    (subject_identity_id is not null)::int + (subject_team_member_id is not null)::int = 1),
  constraint session_delegations_scope_shape check (
       (scope = 'session' and work_session_id is not null and project_id is null)
    or (scope = 'project' and project_id is not null and work_session_id is null)
    or (scope = 'space'   and work_session_id is null and project_id is null))
);
create index session_delegations_subject_idx
  on public.session_delegations(subject_identity_id) where revoked_at is null;
create index session_delegations_grantor_idx
  on public.session_delegations(grantor_member_id) where revoked_at is null;
create index session_delegations_session_idx
  on public.session_delegations(work_session_id) where revoked_at is null;

comment on table public.session_delegations is
  'Explicit, revocable, audited grants over another member''s work sessions. '
  'Subject is an identity_id so a grant can cross a space boundary without the '
  'subject becoming a member. Deliberately NOT merged with a general entity ACL: '
  'an entity-keyed table cannot express "all my sessions, including future ones".';

-- -----------------------------------------------------------------------------
-- 4. The ladder and the predicate. Nothing calls these yet.
-- -----------------------------------------------------------------------------
create or replace function internal.session_level_rank(p_level text) returns integer
language sql immutable set search_path = public, internal, pg_temp as $$
  select case p_level
           when 'watch' then 1 when 'converse' then 2
           when 'drive' then 3 when 'manage' then 4 else 0 end
$$;

-- The caller's highest level over one session, or null.
--
-- Levels NEST, so this returns a single level rather than a set: storing a set
-- would make `{drive}` without `{watch}` representable and meaningless.
create or replace function internal.session_capability(p_session_id uuid) returns text
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  ws public.work_sessions;
  me uuid;
  best integer := 0;
  candidate integer;
begin
  select * into e from public.entities where id = p_session_id and kind = 'work_session';
  if e.id is null or e.deleted_at is not null then return null; end if;
  select * into ws from public.work_sessions where entity_id = p_session_id;
  if ws.entity_id is null then return null; end if;

  -- 1. The owner.
  me := internal.current_member_id(e.space_id);
  if me is not null and me = ws.owner_member_id then return 'manage'; end if;

  -- 2. Space admin. The control is the audit trail, not the gate — and this is
  --    already a massive narrowing from today, where every space MEMBER can
  --    terminate any session in the space.
  if internal.is_space_admin(e.space_id) then return 'manage'; end if;

  -- 3/4. A live delegation naming this identity, or a teammate it may act as.
  select max(internal.session_level_rank(d.level)) into candidate
    from public.session_delegations d
   where d.grantor_member_id = ws.owner_member_id
     and d.revoked_at is null
     and (d.expires_at is null or d.expires_at > now())
     and (
       d.subject_identity_id = internal.identity_id()
       or (d.subject_team_member_id is not null
           and internal.can_act_as(d.subject_team_member_id, e.space_id))
     )
     and (
       (d.scope = 'session' and d.work_session_id = p_session_id)
       or (d.scope = 'project' and ws.project_id is not null and d.project_id = ws.project_id)
       or (d.scope = 'space' and d.grantor_space_id = e.space_id)
     );
  if candidate is not null and candidate > best then best := candidate; end if;

  -- 5. The broadcast floor. Never raises above watch.
  if best = 0 and ws.share_mode = 'space' and internal.is_space_member(e.space_id) then
    best := 1;
  end if;

  return case best when 4 then 'manage' when 3 then 'drive'
                   when 2 then 'converse' when 1 then 'watch' else null end;
end
$$;

create or replace function internal.require_session_capability(
  p_session_id uuid, p_level text
) returns void language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_identity();
  if internal.session_level_rank(coalesce(internal.session_capability(p_session_id), ''))
     < internal.session_level_rank(p_level) then
    -- One message for every refusal. A caller learns what was required, never
    -- which arm declined — matching consume_stream_attach's discipline.
    raise exception 'session capability required: %', p_level using errcode = '42501';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Reads. Modelled on `notifications_select` (023) — the most viewer-precise
--    policy in the schema: you see grants you issued, and grants naming you.
-- -----------------------------------------------------------------------------
alter table public.session_delegations enable row level security;
create policy session_delegations_select on public.session_delegations for select to tm8_app
  using (
    subject_identity_id = internal.identity_id()
    or exists (select 1 from public.members m
                where m.entity_id = session_delegations.grantor_member_id
                  and m.identity_id = internal.identity_id())
    or (subject_team_member_id is not null
        and internal.can_act_as(subject_team_member_id, grantor_space_id))
  );
grant select on public.session_delegations to tm8_app;
grant execute on function internal.session_capability(uuid) to tm8_app;
grant execute on function internal.session_level_rank(text) to tm8_app;

reset role;
