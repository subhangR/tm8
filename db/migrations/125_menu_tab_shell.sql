-- 125 — the six-tab shell: the menu groups become the top-level tabs
-- (user rulings R2/R3/R4 + the same-day Files amendment, task 01a0055c,
-- 2026-08-15). Server twin of tm8-ui
-- SHIPPED_DEFAULT_MENU revision 12 (the shared truth is the contract's
-- DEFAULT_MENU_GROUP_SPINE / DEFAULT_MENU_WORKSPACE_KIND_SPINE /
-- DEFAULT_MENU_CHANNELS_SPINE / DEFAULT_MENU_WORK_ITEM_SPINE;
-- menu-seeder-parity.pg.test.ts pins this file's payload against them).
--
-- WHAT MOVED, in one place:
--   home     → unchanged: Dashboard alone (Home is the chat view, R4).
--   work     → absorbs the retired `code` group (R3: "code is just part of
--              the workspace"): the Workspace caret keeps its eight kinds,
--              then project / pull_request / worktree become ORDINARY Work
--              rows, and the git topology view survives as a plain Work row
--              (default D1 — the surface shipped in #167-#175 is distinct
--              from the three kind collections and is not deleted).
--   graph    → unchanged, but moves ahead of the conversation group in tab
--              order (R2: home | work | graph | channels | files | settings).
--   channels → the `chats` group renamed (R4: "channels is different, chats
--              is different… home is the chats kind of view"): same two rows —
--              the channel collection and the messages view (default D2:
--              `messages` moves here rather than dying with `chats`). Live
--              voice rooms keep hanging beneath this group id client-side.
--   files    → NEW tab (user amendment, 2026-08-15): the File browser view,
--              alone. It LEAVES the work group because menu refs are globally
--              unique; the `file` KIND stays in the Workspace caret, so R9's
--              two file doors survive, on two tabs.
--   settings → unchanged (default D4: stays a peer tab).
--   RETIRED group ids: `chats` (renamed `channels`), `code` (folded into
--   work). Every ref stays registered, routable and offerable through the
--   menu editor — this is a rail edit, not a feature removal.
--
-- NO registry or constraint change: every ref this payload names has been in
-- `menu_view_registry` / `entity_kinds` since at latest 117, and the payload
-- stays within the frozen DTO caps (≤8 groups, ≤12 items per group, ≤8
-- children, depth ≤1, global ref uniqueness, settings present) — the parity
-- test proves the seeder cannot refuse its own payload.
--
-- The upgrade block follows the 096/102/117/122 pattern exactly:
-- byte-equivalent legacy DEFAULTS are re-seeded with revision+1; a
-- hand-edited menu does not match the verbatim guard and keeps its
-- arrangement untouched.

set role tm8_graph_owner;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
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
  ]}'::jsonb
$$;

do $$
declare
  -- The 122 payload VERBATIM — the only un-customized current default once
  -- the chain has run in order. A space whose menu was hand-edited does not
  -- match and keeps its own arrangement; every regrouped ref stays offerable
  -- to it through the menu editor.
  payload_122 constant jsonb := '{"groups":[
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
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_122;
end
$$;

reset role;
