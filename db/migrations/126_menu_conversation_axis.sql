-- 126 — the conversation axis: the `home` GROUP retires (user ruling,
-- task 01a005ea, 2026-08-15). Server twin of tm8-ui SHIPPED_DEFAULT_MENU
-- revision 13 (the shared truth is the contract's DEFAULT_MENU_GROUP_SPINE /
-- DEFAULT_MENU_WORKSPACE_KIND_SPINE / DEFAULT_MENU_CHANNELS_SPINE /
-- DEFAULT_MENU_WORK_ITEM_SPINE; menu-seeder-parity.pg.test.ts pins this
-- file's payload against them).
--
-- WHAT CHANGED, in one line: the `home` group is gone, leaving
--   work | graph | channels | files | settings
--
-- WHY. Home stopped being a DESTINATION and became the CONTAINER — the
-- conversation surface the shell falls back to. Standing on it you were
-- offered a Home tab that was already current AND, inside that tab, a rail
-- drawing one row labelled Home: two more doors to the room you were already
-- in, above a conversation panel that is the actual navigation axis. The
-- group is what encoded both, so the group is what goes.
--
-- WHAT DID NOT CHANGE. The `dashboard` VIEW REF is untouched. It stays in
-- `menu_view_registry`, stays routable (`/home`), stays the screen a viewer
-- with no remembered place lands on, stays a command-palette row, and stays
-- offerable through the menu editor — a space that WANTS a Home tab can add
-- one back with no migration. This is a rail edit, not a feature removal,
-- exactly as 125 was for `chats` and `code`.
--
-- NO registry or constraint change: this payload names a strict SUBSET of the
-- refs 125 named, and the frozen DTO caps (≤8 groups, ≤12 items per group,
-- ≤8 children, depth ≤1, global ref uniqueness, settings present) are all
-- still satisfied — `settings` is present, which is the only group the
-- normalizer requires. The parity test proves the seeder cannot refuse its
-- own payload.
--
-- The upgrade block follows the 096/102/117/122/125 pattern exactly:
-- byte-equivalent legacy DEFAULTS are re-seeded with revision+1; a
-- hand-edited menu does not match the verbatim guard and keeps its
-- arrangement untouched.

set role tm8_graph_owner;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
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
  -- The 125 payload VERBATIM — the only un-customized current default once
  -- the chain has run in order. A space whose menu was hand-edited does not
  -- match and keeps its own arrangement; `dashboard` stays offerable to it
  -- through the menu editor either way.
  payload_125 constant jsonb := '{"groups":[
    {"id":"home","label":"Home","items":[
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
     and payload = payload_125;
end
$$;

reset role;
