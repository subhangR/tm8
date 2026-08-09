-- 089 — the Git view takes a rail row under Tracking (Git UI wave, 2026-08-09).
--
-- The wave shipped a project git screen (topology, worktree lanes, contention)
-- behind the widened `MenuViewRef` 'git', and the client's SHIPPED_DEFAULT_MENU
-- (revision 7) leads the Tracking group with it. But real spaces do not render
-- the client fallback: they render the server-seeded row that
-- `internal.w1_default_menu_payload()` produced, and that payload knows
-- nothing about 'git'. Without this migration the screen is reachable only on
-- fixtures — the exact unreachable-finished-screen shape 045 fixed for Graph,
-- so this follows 045's steps precisely: widen the registry's closed ref
-- constraint, register the implemented view, redefine the default payload,
-- then upgrade byte-equivalent legacy defaults only.
--
-- The row leads Tracking because the screen is the group's summary: projects,
-- pull requests and worktrees are the KINDS, and the git view is where their
-- interplay (lanes, overlap, contention) is actually visible.

set role tm8_graph_owner;

-- The validator introduced by 029 accepts a view only when both its closed
-- ref constraint and registry row know about it (045's wording — same move).
alter table public.menu_view_registry
  drop constraint menu_view_registry_ref_check;

alter table public.menu_view_registry
  add constraint menu_view_registry_ref_check check (
    ref in ('dashboard','feed','inbox','workspace','graph','channels','settings','git')
    or ref ~ '^v:[a-z0-9][a-z0-9_-]{0,48}$'
  );

insert into public.menu_view_registry(
  ref, route_template, menu_eligible, required, implemented
)
values ('git', '#/s/{s}/git', true, false, true)
on conflict (ref) do update
set route_template = excluded.route_template,
    menu_eligible = excluded.menu_eligible,
    required = excluded.required,
    implemented = excluded.implemented;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"home","label":"Home","items":[{"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"channel"},
        {"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"}]},
      {"type":"view","ref":"graph"}]},
    {"id":"tracking","label":"Tracking","items":[
      {"type":"view","ref":"git"},
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"},
      {"type":"kind","ref":"worktree"}]},
    {"id":"collab","label":"Collab","items":[{"type":"kind","ref":"member"}]},
    {"id":"voice","label":"Voice","items":[]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb
$$;

do $$
declare
  -- The 071 payload VERBATIM — the only un-customized current default once the
  -- chain has run in order. A space whose menu was hand-edited does not match
  -- and keeps its own arrangement; the git view remains offerable to it
  -- through the menu editor's freed view refs.
  payload_071 constant jsonb := '{"groups":[
    {"id":"home","label":"Home","items":[{"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"channel"},
        {"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"}]},
      {"type":"view","ref":"graph"}]},
    {"id":"tracking","label":"Tracking","items":[
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"},
      {"type":"kind","ref":"worktree"}]},
    {"id":"collab","label":"Collab","items":[{"type":"kind","ref":"member"}]},
    {"id":"voice","label":"Voice","items":[]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_071;
end
$$;

reset role;
