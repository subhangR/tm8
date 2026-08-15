-- 129 — the tab row is stated outright (user ruling, 2026-08-16):
--   home | workspace | collab | graph | files | settings
-- Server twin of tm8-ui SHIPPED_DEFAULT_MENU revision 16. THREE LABEL CHANGES
-- AND ONE MOVE. No group is added, removed or re-scoped; no group id changes;
-- no ref, cap or constraint changes. Same shape as 128 throughout.
--
-- WHAT MOVED AND WHY
--   `chats`    Collab   -> Home       it owns the `dashboard` view, the surface
--                                     you land on with no remembered place, so
--                                     128 named the one place that is YOURS
--                                     after the activity of talking to others.
--   `work`     Work     -> Workspace  matches the `workspace` view ref, the
--                                     Workspace caret and "Open full
--                                     workspace"; "Work" was an abbreviation
--                                     nothing else in the product used.
--   `channels` Channels -> Collab     this is the SHARED half — the channel
--                                     collection plus Messages. "Channels"
--                                     named a KIND; "Collab" names what you go
--                                     there to do.
--   `channels` also moves ahead of `graph`. Group ORDER lives in the contract's
--   DEFAULT_MENU_GROUP_SPINE, which is the single source both twins prove
--   against, so this file and tm8-ui cannot drift apart on it.
--
-- THE IDS DELIBERATELY READ BACKWARDS after this: the HOME tab is id `chats`
-- and the COLLAB tab is id `channels`. Ids are the wire-stable half — the
-- upgrade guard below, GateApp's voice-room fallback and every resolver key on
-- them — so renaming an id to chase a label would strand every space that has
-- already stored one. The id is history; the label is the product.
--
-- The upgrade block follows the 096/102/117/122/125/126/127/128 pattern
-- exactly: the byte-equivalent previous DEFAULT is re-seeded with revision+1,
-- so a hand-edited menu does not match the verbatim guard and keeps its own
-- arrangement untouched. menu-seeder-parity.pg.test.ts proves both halves
-- against real rows.

set role tm8_graph_owner;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"chats","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"work","label":"Workspace","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"},
        {"type":"kind","ref":"loop"},{"type":"kind","ref":"file"}]},
      {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"},
      {"type":"kind","ref":"worktree"},
      {"type":"view","ref":"git"}]},
    {"id":"channels","label":"Collab","items":[
      {"type":"kind","ref":"channel"},
      {"type":"view","ref":"messages"}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"files","label":"Files","items":[{"type":"view","ref":"files"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb
$$;

do $$
declare
  -- The 128 payload VERBATIM — the only un-customized current default once the
  -- chain has run in order. Comparison is jsonb-structural, so the formatting
  -- here is free; what must match is the SHAPE 128 seeded, group order
  -- included. One wrong byte here matches zero rows and the upgrade half fails
  -- SILENTLY while the seeder half still succeeds, so this literal is copied
  -- from 128 rather than retyped.
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
