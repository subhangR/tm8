-- =============================================================================
-- 279 — cross-space references (lane L3 of task 01a0fb5b; owner decisions D3,
-- D7 in form 01a0fb65).
--
-- D3 keeps the invariant that an EDGE never crosses spaces (001's trigger,
-- 129's write_edge). What an entity in home space A may hold instead is a
-- REFERENCE: a row in A that names an entity in target space B by
-- {target space, entity id, kind, title snapshot}. It is not an edge: nothing
-- in B is written, no FK reaches B, and B's entity can be deleted, renamed or
-- become unreadable without touching A.
--
--   * cross_space_refs: the rows. No tm8_app privilege and no policy: every
--     read and write is an RPC below (260's cross_space_audit precedent).
--   * add_cross_space_ref: D7 — refused unless the CALLER holds a signed_in
--     row on a link from A to the reference's target space. The server checks
--     that B's entity is readable THROUGH that link (entities.get via
--     spaceLinks.invoke, audited in A) before calling this, and passes the
--     snapshot it read. Re-adding the same target refreshes the snapshot.
--   * list_cross_space_refs: an A reader's view. `live` is set only when the
--     VIEWER can read B's entity directly (internal.entity_readable: a member
--     of B, inside the viewer's session pin); otherwise the snapshot stands.
--   * remove_cross_space_ref: any member who can read the A entity, as with
--     an edge in A.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The table.
-- -----------------------------------------------------------------------------

create table public.cross_space_refs (
  id                uuid primary key default internal.new_id(),
  space_id          uuid not null references public.spaces(id) on delete cascade,
  entity_id         uuid not null references public.entities(id) on delete cascade,
  -- The link it was made through. A removed link keeps the reference (snapshot).
  link_id           uuid references public.space_links(entity_id) on delete set null,
  -- No FK: B is another space, and with a remote link (W8) another server.
  target_space_id   uuid not null,
  target_server_id  uuid,
  target_entity_id  uuid not null,
  target_kind       text not null check (char_length(target_kind) between 1 and 100),
  title_snapshot    text not null check (char_length(title_snapshot) between 1 and 500),
  created_by        uuid not null,
  created_by_actor  uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (target_space_id <> space_id),
  unique (entity_id, target_space_id, target_entity_id)
);

create index cross_space_refs_space_idx on public.cross_space_refs(space_id);
create index cross_space_refs_target_idx on public.cross_space_refs(target_space_id, target_entity_id);

alter table public.cross_space_refs enable row level security;

comment on table public.cross_space_refs is
  'L3 (279): an entity in this space pointing at an entity in another space, made through a signed-in space link. Not an edge (D3).';

-- -----------------------------------------------------------------------------
-- 2. One row's JSON, with the viewer's live resolution.
-- -----------------------------------------------------------------------------

create or replace function internal.cross_space_ref_json(p_row public.cross_space_refs)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  live jsonb := null;
  e public.entities;
begin
  if p_row.target_server_id is null and internal.entity_readable(p_row.target_entity_id) then
    select * into e from public.entities where id = p_row.target_entity_id;
    if e.id is not null and e.space_id = p_row.target_space_id then
      live := jsonb_build_object(
        'kind', e.kind,
        'title', left(internal.entity_display_title(internal.entity_content(e.id)), 500),
        'updatedAt', e.updated_at);
    end if;
  end if;
  return jsonb_build_object(
    'id', p_row.id,
    'spaceId', p_row.space_id,
    'entityId', p_row.entity_id,
    'linkId', p_row.link_id,
    'targetSpaceId', p_row.target_space_id,
    'targetServerId', p_row.target_server_id,
    'targetEntityId', p_row.target_entity_id,
    'kind', p_row.target_kind,
    'titleSnapshot', p_row.title_snapshot,
    'live', live,
    'createdBy', p_row.created_by,
    'createdAt', p_row.created_at,
    'updatedAt', p_row.updated_at);
end
$$;

-- -----------------------------------------------------------------------------
-- 3. Add (or refresh the snapshot of) a reference. D7: an active link only.
-- -----------------------------------------------------------------------------

create or replace function public.add_cross_space_ref(
  p_entity_id uuid,
  p_link_id uuid,
  p_target_entity_id uuid,
  p_target_kind text,
  p_title text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  me uuid;
  tok public.space_link_tokens;
  server_id uuid;
  row public.cross_space_refs;
begin
  if coalesce(internal.claim_text('tm8.auth_kind'), '') not in ('browser', 'cli', 'agent') then
    raise exception 'this session kind cannot use a space link' using errcode = '42501';
  end if;
  if internal.claim_text('tm8.via_link') is not null then
    raise exception 'a session minted under a space link cannot use a space link' using errcode = '42501';
  end if;
  select * into e from public.entities where id = p_entity_id and deleted_at is null;
  if e.id is null or not internal.entity_readable(p_entity_id) then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;
  me := internal.current_member_id(e.space_id);
  if me is null then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;
  -- D7: the caller's OWN row on a link out of A, signed in. Owning or
  -- belonging to both spaces is not an authority on its own.
  select t.* into tok from public.space_link_tokens t
   where t.link_id = p_link_id and t.member_id = me and t.home_space_id = e.space_id;
  if tok.id is null then
    raise exception 'no space link from this entity''s space for your member' using errcode = '42501',
      detail = jsonb_build_object('reason', 'cross_space_ref_no_link')::text;
  end if;
  if tok.status <> 'signed_in' then
    raise exception 'space link is %: ask your human to sign in to the link again', tok.status
      using errcode = '42501',
      detail = jsonb_build_object('reason', 'cross_space_ref_link_inactive', 'status', tok.status)::text;
  end if;
  if tok.target_space_id = e.space_id then
    raise exception 'a reference must point into another space; use an edge' using errcode = '22023';
  end if;
  if p_target_entity_id is null or p_target_kind is null or btrim(p_target_kind) = '' then
    raise exception 'target entity and kind are required' using errcode = '22023';
  end if;
  select l.target_server_id into server_id from public.space_links l where l.entity_id = p_link_id;

  insert into public.cross_space_refs as r (
    space_id, entity_id, link_id, target_space_id, target_server_id, target_entity_id,
    target_kind, title_snapshot, created_by, created_by_actor)
  values (
    e.space_id, e.id, p_link_id, tok.target_space_id, server_id, p_target_entity_id,
    left(btrim(p_target_kind), 100), left(coalesce(nullif(btrim(p_title), ''), 'Untitled'), 500),
    me, nullif(internal.claim_text('tm8.actor_id'), '')::uuid)
  on conflict (entity_id, target_space_id, target_entity_id) do update
    set link_id = excluded.link_id,
        target_server_id = excluded.target_server_id,
        target_kind = excluded.target_kind,
        title_snapshot = excluded.title_snapshot,
        updated_at = now()
  returning r.* into row;
  return internal.cross_space_ref_json(row);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. List an entity's references (any reader of the entity).
-- -----------------------------------------------------------------------------

create or replace function public.list_cross_space_refs(p_entity_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  if not internal.entity_readable(p_entity_id) then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;
  return coalesce((
    select jsonb_agg(internal.cross_space_ref_json(r) order by r.created_at, r.id)
      from public.cross_space_refs r
     where r.entity_id = p_entity_id), '[]'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Remove one (any reader of the entity who is a member of its space).
-- -----------------------------------------------------------------------------

create or replace function public.remove_cross_space_ref(p_entity_id uuid, p_ref_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  row public.cross_space_refs;
begin
  if not internal.entity_readable(p_entity_id) then
    raise exception 'entity not found' using errcode = 'P0002';
  end if;
  delete from public.cross_space_refs r
   where r.id = p_ref_id and r.entity_id = p_entity_id
     and internal.current_member_id(r.space_id) is not null
  returning r.* into row;
  if row.id is null then
    raise exception 'reference not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', row.id, 'entityId', row.entity_id, 'removed', true);
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants — full signatures.
-- -----------------------------------------------------------------------------
revoke all on public.cross_space_refs from public, tm8_app;

revoke all on function internal.cross_space_ref_json(public.cross_space_refs) from public;
revoke all on function public.add_cross_space_ref(uuid, uuid, uuid, text, text) from public;
grant execute on function public.add_cross_space_ref(uuid, uuid, uuid, text, text) to tm8_app;
revoke all on function public.list_cross_space_refs(uuid) from public;
grant execute on function public.list_cross_space_refs(uuid) to tm8_app;
revoke all on function public.remove_cross_space_ref(uuid, uuid) from public;
grant execute on function public.remove_cross_space_ref(uuid, uuid) to tm8_app;

reset role;

analyze public.cross_space_refs;
