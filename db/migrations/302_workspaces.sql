-- 302 — Server-side Workspaces (Spec D, doc 01a11171-3aba; task 01a11117-3526).
--
-- One Workspace per (space, IDENTITY): a person and the agents whose token
-- resolves to them share it (Spec C §3). Draft values live in their own table
-- so typing never bumps the workspace revision.
--
-- PRIVATE BY CONSTRUCTION
-- * RLS: a row is visible only to its own identity, and only while that
--   identity is a member of the space. There is no admin arm and no
--   share mode: another member's tab list and draft text are never readable.
-- * NO capture trigger on either table: nothing here ever enters
--   space_event_seq, events.poll, events.changes or the space fan-out. The node
--   pushes changes to the owner's own sockets only.
-- * tm8_app gets SELECT; writes are the two compare-and-swap RPCs below (the
--   008 rule: no INSERT/UPDATE/DELETE grants).
--
-- The state is the runtime's shared WorkspaceState (content-free refs: kinds
-- and ids, never titles or bodies), bounded at 128 KB; a draft at 32 KB, 30 per
-- workspace.

create table public.workspaces (
  space_id     uuid        not null references public.spaces(id) on delete cascade,
  identity_id  text        not null,
  member_id    uuid        not null references public.entities(id) on delete cascade,
  state        jsonb       not null,
  revision     bigint      not null check (revision >= 1),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (space_id, identity_id),
  constraint workspaces_state_bounded check (octet_length(state::text) <= 131072)
);

create table public.workspace_drafts (
  space_id     uuid        not null,
  identity_id  text        not null,
  draft_id     uuid        not null,
  kind         text        not null check (char_length(kind) between 1 and 64),
  fields       jsonb       not null default '{}'::jsonb,
  revision     bigint      not null check (revision >= 1),
  updated_at   timestamptz not null default now(),
  primary key (space_id, identity_id, draft_id),
  foreign key (space_id, identity_id) references public.workspaces(space_id, identity_id) on delete cascade,
  constraint workspace_drafts_bounded check (octet_length(fields::text) <= 32768)
);

alter table public.workspaces enable row level security;
alter table public.workspace_drafts enable row level security;

create policy workspaces_select on public.workspaces for select to tm8_app
  using (identity_id = (select internal.identity_id())
         and space_id = any ((select internal.member_space_ids())::uuid[]));

create policy workspace_drafts_select on public.workspace_drafts for select to tm8_app
  using (identity_id = (select internal.identity_id())
         and space_id = any ((select internal.member_space_ids())::uuid[]));

grant select on public.workspaces, public.workspace_drafts to tm8_app;

-- Write the caller's workspace state, compare-and-swap on revision: the row
-- must be at p_expected (0 = no row yet) and moves to p_next (> p_expected;
-- one apply can commit twice, a resolution and its replay). Returns p_next.
-- 40001 on a stale revision, 54000 when too big.
create or replace function public.workspace_save(p_space_id uuid, p_expected bigint, p_next bigint, p_state jsonb)
returns bigint language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  me_member uuid;
  next_revision bigint;
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
    insert into public.workspaces(space_id, identity_id, member_id, state, revision)
    values (p_space_id, me_identity, me_member, p_state, p_next)
    on conflict (space_id, identity_id) do nothing
    returning revision into next_revision;
  else
    update public.workspaces
       set state = p_state, revision = p_next, member_id = me_member, updated_at = now()
     where space_id = p_space_id and identity_id = me_identity and revision = p_expected
    returning revision into next_revision;
  end if;
  if next_revision is null then
    raise exception 'workspace revision is stale' using errcode = '40001';
  end if;
  return next_revision;
end;
$$;

-- Write (or delete, when p_fields is null) one of the caller's drafts,
-- compare-and-swap on the draft's own revision (0 = create). Returns the new
-- revision (0 after a delete).
create or replace function public.workspace_draft_save(
  p_space_id uuid, p_draft_id uuid, p_kind text, p_expected bigint, p_fields jsonb
)
returns bigint language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me_identity text := internal.identity_id();
  next_revision bigint;
begin
  perform internal.require_space_member(p_space_id);
  if me_identity is null then
    raise exception 'not a member of this space' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspaces where space_id = p_space_id and identity_id = me_identity) then
    raise exception 'no workspace yet' using errcode = 'P0002';
  end if;
  if p_fields is null then
    delete from public.workspace_drafts
     where space_id = p_space_id and identity_id = me_identity and draft_id = p_draft_id;
    return 0;
  end if;
  if octet_length(p_fields::text) > 32768 then
    raise exception 'draft is too large' using errcode = '54000';
  end if;
  if p_expected = 0 then
    if (select count(*) from public.workspace_drafts where space_id = p_space_id and identity_id = me_identity) >= 30 then
      raise exception 'too many drafts in this workspace' using errcode = '53400';
    end if;
    insert into public.workspace_drafts(space_id, identity_id, draft_id, kind, fields, revision)
    values (p_space_id, me_identity, p_draft_id, p_kind, p_fields, 1)
    on conflict (space_id, identity_id, draft_id) do nothing
    returning revision into next_revision;
  else
    update public.workspace_drafts
       set fields = p_fields, revision = revision + 1, updated_at = now()
     where space_id = p_space_id and identity_id = me_identity and draft_id = p_draft_id and revision = p_expected
    returning revision into next_revision;
  end if;
  if next_revision is null then
    raise exception 'draft revision is stale' using errcode = '40001';
  end if;
  return next_revision;
end;
$$;

revoke all on function public.workspace_save(uuid, bigint, bigint, jsonb) from public;
revoke all on function public.workspace_draft_save(uuid, uuid, text, bigint, jsonb) from public;
grant execute on function public.workspace_save(uuid, bigint, bigint, jsonb) to tm8_app;
grant execute on function public.workspace_draft_save(uuid, uuid, text, bigint, jsonb) to tm8_app;
