-- 069 — Channels leave the rail for the Entity List Panel; Home is Dashboard
-- alone (user ruling 2026-08-01).
--
-- THE SHAPE: the `channels` GROUP is dropped from the spine, and no `channels`
-- view ref replaces it anywhere in the default. A channel is an ENTITY, so it
-- belongs in the entity list with every other collection — tm8-ui's registry
-- row for `channel` moved from `strategy: 'special'` to `'collection'` in the
-- same change, which is what puts "Channels" in the list panel's kind switcher
-- and opens a channel in the entity detail panel like any other entity. A rail
-- section AND a collection list would be two divergent homes for one kind.
--
-- Feed and Inbox leave the rail in the same ruling, so Home is Dashboard.
--
-- NOTHING is deleted from the app: `feed`, `inbox` and `channels` all keep
-- their MenuViewRef membership, their routes (`#/s/{space}/feed`, `/inbox`,
-- `/channels`) and their chords, and the menu editor can put any of the three
-- back — they are the three free view refs on this default now.
--
-- The contract's DEFAULT_MENU_GROUP_SPINE loses its `channels` row in the same
-- change; packages/server/test/db/menu-seeder-parity.pg.test.ts pins the
-- payload below against it, and tm8-ui's menu.test.ts pins the client twin.

set role tm8_graph_owner;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"home","label":"Home","items":[{"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"}]},
      {"type":"view","ref":"graph"}]},
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
  -- The 061 payload VERBATIM: the only "un-customized current default" that can
  -- exist once the chain has run in order. jsonb equality is structural, so
  -- whitespace differences cannot cause a false miss — and a space whose menu
  -- was hand-edited does NOT match, so a viewer's own arrangement is never
  -- overwritten by this migration.
  payload_061 constant jsonb := '{"groups":[
    {"id":"home","label":"Home","items":[
      {"type":"view","ref":"dashboard"},{"type":"view","ref":"feed"},
      {"type":"view","ref":"inbox"}]},
    {"id":"work","label":"Work","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"}]},
      {"type":"view","ref":"graph"}]},
    {"id":"tracking","label":"Tracking","items":[
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"},
      {"type":"kind","ref":"worktree"}]},
    {"id":"collab","label":"Collab","items":[{"type":"kind","ref":"member"}]},
    {"id":"channels","label":"Channels","items":[{"type":"view","ref":"channels"}]},
    {"id":"voice","label":"Voice","items":[]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_061;
end
$$;

reset role;
