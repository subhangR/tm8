-- 310 — Multiple workspaces per (space, identity): data layer (design doc
-- 01a11593 §7, API doc 01a115c4 §2.1; build decisions 01a115d7, D and Q7/Q9/Q10).
--
-- * Every workspace gets its own id (the new primary key), a name, a colour
--   token, a list position, who created it, and the timestamps the activity
--   dot needs (last_active_at, last_agent_change_at/last_agent_actor_id).
-- * workspace_active is the ONE active pointer per (space, identity). Its
--   composite FK means it can only point at a workspace of the same space and
--   identity. list_revision orders the workspace-list frames.
-- * Drafts belong to a workspace (PK (workspace_id, draft_id)) and go with it
--   on delete. They keep space_id/identity_id for RLS, and the composite FK
--   keeps those equal to their workspace's.
-- * Backfill: every existing row becomes "Main" and its owner's active one;
--   every draft gets its row's workspace_id.
--
-- Still private by construction (305): identity-equality RLS, no capture
-- trigger on any of the three tables, SELECT-only for tm8_app, writes through
-- SECURITY DEFINER functions.
--
-- The colour list and the cap of 20 are HARD-CODED here and in
-- packages/contract/src/workspace-bridge.ts (WORKSPACE_COLORS,
-- WORKSPACES_PER_IDENTITY_CAP). stored.pg.test.ts fails if they drift apart.

-- 1. The old drafts FK hangs off the old primary key: drop it first.
alter table public.workspace_drafts drop constraint workspace_drafts_space_id_identity_id_fkey;

-- 2. Workspaces get an id, a name and the API §2.1 columns.
alter table public.workspaces
  add column workspace_id         uuid        not null default gen_random_uuid(),
  add column name                 text        not null default 'Main',
  add column color                text,
  add column position             int         not null default 0,
  add column created_by_actor_id  uuid,
  add column created_by_class     text,
  add column last_active_at       timestamptz,
  add column last_agent_change_at timestamptz,
  add column last_agent_actor_id  uuid,
  add constraint workspaces_name_check check (char_length(name) between 1 and 64 and name = btrim(name)),
  add constraint workspaces_color_token check (
    color is null or color in ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink')
  ),
  add constraint workspaces_position_check check (position >= 0),
  add constraint workspaces_created_by_class_check check (created_by_class is null or created_by_class in ('human', 'agent'));

alter table public.workspaces drop constraint workspaces_pkey;
alter table public.workspaces add primary key (workspace_id);
-- The target of the composite FKs below: a pointer or a draft can only name a
-- workspace of its own (space, identity).
alter table public.workspaces add constraint workspaces_owner_key unique (workspace_id, space_id, identity_id);
create unique index workspaces_owner_name on public.workspaces (space_id, identity_id, lower(name));
create index workspaces_owner on public.workspaces (space_id, identity_id, position);

-- Backfilled rows were the active (and only) workspace until now.
update public.workspaces set last_active_at = updated_at;

-- 3. The active pointer, one per (space, identity), backfilled.
create table public.workspace_active (
  space_id      uuid        not null references public.spaces(id) on delete cascade,
  identity_id   text        not null,
  workspace_id  uuid        not null,
  switched_at   timestamptz not null default now(),
  list_revision bigint      not null default 1 check (list_revision >= 1),
  primary key (space_id, identity_id),
  -- CASCADE, not RESTRICT: workspaces also cascade from their member entity,
  -- and a restricting pointer would block that delete. The writers move the
  -- pointer before deleting the active workspace; a row set with no pointer
  -- reads its first workspace as active and repairs the pointer on the next
  -- write (workspace_save).
  foreign key (workspace_id, space_id, identity_id)
    references public.workspaces (workspace_id, space_id, identity_id) on delete cascade
);
create index workspace_active_workspace on public.workspace_active (workspace_id);

insert into public.workspace_active (space_id, identity_id, workspace_id)
select space_id, identity_id, workspace_id from public.workspaces;

-- 4. Drafts re-key onto their workspace.
alter table public.workspace_drafts add column workspace_id uuid;
update public.workspace_drafts d
   set workspace_id = w.workspace_id
  from public.workspaces w
 where w.space_id = d.space_id and w.identity_id = d.identity_id;
-- 305's FK made an orphan impossible, so this deletes nothing; it is here so
-- the NOT NULL below can never fail half way through a deploy.
delete from public.workspace_drafts where workspace_id is null;
alter table public.workspace_drafts alter column workspace_id set not null;
alter table public.workspace_drafts drop constraint workspace_drafts_pkey;
alter table public.workspace_drafts add primary key (workspace_id, draft_id);
alter table public.workspace_drafts
  add constraint workspace_drafts_workspace_fkey foreign key (workspace_id, space_id, identity_id)
    references public.workspaces (workspace_id, space_id, identity_id) on delete cascade;

-- 5. At most 20 workspaces per (space, identity). The writers check first and
-- answer with a reason; this is the backstop. The advisory lock makes two
-- concurrent creates count one after the other.
create or replace function internal.workspaces_enforce_cap() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('workspaces:' || new.space_id::text || ':' || new.identity_id, 0));
  if (select count(*) from public.workspaces where space_id = new.space_id and identity_id = new.identity_id) >= 20 then
    raise exception 'too many workspaces in this space' using errcode = '53400';
  end if;
  return new;
end;
$$;
create trigger workspaces_enforce_cap before insert on public.workspaces
for each row execute function internal.workspaces_enforce_cap();

-- 6. RLS: the pointer is as private as the rows it points at.
alter table public.workspace_active enable row level security;
create policy workspace_active_select on public.workspace_active for select to tm8_app
  using (identity_id = (select internal.identity_id())
         and space_id = any ((select internal.member_space_ids())::uuid[]));
grant select on public.workspace_active to tm8_app;

-- 7. The writers, keyed by workspace_id. The 305 signatures go: a call keyed
-- by (space, identity) has no meaning once an identity has several rows.
drop function public.workspace_save(uuid, bigint, bigint, jsonb);
drop function public.workspace_draft_save(uuid, uuid, text, bigint, jsonb);

-- Write one of the caller's workspaces, compare-and-swap on revision: the row
-- must be at p_expected and moves to p_next (> p_expected). Returns the
-- workspace id. 40001 on a stale revision, 54000 when too big.
--
-- p_workspace_id null with p_expected 0 is the FIRST write of an identity
-- with no workspace in the space (S12): it creates "Main" and the active
-- pointer to it in this one transaction. If the identity already has a
-- workspace, the caller's view is stale: 40001.
--
-- p_agent_actor_id marks an agent's commit for the activity dot (API §2.1);
-- null for a human's.
create or replace function public.workspace_save(
  p_space_id uuid, p_workspace_id uuid, p_expected bigint, p_next bigint, p_state jsonb,
  p_agent_actor_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  me_member uuid;
  saved uuid;
begin
  perform internal.require_space_member(p_space_id);
  me_member := internal.current_member_id(p_space_id);
  if me_identity is null or me_member is null then
    raise exception 'not a member of this space' using errcode = '42501';
  end if;
  if octet_length(p_state::text) > 131072 then
    raise exception 'workspace state is too large' using errcode = '54000';
  end if;
  if p_next <= p_expected then
    raise exception 'the next revision must move forward' using errcode = '22023';
  end if;
  if p_workspace_id is null then
    if p_expected <> 0 then
      raise exception 'a workspace id is required to update' using errcode = '22023';
    end if;
    if exists (select 1 from public.workspaces where space_id = p_space_id and identity_id = me_identity) then
      raise exception 'workspace revision is stale' using errcode = '40001';
    end if;
    insert into public.workspaces(
      space_id, identity_id, member_id, state, revision, name, position,
      created_by_actor_id, created_by_class, last_active_at, last_agent_change_at, last_agent_actor_id
    )
    values (
      p_space_id, me_identity, me_member, p_state, p_next, 'Main', 0,
      coalesce(p_agent_actor_id, internal.actor_id()),
      case when p_agent_actor_id is null then 'human' else 'agent' end,
      now(),
      case when p_agent_actor_id is null then null else now() end,
      p_agent_actor_id
    )
    on conflict (space_id, identity_id, lower(name)) do nothing
    returning workspace_id into saved;
    if saved is null then
      raise exception 'workspace revision is stale' using errcode = '40001';
    end if;
    insert into public.workspace_active(space_id, identity_id, workspace_id)
    values (p_space_id, me_identity, saved);
    return saved;
  end if;

  update public.workspaces
     set state = p_state, revision = p_next, member_id = me_member, updated_at = now(),
         last_agent_change_at = case when p_agent_actor_id is null then last_agent_change_at else now() end,
         last_agent_actor_id = coalesce(p_agent_actor_id, last_agent_actor_id)
   where workspace_id = p_workspace_id and space_id = p_space_id and identity_id = me_identity
     and revision = p_expected
  returning workspace_id into saved;
  if saved is null then
    raise exception 'workspace revision is stale' using errcode = '40001';
  end if;
  -- Repair a lost pointer (see workspace_active): the written workspace becomes active.
  insert into public.workspace_active(space_id, identity_id, workspace_id)
  values (p_space_id, me_identity, saved)
  on conflict (space_id, identity_id) do nothing;
  return saved;
end;
$$;

-- Write (or delete, when p_fields is null) a draft in one of the caller's
-- workspaces, compare-and-swap on the draft's own revision (0 = create).
-- Returns the new revision (0 after a delete). P0002 when the workspace is
-- not the caller's (or does not exist); at most 30 drafts per workspace.
create or replace function public.workspace_draft_save(
  p_workspace_id uuid, p_draft_id uuid, p_kind text, p_expected bigint, p_fields jsonb
)
returns bigint language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  ws_space uuid;
  next_revision bigint;
begin
  if me_identity is null then
    raise exception 'not a member of this space' using errcode = '42501';
  end if;
  select space_id into ws_space from public.workspaces
   where workspace_id = p_workspace_id and identity_id = me_identity;
  if ws_space is null then
    raise exception 'no such workspace' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(ws_space);
  if p_fields is null then
    delete from public.workspace_drafts where workspace_id = p_workspace_id and draft_id = p_draft_id;
    return 0;
  end if;
  if octet_length(p_fields::text) > 32768 then
    raise exception 'draft is too large' using errcode = '54000';
  end if;
  if p_expected = 0 then
    if (select count(*) from public.workspace_drafts where workspace_id = p_workspace_id) >= 30 then
      raise exception 'too many drafts in this workspace' using errcode = '53400';
    end if;
    insert into public.workspace_drafts(workspace_id, space_id, identity_id, draft_id, kind, fields, revision)
    values (p_workspace_id, ws_space, me_identity, p_draft_id, p_kind, p_fields, 1)
    on conflict (workspace_id, draft_id) do nothing
    returning revision into next_revision;
  else
    update public.workspace_drafts
       set fields = p_fields, revision = revision + 1, updated_at = now()
     where workspace_id = p_workspace_id and draft_id = p_draft_id and revision = p_expected
    returning revision into next_revision;
  end if;
  if next_revision is null then
    raise exception 'draft revision is stale' using errcode = '40001';
  end if;
  return next_revision;
end;
$$;

revoke all on function public.workspace_save(uuid, uuid, bigint, bigint, jsonb, uuid) from public;
revoke all on function public.workspace_draft_save(uuid, uuid, text, bigint, jsonb) from public;
grant execute on function public.workspace_save(uuid, uuid, bigint, bigint, jsonb, uuid) to tm8_app;
grant execute on function public.workspace_draft_save(uuid, uuid, text, bigint, jsonb) to tm8_app;

-- A new table is analyzed at birth (never-analyzed-tables.pg.test.ts); the
-- re-keyed ones too, so their new indexes plan on real numbers.
analyze public.workspaces, public.workspace_drafts, public.workspace_active;
