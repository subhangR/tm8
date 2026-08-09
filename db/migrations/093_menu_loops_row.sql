-- 093 — Loops take the eighth and final Workspace caret slot.
--
-- The `loop` core kind shipped in 091 with a collection route and registry
-- row, but neither twin of the default Space menu names it. A finished feature
-- that has no default-menu row is unreachable unless a viewer already knows
-- to customize the menu. Put it beside the other Workspace collections.
--
-- The frozen menu contract caps caret children at 8. The 088 default has 7;
-- this migration deliberately fills, but does not widen, that cap.
--
-- Saved-menu compatibility follows the earlier default migrations: update
-- only a schema-v1 row that is structurally equal to the 088 default. jsonb
-- equality ignores formatting but not authored changes, so a customized menu
-- and its revision remain untouched.

set role tm8_graph_owner;

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
  -- The 088 payload verbatim. It is the only untouched default after the
  -- ordered chain has run; any authored difference prevents this match.
  payload_088 constant jsonb := '{"groups":[
    {"id":"home","label":"Home","items":[{"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"channel"},
        {"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"}]},
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
     and payload = payload_088;
end
$$;

reset role;
