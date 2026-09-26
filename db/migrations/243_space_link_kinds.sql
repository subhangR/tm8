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

-- 218's shape, not `internal.entity_readable(entity_id)`: an exists over
-- `entities_select`, so membership resolves once per statement; `offset 0`
-- keeps it a per-row pkey probe (218 §4).
create policy space_links_select on public.space_links for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = space_links.entity_id and readable_entity.deleted_at is null offset 0)));

grant select on public.space_links to tm8_app;

comment on table public.space_links is
  'W6 (243): the shared space_link entity''s detail row. Holds no secret: the '
  'per-member sealed token is public.space_link_tokens (244).';


-- -----------------------------------------------------------------------------
-- 4. Content hydration. SHARED OBJECT: body copied from 209 verbatim; the
--    `space_link` arm is the only addition. `server` gets no arm: it has no
--    detail table in W6 and resolves to '{}' through `else` (W8 adds its row),
--    recorded in entity-content-all-kinds' NO_CONTENT_ARM.
-- -----------------------------------------------------------------------------
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then return null; end if;
  if e.kind like 'c:%' then
    select jsonb_build_object('title', c.title, 'fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case e.kind
      when 'task' then select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'voice_channel' then select to_jsonb(v) - 'entity_id' into content from public.voice_channels v where v.entity_id = target;
      when 'artifact' then select to_jsonb(a) - 'entity_id' into content from public.artifacts a where a.entity_id = target;
      when 'memory' then select to_jsonb(m) - 'entity_id' into content from public.memories m where m.entity_id = target;
      when 'worktree' then select to_jsonb(w) - 'entity_id' into content from public.worktrees w where w.entity_id = target;
      when 'loop' then select to_jsonb(l) - 'entity_id' into content from public.loops l where l.entity_id = target;
      when 'graph' then select to_jsonb(g) - 'entity_id' into content from public.graphs g where g.entity_id = target;
      when 'chat' then select to_jsonb(c) - 'entity_id' - 'cwd' - 'native_session_id' - 'client_mutation_id'
                       into content from public.chats c where c.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      when 'container' then select to_jsonb(c) - 'entity_id' - 'runtime_ref' - 'host_spec'
                              into content from public.containers c where c.entity_id = target;
      when 'drawing' then select to_jsonb(d) - 'entity_id' into content from public.drawings d where d.entity_id = target;
      -- `-` binds tighter than `||`: the entity_id is dropped, THEN the
      -- ordered sections and questions are merged in.
      when 'form' then select to_jsonb(fm) - 'entity_id'
                              || jsonb_build_object('sections', internal.form_sections_json(target),
                                                    'questions', internal.form_questions_json(target))
                         into content from public.forms fm where fm.entity_id = target;
      -- 243 (W6): the shared link's metadata. `space_links` holds no secret; the
      -- sealed per-member token is `space_link_tokens` (244) and has no arm.
      when 'space_link' then select to_jsonb(sl) - 'entity_id' into content from public.space_links sl where sl.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

reset role;

-- Never-analyzed tables are estimated at 10 pages (225); 229's precedent.
analyze public.space_links;
