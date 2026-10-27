-- =============================================================================
-- 282  FILESYSTEM PATH GRANTS: A NODE ADMIN LETS ONE MEMBER BROWSE ONE ROOT.
--
-- Lane L1 of the space-scoped projects design (doc 01a0fb62, §4; task
-- 01a0fb65-58d0). The owner's words: "in the server gate the member gets the
-- roles and permissions of what filesystem paths he can access".
--
-- TODAY. Browsing node directories (`projects.directories.list`) is node-admin
-- only, because the browse scope is TM8_PROJECT_ROOTS (default `/`) and a
-- denylist over the whole filesystem fails open. There is no unit smaller than
-- "node admin" to hand out, so on a server node an ordinary member can never
-- pick a folder at all.
--
-- THE UNIT. A grant is node-level and addressed to ONE ACCOUNT (Q2 on owner
-- form 01a0fb63, recommended answer; a space-addressed grant can be added later
-- as a second nullable target without changing what a member reads). It names a
-- canonical root; `mode = 'select'` means the member may browse that subtree and
-- select a folder in it. No file is read through a grant: files are only ever
-- read through a project checkout. A `read` mode is deliberately absent.
--
-- WHAT THE DATABASE DOES NOT DO. Canonicalization. The facade realpaths the
-- root and requires it inside the canonical TM8_PROJECT_ROOTS before it calls
-- create_path_grant, and re-canonicalizes every requested path before the
-- containment check on every browse — a symlink under a granted root that
-- escapes it is refused there. The check constraint below only refuses shapes
-- no realpath ever returns (relative, `..` segments).
--
-- NODE ADMINS have an implicit grant of every root; nothing is stored for them.
--
-- WHO. Writes and the full list are gate admin (require_gate_admin: a node
-- admin on an UNPINNED session, so a space-pinned session never administers
-- grants). A member reads only their own live grants (my_path_grants, and the
-- RLS policy below). Revoking stamps revoked_at; nothing is deleted, so the
-- audit trail says who could browse what and when.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create table public.path_grants (
  id          uuid primary key default internal.new_id(),
  account_id  uuid not null references public.accounts(id) on delete cascade,
  root_path   text not null,
  mode        text not null default 'select',
  granted_by  uuid references public.accounts(id) on delete set null,
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid references public.accounts(id) on delete set null,
  note        text,
  constraint path_grants_mode_check check (mode in ('select')),
  constraint path_grants_root_absolute check (
    root_path ~ '^(/|[A-Za-z]:[\\/])'
    and root_path !~ '(^|[\\/])\.\.([\\/]|$)'
    and char_length(root_path) <= 4096),
  constraint path_grants_note_length check (note is null or char_length(note) <= 500),
  constraint path_grants_revoked_shape check (revoked_at is not null or revoked_by is null),
  -- One row per (account, root), live or revoked: granting again re-opens it.
  constraint path_grants_account_root_key unique (account_id, root_path)
);

create index path_grants_live_account_idx on public.path_grants(account_id) where revoked_at is null;

alter table public.path_grants enable row level security;
-- A member sees their own grants; nothing else is readable through the table.
create policy path_grants_own_select on public.path_grants
  for select using (account_id = internal.current_account_id());
grant select (id, account_id, root_path, mode, granted_at, revoked_at, note)
  on public.path_grants to tm8_app;

-- -----------------------------------------------------------------------------
-- The row a caller sees. `grantee` is joined for the admin list only.
-- -----------------------------------------------------------------------------
create or replace function internal.path_grant_json(g public.path_grants, with_grantee boolean)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', g.id,
    'accountId', g.account_id,
    'rootPath', g.root_path,
    'mode', g.mode,
    'grantedAt', g.granted_at,
    'revokedAt', g.revoked_at,
    'note', g.note,
    'grantee', case when with_grantee then (
      select jsonb_build_object('accountId', a.id, 'username', a.username,
                                'displayName', a.display_name, 'status', a.status)
        from public.accounts a where a.id = g.account_id) end,
    'grantedBy', case when with_grantee then (
      select jsonb_build_object('accountId', a.id, 'username', a.username)
        from public.accounts a where a.id = g.granted_by) end
  ))
$$;
revoke all on function internal.path_grant_json(public.path_grants, boolean) from public;

-- -----------------------------------------------------------------------------
-- create_path_grant — gate admin. Idempotent per (account, root): an existing
-- row, live or revoked, is re-opened with the new note and stamp.
-- -----------------------------------------------------------------------------
create or replace function public.create_path_grant(p_account_id uuid, p_root_path text, p_note text)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.path_grants; grantor uuid;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_gate_admin();
  if not exists (select 1 from public.accounts a where a.id = p_account_id and a.status = 'active') then
    raise exception 'no active account %', p_account_id using errcode = 'P0002';
  end if;
  grantor := internal.current_account_id();
  insert into public.path_grants(account_id, root_path, note, granted_by)
  values (p_account_id, p_root_path, nullif(btrim(p_note), ''), grantor)
  on conflict (account_id, root_path) do update
     set note = excluded.note,
         granted_by = excluded.granted_by,
         granted_at = now(),
         revoked_at = null,
         revoked_by = null
  returning * into stored;
  return internal.path_grant_json(stored, true);
end
$$;

-- -----------------------------------------------------------------------------
-- revoke_path_grant — gate admin. Revoking a revoked grant is a no-op that
-- returns the row as it stands.
-- -----------------------------------------------------------------------------
create or replace function public.revoke_path_grant(p_grant_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stored public.path_grants;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_gate_admin();
  update public.path_grants
     set revoked_at = now(), revoked_by = internal.current_account_id()
   where id = p_grant_id and revoked_at is null
  returning * into stored;
  if stored.id is null then
    select * into stored from public.path_grants where id = p_grant_id;
    if stored.id is null then
      raise exception 'no path grant %', p_grant_id using errcode = 'P0002';
    end if;
  end if;
  return internal.path_grant_json(stored, true);
end
$$;

-- -----------------------------------------------------------------------------
-- list_path_grants — gate admin. Every grant on the node, newest first; revoked
-- ones only when asked.
-- -----------------------------------------------------------------------------
create or replace function public.list_path_grants(p_include_revoked boolean)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_gate_admin();
  return coalesce((
    select jsonb_agg(internal.path_grant_json(g, true) order by g.granted_at desc, g.id)
      from public.path_grants g
     where coalesce(p_include_revoked, false) or g.revoked_at is null
  ), '[]'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- my_path_grants — any active account: its own live grants, by root. What the
-- facade scopes `projects.directories.list` to for a caller who is not a node
-- admin, and what the Create Project page reads to enable "Folder on this node".
-- -----------------------------------------------------------------------------
create or replace function public.my_path_grants()
returns jsonb
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select coalesce((
    select jsonb_agg(internal.path_grant_json(g, false) order by g.root_path)
      from public.path_grants g
     where g.account_id = internal.current_account_id()
       and g.revoked_at is null
  ), '[]'::jsonb)
$$;

-- -----------------------------------------------------------------------------
-- list_node_accounts — gate admin. Who a grant can be addressed to: every
-- account on the node, which no other operation lists (a member list is per
-- space, and a node admin may grant to an account in none of theirs).
-- -----------------------------------------------------------------------------
create or replace function public.list_node_accounts()
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_gate_admin();
  return coalesce((
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'accountId', a.id, 'username', a.username, 'displayName', a.display_name,
             'status', a.status, 'isNodeAdmin', (a.is_node_admin or a.is_owner)))
           order by a.username)
      from public.accounts a
  ), '[]'::jsonb);
end
$$;

revoke all on function public.create_path_grant(uuid, text, text) from public;
revoke all on function public.revoke_path_grant(uuid) from public;
revoke all on function public.list_path_grants(boolean) from public;
revoke all on function public.my_path_grants() from public;
revoke all on function public.list_node_accounts() from public;
grant execute on function public.create_path_grant(uuid, text, text) to tm8_app;
grant execute on function public.revoke_path_grant(uuid) to tm8_app;
grant execute on function public.list_path_grants(boolean) to tm8_app;
grant execute on function public.my_path_grants() to tm8_app;
grant execute on function public.list_node_accounts() to tm8_app;

comment on table public.path_grants is
  'Node-level, per-account permission to browse and select under a filesystem root (282). '
  'Paths are canonicalized by the facade before they reach this table.';

-- Never-analyzed tables are estimated at 10 pages (225); 229's precedent.
analyze public.path_grants;

reset role;
