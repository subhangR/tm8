-- 311 — Workspace management writers (API doc 01a115c4 §5.7–§5.11; build
-- decisions 01a115d7, advisor #4).
--
-- create / update (rename, recolour) / reorder / delete / switch, one
-- SECURITY DEFINER function each, over the tables migration 310 made. The
-- node calls them inside its (space, identity) write lock (D4) and checks the
-- caller-facing refusals (name taken, cap, last workspace, unsaved drafts)
-- first, so it can answer with a reason. The checks here are the backstop.
--
-- * Positions stay dense (0..n-1), in list order (position, created_at,
--   workspace_id), after every writer.
-- * Every list change bumps workspace_active.list_revision once.
-- * Delete moves the active pointer FIRST (next in list order, else the
--   previous) in the same transaction, and raises if the pointer would be
--   lost (advisor #4 (1a)).
-- * Agents never switch and never delete in this release; that rule lives in
--   the node (D6), which decides by auth kind. These functions only record
--   who created a workspace.

-- Rewrite positions densely in list order; p_moving (if any) goes right before
-- p_before, or last when p_before is null.
create or replace function internal.workspaces_place(p_space_id uuid, p_identity text, p_moving uuid, p_before uuid)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
declare
  ids uuid[];
  i int;
begin
  select coalesce(array_agg(workspace_id order by position, created_at, workspace_id), '{}') into ids
    from public.workspaces
   where space_id = p_space_id and identity_id = p_identity and workspace_id is distinct from p_moving;
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

-- The pointer (healed to the first workspace if it was lost) gets the next
-- list revision. Returns it.
create or replace function internal.workspaces_list_bump(p_space_id uuid, p_identity text)
returns bigint language plpgsql set search_path = public, internal, pg_temp as $$
declare
  next_revision bigint;
begin
  insert into public.workspace_active(space_id, identity_id, workspace_id)
  select p_space_id, p_identity, w.workspace_id from public.workspaces w
   where w.space_id = p_space_id and w.identity_id = p_identity
   order by w.position, w.created_at, w.workspace_id
   limit 1
  on conflict (space_id, identity_id) do nothing;
  update public.workspace_active set list_revision = list_revision + 1
   where space_id = p_space_id and identity_id = p_identity
  returning list_revision into next_revision;
  return next_revision;
end;
$$;

-- The caller's workspace p_workspace_id in its space, or P0002.
create or replace function internal.workspace_owned(p_workspace_id uuid)
returns uuid language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  ws_space uuid;
begin
  select space_id into ws_space from public.workspaces
   where workspace_id = p_workspace_id and identity_id = internal.identity_id();
  if ws_space is null then
    raise exception 'no such workspace' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(ws_space);
  return ws_space;
end;
$$;

create or replace function internal.workspace_name_ok(p_name text)
returns void language plpgsql immutable as $$
begin
  if p_name is null or p_name <> btrim(p_name) or char_length(p_name) not between 1 and 64 or p_name ~ '[[:cntrl:]]' then
    raise exception 'invalid workspace name' using errcode = '22023';
  end if;
end;
$$;

-- Create a workspace, never active. The identity must already have one (the
-- node materialises "Main" first, S12, in the same transaction); a null name
-- is "Workspace N", the lowest N >= 2 not taken. p_agent marks an agent's
-- create (who: internal.actor_id(), the teammate). Returns the new id.
-- 23505 name taken, 53400 at the cap (trigger), P0002 bad p_before.
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
  if not exists (select 1 from public.workspaces where space_id = p_space_id and identity_id = me_identity) then
    raise exception 'create the first workspace with workspace_save' using errcode = '55000';
  end if;
  if p_before is not null and not exists (
    select 1 from public.workspaces where workspace_id = p_before and space_id = p_space_id and identity_id = me_identity
  ) then
    raise exception 'no such workspace' using errcode = 'P0002';
  end if;
  if octet_length(p_state::text) > 131072 then
    raise exception 'workspace state is too large' using errcode = '54000';
  end if;
  if chosen is null then
    while exists (
      select 1 from public.workspaces
       where space_id = p_space_id and identity_id = me_identity and lower(name) = lower('Workspace ' || n)
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

-- Rename and/or recolour. A null p_name keeps the name; p_set_color false
-- keeps the colour. Returns whether anything changed (only then the list
-- revision moves). 23505 name taken.
create or replace function public.workspace_update(p_workspace_id uuid, p_name text, p_set_color boolean, p_color text)
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  ws_space uuid := internal.workspace_owned(p_workspace_id);
  changed boolean;
begin
  if p_name is not null then
    perform internal.workspace_name_ok(p_name);
  end if;
  update public.workspaces
     set name = coalesce(p_name, name),
         color = case when p_set_color then p_color else color end
   where workspace_id = p_workspace_id
     and (name is distinct from coalesce(p_name, name) or (p_set_color and color is distinct from p_color));
  changed := found;
  if changed then
    perform internal.workspaces_list_bump(ws_space, me_identity);
  end if;
  return changed;
end;
$$;

-- Move a workspace right before p_before (null = last). Returns whether the
-- order changed.
create or replace function public.workspace_reorder(p_workspace_id uuid, p_before uuid)
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  ws_space uuid := internal.workspace_owned(p_workspace_id);
  before_order uuid[];
  after_order uuid[];
begin
  if p_before is not null and not exists (
    select 1 from public.workspaces where workspace_id = p_before and space_id = ws_space and identity_id = me_identity
  ) then
    raise exception 'no such workspace' using errcode = 'P0002';
  end if;
  select array_agg(workspace_id order by position, created_at, workspace_id) into before_order
    from public.workspaces where space_id = ws_space and identity_id = me_identity;
  if p_before = p_workspace_id then
    return false;
  end if;
  perform internal.workspaces_place(ws_space, me_identity, p_workspace_id, p_before);
  select array_agg(workspace_id order by position, created_at, workspace_id) into after_order
    from public.workspaces where space_id = ws_space and identity_id = me_identity;
  if after_order = before_order then
    return false;
  end if;
  perform internal.workspaces_list_bump(ws_space, me_identity);
  return true;
end;
$$;

-- Make a workspace the active one. Returns the previously active id (equal to
-- p_workspace_id when nothing changed). last_active_at moves on both.
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
    -- A lost pointer reads as the first workspace (310).
    select workspace_id into previous from public.workspaces
     where space_id = ws_space and identity_id = me_identity
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

-- Delete a workspace and (by cascade) its drafts. If it is the active one,
-- the pointer moves FIRST to the next workspace in list order, else the
-- previous. Returns the active id after. 55000 for the last workspace.
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
    from public.workspaces where space_id = ws_space and identity_id = me_identity;
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

revoke all on function public.workspace_create(uuid, text, text, uuid, jsonb, boolean) from public;
revoke all on function public.workspace_update(uuid, text, boolean, text) from public;
revoke all on function public.workspace_reorder(uuid, uuid) from public;
revoke all on function public.workspace_switch(uuid) from public;
revoke all on function public.workspace_delete(uuid) from public;
grant execute on function public.workspace_create(uuid, text, text, uuid, jsonb, boolean) to tm8_app;
grant execute on function public.workspace_update(uuid, text, boolean, text) to tm8_app;
grant execute on function public.workspace_reorder(uuid, uuid) to tm8_app;
grant execute on function public.workspace_switch(uuid) to tm8_app;
grant execute on function public.workspace_delete(uuid) to tm8_app;
