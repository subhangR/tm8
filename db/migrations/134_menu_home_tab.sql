-- 134 — the unified HOME tab (task 01a00932, LLD docs/features/home/
-- UNIFIED-HOME-DESIGN.md; user rulings R1-R11, 2026-08-16).
-- Server twin of tm8-ui SHIPPED_DEFAULT_MENU revision 17.
--
-- The Work and Channels GROUPS retire and the conversation tab is renamed
-- HOME: the tab row becomes Home | Board | Graph | Files | Settings. Home
-- absorbs both worlds — its screen lists chat threads OR any collection
-- kind (the root column + icon rail, registry-driven), so a Work tab beside
-- it would be a second door to every list Home already owns, and Channels'
-- contents await the redesigned Collab surface (R2: a later feature).
--
-- The group id stays `chats` — ids are the wire-stable half (the contract's
-- DEFAULT_MENU_GROUP_SPINE, GateApp's voice-room fallback and every upgrade
-- guard key on ids, never labels; the 128 precedent). The group still owns
-- exactly one childless `dashboard` view item, so `isRaillessGroup` still
-- answers true — Home's own icon rail is part of the SCREEN, never menu
-- data (the frozen DTO caps items at 12 and cannot carry every kind).
--
-- NOTHING IS DELETED: `workspace`, `git`, `messages` and every retired kind
-- ref keep their routes, their chords and their menu-editor eligibility —
-- the same rail-edit-not-feature-removal posture as 125/126/127. No
-- registry or constraint change: every ref this payload names already
-- passes ref_check.
--
-- The upgrade block follows the 096/102/117/122/125/126/127/128/130
-- pattern: the byte-equivalent previous DEFAULT is re-seeded with
-- revision+1; a hand-edited menu does not match the verbatim guard and
-- keeps its arrangement untouched (menu-seeder-parity.pg.test.ts proves
-- both halves against real rows).

set role tm8_graph_owner;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"board","label":"Board","items":[{"type":"view","ref":"board"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"files","label":"Files","items":[{"type":"view","ref":"files"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb
$$;

do $$
declare
  -- The 130 payload VERBATIM — the only un-customized current default once
  -- the chain has run in order. Comparison is jsonb-structural, so the
  -- formatting here is free; what must match is the shape 130 seeded. A
  -- space whose menu was hand-edited does not match and keeps its own
  -- arrangement, with every retired ref still offerable back through the
  -- menu editor.
  payload_130 constant jsonb := '{"groups":[
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
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_130;
end
$$;

reset role;
