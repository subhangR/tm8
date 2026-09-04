-- 130 — the Board tab: the task kanban as its own top-level tab (Board tab
-- wave, task 01a0074b, 2026-08-16). Server twin of tm8-ui
-- SHIPPED_DEFAULT_MENU revision 16 (shared truth: the contract's
-- DEFAULT_MENU_GROUP_SPINE, which gains {serverId:'board', clientId:'board'};
-- menu-seeder-parity.pg.test.ts pins this file's payload against it).
--
-- NUMBERED 130: this lane's chain holds up to 128, origin/main up to 124, and
-- 129 is RESERVED by the assigned-by provenance lane working the same task
-- family (message on task 01a00753-f724 assigns the numbers) — a stale "next
-- number" silently loses, so the union plus the reservation is the measure.
--
-- WHAT CHANGED, in one line: a BOARD group joins beside Work —
--   chats | work | board | graph | channels | files | settings
--
-- `board` is a VIEW, not a kind move: the tab is a full-screen kanban
-- PRESENTATION of the task collection (switchable grouping, priority and
-- assignee filters), while the `task` kind row stays in the Workspace caret —
-- the same two-doors posture R9 set for files. The group owns exactly one
-- childless view item, so tm8-ui's `isRaillessGroup` answers true and the
-- screen renders full-bleed ('board' joined RAILLESS_VIEW_REFS in the same
-- change): the board's own columns are the navigation, and a rail beside them
-- could only repeat the tab's name.
--
-- Follows the 045/096/102/117 four-step pattern for a NEW view ref: widen the
-- registry's closed ref constraint, register the implemented view, redefine
-- the default payload, then upgrade byte-equivalent legacy DEFAULTS only.
-- Drafted against the CURRENT chain head (128): the constraint keeps every
-- widening that landed since 117 (none) and the payload carries 125-128's tab
-- shell and Collab label — re-authoring from an older migration would
-- silently revoke refs that already shipped.
--
-- Caps hold: 7 groups (<=8), <=12 items per group, <=8 children, depth <=1,
-- global ref uniqueness ('board' appears nowhere else), settings present.

set role tm8_graph_owner;

-- The validator introduced by 029 accepts a view only when both its closed
-- ref constraint and registry row know about it (045's wording — same move).
alter table public.menu_view_registry
  drop constraint menu_view_registry_ref_check;

alter table public.menu_view_registry
  add constraint menu_view_registry_ref_check check (
    ref in ('dashboard','feed','inbox','workspace','graph','channels','files','settings','git','messages','board')
    or ref ~ '^v:[a-z0-9][a-z0-9_-]{0,48}$'
  );

insert into public.menu_view_registry(
  ref, route_template, menu_eligible, required, implemented
)
values ('board', '#/s/{s}/board', true, false, true)
on conflict (ref) do update
set route_template = excluded.route_template,
    menu_eligible = excluded.menu_eligible,
    required = excluded.required,
    implemented = excluded.implemented;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"chats","label":"Collab","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"},
        {"type":"kind","ref":"loop"},{"type":"kind","ref":"file"}]},
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"},
      {"type":"kind","ref":"worktree"},
      {"type":"view","ref":"git"}]},
    {"id":"board","label":"Board","items":[{"type":"view","ref":"board"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"channels","label":"Channels","items":[
      {"type":"kind","ref":"channel"},
      {"type":"view","ref":"messages"}]},
    {"id":"files","label":"Files","items":[{"type":"view","ref":"files"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb
$$;

do $$
declare
  -- The 128 payload VERBATIM — the only un-customized current default once
  -- the chain has run in order. Comparison is jsonb-structural, so the
  -- formatting here is free; what must match is the shape 128 seeded. A
  -- space whose menu was hand-edited does not match and keeps its own
  -- arrangement, the board view still offerable to it through the menu
  -- editor's freed view refs.
  payload_128 constant jsonb := '{"groups":[
    {"id":"chats","label":"Collab","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"},
        {"type":"kind","ref":"loop"},{"type":"kind","ref":"file"}]},
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"},
      {"type":"kind","ref":"worktree"},
      {"type":"view","ref":"git"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"channels","label":"Channels","items":[
      {"type":"kind","ref":"channel"},
      {"type":"view","ref":"messages"}]},
    {"id":"files","label":"Files","items":[{"type":"view","ref":"files"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_128;
end
$$;

reset role;
