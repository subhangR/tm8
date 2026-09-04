-- 127 — the Chats tab returns (user ruling, task 01a00671, 2026-08-15).
-- Server twin of tm8-ui SHIPPED_DEFAULT_MENU revision 14 (the shared truth is
-- the contract's DEFAULT_MENU_GROUP_SPINE / DEFAULT_MENU_WORKSPACE_KIND_SPINE
-- / DEFAULT_MENU_CHANNELS_SPINE / DEFAULT_MENU_WORK_ITEM_SPINE;
-- menu-seeder-parity.pg.test.ts pins this file's payload against them).
--
-- WHAT CHANGED, in one line: a group leads `dashboard` again, named CHATS —
--   chats | work | graph | channels | files | settings
--
-- WHY. 126 retired the `home` group because standing on the conversation
-- surface you were offered a Home tab that was already current AND a rail
-- drawing one row labelled Home. That reading of the redundancy was right and
-- the conclusion drawn from it was wrong: the duplicated door was the RAIL
-- ROW, not the tab. Retiring the group took the tab away too, which left the
-- brand mark as the only route back to conversations — a door with no label,
-- found by guessing. The user rejected that.
--
-- So the tab comes back and the RAIL is what stays gone. The group owns
-- exactly one childless view item, which is the condition tm8-ui's
-- `isRaillessGroup` tests, and `dashboard` joined `RAILLESS_VIEW_REFS` in the
-- same change — so the Chats tab draws no rail and the surface is exactly two
-- panes: the conversation LIST, then the open conversation. The list is the
-- navigation and it belongs to the screen, not to the chrome.
--
-- THE ID IS `chats`, AND IT IS FREE. 125 RENAMED the pre-existing `chats`
-- group to `channels` — that group was the channel collection's, never this
-- surface's — so no current or upgraded payload can hold both. GateApp's
-- voice-room host still resolves `channels` first and only falls back to
-- `chats` for pre-125 menus, so it keeps pointing at the channel group.
--
-- NO registry or constraint change: `dashboard` never left `menu_view_registry`
-- (126 was explicit that the REF was untouched), so the write-path validator
-- already accepts it, and the frozen DTO caps (<=8 groups — this payload has 6
-- — <=12 items per group, <=8 children, depth <=1, global ref uniqueness,
-- settings present) are all satisfied. The parity test proves the seeder
-- cannot refuse its own payload.
--
-- The upgrade block follows the 096/102/117/122/125/126 pattern exactly:
-- byte-equivalent legacy DEFAULTS are re-seeded with revision+1; a hand-edited
-- menu does not match the verbatim guard and keeps its arrangement untouched.

set role tm8_graph_owner;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"chats","label":"Chats","items":[
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
  ]}'::jsonb
$$;

do $$
declare
  -- The 126 payload VERBATIM — the only un-customized current default once the
  -- chain has run in order. Comparison is jsonb-structural, so the formatting
  -- here is free; what must match is the shape 126 seeded. A space whose menu
  -- was hand-edited does not match and keeps its own arrangement, `dashboard`
  -- still offerable to it through the menu editor.
  payload_126 constant jsonb := '{"groups":[
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
     and payload = payload_126;
end
$$;

reset role;
