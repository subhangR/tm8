-- 315 — Craft workspaces: one hidden workspace per (space, identity, craft)
-- (Craft redesign doc 01a1255d §3 "Persistence", §4; contract
-- packages/contract/src/craft-workspace.ts).
--
-- * A workspace row may be SCOPED to a craft entity (`scope_kind`,
--   `scope_entity_id`). A scoped row holds the person's open tabs on that
--   craft; at most one per (space, identity, craft).
-- * Scoped rows are not Home workspaces: every 311/312 writer and the cap of
--   20 now consider unscoped rows only, the name-uniqueness index is partial,
--   and a scoped row can never be the active Home workspace or take drafts.
-- * The same rows are the person's open-crafts list: `open` says the craft is
--   in the Craft top bar, `position` orders it (among scoped rows).
-- * `about` may now be sourced by a work session, so "+ New session" on a
--   craft can record session -[about]-> craft — the edge that lets that
--   session's agent command its starter's craft workspace (§4).
--
-- Writes stay SECURITY DEFINER, identity-checked, tm8_app SELECT-only.
-- `craft` and its old name `design` are both accepted as the scope entity
-- kind until the design→craft rename (L1) lands.

alter table public.workspaces
  add column scope_kind      text,
  add column scope_entity_id uuid references public.entities(id) on delete cascade,
  add column open            boolean not null default false,
  add constraint workspaces_scope_kind_check check (scope_kind is null or scope_kind = 'craft'),
  add constraint workspaces_scope_pair check ((scope_kind is null) = (scope_entity_id is null)),
  add constraint workspaces_open_scoped check (not open or scope_entity_id is not null);

drop index public.workspaces_owner_name;
create unique index workspaces_owner_name on public.workspaces (space_id, identity_id, lower(name))
  where scope_entity_id is null;
create unique index workspaces_owner_scope on public.workspaces (space_id, identity_id, scope_entity_id)
  where scope_entity_id is not null;
create index workspaces_scope_entity on public.workspaces (scope_entity_id) where scope_entity_id is not null;

-- -----------------------------------------------------------------------------
-- 1. The Home writers and the cap, unscoped rows only (bodies as 311/312
--    otherwise).
-- -----------------------------------------------------------------------------
create or replace function internal.workspaces_enforce_cap() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.scope_entity_id is not null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('workspaces:' || new.space_id::text || ':' || new.identity_id, 0));
  if (select count(*) from public.workspaces where space_id = new.space_id and identity_id = new.identity_id and scope_entity_id is null) >= 20 then
    raise exception 'too many workspaces in this space' using errcode = '53400';
  end if;
  return new;
end;
$$;

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
    if exists (select 1 from public.workspaces where space_id = p_space_id and identity_id = me_identity and scope_entity_id is null) then
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
    on conflict (space_id, identity_id, lower(name)) where scope_entity_id is null do nothing
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
   where workspace_id = p_workspace_id and space_id = p_space_id and identity_id = me_identity and scope_entity_id is null
     and revision = p_expected
  returning workspace_id into saved;
  if saved is null then
    raise exception 'workspace revision is stale' using errcode = '40001';
  end if;
  -- Repair a lost pointer (see workspace_active) in this transaction. It goes
  -- to the workspace reads already treat as active: the first in list order.
  insert into public.workspace_active(space_id, identity_id, workspace_id)
  select p_space_id, me_identity, w.workspace_id from public.workspaces w
   where w.space_id = p_space_id and w.identity_id = me_identity and w.scope_entity_id is null
   order by w.position, w.created_at, w.workspace_id
   limit 1
  on conflict (space_id, identity_id) do nothing;
  return saved;
end;
$$;

create or replace function public.workspace_draft_write(
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
  -- The lookup itself honours the pinned space (is_space_member, 227): a
  -- workspace of the caller's in any other space answers exactly like one
  -- that does not exist, so a pinned session learns nothing about it.
  select space_id into ws_space from public.workspaces
   where workspace_id = p_workspace_id and identity_id = me_identity and scope_entity_id is null
     and internal.is_space_member(space_id);
  if ws_space is null then
    raise exception 'no such workspace' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(ws_space);
  -- Any write repairs a lost pointer, as workspace_save does.
  insert into public.workspace_active(space_id, identity_id, workspace_id)
  select ws_space, me_identity, w.workspace_id from public.workspaces w
   where w.space_id = ws_space and w.identity_id = me_identity and w.scope_entity_id is null
   order by w.position, w.created_at, w.workspace_id
   limit 1
  on conflict (space_id, identity_id) do nothing;
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

create or replace function internal.workspaces_place(p_space_id uuid, p_identity text, p_moving uuid, p_before uuid)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
declare
  ids uuid[];
  i int;
begin
  select coalesce(array_agg(workspace_id order by position, created_at, workspace_id), '{}') into ids
    from public.workspaces
   where space_id = p_space_id and identity_id = p_identity and scope_entity_id is null and workspace_id is distinct from p_moving;
  if p_moving is not null then
    i := case when p_before is null then null else array_position(ids, p_before) end;
    if i is null then
      ids := ids || p_moving;
    else
      ids := ids[1:i - 1] || p_moving || ids[i:];
    end if;
  end if;
  update public.workspaces w set position = o.ord - 1
    from unnest(ids) with ordinality as o(id, ord)
   where w.workspace_id = o.id and w.position <> o.ord - 1;
end;
$$;

create or replace function internal.workspaces_list_bump(p_space_id uuid, p_identity text)
returns bigint language plpgsql set search_path = public, internal, pg_temp as $$
declare
  next_revision bigint;
begin
  insert into public.workspace_active(space_id, identity_id, workspace_id)
  select p_space_id, p_identity, w.workspace_id from public.workspaces w
   where w.space_id = p_space_id and w.identity_id = p_identity and w.scope_entity_id is null
   order by w.position, w.created_at, w.workspace_id
   limit 1
  on conflict (space_id, identity_id) do nothing;
  update public.workspace_active set list_revision = list_revision + 1
   where space_id = p_space_id and identity_id = p_identity
  returning list_revision into next_revision;
  return next_revision;
end;
$$;

create or replace function internal.workspace_owned(p_workspace_id uuid)
returns uuid language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  ws_space uuid;
begin
  select space_id into ws_space from public.workspaces
   where workspace_id = p_workspace_id and identity_id = internal.identity_id() and scope_entity_id is null
     and internal.is_space_member(space_id);
  if ws_space is null then
    raise exception 'no such workspace' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(ws_space);
  return ws_space;
end;
$$;

create or replace function public.workspace_create(
  p_space_id uuid, p_name text, p_color text, p_before uuid, p_state jsonb, p_agent boolean
)
returns uuid language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  me_member uuid;
  chosen text := p_name;
  n int := 2;
  created uuid;
begin
  perform internal.require_space_member(p_space_id);
  me_member := internal.current_member_id(p_space_id);
  if me_identity is null or me_member is null then
    raise exception 'not a member of this space' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspaces where space_id = p_space_id and identity_id = me_identity and scope_entity_id is null) then
    raise exception 'create the first workspace with workspace_save' using errcode = '55000';
  end if;
  if p_before is not null and not exists (
    select 1 from public.workspaces where workspace_id = p_before and space_id = p_space_id and identity_id = me_identity and scope_entity_id is null
  ) then
    raise exception 'no such workspace' using errcode = 'P0002';
  end if;
  if octet_length(p_state::text) > 131072 then
    raise exception 'workspace state is too large' using errcode = '54000';
  end if;
  if chosen is null then
    while exists (
      select 1 from public.workspaces
       where space_id = p_space_id and identity_id = me_identity and scope_entity_id is null and lower(name) = lower('Workspace ' || n)
    ) loop
      n := n + 1;
    end loop;
    chosen := 'Workspace ' || n;
  end if;
  perform internal.workspace_name_ok(chosen);
  insert into public.workspaces(
    space_id, identity_id, member_id, state, revision, name, color, position,
    created_by_actor_id, created_by_class, last_agent_change_at, last_agent_actor_id
  )
  values (
    p_space_id, me_identity, me_member, p_state, 1, chosen, p_color, 2147483647,
    internal.actor_id(),
    case when p_agent then 'agent' else 'human' end,
    case when p_agent then now() end,
    case when p_agent then internal.actor_id() end
  )
  returning workspace_id into created;
  perform internal.workspaces_place(p_space_id, me_identity, created, p_before);
  perform internal.workspaces_list_bump(p_space_id, me_identity);
  return created;
end;
$$;

create or replace function public.workspace_reorder(p_workspace_id uuid, p_before uuid)
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  ws_space uuid := internal.workspace_owned(p_workspace_id);
  before_order uuid[];
  after_order uuid[];
begin
  if p_before is not null and not exists (
    select 1 from public.workspaces where workspace_id = p_before and space_id = ws_space and identity_id = me_identity and scope_entity_id is null
  ) then
    raise exception 'no such workspace' using errcode = 'P0002';
  end if;
  select array_agg(workspace_id order by position, created_at, workspace_id) into before_order
    from public.workspaces where space_id = ws_space and identity_id = me_identity and scope_entity_id is null;
  if p_before = p_workspace_id then
    return false;
  end if;
  perform internal.workspaces_place(ws_space, me_identity, p_workspace_id, p_before);
  select array_agg(workspace_id order by position, created_at, workspace_id) into after_order
    from public.workspaces where space_id = ws_space and identity_id = me_identity and scope_entity_id is null;
  if after_order = before_order then
    return false;
  end if;
  perform internal.workspaces_list_bump(ws_space, me_identity);
  return true;
end;
$$;

create or replace function public.workspace_switch(p_workspace_id uuid)
returns uuid language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  ws_space uuid := internal.workspace_owned(p_workspace_id);
  previous uuid;
begin
  select workspace_id into previous from public.workspace_active
   where space_id = ws_space and identity_id = me_identity;
  if previous is null then
    -- A lost pointer reads as the first workspace (311).
    select workspace_id into previous from public.workspaces
     where space_id = ws_space and identity_id = me_identity and scope_entity_id is null
     order by position, created_at, workspace_id
     limit 1;
  end if;
  if previous = p_workspace_id then
    return previous;
  end if;
  perform internal.workspaces_list_bump(ws_space, me_identity);
  update public.workspace_active set workspace_id = p_workspace_id, switched_at = now()
   where space_id = ws_space and identity_id = me_identity;
  update public.workspaces set last_active_at = now()
   where workspace_id in (previous, p_workspace_id);
  return previous;
end;
$$;

create or replace function public.workspace_delete(p_workspace_id uuid)
returns uuid language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  ws_space uuid := internal.workspace_owned(p_workspace_id);
  ids uuid[];
  i int;
  active uuid;
  successor uuid;
begin
  select array_agg(workspace_id order by position, created_at, workspace_id) into ids
    from public.workspaces where space_id = ws_space and identity_id = me_identity and scope_entity_id is null;
  if cardinality(ids) <= 1 then
    raise exception 'last workspace' using errcode = '55000';
  end if;
  perform internal.workspaces_list_bump(ws_space, me_identity);
  select workspace_id into active from public.workspace_active
   where space_id = ws_space and identity_id = me_identity;
  if active = p_workspace_id then
    i := array_position(ids, p_workspace_id);
    successor := coalesce(ids[i + 1], ids[i - 1]);
    update public.workspace_active set workspace_id = successor, switched_at = now()
     where space_id = ws_space and identity_id = me_identity;
    update public.workspaces set last_active_at = now()
     where workspace_id in (p_workspace_id, successor);
    active := successor;
  end if;
  delete from public.workspaces where workspace_id = p_workspace_id;
  if not exists (select 1 from public.workspace_active where space_id = ws_space and identity_id = me_identity) then
    raise exception 'deleting a workspace lost the active pointer' using errcode = 'XX000';
  end if;
  perform internal.workspaces_place(ws_space, me_identity, null, null);
  return active;
end;
$$;

create or replace function public.workspace_save(p_space_id uuid, p_expected bigint, p_next bigint, p_state jsonb)
returns bigint language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  ids uuid[];
begin
  -- Membership (pinned, 227) before any read, as 305 did: the count below
  -- must not answer for a space outside the pin.
  perform internal.require_space_member(p_space_id);
  select coalesce(array_agg(workspace_id), '{}') into ids from public.workspaces
   where space_id = p_space_id and identity_id = me_identity and scope_entity_id is null;
  if cardinality(ids) >= 2 then
    raise exception 'multiple workspaces: roll forward' using errcode = '55000';
  end if;
  if cardinality(ids) = 0 then
    -- 305 updated nothing for a missing row: the same stale answer.
    if p_expected <> 0 then
      raise exception 'workspace revision is stale' using errcode = '40001';
    end if;
    perform public.workspace_save(p_space_id, null::uuid, p_expected, p_next, p_state);
    return p_next;
  end if;
  -- 305 inserted at p_expected 0, and a row already exists: stale.
  if p_expected = 0 then
    raise exception 'workspace revision is stale' using errcode = '40001';
  end if;
  perform public.workspace_save(p_space_id, ids[1], p_expected, p_next, p_state);
  return p_next;
end;
$$;

create or replace function public.workspace_draft_save(
  p_space_id uuid, p_draft_id uuid, p_kind text, p_expected bigint, p_fields jsonb
)
returns bigint language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  ids uuid[];
begin
  perform internal.require_space_member(p_space_id);
  if me_identity is null then
    raise exception 'not a member of this space' using errcode = '42501';
  end if;
  select coalesce(array_agg(workspace_id), '{}') into ids from public.workspaces
   where space_id = p_space_id and identity_id = me_identity and scope_entity_id is null;
  if cardinality(ids) >= 2 then
    raise exception 'multiple workspaces: roll forward' using errcode = '55000';
  end if;
  if cardinality(ids) = 0 then
    raise exception 'no workspace yet' using errcode = 'P0002';
  end if;
  return public.workspace_draft_write(ids[1], p_draft_id, p_kind, p_expected, p_fields);
end;
$$;

-- workspace_update finds its row through workspace_owned (unscoped above), so
-- it cannot rename a craft workspace; it needs no new body.

-- -----------------------------------------------------------------------------
-- 2. Craft workspace writers.
-- -----------------------------------------------------------------------------

-- The caller's craft workspace for p_craft_id: created at p_expected = 0
-- (closed, last in the list), compare-and-swap updated otherwise.
-- An agent's write (p_agent, or an actor id) stamps last_agent_change_*.
-- 40001 stale, P0002 no such craft, 54000 too large, 22023 bad revisions.
create or replace function public.craft_workspace_save(
  p_space_id uuid, p_craft_id uuid, p_expected bigint, p_next bigint, p_state jsonb,
  p_agent_actor_id uuid default null, p_agent boolean default false
)
returns uuid language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  me_member uuid;
  saved uuid;
  by_agent boolean := coalesce(p_agent, false) or p_agent_actor_id is not null;
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
  if p_expected = 0 then
    if not exists (
      select 1 from public.entities e
       where e.id = p_craft_id and e.space_id = p_space_id and e.kind in ('craft', 'design') and e.deleted_at is null
    ) then
      raise exception 'no such craft' using errcode = 'P0002';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('craft-workspaces:' || p_space_id::text || ':' || me_identity, 0));
    insert into public.workspaces(
      space_id, identity_id, member_id, state, revision, name, position, scope_kind, scope_entity_id, open,
      created_by_actor_id, created_by_class, last_active_at, last_agent_change_at, last_agent_actor_id
    )
    values (
      p_space_id, me_identity, me_member, p_state, p_next, 'Craft',
      coalesce((select max(w.position) + 1 from public.workspaces w
                 where w.space_id = p_space_id and w.identity_id = me_identity and w.scope_entity_id is not null), 0),
      'craft', p_craft_id, false,
      coalesce(p_agent_actor_id, internal.actor_id()),
      case when by_agent then 'agent' else 'human' end,
      now(),
      case when by_agent then now() end,
      p_agent_actor_id
    )
    on conflict (space_id, identity_id, scope_entity_id) where scope_entity_id is not null do nothing
    returning workspace_id into saved;
  else
    update public.workspaces
       set state = p_state, revision = p_next, member_id = me_member, updated_at = now(), last_active_at = now(),
           last_agent_change_at = case when by_agent then now() else last_agent_change_at end,
           last_agent_actor_id = coalesce(p_agent_actor_id, last_agent_actor_id)
     where space_id = p_space_id and identity_id = me_identity and scope_entity_id = p_craft_id
       and revision = p_expected
    returning workspace_id into saved;
  end if;
  if saved is null then
    raise exception 'workspace revision is stale' using errcode = '40001';
  end if;
  return saved;
end;
$$;

-- Lay out the caller's craft list in a space: p_order (craft ids) first, in
-- that order, then any other craft workspaces in their current order; `open`
-- is exactly the craft ids in p_open. Every id must name one of the caller's
-- craft workspaces in the space (P0002). 53400 past 30 open. Returns whether
-- anything changed.
create or replace function public.craft_workspaces_arrange(p_space_id uuid, p_order uuid[], p_open uuid[])
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  ids uuid[];
  changed int;
begin
  perform internal.require_space_member(p_space_id);
  if me_identity is null then
    raise exception 'not a member of this space' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('craft-workspaces:' || p_space_id::text || ':' || me_identity, 0));
  select coalesce(array_agg(scope_entity_id order by position, created_at, workspace_id), '{}') into ids
    from public.workspaces
   where space_id = p_space_id and identity_id = me_identity and scope_entity_id is not null;
  if exists (select 1 from unnest(coalesce(p_order, '{}') || coalesce(p_open, '{}')) x(id) where not (x.id = any(ids))) then
    raise exception 'no such craft workspace' using errcode = 'P0002';
  end if;
  if (select count(distinct x) from unnest(coalesce(p_open, '{}')) x) > 30 then
    raise exception 'too many open crafts' using errcode = '53400';
  end if;
  ids := array(
    select x.id from unnest(coalesce(p_order, '{}')) with ordinality x(id, ord)
     group by x.id order by min(x.ord)
  ) || array(
    select w.scope_entity_id from public.workspaces w
     where w.space_id = p_space_id and w.identity_id = me_identity and w.scope_entity_id is not null
       and not (w.scope_entity_id = any(coalesce(p_order, '{}')))
     order by w.position, w.created_at, w.workspace_id
  );
  update public.workspaces w
     set position = o.ord - 1, open = (w.scope_entity_id = any(coalesce(p_open, '{}')))
    from unnest(ids) with ordinality as o(id, ord)
   where w.space_id = p_space_id and w.identity_id = me_identity and w.scope_entity_id = o.id
     and (w.position <> o.ord - 1 or w.open <> (w.scope_entity_id = any(coalesce(p_open, '{}'))));
  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

revoke all on function public.craft_workspace_save(uuid, uuid, bigint, bigint, jsonb, uuid, boolean) from public;
revoke all on function public.craft_workspaces_arrange(uuid, uuid[], uuid[]) from public;
grant execute on function public.craft_workspace_save(uuid, uuid, bigint, bigint, jsonb, uuid, boolean) to tm8_app;
grant execute on function public.craft_workspaces_arrange(uuid, uuid[], uuid[]) to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. A work session may say what it is about (append, idempotent; 304).
-- -----------------------------------------------------------------------------
update public.edge_types
   set src_kinds = array_append(src_kinds, 'work_session')
 where type = 'about'
   and not ('work_session' = any(src_kinds));

analyze public.workspaces;
