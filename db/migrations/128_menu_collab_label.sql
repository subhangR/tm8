-- 128 — the Chats tab is renamed COLLAB (user ruling, 2026-08-16).
-- Server twin of tm8-ui SHIPPED_DEFAULT_MENU revision 15. A LABEL change
-- only: the group id stays `chats` — ids are the wire-stable half (the
-- contract's DEFAULT_MENU_GROUP_SPINE, GateApp's voice-room fallback and
-- every upgrade guard key on ids, never labels) — and the group still owns
-- exactly one childless `dashboard` view item, so `isRaillessGroup` still
-- answers true and the surface stays two panes: conversation LIST, then the
-- open conversation.
--
-- NO registry or constraint change: same refs, same shape, same caps as 127.
--
-- The upgrade block follows the 096/102/117/122/125/126/127 pattern exactly:
-- the byte-equivalent previous DEFAULT is re-seeded with revision+1; a
-- hand-edited menu does not match the verbatim guard and keeps its
-- arrangement untouched (menu-seeder-parity.pg.test.ts proves both halves
-- against real rows).

set role tm8_graph_owner;

create or replace function internal.w1_default_menu_payload() returns jsonb
language sql immutable parallel safe as $$
  select '{"groups":[
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
  ]}'::jsonb
$$;

do $$
declare
  -- The 127 payload VERBATIM — the only un-customized current default once
  -- the chain has run in order. Comparison is jsonb-structural, so the
  -- formatting here is free; what must match is the shape 127 seeded. A
  -- space whose menu was hand-edited does not match and keeps its own
  -- arrangement.
  payload_127 constant jsonb := '{"groups":[
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
  ]}'::jsonb;
begin
  update public.space_menu_configs
     set payload = internal.w1_default_menu_payload(),
         revision = revision + 1
   where schema_version = 1
     and payload = payload_127;
end
$$;

reset role;
