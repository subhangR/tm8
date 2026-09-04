-- 164 — Help becomes the final shipped tab; Files and the legacy Board menu
-- groups leave the default spine (task 01a01e37-49a5-7da9-acf6-23b4bf64acf6,
-- 2026-08-20). Server twin of tm8-ui SHIPPED_DEFAULT_MENU revision 20.
--
-- The resulting SERVER payload is:
--   Home | Work | Craft | Graph | Settings | Help
-- tm8-ui inserts the route-only Board v2 seat after Work, labelled exactly
-- "Board", producing the visible seven-tab row. Board v2 is deliberately not
-- a MenuViewRef. The legacy `board`, `files` and every implementation behind
-- them stay registered, routable and menu-editor eligible.
--
-- Compatibility is byte/structure guarded. Only a saved payload exactly equal
-- to migration 140's untouched default moves. An operator-authored label,
-- order, row or group makes the payload unequal and it remains untouched.

set role tm8_graph_owner;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[{"type":"view","ref":"workspace"}]},
    {"id":"craft","label":"Craft","items":[{"type":"view","ref":"craft"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]},
    {"id":"help","label":"Help","items":[{"type":"view","ref":"help"}]}
  ]}'::jsonb
$$;

do $$
declare
  payload_140 constant jsonb := '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[{"type":"view","ref":"workspace"}]},
    {"id":"board","label":"Board","items":[{"type":"view","ref":"board"}]},
    {"id":"craft","label":"Craft","items":[{"type":"view","ref":"craft"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"files","label":"Files","items":[{"type":"view","ref":"files"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_140;
end
$$;

reset role;
