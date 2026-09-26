-- =============================================================================
-- 243 — space links, part 1: the kinds, auth kind `link`, the space_links table
-- (plan 01a0d9eb §3 W6; phases doc 01a0d9fb §3 W6; decisions 31, 33, 38).
--
-- Ordinal 243 was reserved for W6 by the Phase 1b coordinator. 244 is the
-- second half (space_link_tokens and the spaceLinks.* RPCs).
--
-- WHAT THIS FILE DOES
--
--   1. Registers the `space_link` and `server` core kinds (001:284's registry).
--      `server` is W8's; it is registered here so W8 takes no kind ordinal.
--   2. `auth_sessions.kind` learns `link`: a stored session a member of home
--      space A holds for target space B. It is pinned (226's
--      `auth_sessions_pinned_kinds_have_space` already names it), and it never
--      carries a persona, work session or runtime binding: in B it IS the member.
--   3. `public.space_links`: the one shared entity per (home space, target).
--
-- THE GATE IS NOT TOUCHED (deputy ruling, 2026-09-26 02:04Z, interim until the
-- lead rules). `internal.require_human_auth_kind()` (083) stays strict: it
-- admits browser and cli only, so it refuses `link`. Every credential RPC
-- calls it (083, 093, 203, 206), so kind `link` is refused IN SQL on every
-- current and future credential op with no edit (E2, T20b), fail-closed. The
-- spaceLinks.* writes (244) call it too: a link session never manages link
-- tokens (decision 31's refused set). What decision 31 admits for `link`
-- (invites, roles, delete) never called the gate, so it passes as the member
-- with no change here. `space-links.pg.test.ts` pins every caller of the gate
-- against an explicit, labelled list.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Kinds. APPEND, never a full-array rewrite (052's lesson).
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('space_link', 'core', null, 'link'),
  ('server',     'core', null, 'server')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. auth_sessions.kind = 'link'.
-- -----------------------------------------------------------------------------
alter table public.auth_sessions
  drop constraint if exists auth_sessions_kind_check;
alter table public.auth_sessions
  add constraint auth_sessions_kind_check
  check (kind in ('browser', 'cli', 'agent', 'agent_runtime', 'link'));

-- A link session is the member, and nothing narrower: no persona, no work
-- session, no chat runtime. 226's check already requires its space_id.
alter table public.auth_sessions
  add constraint auth_sessions_link_shape check (
    kind <> 'link'
    or (acting_as_team_member_id is null
        and work_session_id is null
        and runtime_member_id is null
        and runtime_thread_root_id is null
        and runtime_chat_id is null)
  );

-- -----------------------------------------------------------------------------
-- 3. space_links — one shared entity per (home space, target).
--
-- The entity lives in the home space (K9: the member's personal space when
-- they have one, else the shared home; there is no personal space on this
-- base, so it is always the home). Every member of the home space can SEE that
-- the link exists (P8); only a member's own token row is theirs (244).
-- target_server_id null = this server; W8 points it at a `server` entity.
-- -----------------------------------------------------------------------------
create table public.space_links (
  entity_id        uuid primary key references public.entities(id) on delete cascade,
  home_space_id    uuid not null references public.spaces(id) on delete cascade,
  target_space_id  uuid not null,
  target_server_id uuid references public.entities(id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index space_links_one_per_target
  on public.space_links(home_space_id, target_space_id,
                        coalesce(target_server_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index space_links_target_idx on public.space_links(target_space_id);

alter table public.space_links enable row level security;

create policy space_links_select on public.space_links for select to tm8_app
  using (internal.entity_readable(entity_id));

grant select on public.space_links to tm8_app;

comment on table public.space_links is
  'W6 (243): the shared space_link entity''s detail row. Holds no secret: the '
  'per-member sealed token is public.space_link_tokens (244).';

reset role;
