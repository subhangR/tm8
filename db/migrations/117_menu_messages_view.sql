-- 117 — the Messages view takes the second Home row, and Inbox rejoins it
-- (Messages/Inbox landing, 2026-08-13).
--
-- NUMBERED 117 after 116 landed during this PR's green CI run. Migration
-- ordering is durable deployment history, so the branch takes the next number
-- above main rather than reusing the newly occupied slot.
--
-- The messages wave mounts a Messages screen behind the widened `MenuViewRef`
-- 'messages', and mounts the Inbox screen that has had a registry row since 029
-- but no rail row since revision 5 took it off. Both are reachable by URL the
-- moment the client ships. Neither is reachable by RAIL, because a real space
-- does not render the client's SHIPPED_DEFAULT_MENU — it renders the row
-- `internal.w1_default_menu_payload()` seeded into `space_menu_configs`, and
-- that payload knows nothing about either.
--
-- The failure this half prevents is the appear-then-disappear one: with only
-- the client constant edited, the rail shows Messages for exactly as long as a
-- space has no persisted menu, and the instant the seeder writes one — or on
-- any space that already has one, which is all of them — the row vanishes and
-- a finished screen becomes unreachable. That is the same shape 045 fixed for
-- Graph, 096 for Files and 102 for Git, so this follows the same four steps:
-- widen the registry's closed ref constraint, register the implemented view,
-- redefine the default payload, then upgrade byte-equivalent legacy defaults
-- only.
--
-- Drafted against the CURRENT chain head (108): the constraint and payload
-- below carry 094's 'loop' child, 096's 'files' view and 102's 'git' view — a
-- re-declared closed list must keep every widening that landed since the one it
-- was drafted against, and re-authoring from an older migration would silently
-- revoke refs that already shipped.
--
-- Only 'messages' widens the constraint. 'inbox' has been in the closed list
-- and in the registry since 029; it needs a payload row and nothing else.
--
-- The two rows lead Home rather than joining a group below it because Home is
-- where a person's own correspondence belongs: Dashboard is what the space is
-- doing, Messages is what is being said, Inbox is what is waiting on you.

set role tm8_graph_owner;

-- The validator introduced by 029 accepts a view only when both its closed
-- ref constraint and registry row know about it (045's wording — same move).
alter table public.menu_view_registry
  drop constraint menu_view_registry_ref_check;

alter table public.menu_view_registry
  add constraint menu_view_registry_ref_check check (
    ref in ('dashboard','feed','inbox','workspace','graph','channels','files','settings','git','messages')
    or ref ~ '^v:[a-z0-9][a-z0-9_-]{0,48}$'
  );

insert into public.menu_view_registry(
  ref, route_template, menu_eligible, required, implemented
)
values ('messages', '#/s/{s}/messages', true, false, true)
on conflict (ref) do update
set route_template = excluded.route_template,
    menu_eligible = excluded.menu_eligible,
    required = excluded.required,
    implemented = excluded.implemented;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"home","label":"Home","items":[
      {"type":"view","ref":"dashboard"},
      {"type":"view","ref":"messages"},
      {"type":"view","ref":"inbox"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"channel"},
        {"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"},
        {"type":"kind","ref":"loop"}]},
      {"type":"view","ref":"graph"}]},
    {"id":"library","label":"Library","items":[
      {"type":"view","ref":"files"},
      {"type":"kind","ref":"file"},{"type":"kind","ref":"spell"},
      {"type":"kind","ref":"collection"}]},
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
  -- The 102 payload VERBATIM — the only un-customized current default once the
  -- chain has run in order. A space whose menu was hand-edited does not match
  -- and keeps its own arrangement; the messages and inbox views remain
  -- offerable to it through the menu editor's freed view refs.
  payload_102 constant jsonb := '{"groups":[
    {"id":"home","label":"Home","items":[{"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"channel"},
        {"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"},
        {"type":"kind","ref":"loop"}]},
      {"type":"view","ref":"graph"}]},
    {"id":"library","label":"Library","items":[
      {"type":"view","ref":"files"},
      {"type":"kind","ref":"file"},{"type":"kind","ref":"spell"},
      {"type":"kind","ref":"collection"}]},
    {"id":"tracking","label":"Tracking","items":[
      {"type":"view","ref":"git"},
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
     and payload = payload_102;
end
$$;

reset role;
