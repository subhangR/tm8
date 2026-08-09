-- 096 — persist the Files explorer row in default Space menus.
--
-- The client shipped-default menu reached revision 8 with a new `files` VIEW
-- row, but migration 094 remained the last writer of
-- `internal.w1_default_menu_payload()` and still emitted only the three
-- Library KIND rows. On reload the client briefly rendered its fallback,
-- then replaced it with that persisted older menu, making File browser appear
-- and disappear. Keep both twins aligned and upgrade only untouched defaults;
-- an authored menu remains the owner's menu.

set role tm8_graph_owner;

-- Saved menus cross the database validator on every write. The contract and
-- client learned this ref in the Files wave, but the server-owned registry is
-- the validator's authority and must be widened before the backfill below.
alter table public.menu_view_registry
  drop constraint menu_view_registry_ref_check;

alter table public.menu_view_registry
  add constraint menu_view_registry_ref_check check (
    ref in ('dashboard','feed','inbox','workspace','graph','channels','files','settings')
    or ref ~ '^v:[a-z0-9][a-z0-9_-]{0,48}$'
  );

insert into public.menu_view_registry(
  ref, route_template, menu_eligible, required, implemented
)
values ('files', '#/s/{s}/files', true, false, true)
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
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"},
        {"type":"kind","ref":"loop"}]},
      {"type":"view","ref":"graph"}]},
    {"id":"library","label":"Library","items":[
      {"type":"view","ref":"files"},
      {"type":"kind","ref":"file"},{"type":"kind","ref":"spell"},
      {"type":"kind","ref":"collection"}]},
    {"id":"tracking","label":"Tracking","items":[
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"},
      {"type":"kind","ref":"worktree"}]},
    {"id":"collab","label":"Collab","items":[{"type":"kind","ref":"member"}]},
    {"id":"voice","label":"Voice","items":[]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb
$$;

do $$
declare
  -- The 094 payload verbatim. jsonb equality upgrades only untouched defaults;
  -- formatting is irrelevant, while any authored menu change blocks the match.
  payload_094 constant jsonb := '{"groups":[
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
      {"type":"kind","ref":"file"},{"type":"kind","ref":"spell"},
      {"type":"kind","ref":"collection"}]},
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
     and payload = payload_094;
end
$$;

reset role;
