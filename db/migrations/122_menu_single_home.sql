-- 122 — the single-home rail: six intent clusters (user ruling, task
-- 01a0027d, 2026-08-14). Server twin of tm8-ui SHIPPED_DEFAULT_MENU
-- revision 11 (the shared truth is the contract's DEFAULT_MENU_GROUP_SPINE /
-- DEFAULT_MENU_WORKSPACE_KIND_SPINE / DEFAULT_MENU_CHATS_SPINE /
-- DEFAULT_MENU_CODE_KIND_SPINE; menu-seeder-parity.pg.test.ts pins this file's
-- payload against them).
--
-- WHAT MOVED, in one place:
--   home     → Dashboard alone (the merged single-home landing).
--   chats    → NEW: the conversation surfaces — the channel COLLECTION row and
--              the messages view. Live voice rooms hang beneath this group id
--              client-side (the dynamic group moved here from `voice`).
--   work     → the workspace caret keeps eight children, with `channel`
--              swapped out (it lives in chats now) and `file` swapped in;
--              the files EXPLORER view rides beside the caret (the Library
--              group folds in — R9 keeps both file doors).
--   code     → the old `tracking` group: the git view row, with the three
--              dev collections as its caret children rather than three
--              always-visible rows.
--   graph    → its own one-row group (it sat inside `work` before).
--   RETIRED from the default: `library` (folded into work), `collab` (the
--   member row goes palette/kind-switcher), `voice` (label without rows),
--   and Home's `messages` + `inbox` rows (messages moved to chats; inbox's
--   door is the client's top-bar bell). Every retired ref stays registered,
--   routable and offerable through the menu editor — this is a rail edit,
--   not a feature removal.
--
-- NO registry or constraint change: every ref this payload names has been in
-- `menu_view_registry` / `entity_kinds` since at latest 117. The guard
-- (`internal.w2_normalize_menu_payload`) accepts children on any view item and
-- requires only global ref uniqueness + the settings row, both of which this
-- payload satisfies — the parity test proves the seeder cannot refuse its own
-- payload, as it does for every menu migration since 071.
--
-- The upgrade block follows the 096/102/117 pattern exactly: byte-equivalent
-- legacy DEFAULTS are re-seeded with revision+1; a hand-edited menu does not
-- match the verbatim guard and keeps its arrangement untouched.

set role tm8_graph_owner;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
    {"id":"home","label":"Home","items":[
      {"type":"view","ref":"dashboard"}]},
    {"id":"chats","label":"Chats","items":[
      {"type":"kind","ref":"channel"},
      {"type":"view","ref":"messages"}]},
    {"id":"work","label":"Workspace","items":[
      {"type":"view","ref":"workspace","children":[
        {"type":"kind","ref":"task"},{"type":"kind","ref":"work_session"},
        {"type":"kind","ref":"doc"},{"type":"kind","ref":"team_member"},
        {"type":"kind","ref":"memory"},{"type":"kind","ref":"artifact"},
        {"type":"kind","ref":"loop"},{"type":"kind","ref":"file"}]},
      {"type":"view","ref":"files"}]},
    {"id":"code","label":"Code","items":[
      {"type":"view","ref":"git","children":[
        {"type":"kind","ref":"project"},{"type":"kind","ref":"pull_request"},
        {"type":"kind","ref":"worktree"}]}]},
    {"id":"graph","label":"Graph","items":[{"type":"view","ref":"graph"}]},
    {"id":"settings","label":"Settings","items":[{"type":"view","ref":"settings"}]}
  ]}'::jsonb
$$;

do $$
declare
  -- The 117 payload VERBATIM — the only un-customized current default once the
  -- chain has run in order. A space whose menu was hand-edited does not match
  -- and keeps its own arrangement; every regrouped ref stays offerable to it
  -- through the menu editor.
  payload_117 constant jsonb := '{"groups":[
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
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_117;
end
$$;

reset role;
